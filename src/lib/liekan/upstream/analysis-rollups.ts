import { boundedBrowserEventsSql } from './bounded-browser-events';
import { parseFilterValue } from '@/lib/params';
import {
  getPostgresCountrySQL,
  getPostgresRegionSQL,
  getRegionFilterValues,
  normalizeCountryCode,
} from '@/lib/country';
import { cityNameSQL, cityFilterValues } from './geography-query';
import { getQuerySnapshot } from './query-snapshot';
import { staticRequestExtensionPattern } from './log-content-boundary';
import {
  analysisTransaction,
  findAnalysisVersions,
  analysisLogRawFactsSql,
  analysisLogRawRowsSql,
  analysisVisitRowsSql,
} from './analysis-rollups-db';
import { browserPopulationMetadataSql, populationFromRow } from './browser-population';
import type { BrowserPopulation } from '../contracts/browser-population';
import {
  ANALYSIS_ROLLUP_VERSION,
  analysisSafeNumber,
  analysisPathCoverageSql,
  type AnalysisLogInput,
  type AnalysisLogResult,
  type AnalysisVisitInput,
  type AnalysisVisitTotals,
  type AnalysisVisitPopulationInput,
  type AnalysisTx,
} from './analysis-rollups-model';
export * from './analysis-rollups-model';
export {
  createAnalysisBuild,
  getAnalysisStatus,
  listAnalysisBuilds,
  actionAnalysisBuild,
} from './analysis-rollups-management';
export { runOneAnalysisWorkUnit, reconcileAnalysisRollups } from './analysis-rollups-worker';

export function getAnalysisRollupCapability() {
  return {
    supported: !process.env.CLICKHOUSE_URL,
    version: ANALYSIS_ROLLUP_VERSION,
    exactVisits: true,
    unsupportedVisitFilters: ['eventProperties', 'cohort', 'excludeBounce', 'eventFields'],
    logGrains: ['5m', 'hour'],
    rawFallback: true,
  };
}
const inactive = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  value === false ||
  (Array.isArray(value) && !value.length);
const logFilterKeys = new Set([
  'botProductForm',
  'botCategory',
  'botType',
  'botId',
  'botName',
  'resource',
]);
const visitFilterKeys = new Set([
  'hostname',
  'browser',
  'os',
  'device',
  'screen',
  'language',
  'country',
  'region',
  'city',
]);
async function readTransaction<T>(work: (tx: AnalysisTx) => Promise<T>) {
  const snapshot = getQuerySnapshot();
  const read = async (tx: AnalysisTx) => {
    await tx.$executeRawUnsafe('SET LOCAL jit=off');
    return work(tx);
  };
  return snapshot ? read(snapshot as AnalysisTx) : analysisTransaction(read, 'RepeatableRead');
}
const fixedReadVersions = new WeakMap<
  object,
  Map<string, Promise<Record<string, unknown> | null>>
>();
const manifestWindow = `((m.bucket>=$2::timestamptz AND m.bucket_end<=$3::timestamptz)
 OR (m.row_count=0 AND m.bucket<$3::timestamptz AND m.bucket_end>$2::timestamptz))`;
async function pinnedReadVersions(tx: AnalysisTx, websiteId: string) {
  const snapshot = getQuerySnapshot();
  if (!snapshot) return findAnalysisVersions(tx, websiteId);
  let sites = fixedReadVersions.get(snapshot);
  if (!sites) {
    sites = new Map();
    fixedReadVersions.set(snapshot, sites);
  }
  let versions = sites.get(websiteId);
  if (!versions) {
    versions = findAnalysisVersions(tx, websiteId);
    sites.set(websiteId, versions);
  }
  return versions;
}
async function hasCoveredManifest(
  tx: AnalysisTx,
  input: AnalysisVisitInput,
  family: 'log' | 'visit',
  versions: Record<string, unknown>,
) {
  if (input.allowRawOnly) return true;
  const [coverage] = await tx.$queryRawUnsafe<{ covered: boolean }[]>(
    `SELECT EXISTS(
    SELECT 1 FROM liekan_analysis_manifest m JOIN liekan_analysis_site s USING(website_id,epoch)
    WHERE m.website_id=$1::uuid AND m.family=$4 AND s.mode='live'
     AND ${manifestWindow} AND m.versions=$5::jsonb
     AND m.fingerprint=liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,m.bucket,m.bucket_end)
    LIMIT 1) AS covered`,
    input.websiteId,
    input.startDate,
    input.endDate,
    family,
    JSON.stringify(versions),
  );
  return coverage.covered;
}
function validWindow(input: { startDate: Date; endDate: Date }) {
  return (
    Number.isFinite(+input.startDate) &&
    Number.isFinite(+input.endDate) &&
    +input.endDate >= +input.startDate
  );
}
function timezoneSupported(timezone: string, input: AnalysisLogInput) {
  try {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    // Five-minute facts preserve local hour/day splits in current IANA time zones.
    for (const at of [input.startDate, input.endDate]) {
      const offset = format.formatToParts(at).find(part => part.type === 'timeZoneName')?.value;
      const minutes = offset?.match(/([+-])(\d\d):(\d\d)(?::(\d\d))?/);
      if (minutes && (Number(minutes[3]) % 5 || Number(minutes[4] || 0))) return false;
    }
    return true;
  } catch {
    return false;
  }
}
const coverageSql = `original_coverage AS MATERIALIZED (
 SELECT m.* FROM liekan_analysis_manifest m JOIN liekan_analysis_site s ON s.website_id=m.website_id AND s.epoch=m.epoch
 JOIN website w ON w.website_id=s.website_id AND w.deleted_at IS NULL
 WHERE m.website_id=$1::uuid AND s.mode='live' AND m.family=$5 AND ${manifestWindow}
 AND m.versions=$6::jsonb AND m.fingerprint=liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,m.bucket,m.bucket_end)
), covered AS MATERIALIZED (
 SELECT website_id,epoch,family,generation,row_count,path_complete,
  greatest(bucket,$2::timestamptz) AS bucket,least(bucket_end,$3::timestamptz) AS bucket_end FROM original_coverage
)`;
function gapRangesSql(name: string, covered: string, inclusiveEnd: boolean) {
  const end = `$3::timestamptz${inclusiveEnd ? "+interval '1 microsecond'" : ''}`;
  return `${name}_edges AS (
    SELECT $2::timestamptz AS starts,coalesce(min(bucket),${end}) AS ends FROM ${covered}
    UNION ALL SELECT bucket_end AS starts,coalesce(lead(bucket) OVER(ORDER BY bucket),${end}) AS ends FROM ${covered}
   ), ${name} AS MATERIALIZED (SELECT starts,ends FROM ${name}_edges WHERE starts<ends)`;
}
// A full UTC hour can use hourly counts when every five-minute grid point has an integral-hour zone offset.
// The same grid is the smallest supported fact resolution; non-hour offsets retain five-minute facts.
const lowGrainSql = `(CASE WHEN $2::timestamptz=date_bin(interval '1 hour',$2::timestamptz,timestamptz '2000-01-01Z')
 AND $3::timestamptz=date_bin(interval '1 hour',$3::timestamptz,timestamptz '2000-01-01Z')
 AND $3::timestamptz-$2::timestamptz<=interval '366 days'
 AND NOT EXISTS(SELECT 1 FROM generate_series($2::timestamptz,$3::timestamptz,interval '5 minutes') grid(at)
   WHERE mod(extract(epoch FROM ((at AT TIME ZONE $4)-(at AT TIME ZONE 'UTC')))::bigint,3600)<>0)
 THEN 'hour' ELSE '5m' END)`;
