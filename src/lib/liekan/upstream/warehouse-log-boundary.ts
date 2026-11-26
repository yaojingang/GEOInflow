import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { LogReadQuery } from '../contracts/log-read';
import { warehouseReader } from '../warehouse/reader-runtime';
import { readReportingMetadata } from '../warehouse/reporting-context';
import { warehouseV2Enabled } from '../warehouse-v2/index';
import { getPublishedCatalog } from '../crawlers/published';
import { LiekanError } from './errors';
import { processSingleton } from './process-singleton';
import { warehouseControlFingerprint, withinWarehouseReport } from './warehouse-report-snapshot';

const handles = processSingleton(
  'warehouse-log-read-handle',
  () => new AsyncLocalStorage<{ site: string; scope: string; token: string }>(),
);
const scopeOf = (p: LogReadQuery) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        'log-read-v4',
        getPublishedCatalog()?.version ?? null,
        p.startAt,
        p.endAt,
        p.timezone,
        p.filter,
        p.search,
        p.crawlerIdentityScope,
        p.crawlerMetricsVersion ?? null,
      ]),
    )
    .digest('hex');
const conflict = () =>
  new LiekanError('日志读取边界已失效，请重新读取第一页', 409, 'log-read-boundary-conflict');
export function pinnedLogBoundary(site: string, p: LogReadQuery) {
  const handle = handles.getStore();
  if (
    !handle ||
    handle.site !== site ||
    handle.scope !== scopeOf(p) ||
    (p.readBoundary && handle.token !== p.readBoundary)
  )
    throw conflict();
  return handle.token;
}

/** The handle pins all independently delivered parts, even while uploads advance.
 * Every use still requires endpoint authorization and fresh control validation. */
export async function withWarehouseLogBoundary<T>(
  site: string,
  p: LogReadQuery,
  work: () => Promise<T>,
  deadline?: number,
) {
  const scope = scopeOf(p);
  return withWarehouseReadBoundary(
    site,
    scope,
    p.readBoundary,
    token => handles.run({ site, scope, token }, work),
    deadline,
  );
}

/** Opaque publication handles are shared by log parts and paged session reads.
 * Callers bind their own immutable query scope and perform authorization. */
export async function withWarehouseReadBoundary<T>(
  site: string,
  scope: string,
  readBoundary: string | undefined,
  work: (token: string) => Promise<T>,
  deadline?: number,
) {
  const db = warehouseReader().db;
  const metadata = await readReportingMetadata(db, site);
  const control = warehouseControlFingerprint(metadata);
  if (warehouseV2Enabled()) {
    const expected = createHash('sha256')
      .update(JSON.stringify(['v2-boundary', site, scope, metadata.boundary.epoch, control]))
      .digest('hex');
    if (readBoundary && readBoundary !== expected) throw conflict();
    return withinWarehouseReport(() => work(expected), { deadline });
  }
  const token = readBoundary || randomBytes(32).toString('hex');
  const reference = randomUUID();
  const boundary = await db.transaction(async tx => {
    const { rows: locked } = await tx.query(
      `SELECT website_id FROM liekan_warehouse_site WHERE website_id=$1 AND epoch=$2 AND deletion_revision=$3 AND state='active' FOR SHARE`,
      [site, metadata.boundary.epoch, metadata.boundary.deletionRevision],
    );
    if (!locked.length) throw conflict();
    if (readBoundary) {
      const {
        rows: [saved],
      } = await tx.query<{ publication: string }>(
        `SELECT b.publication::text FROM liekan_warehouse_report_boundary b
         JOIN liekan_warehouse_reference r USING(reference_id)
         WHERE b.token=$1 AND b.website_id=$2 AND b.scope=$3 AND b.control=$4
           AND b.epoch=$5 AND b.deletion_revision=$6 AND b.publication<=$7
           AND b.expires_at>clock_timestamp() AND r.expires_at>clock_timestamp()
         FOR UPDATE OF r`,
        [
          token,
          site,
          scope,
          control,
          metadata.boundary.epoch,
          metadata.boundary.deletionRevision,
          metadata.boundary.publication,
        ],
      );
      if (!saved) throw conflict();
      // Extend only the protection, not the handle's fixed fifteen-minute lifetime.
      await tx.query(
        `UPDATE liekan_warehouse_reference SET expires_at=greatest(expires_at,clock_timestamp()+interval '2 minutes') WHERE reference_id=(SELECT reference_id FROM liekan_warehouse_report_boundary WHERE token=$1)`,
        [token],
      );
      return saved.publication;
    }
    await tx.query(
      `INSERT INTO liekan_warehouse_reference(reference_id,website_id,epoch,publication,kind,owner_id,expires_at)
      VALUES($1,$2,$3,$4,'query',$1,clock_timestamp()+interval '15 minutes')`,
      [reference, site, metadata.boundary.epoch, metadata.boundary.publication],
    );
    await tx.query(
      `INSERT INTO liekan_warehouse_report_boundary(token,website_id,scope,control,epoch,publication,deletion_revision,reference_id,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '15 minutes')`,
      [
        token,
        site,
        scope,
        control,
        metadata.boundary.epoch,
        metadata.boundary.publication,
        metadata.boundary.deletionRevision,
        reference,
      ],
    );
    return metadata.boundary.publication;
  });
  return withinWarehouseReport(
    async () => {
      const { warehouseReportMetadata } = await import('./warehouse-report-snapshot');
      if (warehouseControlFingerprint(await warehouseReportMetadata(site)) !== control)
        throw conflict();
      return work(token);
    },
    { publication: { websiteId: site, publication: boundary }, deadline },
  );
}
