import { warehouseEnabled } from '../warehouse/authority-routing';
import { applyFeaturePopulation } from '../contracts/population-results';
import { readBrowserPopulation } from './browser-population';
import { nativeSnapshot } from './native-snapshot';
import { nativeAggregate } from './native-aggregate';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
import { geographyVersion } from '../contracts/geography';
import { getPostgresCountrySQL } from '@/lib/country';
import { analyticsCache, analyticsCacheKey, websiteCacheTag } from './query-cache';
import { bypassQueryCache, noteCacheResult } from './cache-context';
import { statisticsCacheTtl } from './cache-policy';
import { Decimal } from '@prisma/client/runtime/client';
import {
  addDays,
  addHours,
  addMinutes,
  addMonths,
  addWeeks,
  addYears,
  format,
  startOfDay,
  startOfHour,
  startOfMinute,
  startOfMonth,
  startOfWeek,
  startOfYear,
} from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { goalParametersSchema } from '@/lib/analytics-schema';
import { analysisQuery, type JourneyData, journeyQuery } from '@/lib/liekan/contracts/analysis';
import prisma from '@/lib/prisma';
import { getQueryFilters } from '@/lib/request';
import type { Auth } from '@/lib/types';
import { canViewReport } from '@/permissions';
import { getReport, getWebsiteSegment } from '@/queries/prisma';
import { getRelationalHeatmapFilterContext } from '@/queries/sql/heatmap/getHeatmap';
import { classifyEntrySource } from './analytics';
import { classifyEntrySourceForDisplay } from '../contracts/sources';
import { LiekanError } from './server';

