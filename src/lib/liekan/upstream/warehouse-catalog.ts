import { createHash } from 'node:crypto';
import { WarehouseConflict } from '../warehouse/control-db';
import { warehouseTime } from '../warehouse/fact-input';
import { warehouseReader } from '../warehouse/reader-runtime';
import { LiekanError } from './errors';
import { warehouseReportMetadata } from './warehouse-report-snapshot';

/** Business catalog membership is projected in bounded pages. Reports join it
 * inside CH; no full log/path ID list travels back to PG for membership checks. */
export async function warehouseCatalogProjection(site: string, signal?: AbortSignal) {
  const reader = warehouseReader(),
    metadata = await warehouseReportMetadata(site);
  const revision = metadata.catalogRevision,
    epoch = metadata.boundary.epoch;
  if (!revision) throw new WarehouseConflict('warehouse-catalog-revision-missing');
  const params = { site, epoch, revision };
  const readManifest = () =>
    reader.ch
      .query({
        query: `SELECT DISTINCT value FROM warehouse_control_projection
    WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND revision={revision:UInt64} AND kind='catalog-manifest-v1' LIMIT 2`,
        query_params: params,
        format: 'JSONEachRow',
        abort_signal: signal,
      })
      .then(r => r.json<{ value: string }>());
  const existing = await readManifest();
  if (existing.length > 1) throw new WarehouseConflict('warehouse-catalog-manifest-conflict');
  if (existing.length === 1) return { wh_catalog_revision: revision };
  const source = createHash('sha256');
  let after: string | null = null,
    count = 0;
  const assertRevision = async () => {
    if (signal?.aborted) throw new LiekanError('统计读取已取消', 499);
    const [current] = await reader.db.read<{
      catalog_revision: string;
      epoch: string;
      state: string;
    }>(
      'SELECT catalog_revision::text,epoch::text,state FROM liekan_warehouse_site WHERE website_id=$1',
      [site],
    );
    if (
      current?.state !== 'active' ||
      current.epoch !== epoch ||
      current.catalog_revision !== revision
    )
      throw new WarehouseConflict('warehouse-catalog-changed');
  };
  for (;;) {
    await assertRevision();
    const rows = await reader.db.read<{ path: string }>(
      `SELECT path FROM liekan_catalog WHERE website_id=$1 AND ($2::text IS NULL OR path COLLATE "C">$2 COLLATE "C") ORDER BY path COLLATE "C" LIMIT 1000`,
      [site, after],
    );
    if (!rows.length) break;
    for (const row of rows) source.update(JSON.stringify(row.path) + '\n');
    count += rows.length;
    await reader.ch.insert({
      table: 'warehouse_control_projection',
      format: 'JSONEachRow',
      abort_signal: signal,
      values: rows.map(row => ({
        website_id: site,
        epoch,
        kind: 'catalog-path-v1',
        revision,
        key: row.path,
        value: '',
        created_at: warehouseTime(new Date()),
      })),
    });
    after = rows.at(-1).path;
  }
  await assertRevision();
  const actual = createHash('sha256');
  let actualCount = 0;
  after = null;
  for (;;) {
    const rows = await reader.ch
      .query({
        query: `SELECT DISTINCT key FROM warehouse_control_projection
      WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND revision={revision:UInt64} AND kind='catalog-path-v1'
      AND ({first:Bool} OR key>{after:String}) ORDER BY key LIMIT 1000`,
        query_params: { ...params, first: after === null, after: after ?? '' },
        format: 'JSONEachRow',
        abort_signal: signal,
      })
      .then(r => r.json<{ key: string }>());
    if (!rows.length) break;
    for (const row of rows) actual.update(JSON.stringify(row.key) + '\n');
    actualCount += rows.length;
    after = rows.at(-1).key;
  }
  const checksum = source.digest('hex');
  if (actualCount !== count || actual.digest('hex') !== checksum)
    throw new WarehouseConflict('warehouse-catalog-verification-failed');
  await assertRevision();
  const manifest = JSON.stringify({ format: 'catalog-path-v1', count, checksum });
  await reader.ch.insert({
    table: 'warehouse_control_projection',
    format: 'JSONEachRow',
    abort_signal: signal,
    values: [
      {
        website_id: site,
        epoch,
        kind: 'catalog-manifest-v1',
        revision,
        key: '',
        value: manifest,
        created_at: warehouseTime(new Date()),
      },
    ],
  });
  const verified = await readManifest();
  if (verified.length !== 1 || verified[0].value !== manifest)
    throw new WarehouseConflict('warehouse-catalog-manifest-conflict');
  return { wh_catalog_revision: revision };
}

export const warehouseCatalogPaths = `(SELECT DISTINCT key AS path FROM warehouse_control_projection
  WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND revision={wh_catalog_revision:UInt64} AND kind='catalog-path-v1')`;
