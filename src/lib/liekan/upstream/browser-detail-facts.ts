import { getPostgresCountrySQL, getPostgresRegionSQL } from '@/lib/country';
import { analysisTransaction, findAnalysisVersions } from './analysis-rollups-db';
import {
  ANALYSIS_CHUNK_SIZE,
  type AnalysisBuildRow,
  type AnalysisCheckpoint,
  type AnalysisTx,
} from './analysis-rollups-model';
import { getQuerySnapshot } from './query-snapshot';
import { warehouseEnabled } from '../warehouse/runtime';

export const BROWSER_DETAIL_FORMAT = 'browser-detail-v1';
export const browserDetailFields = new Set([
  'daily',
  'geo',
  'sources',
  'environment',
  'pages',
  'heatmap',
  'newVisitors',
  'goals',
  'converted',
  'dailySources',
  'dailyConversions',
]);
const origin = "timestamptz '2000-01-01Z'";
const floor = (value: string) => `date_bin(interval '5 minutes',${value},${origin})`;
const ceil = (value: string) =>
  `(${floor(value)}+CASE WHEN ${floor(value)}<${value} THEN interval '5 minutes' ELSE interval '0' END)`;
const pv = 'event_type NOT IN(2,5)';
const eventColumns = `e.event_id,e.created_at,e.session_id,e.visit_id,e.event_type,e.url_path,e.event_name,
 e.liekan_country AS country,e.liekan_region AS region,e.liekan_city AS city,
 e.liekan_browser AS browser,e.liekan_os AS os,e.liekan_device AS device,s.created_at AS session_created_at`;

/** Every piece uses the same event ordering as humanVisitsSql, including ties and custom-only pieces. */
function pieces(source: string) {
  const key = 'bucket,session_id,visit_id';
  const point = `jsonb_build_object('at',created_at,'id',event_id,'path',url_path,'type',event_type,'name',event_name,'country',country,'region',region,'city',city)`;
  return `detail_events AS MATERIALIZED (SELECT *,${floor('created_at')} AS bucket FROM ${source} WHERE event_type<>5),
 detail_pairs AS (SELECT DISTINCT session_id,visit_id FROM detail_events),
 detail_entries AS MATERIALIZED (SELECT p.session_id,p.visit_id,anchor.entry FROM detail_pairs p
  LEFT JOIN LATERAL(SELECT jsonb_build_object('referrer',e.referrer_domain,'utmSource',e.utm_source,'utmMedium',e.utm_medium,'utmCampaign',e.utm_campaign) AS entry
   FROM liekan_geographic_website_event e WHERE e.website_id=$1::uuid AND e.session_id=p.session_id AND e.visit_id=p.visit_id
   AND e.event_type NOT IN(2,5) ORDER BY e.created_at,e.event_id LIMIT 1) anchor ON true),
 detail_visits AS MATERIALIZED (SELECT ${key},count(*) FILTER(WHERE ${pv}) AS pageviews,bool_or(event_type=2) AS has_custom,
  (array_agg(${point} ORDER BY created_at,event_id) FILTER(WHERE ${pv}))[1] AS first_pv,
  (array_agg(${point} ORDER BY created_at DESC,event_id DESC) FILTER(WHERE ${pv}))[1] AS last_pv,
  max(browser) AS browser,max(os) AS os,max(device) AS device,max(session_created_at) AS session_created_at
  FROM detail_events GROUP BY ${key}),
 detail_ordered AS (SELECT *,lead(created_at) OVER(PARTITION BY ${key} ORDER BY created_at,event_id) AS next_at FROM detail_events WHERE ${pv}),
 detail_path_events AS (SELECT bucket,session_id,visit_id,url_path AS path,event_type,coalesce(event_name,'') AS event_name,event_name IS NULL AS name_missing,
  count(*) AS events,count(*) FILTER(WHERE ${pv}) AS pageviews,0::float8 AS dwell_total,0::bigint AS dwell_samples
  FROM detail_events GROUP BY 1,2,3,4,5,6,7
  UNION ALL SELECT bucket,session_id,visit_id,url_path,event_type,coalesce(event_name,''),event_name IS NULL,0,0,
   coalesce(sum(extract(epoch FROM next_at-created_at)),0)::float8,count(next_at)
   FROM detail_ordered GROUP BY 1,2,3,4,5,6,7),
 detail_paths AS MATERIALIZED (SELECT bucket,session_id,visit_id,path,event_type,event_name,name_missing,
  sum(events)::bigint AS events,sum(pageviews)::bigint AS pageviews,sum(dwell_total)::float8 AS dwell_total,sum(dwell_samples)::bigint AS dwell_samples
  FROM detail_path_events GROUP BY 1,2,3,4,5,6,7)`;
}