export function normalizeFeatureNumbers(value: any): any {
  if (typeof value === 'bigint') return Number(value);
  if (Decimal.isDecimal(value)) return value.toNumber();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeFeatureNumbers);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeFeatureNumbers(entry)]),
    );
  return value;
}
const clean = normalizeFeatureNumbers;
async function filtersFor(websiteId: string, input: any) {
  if (process.env.CLICKHOUSE_URL)
    throw new LiekanError(
      '此补充统计当前支持 PostgreSQL。可使用兼容页面查看现有 ClickHouse 统计。',
      501,
    );
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: input.timezone }).format();
  } catch {
    throw new LiekanError('时区无效');
  }
  for (const key of ['segment', 'cohort'])
    if (input[key] && !(await getWebsiteSegment(websiteId, input[key])))
      throw new LiekanError('人群条件不存在', 404);
  return getQueryFilters(input, websiteId);
}
function selectEvents(websiteId: string, filters: any, all = false, source = 'selected') {
  const { filterQuery, joinSessionQuery, cohortQuery, excludeBounceQuery, queryParams } =
    prisma.parseFilters({
      ...filters,
      websiteId,
    });
  return {
    cte: `WITH ${source} AS (SELECT website_event.* FROM website_event ${cohortQuery} ${joinSessionQuery} ${excludeBounceQuery} WHERE website_event.website_id={{websiteId::uuid}} AND website_event.created_at BETWEEN {{startDate}} AND {{endDate}} ${all ? '' : 'AND website_event.event_type IN (1,2)'} ${filterQuery})`,
    params: queryParams,
  };
}
function attributionCte(
  cte: string,
  source: string,
  p: { model: string; type: string },
  prefix = '',
) {
  const column = p.type === 'path' ? 'url_path' : 'event_name',
    direction = p.model === 'first-click' ? 'ASC' : 'DESC';
  return `${cte}, ${prefix}conversions AS(SELECT session_id,MAX(created_at) AS last_conversion FROM ${source} WHERE event_type={{${prefix}conversionType}} AND ${column}={{${prefix}step}} GROUP BY session_id), ${prefix}attributed AS(SELECT c.session_id,source.referrer_domain,source.hostname FROM ${prefix}conversions c LEFT JOIN LATERAL(SELECT e.referrer_domain,e.hostname FROM website_event e WHERE e.website_id={{websiteId::uuid}} AND e.session_id=c.session_id AND e.created_at BETWEEN {{startDate}} AND {{endDate}} AND e.created_at${p.model === 'last-click' ? '<' : '<='}c.last_conversion AND e.event_type IN(1,2) ORDER BY e.created_at ${direction},e.event_id ${direction} LIMIT 1) source ON TRUE)`;
}
async function featurePopulation(websiteId: string, p: any, load: () => Promise<any>) {
  return nativeSnapshot(async () => {
    const value = await load();
    const population = await readBrowserPopulation(
      websiteId,
      new Date(p.startAt),
      new Date(p.endAt),
      p.timezone,
    );
    return applyFeaturePopulation(value, p.kind || 'properties', population);
  });
}
export async function featureAnalytics(websiteId: string, input: unknown) {
  const parsed = analysisQuery.safeParse(input);
  if (!parsed.success) throw new LiekanError('统计参数无效');
  const { refresh, ...p } = parsed.data;
  const filters = await filtersFor(websiteId, {
    ...p,
    ...(p.eventName ? { drill_event: `eq.${p.eventName}` } : {}),
  });
  if (
    !bypassQueryCache() &&
    ['events', 'utm', 'sources', 'performance', 'attribution', 'heatmap-scroll'].includes(p.kind)
  ) {
    const result = await analyticsCache.read(
      analyticsCacheKey(`feature-analytics-v3-${geographyVersion}-${TRAFFIC_POLICY_VERSION}`, [
        process.env.DATABASE_URL,
        websiteId,
        p,
        filters,
      ]),
      statisticsCacheTtl(p.endAt, p.timezone),
      [websiteCacheTag(websiteId)],
      () => featurePopulation(websiteId, p, () => computeFeatureAnalytics(websiteId, p, filters)),
      refresh === '1',
    );
    noteCacheResult(result);
    return result.value;
  }
  return featurePopulation(websiteId, p, () => computeFeatureAnalytics(websiteId, p, filters));
}
async function computeFeatureAnalytics(websiteId: string, p: any, filters: any) {
  if (warehouseEnabled())
    return (await import('./warehouse-feature-analytics')).warehouseFeatureAnalytics(
      websiteId,
      p,
      filters,
    );
  let source = p.retentionDate ? 'cohort_events' : 'filtered_events';
  let { cte, params } = selectEvents(websiteId, filters, !!p.retentionDate, source);
  if (p.retentionDate) {
    if (!p.retentionDay) throw new LiekanError('留存观察日无效');
    cte = `${cte}, cohort_visitors AS(SELECT session_id FROM cohort_events GROUP BY session_id HAVING (${prisma.getDateSQL('MIN(created_at)', 'day', p.timezone)})::date={{retentionDate}}::date), returned AS(SELECT DISTINCT e.session_id FROM website_event e JOIN cohort_visitors c ON c.session_id=e.session_id WHERE e.website_id={{websiteId::uuid}} AND e.created_at BETWEEN {{startDate}} AND {{endDate}} AND (${prisma.getDateSQL('e.created_at', 'day', p.timezone)})::date={{retentionDate}}::date+{{retentionDay}}::int), retained_events AS(SELECT e.* FROM website_event e JOIN returned r ON r.session_id=e.session_id WHERE e.website_id={{websiteId::uuid}} AND e.created_at BETWEEN {{startDate}} AND {{endDate}})`;
    source = 'retained_events';
    params = { ...params, retentionDate: p.retentionDate, retentionDay: p.retentionDay };
  }
  if (p.attributionStep) {
    if (!p.attributionModel || !p.attributionType || p.attributionSource == null)
      throw new LiekanError('归因关联条件不完整');
    cte =
      attributionCte(
        cte,
        source,
        {
          model: p.attributionModel,
          type: p.attributionType,
        },
        'association_',
      ) +
      `,associated_events AS(SELECT * FROM ${source} WHERE session_id IN(SELECT session_id FROM association_attributed WHERE referrer_domain={{attributionSource}}))`;
    source = 'associated_events';
    params = {
      ...params,
      association_step: p.attributionStep,
      association_conversionType: p.attributionType === 'path' ? 1 : 2,
      attributionSource: p.attributionSource,
    };
  }
  cte += `,selected AS(SELECT * FROM ${source})`;
  const run = (sql: string, extra: any = {}) =>
    prisma.rawQuery(`${cte} ${sql}`, { ...params, ...extra }, 'liekanFeatureAnalytics').then(clean);
  if (p.kind === 'heatmap-scroll') {
    if (!p.urlPath) throw new LiekanError('请选择已采集页面');
    const ctx = getRelationalHeatmapFilterContext(websiteId, filters);
    const result = await prisma.rawQuery(
      `${cte}, depths AS(SELECT h.visit_id,MAX(h.scroll_pct) AS depth FROM heatmap_event h ${ctx.joinQuery} WHERE h.website_id={{websiteId::uuid}} AND h.event_type=2 AND h.url_path={{urlPath}} AND h.created_at BETWEEN {{startDate}} AND {{endDate}} AND h.scroll_pct IS NOT NULL AND h.page_w IS NOT NULL AND h.page_h IS NOT NULL AND h.viewport_w IS NOT NULL AND h.viewport_h IS NOT NULL ${p.retentionDate || p.attributionStep ? 'AND h.session_id IN(SELECT session_id FROM selected)' : ''} ${ctx.filterQuery} GROUP BY h.visit_id) SELECT COUNT(*) AS total,${[25, 50, 75, 100].map(depth => `COUNT(*) FILTER(WHERE depth>=${depth}) AS "reach${depth}"`).join(',')} FROM depths`,
      { ...params, ...ctx.queryParams, urlPath: p.urlPath },
      'liekanExactScrollDepth',
    );
    return clean(result[0]);
  }
  if (p.kind === 'replays') {
    const replayCte = `${cte}, replay_visits AS MATERIALIZED(SELECT DISTINCT r.visit_id,r.session_id FROM session_replay r WHERE r.website_id={{websiteId::uuid}} ${p.saved === '1' ? 'AND EXISTS(SELECT 1 FROM session_replay_saved saved WHERE saved.website_id=r.website_id AND saved.visit_id=r.visit_id)' : ''}), matching_visits AS(SELECT visit_id,session_id,COUNT(*) FILTER(WHERE event_type=1) AS pageviews,(ARRAY_AGG(referrer_domain ORDER BY created_at,event_id))[1] AS "referrerDomain",(ARRAY_AGG(liekan_browser ORDER BY created_at DESC,event_id DESC))[1] AS browser,(ARRAY_AGG(liekan_device ORDER BY created_at DESC,event_id DESC))[1] AS device FROM selected JOIN replay_visits USING(visit_id,session_id) GROUP BY visit_id,session_id), recordings AS(SELECT r.visit_id AS id,r.visit_id AS "visitId",r.session_id AS "sessionId",MIN(r.started_at) AS "startedAt",MAX(r.ended_at) AS "endedAt",EXTRACT(EPOCH FROM MAX(r.ended_at)-MIN(r.started_at))*1000 AS duration,SUM(r.event_count) AS "eventCount",COUNT(*) AS "chunkCount",MAX(m.pageviews) AS pageviews,MAX(m."referrerDomain") AS "referrerDomain",MAX(m.device) AS device,MAX(m.browser) AS browser,MAX(saved.name) AS name FROM session_replay r JOIN matching_visits m ON m.visit_id=r.visit_id AND m.session_id=r.session_id LEFT JOIN session_replay_saved saved ON saved.website_id=r.website_id AND saved.visit_id=r.visit_id WHERE r.website_id={{websiteId::uuid}} ${p.saved === '1' ? 'AND saved.visit_id IS NOT NULL' : ''} GROUP BY r.visit_id,r.session_id)`;
    const [count, rows] = await Promise.all([
      prisma.rawQuery(
        `${replayCte} SELECT COUNT(*) AS count FROM recordings`,
        params,
        'liekanReplayCount',
      ),
      prisma.rawQuery(
        `${replayCte} SELECT * FROM recordings ORDER BY "startedAt" DESC,id LIMIT 25 OFFSET {{offset}}`,
        { ...params, offset: (p.page - 1) * 25 },
        'liekanReplayRows',
      ),
    ]);
    return clean({ rows, count: count[0].count, page: p.page, pageSize: 25 });
  }
  if (p.kind === 'performance') {
    const { filterQuery, joinSessionQuery, cohortQuery, excludeBounceQuery, queryParams } =
      prisma.parseFilters({
        ...filters,
        websiteId,
      });
    const select = ['lcp', 'inp', 'cls', 'fcp', 'ttfb']
      .map(
        metric =>
          `COUNT(${metric}) AS "${metric}Count",percentile_cont(0.5) WITHIN GROUP(ORDER BY ${metric}) AS "${metric}P50",percentile_cont(0.75) WITHIN GROUP(ORDER BY ${metric}) AS "${metric}P75",percentile_cont(0.95) WITHIN GROUP(ORDER BY ${metric}) AS "${metric}P95"`,
      )
      .join(',');
    return clean(
      await prisma.rawQuery(
        `${cte} SELECT ${select} FROM website_event ${cohortQuery} ${joinSessionQuery} ${excludeBounceQuery} WHERE website_event.website_id={{websiteId::uuid}} AND website_event.created_at BETWEEN {{startDate}} AND {{endDate}} AND website_event.event_type=5 ${p.retentionDate || p.attributionStep ? 'AND website_event.session_id IN(SELECT session_id FROM selected)' : ''} ${filterQuery}`,
        { ...queryParams, ...params },
        'liekanPerformanceCounts',
      ),
    )[0];
  }
  if (p.kind === 'revenue') {
    if (!p.currency) throw new LiekanError('请选择币种');
    const revenueCte = `${cte}, transactions AS(SELECT r.event_id AS id,r.session_id AS "sessionId",r.event_name AS event,r.revenue AS amount,r.currency,r.created_at AS "createdAt" FROM revenue r WHERE r.website_id={{websiteId::uuid}} AND r.created_at BETWEEN {{startDate}} AND {{endDate}} AND UPPER(r.currency)={{currency}} AND EXISTS(SELECT 1 FROM selected s WHERE s.session_id=r.session_id OFFSET 0))`;
    const [count, rows] = await Promise.all([
      prisma.rawQuery(
        `${revenueCte} SELECT COUNT(*) AS count FROM transactions`,
        { ...params, currency: p.currency },
        'liekanRevenueCount',
      ),
      prisma.rawQuery(
        `${revenueCte} SELECT * FROM transactions ORDER BY "createdAt" DESC,id LIMIT 25 OFFSET {{offset}}`,
        { ...params, currency: p.currency, offset: (p.page - 1) * 25 },
        'liekanRevenueRows',
      ),
    ]);
    noteCacheResult({
      value: null,
      generatedAt: Date.now(),
      expiresAt: Date.now(),
      status: 'miss',
    });
    return clean({
      rows: rows.map(row => ({
        ...row,
        amount: Decimal.isDecimal(row.amount) ? row.amount.toString() : row.amount,
      })),
      count: count[0].count,
      page: p.page,
      pageSize: 25,
    });
  }
  if (p.kind === 'events') {
    const [totals, rows, names, values] = await Promise.all([
      run(
        `SELECT COUNT(*) AS total,COUNT(DISTINCT session_id) AS visitors,COUNT(DISTINCT event_name) AS types,COUNT(*) FILTER(WHERE EXISTS(SELECT 1 FROM event_data d WHERE d.website_id={{websiteId::uuid}} AND d.website_event_id=s.event_id)) AS "withProperties",MAX(created_at) AS "lastAt" FROM selected s WHERE event_type=2`,
      ),
      run(
        `SELECT event_name AS name,COUNT(*) AS triggers,COUNT(DISTINCT session_id) AS visitors,MAX(created_at) AS "lastAt",(SELECT COUNT(DISTINCT d.data_key) FROM event_data d JOIN selected e ON e.event_id=d.website_event_id WHERE d.website_id={{websiteId::uuid}} AND e.event_type=2 AND e.event_name=s.event_name) AS properties FROM selected s WHERE event_type=2 GROUP BY event_name ORDER BY triggers DESC,event_name LIMIT 100 OFFSET {{offset}}`,
        { offset: (p.page - 1) * 100 },
      ),
      run(
        `SELECT d.data_key AS name,d.data_type AS "dataType",COUNT(DISTINCT d.website_event_id) AS total FROM event_data d JOIN selected s ON s.event_id=d.website_event_id WHERE d.website_id={{websiteId::uuid}} AND s.event_type=2 GROUP BY 1,2 ORDER BY 1,2`,
      ),
      p.propertyName
        ? run(
            `SELECT d.string_value AS value,d.data_type AS "dataType",COUNT(DISTINCT d.website_event_id) AS total FROM event_data d JOIN selected s ON s.event_id=d.website_event_id WHERE d.website_id={{websiteId::uuid}} AND s.event_type=2 AND d.data_key={{propertyName}} GROUP BY 1,2 ORDER BY total DESC,value LIMIT 100`,
            { propertyName: p.propertyName },
          )
        : Promise.resolve([]),
    ]);
    return {
      totals: totals[0],
      rows,
      properties: names,
      values,
      page: p.page,
      pageSize: 100,
      count: totals[0].types,
      limited: values.length === 100,
    };
  }
  if (p.kind === 'utm') {
    const totals = await run(
      `SELECT COUNT(*) FILTER(WHERE event_type=1) AS views,COUNT(DISTINCT session_id) FILTER(WHERE event_type=1) AS visitors,COUNT(*) FILTER(WHERE event_type=2) AS events FROM selected WHERE COALESCE(utm_source,'')<>'' OR COALESCE(utm_medium,'')<>'' OR COALESCE(utm_campaign,'')<>'' OR COALESCE(utm_content,'')<>'' OR COALESCE(utm_term,'')<>''`,
    );
    if (!p.dimension) return totals[0];
    const column = `utm_${p.dimension}`;
    const [rows, dimension] = await Promise.all([
      run(
        `SELECT ${column} AS utm,COUNT(*) AS views FROM selected WHERE event_type=1 AND COALESCE(${column},'')<>'' GROUP BY 1 ORDER BY views DESC,utm LIMIT 101`,
      ),
      run(
        `SELECT COUNT(*) AS views FROM selected WHERE event_type=1 AND COALESCE(${column},'')<>''`,
      ),
    ]);
    return {
      ...totals[0],
      rows: rows.slice(0, 100),
      dimensionTotal: dimension[0].views,
      limited: rows.length > 100,
    };
  }
  if (p.kind === 'attribution') {
    if (!p.model || !p.type || !p.step) throw new LiekanError('归因条件不完整');
    const conversionType = p.type === 'path' ? 1 : 2;
    const attribution = attributionCte(cte, 'selected', { model: p.model, type: p.type });
    const known =
      "COALESCE(referrer_domain,'')<>'' AND referrer_domain<>regexp_replace(COALESCE(hostname,''),'^www\\.','')";
    const options = { ...params, conversionType, step: p.step };
    const [totals, rows] = await Promise.all([
      prisma.rawQuery(
        `${attribution} SELECT COUNT(*) AS visitors,COUNT(*) FILTER(WHERE ${known}) AS attributed FROM attributed`,
        options,
        'liekanAttributionTotals',
      ),
      prisma.rawQuery(
        `${attribution} SELECT referrer_domain AS name,COUNT(*) AS value FROM attributed WHERE ${known} GROUP BY 1 ORDER BY value DESC,name LIMIT 101`,
        options,
        'liekanAttributionRows',
      ),
    ]);
    return clean({ total: totals[0], referrer: rows.slice(0, 100), limited: rows.length > 100 });
  }
  if (p.kind === 'sources') {
    return run(
      `SELECT referrer_domain AS referrer,COUNT(DISTINCT session_id) AS visitors,COUNT(*) AS views FROM selected WHERE event_type=1 GROUP BY 1 ORDER BY visitors DESC,referrer_domain`,
    );
  }
  if (p.kind === 'session') {
    if (!p.sessionId) throw new LiekanError('请选择会话');
    const rows = await run(
      `SELECT event_id AS "eventId",session_id AS "sessionId",visit_id AS "visitId",created_at AS "createdAt",url_path AS "urlPath",url_query AS "urlQuery",referrer_domain AS "referrerDomain",event_type AS "eventType",event_name AS "eventName",hostname FROM selected WHERE session_id={{sessionId::uuid}} ORDER BY created_at,event_id LIMIT 1001 OFFSET {{offset}}`,
      { sessionId: p.sessionId, offset: (p.page - 1) * 1000 },
    );
    const totals = await run(
      `SELECT COUNT(*) FILTER(WHERE event_type=1) AS views,COUNT(*) FILTER(WHERE event_type=2) AS events,MIN(created_at) AS "firstAt",MAX(created_at) AS "lastAt",(ARRAY_AGG(url_path ORDER BY created_at,event_id))[1] AS "entryPath",(ARRAY_AGG(url_path ORDER BY created_at DESC,event_id DESC))[1] AS "exitPath",(ARRAY_AGG(referrer_domain ORDER BY created_at,event_id))[1] AS "referrerDomain",EXTRACT(EPOCH FROM MAX(created_at)-MIN(created_at)) AS seconds,COUNT(*) AS count FROM selected WHERE session_id={{sessionId::uuid}}`,
      { sessionId: p.sessionId },
    );
    return {
      rows: rows.slice(0, 1000),
      totals: totals[0],
      page: p.page,
      pageSize: 1000,
      more: rows.length > 1000,
    };
  }
  if (p.kind === 'sessions') {
    const [count, rows] = await Promise.all([
      run('SELECT COUNT(DISTINCT session_id) AS count FROM selected'),
      run(
        `SELECT s.session_id AS id,MIN(s.created_at) AS "firstAt",MAX(s.created_at) AS "lastAt",COUNT(DISTINCT visit_id) AS visits,COUNT(*) FILTER(WHERE event_type=1) AS views,COUNT(*) FILTER(WHERE event_type=2) AS events,EXTRACT(EPOCH FROM MAX(s.created_at)-MIN(s.created_at)) AS seconds,(ARRAY_AGG(s.referrer_domain ORDER BY s.created_at,s.event_id))[1] AS "referrerDomain",(ARRAY_AGG(s.url_path ORDER BY s.created_at DESC,s.event_id DESC))[1] AS "urlPath",${getPostgresCountrySQL('(ARRAY_AGG(s.liekan_country ORDER BY s.created_at DESC,s.event_id DESC))[1]')} AS country,(ARRAY_AGG(s.liekan_region ORDER BY s.created_at DESC,s.event_id DESC))[1] AS region,(ARRAY_AGG(s.liekan_city ORDER BY s.created_at DESC,s.event_id DESC))[1] AS city,(ARRAY_AGG(s.liekan_browser ORDER BY s.created_at DESC,s.event_id DESC))[1] AS browser,(ARRAY_AGG(s.liekan_os ORDER BY s.created_at DESC,s.event_id DESC))[1] AS os,(ARRAY_AGG(s.liekan_device ORDER BY s.created_at DESC,s.event_id DESC))[1] AS device FROM selected s GROUP BY s.session_id ORDER BY "lastAt" DESC,s.session_id LIMIT 25 OFFSET {{offset}}`,
        { offset: (p.page - 1) * 25 },
      ),
    ]);
    return { rows, count: count[0].count, page: p.page, pageSize: 25 };
  }
  if (p.kind === 'realtime') {
    const cutoff = new Date(p.endAt - 5 * 60000);
    const [totals, pages, sources] = await Promise.all([
      run(
        `SELECT COUNT(DISTINCT session_id) FILTER(WHERE created_at>={{cutoff}}) AS active,COUNT(*) FILTER(WHERE event_type=1) AS views,COUNT(*) FILTER(WHERE event_type=2) AS events FROM selected`,
        { cutoff },
      ),
      run(
        `SELECT url_path AS name,COUNT(DISTINCT session_id) AS value FROM selected WHERE created_at>={{cutoff}} AND event_type=1 GROUP BY 1 ORDER BY 2 DESC LIMIT 25`,
        { cutoff },
      ),
      run(
        `SELECT DISTINCT session_id AS id,referrer_domain AS referrer FROM selected WHERE created_at>={{cutoff}}`,
        { cutoff },
      ),
    ]);
    const ai = new Set(
      sources
        .filter(s => classifyEntrySource({ referrer: s.referrer }).channel === 'AI 搜索引荐')
        .map(s => s.id),
    );
    const sourceMap = new Map<string, { name: string; sourceLabel?: 'direct'; ids: Set<string> }>();
    for (const s of sources) {
      const label = classifyEntrySourceForDisplay({ referrer: s.referrer });
      const key = JSON.stringify([label.source, label.sourceLabel ?? null]);
      if (!sourceMap.has(key))
        sourceMap.set(key, {
          name: label.source,
          ...(label.sourceLabel ? { sourceLabel: label.sourceLabel } : {}),
          ids: new Set(),
        });
      sourceMap.get(key).ids.add(s.id);
    }
    return {
      totals: { ...totals[0], ai: ai.size },
      pages,
      sources: [...sourceMap.values()]
        .map(({ ids, ...source }) => ({ ...source, value: ids.size }))
        .sort((a, b) => b.value - a.value),
    };
  }
  const rows = await run(
    `,property_visitors AS MATERIALIZED(SELECT DISTINCT session_id FROM selected),property_rows AS MATERIALIZED(SELECT data_key,string_value,data_type,session_id FROM session_data WHERE website_id={{websiteId::uuid}}) SELECT d.data_key AS name,d.string_value AS value,d.data_type AS "dataType",COUNT(DISTINCT d.session_id) AS sessions FROM property_rows d WHERE d.session_id IN(SELECT session_id FROM property_visitors) GROUP BY 1,2,3 ORDER BY sessions DESC,name,value LIMIT 100 OFFSET {{offset}}`,
    { offset: (p.page - 1) * 100 },
  );
  return { rows, page: p.page, pageSize: 100, more: rows.length === 100 };
}
export async function featureJourney(websiteId: string, input: unknown): Promise<JourneyData> {
  const parsed = journeyQuery.safeParse(input);
  if (!parsed.success) throw new LiekanError('路径参数无效');
  const { refresh, ...p } = parsed.data;
  let nodes: string[];
  if (p.sequence) {
    try {
      nodes = JSON.parse(p.sequence);
    } catch {
      throw new LiekanError('路径标识无效');
    }
    if (
      !Array.isArray(nodes) ||
      !nodes.length ||
      nodes.length > 7 ||
      nodes.some(n => typeof n !== 'string' || n.length > 200)
    )
      throw new LiekanError('路径标识无效');
  }
  if (!nodes && !bypassQueryCache()) {
    const result = await analyticsCache.read(
      analyticsCacheKey(`feature-journey-v4-${geographyVersion}-${TRAFFIC_POLICY_VERSION}`, [
        process.env.DATABASE_URL,
        websiteId,
        p,
      ]),
      statisticsCacheTtl(p.endAt, p.timezone),
      [websiteCacheTag(websiteId)],
      () =>
        featurePopulation(websiteId, { ...p, kind: 'journey' }, () =>
          computeFeatureJourney(websiteId, p, nodes),
        ),
      refresh === '1',
    );
    noteCacheResult(result);
    return result.value;
  }
  return featurePopulation(websiteId, { ...p, kind: 'journey' }, () =>
    computeFeatureJourney(websiteId, p, nodes),
  );
}
async function computeFeatureJourney(
  websiteId: string,
  p: any,
  nodes?: string[],
): Promise<JourneyData> {
  const filters = await filtersFor(websiteId, {
    ...p,
    ...(p.type === 'all' ? {} : { eventType: p.type === 'pages' ? 1 : 2 }),
  });
  if (warehouseEnabled())
    return (await import('./warehouse-feature-journey')).warehouseFeatureJourney(
      websiteId,
      p,
      filters,
      nodes,
    );
  const { cte, params } = selectEvents(websiteId, filters);
  // Read each visit's first source from the full selection once before applying journey bounds.
  const sql = `${cte}, first_sources AS(SELECT DISTINCT ON(visit_id) visit_id,referrer_domain AS source FROM selected ORDER BY visit_id,created_at,event_id),annotated AS(SELECT *,COALESCE(NULLIF(event_name,''),url_path) AS node,LAG(COALESCE(NULLIF(event_name,''),url_path)) OVER(PARTITION BY visit_id ORDER BY created_at,event_id) AS previous FROM selected),deduplicated AS(SELECT * FROM annotated WHERE node IS DISTINCT FROM previous),ordered AS(SELECT *,ROW_NUMBER() OVER(PARTITION BY visit_id ORDER BY created_at,event_id)::int AS rn FROM deduplicated),starts AS(SELECT visit_id,MIN(rn) FILTER(WHERE {{startStep}}='' OR node={{startStep}}) AS start_rn FROM ordered GROUP BY visit_id),bounds AS(SELECT o.visit_id,s.start_rn,CASE WHEN {{endStep}}='' THEN s.start_rn+{{steps}}::int-1 ELSE MIN(o.rn) FILTER(WHERE o.rn>s.start_rn AND o.node={{endStep}}) END AS end_rn FROM ordered o JOIN starts s ON s.visit_id=o.visit_id GROUP BY o.visit_id,s.start_rn),windowed AS(SELECT o.* FROM ordered o JOIN bounds b ON b.visit_id=o.visit_id WHERE b.start_rn IS NOT NULL AND b.end_rn IS NOT NULL AND b.end_rn<=b.start_rn+{{steps}}::int-1 AND o.rn BETWEEN b.start_rn AND b.end_rn),eligible AS(SELECT w.visit_id,w.session_id,ARRAY_AGG(w.node ORDER BY w.rn) AS nodes,EXTRACT(EPOCH FROM MAX(w.created_at)-MIN(w.created_at)) AS seconds,source.source FROM windowed w JOIN first_sources source ON source.visit_id=w.visit_id GROUP BY w.visit_id,w.session_id,source.source HAVING COUNT(*)>=2)`;
  const run = (query: string, extra: any = {}) =>
    prisma
      .rawQuery(
        `${sql} ${query}`,
        { ...params, steps: p.steps, startStep: p.startStep, endStep: p.endStep, ...extra },
        'liekanFeatureJourney',
      )
      .then(clean);
  const [total, rows] = await Promise.all([
    run('SELECT COUNT(DISTINCT session_id) AS visitors FROM eligible'),
    run(
      `SELECT e.nodes,COUNT(DISTINCT e.session_id) AS visitors,COUNT(*) AS visits,AVG(e.seconds) AS seconds,(SELECT g.source FROM eligible g WHERE g.nodes=e.nodes GROUP BY g.source ORDER BY COUNT(DISTINCT g.session_id) DESC,g.source LIMIT 1) AS source FROM eligible e ${nodes ? 'WHERE e.nodes={{nodes}}::text[]' : ''} GROUP BY e.nodes ORDER BY visitors DESC,e.nodes LIMIT 101`,
      { nodes },
    ),
  ]);
  const mapped = rows.slice(0, 100).map(row => ({
    ...row,
    source: row.source ? classifyEntrySource({ referrer: row.source }).source : null,
  }));
  let sessions: any[], count: number;
  if (nodes) {
    const results = await Promise.all([
      run(
        'SELECT COUNT(DISTINCT session_id) AS count FROM eligible WHERE nodes={{nodes}}::text[]',
        { nodes },
      ),
      run(
        `SELECT e.session_id AS id,MIN(d.created_at) AS "firstAt",MAX(d.created_at) AS "lastAt",COUNT(*) FILTER(WHERE d.event_type=1) AS views,EXTRACT(EPOCH FROM MAX(d.created_at)-MIN(d.created_at)) AS seconds,(ARRAY_AGG(d.url_path ORDER BY d.created_at DESC,d.event_id DESC))[1] AS "urlPath",(ARRAY_AGG(d.referrer_domain ORDER BY d.created_at,d.event_id))[1] AS "referrerDomain",${getPostgresCountrySQL('(ARRAY_AGG(d.liekan_country ORDER BY d.created_at DESC,d.event_id DESC))[1]')} AS country,(ARRAY_AGG(d.liekan_region ORDER BY d.created_at DESC,d.event_id DESC))[1] AS region,(ARRAY_AGG(d.liekan_city ORDER BY d.created_at DESC,d.event_id DESC))[1] AS city,(ARRAY_AGG(d.liekan_browser ORDER BY d.created_at DESC,d.event_id DESC))[1] AS browser,(ARRAY_AGG(d.liekan_device ORDER BY d.created_at DESC,d.event_id DESC))[1] AS device FROM eligible e JOIN selected d ON d.visit_id=e.visit_id WHERE e.nodes={{nodes}}::text[] GROUP BY e.session_id ORDER BY "lastAt" DESC,e.session_id LIMIT 25 OFFSET {{offset}}`,
        { nodes, offset: (p.page - 1) * 25 },
      ),
    ]);
    count = results[0][0].count;
    sessions = results[1];
  }
  return {
    rows: mapped,
    visitors: total[0].visitors,
    sessions,
    count,
    page: p.page,
    pageSize: 25,
    limited: rows.length > 100,
  };
}

