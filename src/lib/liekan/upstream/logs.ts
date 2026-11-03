import { readClickHouseLogRollup, readClickHouseLogSeries } from './analytics-engine-read';
import {
  readAnalysisLogRollup,
  readAnalysisLogSeries,
  readAnalysisLogToday,
} from './analysis-rollups';
import { getPublishedCatalog } from '../crawlers/published';
import { createHash } from 'node:crypto';
import { CRAWLER_POPULATION_VERSION } from '../rules/population';
import type { CrawlerMetricOptions } from '../contracts/crawler-metrics';
import type { CrawlerPageFilters } from '../contracts/query';
import { crawlerIdentitySql } from '../crawlers/metric-scope';
import { crawlerAiSql, unknownCrawlerSql } from '../rules/population';
import { logInputConnectedSql } from './log-input';
import { withLogStatisticsRead } from './ai-log-read-priority';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { calendarDayRange } from '../contracts/calendar';
import { readReportFragment, reportFragmentsActive } from './report-fragments';
import { analysisSafeNumber } from './analysis-rollups-model';
import { decodeCursor, encodeCursor } from '../cursor';
import { humanPathFromEncoded } from './paths';
import { LiekanError, query } from './server';
import { staticRequestExtensionPattern } from './log-content-boundary';

export { staticRequestExtensionPattern, isStaticRequestPath } from './log-content-boundary';

const readPreferredLogRollup = async (input: Parameters<typeof readAnalysisLogRollup>[0]) =>
  (await readClickHouseLogRollup(input)) ?? readAnalysisLogRollup(input);
const readLogSeries = async (
  input: Parameters<typeof readAnalysisLogSeries>[0],
  allowRawOnly = false,
) =>
  (await readClickHouseLogSeries(input)) ??
  readAnalysisLogSeries(allowRawOnly ? { ...input, allowRawOnly: true } : input);