/** Called beside visitChunk, before its generation accounting, inside the same transaction. */
export async function buildBrowserDetailChunk(
  tx: AnalysisTx,
  row: AnalysisBuildRow,
  state: AnalysisCheckpoint,
) {
  const [result] = await tx.$queryRawUnsafe<{ bytes: string }[]>(
    `WITH chunk AS MATERIALIZED (SELECT ${eventColumns} FROM liekan_geographic_website_event e
     LEFT JOIN liekan_effective_session s ON s.session_id=e.session_id AND s.website_id=e.website_id
     WHERE e.website_id=$1::uuid AND e.created_at>=$3::timestamptz AND e.created_at<$4::timestamptz
     AND ($5::timestamptz IS NULL OR (e.created_at,e.event_id)>($5::timestamptz,$6::uuid))
     ORDER BY e.created_at,e.event_id LIMIT $7), ${pieces('chunk')},
    previous AS MATERIALIZED (SELECT old.* FROM liekan_analysis_browser_visit old JOIN detail_visits n USING(bucket,session_id,visit_id)
     WHERE old.website_id=$1::uuid AND old.generation=$2::uuid),
    visits AS (INSERT INTO liekan_analysis_browser_visit(website_id,generation,bucket,session_id,visit_id,pageviews,has_custom,first_pv,last_pv,entry,browser,os,device,session_created_at)
     SELECT $1::uuid,$2::uuid,n.bucket,n.session_id,n.visit_id,n.pageviews,n.has_custom,n.first_pv,n.last_pv,e.entry,n.browser,n.os,n.device,n.session_created_at
     FROM detail_visits n LEFT JOIN detail_entries e USING(session_id,visit_id)
     ON CONFLICT(website_id,generation,bucket,session_id,visit_id) DO UPDATE SET
      pageviews=liekan_analysis_browser_visit.pageviews+EXCLUDED.pageviews,has_custom=liekan_analysis_browser_visit.has_custom OR EXCLUDED.has_custom,
      first_pv=coalesce(liekan_analysis_browser_visit.first_pv,EXCLUDED.first_pv),last_pv=coalesce(EXCLUDED.last_pv,liekan_analysis_browser_visit.last_pv),
      entry=EXCLUDED.entry,browser=greatest(liekan_analysis_browser_visit.browser,EXCLUDED.browser),os=greatest(liekan_analysis_browser_visit.os,EXCLUDED.os),
      device=greatest(liekan_analysis_browser_visit.device,EXCLUDED.device),session_created_at=EXCLUDED.session_created_at,updated_at=clock_timestamp()
     RETURNING pg_column_size(liekan_analysis_browser_visit)*2 AS bytes),
    additions AS (SELECT * FROM detail_paths UNION ALL
     SELECT n.bucket,n.session_id,n.visit_id,o.last_pv->>'path',(o.last_pv->>'type')::int,coalesce(o.last_pv->>'name',''),o.last_pv->>'name' IS NULL,
      0,0,extract(epoch FROM (n.first_pv->>'at')::timestamptz-(o.last_pv->>'at')::timestamptz)::float8,1
      FROM detail_visits n JOIN previous o USING(bucket,session_id,visit_id) WHERE n.first_pv IS NOT NULL AND o.last_pv IS NOT NULL),
    paths AS (INSERT INTO liekan_analysis_browser_path(website_id,generation,bucket,session_id,visit_id,path,event_type,event_name,name_missing,events,pageviews,dwell_total,dwell_samples)
     SELECT $1::uuid,$2::uuid,bucket,session_id,visit_id,path,event_type,event_name,name_missing,sum(events),sum(pageviews),sum(dwell_total),sum(dwell_samples)
     FROM additions GROUP BY bucket,session_id,visit_id,path,event_type,event_name,name_missing
     ON CONFLICT(website_id,generation,bucket,session_id,visit_id,path,event_type,event_name,name_missing) DO UPDATE SET
      events=liekan_analysis_browser_path.events+EXCLUDED.events,pageviews=liekan_analysis_browser_path.pageviews+EXCLUDED.pageviews,
      dwell_total=liekan_analysis_browser_path.dwell_total+EXCLUDED.dwell_total,dwell_samples=liekan_analysis_browser_path.dwell_samples+EXCLUDED.dwell_samples,updated_at=clock_timestamp()
     RETURNING pg_column_size(liekan_analysis_browser_path)*2 AS bytes),
    proof AS (INSERT INTO liekan_analysis_browser_detail(website_id,generation,format,complete)
     VALUES($1::uuid,$2::uuid,$8,(SELECT count(*)<$7 FROM chunk)) ON CONFLICT(website_id,generation) DO UPDATE SET complete=EXCLUDED.complete
     RETURNING pg_column_size(liekan_analysis_browser_detail)*2 AS bytes)
    SELECT coalesce(sum(bytes),0)::text AS bytes FROM (SELECT bytes FROM visits UNION ALL SELECT bytes FROM paths UNION ALL SELECT bytes FROM proof) sizes`,
    row.website_id,
    state.generation,
    state.hour,
    state.spanEnd,
    state.afterTime || null,
    state.afterId || '00000000-0000-0000-0000-000000000000',
    state.chunkSize || ANALYSIS_CHUNK_SIZE,
    BROWSER_DETAIL_FORMAT,
  );
  return result;
}