export async function featureGoal(websiteId: string, goalId: string, input: unknown, auth: Auth) {
  const p = analysisQuery.parse(input);
  const report = await getReport(goalId);
  if (!report || report.websiteId !== websiteId || report.type !== 'goal')
    throw new LiekanError('目标不存在', 404);
  if (!(await canViewReport(auth, report))) throw new LiekanError('无权查看此目标', 403);
  const goal = goalParametersSchema.safeParse(report.parameters);
  if (!goal.success) throw new LiekanError('目标条件无效');
  const filters = await filtersFor(websiteId, p);
  return nativeAggregate(
    'liekanFeatureGoal',
    websiteId,
    { ...p, goalId, goal: goal.data, endDate: filters.endDate },
    filters,
    () =>
      featurePopulation(websiteId, { ...p, kind: 'goal' }, () =>
        computeFeatureGoal(websiteId, goal.data, p, filters),
      ),
  );
}
async function computeFeatureGoal(
  websiteId: string,
  goal: ReturnType<typeof goalParametersSchema.parse>,
  p: ReturnType<typeof analysisQuery.parse>,
  filters: Awaited<ReturnType<typeof filtersFor>>,
) {
  const { type, value } = goal;
  let { cte, params } = selectEvents(websiteId, filters);
  if (p.requireUtm === '1')
    cte = cte.replace(
      'AND website_event.event_type IN (1,2)',
      "AND website_event.event_type IN (1,2) AND (COALESCE(utm_source,'')<>'' OR COALESCE(utm_medium,'')<>'' OR COALESCE(utm_campaign,'')<>'' OR COALESCE(utm_content,'')<>'' OR COALESCE(utm_term,'')<>'')",
    );
  const column = type === 'path' ? 'url_path' : 'event_name';
  const operator = value.startsWith('*') || value.endsWith('*') ? 'LIKE' : '=';
  const target = value.replace(/^\*|\*$/g, '%');
  const matching = `event_type=${type === 'path' ? 1 : 2} AND ${column} ${operator} {{target}}`;
  const dateSQL = prisma
    .getDateSQL('created_at', p.unit === 'week' ? 'day' : p.unit, p.timezone)
    .replace(p.unit === 'week' ? "date_trunc('day'," : '__unused__', "date_trunc('week',");
  const run = (sql: string) =>
    prisma.rawQuery(`${cte} ${sql}`, { ...params, target }, 'liekanFeatureGoal').then(clean);
  const [totals, series] = warehouseEnabled()
    ? await (await import('./warehouse-feature-analytics')).warehouseFeatureGoal(
        websiteId,
        goal,
        p,
        filters,
      )
    : await Promise.all([
        run(
          `SELECT COUNT(*) FILTER(WHERE ${matching}) AS conversions,COUNT(DISTINCT session_id) FILTER(WHERE ${matching}) AS num,COUNT(DISTINCT session_id) AS total FROM selected`,
        ),
        run(
          `SELECT ${dateSQL} AS x,COUNT(*) AS y FROM selected WHERE ${matching} GROUP BY 1 ORDER BY 1`,
        ),
      ]);
  const starts: any = {
    minute: startOfMinute,
    hour: startOfHour,
    day: startOfDay,
    week: (d: Date) => startOfWeek(d, { weekStartsOn: 1 }),
    month: startOfMonth,
    year: startOfYear,
  };
  const adds: any = {
    minute: addMinutes,
    hour: addHours,
    day: addDays,
    week: addWeeks,
    month: addMonths,
    year: addYears,
  };
  const bucketFormat: any = {
    minute: "yyyy-MM-dd'T'HH:mm:00'Z'",
    hour: "yyyy-MM-dd'T'HH:00:00'Z'",
    day: "yyyy-MM-dd'T'00:00:00'Z'",
    week: "yyyy-MM-dd'T'00:00:00'Z'",
    month: "yyyy-MM-01'T'00:00:00'Z'",
    year: "yyyy-01-01'T'00:00:00'Z'",
  };
  const byDate = new Map(series.map((r: any) => [r.x, Number(r.y)]));
  const filled: any[] = [];
  for (
    let point = starts[p.unit](toZonedTime(p.startAt, p.timezone)),
      end = toZonedTime(p.endAt, p.timezone);
    point <= end;
    point = adds[p.unit](point, 1)
  ) {
    if (filled.length >= 10000) throw new LiekanError('图表时间桶过多，请改用更大的时间单位', 413);
    const x = format(point, bucketFormat[p.unit]);
    filled.push({ x, y: byDate.get(x) || 0 });
  }
  return { ...totals[0], series: filled };
}
