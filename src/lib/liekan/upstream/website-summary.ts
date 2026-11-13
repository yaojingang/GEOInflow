import { warehouseEnabled } from '../warehouse/authority-routing';
import { readBrowserPopulation } from './browser-population';
import {
  type BrowserPopulation,
  identityUsable,
  totalIdentityFields,
  unavailableFields,
} from '../contracts/browser-population';
import { checkAuth } from '@/lib/auth';
import { DEFAULT_RESET_DATE } from '@/lib/constants';
import { getCompareDate } from '@/lib/date';
import prisma, { getRawQueryClient } from '@/lib/prisma';
import { getQueryFilters } from '@/lib/request';
import type { Auth } from '@/lib/types';
import { canViewWebsiteSection } from '@/permissions';
import { getWebsiteDateRange, getWebsiteStats } from '@/queries/sql';
import { websiteSummaryQuery, websiteSummarySchema } from '../contracts/website-summary';
import { statisticsCacheTtl } from './cache-policy';
import {
  bindCacheRequest,
  noteCacheResult,
  prepareAnalyticsVersions,
  withoutQueryCache,
} from './cache-context';
import { channelFilterColumn } from './filter-extension';
import { analyticsCache, analyticsCacheKey, websiteCacheTag } from './query-cache';
import { LiekanError, query } from './server';

