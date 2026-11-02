import { withPublishedRegistry } from './crawler-registry-context';
import { getPublishedCatalog } from '../crawlers/published';
import { CRAWLER_POPULATION_VERSION } from '../rules/population';
import { geographyVersion } from '../contracts/geography';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { type LiekanPageReport, pageReportParts, pageReportSchema } from '../contracts/page-report';
import { parseReportQuery } from '../contracts/query';
import { buildReport } from '../report';
import { readKeywordPage } from './keywords';
import { withoutQueryCache, noteBrowserPopulation } from './cache-context';
import { LiekanError } from './errors';
import {
  analyticsCache,
  analyticsCacheKey,
  type CachedResult,
  websiteCacheTag,
} from './query-cache';
import { query, reportSnapshot } from './server';
import { attachReportEvidenceView } from './report-evidence-view';
import { dashboardClock } from './dashboard-clock';
import { DASHBOARD_INTERVAL } from './dashboard-snapshot-model';
import { withReportFragments } from './report-fragments';

async function readPageReportSnapshot(
  website: { id: string; name: string; domain: string },
  input: unknown,
  refresh = false,
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
      withoutQueryCache(async () =>
        attachReportEvidenceView(await buildReport(website, false, p, true), parsed.data),
      ),
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
  if (!ttl) {
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

export const readPageReport: typeof readPageReportSnapshot = async (...args) => {
  const load = () => withReportFragments(args[0].id, () => readPageReportSnapshot(...args));
  const result = process.env.CLICKHOUSE_URL ? await load() : await withPublishedRegistry(load);
  // The inner cache bypass owns its context; publish validated evidence to the caller's envelope.
  for (const population of [result.value.meta.population, result.value.meta.trendPopulation])
    if (population) noteBrowserPopulation(args[0].id, population);
  return result;
};

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
