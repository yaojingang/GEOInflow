import { getClickHouseCountrySQL, getClickHouseRegionSQL } from '@/lib/country';
import { identityUsable, unavailableFields } from '../contracts/browser-population';
import { warehouseTime } from '../warehouse/fact-input';
import { geographicEventRelation } from '../warehouse/reporting-relations';
import { warehouseBrowserPopulation } from './warehouse-browser-population';
import {
  warehouseReportMetadata,
  warehouseReportQuery,
  withinWarehouseReport,
} from './warehouse-report-snapshot';

export async function warehouseBrowserParameters(
  id: string,
  start: Date,
  end: Date,
  timezone: string,
) {
  const metadata = await warehouseReportMetadata(id);
  const definitions = metadata.reports.filter(
    d =>
      d.type === 'goal' &&
      typeof d.parameters?.value === 'string' &&
      typeof d.parameters?.type === 'string',
  );
  return {
    start: warehouseTime(start),
    end: warehouseTime(end),
    timezone: Intl.DateTimeFormat(undefined, { timeZone: timezone }).resolvedOptions().timeZone,
    goalIds: definitions.map(d => d.id),
    goalNames: definitions.map(d => d.name),
    goalTypes: definitions.map(d => d.parameters.type),
    goalValues: definitions.map(d => d.parameters.value),
  };
}
export function warehouseVisitsSQL(halfOpen = false) {
  return `WITH all_events AS ${geographicEventRelation()},
    attributed AS (SELECT *,argMinIf(tuple(referrer_domain,utm_source,utm_medium,utm_campaign,referrer_path,referrer_query,utm_term),tuple(created_at,event_id),event_type NOT IN(2,5))
      OVER(PARTITION BY session_id,visit_id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS entry
      FROM all_events WHERE created_at<={end:DateTime64(6,'UTC')}),
    events AS (SELECT *,arrayMap(g->g.1,arrayFilter(g ->
      ((g.2='path' AND event_type=1) OR (g.2!='path' AND event_type=2)) AND
      if(startsWith(g.3,'*') OR endsWith(g.3,'*'),if(g.2='path',url_path,event_name) LIKE replaceRegexpOne(replaceRegexpOne(g.3,'^[*]','%'),'[*]$','%'),if(g.2='path',url_path,event_name)=g.3),
      arrayZip({goalIds:Array(UUID)},{goalTypes:Array(String)},{goalValues:Array(String)}))) AS matched_goals
      FROM attributed WHERE created_at>={start:DateTime64(6,'UTC')} AND created_at${halfOpen ? '<' : '<='}{end:DateTime64(6,'UTC')} AND event_type!=5),
    window_events AS (SELECT *,countIf(event_type NOT IN(2,5)) OVER visit AS visit_pv,countIf(event_type=2) OVER visit AS visit_custom,
      tupleElement(argMinIf(tuple(event_id),tuple(created_at,event_id),event_type NOT IN(2,5)) OVER visit,1) AS visit_first,
      minIf(created_at,event_type NOT IN(2,5)) OVER visit AS visit_started,
      (maxIf(toUnixTimestamp64Micro(created_at),event_type NOT IN(2,5)) OVER visit-minIf(toUnixTimestamp64Micro(created_at),event_type NOT IN(2,5)) OVER visit)/1000000.0 AS visit_duration,
      max(liekan_browser) OVER visit AS visit_browser,max(liekan_os) OVER visit AS visit_os,max(liekan_device) OVER visit AS visit_device,
      countIf(notEmpty(matched_goals)) OVER visit>0 AS visit_converted
      FROM events WINDOW visit AS (PARTITION BY session_id,visit_id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)),
    visits AS (SELECT session_id,visit_id,visit_pv AS pv,visit_custom AS custom,visit_started AS started,visit_duration AS duration,
      visit_browser AS browser,visit_os AS os,visit_device AS device,liekan_country AS country,liekan_region AS region,liekan_city AS city,
      entry.1 AS referrer,entry.2 AS utmSource,entry.3 AS utmMedium,entry.4 AS utmCampaign,entry.5 AS referrerPath,entry.6 AS referrerQuery,entry.7 AS utmTerm,
      visit_converted AS converted,liekan_session_created_at AS session_created_at
      FROM window_events WHERE event_type NOT IN(2,5) AND event_id=visit_first),
    definitions AS (SELECT g.1 AS report_id,g.2 AS name,g.3 AS type,g.4 AS value FROM (SELECT arrayJoin(arrayZip({goalIds:Array(UUID)},{goalNames:Array(String)},{goalTypes:Array(String)},{goalValues:Array(String)})) AS g)),
    matches AS (SELECT arrayJoin(matched_goals) AS report_id,event_id,created_at,visit_id,session_id,visit_pv FROM window_events)`;
}
const metrics = `count() AS sessions,sum(v.pv) AS pv,avgOrNull(v.duration) AS duration,countIf(v.pv=1 AND v.custom=0) AS bounces,countIf(v.converted) AS conversions`;
export function browserBinsSQL(hour = false) {
  const format = hour ? '%Y-%m-%d %H:00' : '%Y-%m-%d';
  return ` SELECT formatDateTime(created_at,'${format}',{timezone:String}) AS day,uniqExact(session_id) AS uv,count() AS pv,
    countIf(event_id=visit_first) AS sessions,avgOrNullIf(visit_duration,event_id=visit_first) AS duration,
    countIf(event_id=visit_first AND visit_pv=1 AND visit_custom=0) AS bounces,countIf(event_id=visit_first AND visit_converted) AS conversions
    FROM window_events WHERE event_type NOT IN(2,5) GROUP BY day ORDER BY day`;
}
const integerFields = new Set([
  'sessions',
  'pv',
  'uv',
  'bounces',
  'conversions',
  'count',
  'samples',
  'entries',
  'weekday',
  'hour',
  'durationSamples',
  'convertedSessions',
  'events',
  'pageviews',
  'visitors',
  'visits',
]);
const floatFields = new Set(['duration', 'durationTotal', 'totaltime']);
function numbers(rows: any[]) {
  return rows.map(row =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (value === null || (!integerFields.has(key) && !floatFields.has(key)))
          return [key, value];
        const n = Number(value);
        if (!Number.isFinite(n) || (integerFields.has(key) && !Number.isSafeInteger(n)))
          throw new Error('warehouse-counter-out-of-range');
        return [key, n];
      }),
    ),
  );
}
export async function warehouseBrowserFacts(
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
  return withinWarehouseReport(async () => {
    const params = await warehouseBrowserParameters(id, start, end, timezone);
    const statements: Record<string, string> = {
      daily: browserBinsSQL(options.hour),
      geo: ` SELECT ${getClickHouseCountrySQL('v.country')} AS country,${getClickHouseRegionSQL('v.country', 'v.region')} AS region,v.city AS city,sum(v.duration) AS durationTotal,count(v.duration) AS durationSamples,${metrics} FROM visits v GROUP BY country,region,city ORDER BY sessions DESC,country,region,city`,
      sources: ` SELECT v.referrer AS referrer,v.utmSource AS utmSource,v.utmMedium AS utmMedium,v.utmCampaign AS utmCampaign,${metrics} FROM visits v GROUP BY referrer,utmSource,utmMedium,utmCampaign ORDER BY sessions DESC,referrer,utmSource,utmMedium,utmCampaign`,
      environment:
        ' SELECT device,browser,os,count() AS sessions FROM visits GROUP BY device,browser,os ORDER BY sessions DESC,device,browser,os',
      pages: `,ordered AS (SELECT *,row_number() OVER(PARTITION BY visit_id,session_id ORDER BY created_at,event_id) AS ordinal,
        (leadInFrame(toNullable(toUnixTimestamp64Micro(created_at)),1,NULL) OVER(PARTITION BY visit_id,session_id ORDER BY created_at,event_id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)-toUnixTimestamp64Micro(created_at))/1000000.0 AS dwell
        FROM window_events WHERE event_type NOT IN(2,5))
        SELECT e.url_path AS path,count() AS pv,uniqExact(e.session_id) AS uv,countIf(e.ordinal=1) AS entries,avgOrNull(e.dwell) AS duration,count(e.dwell) AS samples,
        countIf(e.ordinal=1 AND e.visit_pv=1 AND e.visit_custom=0) AS bounces FROM ordered e GROUP BY path ORDER BY pv DESC,path`,
      heatmap:
        ' SELECT modulo(toDayOfWeek(toTimeZone(started,{timezone:String})),7) AS weekday,toHour(toTimeZone(started,{timezone:String})) AS hour,count() AS count FROM visits GROUP BY weekday,hour ORDER BY weekday,hour',
      goals:
        ' SELECT d.report_id AS id,d.name AS name,d.value AS path,uniqExact(m.event_id) AS count,uniqExactIf(tuple(m.visit_id,m.session_id),m.visit_pv>0) AS convertedSessions FROM definitions d LEFT JOIN matches m ON m.report_id=d.report_id GROUP BY id,name,path',
      converted:
        ' SELECT countIf(event_type NOT IN(2,5) AND event_id=visit_first AND visit_converted) AS count,countIf(notEmpty(matched_goals)) AS events FROM window_events',
      journeys: `,paths AS (SELECT visit_id,arrayMap(x->x.3,arraySlice(arraySort(x->(x.1,x.2),groupArray(tuple(created_at,event_id,url_path))),1,6)) AS path FROM events WHERE event_type=1 GROUP BY visit_id)
        SELECT arrayStringConcat(path,' → ') AS path,count() AS count FROM paths GROUP BY path ORDER BY count DESC,path LIMIT 6`,
      exits: `,lasts AS (SELECT argMax(url_path,tuple(created_at,event_id)) AS path FROM events WHERE event_type=1 GROUP BY visit_id,session_id) SELECT path,count() AS count FROM lasts GROUP BY path ORDER BY count DESC,path LIMIT 1`,
      dailySources:
        " SELECT formatDateTime(started,'%Y-%m-%d',{timezone:String}) AS day,referrer,utmSource,utmMedium,utmCampaign,count() AS count FROM visits GROUP BY day,referrer,utmSource,utmMedium,utmCampaign ORDER BY day,referrer,utmSource,utmMedium,utmCampaign",
      newVisitors: ` SELECT uniqExact(session_id) AS count FROM visits WHERE session_created_at BETWEEN {start:DateTime64(6,'UTC')} AND {end:DateTime64(6,'UTC')}`,
      dailyConversions:
        " SELECT formatDateTime(created_at,'%Y-%m-%d',{timezone:String}) AS day,uniqExact(event_id) AS count FROM matches GROUP BY day ORDER BY day",
    };
    const result: Record<string, any[]> = {};
    for (const field of fields) {
      const sql = statements[field];
      if (!sql) continue;
      result[field] = numbers(
        await warehouseReportQuery<any>(id, warehouseVisitsSQL(options.halfOpen) + sql, params),
      );
    }
    return result;
  });
}
export async function warehouseBrowserTotals(id: string, start: Date, end: Date, timezone = 'UTC') {
  return withinWarehouseReport(async () => {
    const params = await warehouseBrowserParameters(id, start, end, timezone),
      population = await warehouseBrowserPopulation(id, start, end, timezone);
    const [row] = numbers(
      await warehouseReportQuery<any>(
        id,
        `${warehouseVisitsSQL()} SELECT sum(pv) AS pageviews,uniqExact(session_id) AS visitors,count() AS visits,countIf(pv=1 AND custom=0) AS bounces,coalesce(sum(duration),0) AS totaltime FROM visits`,
        params,
      ),
    );
    return {
      ...(identityUsable(population)
        ? row
        : unavailableFields(row, ['visitors', 'visits', 'bounces', 'totaltime'])),
      population,
    };
  });
}
export async function warehouseBrowserConversions(
  id: string,
  start: Date,
  end: Date,
  timezone = 'UTC',
) {
  return withinWarehouseReport(async () => {
    const params = await warehouseBrowserParameters(id, start, end, timezone);
    return numbers(
      await warehouseReportQuery<any>(
        id,
        `${warehouseVisitsSQL()} SELECT uniqExact(event_id) AS count FROM matches`,
        params,
      ),
    )[0].count;
  });
}