const derivedBucketBounds = `f.bucket>=date_bin(interval '1 hour',$2::timestamptz,timestamptz '2000-01-01Z') AND f.bucket<$3::timestamptz`;
const flattened = `dimensions->>'bot' AS bot,dimensions->>'vendor' AS vendor,dimensions->>'type' AS bot_type,
 dimensions->>'crawlerId' AS bot_id,dimensions->>'catalogVersion' AS catalog_version,
 dimensions->>'classificationVersion' AS classification_version,(dimensions->>'aiEligible')::boolean AS ai_eligible,
 dimensions->>'recognitionState' AS recognition_state,dimensions->>'verification' AS verification,
 (dimensions->>'selfCheck')::boolean AS self_check,(dimensions->>'status')::integer AS status,dimensions->>'productForm' AS product_form`;
const ai = `coalesce(ai_eligible,bot_type IN('训练','搜索','用户触发'))`;
const unknown = `(coalesce(recognition_state IN('unknown','ambiguous'),false) OR (recognition_state IS NULL AND bot='其他'))`;
const identity = `($8='all' OR ($8='verified_range' AND verification='verified_range') OR ($8='verified_identity' AND verification IN('verified_range','verified_dns','verified_edge')))`;
const forms = `($9::text IS NULL OR product_form=$9) AND ($10::text IS NULL OR (bot_type NOT IN('训练','搜索','用户触发','传统搜索') AND coalesce(product_form,'unknown') NOT IN('workbench','personal_agent')))`;

