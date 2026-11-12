import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { geographyVersion } from '../contracts/geography';
import { type LiekanPageReport, pageReportParts, pageReportSchema } from '../contracts/page-report';
import { parseReportQuery } from '../contracts/query';
import type { Row } from '../contracts/report';
import { getPublishedCatalog } from '../crawlers/published';
import { buildReport } from '../report';
import { CRAWLER_POPULATION_VERSION } from '../rules/population';
import { warehouseEnabled } from '../warehouse/runtime';
import { noteBrowserPopulation, withoutQueryCache } from './cache-context';
import { withPublishedRegistry } from './crawler-registry-context';
import { dashboardClock } from './dashboard-clock';
import { DASHBOARD_INTERVAL } from './dashboard-snapshot-model';
import { LiekanError } from './errors';
import { readKeywordPage } from './keywords';
import {
  analyticsCache,
  analyticsCacheKey,
  type CachedResult,
  websiteCacheTag,
} from './query-cache';
import { attachReportEvidenceView } from './report-evidence-view';
import { withReportFragments } from './report-fragments';
import { query, reportSnapshot } from './server';

type PageReportWebsite = { id: string; name: string; domain: string };
export type WarehouseOverviewResult = LiekanPageReport & {
  overviewRanking?: { table: 'topBody' | 'visitorTopBody'; rows: Row[] };
};

async function readPageReportSnapshot(
  website: PageReportWebsite,
  input: unknown,
  refresh = false,
  overviewSnapshot = false,
): Promise<CachedResult<LiekanPageReport>> {
  const parsed = parseReportQuery(input);
  if (!parsed.success) throw new LiekanError('统计参数无效');
  const { refresh: requestedRefresh, ...p } = parsed.data;
  let today: number;
  try {
    today = +fromZonedTime(
      `${formatInTimeZone(Date.now(), p.timezone, 'yyyy-MM-dd')}T00:00:00`,
      p.timezone,
    );
  } catch {
    throw new LiekanError('时区无效');
  }
  const historical =
    p.endAt < today ||
    (p.crawlerMetricsVersion === 1 && p.resource.startsWith('ai/') && p.endAt === today);
  const ttl =
    p.resource === 'logs' ? 0 : historical && !pageReportParts[p.resource].today ? 300000 : 30000;
  if (p.resource === 'human/keywords') {
    const result = await readKeywordPage(
      website,
      { ...p, refresh: requestedRefresh },
      ttl,
      refresh || requestedRefresh === '1',
    );
    return {
      ...result,
      value: pageReportSchema.parse({
        ...result.value,
        resource: p.resource,
        meta: {
          ...result.value.meta,
          catalogVersion: getPublishedCatalog()?.version,
          generatedAt: result.generatedAt,
          expiresAt: result.expiresAt,
        },
      }) as LiekanPageReport,
    };
  }
  const load = async () => {
    const report = await reportSnapshot(() =>
      withoutQueryCache(async () => {
        const prepared = warehouseEnabled()
          ? await (await import('./warehouse-page-report')).prepareWarehousePageReport(
              website,
              parsed.data,
              overviewSnapshot,
            )
          : undefined;
        try {
          return await attachReportEvidenceView(
            await buildReport(website, false, p, true, false, undefined, prepared),
            parsed.data,
          );
        } finally {
          await prepared?.dispose?.();
        }
      }),
    );
    const generatedAt = Date.now();
    return pageReportSchema.parse({
      ...report,
      resource: p.resource,
      meta: {
        ...report.meta,
        generatedAt,
        expiresAt: generatedAt + ttl,
        ...(dashboardClock()
          ? {
              snapshot: {
                dataThrough: dashboardClock().cutoff,
                state: 'ready',
                intervalMs: DASHBOARD_INTERVAL,
              },
            }
          : {}),
      },
    }) as LiekanPageReport;
  };
  if (!ttl || overviewSnapshot) {
    const value = await load();
    return {
      value,
      generatedAt: value.meta.generatedAt,
      expiresAt: value.meta.expiresAt,
      status: 'miss',
    };
  }
  const revision = analyticsCache.isRuntimeConfigured
    ? undefined
    : (
        await query(
          `SELECT coalesce((SELECT data_revision::text FROM liekan_log_state WHERE website_id=$1::uuid),'0') AS data,coalesce((SELECT policy_revision::text FROM liekan_log_state WHERE website_id=$1::uuid),'0') AS policy,coalesce((SELECT revision::text FROM liekan_analytics_revision WHERE resource_type='website' AND resource_id=$1::uuid),'0') AS geography`,
          website.id,
        )
      )[0] || { data: '0', policy: '0' };
  const key = analyticsCacheKey(
    `page-report-v11-${geographyVersion}-${CRAWLER_POPULATION_VERSION}`,
    [process.env.DATABASE_URL, website.id, p, revision],
  );
  const result = await analyticsCache.read(
    key,
    ttl,
    [websiteCacheTag(website.id)],
    load,
    refresh || requestedRefresh === '1',
  );
  result.value.meta.generatedAt = result.generatedAt;
  result.value.meta.expiresAt = result.expiresAt;
  return result;
}

export async function readPageReport(website: PageReportWebsite, input: unknown, refresh = false) {
  const read = () => readPageReportSnapshot(website, input, refresh);
  const load = () => (warehouseEnabled() ? read() : withReportFragments(website.id, read));
  const result = process.env.CLICKHOUSE_URL ? await load() : await withPublishedRegistry(load);
  // The inner cache bypass owns its context; publish validated evidence to the caller's envelope.
  for (const population of [result.value.meta.population, result.value.meta.trendPopulation])
    if (population) noteBrowserPopulation(website.id, population);
  return result;
}

export async function computeWarehouseOverview(
  website: PageReportWebsite,
  input: unknown,
): Promise<WarehouseOverviewResult> {
  const { value } = await readPageReportSnapshot(website, input, false, true);
  const table = value.meta.aiCrawlerEnabled === false ? 'visitorTopBody' : 'topBody';
  const paging = value.meta.tablePages?.[table];
  if (paging?.page !== 1) return value;
  const rows = value.tables[table];
  return {
    ...value,
    tables: { ...value.tables, [table]: rows.slice(0, paging.pageSize) },
    overviewRanking: { table, rows: rows.slice(paging.pageSize) },
  };
}

/** A private async request checks the identical cache identity without starting SQL. */
export async function peekPageReport(website: { id: string }, input: unknown) {
  const parsed = parseReportQuery(input);
  if (!parsed.success) throw new LiekanError('统计参数无效');
  const { refresh, ...p } = parsed.data;
  if (refresh === '1' || ['logs', 'human/keywords'].includes(p.resource)) return undefined;
  // Production runtime resolves resource versions. Standalone tests keep the existing direct path.
  if (!analyticsCache.isRuntimeConfigured) return undefined;
  const key = analyticsCacheKey(
    `page-report-v11-${geographyVersion}-${CRAWLER_POPULATION_VERSION}`,
    [process.env.DATABASE_URL, website.id, p, undefined],
  );
  return analyticsCache.peek<LiekanPageReport>(key, [websiteCacheTag(website.id)]);
}
