import {
  analysisReadParameters,
  analysisWindowRelation,
  verifiedLogModel,
  type AnalysisWindow,
} from '../warehouse/analysis-context';
import { createHash } from 'node:crypto';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { calendarDateRange } from '../contracts/calendar';
import type { CrawlerMetricOptions } from '../contracts/crawler-metrics';
import { crawlerIdentitySql } from '../crawlers/metric-scope';
import { CRAWLER_POPULATION_VERSION, crawlerAiSql, unknownCrawlerSql } from '../rules/population';
import { warehouseTime } from '../warehouse/fact-input';
import { warehouseReader } from '../warehouse/reader-runtime';
import {
  logSummaryColumns,
  reportingLogRelation,
  websiteEventRelation,
} from '../warehouse/reporting-relations';
import { v2Tables, warehouseV2Enabled } from '../warehouse-v2/index';
import { dashboardClock } from './dashboard-clock';
import { LiekanError } from './errors';
import { logInputConnectedSql } from './log-input';
import { countLogWindow, logCountExpressions, logCountPattern } from './warehouse-log-hour-counts';
import { readLogPageWindows } from './warehouse-log-page';
import { decodeWarehouseLogCursor } from './warehouse-log-cursor';
import {
  warehouseReportMetadata,
  warehouseReportQuery,
  warehouseReportStream,
  withinWarehouseReport,
} from './warehouse-report-snapshot';
import { memoRoundMetric } from './warehouse-round-metrics';

// Counts stay exact in CH. Product contracts use JS numbers, so fail explicitly
// if a counter exceeds their representable range rather than silently rounding.
export function warehouseNumbers<T>(value: T): T {
  if (Array.isArray(value)) return value.map(warehouseNumbers) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        [
          'requests',
          'ai',
          'pages',
          'abnormal',
          'classificationVersions',
          'legacyRequests',
          'unclassifiedRequests',
          'aiRequests',
          'count',
          'total',
          'hour',
          'status',
          'pv',
          'increment',
        ].includes(key) && v !== null
          ? exactCount(v)
          : warehouseNumbers(v),
      ]),
    ) as T;
  return value;
}
function exactCount(value: unknown) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('warehouse-counter-out-of-range');
  return n;
}

function singleLogDay(start: Date, end: Date, timezone: string, endExclusive: boolean) {
  const day = formatInTimeZone(start, timezone, 'yyyy-MM-dd');
  const last = +end - (endExclusive ? 1 : 0);
  return +end >= +start && last <= calendarDateRange(day, timezone).endAt ? day : undefined;
}

type SpiderIdentity = { vendor: string | null; botId: string | null };
function dailyCountsFromBots(
  day: string,
  bots: (SpiderIdentity & { name: string | null; requests: number; aiRequests: number })[],
) {
  const groups = new Map<
    string,
    SpiderIdentity & { day: string; bot: string | null; count: number; aiRequests: number }
  >();
  for (const { name: bot, vendor, botId, requests, aiRequests } of bots) {
    const key = JSON.stringify([bot, vendor, botId]);
    const group = groups.get(key);
    if (group) {
      group.count = exactCount(group.count + requests);
      group.aiRequests = exactCount(group.aiRequests + aiRequests);
    } else {
      groups.set(key, { day, bot, vendor, botId, count: requests, aiRequests });
    }
  }
  return [...groups.values()];
}