/** Today keeps its inclusive endpoints and its complete reporting-log population. */
export async function readAnalysisLogToday(input: AnalysisVisitInput): Promise<{
  requests: number;
  abnormal: number;
  coverage: { manifests: number; rawFallback: boolean };
} | null> {
  if (process.env.CLICKHOUSE_URL || !validWindow(input)) return null;
  try {
    return await readTransaction(async tx => {
      const versions = await pinnedReadVersions(tx, input.websiteId);
      if (!versions) return null;
      const [result] = await tx.$queryRawUnsafe<
        {
          requests: string;
          abnormal: string;
          manifests: string;
          raw_fallback: boolean;
        }[]
      >(
        `WITH covered AS MATERIALIZED (
         SELECT m.website_id,m.generation,m.bucket,m.bucket_end FROM liekan_analysis_manifest m
         JOIN liekan_analysis_site s ON s.website_id=m.website_id AND s.epoch=m.epoch
         JOIN website w ON w.website_id=s.website_id AND w.deleted_at IS NULL
         WHERE m.website_id=$1::uuid AND s.mode='live' AND m.family='log' AND NOT $5::boolean
          AND m.bucket>=$2::timestamptz AND m.bucket_end<=$3::timestamptz
          AND m.bucket_end<=clock_timestamp()-interval '30 seconds'
          AND m.bucket=date_bin(interval '5 minutes',m.bucket,timestamptz '2000-01-01Z')
          AND m.bucket_end=date_bin(interval '5 minutes',m.bucket_end,timestamptz '2000-01-01Z')
          AND m.versions=$4::jsonb
          AND m.fingerprint=liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,m.bucket,m.bucket_end)
        ), ${gapRangesSql('raw_gaps', 'covered', true)}, counts AS (
         SELECT coalesce(sum(f.requests) FILTER(WHERE NOT (f.dimensions->>'staticResource')::boolean),0) AS requests,
          coalesce(sum(f.requests) FILTER(WHERE (f.dimensions->>'status')::int>=400),0) AS abnormal
         FROM covered c JOIN liekan_analysis_log f ON f.website_id=c.website_id AND f.generation=c.generation
          AND f.grain='5m' AND f.bucket>=c.bucket AND f.bucket<c.bucket_end
         UNION ALL
         SELECT count(*) FILTER(WHERE l.path !~* '${staticRequestExtensionPattern}'),count(*) FILTER(WHERE l.status>=400)
         FROM raw_gaps g CROSS JOIN LATERAL (
          SELECT l.path,l.status FROM liekan_reporting_log l
          WHERE l.website_id=$1::uuid AND l.created_at>=g.starts AND l.created_at<g.ends OFFSET 0
         ) l
        ) SELECT coalesce(sum(requests),0)::text AS requests,coalesce(sum(abnormal),0)::text AS abnormal,
         (SELECT count(*)::text FROM covered) AS manifests,
         EXISTS(SELECT 1 FROM raw_gaps) AS raw_fallback FROM counts`,
        input.websiteId,
        input.startDate,
        input.endDate,
        JSON.stringify(versions),
        !!input.allowRawOnly,
      );
      return {
        requests: analysisSafeNumber(result.requests),
        abnormal: analysisSafeNumber(result.abnormal),
        coverage: {
          manifests: analysisSafeNumber(result.manifests),
          rawFallback: result.raw_fallback,
        },
      };
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** Exact disjoint covered/raw population. Unsupported input returns null to the existing SQL path. */
export async function readAnalysisLogRollup(
  input: AnalysisLogInput,
): Promise<AnalysisLogResult | null> {
  if (process.env.CLICKHOUSE_URL || !validWindow(input)) return null;
  const filters = input.filters || {};
  if (Object.entries(filters).some(([key, value]) => !logFilterKeys.has(key) && !inactive(value)))
    return null;
  if (Object.values(filters).some(value => !inactive(value) && typeof value !== 'string'))
    return null;
  if (Object.entries(filters).some(([key, value]) => key !== 'resource' && value === ''))
    return null;
  if (filters.botCategory && filters.botCategory !== 'other') return null;
  if (!['all', 'verified_range', 'verified_identity'].includes(input.crawlerIdentityScope || 'all'))
    return null;
  const timezone = input.timezone || 'UTC';
  if (!timezoneSupported(timezone, input)) return null;
  const modern = input.crawlerMetricsVersion === 1;
  const resource = filters.resource || '';
  const withForms = resource === 'ai/bots' || resource === 'ai/pages';
  try {
    return await readTransaction(async tx => {
      const versions = await pinnedReadVersions(tx, input.websiteId);
      if (!versions || !(await hasCoveredManifest(tx, input, 'log', versions))) return null;
      const aggregates: Record<string, string> = {
        classificationSet: `(SELECT coalesce(string_agg(DISTINCT classification_version,','),'legacy') FROM low)`,
        summary: `(SELECT jsonb_build_object('requests',coalesce(sum(requests),0)::text,'ai',coalesce(sum(requests) FILTER(WHERE ${ai}),0)::text,
          'pages',(SELECT count(DISTINCT path)::text FROM paths WHERE ${ai}),
          'abnormal',coalesce(sum(requests) FILTER(WHERE status>=400),0)::text,
          'classificationVersions',count(DISTINCT coalesce(classification_version,'legacy'))::text,
          'legacyRequests',coalesce(sum(requests) FILTER(WHERE ai_eligible IS NULL),0)::text,
          'unclassifiedRequests',coalesce(sum(requests) FILTER(WHERE ${unknown}),0)::text) FROM low)`,
        bots: `coalesce((SELECT jsonb_agg(t) FROM (
          SELECT bot AS name,vendor,bot_type AS type,bot_id AS "botId",
           ${withForms ? "string_agg(DISTINCT coalesce(product_form,'unknown'),',' ORDER BY coalesce(product_form,'unknown')) AS \"productForm\"," : ''}
           sum(requests)::text AS requests,coalesce(sum(requests) FILTER(WHERE ${ai}),0)::text AS "aiRequests",
           count(DISTINCT path)::text AS pages,max(last_at) AS "lastVisit"
          FROM paths WHERE NOT ${unknown} ${withForms ? `AND ${forms}` : ''}
          GROUP BY bot,vendor,bot_type,bot_id ORDER BY sum(requests) DESC,bot,bot_id
        ) t),'[]'::jsonb)`,
        pages: `coalesce((SELECT jsonb_agg(t) FROM (
          SELECT path,bot,bot_id AS "botId",sum(requests)::text AS requests,max(last_at) AS "lastCrawled"
          FROM paths WHERE ${ai} ${withForms ? `AND NOT ${unknown} AND ${forms}` : ''}
          ${resource === 'ai/pages' ? 'AND ($11::text IS NULL OR bot_type=$11) AND ($12::text IS NULL OR bot_id=$12) AND ($13::text IS NULL OR (bot_id IS NULL AND bot=$13))' : ''}
          GROUP BY path,bot,bot_id ORDER BY sum(requests) DESC,path,bot,bot_id
        ) t),'[]'::jsonb)`,
        daily: `coalesce((SELECT jsonb_agg(t) FROM (
          SELECT to_char(bucket AT TIME ZONE $4,'YYYY-MM-DD') AS day,bot,vendor,bot_id AS "botId",sum(requests)::text AS count,
            coalesce(sum(requests) FILTER(WHERE ${ai}),0)::text AS "aiRequests"
          FROM low WHERE NOT ${unknown} GROUP BY 1,2,3,4 ORDER BY 1,2,3,4
        ) t),'[]'::jsonb)`,
        statuses: `coalesce((SELECT jsonb_agg(t) FROM (
          SELECT (status/100)*100 AS status,sum(requests)::text AS count FROM low WHERE ${ai} GROUP BY 1 ORDER BY 1
        ) t),'[]'::jsonb)`,
        hours: `coalesce((SELECT jsonb_agg(t) FROM (
          SELECT extract(hour FROM bucket AT TIME ZONE $4)::int AS hour,sum(requests)::text AS count FROM low WHERE ${ai} GROUP BY 1 ORDER BY 1
        ) t),'[]'::jsonb)`,
      };
      const requested =
        input.fields || Object.keys(aggregates).filter(field => field !== 'classificationSet');
      if (requested.some(field => !Object.hasOwn(aggregates, field))) return null;
      const needsPaths = requested.some(field => ['summary', 'bots', 'pages'].includes(field));
      const projections = requested.map(field => `${aggregates[field]} AS "${field}"`);
      const [result] = await tx.$queryRawUnsafe<any[]>(
        `WITH ${coverageSql}, ${gapRangesSql('raw_gaps', 'covered', !modern)},
        path_covered AS MATERIALIZED(SELECT * FROM covered c WHERE ${analysisPathCoverageSql('c')}),
        ${gapRangesSql('path_gaps', 'path_covered', !modern)},
        reporting_gaps AS MATERIALIZED(SELECT * FROM raw_gaps ${needsPaths ? 'UNION ALL SELECT * FROM path_gaps' : ''}),
        ${analysisLogRawFactsSql('reporting_gaps')},
        raw_scope AS MATERIALIZED (
         SELECT * FROM reporting_facts WHERE created_at<@(SELECT range_agg(tstzrange(starts,ends,'[)')) FROM raw_gaps)
        ), path_scope AS MATERIALIZED (
         SELECT * FROM reporting_facts WHERE created_at<@(SELECT range_agg(tstzrange(starts,ends,'[)')) FROM path_gaps)
        ), low_facts AS (
         SELECT f.bucket,f.dimensions,f.requests,f.first_at,f.last_at FROM liekan_analysis_log f JOIN covered c ON c.generation=f.generation AND c.website_id=f.website_id
         WHERE ${derivedBucketBounds} AND f.grain=${lowGrainSql}
         UNION ALL
         SELECT date_bin(interval '5 minutes',created_at,timestamptz '2000-01-01Z'),dimensions,count(*),min(created_at),max(created_at) FROM raw_scope GROUP BY 1,2
        ), path_facts AS (
         SELECT f.path,f.dimensions,f.requests,f.first_at,f.last_at FROM liekan_analysis_path f JOIN path_covered c ON c.generation=f.generation AND c.website_id=f.website_id
         WHERE ${derivedBucketBounds}
         UNION ALL
         SELECT path,dimensions,count(*),min(created_at),max(created_at) FROM path_scope GROUP BY 1,2
        ), low_flat AS (SELECT bucket,requests,first_at,last_at,${flattened} FROM low_facts),
        path_flat AS (SELECT path,requests,first_at,last_at,${flattened} FROM path_facts),
        low AS MATERIALIZED (SELECT * FROM low_flat WHERE ${modern ? 'NOT self_check AND' : ''} ${identity}),
        paths AS MATERIALIZED (SELECT * FROM path_flat WHERE ${modern ? 'NOT self_check AND' : ''} ${identity})
        SELECT
        ${projections.length ? projections.join(',') + ',' : ''}
        jsonb_build_object('manifests',(SELECT count(*)::text FROM covered),'rawFallback',NOT $7::boolean OR (SELECT coalesce(sum(extract(epoch FROM bucket_end-bucket)),0)<extract(epoch FROM $3::timestamptz-$2::timestamptz) FROM covered) ${needsPaths ? 'OR (SELECT coalesce(sum(extract(epoch FROM bucket_end-bucket)),0)<extract(epoch FROM $3::timestamptz-$2::timestamptz) FROM path_covered)' : ''}) AS coverage
        FROM (SELECT $4::text,$7::boolean,$9::text,$10::text,$11::text,$12::text,$13::text) parameter_types`,
        input.websiteId,
        input.startDate,
        input.endDate,
        timezone,
        'log',
        JSON.stringify(versions),
        modern,
        input.crawlerIdentityScope || 'all',
        filters.botProductForm || null,
        filters.botCategory || null,
        resource === 'ai/pages' ? filters.botType || null : null,
        resource === 'ai/pages' ? filters.botId || null : null,
        resource === 'ai/pages' && !filters.botId ? filters.botName || null : null,
      );
      const convert = (row: Record<string, unknown>, keys: string[]) => {
        for (const key of keys) row[key] = analysisSafeNumber(row[key] as string);
      };
      if (result.summary)
        convert(result.summary, [
          'requests',
          'ai',
          'pages',
          'abnormal',
          'classificationVersions',
          'legacyRequests',
          'unclassifiedRequests',
        ]);
      for (const row of result.bots || []) convert(row, ['requests', 'aiRequests', 'pages']);
      for (const row of result.pages || []) convert(row, ['requests']);
      for (const row of result.daily || []) convert(row, ['count', 'aiRequests']);
      for (const row of [...(result.statuses || []), ...(result.hours || [])])
        convert(row, ['count']);
      result.coverage.manifests = analysisSafeNumber(result.coverage.manifests);
      return result as AnalysisLogResult;
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function normalizedVisitFilters(
  input: Record<string, unknown> = {},
): Record<string, string> | null {
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (
      raw === undefined ||
      raw === null ||
      (key === 'excludeBounce' && raw === false) ||
      (['eventPropertyFilters', 'sessionPropertyFilters'].includes(key) &&
        Array.isArray(raw) &&
        raw.length === 0)
    )
      continue;
    if (!visitFilterKeys.has(key) || typeof raw !== 'string') return null;
    const parsed = parseFilterValue(raw);
    if (
      parsed.operator !== 'eq' ||
      !Array.isArray(parsed.value) ||
      parsed.value.length !== 1 ||
      typeof parsed.value[0] !== 'string'
    )
      return null;
    let value = parsed.value[0];
    if (value === '') return null;
    if (key === 'country') value = normalizeCountryCode(value);
    if (key === 'region') {
      const values = getRegionFilterValues(value);
      if (values.length !== 1 || typeof values[0] !== 'string') return null;
      value = values[0];
    }
    output[key] = value;
  }
  return output;
}
function visitFilterColumn(key: string, selectedValue?: string) {
  const country = "(dimensions->>'country')",
    region = "(dimensions->>'region')",
    city = "(dimensions->>'city')";
  if (key === 'hostname') return 'hostname';
  if (key === 'country') return getPostgresCountrySQL(country);
  if (key === 'region') return getPostgresRegionSQL(country, region);
  if (key === 'city') return cityNameSQL(country, region, city, 'postgres', selectedValue);
  return `dimensions->>'${key}'`;
}
function visitFilterParameters(filters: Record<string, string>) {
  return Object.entries(filters).map(([key, value]) =>
    key === 'city' ? [...new Set([...cityFilterValues(value), value])] : value,
  );
}
function visitConditions(filters: Record<string, string>) {
  const parts = Object.entries(filters).map(([key, value], index) => {
    const parameter = `$${index + 7}`;
    if (key === 'city') {
      const column = visitFilterColumn(key, value);
      return `(${column}=ANY(${parameter}::text[]) OR coalesce(dimensions->>'city',${column})=ANY(${parameter}::text[]))`;
    }
    return `${visitFilterColumn(key, value)}=${parameter}::text`;
  });
  if (Object.keys(filters).some(key => key !== 'hostname'))
    parts.push("(dimensions->>'sessionPresent')::boolean");
  return parts.join(' AND ') || 'true';
}
function visitFactsSql(inclusiveEnd = true, geography = true, observed = false) {
  const condition = `e.website_id=$1::uuid AND e.created_at>=$2::timestamptz AND e.created_at${inclusiveEnd ? '<=' : '<'}$3::timestamptz AND EXISTS(SELECT 1 FROM visit_gaps g WHERE e.created_at>=g.starts AND e.created_at<g.ends)`;
  return `${coverageSql}, ${gapRangesSql('visit_gaps', 'covered', inclusiveEnd)},
  ${boundedBrowserEventsSql(condition, { geography, environment: true, ranges: 'visit_gaps' })}, raw_scope AS MATERIALIZED (
   SELECT e.session_id,e.visit_id,e.hostname,e.dimensions,
    count(*) AS eligible_events,count(*) FILTER(WHERE e.event_type NOT IN(2,5)) AS pageviews,bool_or(e.event_type=2) AS has_custom,
    min(e.created_at) FILTER(WHERE e.event_type NOT IN(2,5)) AS min_time,max(e.created_at) FILTER(WHERE e.event_type NOT IN(2,5)) AS max_time
   FROM (${analysisVisitRowsSql(condition, 'bounded_events', geography, observed)}) e
   GROUP BY e.session_id,e.visit_id,e.hostname,e.dimensions
 ), observed_facts AS MATERIALIZED (
  SELECT f.session_id,f.visit_id,f.hostname,f.dimensions,f.eligible_events,f.pageviews,f.has_custom,f.min_time,f.max_time
  FROM liekan_analysis_visit f JOIN covered c ON c.generation=f.generation AND c.website_id=f.website_id WHERE ${derivedBucketBounds}
  UNION ALL SELECT * FROM raw_scope
 ), facts AS MATERIALIZED (
  SELECT * FROM observed_facts WHERE coalesce((dimensions->>'identityAvailable')::boolean,false)
 )`;
}

/** Read the crawler page's browser presence, date labels and identity evidence together. */
export async function readAnalysisVisitContext(input: AnalysisVisitPopulationInput): Promise<{
  totals: AnalysisVisitTotals;
  population: BrowserPopulation;
  dates: string[];
} | null> {
  if (
    process.env.CLICKHOUSE_URL ||
    !validWindow(input) ||
    +input.endDate - +input.startDate > 1096 * 86400000
  )
    return null;
  const timezone = input.timezone || 'UTC';
  if (!timezoneSupported(timezone, input)) return null;
  return readTransaction(async tx => {
    // UTC hour facts can supply calendar labels only when the whole hour stays on one local day.
    const [grid] = await tx.$queryRawUnsafe<{ aligned: boolean }[]>(
      `SELECT NOT EXISTS(SELECT 1 FROM generate_series(
        date_bin(interval '1 hour',$1::timestamptz,timestamptz '2000-01-01Z'),$2::timestamptz,interval '1 hour') hours(at)
       WHERE mod(extract(epoch FROM ((at AT TIME ZONE $3)-(at AT TIME ZONE 'UTC'))),3600)<>0
        OR (at AT TIME ZONE $3)::date<>((at+interval '1 hour'-interval '1 microsecond') AT TIME ZONE $3)::date) AS aligned`,
      input.startDate,
      input.endDate,
      timezone,
    );
    if (!grid.aligned) return null;
    const versions = await pinnedReadVersions(tx, input.websiteId);
    if (!versions) return null;
    const [row] = await tx.$queryRawUnsafe<any[]>(
      `WITH ${coverageSql}, ${gapRangesSql('visit_gaps', 'covered', !input.halfOpen)},
raw_window AS MATERIALIZED(
 SELECT e.* FROM visit_gaps gap CROSS JOIN LATERAL(
  SELECT e.session_id,e.visit_id,e.created_at,e.event_type,
   qualified.event_id IS NOT NULL AND EXISTS(SELECT 1 FROM (TABLE session) present WHERE present.website_id=e.website_id AND present.session_id=e.session_id) AS identity_available,
   env.identity_version,q.rule_version,q.catalog_version::text AS catalog_version
  FROM liekan_observed_browser_event e
  LEFT JOIN liekan_event_environment env ON env.website_id=e.website_id AND env.event_id=e.event_id
  LEFT JOIN liekan_reporting_event_quality q ON q.website_id=e.website_id AND q.event_id=e.event_id
  LEFT JOIN liekan_browser_identity qualified ON qualified.website_id=e.website_id AND qualified.event_id=e.event_id
  WHERE e.website_id=$1::uuid AND e.created_at>=gap.starts AND e.created_at<gap.ends OFFSET 0
 ) e
), raw_context AS MATERIALIZED(
 SELECT session_id,visit_id,to_char(created_at AT TIME ZONE $4,'YYYY-MM-DD') AS day,identity_available,identity_version,rule_version,catalog_version,
  count(*) AS eligible_events,count(*) FILTER(WHERE event_type NOT IN(2,5)) AS pageviews,bool_or(event_type=2) AS has_custom,
  min(created_at) FILTER(WHERE event_type NOT IN(2,5)) AS min_time,max(created_at) FILTER(WHERE event_type NOT IN(2,5)) AS max_time
 FROM raw_window GROUP BY 1,2,3,4,5,6,7
), context_facts AS MATERIALIZED(
 SELECT f.session_id,f.visit_id,to_char(f.bucket AT TIME ZONE $4,'YYYY-MM-DD') AS day,
  coalesce((f.dimensions->>'identityAvailable')::boolean,false) AS identity_available,
  f.dimensions->>'identityVersion' AS identity_version,f.dimensions->>'ruleVersion' AS rule_version,f.dimensions->>'catalogVersion' AS catalog_version,
  f.eligible_events,f.pageviews,f.has_custom,f.min_time,f.max_time
 FROM liekan_analysis_visit f JOIN covered c ON c.generation=f.generation AND c.website_id=f.website_id
 WHERE f.bucket>=date_bin(interval '1 hour',$2::timestamptz,timestamptz '2000-01-01Z') AND f.bucket<$3::timestamptz
 UNION ALL SELECT * FROM raw_context
), context_visits AS MATERIALIZED(
 SELECT session_id,visit_id,sum(pageviews) AS pageviews,bool_or(has_custom) AS has_custom,min(min_time) AS min_time,max(max_time) AS max_time
 FROM context_facts WHERE identity_available GROUP BY session_id,visit_id HAVING sum(pageviews)>0
) SELECT ${browserPopulationMetadataSql},'qualified-browser' AS "metricScope",
 coalesce(sum(eligible_events),0)::text AS "eligibleEvents",
 coalesce(sum(eligible_events) FILTER(WHERE identity_available),0)::text AS "qualifiedEvents",
 coalesce(sum(pageviews),0)::text AS "eligiblePV",
 coalesce(sum(pageviews) FILTER(WHERE identity_available),0)::text AS "qualifiedPV",
 count(DISTINCT session_id) FILTER(WHERE pageviews>0 AND identity_available)::text AS "qualifiedVisitors",
 ARRAY(SELECT DISTINCT identity_version FROM context_facts WHERE identity_version IS NOT NULL ORDER BY 1 LIMIT 33) AS "identityVersions",
 ARRAY(SELECT DISTINCT identity_version FROM context_facts WHERE identity_version IS NOT NULL AND pageviews>0 AND identity_available ORDER BY 1 LIMIT 33) AS "qualifiedIdentityVersions",
 ARRAY(SELECT DISTINCT rule_version FROM context_facts WHERE rule_version IS NOT NULL ORDER BY 1 LIMIT 33) AS "ruleVersions",
 ARRAY(SELECT DISTINCT catalog_version FROM context_facts WHERE catalog_version IS NOT NULL ORDER BY 1 LIMIT 33) AS "catalogVersions",
 ARRAY(SELECT DISTINCT day FROM context_facts WHERE pageviews>0 AND identity_available ORDER BY 1) AS dates,
 (SELECT jsonb_build_object('pageviews',coalesce(sum(pageviews),0)::text,'visitors',count(DISTINCT session_id)::text,'visits',count(DISTINCT visit_id)::text,
  'bounces',count(*) FILTER(WHERE pageviews=1 AND NOT has_custom)::text,'totaltime',coalesce(sum(floor(extract(epoch FROM(max_time-min_time)))),0)::bigint::text) FROM context_visits) AS totals
 FROM context_facts`,
      input.websiteId,
      input.startDate,
      input.endDate,
      timezone,
      'visit',
      JSON.stringify(versions),
    );
    for (const key of [
      'eligibleEvents',
      'qualifiedEvents',
      'eligiblePV',
      'qualifiedPV',
      'qualifiedVisitors',
    ])
      analysisSafeNumber(row[key]);
    return {
      totals: Object.fromEntries(
        Object.entries(row.totals).map(([key, value]) => [
          key,
          analysisSafeNumber(value as string),
        ]),
      ) as unknown as AnalysisVisitTotals,
      population: {
        ...populationFromRow(row, {
          startAt: +input.startDate,
          endAt: +input.endDate,
          timezone,
          ...(input.halfOpen ? { endExclusive: true } : {}),
        }),
        resourceId: input.websiteId,
      },
      dates: row.dates,
    };
  });
}

/** Exact full-window identity evidence is independent of metric filters and PV-only grouping. */
export async function readAnalysisVisitPopulation(
  input: AnalysisVisitPopulationInput,
  executor?: Pick<AnalysisTx, '$queryRawUnsafe'>,
): Promise<BrowserPopulation | null> {
  if (process.env.CLICKHOUSE_URL || !validWindow(input)) return null;
  const read = async (tx: AnalysisTx) => {
    // Link/pixel resources and first-deployment raw-only windows retain the original reader.
    const [candidate] = await tx.$queryRawUnsafe<{ covered: boolean }[]>(
      `SELECT EXISTS(SELECT 1 FROM liekan_analysis_manifest m JOIN liekan_analysis_site s USING(website_id,epoch)
       WHERE m.website_id=$1::uuid AND m.family='visit' AND s.mode='live'
       AND ${manifestWindow} LIMIT 1) AS covered`,
      input.websiteId,
      input.startDate,
      input.endDate,
    );
    if (!candidate?.covered) return null;
    const versions = await pinnedReadVersions(tx, input.websiteId);
    if (!versions || !(await hasCoveredManifest(tx, input, 'visit', versions))) return null;
    const [row] = await tx.$queryRawUnsafe<Record<string, any>[]>(
      `WITH ${visitFactsSql(!input.halfOpen, false, true)}, population_facts AS MATERIALIZED (
       SELECT session_id,eligible_events,pageviews,dimensions FROM observed_facts
       ) SELECT ${browserPopulationMetadataSql},'qualified-browser' AS "metricScope",
       coalesce(sum(eligible_events),0)::text AS "eligibleEvents",
       coalesce(sum(eligible_events) FILTER(WHERE (dimensions->>'identityAvailable')::boolean),0)::text AS "qualifiedEvents",
       coalesce(sum(pageviews),0)::text AS "eligiblePV",
       coalesce(sum(pageviews) FILTER(WHERE (dimensions->>'identityAvailable')::boolean),0)::text AS "qualifiedPV",
       count(DISTINCT session_id) FILTER(WHERE pageviews>0 AND (dimensions->>'identityAvailable')::boolean)::text AS "qualifiedVisitors",
       ARRAY(SELECT DISTINCT dimensions->>'identityVersion' FROM population_facts WHERE dimensions->>'identityVersion' IS NOT NULL ORDER BY 1 LIMIT 33) AS "identityVersions",
       ARRAY(SELECT DISTINCT dimensions->>'identityVersion' FROM population_facts WHERE dimensions->>'identityVersion' IS NOT NULL AND pageviews>0 AND (dimensions->>'identityAvailable')::boolean ORDER BY 1 LIMIT 33) AS "qualifiedIdentityVersions",
       ARRAY(SELECT DISTINCT dimensions->>'ruleVersion' FROM population_facts WHERE dimensions->>'ruleVersion' IS NOT NULL ORDER BY 1 LIMIT 33) AS "ruleVersions",
       ARRAY(SELECT DISTINCT dimensions->>'catalogVersion' FROM population_facts WHERE dimensions->>'catalogVersion' IS NOT NULL ORDER BY 1 LIMIT 33) AS "catalogVersions"
       FROM population_facts CROSS JOIN(SELECT $4::text) parameter_types`,
      input.websiteId,
      input.startDate,
      input.endDate,
      input.timezone || 'UTC',
      'visit',
      JSON.stringify(versions),
    );
    for (const key of [
      'eligibleEvents',
      'qualifiedEvents',
      'eligiblePV',
      'qualifiedPV',
      'qualifiedVisitors',
    ])
      analysisSafeNumber(row[key]);
    return {
      ...populationFromRow(row, {
        startAt: +input.startDate,
        endAt: +input.endDate,
        timezone: input.timezone || 'UTC',
        ...(input.halfOpen ? { endExclusive: true } : {}),
      }),
      resourceId: input.websiteId,
    };
  };
  try {
    return executor ? await read(executor as AnalysisTx) : await readTransaction(read);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** Merge exact IDs and PV bounds over the whole window before calculating UV, visits and bounces. */
export async function readAnalysisVisitTotals(
  input: AnalysisVisitInput,
): Promise<AnalysisVisitTotals | null> {
  if (process.env.CLICKHOUSE_URL || !validWindow(input)) return null;
  const filters = normalizedVisitFilters(input.filters);
  if (!filters) return null;
  try {
    return await readTransaction(async tx => {
      const versions = await pinnedReadVersions(tx, input.websiteId);
      if (!versions || !(await hasCoveredManifest(tx, input, 'visit', versions))) return null;
      const [result] = await tx.$queryRawUnsafe<Record<keyof AnalysisVisitTotals, string>[]>(
        `WITH ${visitFactsSql(
          true,
          ['country', 'region', 'city'].some(key => key in filters),
        )}, visits AS (
         SELECT session_id,visit_id,sum(pageviews) AS pageviews,
          ${'hostname' in filters ? '(SELECT bool_or(all_facts.has_custom) FROM facts all_facts WHERE all_facts.session_id=facts.session_id AND all_facts.visit_id=facts.visit_id)' : 'bool_or(has_custom)'} AS has_custom,
          min(min_time) AS min_time,max(max_time) AS max_time
         FROM facts WHERE ${visitConditions(filters)} GROUP BY session_id,visit_id HAVING sum(pageviews)>0
        ) SELECT coalesce(sum(pageviews),0)::text AS pageviews,count(DISTINCT session_id)::text AS visitors,count(DISTINCT visit_id)::text AS visits,
          count(*) FILTER(WHERE pageviews=1 AND NOT has_custom)::text AS bounces,
          coalesce(sum(floor(extract(epoch FROM (max_time-min_time)))),0)::bigint::text AS totaltime
        FROM visits CROSS JOIN (SELECT $4::text) parameter_types`,
        input.websiteId,
        input.startDate,
        input.endDate,
        'UTC',
        'visit',
        JSON.stringify(versions),
        ...visitFilterParameters(filters),
      );
      return Object.fromEntries(
        Object.entries(result).map(([key, value]) => [key, analysisSafeNumber(value)]),
      ) as unknown as AnalysisVisitTotals;
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

export interface AnalysisVisitMetricsInput extends AnalysisVisitInput {
  type: string;
  limit?: number | string;
  offset?: number | string;
}
/** Exact session-ID distributions for stable dimensions and event-bound visit geography. */
export async function readAnalysisVisitMetrics(
  input: AnalysisVisitMetricsInput,
): Promise<{ x: string; y: number; country?: string }[] | null> {
  if (process.env.CLICKHOUSE_URL || !validWindow(input) || !visitFilterKeys.has(input.type))
    return null;
  const filters = normalizedVisitFilters(input.filters);
  const limit = Number(input.limit ?? 500),
    offset = Number(input.offset ?? 0);
  if (
    !filters ||
    !Number.isSafeInteger(limit) ||
    !Number.isSafeInteger(offset) ||
    limit < 0 ||
    limit > 10000 ||
    offset < 0
  )
    return null;
  const country = getPostgresCountrySQL("(dimensions->>'country')");
  const column =
    input.type === 'language'
      ? "lower(left(dimensions->>'language',2))"
      : input.type === 'city'
        ? "dimensions->>'city'"
        : visitFilterColumn(input.type);
  const includeCountry = input.type === 'region' || input.type === 'city';
  try {
    return await readTransaction(async tx => {
      const versions = await pinnedReadVersions(tx, input.websiteId);
      if (!versions || !(await hasCoveredManifest(tx, input, 'visit', versions))) return null;
      const rows = await tx.$queryRawUnsafe<{ x: string; y: string; country?: string }[]>(
        `WITH ${visitFactsSql()} SELECT ${column} AS x,count(DISTINCT session_id)::text AS y ${includeCountry ? `,${country} AS country` : ''}
         FROM facts CROSS JOIN (SELECT $4::text) parameter_types WHERE pageviews>0 AND ${column}<>'' AND ${visitConditions(filters)} ${input.type !== 'hostname' ? "AND (dimensions->>'sessionPresent')::boolean" : ''}
         GROUP BY 1 ${includeCountry ? ',3' : ''} ORDER BY count(DISTINCT session_id) DESC,1 ${includeCountry ? ',3' : ''}
         LIMIT ${limit} OFFSET ${offset}`,
        input.websiteId,
        input.startDate,
        input.endDate,
        'UTC',
        'visit',
        JSON.stringify(versions),
        ...visitFilterParameters(filters),
      );
      return rows.map(row => ({ ...row, y: analysisSafeNumber(row.y) }));
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

export interface AnalysisLogSeriesInput extends AnalysisLogInput {
  grain: 'day' | 'hour' | 'month';
}
export async function readAnalysisLogSeries(
  input: AnalysisLogSeriesInput,
): Promise<{ day: string; bot: string; type: string; count: number; aiRequests: number }[] | null> {
  if (
    process.env.CLICKHOUSE_URL ||
    !validWindow(input) ||
    !['day', 'hour', 'month'].includes(input.grain)
  )
    return null;
  if (Object.values(input.filters || {}).some(value => !inactive(value))) return null;
  if (!['all', 'verified_range', 'verified_identity'].includes(input.crawlerIdentityScope || 'all'))
    return null;
  const timezone = input.timezone || 'UTC';
  if (!timezoneSupported(timezone, input)) return null;
  const modern = input.crawlerMetricsVersion === 1;
  const format =
    input.grain === 'month'
      ? 'YYYY-MM'
      : input.grain === 'hour'
        ? 'YYYY-MM-DD HH24:00'
        : 'YYYY-MM-DD';
  try {
    return await readTransaction(async tx => {
      const versions = await pinnedReadVersions(tx, input.websiteId);
      if (!versions || !(await hasCoveredManifest(tx, input, 'log', versions))) return null;
      const rows = await tx.$queryRawUnsafe<
        { day: string; bot: string; type: string; count: string; aiRequests: string }[]
      >(
        `WITH ${coverageSql}, ${gapRangesSql('series_gaps', 'covered', !modern)},
        ${analysisLogRawRowsSql('series_gaps')}, series_facts AS (
          SELECT to_char(f.bucket AT TIME ZONE $4,'${format}') AS day,f.dimensions->>'bot' AS bot,f.dimensions->>'type' AS bot_type,
           f.requests,(f.dimensions->>'aiEligible')::boolean AS ai_eligible,f.dimensions->>'recognitionState' AS recognition_state,
           f.dimensions->>'verification' AS verification,(f.dimensions->>'selfCheck')::boolean AS self_check
          FROM liekan_analysis_log f JOIN covered c ON c.generation=f.generation AND c.website_id=f.website_id
          WHERE ${derivedBucketBounds} AND f.grain=${lowGrainSql}
          UNION ALL
          SELECT to_char(date_bin(interval '5 minutes',created_at,timestamptz '2000-01-01Z') AT TIME ZONE $4,'${format}'),bot,bot_type,1::bigint,ai_eligible,recognition_state,verification,
           user_agent LIKE 'Liekan-Crawler-Check/%' FROM reporting_raw
        )
        SELECT day,bot,bot_type AS type,sum(requests)::text AS count,
          coalesce(sum(requests) FILTER(WHERE ${ai}),0)::text AS "aiRequests"
        FROM series_facts CROSS JOIN (SELECT $7::boolean) parameter_types
        WHERE ${modern ? 'NOT self_check AND' : ''} ${identity}
        GROUP BY 1,2,3 ORDER BY 1,2,3`,
        input.websiteId,
        input.startDate,
        input.endDate,
        timezone,
        'log',
        JSON.stringify(versions),
        modern,
        input.crawlerIdentityScope || 'all',
      );
      return rows.map(row => ({
        ...row,
        count: analysisSafeNumber(row.count),
        aiRequests: analysisSafeNumber(row.aiRequests),
      }));
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}