async function readPreferredLogSeries(input: Parameters<typeof readAnalysisLogSeries>[0]) {
  if (!reportFragmentsActive() || input.crawlerMetricsVersion !== 1) return readLogSeries(input);
  const { startDate, endDate, websiteId, ...conditions } = input;
  const timezone = input.timezone || 'UTC';
  const boundaries = [+startDate];
  if (input.grain === 'month') {
    const [year, month] = formatInTimeZone(startDate, timezone, 'yyyy-MM').split('-').map(Number);
    for (let offset = 1; offset <= 36; offset++) {
      const next = new Date(Date.UTC(year, month - 1 + offset, 1));
      const at = +fromZonedTime(`${next.toISOString().slice(0, 10)}T00:00:00`, timezone);
      if (at >= +endDate) break;
      boundaries.push(at);
    }
  } else {
    const today = calendarDayRange(Date.now(), timezone).startAt;
    if (today > +startDate && today < +endDate) boundaries.push(today);
  }
  boundaries.push(+endDate);
  const combined = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof readAnalysisLogSeries>>>[number]
  >();
  for (let index = 1; index < boundaries.length; index++) {
    const start = new Date(boundaries[index - 1]),
      end = new Date(boundaries[index]);
    const rows = await readReportFragment('log-series', start, end, conditions, () =>
      readLogSeries({ ...input, startDate: start, endDate: end }, true),
    );
    if (!rows) return null;
    for (const row of rows) {
      const key = JSON.stringify([row.day, row.bot, row.type]);
      const previous = combined.get(key);
      combined.set(
        key,
        previous
          ? {
              ...row,
              count: analysisSafeNumber((BigInt(previous.count) + BigInt(row.count)).toString()),
              aiRequests: analysisSafeNumber(
                (BigInt(previous.aiRequests) + BigInt(row.aiRequests)).toString(),
              ),
            }
          : { ...row },
      );
    }
  }
  return [...combined.values()].sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      a.bot.localeCompare(b.bot) ||
      (a.type || '').localeCompare(b.type || ''),
  );
}
export async function getLogFacts(...args: Parameters<typeof readLogFacts>) {
  return withLogStatisticsRead(() => readLogFacts(...args));
}
async function readLogFacts(
  id: string,
  start: Date,
  end: Date,
  timezone: string,
  page = 1,
  filter = '',
  search = '',
  cursor = '',
  seek: 'after' | 'before' = 'after',
  fields?: readonly string[],
  metrics: CrawlerMetricOptions & CrawlerPageFilters & { resource?: string } = {
    crawlerIdentityScope: 'all',
  },
  fullExport = false,
  comparisonBoundary?: [Date, string],
) {
  const read = <T = any>(sql: string, ...params: any[]) =>
    withLogStatisticsRead(() => query<T>(sql, ...params));
  const timeCondition =
    metrics.crawlerMetricsVersion === 1
      ? "created_at >= $2::timestamptz AND created_at < $3::timestamptz AND user_agent NOT LIKE 'Liekan-Crawler-Check/%'"
      : 'created_at BETWEEN $2::timestamptz AND $3::timestamptz';
  const identityScope = crawlerIdentitySql(metrics.crawlerIdentityScope);
  const base = `FROM liekan_reporting_log WHERE website_id=$1::uuid AND ${timeCondition} AND $4::text IS NOT NULL${identityScope}`;
  const ai = ` AND ${crawlerAiSql()}`;
  const unknown = unknownCrawlerSql();
  const known = ` AND NOT ${unknown}`;
  const identityBase = base.replace(
    'FROM liekan_reporting_log WHERE website_id=',
    'FROM liekan_reporting_log l LEFT JOIN liekan_crawler_evidence e ON e.website_id=l.website_id AND e.log_id=l.id WHERE l.website_id=',
  );
  const args = [id, start, end, timezone];
  const q = (sql: string) => read(sql, ...args);
  const withForms = ['ai/bots', 'ai/pages'].includes(metrics.resource);
  // Resolve product forms from each request's immutable catalog, once per used version.
  // Missing historical bindings remain unknown; current catalog edits cannot reclassify them.
  const formScope = `WITH scoped_crawlers AS MATERIALIZED (
    SELECT bot,vendor,bot_type,path,created_at,ai_eligible,recognition_state,
      l.reporting_crawler_id AS "botId",l.reporting_catalog_version AS catalog_version
    ${identityBase}${known}
  ), catalog_forms AS MATERIALIZED (
    SELECT v.version,i.identity->>'id' AS "botId",i.identity->>'productForm' AS form
    FROM liekan_crawler_registry_version v
    JOIN (SELECT DISTINCT catalog_version FROM scoped_crawlers) used ON used.catalog_version=v.version
    CROSS JOIN LATERAL jsonb_array_elements(v.payload->'identities') i(identity)
  )`;
  const formBase = `FROM scoped_crawlers l LEFT JOIN catalog_forms f
    ON f.version=l.catalog_version AND f."botId"=l."botId"
    WHERE ($5::text IS NULL OR f.form=$5)
      AND ($6::text IS NULL OR (
        bot_type NOT IN ('训练','搜索','用户触发','传统搜索')
        AND coalesce(f.form,'unknown') NOT IN ('workbench','personal_agent')
      ))`;
  const formBots = `${formScope}
    SELECT bot AS name,vendor,bot_type AS type,l."botId",
      string_agg(DISTINCT coalesce(f.form,'unknown'),',' ORDER BY coalesce(f.form,'unknown')) AS "productForm",
      count(*)::int AS requests,count(*) FILTER(WHERE ${crawlerAiSql()})::int AS "aiRequests",
      count(distinct path)::int AS pages,max(created_at) AS "lastVisit"
    ${formBase} GROUP BY 1,2,3,4 ORDER BY requests DESC,name,"botId"`;
  const filterSql =
    filter === 'ai'
      ? ai
      : filter === 'abnormal'
        ? ' AND status>=400'
        : filter === 'other'
          ? ` AND ${unknown}`
          : '';
  const [cursorState] =
    metrics.crawlerMetricsVersion === 1
      ? await read(
          'SELECT epoch,policy_revision::text FROM liekan_log_state WHERE website_id=$1::uuid',
          id,
        )
      : [];
  const acceleratedClassification =
    metrics.crawlerMetricsVersion === 1 &&
    (!fields || fields.includes('recent')) &&
    !filter &&
    !search &&
    /^[a-f0-9-]{36}$/i.test(id)
      ? await readPreferredLogRollup({
          websiteId: id,
          startDate: start,
          endDate: end,
          timezone,
          crawlerMetricsVersion: 1,
          crawlerIdentityScope: metrics.crawlerIdentityScope,
          fields: ['classificationSet'],
        })
      : null;
  const [cursorClassification] = acceleratedClassification
    ? [{ versions: acceleratedClassification.classificationSet }]
    : metrics.crawlerMetricsVersion === 1 && (!fields || fields.includes('recent'))
      ? await q(
          `SELECT coalesce(string_agg(DISTINCT l.reporting_classification_version,','),'legacy') AS versions ${identityBase}${filterSql}`,
        )
      : [];
  const [repair] = await read(
    'SELECT active_generation::text,active_revision::text FROM liekan_history_repair_run WHERE website_id=$1::uuid',
    id,
  );
  const cursorScope = createHash('sha256')
    .update(
      JSON.stringify({
        id,
        start,
        end,
        timezone,
        filter,
        search,
        metrics: {
          crawlerIdentityScope: metrics.crawlerIdentityScope,
          crawlerMetricsVersion: metrics.crawlerMetricsVersion,
        },
        classification: CRAWLER_POPULATION_VERSION,
        catalogVersion: getPublishedCatalog()?.version ?? null,
        historyRepair: {
          generation: repair?.active_generation || null,
          revision: repair?.active_revision || '0',
        },
        classificationVersions: cursorClassification?.versions ?? null,
        epoch: cursorState?.epoch ?? 1,
        policyRevision: cursorState?.policy_revision ?? '0',
      }),
    )
    .digest('hex');
  let boundary: [Date, string];
  if (cursor) {
    try {
      // Export comparison has already checked the page's policy/catalog/epoch baseline.
      // Its original keyset boundary survives a late record introducing a classification version.
      boundary = comparisonBoundary ?? decodeCursor(cursor, cursorScope);
    } catch {
      throw new LiekanError('日志游标已失效，请重新读取', 409, 'history-repair-cursor-conflict');
    }
  }
  const seekSql = cursor
    ? ` AND (created_at,id) ${seek === 'before' ? '>' : '<'} ($6::timestamptz,$7)`
    : '';
  const paginationSql = cursor ? '' : ' OFFSET $6';
  const direction = cursor && seek === 'before' ? 'ASC' : 'DESC';
  const needs = (field: string) => !fields || fields.includes(field);
  // Materialize the filtered, repaired population once for all current-window aggregates.
  // Only aggregate columns enter the spool; raw UA and visitor evidence stay in detail reads.
  const aggregateQueries: Record<string, string> = {
    summary: `SELECT count(*)::int AS requests,count(*) FILTER(WHERE ${crawlerAiSql()})::int AS ai,count(distinct path) FILTER(WHERE ${crawlerAiSql()})::int AS pages,count(*) FILTER(WHERE status>=400)::int AS abnormal,count(distinct coalesce(l.reporting_classification_version,'legacy'))::int AS "classificationVersions",count(*) FILTER(WHERE ai_eligible IS NULL)::int AS "legacyRequests",count(*) FILTER(WHERE ${unknown})::int AS "unclassifiedRequests" ${identityBase}`,
    daily: `SELECT to_char(created_at AT TIME ZONE $4,'YYYY-MM-DD') AS day,bot,vendor,l.reporting_crawler_id AS "botId",count(*)::int AS count,count(*) FILTER(WHERE ${crawlerAiSql()})::int AS "aiRequests" ${identityBase}${known} GROUP BY 1,2,3,4 ORDER BY 1`,
    bots: withForms
      ? formBots
      : `SELECT bot AS name,vendor,bot_type AS type,l.reporting_crawler_id AS "botId",count(*)::int AS requests,count(*) FILTER(WHERE ${crawlerAiSql()})::int AS "aiRequests",count(distinct path)::int AS pages,max(created_at) AS "lastVisit" ${identityBase}${known} GROUP BY 1,2,3,4 ORDER BY requests DESC,name,"botId"`,
    pages: withForms
      ? `${formScope} SELECT path,bot,l."botId",count(*)::int AS requests,max(created_at) AS "lastCrawled"
          ${formBase}${ai}
          AND ($7::text IS NULL OR bot_type=$7) AND ($8::text IS NULL OR l."botId"=$8)
          AND ($9::text IS NULL OR (l."botId" IS NULL AND bot=$9))
          GROUP BY 1,2,3 ORDER BY requests DESC`
      : `SELECT path,bot,l.reporting_crawler_id AS "botId",count(*)::int AS requests,max(created_at) AS "lastCrawled" ${identityBase}${ai} GROUP BY 1,2,3 ORDER BY requests DESC`,
    statuses: `SELECT (status/100)*100 AS status,count(*)::int AS count ${base}${ai} GROUP BY 1 ORDER BY 1`,
    hours: `SELECT extract(hour FROM created_at AT TIME ZONE $4)::int AS hour,count(*)::int AS count ${base}${ai} GROUP BY 1 ORDER BY 1`,
  };
  const selectedAggregates = Object.entries(aggregateQueries).filter(([field]) => needs(field));
  const accelerated =
    selectedAggregates.length && /^[a-f0-9-]{36}$/i.test(id)
      ? await readPreferredLogRollup({
          websiteId: id,
          startDate: start,
          endDate: end,
          timezone,
          crawlerMetricsVersion: metrics.crawlerMetricsVersion,
          crawlerIdentityScope: metrics.crawlerIdentityScope,
          fields: selectedAggregates.map(([field]) => field),
          filters: {
            resource: metrics.resource,
            botProductForm: metrics.botProductForm,
            botCategory: metrics.botCategory,
            botType: metrics.botType,
            botId: metrics.botId,
            botName: metrics.botName,
          },
        })
      : null;
  const aggregatesRead = accelerated
    ? Promise.resolve([{ ...accelerated, summary: [accelerated.summary] }])
    : selectedAggregates.length
      ? read(
          `WITH statistics_scope AS MATERIALIZED (
        SELECT created_at,path,status,bot,vendor,bot_type,ai_eligible,recognition_state,
          reporting_crawler_id,reporting_catalog_version,reporting_classification_version
        ${base}
      ), filter_types AS (SELECT $5::text,$6::text,$7::text,$8::text,$9::text)
      SELECT ${selectedAggregates
        .map(([field, sql]) => {
          const scoped = sql
            .replaceAll(identityBase, 'FROM statistics_scope l WHERE true')
            .replaceAll(base, 'FROM statistics_scope l WHERE true');
          return `coalesce((SELECT jsonb_agg(rows) FROM (${scoped}) rows),'[]'::jsonb) AS "${field}"`;
        })
        .join(',')}`,
          ...args,
          metrics.botProductForm ?? null,
          metrics.botCategory ?? null,
          metrics.resource === 'ai/pages' ? (metrics.botType ?? null) : null,
          metrics.resource === 'ai/pages' ? (metrics.botId ?? null) : null,
          metrics.resource === 'ai/pages' && !metrics.botId ? (metrics.botName ?? null) : null,
        )
      : Promise.resolve([]);
  const [aggregates, catalog, latest, recent, count] = await Promise.all([
    aggregatesRead,
    needs('catalog')
      ? read(
          'SELECT path,title,content_type AS type,word_count AS "wordCount",published_at AS "publishedAt",content_updated_at AS "updatedAt",link_depth AS "linkDepth",evidence_source AS source,structured,structure_score AS "structureScore" FROM liekan_catalog WHERE website_id=$1::uuid ORDER BY path',
          id,
        )
      : Promise.resolve([]),
    needs('latest')
      ? read(
          `SELECT (SELECT imported_at FROM liekan_import WHERE website_id=$1::uuid AND accepted>0 ORDER BY imported_at DESC LIMIT 1) AS time, ${logInputConnectedSql} AS connected`,
          id,
        )
      : Promise.resolve([]),
    needs('recent')
      ? read(
          `SELECT id AS "recordId",created_at AS time,ip_masked AS "ipMasked",location,method,path,status,user_agent AS "userAgent",bot,l.reporting_crawler_id AS "botId",l.reporting_catalog_version AS "catalogVersion",e.identity_evidence AS "identityEvidence",bot_type AS "botType",verification,${crawlerAiSql()} AS "aiEligible",recognition_state AS "recognitionState",verification_version AS "verificationVersion",verification_observed_at AS "verificationObservedAt",verification_reason AS "verificationReason" ${identityBase}${filterSql} AND strpos(lower(concat_ws(' ',path,user_agent,method,status::text,ip_masked,location,bot,bot_type,CASE verification WHEN 'verified_range' THEN '官方 IP 范围匹配' WHEN 'verified_dns' THEN '官方 DNS 双向核验' WHEN 'verified_edge' THEN '可信边缘身份核验' WHEN 'range_mismatch' THEN '官方范围未匹配' ELSE '身份未核验' END)) ,lower($5))>0 ${seekSql} ORDER BY created_at ${direction},id ${direction} LIMIT ${fullExport ? 100001 : 100}${paginationSql}`,
          ...args,
          search,
          ...(cursor ? boundary : [(page - 1) * 100]),
        )
      : Promise.resolve([]),
    needs('count')
      ? read(
          `SELECT count(*)::int AS count ${base}${filterSql} AND strpos(lower(concat_ws(' ',path,user_agent,method,status::text,ip_masked,location,bot,bot_type,CASE verification WHEN 'verified_range' THEN '官方 IP 范围匹配' WHEN 'verified_dns' THEN '官方 DNS 双向核验' WHEN 'verified_edge' THEN '可信边缘身份核验' WHEN 'range_mismatch' THEN '官方范围未匹配' ELSE '身份未核验' END)) ,lower($5))>0`,
          ...args,
          search,
        )
      : Promise.resolve([{ count: 0 }]),
  ]);
  const {
    summary = [{ requests: 0, ai: 0, pages: 0, abnormal: 0 }],
    daily = [],
    bots = [],
    pages = [],
    statuses = [],
    hours = [],
  } = aggregates[0] ?? {};
  for (const row of bots) if (row.lastVisit) row.lastVisit = new Date(row.lastVisit);
  for (const row of pages) if (row.lastCrawled) row.lastCrawled = new Date(row.lastCrawled);
  const previousStart = new Date(
    Math.max(0, +start - (+end - +start + (metrics.crawlerMetricsVersion === 1 ? 0 : 1))),
  );
  const previousEnd = new Date(+start - (metrics.crawlerMetricsVersion === 1 ? 0 : 1));
  const previousRollup =
    needs('previousBots') && withForms && /^[a-f0-9-]{36}$/i.test(id)
      ? await readPreferredLogRollup({
          websiteId: id,
          startDate: previousStart,
          endDate: previousEnd,
          timezone,
          crawlerMetricsVersion: metrics.crawlerMetricsVersion,
          crawlerIdentityScope: metrics.crawlerIdentityScope,
          fields: ['bots'],
          filters: {
            resource: metrics.resource,
            botProductForm: metrics.botProductForm,
            botCategory: metrics.botCategory,
          },
        })
      : null;
  const previousBots = previousRollup?.bots.map(row => ({
    ...row,
    lastVisit: row.lastVisit ? new Date(row.lastVisit) : row.lastVisit,
  }));
  return {
    summary: summary[0],
    daily,
    bots,
    pages,
    statuses,
    hours,
    catalog,
    latest: latest[0]?.time ?? null,
    connected: latest[0]?.connected ?? Boolean(latest[0]?.time),
    recent: cursor && seek === 'before' ? recent.reverse() : recent,
    nextCursor: recent.length ? encodeCursor(recent.at(-1), cursorScope) : '',
    previousCursor: page > 1 && recent.length ? encodeCursor(recent[0], cursorScope) : '',
    totalLogs: count[0].count,
    previousBots:
      previousBots ??
      (needs('previousBots')
        ? await read(
            withForms
              ? formBots
              : `SELECT bot AS name,vendor,bot_type AS type,l.reporting_crawler_id AS "botId",count(*)::int AS requests FROM liekan_reporting_log l LEFT JOIN liekan_crawler_evidence e ON e.website_id=l.website_id AND e.log_id=l.id WHERE l.website_id=$1::uuid AND ${timeCondition}${identityScope} GROUP BY 1,2,3,4`,
            id,
            previousStart,
            previousEnd,
            ...(withForms
              ? [timezone, metrics.botProductForm ?? null, metrics.botCategory ?? null]
              : []),
          )
        : []),
  };
}
export async function getLogToday(id: string, start: Date, end: Date) {
  const [rows, imports] = await Promise.all([
    readAnalysisLogToday({ websiteId: id, startDate: start, endDate: end }).then(
      covered =>
        covered ||
        query(
          `SELECT count(*) FILTER(WHERE path !~* '${staticRequestExtensionPattern}')::int AS requests,count(*) FILTER(WHERE status>=400)::int AS abnormal FROM liekan_reporting_log WHERE website_id=$1::uuid AND created_at BETWEEN $2 AND $3`,
          id,
          start,
          end,
        ).then(rows => rows[0]),
    ),
    query(
      'SELECT coalesce(sum(accepted),0)::int AS accepted FROM liekan_import WHERE website_id=$1::uuid AND imported_at BETWEEN $2 AND $3',
      id,
      start,
      end,
    ),
  ]);
  return { requests: rows.requests, abnormal: rows.abnormal, accepted: imports[0].accepted };
}
export async function getContentImpact(
  id: string,
  start: Date,
  end: Date,
  metrics: CrawlerMetricOptions = { crawlerIdentityScope: 'all' },
) {
  const targets = await query<{ path: string; publishedAt: Date | string }>(
    `SELECT path,published_at AS "publishedAt" FROM liekan_catalog WHERE website_id=$1::uuid AND published_at BETWEEN $2 AND $3 AND published_at+interval '7 days'<=now() ORDER BY published_at DESC LIMIT 20`,
    id,
    start,
    end,
  );
  if (!targets.length) return [];
  return query(
    `WITH targets AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS c(path text,"humanPath" text,"publishedAt" timestamptz))
    SELECT c.path,
    (SELECT count(*)::int FROM website_event e WHERE e.website_id=$1::uuid AND e.url_path=c."humanPath" AND e.event_type=1 AND e.created_at>=c."publishedAt" AND e.created_at<c."publishedAt"+interval '7 days') AS pv,
    (SELECT count(*)::int FROM liekan_reporting_log l WHERE l.website_id=$1::uuid AND l.path=c.path AND ${crawlerAiSql('l')}${crawlerIdentitySql(metrics.crawlerIdentityScope, 'l')}${metrics.crawlerMetricsVersion === 1 ? " AND l.user_agent NOT LIKE 'Liekan-Crawler-Check/%'" : ''} AND l.created_at>=c."publishedAt" AND l.created_at<c."publishedAt"+interval '7 days')-
    (SELECT count(*)::int FROM liekan_reporting_log l WHERE l.website_id=$1::uuid AND l.path=c.path AND ${crawlerAiSql('l')}${crawlerIdentitySql(metrics.crawlerIdentityScope, 'l')}${metrics.crawlerMetricsVersion === 1 ? " AND l.user_agent NOT LIKE 'Liekan-Crawler-Check/%'" : ''} AND l.created_at>=c."publishedAt"-interval '7 days' AND l.created_at<c."publishedAt") AS increment
    FROM targets c ORDER BY c."publishedAt" DESC`,
    id,
    JSON.stringify(
      targets.map(target => ({ ...target, humanPath: humanPathFromEncoded(target.path) })),
    ),
  );
}
export async function getMonthlyAiShare(
  id: string,
  end: Date,
  timezone: string,
  metrics: CrawlerMetricOptions = { crawlerIdentityScope: 'all' },
) {
  const monthEnd = metrics.crawlerMetricsVersion === 1 ? new Date(+end - 1) : end;
  if (/^[a-f0-9-]{36}$/i.test(id)) {
    const [y, m] = formatInTimeZone(monthEnd, timezone, 'yyyy-MM').split('-').map(Number);
    const { fromZonedTime } = await import('date-fns-tz');
    const start = fromZonedTime(
      `${new Date(Date.UTC(y, m - 6, 1)).toISOString().slice(0, 10)}T00:00:00`,
      timezone,
    );
    const series = await readPreferredLogSeries({
      websiteId: id,
      startDate: start,
      endDate: end,
      timezone,
      ...metrics,
      grain: 'month',
    });
    if (series)
      return Array.from({ length: 6 }, (_, index) => {
        const month = new Date(Date.UTC(y, m - 6 + index, 1)).toISOString().slice(0, 7);
        const rows = series.filter(row => row.day === month);
        return {
          month,
          total: rows.reduce((sum, row) => sum + row.count, 0),
          ai: rows.reduce((sum, row) => sum + row.aiRequests, 0),
        };
      });
  }

  const rows = await query<{ month: string; total: number; ai: number }>(
    `SELECT to_char(created_at AT TIME ZONE $3,'YYYY-MM') AS month,count(*)::int AS total,count(*) FILTER(WHERE ${crawlerAiSql()})::int AS ai FROM liekan_reporting_log WHERE website_id=$1::uuid ${crawlerIdentitySql(metrics.crawlerIdentityScope)}${metrics.crawlerMetricsVersion === 1 ? " AND user_agent NOT LIKE 'Liekan-Crawler-Check/%'" : ''} AND created_at${metrics.crawlerMetricsVersion === 1 ? '<' : '<='}$2 AND created_at>=((date_trunc('month',$4::timestamptz AT TIME ZONE $3)-interval '5 months') AT TIME ZONE $3) GROUP BY 1 ORDER BY 1`,
    id,
    end,
    timezone,
    monthEnd,
  );
  const [year, month] = formatInTimeZone(monthEnd, timezone, 'yyyy-MM').split('-').map(Number);
  return Array.from({ length: 6 }, (_, index) => {
    const label = new Date(Date.UTC(year, month - 6 + index, 1)).toISOString().slice(0, 7);
    return rows.find(row => row.month === label) ?? { month: label, total: 0, ai: 0 };
  });
}
export async function getPlotLogs(
  id: string,
  start: Date,
  end: Date,
  timezone: string,
  hour = false,
  metrics: CrawlerMetricOptions = { crawlerIdentityScope: 'all' },
) {
  if (/^[a-f0-9-]{36}$/i.test(id)) {
    const series = await readPreferredLogSeries({
      websiteId: id,
      startDate: start,
      endDate: end,
      timezone,
      ...metrics,
      grain: hour ? 'hour' : 'day',
    });
    if (series) return series;
  }
  return query(
    `SELECT to_char(created_at AT TIME ZONE $4,'${hour ? 'YYYY-MM-DD HH24:00' : 'YYYY-MM-DD'}') AS day,bot,bot_type AS type,count(*)::int AS count,count(*) FILTER(WHERE ${crawlerAiSql()})::int AS "aiRequests" FROM liekan_reporting_log WHERE website_id=$1::uuid AND ${metrics.crawlerMetricsVersion === 1 ? "created_at>=$2 AND created_at<$3 AND user_agent NOT LIKE 'Liekan-Crawler-Check/%'" : 'created_at BETWEEN $2 AND $3'}${crawlerIdentitySql(metrics.crawlerIdentityScope)} GROUP BY 1,2,3 ORDER BY 1`,
    id,
    start,
    end,
    timezone,
  );
}