export async function readWebsiteSummary(request: Request, input: unknown) {
  const parsed = websiteSummaryQuery.safeParse(input);
  if (!parsed.success) throw new LiekanError('网站或日期参数无效');
  const p = {
    ...parsed.data,
    ids: parsed.data.ids
      ? [...new Set(parsed.data.ids.split(',').map(id => id.toLowerCase()))].sort()
      : [],
  };
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: p.timezone }).format();
  } catch {
    throw new LiekanError('时区无效');
  }
  const auth = await checkAuth(request);
  if (!auth?.user || auth.user.deletedAt || ('shareToken' in auth && auth.shareToken))
    throw new LiekanError('需要完整登录', 401);
  bindCacheRequest(
    request,
    auth,
    parsed.data,
    async () => {
      const fresh = await checkAuth(request);
      return !!fresh?.user && fresh.user.id === auth.user.id && fresh.user.role === auth.user.role;
    },
    { allowWarehousePublicationAdvance: true },
  );
  await prepareAnalyticsVersions(p.ids.map(websiteCacheTag));
  // Check current ownership and permissions before every cache read.
  const sites = await (
    getRawQueryClient(prisma.client, { write: true }) as typeof prisma.client
  ).website.findMany({
    where: { id: { in: p.ids }, deletedAt: null },
    select: { id: true, createdAt: true },
  });
  if (sites.length !== p.ids.length) throw new LiekanError('网站不存在', 404);
  const allowed = await Promise.all(
    p.ids.map(id => canViewWebsiteSection(auth as Auth, id, ['overview', 'compare'])),
  );
  if (allowed.some(value => !value)) throw new LiekanError('无权访问网站', 403);
  const ttl = Math.min(30000, statisticsCacheTtl(p.endAt, p.timezone));
  if (!p.ids.length) return [];
  const current = { startDate: new Date(p.startAt), endDate: new Date(p.endAt) };
  const previous = getCompareDate('prev', current.startDate, current.endDate, p.timezone);
  const zero = { pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0, aiVisits: 0 };
  const normalize = (row: any) =>
    Object.fromEntries(
      Object.keys(zero).map(key => [key, row?.[key] === null ? null : Number(row?.[key] ?? 0)]),
    ) as typeof zero;
  const populationTotals = (row: any, population: BrowserPopulation) => {
    const totals = normalize(row);
    return identityUsable(population)
      ? totals
      : unavailableFields(totals, [
          ...totalIdentityFields,
          'aiVisits',
          ...(population.metricScope === 'qualified-browser' ? ['pageviews'] : []),
        ]);
  };
  const result = await analyticsCache.read(
    analyticsCacheKey('website-summary-browser-population-v3', [
      process.env.DATABASE_URL,
      process.env.CLICKHOUSE_URL,
      p,
      sites,
    ]),
    ttl,
    p.ids.map(websiteCacheTag),
    async () => {
      if(warehouseEnabled())return (await import('./warehouse-website-summary')).warehouseWebsiteSummaries(sites,p);
      if (process.env.CLICKHOUSE_URL || process.env.CLOUD_MODE) {
        const rows = [];
        // Bound compatibility fallback fan-out; PostgreSQL uses one grouped query.
        for (const site of sites) {
          const filters = await getQueryFilters(
            { startAt: p.startAt, endAt: p.endAt, timezone: p.timezone },
            site.id,
          );
          const comparisonFilters = getCompareDate(
            'prev',
            filters.startDate,
            filters.endDate,
            p.timezone,
          );
          const lifetimeFilters = await getQueryFilters(
            { startAt: +site.createdAt, endAt: Date.now() },
            site.id,
          );
          // The AI drill mirrors the workspace AI card: event-level channel attribution.
          const [stats, comparison, dates, lifetime, ai, aiComparison] = await withoutQueryCache(
            () =>
              Promise.all([
                getWebsiteStats(site.id, filters),
                getWebsiteStats(site.id, { ...filters, ...comparisonFilters }),
                getWebsiteDateRange(site.id),
                getWebsiteStats(site.id, lifetimeFilters),
                getWebsiteStats(site.id, { ...filters, drill_channel: 'eq.AI 搜索引荐' }),
                getWebsiteStats(site.id, {
                  ...filters,
                  ...comparisonFilters,
                  drill_channel: 'eq.AI 搜索引荐',
                }),
              ]),
          );
          rows.push({
            id: site.id,
            ...normalize(stats),
            population: stats.population,
            comparison: {
              ...normalize(comparison),
              aiVisits: normalize(aiComparison).visits,
              population: comparison.population,
            },
            views: normalize(stats).pageviews,
            received: normalize(lifetime).pageviews > 0,
            lastAt: dates?.endDate ? new Date(dates.endDate).toISOString() : null,
            aiVisits: normalize(ai).visits,
          });
        }
        return websiteSummarySchema.parse(rows);
      }
      const facts = await query(
        `WITH windows(label,start_at,end_at) AS (VALUES ('current',$2::timestamptz,$3::timestamptz),('previous',$4::timestamptz,$5::timestamptz)), visits AS (
        SELECT e.website_id,w.label,e.session_id,e.visit_id,
          COUNT(*) FILTER(WHERE e.event_type NOT IN (2,5)) AS c,
          MIN(e.created_at) FILTER(WHERE e.event_type NOT IN (2,5)) AS first_at,
          MAX(e.created_at) FILTER(WHERE e.event_type NOT IN (2,5)) AS last_at,
          MAX(CASE WHEN e.event_type=2 THEN 1 ELSE 0 END) AS custom,
          MAX(CASE WHEN e.event_type NOT IN (2,5) AND ${channelFilterColumn('e.')}='AI 搜索引荐' THEN 1 ELSE 0 END) AS ai
        FROM website_event e JOIN windows w ON e.created_at BETWEEN w.start_at AND w.end_at
        WHERE e.website_id=ANY($1::uuid[]) AND e.event_type!=5
        GROUP BY 1,2,3,4 HAVING COUNT(*) FILTER(WHERE e.event_type NOT IN (2,5))>0
      ), totals AS (
        SELECT v.website_id,v.label,SUM(v.c) AS pageviews,COUNT(DISTINCT v.session_id) AS visitors,COUNT(DISTINCT v.visit_id) AS visits,
          SUM(CASE WHEN v.c=1 AND v.custom=0 THEN 1 ELSE 0 END) AS bounces,SUM(FLOOR(EXTRACT(epoch FROM v.last_at-v.first_at))) AS totaltime,
          COUNT(DISTINCT v.visit_id) FILTER(WHERE v.ai=1) AS "aiVisits"
        FROM visits v
        GROUP BY 1,2
      ) SELECT w.website_id AS id,
        COALESCE((SELECT row_to_json(t) FROM totals t WHERE t.website_id=w.website_id AND label='current'),'{}') AS current,
        COALESCE((SELECT row_to_json(t) FROM totals t WHERE t.website_id=w.website_id AND label='previous'),'{}') AS previous,
        EXISTS(SELECT 1 FROM liekan_raw_website_event e WHERE e.website_id=w.website_id AND e.event_type NOT IN (2,5) AND e.created_at BETWEEN w.created_at AND $6::timestamptz) AS received,
        (SELECT MAX(e.created_at) FROM liekan_raw_website_event e WHERE e.website_id=w.website_id AND e.created_at >= $7::timestamptz) AS last_at
        FROM website w WHERE w.website_id=ANY($1::uuid[]) ORDER BY w.website_id`,
        p.ids,
        current.startDate,
        current.endDate,
        previous.startDate,
        previous.endDate,
        new Date(),
        new Date(DEFAULT_RESET_DATE),
      );
      return websiteSummarySchema.parse(
        await Promise.all(
          facts.map(async row => {
            const population = await readBrowserPopulation(
              row.id,
              current.startDate,
              current.endDate,
              p.timezone,
            );
            const comparisonPopulation = await readBrowserPopulation(
              row.id,
              previous.startDate,
              previous.endDate,
              p.timezone,
            );
            const currentTotals = populationTotals(row.current, population),
              previousTotals = populationTotals(row.previous, comparisonPopulation);
            return {
              id: row.id,
              ...currentTotals,
              population,
              comparison: {
                ...previousTotals,
                population: comparisonPopulation,
              },
              views: currentTotals.pageviews,
              received: row.received,
              lastAt: row.last_at?.toISOString() ?? null,
            };
          }),
        ),
      );
    },
  );
  noteCacheResult(result);
  return result.value;
}
