import { createHash } from 'node:crypto';
import { formatInTimeZone } from 'date-fns-tz';
import type { GeoWeightResponse } from '../contracts/geo-weight';
import { geoWeightQuerySchema } from '../contracts/geo-weight';
import { crawlerWindowQuality } from '../crawlers/analysis';
import { geoComparable, geoPoint } from '../geo-weight/evidence';
import {
  GEO_ALGORITHM,
  GEO_COEFFICIENTS,
  GEO_CONTENT_TYPES,
  GEO_FORMULA,
  GEO_LEVEL_MINIMUMS,
  GEO_METADATA_PATH,
  GEO_NON_CONTENT_EXTENSION,
  GEO_SCOPE,
  GEO_VERIFICATION,
} from '../geo-weight/policy';
import { geoDateOffset, geoWindow } from '../geo-weight/window';
import type { AiTx } from './ai-db';
import { AnalyticsUnavailable, analyticsGate } from './analytics-budget';
import { currentCacheContext, noteCacheResult } from './cache-context';
import { authorizeCrawler, type CrawlerActor, crawlerTransaction } from './crawler-access';
import { withPublishedRegistry } from './crawler-registry-context';
import { LiekanError } from './errors';
import { evidenceCache } from './evidence-cache';
import { geoWeightAggregate, geoWeightFirstEvidence } from './geo-weight-sql';
import { websiteCacheTag } from './query-cache';
import { cancellableEvidence } from './query-cancellation';
import { withinWarehouseReport } from './warehouse-report-snapshot';
import { warehouseEnabled } from '../warehouse/runtime';
import { warehouseControlRead } from './warehouse-control-read';
import { warehouseReportMetadata } from './warehouse-report-snapshot';
import type { ReadBoundary } from '../warehouse/read';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const GEO_SCOPE_HASH = hash({
  algorithm: GEO_ALGORITHM,
  scope: GEO_SCOPE,
  verification: GEO_VERIFICATION,
  coefficients: GEO_COEFFICIENTS,
  levelMinimums: GEO_LEVEL_MINIMUMS,
  formula: GEO_FORMULA,
  contentTypes: GEO_CONTENT_TYPES,
  metadata: GEO_METADATA_PATH,
  nonContent: GEO_NON_CONTENT_EXTENSION,
});
export function parseGeoWeightQuery(input: unknown, now = Date.now()) {
  const parsed = geoWeightQuerySchema.safeParse(input);
  if (!parsed.success) throw new LiekanError('GEO 权重参数无效', 400);
  const p = parsed.data;
  try {
    if (
      new Date(p.asOf + 'T00:00:00Z').toISOString().slice(0, 10) !== p.asOf ||
      p.asOf < '1970-03-01' ||
      p.asOf >= formatInTimeZone(now, p.timezone, 'yyyy-MM-dd')
    )
      throw new Error();
    const w = geoWindow(p.asOf, p.timezone);
    if (!Number.isFinite(w.startAt) || w.endAt > now) throw new Error();
  } catch {
    throw new LiekanError('GEO 权重需要有效时区和已结束的日期', 400);
  }
  return p;
}
function hostname(domain: string) {
  try {
    const u = new URL(/^https?:\/\//.test(domain) ? domain : `https://${domain}`);
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    throw new LiekanError('网站域名无效', 400);
  }
}
async function readAccess(tx: AiTx, actor: CrawlerActor, websiteId: string) {
  const website = await authorizeCrawler(tx, actor, websiteId);
  const [setting] = await tx.query(
    'SELECT ai_crawler_enabled FROM liekan_setting WHERE website_id=$1::uuid',
    websiteId,
  );
  if (setting?.ai_crawler_enabled === false) throw new LiekanError('AI 蜘蛛数据展示已关闭', 403);
  const [state] = await tx.query(
    'SELECT epoch,data_revision::text,policy_revision::text FROM liekan_log_state WHERE website_id=$1::uuid',
    websiteId,
  );
  return {
    hostname: hostname(website.domain),
    epoch: state?.epoch || 1,
    dataRevision: state?.data_revision || '0',
    policyRevision: state?.policy_revision || '0',
    resetAt: website.resetAt?.toISOString() || null,
    owner: website.ownerUserId,
    team: website.teamId,
    canManageCatalog: website.role === 'admin',
  };
}
// New ingestion can advance revisions outside the selected historical window. A repeatable
// transaction preserves its own input revision; only access and scope changes invalidate it.
function accessBoundary(value: Awaited<ReturnType<typeof readAccess>>) {
  const { dataRevision: _revision, canManageCatalog: _capability, ...boundary } = value;
  return boundary;
}
export function geoWeightRemaining(deadline: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new LiekanError('统计读取已取消', 499);
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new AnalyticsUnavailable('GEO 权重计算未完成，请重新读取');
  return remaining;
}
export function geoWeightTransaction<T>(
  deadline: number,
  signal: AbortSignal | undefined,
  work: (tx: AiTx) => Promise<T>,
  repeatableRead = false,
) {
  const remaining = geoWeightRemaining(deadline, signal);
  return crawlerTransaction(
    async raw => {
      const tx: AiTx = {
        execute: (sql, ...args) => raw.execute(sql, ...args),
        query: async <Row = Record<string, any>>(sql: string, ...args: unknown[]) => {
          await raw.execute(
            `SET LOCAL statement_timeout TO '${Math.min(59000, geoWeightRemaining(deadline, signal))}ms'`,
          );
          const result = await raw.query<Row>(sql, ...args);
          geoWeightRemaining(deadline, signal);
          return result;
        },
      };
      const result = await cancellableEvidence(tx, signal, () => work(tx));
      geoWeightRemaining(deadline, signal);
      return result;
    },
    {
      timeout: Math.min(59000, remaining),
      transactionTimeout: remaining,
      maxWait: Math.min(1000, remaining),
      repeatableRead,
    },
  ).catch(error => {
    if (error?.code === 'P2028' || /statement timeout/.test(String(error?.message)))
      throw new AnalyticsUnavailable('GEO 权重计算未完成，请重新读取');
    throw error;
  });
}
async function calculateGeoWeightAtBoundary(
  actor: CrawlerActor,
  websiteId: string,
  input: unknown,
  options: { signal?: AbortSignal; fresh?: boolean; deadline?: number; globalLock?: boolean; onWarehouseBoundary?: (boundary: ReadBoundary) => void } = {},
): Promise<GeoWeightResponse> {
  const deadline = Math.min(Date.now() + 60000, options.deadline ?? Infinity);
  const p = parseGeoWeightQuery(input);
  return withPublishedRegistry(async catalog => {
    let access: Awaited<ReturnType<typeof readAccess>>;
    try {
      access = await geoWeightTransaction(deadline, options.signal, tx =>
        readAccess(tx, actor, websiteId),
      );
    } catch (error) {
      if (['42P01', '42703'].includes((error as any)?.meta?.code))
        throw new LiekanError('当前环境缺少 GEO 权重所需的目录与日志证据能力', 503);
      throw error;
    }
    const windows = (p.view === 'detail' ? [0, 7, 14, 21, 28, 30] : [0]).map(days =>
      geoWindow(geoDateOffset(p.asOf, -days), p.timezone),
    );
    let computedHere = false;
    const compute = (signal?: AbortSignal) =>
      analyticsGate.run(
        () =>
          (warehouseEnabled() ? warehouseGeoCompute : geoWeightTransaction)(
            deadline,
            signal,
            async tx => {
              if (options.globalLock && !warehouseEnabled()) {
                const [lock] = await tx.query(
                  'SELECT pg_try_advisory_xact_lock(12800031) AS acquired',
                );
                if (!lock?.acquired) throw new GeoWeightLockBusy();
              }
              computedHere = true;
              const currentAccess = await readAccess(tx, actor, websiteId);
              if (warehouseEnabled()) options.onWarehouseBoundary?.((await warehouseReportMetadata(websiteId)).boundary);
              if (hash(accessBoundary(access)) !== hash(accessBoundary(currentAccess)))
                throw new LiekanError('统计基准已变化，请重新读取', 409);
              const rows = await geoWeightAggregate(
                tx,
                websiteId,
                access.hostname,
                p.timezone,
                windows,
              );
              const firstEvidenceDay = await geoWeightFirstEvidence(
                tx,
                websiteId,
                access.hostname,
                p.timezone,
                windows[0].endAt,
              );
              const points = [];
              for (const window of windows) {
                const quality = await crawlerWindowQuality(
                  tx,
                  websiteId,
                  window.startAt,
                  window.endAt,
                  p.timezone,
                );
                const [coverage] = await tx.query(
                  `SELECT EXISTS(SELECT 1 FROM liekan_crawler_rule_version r
              JOIN liekan_crawler_registry_version c ON c.version=r.catalog_version
              WHERE r.website_id=$1::uuid AND r.version=$2 AND r.crawler_configuration IS NOT NULL)
              AND EXISTS(SELECT 1 FROM liekan_crawler_quality q
                JOIN liekan_log_source s ON s.id=q.source_id AND s.website_id=q.website_id
                WHERE q.website_id=$1::uuid AND lower(s.domain)=$3 AND q.state='complete'
                  AND q.evidence->>'basis'='event_time' AND q.evidence->>'classificationVersion'=$2
                  AND q.evidence->>'sourceVersion' IS NOT DISTINCT FROM $6
                  AND q.starts_at<$5::timestamptz AND q.ends_at>$4::timestamptz
                  AND (SELECT range_agg(tstzrange(i.starts_at,i.ends_at,'[)')) FROM liekan_log_interval i
                    WHERE i.website_id=q.website_id AND i.source_id=q.source_id)
                    @> tstzrange($4::timestamptz,$5::timestamptz,'[)')
                GROUP BY q.source_id HAVING range_agg(tstzrange(q.starts_at,q.ends_at,'[]'))
                  @> tstzrange($4::timestamptz,$5::timestamptz,'[)')) AS valid`,
                  websiteId,
                  quality.classificationVersion,
                  access.hostname,
                  new Date(window.startAt),
                  new Date(window.endAt),
                  quality.sourceVersion,
                );
                const covered = quality.state === 'complete' && coverage?.valid === true;
                const row = rows.find(r => r.asOf === window.asOf) || {};
                if (firstEvidenceDay && firstEvidenceDay <= window.asOf)
                  row.stats = { ...row.stats, firstEvidenceDay };
                points.push(geoPoint(window, row, quality, catalog.state === 'fallback', covered));
              }
              const current = points[0],
                previous = points[5];
              const result: GeoWeightResponse = {
                websiteId,
                hostname: access.hostname,
                timezone: p.timezone,
                algorithm: GEO_ALGORITHM,
                scoreScopeHash: GEO_SCOPE_HASH,
                readCatalogVersion: catalog.version,
                readCatalogHash: catalog.contentHash,
                catalogState: catalog.state,
                directoryCounts: {
                  platforms: catalog.payload.platforms.length,
                  products: catalog.payload.products.length,
                  identities: catalog.payload.identities.length,
                },
                scope: GEO_SCOPE.map(row => {
                  const identity = catalog.payload.identities.find(i => i.id === row.id);
                  const platform = catalog.payload.platforms.find(i => i.id === row.platformId);
                  return {
                    ...row,
                    name: identity?.name || row.id,
                    platform: platform?.operator || row.platformId,
                    documentation: identity?.metadata.sources[0]?.url || null,
                    reviewedAt: identity?.metadata.reviewedAt || null,
                    productForm: identity?.productForm || 'unknown',
                  };
                }),
                canManageCatalog: access.canManageCatalog,
                epoch: access.epoch,
                dataRevision: currentAccess.dataRevision,
                calculatedAt: new Date().toISOString(),
                snapshot: '',
                view: p.view,
                current,
                ...(p.view === 'detail'
                  ? {
                      previous,
                      observations: points
                        .slice(0, 5)
                        .reverse()
                        .map((point, i, all) => ({
                          ...point,
                          connectPrevious: i > 0 && geoComparable(point, all[i - 1]),
                        })),
                      comparison: {
                        comparable: geoComparable(current, previous),
                        delta: geoComparable(current, previous)
                          ? current.level - previous.level
                          : null,
                        reasons: [
                          ...new Set([
                            ...current.reasons,
                            ...previous.reasons,
                            ...(!geoComparable(current, previous) &&
                            !current.reasons.length &&
                            !previous.reasons.length
                              ? ['classification_changed' as const]
                              : []),
                          ]),
                        ],
                      },
                    }
                  : {}),
              };
              result.snapshot = hash({
                ...result,
                calculatedAt: undefined,
                snapshot: undefined,
                canManageCatalog: undefined,
                dataRevision: undefined,
              });
              return result;
            },
            true,
          ),
        deadline,
      );
    try {
      const key = hash({
        websiteId,
        p,
        access,
        scope: GEO_SCOPE_HASH,
        catalog: catalog.version,
        state: catalog.state,
      });
      const result =
        options.fresh || currentCacheContext()?.refresh
          ? await compute(options.signal)
          : await evidenceCache.read(
              `geo-weight:${key}`,
              [websiteCacheTag(websiteId)],
              compute,
              options.signal,
            );
      if (options.signal?.aborted) throw new LiekanError('统计读取已取消', 499);
      const after = await geoWeightTransaction(deadline, options.signal, tx =>
        readAccess(tx, actor, websiteId),
      );
      if (hash(accessBoundary(access)) !== hash(accessBoundary(after)))
        throw new LiekanError('统计基准已变化，请重新读取', 409);
      const generatedAt = Date.parse(result.calculatedAt);
      noteCacheResult({
        value: result,
        generatedAt,
        expiresAt: generatedAt + 5000,
        status: computedHere ? 'miss' : 'hit',
        tier: computedHere ? 'computed' : 'memory',
      });
      return result;
    } catch (error) {
      if (
        (error as any)?.code === 'P2028' ||
        /statement timeout/.test(String((error as any)?.message))
      )
        throw new AnalyticsUnavailable('GEO 权重计算未完成，请重新读取');
      if (['42P01', '42703'].includes((error as any)?.meta?.code))
        throw new LiekanError('当前环境缺少 GEO 权重所需的目录与日志证据能力', 503);
      throw error;
    }
  });
}

export class GeoWeightLockBusy extends Error {}
function warehouseGeoCompute<T>(deadline: number, signal: AbortSignal | undefined, work: (tx: AiTx) => Promise<T>, _repeatableRead = false) {
  return warehouseControlRead(work, { deadline, signal, stable: (sql, values) => {
    const rows = values as Record<string, unknown>[];
    // New accepted log facts use the pinned CH publication. Their PG diagnostic
    // revision may advance without changing the permissions or evidence policy.
    if (/FROM liekan_log_state\b/.test(sql)) return rows.map(({data_revision: _data, ...row}) => row);
    if (/FROM liekan_ingest_batch\b/.test(sql)) return rows.map(row => ({...row, count: Number(row.count) > 0}));
    return rows;
  } });
}
/** Compatibility callers share the durable daily publication path. */
export async function readGeoWeight(
  actor: CrawlerActor,
  websiteId: string,
  input: unknown,
  options: { signal?: AbortSignal; fresh?: boolean; deadline?: number } = {},
): Promise<GeoWeightResponse> {
  const { readLegacyGeoWeight } = await import('./geo-weight-snapshots');
  return readLegacyGeoWeight(actor, websiteId, input, options);
}

export async function calculateGeoWeight(...args: Parameters<typeof calculateGeoWeightAtBoundary>) {
  return warehouseEnabled()
    ? withinWarehouseReport(() => calculateGeoWeightAtBoundary(...args))
    : calculateGeoWeightAtBoundary(...args);
}
