import { getClickHouseCountrySQL } from '@/lib/country';
import { classifyEntrySource } from './analytics';
import { warehouseFeatureSelection, warehouseFeatureQuery } from './warehouse-feature-analytics';
import type { JourneyData } from '../contracts/analysis';

/** Keep a single pipeline through the versioned events. CH expands CTEs at each
 * reference; branching joins here multiply the quality/deletion relation tree. */
export async function warehouseFeatureJourney(
  websiteId: string,
  p: any,
  filters: any,
  nodes?: string[],
): Promise<JourneyData> {
  const { cte, params } = warehouseFeatureSelection(websiteId, filters);
  const details = nodes
    ? `,min(created_at) OVER visit AS visit_first,max(created_at) OVER visit AS visit_last,
    countIf(event_type=1) OVER visit AS visit_views,
    argMin(tuple(created_at,event_id),tuple(created_at,event_id)) OVER visit AS visit_first_key,argMax(tuple(created_at,event_id),tuple(created_at,event_id)) OVER visit AS visit_last_key,
    argMax(tuple(url_path,liekan_country,liekan_region,liekan_city,liekan_browser,liekan_device),tuple(created_at,event_id)) OVER visit AS visit_environment`
    : '';
  const sql = `${cte},annotated AS(SELECT *,coalesce(nullIf(event_name,''),url_path) AS node,
      argMin(tuple(referrer_domain),tuple(created_at,event_id)) OVER visit AS first_source,
      lagInFrame(toNullable(coalesce(nullIf(event_name,''),url_path)),1,NULL) OVER visit AS previous ${details}
      FROM selected WINDOW visit AS(PARTITION BY visit_id ORDER BY created_at,event_id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)),
    deduplicated AS(SELECT * FROM annotated WHERE coalesce(node!=previous,false) OR isNull(node)!=isNull(previous)),
    ordered AS(SELECT *,toInt64(row_number() OVER(PARTITION BY visit_id ORDER BY created_at,event_id)) AS rn FROM deduplicated),
    starts AS(SELECT *,minOrNullIf(rn,{startStep:String}='' OR node={startStep:String}) OVER(PARTITION BY visit_id) AS start_rn FROM ordered),
    bounds AS(SELECT *,if({endStep:String}='',start_rn+{steps:Int64}-1,minOrNullIf(rn,rn>start_rn AND node={endStep:String}) OVER(PARTITION BY visit_id)) AS end_rn FROM starts),
    windowed AS(SELECT * FROM bounds WHERE start_rn IS NOT NULL AND end_rn IS NOT NULL AND end_rn<=start_rn+{steps:Int64}-1 AND rn BETWEEN start_rn AND end_rn),
    eligible AS(SELECT visit_id,session_id,arrayMap(x->x.2,arraySort(x->x.1,groupArray(tuple(rn,node)))) AS nodes,
      (toUnixTimestamp64Micro(max(created_at))-toUnixTimestamp64Micro(min(created_at)))/1000000.0 AS seconds,any(first_source).1 AS source
      ${nodes ? ',any(visit_first) AS visit_first,any(visit_last) AS visit_last,any(visit_views) AS visit_views,any(visit_first_key) AS visit_first_key,any(visit_last_key) AS visit_last_key,any(visit_environment) AS visit_environment' : ''}
      FROM windowed GROUP BY visit_id,session_id HAVING count()>=2)`;
  const run = (query: string, extra: any = {}) =>
    warehouseFeatureQuery(`${sql} ${query}`, {
      ...params,
      steps: p.steps,
      startStep: p.startStep,
      endStep: p.endStep,
      nodes,
      ...extra,
    });
  const total = await run('SELECT uniqExact(session_id) AS visitors FROM eligible');
  const rows =
    await run(`,sources AS(SELECT nodes,source,uniqExactState(session_id) AS visitor_state,count() AS visit_count,sum(seconds) AS duration FROM eligible
      ${nodes ? 'WHERE nodes={nodes:Array(String)}' : ''} GROUP BY nodes,source)
    SELECT nodes,uniqExactMerge(visitor_state) AS visitors,sum(visit_count) AS visits,sum(duration)/sum(visit_count) AS seconds,
      argMin(tuple(source),tuple(-toInt64(finalizeAggregation(visitor_state)),isNull(source),coalesce(source,''))).1 AS source FROM sources GROUP BY nodes ORDER BY visitors DESC,nodes LIMIT 101`);
  let sessions: any[], count: number;
  if (nodes) {
    const totals = await run(
      'SELECT uniqExact(session_id) AS count FROM eligible WHERE nodes={nodes:Array(String)}',
    );
    sessions = await run(
      `SELECT session_id AS id,min(visit_first) AS firstAt,max(visit_last) AS lastAt,sum(visit_views) AS views,
      (toUnixTimestamp64Micro(max(visit_last))-toUnixTimestamp64Micro(min(visit_first)))/1000000.0 AS seconds,
      argMax(visit_environment,visit_last_key) AS environment,environment.1 AS urlPath,
      argMin(tuple(source),visit_first_key).1 AS referrerDomain,
      ${getClickHouseCountrySQL('environment.2')} AS country,environment.3 AS region,environment.4 AS city,environment.5 AS browser,environment.6 AS device
      FROM eligible WHERE nodes={nodes:Array(String)} GROUP BY session_id ORDER BY lastAt DESC,session_id LIMIT 25 OFFSET {offset:UInt64}`,
      { offset: (p.page - 1) * 25 },
    );
    sessions = sessions.map(({ environment, ...row }) => row);
    count = totals[0].count;
  }
  return {
    rows: rows
      .slice(0, 100)
      .map(row => ({
        ...row,
        source: row.source ? classifyEntrySource({ referrer: row.source }).source : null,
      })),
    visitors: total[0].visitors,
    sessions,
    count,
    page: p.page,
    pageSize: 25,
    limited: rows.length > 100,
  };
}