function supportedTimezone(timezone: string, start: Date, end: Date) {
  try {
    const format = new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    return [start, end].every(at => {
      const offset = format.formatToParts(at).find(p => p.type === 'timeZoneName')?.value;
      const match = offset?.match(/[+-](\d\d):(\d\d)(?::(\d\d))?/);
      return !match || (Number(match[2]) % 5 === 0 && Number(match[3] || 0) === 0);
    });
  } catch {
    return false;
  }
}

/** Disjoint proved five-minute facts and raw gaps retain exact identities and boundary dwell. */
export async function readBrowserDetailFacts(
  id: string,
  start: Date,
  end: Date,
  timezone: string,
  fields: readonly string[],
  options: {
    hour?: boolean;
    halfOpen?: boolean;
    geographyReadLimit?: { rows: number; bytes: number };
  } = {},
) {
  if(warehouseEnabled())return (await import('./warehouse-browser-queries')).warehouseBrowserFacts(id,start,end,timezone,fields,options);
  if (
    process.env.CLICKHOUSE_URL ||
    !Number.isFinite(+start) ||
    !Number.isFinite(+end) ||
    +end < +start ||
    !supportedTimezone(timezone, start, end)
  )
    return null;
  const wanted = fields.filter(field => browserDetailFields.has(field));
  if (!wanted.length) return null;
  const load = async (tx: AnalysisTx) => {
    const versions = await findAnalysisVersions(tx, id);
    if (!versions) return null;
    const [has] = await tx.$queryRawUnsafe<{ available: boolean }[]>(
      `SELECT EXISTS(SELECT 1 FROM liekan_analysis_manifest m JOIN liekan_analysis_site s USING(website_id,epoch)
       JOIN liekan_analysis_browser_detail d USING(website_id,generation)
       WHERE m.website_id=$1::uuid AND m.family='visit' AND s.mode='live' AND d.complete AND d.format=$4
       AND m.bucket<$3::timestamptz AND m.bucket_end>$2::timestamptz) AS available`,
      id,
      start,
      end,
      BROWSER_DETAIL_FORMAT,
    );
    if (!has.available) return null;
    const endSql = `$3::timestamptz${options.halfOpen ? '' : "+interval '1 microsecond'"}`;
    const bin = options.hour ? 'YYYY-MM-DD HH24:00' : 'YYYY-MM-DD';
    const metrics = `count(*)::int AS sessions,sum(v.pv)::int AS pv,avg(v.duration)::float AS duration,
      count(*) FILTER(WHERE v.pv=1 AND NOT v.custom)::int AS bounces,count(*) FILTER(WHERE v.converted)::int AS conversions`;
    const statements: Record<string, string> = {
      daily: `WITH eb AS(SELECT to_char(bucket AT TIME ZONE $4,'${bin}') AS day,count(DISTINCT session_id)::int AS uv,sum(pageviews)::int AS pv FROM visit_pieces WHERE pageviews>0 GROUP BY 1),
       vb AS(SELECT to_char(started AT TIME ZONE $4,'${bin}') AS day,count(*)::int AS sessions,avg(duration)::float AS duration,count(*) FILTER(WHERE pv=1 AND NOT custom)::int AS bounces,count(*) FILTER(WHERE converted)::int AS conversions FROM visits GROUP BY 1)
       SELECT e.day,e.uv,e.pv,coalesce(v.sessions,0)::int AS sessions,v.duration,coalesce(v.bounces,0)::int AS bounces,coalesce(v.conversions,0)::int AS conversions FROM eb e LEFT JOIN vb v USING(day) ORDER BY e.day`,
      geo: `SELECT ${getPostgresCountrySQL('v.country')} AS country,${getPostgresRegionSQL('v.country', 'v.region')} AS region,v.city,sum(v.duration)::float AS "durationTotal",count(v.duration)::int AS "durationSamples",${metrics} FROM visits v GROUP BY 1,2,3 ORDER BY sessions DESC,1,2,3`,
      sources: `SELECT v.referrer,v."utmSource",v."utmMedium",v."utmCampaign",${metrics} FROM visits v GROUP BY 1,2,3,4 ORDER BY sessions DESC,1,2,3,4`,
      environment:
        'SELECT device,browser,os,count(*)::int AS sessions FROM visits GROUP BY 1,2,3 ORDER BY sessions DESC,1,2,3',
      pages: `WITH p AS(SELECT path,sum(pageviews)::int AS pv,count(DISTINCT session_id) FILTER(WHERE pageviews>0)::int AS uv,sum(dwell_total)::float8 AS dwell_total,sum(dwell_samples)::bigint AS samples FROM paths GROUP BY path HAVING sum(pageviews)>0),
       entries AS(SELECT first_pv->>'path' AS path,count(*)::int AS entries,count(*) FILTER(WHERE pv=1 AND NOT custom)::int AS bounces FROM visits GROUP BY 1)
       SELECT p.path,p.pv,p.uv,coalesce(e.entries,0)::int AS entries,CASE WHEN p.samples>0 THEN p.dwell_total/p.samples ELSE NULL END::float8 AS duration,p.samples::int AS samples,coalesce(e.bounces,0)::int AS bounces FROM p LEFT JOIN entries e USING(path) ORDER BY p.pv DESC,p.path`,
      heatmap:
        'SELECT extract(dow FROM started AT TIME ZONE $4)::int AS weekday,extract(hour FROM started AT TIME ZONE $4)::int AS hour,count(*)::int AS count FROM visits GROUP BY 1,2 ORDER BY 1,2',
      newVisitors: `SELECT count(DISTINCT session_id)::int AS count FROM visits WHERE session_created_at>=$2::timestamptz AND session_created_at${options.halfOpen ? '<' : '<='}$3::timestamptz`,
      dailySources:
        'SELECT to_char(started AT TIME ZONE $4,\'YYYY-MM-DD\') AS day,referrer,"utmSource","utmMedium","utmCampaign",count(*)::int AS count FROM visits GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5',
      converted:
        'SELECT count(*)::int AS count,(SELECT coalesce(sum(events),0)::int FROM matching_events) AS events FROM visits WHERE converted',
      dailyConversions:
        "SELECT to_char(bucket AT TIME ZONE $4,'YYYY-MM-DD') AS day,sum(events)::int AS count FROM matching_events GROUP BY 1 ORDER BY 1",
      goals: `SELECT d.report_id AS id,d.name,d.parameters->>'value' AS path,coalesce(sum(p.events),0)::int AS count,count(DISTINCT (p.visit_id,p.session_id)) FILTER(WHERE v.visit_id IS NOT NULL)::int AS "convertedSessions"
       FROM definitions d LEFT JOIN paths p ON ${goalMatch('d', 'p')} LEFT JOIN visits v USING(visit_id,session_id) GROUP BY 1,2,3`,
    };
    const selected = wanted;
    if (!selected.length) return null;
    const geographyLimit = selected.includes('geo') && options.geographyReadLimit;
    const projections = selected.map(field => {
      if (field === 'geo' && geographyLimit)
        return `'geo',(SELECT CASE WHEN count(*)>$7::int OR coalesce(sum(octet_length(to_jsonb(fact)::text)),0)>$8::bigint THEN '{"limitExceeded":true}'::jsonb
         ELSE coalesce(jsonb_agg(to_jsonb(fact)),'[]'::jsonb) END FROM (${statements.geo} LIMIT ($7::int+1)) fact)`;
      return `'${field}',(SELECT coalesce(jsonb_agg(to_jsonb(fact)),'[]'::jsonb) FROM (${statements[field]}) fact)`;
    });
    // Expanded policy views can trigger seconds of LLVM compilation for millisecond detail reads.
    // Keep this execution policy local to the current reporting transaction.
    await tx.$executeRawUnsafe('SET LOCAL jit=off');
    const [row] = await tx.$queryRawUnsafe<{ facts: Record<string, any[]> }[]>(
      `WITH original_coverage AS MATERIALIZED(SELECT m.* FROM liekan_analysis_manifest m JOIN liekan_analysis_site s USING(website_id,epoch)
       JOIN liekan_analysis_browser_detail d USING(website_id,generation) JOIN website w ON w.website_id=m.website_id AND w.deleted_at IS NULL
       WHERE m.website_id=$1::uuid AND m.family='visit' AND s.mode='live' AND d.complete AND d.format=$6
       AND m.bucket<${endSql} AND m.bucket_end>$2::timestamptz AND m.versions=$5::jsonb
       AND m.fingerprint=liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,m.bucket,m.bucket_end)),
      clipped AS(SELECT *,CASE WHEN row_count=0 THEN greatest(bucket,$2::timestamptz) ELSE greatest(${ceil('bucket')},${ceil('$2::timestamptz')}) END AS starts,
       CASE WHEN row_count=0 THEN least(bucket_end,${endSql}) ELSE least(${floor('bucket_end')},${floor(endSql)}) END AS ends FROM original_coverage),
      covered AS MATERIALIZED(SELECT * FROM clipped WHERE starts<ends),
      raw_gaps AS MATERIALIZED(SELECT lower(gap) AS starts,upper(gap) AS ends FROM (SELECT unnest(tstzmultirange(tstzrange($2::timestamptz,${endSql},'[)'))-
       coalesce(range_agg(tstzrange(starts,ends,'[)')),'{}'::tstzmultirange)) AS gap FROM covered) gaps),
      raw_chunk AS MATERIALIZED(SELECT r.* FROM raw_gaps g CROSS JOIN LATERAL(SELECT ${eventColumns} FROM liekan_geographic_website_event e
       LEFT JOIN liekan_effective_session s ON s.website_id=e.website_id AND s.session_id=e.session_id
       WHERE e.website_id=$1::uuid AND e.created_at>=g.starts AND e.created_at<g.ends OFFSET 0) r),${pieces('raw_chunk')},
      visit_pieces AS MATERIALIZED(SELECT f.bucket,f.session_id,f.visit_id,f.pageviews,f.has_custom,f.first_pv,f.last_pv,f.entry,f.browser,f.os,f.device,f.session_created_at
       FROM covered c JOIN liekan_analysis_browser_visit f ON f.website_id=c.website_id AND f.generation=c.generation AND f.bucket>=c.starts AND f.bucket<c.ends
       UNION ALL SELECT n.bucket,n.session_id,n.visit_id,n.pageviews,n.has_custom,n.first_pv,n.last_pv,e.entry,n.browser,n.os,n.device,n.session_created_at FROM detail_visits n LEFT JOIN detail_entries e USING(session_id,visit_id)),
      path_pieces AS MATERIALIZED(SELECT f.bucket,f.session_id,f.visit_id,f.path,f.event_type,f.event_name,f.name_missing,f.events,f.pageviews,f.dwell_total,f.dwell_samples
       FROM covered c JOIN liekan_analysis_browser_path f ON f.website_id=c.website_id AND f.generation=c.generation AND f.bucket>=c.starts AND f.bucket<c.ends
       UNION ALL SELECT * FROM detail_paths),
      boundaries AS(SELECT *,lead(first_pv) OVER(PARTITION BY session_id,visit_id ORDER BY (first_pv->>'at')::timestamptz,(first_pv->>'id')::uuid) AS next_pv FROM visit_pieces WHERE pageviews>0),
      paths AS MATERIALIZED(SELECT * FROM path_pieces UNION ALL SELECT bucket,session_id,visit_id,last_pv->>'path',(last_pv->>'type')::int,coalesce(last_pv->>'name',''),last_pv->>'name' IS NULL,0,0,
       extract(epoch FROM (next_pv->>'at')::timestamptz-(last_pv->>'at')::timestamptz)::float8,1 FROM boundaries WHERE next_pv IS NOT NULL),
      definitions AS(SELECT report_id,name,parameters FROM report WHERE website_id=$1::uuid AND type='goal'),
      matching_events AS MATERIALIZED(SELECT p.* FROM path_pieces p WHERE EXISTS(SELECT 1 FROM definitions d WHERE ${goalMatch('d', 'p')})),
      merged AS(SELECT session_id,visit_id,sum(pageviews)::bigint AS pv,bool_or(has_custom) AS custom,
       (array_agg(first_pv ORDER BY (first_pv->>'at')::timestamptz,(first_pv->>'id')::uuid) FILTER(WHERE first_pv IS NOT NULL))[1] AS first_pv,
       (array_agg(last_pv ORDER BY (last_pv->>'at')::timestamptz DESC,(last_pv->>'id')::uuid DESC) FILTER(WHERE last_pv IS NOT NULL))[1] AS last_pv,
       (array_agg(entry ORDER BY bucket))[1] AS entry,max(browser) AS browser,max(os) AS os,max(device) AS device,max(session_created_at) AS session_created_at
       FROM visit_pieces GROUP BY session_id,visit_id HAVING sum(pageviews)>0),
      visits AS MATERIALIZED(SELECT m.*,(first_pv->>'at')::timestamptz AS started,
       extract(epoch FROM (last_pv->>'at')::timestamptz-(first_pv->>'at')::timestamptz)::float8 AS duration,
       first_pv->>'country' AS country,first_pv->>'region' AS region,first_pv->>'city' AS city,entry->>'referrer' AS referrer,
       entry->>'utmSource' AS "utmSource",entry->>'utmMedium' AS "utmMedium",entry->>'utmCampaign' AS "utmCampaign",
       EXISTS(SELECT 1 FROM matching_events p WHERE p.session_id=m.session_id AND p.visit_id=m.visit_id) AS converted FROM merged m)
      SELECT jsonb_build_object(${projections.join(',')}) AS facts FROM (SELECT $4::text AS timezone) parameter_types`,
      id,
      start,
      end,
      timezone,
      JSON.stringify(versions),
      BROWSER_DETAIL_FORMAT,
      ...(geographyLimit ? [geographyLimit.rows, geographyLimit.bytes] : []),
    );
    return row.facts;
  };
  const snapshot = getQuerySnapshot();
  return snapshot ? load(snapshot as AnalysisTx) : analysisTransaction(load, 'RepeatableRead');
}

function goalMatch(definition: string, event: string) {
  const value = `${definition}.parameters->>'value'`;
  const matches = (field: string) =>
    `CASE WHEN left(${value},1)='*' OR right(${value},1)='*' THEN ${field} LIKE regexp_replace(regexp_replace(${value},'^[*]','%'),'[*]$','%') ELSE ${field}=${value} END`;
  return `((${definition}.parameters->>'type'='path' AND ${event}.event_type=1 AND ${matches(`${event}.path`)}) OR
   (${definition}.parameters->>'type'!='path' AND ${event}.event_type=2 AND NOT ${event}.name_missing AND ${matches(`${event}.event_name`)}))`;
}
