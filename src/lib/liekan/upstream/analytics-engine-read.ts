import { analysisTransaction } from './analysis-rollups-db';
import type { AnalysisLogInput, AnalysisLogResult, AnalysisTx } from './analysis-rollups-model';
import { analysisSafeNumber } from './analysis-rollups-model';
import {
  chAi,
  chUnknown,
  ENGINE_TABLE,
  engineConnection,
  engineQuery,
  engineWindow,
  supportedLogInput,
} from './analytics-engine-clickhouse';
import { getQuerySnapshot } from './query-snapshot';

async function readEngine<T>(
  input: AnalysisLogInput,
  load: (scope: string, params: Record<string, any>, units: number) => Promise<T>,
): Promise<T | null> {
  if (process.env.CLICKHOUSE_URL || input.allowRawOnly || !supportedLogInput(input)) return null;
  const window = engineWindow(input);
  if (!window) return null;
  let config: ReturnType<typeof engineConnection>;
  try {
    config = engineConnection();
  } catch {
    return null;
  }
  if (!config) return null;
  let timezone = input.timezone || 'UTC';
  try {
    timezone = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  const work = async (tx: AnalysisTx) => {
    const [state] = await tx.$queryRawUnsafe<any[]>(
      'SELECT enabled,epoch,healthy,connection_hash,installation_id FROM liekan_analytics_engine WHERE id=1',
    );
    if (!state?.enabled || !state.healthy || state.connection_hash !== config.key) return null;
    const { engineVersions } = await import('./analytics-engine');
    const versions = await engineVersions(tx, input.websiteId);
    if (!versions) return null;
    // Indexed source bounds prove empty prefixes and suffixes in this same snapshot.
    const [bounds] = await tx.$queryRawUnsafe<any[]>(
      `SELECT
      (SELECT created_at FROM liekan_log WHERE website_id=$1::uuid ORDER BY created_at LIMIT 1) AS first,
      (SELECT created_at FROM liekan_log WHERE website_id=$1::uuid ORDER BY created_at DESC LIMIT 1) AS last`,
      input.websiteId,
    );
    const first = new Date(
      Math.max(+window.first, Math.floor(+new Date(bounds.first) / 3600000) * 3600000),
    );
    const last = new Date(
      Math.min(+window.last, Math.floor(+new Date(bounds.last) / 3600000) * 3600000),
    );
    const expected =
      bounds.first && bounds.last ? Math.max(0, Math.round((+last - +first) / 3600000) + 1) : 0;
    const units = await tx.$queryRawUnsafe<any[]>(
      `SELECT u.generation,u.row_count::text FROM liekan_analytics_engine_unit u
      WHERE u.website_id=$1::uuid AND u.bucket>=$2 AND u.bucket<=$3 AND u.generation IS NOT NULL
      AND u.active_epoch=$4::bigint AND u.versions=$5::jsonb AND u.verified_at IS NOT NULL
      AND u.fingerprint=liekan_engine_fingerprint(u.website_id,u.bucket) ORDER BY u.bucket`,
      input.websiteId,
      first,
      last,
      String(state.epoch),
      JSON.stringify(versions),
    );
    if (units.length !== expected) return null;
    const params = {
      site: input.websiteId,
      installation: state.installation_id,
      generations: units.map(u => u.generation),
      start: input.startDate.toISOString(),
      end: input.endDate.toISOString(),
      timezone,
    };
    const identity = input.crawlerIdentityScope || 'all';
    const scope = `SELECT * FROM ${ENGINE_TABLE} WHERE installation_id={installation:UUID} AND website_id={site:UUID} AND generation IN {generations:Array(UUID)}
      AND created_at>=parseDateTime64BestEffort({start:String},6) AND created_at${input.crawlerMetricsVersion === 1 ? '<' : '<='}parseDateTime64BestEffort({end:String},6)
      ${input.crawlerMetricsVersion === 1 ? 'AND self_check=0' : ''}
      ${identity === 'verified_range' ? "AND verification='verified_range'" : identity === 'verified_identity' ? "AND verification IN ('verified_range','verified_dns','verified_edge')" : ''}`;
    try {
      const counts = await engineQuery<{ generation: string; count: number }>(
        `SELECT generation,count() AS count FROM ${ENGINE_TABLE}
        WHERE installation_id={installation:UUID} AND website_id={site:UUID} AND generation IN {generations:Array(UUID)} GROUP BY generation`,
        params,
      );
      const actual = new Map(counts.map(row => [row.generation, String(row.count)]));
      const missing = units
        .filter(unit => (actual.get(unit.generation) || '0') !== unit.row_count)
        .map(unit => unit.generation);
      if (missing.length) {
        await analysisTransaction(t =>
          t.$executeRawUnsafe(
            `UPDATE liekan_analytics_engine_unit SET verified_at=NULL,
          error_code='engine-projection-lost',attempts=0,retry_at=NULL WHERE website_id=$1::uuid AND generation=ANY($2::uuid[])`,
            input.websiteId,
            missing,
          ),
        );
        return null;
      }
      return await load(scope, params, units.length);
    } catch {
      // A query budget or predicate failure stays local to this request.
      try {
        await engineQuery('SELECT 1 AS ready');
      } catch {
        await analysisTransaction(t =>
          t.$executeRawUnsafe(
            "UPDATE liekan_analytics_engine SET healthy=false,error_code='engine-connection-failed' WHERE id=1 AND connection_hash=$1",
            config.key,
          ),
        ).catch(() => {});
      }
      return null;
    }
  };
  const tx = getQuerySnapshot();
  return tx ? work(tx as AnalysisTx) : analysisTransaction(work, 'RepeatableRead');
}

export async function readClickHouseLogRollup(
  input: AnalysisLogInput,
): Promise<AnalysisLogResult | null> {
  return readEngine(input, async (scope, params, units) => {
    const filters = input.filters || {};
    const resource = filters.resource || '';
    const withForms = ['ai/bots', 'ai/pages'].includes(String(resource));
    const formConditions: string[] = [];
    if (withForms && filters.botProductForm) {
      formConditions.push('product_form={form:String}');
      params.form = filters.botProductForm;
    }
    if (withForms && filters.botCategory === 'other')
      formConditions.push(
        "bot_type NOT IN ('训练','搜索','用户触发','传统搜索') AND coalesce(product_form,'unknown') NOT IN ('workbench','personal_agent')",
      );
    const forms = formConditions.length ? ` AND ${formConditions.join(' AND ')}` : '';
    const pageConditions: string[] = [];
    if (resource === 'ai/pages') {
      for (const [key, column] of [
        ['botType', 'bot_type'],
        ['botId', 'crawler_id'],
      ] as const)
        if (filters[key]) {
          params[key] = filters[key];
          pageConditions.push(`${column}={${key}:String}`);
        }
      if (!filters.botId && filters.botName) {
        params.botName = filters.botName;
        pageConditions.push('isNull(crawler_id) AND bot={botName:String}');
      }
    }
    const pagesFilter = pageConditions.length ? ` AND ${pageConditions.join(' AND ')}` : '';
    const queries: Record<string, string> = {
      summary: `SELECT count() AS requests,countIf(${chAi}) AS ai,uniqExactIf(path,${chAi}) AS pages,
        countIf(status>=400) AS abnormal,uniqExact(coalesce(classification_version,'legacy')) AS classificationVersions,
        countIf(isNull(ai_eligible)) AS legacyRequests,countIf(${chUnknown}) AS unclassifiedRequests FROM scope`,
      daily: `SELECT formatDateTime(created_at,'%Y-%m-%d',{timezone:String}) AS day,bot,vendor,crawler_id AS botId,
        count() AS count,countIf(${chAi}) AS aiRequests FROM scope WHERE NOT ${chUnknown}
        GROUP BY day,bot,vendor,botId ORDER BY day,bot,vendor,botId`,
      bots: `SELECT bot AS name,vendor,bot_type AS type,crawler_id AS botId,
        ${withForms ? "arrayStringConcat(arraySort(groupUniqArray(coalesce(product_form,'unknown'))),',') AS productForm," : ''}
        count() AS requests,countIf(${chAi}) AS aiRequests,uniqExact(path) AS pages,max(created_at) AS lastVisit
        FROM scope WHERE NOT ${chUnknown}${forms} GROUP BY name,vendor,type,botId ORDER BY requests DESC,name,botId`,
      pages: `SELECT path,bot,crawler_id AS botId,count() AS requests,max(created_at) AS lastCrawled FROM scope
        WHERE ${chAi}${withForms ? ` AND NOT ${chUnknown}${forms}` : ''}${pagesFilter}
        GROUP BY path,bot,botId ORDER BY requests DESC,path,bot,botId`,
      statuses: `SELECT intDiv(status,100)*100 AS status,count() AS count FROM scope WHERE ${chAi} GROUP BY status ORDER BY status`,
      hours: `SELECT toHour(toTimeZone(created_at,{timezone:String})) AS hour,count() AS count FROM scope WHERE ${chAi} GROUP BY hour ORDER BY hour`,
    };
    const result: any = { coverage: { manifests: units, rawFallback: false } };
    for (const [field, sql] of Object.entries(queries)) {
      if (input.fields && !input.fields.includes(field)) continue;
      const rows = await engineQuery(`WITH scope AS (${scope}) ${sql}`, params);
      for (const row of rows)
        for (const key of [
          'requests',
          'ai',
          'pages',
          'abnormal',
          'classificationVersions',
          'legacyRequests',
          'unclassifiedRequests',
          'count',
          'aiRequests',
        ])
          if (key in row) row[key] = analysisSafeNumber(row[key]);
      for (const row of rows)
        for (const key of ['lastVisit', 'lastCrawled'])
          if (row[key]) row[key] = new Date(row[key]).toISOString();
      result[field] = field === 'summary' ? rows[0] : rows;
    }
    return result as AnalysisLogResult;
  });
}
export async function readClickHouseLogSeries(
  input: AnalysisLogInput & { grain: 'hour' | 'day' | 'month' },
) {
  return readEngine(input, async (scope, params) => {
    const format =
      input.grain === 'hour' ? '%Y-%m-%d %H:00' : input.grain === 'month' ? '%Y-%m' : '%Y-%m-%d';
    const rows = await engineQuery<{
      day: string;
      bot: string;
      type: string;
      count: number;
      aiRequests: number;
    }>(
      `WITH scope AS (${scope}) SELECT formatDateTime(created_at,'${format}',{timezone:String}) AS day,
      bot,bot_type AS type,count() AS count,countIf(${chAi}) AS aiRequests FROM scope GROUP BY day,bot,type ORDER BY day,bot,type`,
      params,
    );
    return rows.map(row => ({
      ...row,
      count: analysisSafeNumber(row.count),
      aiRequests: analysisSafeNumber(row.aiRequests),
    }));
  });
}