export async function warehouseContentImpact(
  id: string,
  targets: { path: string; humanPath: string; publishedAt: Date | string }[],
  metrics: CrawlerMetricOptions,
) {
  return withinWarehouseReport(async () => {
    const times = targets.map(t => +new Date(t.publishedAt));
    const parameters = {
      ...range(
        new Date(Math.min(...times) - 7 * 86400000),
        new Date(Math.max(...times) + 7 * 86400000),
      ),
      targetPaths: targets.map(t => t.path),
      humanPaths: targets.map(t => t.humanPath),
      published: times.map(t => warehouseTime(new Date(t))),
    };
    const targetSQL = `targets AS (SELECT t.1 AS path,t.2 AS humanPath,parseDateTime64BestEffort(t.3,6,'UTC') AS publishedAt
      FROM (SELECT arrayJoin(arrayZip({targetPaths:Array(String)},{humanPaths:Array(String)},{published:Array(String)})) AS t))`;
    const browser = await warehouseReportQuery<{ path: string; pv: string }>(
      id,
      `WITH ${targetSQL}
      SELECT c.path AS path,count() AS pv FROM ${websiteEventRelation()} e INNER JOIN targets c ON e.url_path=c.humanPath
      WHERE e.event_type=1 AND e.created_at>=c.publishedAt AND e.created_at<c.publishedAt+INTERVAL 7 DAY GROUP BY c.path`,
      parameters,
    );
    const logs = await warehouseReportQuery<{ path: string; increment: string }>(
      id,
      `WITH ${targetSQL}
      SELECT c.path AS path,toInt64(countIf(l.created_at>=c.publishedAt))-toInt64(countIf(l.created_at<c.publishedAt)) AS increment
      FROM (SELECT * ${scoped(metrics)} AND ${crawlerAiSql('l')}) l INNER JOIN targets c ON l.path=c.path
      WHERE l.created_at>=c.publishedAt-INTERVAL 7 DAY AND l.created_at<c.publishedAt+INTERVAL 7 DAY GROUP BY c.path`,
      parameters,
    );
    const b = new Map(browser.map(r => [r.path, r.pv])),
      l = new Map(logs.map(r => [r.path, r.increment]));
    return targets.map(t => ({
      path: t.path,
      pv: exactCount(b.get(t.path) ?? 0),
      increment: exactCount(l.get(t.path) ?? 0),
    }));
  });
}
export const warehouseLogDate = (value: string | null) =>
  value ? new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`) : null;
function scoped(
  metrics: CrawlerMetricOptions = { crawlerIdentityScope: 'all' },
  columns?: readonly string[],
  orderedLogVersions = false,
  window?: { endExclusive: boolean; hours?: boolean },
  restrictEvidenceToWindow = false,
  readWindow?: AnalysisWindow,
) {
  const relation = reportingLogRelation(
    {
      ...(orderedLogVersions ? { orderedLogVersions: true as const } : {}),
      immutableTimeWindow: {
        start: 'logStart',
        end: 'logEnd',
        endExclusive: window?.endExclusive ?? metrics.crawlerMetricsVersion === 1,
        ...(window?.hours ? { hours: 'logHours' } : {}),
      },
    },
    columns && [
      ...columns,
      ...(metrics.crawlerIdentityScope !== 'all' ? ['verification'] : []),
      ...(metrics.crawlerMetricsVersion === 1 ? ['user_agent'] : []),
    ],
    restrictEvidenceToWindow,
    readWindow,
  );
  return `FROM ${relation} l WHERE true ${crawlerIdentitySql(metrics.crawlerIdentityScope, 'l')}${metrics.crawlerMetricsVersion === 1 ? " AND l.user_agent NOT LIKE 'Liekan-Crawler-Check/%'" : ''}`;
}
const range = (start: Date, end: Date, timezone = 'UTC') => ({
  logStart: warehouseTime(start),
  logEnd: warehouseTime(end),
  timezone: Intl.DateTimeFormat(undefined, { timeZone: timezone }).resolvedOptions().timeZone,
});

const logBotColumns = [
  'bot',
  'vendor',
  'bot_type',
  'reporting_crawler_id',
  'path',
  'created_at',
  'ai_eligible',
  'recognition_state',
];
const overviewLogColumns = [...new Set([...logSummaryColumns, ...logBotColumns])];

function rawLogWindow(endExclusive: boolean) {
  if (warehouseV2Enabled()) {
    return `FROM ${v2Tables.logs}
     WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND _deleted=0
       AND created_at >= {logStart:DateTime64(6,'UTC')}
       AND created_at ${endExclusive ? '<' : '<='} {logEnd:DateTime64(6,'UTC')}`;
  }
  return `FROM warehouse_liekan_log
     PREWHERE _website_id={wh_site:UUID} AND _epoch={wh_epoch:UInt64}
       AND toDate32(_record_time) BETWEEN toDate32({logStart:DateTime64(6,'UTC')})
         AND toDate32({logEnd:DateTime64(6,'UTC')})
     WHERE _record_time >= {logStart:DateTime64(6,'UTC')}
       AND _record_time ${endExclusive ? '<' : '<='} {logEnd:DateTime64(6,'UTC')}`;
}

export async function warehouseLogWindowHasFacts(
  site: string,
  start: Date,
  end: Date,
  endExclusive = false,
) {
  // An empty raw window proves that the accepted, filtered report is empty too.
  return memoRoundMetric(
    JSON.stringify(['log-window-presence', site, +start, +end, endExclusive]),
    async () => {
      const rows = await warehouseReportQuery(
        site,
        `SELECT 1 AS present ${rawLogWindow(endExclusive)} LIMIT 1`,
        range(start, end),
        { traceStage: 'log-window-presence' },
      );
      return rows.length > 0;
    },
  );
}

// The round pins publication and control. Also bind the actual analysis buckets
// because another report can complete more of the model within that round.
function roundLogAggregate<T>(site: string, sql: string, params: Record<string, unknown>) {
  return memoRoundMetric(
    JSON.stringify(['log-aggregate', site, sql, params, analysisReadParameters()]),
    () => warehouseReportQuery<T>(site, sql, params),
  );
}

export async function warehouseOverviewLogWindow(
  site: string,
  start: Date,
  end: Date,
  endExclusive: boolean,
) {
  return memoRoundMetric(
    JSON.stringify(['overview-log-window', site, +start, +end, endExclusive]),
    async () => {
      if (+end - +start > 26 * 3600000)
        return {
          hasFacts: await warehouseLogWindowHasFacts(site, start, end, endExclusive),
          restrictEvidenceToWindow: false,
        };
      // Bound the immutable IDs at the pinned publication.
      const limit = 100000;
      const [result] = await warehouseReportQuery<{ count: string }>(
        site,
        `SELECT count() AS count FROM (SELECT 1 ${rawLogWindow(endExclusive)} LIMIT ${limit + 1})`,
        range(start, end),
      );
      const count = exactCount(result.count);
      return { hasFacts: count > 0, restrictEvidenceToWindow: count > 0 && count <= limit };
    },
  );
}
export async function warehouseLogToday(id: string, start: Date, end: Date) {
  return withinWarehouseReport(async () => {
    const [counts, imports] = await Promise.all([
      countLogWindow(verifiedLogModel(id), +start, +end, async (from, to, endExclusive) => {
        const window = { start: from, end: to, endExclusive };
        const [row] = await warehouseReportQuery<{ requests: string; abnormal: string }>(
          id,
          `SELECT ${logCountExpressions} ${scoped(undefined, ['path', 'status'], false, window, false, window)}`,
          { ...range(new Date(from), new Date(to)), staticPattern: logCountPattern },
        );
        return { requests: exactCount(row.requests), abnormal: exactCount(row.abnormal) };
      }),
      warehouseAcceptedImports(id,start,end),
    ]);
    return { ...counts, accepted: imports };
  });
}

export async function warehouseAcceptedImports(id:string,start:Date,end:Date) {
  const [row] = await warehouseReader().db.read<{ accepted: string }>(
    'SELECT coalesce(sum(accepted),0)::text AS accepted FROM liekan_import WHERE website_id=$1::uuid AND imported_at BETWEEN $2 AND $3',
    [id, start, end],
  );
  return exactCount(row.accepted);
}
const trendHourFormat = '%Y-%m-%d %H:00';
const trendColumns = ['created_at', 'bot', 'bot_type', 'ai_eligible'];
const trendCounts = `count() AS count,countIf(${crawlerAiSql('l')}) AS aiRequests`;

export type LogTrendRow = { day: string; bot: string; type: string; count: number; aiRequests: number };

const aiHourColumns = ['created_at', 'ai_eligible', 'bot_type'];
function aiHourSql(source: string) {
  return `SELECT toHour(toTimeZone(created_at,{timezone:String})) AS hour,count() AS count ${source} AND ${crawlerAiSql('l')} GROUP BY hour ORDER BY hour`;
}

export async function warehousePlotLogs(
  id: string,
  start: Date,
  end: Date,
  timezone: string,
  hour = false,
  metrics: CrawlerMetricOptions = { crawlerIdentityScope: 'all' },
) {
  return withinWarehouseReport(async () => {
    const endExclusive = metrics.crawlerMetricsVersion === 1;
    return memoRoundMetric(
      JSON.stringify([
        'log-trend-edge',
        id,
        +start,
        +end,
        endExclusive,
        timezone,
        hour,
        metrics.crawlerIdentityScope,
        metrics.crawlerMetricsVersion,
      ]),
      async () => {
        if (!(await warehouseLogWindowHasFacts(id, start, end, endExclusive))) return [];
        return warehouseNumbers(
          await warehouseReportQuery<LogTrendRow>(
            id,
            `SELECT formatDateTime(created_at,'${hour ? trendHourFormat : '%Y-%m-%d'}',{timezone:String}) AS day,bot,bot_type AS type,
       ${trendCounts} ${scoped(metrics, trendColumns, false, { endExclusive }, false, { start: +start, end: +end, endExclusive })} GROUP BY day,bot,type ORDER BY day`,
            range(start, end, timezone),
            { traceStage: 'log-trend' },
          ),
        );
      },
    );
  });
}
export async function warehouseMonthlyAiShare(
  id: string,
  end: Date,
  timezone: string,
  metrics: CrawlerMetricOptions = { crawlerIdentityScope: 'all' },
) {
  const monthEnd = metrics.crawlerMetricsVersion === 1 ? new Date(+end - 1) : end;
  const [year, month] = formatInTimeZone(monthEnd, timezone, 'yyyy-MM').split('-').map(Number);
  const start = fromZonedTime(
    `${new Date(Date.UTC(year, month - 6, 1)).toISOString().slice(0, 10)}T00:00:00`,
    timezone,
  );
  const rows = await memoRoundMetric(
    JSON.stringify([
      'monthly-ai',
      id,
      +start,
      +end,
      timezone,
      metrics.crawlerIdentityScope,
      metrics.crawlerMetricsVersion,
    ]),
    async () =>
      warehouseNumbers(
        await warehouseReportQuery<{ month: string; total: number; ai: number }>(
          id,
          `SELECT formatDateTime(created_at,'%Y-%m',{timezone:String}) AS month,count() AS total,countIf(${crawlerAiSql('l')}) AS ai ${scoped(metrics, ['created_at', 'bot_type', 'ai_eligible'], false, undefined, false, { start: +start, end: +end })} GROUP BY month ORDER BY month`,
          range(start, end, timezone),
        ),
      ),
  );
  return Array.from({ length: 6 }, (_, i) => {
    const label = new Date(Date.UTC(year, month - 6 + i, 1)).toISOString().slice(0, 7);
    return rows.find(r => r.month === label) ?? { month: label, total: 0, ai: 0 };
  });
}

function encodeLogCursor(row: any, scope: string) {
  return row
    ? Buffer.from(JSON.stringify([String(row.cursorTime), row.recordId, scope])).toString(
        'base64url',
      )
    : '';
}
export const warehouseLogDetailColumns = (
  ai: string,
) => `id AS recordId,toString(created_at) AS cursorTime,toString(created_at) AS time,ip_masked AS ipMasked,location,method,path,status,user_agent AS userAgent,bot,reporting_crawler_id AS botId,toString(reporting_catalog_version) AS catalogVersion,
      reporting_identity_evidence AS identityEvidence,
      bot_type AS botType,verification,${ai} AS aiEligible,recognition_state AS recognitionState,verification_version AS verificationVersion,toString(verification_observed_at) AS verificationObservedAt,verification_reason AS verificationReason`;
export function warehouseLogDetailRow({ cursorTime: _cursorTime, ...r }: any) {
  return {
    ...r,
    time: warehouseLogDate(r.time),
    verificationObservedAt: warehouseLogDate(r.verificationObservedAt),
    identityEvidence: r.identityEvidence ? JSON.parse(r.identityEvidence) : null,
  };
}

/** Shared report/evidence query contract. Evidence streams the same unbounded
 * statements; the regular page reader retains its existing cursor and limits. */
export async function warehouseLogQuerySpec(
  start: Date,
  end: Date,
  timezone: string,
  metrics: NonNullable<Parameters<typeof import('./logs').getLogFacts>[10]>,
  filter: string,
  search: string,
  previousBots: boolean,
  id: string,
  reuseOverview = false,
  restrictEvidenceToWindow = false,
  detailWindow?: AnalysisWindow,
  catalogOnlyPages = false,
) {
  if (reuseOverview && metrics.resource !== 'overview')
    throw new Error('warehouse-overview-reuse-scope-invalid');
  const readWindow = detailWindow ?? {
    start: previousBots
      ? Math.max(0, +start - (+end - +start + (metrics.crawlerMetricsVersion === 1 ? 0 : 1)))
      : +start,
    end: +end,
    endExclusive: metrics.crawlerMetricsVersion === 1,
  };
  const queryFrom = (columns?: readonly string[]) =>
    scoped(
      metrics,
      columns,
      restrictEvidenceToWindow,
      { endExclusive: !!readWindow.endExclusive },
      restrictEvidenceToWindow,
      readWindow,
    );
  const aggregateFrom = queryFrom;
  const params: Record<string, unknown> = range(start, end, timezone),
    base = queryFrom(),
    ai = crawlerAiSql('l'),
    known = `NOT ${unknownCrawlerSql('l')}`;
  const forms = ['ai/bots', 'ai/pages'].includes(metrics.resource);
  let form = "'unknown'";
  if (forms) {
    const used = await roundLogAggregate<{ version: string }>(
      id,
      `SELECT DISTINCT toString(reporting_catalog_version) AS version ${base} AND isNotNull(reporting_catalog_version)`,
      {
        ...params,
        ...(previousBots
          ? range(new Date(Math.max(0, +start - (+end - +start + 1))), end, timezone)
          : {}),
      },
    );
    const records = used.length
      ? await warehouseReader().db.read<{ version: string; identities: any[] }>(
          "SELECT version::text,payload->'identities' AS identities FROM liekan_crawler_registry_version WHERE version=ANY($1::uuid[])",
          [used.map(r => r.version)],
        )
      : [];
    const mappings = records.flatMap(r =>
      (r.identities ?? []).map(i => [`${r.version}:${i.id}`, i.productForm ?? 'unknown']),
    );
    params.formKeys = mappings.map(m => m[0]);
    params.formValues = mappings.map(m => m[1]);
    form =
      "transform(concat(toString(l.reporting_catalog_version),':',coalesce(l.reporting_crawler_id,'')),{formKeys:Array(String)},{formValues:Array(String)},'unknown')";
  }
  params.productForm = metrics.botProductForm ?? null;
  params.category = metrics.botCategory ?? null;
  params.botType = metrics.botType ?? null;
  params.botId = metrics.botId ?? null;
  params.botName = metrics.botName ?? null;
  const formFilter = forms
    ? ` AND (isNull({productForm:Nullable(String)}) OR ${form}={productForm:Nullable(String)})
      AND (isNull({category:Nullable(String)}) OR (bot_type NOT IN('训练','搜索','用户触发','传统搜索') AND ${form} NOT IN('workbench','personal_agent')))`
    : '';
  const botColumns = [...logBotColumns, ...(forms ? ['reporting_catalog_version'] : [])];
  const botQuery = `SELECT bot AS name,vendor,bot_type AS type,reporting_crawler_id AS botId,${forms ? `arrayStringConcat(arraySort(groupUniqArray(coalesce(${form},'unknown'))),',') AS productForm,` : ''}
      count() AS requests,countIf(${ai}) AS aiRequests,uniqExact(path) AS pages,toString(max(created_at)) AS lastVisit ${aggregateFrom(botColumns)} AND ${known}${formFilter} GROUP BY name,vendor,type,botId ORDER BY requests DESC,name,botId,vendor,type`;
  const statements: Record<string, string> = {
    summary: `SELECT count() AS requests,countIf(${ai}) AS ai,uniqExactIf(path,${ai}) AS pages,countIf(status>=400) AS abnormal,
        uniqExact(coalesce(reporting_classification_version,'legacy')) AS classificationVersions,countIf(isNull(ai_eligible)) AS legacyRequests,countIf(${unknownCrawlerSql('l')}) AS unclassifiedRequests ${aggregateFrom(logSummaryColumns)}`,
    daily: `SELECT formatDateTime(created_at,'%Y-%m-%d',{timezone:String}) AS day,bot,vendor,reporting_crawler_id AS botId,count() AS count,countIf(${ai}) AS aiRequests ${queryFrom(['created_at', 'bot', 'vendor', 'reporting_crawler_id', 'ai_eligible', 'bot_type', 'recognition_state'])} AND ${known} GROUP BY day,bot,vendor,botId ORDER BY day`,
    bots: botQuery,
    pages: `SELECT path,bot,reporting_crawler_id AS botId,count() AS requests,toString(max(created_at)) AS lastCrawled ${aggregateFrom(
      botColumns.filter(column => column !== 'vendor'),
    )} AND ${ai}${
      forms
        ? ` AND ${known}${formFilter}
        AND (isNull({botType:Nullable(String)}) OR bot_type={botType:Nullable(String)}) AND (isNull({botId:Nullable(String)}) OR reporting_crawler_id={botId:Nullable(String)})
        AND (isNotNull({botId:Nullable(String)}) OR isNull({botName:Nullable(String)}) OR (isNull(reporting_crawler_id) AND bot={botName:Nullable(String)}))`
        : ''
    }${catalogOnlyPages ? ' AND l.path IN {catalogPaths:Array(String)}' : ''}
    GROUP BY path,bot,botId ORDER BY requests DESC,path,bot,botId`,
    statuses: `SELECT intDiv(status,100)*100 AS status,count() AS count ${queryFrom(['status', 'ai_eligible', 'bot_type'])} AND ${ai} GROUP BY status ORDER BY status`,
    hours: aiHourSql(queryFrom(aiHourColumns)),
  };
  const filterSql =
    filter === 'ai'
      ? ` AND ${ai}`
      : filter === 'abnormal'
        ? ' AND status>=400'
        : filter === 'other'
          ? ` AND ${unknownCrawlerSql('l')}`
          : '';
  const searchCondition = search
    ? ` AND positionCaseInsensitiveUTF8(arrayStringConcat(arrayFilter(x->x!='',[coalesce(path,''),coalesce(user_agent,''),coalesce(method,''),toString(status),coalesce(ip_masked,''),coalesce(location,''),coalesce(bot,''),coalesce(bot_type,''),
      multiIf(verification='verified_range','官方 IP 范围匹配',verification='verified_dns','官方 DNS 双向核验',verification='verified_edge','可信边缘身份核验',verification='range_mismatch','官方范围未匹配','身份未核验')]),' '),{search:String})>0`
    : '';
  const detailBase = `${base}${filterSql}${searchCondition}`;
  params.search = search;
  const previousParams = {
    ...params,
    ...range(
      new Date(
        Math.max(0, +start - (+end - +start + (metrics.crawlerMetricsVersion === 1 ? 0 : 1))),
      ),
      new Date(+start - (metrics.crawlerMetricsVersion === 1 ? 0 : 1)),
      timezone,
    ),
  };
  return {
    params,
    previousParams,
    base,
    ai,
    forms,
    botQuery,
    statements,
    // Expand only eligible aggregate groups after reading the accepted relation
    // once. A materialized CTE retained every log row alongside join/group states
    // and exhausted the query budget even when those operators spilled to disk.
    overview: reuseOverview
      ? renderWarehouseOverviewAggregate(
          overviewAggregateRows(metrics, restrictEvidenceToWindow, 'counts', readWindow),
        )
      : undefined,
    filterSql,
    detailBase,
  };
}

export function warehouseOverviewAggregateStates(
  start: Date,
  end: Date,
  timezone: string,
  metrics: CrawlerMetricOptions,
  restrictEvidenceToWindow: boolean,
  days?: string[],
) {
  return {
    sql: overviewAggregateRows(metrics, restrictEvidenceToWindow, days ? 'days' : 'states', {
      start: +start,
      end: +end,
      endExclusive: !!days || metrics.crawlerMetricsVersion === 1,
    }),
    params: { ...range(start, end, timezone), ...(days ? { overviewDays: days } : {}) },
  };
}

export function renderWarehouseOverviewAggregate(source: string, live?: LiveOverviewLogs) {
  return `SELECT section,multiIf(${
    live?.todayEnd
      ? "section='today',toJSONString(map('requests',toString(requests),'abnormal',toString(abnormal))),"
      : ''
  }${live?.hourlyTrend
    ? "section='trend',toJSONString(map('day',trendHour,'bot',name,'type',type,'count',toString(requests),'aiRequests',toString(ai))),"
    : ''
  }section='summary',
    toJSONString(map('requests',toString(requests),'ai',toString(ai),'pages',toString(pages),'abnormal',toString(abnormal),
      'classificationVersions',toString(classificationVersions),'legacyRequests',toString(legacyRequests),'unclassifiedRequests',toString(unclassifiedRequests))),
    section='bots',toJSONString(map('name',name,'vendor',vendor,'type',type,'botId',botId,'requests',toString(requests),'aiRequests',toString(ai),'pages',toString(pages),'lastVisit',toString(lastTime))),
    toJSONString(map('path',path,'bot',name,'botId',botId,'requests',toString(requests),'lastCrawled',toString(lastTime)))) AS row
  FROM (${source})
  ORDER BY section,requests DESC,if(section='pages',path,name),if(section='pages',name,''),botId,vendor,type
  SETTINGS optimize_aggregation_in_order=1`;
}

type LiveOverviewLogs = {
  paths: string[];
  catalogPaths?: string[];
  todayEnd?: Date;
  hourlyTrend?: boolean;
};
export function liveOverviewLogs(
  start: Date,
  end: Date,
  timezone: string,
  metrics: CrawlerMetricOptions,
  live: LiveOverviewLogs,
) {
  return {
    sql: renderWarehouseOverviewAggregate(
      overviewAggregateRows(metrics, false, 'counts', undefined, live),
      live,
    ),
    params: {
      ...range(start, end, timezone),
      overviewPaths: live.paths,
      ...(live.catalogPaths?.length ? { catalogPaths: live.catalogPaths } : {}),
      staticPattern: logCountPattern,
      ...(live.todayEnd ? { todayEnd: warehouseTime(live.todayEnd) } : {}),
    },
  };
}
function overviewAggregateRows(
  metrics: CrawlerMetricOptions,
  restrictEvidenceToWindow: boolean,
  output: 'counts' | 'states' | 'days',
  readWindow?: AnalysisWindow,
  live?: LiveOverviewLogs,
) {
  const ai = crawlerAiSql('l');
  const unknown = unknownCrawlerSql('l');
  const groupDay = output === 'days';
  const today = !!live?.todayEnd;
  const trend = live?.hourlyTrend === true;
  const separateSelfChecks = today && metrics.crawlerMetricsVersion === 1;
  const columns = [
    ...overviewLogColumns,
    ...(live ? ['human_path'] : []),
    ...(separateSelfChecks ? ['user_agent'] : []),
  ];
  const selected = live
    ? `(l.human_path IN {overviewPaths:Array(String)} OR l.path IN {overviewPaths:Array(String)}
    OR (l.human_path='' AND position(l.path,'%')>0))`
    : '1';
  const botGroup = live
    ? `(section='bots' OR (section='pages' AND ${selected}))`
    : `section!='summary'`;
  const pageFilter = live?.catalogPaths
    ? ` AND (${selected}${live.catalogPaths.length ? ' OR l.path IN {catalogPaths:Array(String)}' : ''})`
    : '';
  const reportSection = `(k='summary' OR (l._present AND ((k='bots' AND NOT ${unknown}) OR
    (k='pages' AND ${ai}${pageFilter})${trend ? " OR k='trend'" : ''})))`;
  const sections = today
    ? `arrayFilter(k -> (k='today' AND (NOT l._present OR l.created_at<={todayEnd:DateTime64(6,'UTC')}))
    OR (${reportSection}${
        separateSelfChecks
          ? " AND (NOT l._present OR l.user_agent NOT LIKE 'Liekan-Crawler-Check/%')"
          : ''
      }),['summary','bots','pages','today'${trend ? ",'trend'" : ''}])`
    : `arrayFilter(k -> ${reportSection},['summary','bots','pages'${trend ? ",'trend'" : ''}])`;
  const relation = scoped(
    separateSelfChecks ? { ...metrics, crawlerMetricsVersion: undefined } : metrics,
    columns,
    true,
    groupDay || separateSelfChecks ? { endExclusive: true } : undefined,
    restrictEvidenceToWindow,
    readWindow,
  );
  const day = 'toDate32(assumeNotNull(l.created_at),{timezone:String})';
  const unique = (value: string, condition: string) =>
    output === 'counts'
      ? `uniqExactIf(${value},${condition})`
      : `uniqExactStateIf(assumeNotNull(${value}),toUInt8(isNotNull(${value}) AND ${condition}))`;
  // One zero-weight seed preserves the empty aggregate row without another fact
  // scan. A complete day with no rows is recorded in the coverage checkpoint.
  return `SELECT ${groupDay ? `${day} AS day,` : ''}section,
    ${trend ? `if(section='trend',formatDateTime(l.created_at,'${trendHourFormat}',{timezone:String}),NULL) AS trendHour,` : ''}
    if(${botGroup}${trend ? " OR section='trend'" : ''},l.bot,NULL) AS name,if(section='bots',l.vendor,NULL) AS vendor,
    if(section='bots'${trend ? " OR section='trend'" : ''},l.bot_type,NULL) AS type,if(${botGroup},l.reporting_crawler_id,NULL) AS botId,
    if(section='pages',l.path,NULL) AS path,
    countIf(l._present${
      today ? " AND (section!='today' OR NOT match(l.path,{staticPattern:String}))" : ''
    }) AS requests,countIf(l._present AND ${ai}) AS ai,
    ${unique(
      'l.path',
      `l._present AND (section='bots' OR (section='summary' AND ${ai}))`,
    )} AS pages,
    countIf(l._present AND l.status>=400) AS abnormal,
    ${unique(
      "coalesce(l.reporting_classification_version,'legacy')",
      "l._present AND section='summary'",
    )} AS classificationVersions,
    countIf(l._present AND isNull(l.ai_eligible)) AS legacyRequests,
    countIf(l._present AND ${unknown}) AS unclassifiedRequests,max(l.created_at) AS lastTime
    FROM (SELECT ${columns.map(c => `l.${c}`).join(',')},1 AS _present ${relation}
      UNION ALL SELECT ${columns.map(() => 'NULL').join(',')},0 AS _present) l
    ARRAY JOIN ${sections} AS section
    ${groupDay ? `WHERE l._present AND ${day} IN {overviewDays:Array(Date32)}` : ''}
    GROUP BY ${groupDay ? 'day,' : ''}${trend ? 'trendHour,' : ''}section,name,vendor,type,botId,path`;
}

export async function warehouseLogFacts(...args: Parameters<typeof import('./logs').getLogFacts>) {
  const [
    id,
    start,
    end,
    timezone,
    page = 1,
    filter = '',
    search = '',
    cursor = '',
    seek = 'after',
    fields,
    metrics = { crawlerIdentityScope: 'all' },
    fullExport = false,
    comparisonBoundary,
    detailRead,
  ] = args;
  return withinWarehouseReport(async () => {
    const meta = await warehouseReportMetadata(id),
      needs = (key: string) => !fields || fields.includes(key);
    const catalog = needs('catalog')
      ? await warehouseReader().db.read<{ path: string }>(
          'SELECT path,title,content_type AS type,word_count AS "wordCount",published_at AS "publishedAt",content_updated_at AS "updatedAt",link_depth AS "linkDepth",evidence_source AS source,structured,structure_score AS "structureScore" FROM liekan_catalog WHERE website_id=$1::uuid ORDER BY path',
          [id],
        )
      : [];
    // The preference page uses per-path log rows only to join the catalog.
    // Keep summary, bot denominators and the recent crawl path site-wide.
    const preferencePaths =
      fields && needs('catalog') && !fullExport && metrics.resource === 'ai/preference'
        ? new Set(catalog.map(row => row.path))
        : undefined;
    const pushCatalogPaths =
      !!preferencePaths &&
      catalog.reduce((bytes, row) => bytes + Buffer.byteLength(row.path) + 8, 0) <= 64 * 1024;
    const { params, previousParams, base, ai, forms, botQuery, statements, filterSql, detailBase } =
      await warehouseLogQuerySpec(
        start,
        end,
        timezone,
        metrics,
        filter,
        search,
        needs('previousBots'),
        id,
        false,
        false,
        undefined,
        pushCatalogPaths,
      );
    const aggregates: Record<string, any[]> = {};
    // AI overview reads every known spider group with the same filters as daily.
    // Within one local day only the additional bot_type grouping needs folding.
    const botDay =
      metrics.resource === 'ai/overview' && needs('bots') && needs('daily')
        ? singleLogDay(start, end, timezone, metrics.crawlerMetricsVersion === 1)
        : undefined;
    // Limit concurrent scans per report independently of the HTTP concurrency gate.
    for (const [key, sql] of Object.entries(statements)) {
      if (!needs(key) || (key === 'daily' && botDay)) continue;
      if (key === 'pages' && preferencePaths) {
        if (!preferencePaths.size) continue;
        const pages: any[] = [];
        await warehouseReportStream<{ path: string }>(
          id,
          sql,
          pushCatalogPaths ? { ...params, catalogPaths: [...preferencePaths] } : params,
          async batch => {
            for (const row of batch)
              if (preferencePaths.has(row.path)) pages.push(warehouseNumbers(row));
          },
        );
        aggregates.pages = pages;
      } else {
        aggregates[key] = warehouseNumbers(
          await (key !== 'pages'
            ? roundLogAggregate<any>(id, sql, params)
            : warehouseReportQuery<any>(id, sql, params)),
        );
      }
    }
    if (botDay) aggregates.daily = dailyCountsFromBots(botDay, aggregates.bots);
    const [classification] =
      !detailRead && metrics.crawlerMetricsVersion === 1 && needs('recent')
        ? await warehouseReportQuery<any>(
            id,
            `SELECT arrayStringConcat(arraySort(groupUniqArray(coalesce(reporting_classification_version,'legacy'))),',') AS versions ${base}${filterSql}`,
            params,
          )
        : [];
    const { boundary, population: _population, ...control } = meta;
    const scope =
      detailRead?.cursorScope ??
      createHash('sha256')
        .update(
          JSON.stringify({
            id,
            start,
            end,
            timezone,
            filter,
            search,
            metrics,
            control,
            epoch: boundary.epoch,
            deletion: boundary.deletionRevision,
            classification: classification?.versions,
            population: CRAWLER_POPULATION_VERSION,
            engine: 'warehouse-v1',
          }),
        )
        .digest('hex');
    const boundaryKey = cursor
      ? comparisonBoundary
        ? [
            typeof comparisonBoundary[0] === 'string'
              ? comparisonBoundary[0]
              : warehouseTime(comparisonBoundary[0]),
            comparisonBoundary[1],
          ]
        : decodeWarehouseLogCursor(cursor, scope)
      : null;
    Object.assign(params, {
      search,
      skip: (page - 1) * 100,
      ...(boundaryKey ? { cursorAt: boundaryKey[0], cursorId: boundaryKey[1] } : {}),
    });
    const order = cursor && seek === 'before' ? 'ASC' : 'DESC';
    const readDetail = (
      from: string,
      queryParams: Record<string, unknown>,
      limit: number,
      offset = false,
    ) =>
      warehouseReportQuery<any>(
        id,
        `SELECT ${warehouseLogDetailColumns(ai)} ${from}
         ${cursor ? ` AND (created_at,id) ${seek === 'before' ? '>' : '<'} ({cursorAt:DateTime64(6,'UTC')},{cursorId:String})` : ''}
         ORDER BY created_at ${order},id ${order} LIMIT ${limit}${offset ? ' OFFSET {skip:UInt64}' : ''}`,
        queryParams,
        { traceStage: 'log-page' },
      );
    let detail: any[] = [];
    if (needs('recent')) {
      if (detailRead && !fullExport && (cursor || page === 1)) {
        // Physical timestamps form a conservative superset, including rejected
        // and obsolete candidates. They can add work, never hide accepted rows.
        const [extent] = await warehouseReportQuery<{
          firstHour: string | null;
          lastHour: string | null;
        }>(
          id,
          `SELECT toString(toUnixTimestamp(toStartOfHour(minOrNull(created_at)))) AS firstHour,
                  toString(toUnixTimestamp(toStartOfHour(maxOrNull(created_at)))) AS lastHour
           ${rawLogWindow(metrics.crawlerMetricsVersion === 1)}`,
          params,
          { traceStage: 'log-extent' },
        );
        detail = await readLogPageWindows(
          { start: +start, end: +end, endExclusive: metrics.crawlerMetricsVersion === 1 },
          extent?.firstHour != null && extent.lastHour != null
            ? { firstHour: Number(extent.firstHour), lastHour: Number(extent.lastHour) }
            : undefined,
          detailRead.limit,
          order === 'ASC',
          boundaryKey?.[0],
          async (window, remaining) => {
            const spec = await warehouseLogQuerySpec(
              new Date(window.start),
              new Date(window.end),
              timezone,
              metrics,
              filter,
              search,
              false,
              id,
              false,
              true,
              window,
            );
            return readDetail(spec.detailBase, { ...params, ...spec.params }, remaining);
          },
        );
      } else {
        // Offset links and exports retain their complete ordered relation.
        detail = await readDetail(
          detailBase,
          params,
          fullExport ? 100001 : (detailRead?.limit ?? 100),
          !cursor,
        );
      }
    }
    const count = needs('count')
      ? exactCount(
          (await warehouseReportQuery<any>(id, `SELECT count() AS count ${detailBase}`, params))[0]
            .count,
        )
      : 0;
    const [latest] = needs('latest')
      ? await warehouseReader().db.read<{ time: Date | null; connected: boolean }>(
          `SELECT (SELECT imported_at FROM liekan_import WHERE website_id=$1::uuid AND accepted>0 ORDER BY imported_at DESC LIMIT 1) AS time,${logInputConnectedSql} AS connected`,
          [id],
        )
      : [];
    const previous = needs('previousBots')
      ? warehouseNumbers(
          await warehouseReportQuery<any>(
            id,
            forms
              ? botQuery
              : `SELECT bot AS name,vendor,bot_type AS type,reporting_crawler_id AS botId,count() AS requests ${base} GROUP BY name,vendor,type,botId`,
            previousParams,
          ),
        )
      : [];
    for (const row of aggregates.bots ?? []) row.lastVisit = warehouseLogDate(row.lastVisit);
    for (const row of aggregates.pages ?? []) row.lastCrawled = warehouseLogDate(row.lastCrawled);
    if (cursor && seek === 'before') detail.reverse();
    const visible = detailRead
      ? cursor && seek === 'before'
        ? detail.slice(-(detailRead.limit - 1))
        : detail.slice(0, detailRead.limit - 1)
      : detail;
    const nextCursor = encodeLogCursor(visible.at(-1), scope),
      previousCursor = page > 1 ? encodeLogCursor(visible[0], scope) : '';
    const recent = detail.map(warehouseLogDetailRow);
    return {
      summary: aggregates.summary?.[0] ?? { requests: 0, ai: 0, pages: 0, abnormal: 0 },
      daily: aggregates.daily ?? [],
      bots: aggregates.bots ?? [],
      pages: aggregates.pages ?? [],
      statuses: aggregates.statuses ?? [],
      hours: aggregates.hours ?? [],
      catalog,
      latest: latest?.time ?? null,
      connected: latest?.connected ?? false,
      recent,
      nextCursor,
      previousCursor,
      totalLogs: count,
      previousBots: previous,
    };
  });
}
