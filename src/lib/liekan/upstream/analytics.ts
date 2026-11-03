import { applyHumanFactsPopulation } from '../contracts/population-results';
import { identityUsable, unavailableFields } from '../contracts/browser-population';
import { readBrowserPopulation } from './browser-population';
import { nativeSnapshot } from './native-snapshot';
import { funnelParametersSchema } from '@/lib/analytics-schema';
import { getPostgresCountrySQL, getPostgresRegionSQL } from '@/lib/country';
import { getFunnel } from '@/queries/sql';
import { classifyEntrySource, classifyEntrySourceForDisplay } from '../contracts/sources';
import { humanTotals, query, LiekanError } from './server';
import { readBrowserDetailFacts } from './browser-detail-facts';
import { warehouseEnabled } from '../warehouse/runtime';

export { classifyEntrySource } from '../contracts/sources';

export function sourceFacts(rows: any[]) {
  const grouped = new Map<string, any>();
  for (const row of rows) {
    const attribution = classifyEntrySourceForDisplay(row);
    const key = JSON.stringify([
      row.day,
      attribution.source,
      attribution.channel,
      attribution.sourceLabel ?? null,
    ]);
    let group = grouped.get(key);
    if (!group) {
      group = {
        ...attribution,
        ...(row.day ? { day: row.day } : {}),
        sessions: 0,
        pv: 0,
        bounces: 0,
        conversions: 0,
        count: 0,
        duration: 0,
        evidence: new Map<string, Set<string>>(),
      };
      grouped.set(key, group);
    }
    group.duration += (row.duration ?? 0) * (row.sessions ?? 0);
    for (const metric of ['sessions', 'pv', 'bounces', 'conversions', 'count'])
      group[metric] += row[metric] ?? 0;
    for (const field of ['utmSource', 'utmMedium', 'utmCampaign', 'referrer']) {
      if (!group.evidence.has(field)) group.evidence.set(field, new Set());
      if (row[field]) group.evidence.get(field).add(row[field]);
    }
  }
  return [...grouped.values()]
    .map(({ evidence, ...row }) => ({
      ...row,
      duration: row.sessions ? row.duration / row.sessions : 0,
      ...Object.fromEntries(
        [...evidence].map(([field, values]) => [field, [...values].sort().join(' | ') || null]),
      ),
    }))
    .sort((a, b) => b.sessions - a.sessions);
}

// All knowledge of upstream storage and metric semantics is confined here.
export function humanVisitsSql(keywords = false, dimensions = true) {
  return `WITH events AS (SELECT e.event_id,e.website_id,e.session_id,e.visit_id,e.created_at,e.event_type,e.url_path,e.event_name,e.referrer_domain,e.utm_source,e.utm_medium,e.utm_campaign${dimensions ? ',s.country AS country,s.region AS region,s.city AS city,s.browser AS browser,s.os AS os,s.device AS device' : ''} FROM website_event e${dimensions ? '\n  LEFT JOIN session s ON s.session_id=e.session_id AND s.website_id=e.website_id' : ''}
  WHERE e.website_id=$1::uuid AND e.created_at BETWEEN $2::timestamptz AND $3::timestamptz AND e.event_type != 5 AND $4::text IS NOT NULL),
${dimensions ? 'visit_geography AS (SELECT DISTINCT ON (visit_id,session_id) visit_id,session_id,country,region,city FROM events WHERE event_type NOT IN(2,5) ORDER BY visit_id,session_id,created_at,event_id),\n' : ''}visit_totals AS (SELECT visit_id,session_id,count(*) FILTER(WHERE event_type NOT IN(2,5))::int AS pv,
  bool_or(event_type=2)::int AS custom, min(created_at) FILTER(WHERE event_type NOT IN(2,5)) AS started,
  extract(epoch FROM max(created_at) FILTER(WHERE event_type NOT IN(2,5))-min(created_at) FILTER(WHERE event_type NOT IN(2,5)))::float AS duration${dimensions ? ',\n  max(browser) AS browser,max(os) AS os,max(device) AS device' : ''}
  FROM events GROUP BY visit_id,session_id HAVING count(*) FILTER(WHERE event_type NOT IN(2,5))>0),
visits AS (SELECT v.*${dimensions ? ',geography.country,geography.region,geography.city' : ''},entry.referrer_domain AS referrer,entry.utm_source AS "utmSource",entry.utm_medium AS "utmMedium",entry.utm_campaign AS "utmCampaign"${keywords ? ' ,entry.referrer_path AS "referrerPath",entry.referrer_query AS "referrerQuery",entry.utm_term AS "utmTerm"' : ''}
  FROM visit_totals v${dimensions ? ' JOIN visit_geography geography USING(visit_id,session_id)' : ''} LEFT JOIN LATERAL (
    SELECT e.referrer_domain,e.utm_source,e.utm_medium,e.utm_campaign${keywords ? ',e.referrer_path,e.referrer_query,e.utm_term' : ''} FROM website_event e
    WHERE e.website_id=$1::uuid AND e.visit_id=v.visit_id AND e.session_id=v.session_id
      AND e.created_at<=$3::timestamptz AND e.event_type NOT IN(2,5)
    ORDER BY e.created_at,e.event_id LIMIT 1
  ) entry ON true),
definitions AS (SELECT report_id,name,parameters FROM report WHERE website_id=$1::uuid AND type='goal'),
matches AS (SELECT DISTINCT d.report_id,e.event_id,e.created_at,e.visit_id,e.session_id FROM definitions d JOIN events e ON
  ((d.parameters->>'type'='path' AND e.event_type=1 AND CASE WHEN (left(d.parameters->>'value',1)='*' OR right(d.parameters->>'value',1)='*') THEN e.url_path LIKE regexp_replace(regexp_replace(d.parameters->>'value','^[*]','%'),'[*]$','%') ELSE e.url_path=d.parameters->>'value' END) OR
   (d.parameters->>'type'!='path' AND e.event_type=2 AND CASE WHEN (left(d.parameters->>'value',1)='*' OR right(d.parameters->>'value',1)='*') THEN e.event_name LIKE regexp_replace(regexp_replace(d.parameters->>'value','^[*]','%'),'[*]$','%') ELSE e.event_name=d.parameters->>'value' END))),
converted AS (SELECT DISTINCT visit_id,session_id FROM matches)`;
}
const cte = humanVisitsSql();

export const visitMetrics = `count(*)::int AS sessions, sum(v.pv)::int AS pv,
  avg(v.duration)::float AS duration, count(*) FILTER(WHERE v.pv=1 AND v.custom=0)::int AS bounces,
  count(*) FILTER(WHERE cv.visit_id IS NOT NULL)::int AS conversions`;
export const convertedJoin =
  'LEFT JOIN converted cv ON cv.visit_id=v.visit_id AND cv.session_id=v.session_id';
export async function crawlerReferralRows(
  tx: { query<T = any>(sql: string, ...params: unknown[]): Promise<T[]> },
  id: string,
  start: Date,
  end: Date,
  timezone: string,
  options?: { halfOpen?: boolean; hostEvidence?: boolean },
) {
  return tx.query(
    `WITH first_in_window AS MATERIALIZED(
      SELECT DISTINCT ON(e.visit_id,e.session_id) e.visit_id,e.session_id,e.url_path,e.referrer_domain,e.utm_source,e.utm_medium,e.utm_campaign${options?.hostEvidence ? ',q.hostname' : ''}
      FROM website_event e JOIN session s ON s.session_id=e.session_id AND s.website_id=e.website_id
      ${options?.hostEvidence ? 'LEFT JOIN liekan_event_quality q ON q.event_id=e.event_id AND q.website_id=e.website_id' : ''}
      WHERE e.website_id=$1::uuid AND ${options?.halfOpen ? 'e.created_at>=$2::timestamptz AND e.created_at<$3::timestamptz' : 'e.created_at BETWEEN $2::timestamptz AND $3::timestamptz'} AND e.event_type NOT IN(2,5) AND $4::text IS NOT NULL
      ORDER BY e.visit_id,e.session_id,e.created_at,e.event_id
    ),first_before_window AS(
      SELECT DISTINCT ON(e.visit_id,e.session_id) e.visit_id,e.session_id,e.url_path,e.referrer_domain,e.utm_source,e.utm_medium,e.utm_campaign${options?.hostEvidence ? ',q.hostname' : ''}
      FROM website_event e JOIN first_in_window v USING(visit_id,session_id)
      ${options?.hostEvidence ? 'LEFT JOIN liekan_event_quality q ON q.event_id=e.event_id AND q.website_id=e.website_id' : ''}
      WHERE e.website_id=$1::uuid AND e.created_at<$2::timestamptz AND e.event_type NOT IN(2,5)
      ORDER BY e.visit_id,e.session_id,e.created_at,e.event_id
    ),definitions AS(SELECT parameters FROM report WHERE website_id=$1::uuid AND type='goal'),
    goal_counts AS(
      SELECT e.visit_id,e.session_id,count(distinct e.event_id)::int AS events FROM definitions d
      JOIN website_event e ON e.website_id=$1::uuid AND ${options?.halfOpen ? 'e.created_at>=$2::timestamptz AND e.created_at<$3::timestamptz' : 'e.created_at BETWEEN $2::timestamptz AND $3::timestamptz'} AND
        ((d.parameters->>'type'='path' AND e.event_type=1 AND CASE WHEN (left(d.parameters->>'value',1)='*' OR right(d.parameters->>'value',1)='*') THEN e.url_path LIKE regexp_replace(regexp_replace(d.parameters->>'value','^[*]','%'),'[*]$','%') ELSE e.url_path=d.parameters->>'value' END) OR
         (d.parameters->>'type'!='path' AND e.event_type=2 AND CASE WHEN (left(d.parameters->>'value',1)='*' OR right(d.parameters->>'value',1)='*') THEN e.event_name LIKE regexp_replace(regexp_replace(d.parameters->>'value','^[*]','%'),'[*]$','%') ELSE e.event_name=d.parameters->>'value' END))
      JOIN session s ON s.session_id=e.session_id AND s.website_id=e.website_id
      GROUP BY e.visit_id,e.session_id
    ),entries AS(
      SELECT current.visit_id,current.session_id,
        CASE WHEN prior.visit_id IS NOT NULL THEN prior.url_path ELSE current.url_path END AS path,
        CASE WHEN prior.visit_id IS NOT NULL THEN prior.referrer_domain ELSE current.referrer_domain END AS referrer,
        CASE WHEN prior.visit_id IS NOT NULL THEN prior.utm_source ELSE current.utm_source END AS "utmSource",
        CASE WHEN prior.visit_id IS NOT NULL THEN prior.utm_medium ELSE current.utm_medium END AS "utmMedium",
        CASE WHEN prior.visit_id IS NOT NULL THEN prior.utm_campaign ELSE current.utm_campaign END AS "utmCampaign"${options?.hostEvidence ? ',CASE WHEN prior.visit_id IS NOT NULL THEN prior.hostname ELSE current.hostname END AS hostname' : ''}
      FROM first_in_window current LEFT JOIN first_before_window prior USING(visit_id,session_id)
    ) SELECT entry.referrer,entry."utmSource",entry."utmMedium",entry."utmCampaign",entry.path${options?.hostEvidence ? ',entry.hostname' : ''},
      count(*)::int AS visits,count(*) FILTER(WHERE goals.events>0)::int AS conversions,coalesce(sum(goals.events),0)::int AS "goalEvents"
      FROM entries entry LEFT JOIN goal_counts goals USING(visit_id,session_id)
      GROUP BY 1,2,3,4,5${options?.hostEvidence ? ',6' : ''} ORDER BY visits DESC${options ? ' LIMIT 100001' : ''}`,
    id,
    start,
    end,
    timezone,
  );
}
function humanBinsSql(hour = false) {
  const format = hour ? 'YYYY-MM-DD HH24:00' : 'YYYY-MM-DD';
  return `, event_bins AS (SELECT to_char(created_at AT TIME ZONE $4,'${format}') AS day,count(distinct session_id)::int AS uv,count(*)::int AS pv
    FROM events WHERE event_type NOT IN(2,5) GROUP BY 1),
    visit_bins AS (SELECT to_char(v.started AT TIME ZONE $4,'${format}') AS day,count(*)::int AS sessions,avg(v.duration)::float AS duration,
      count(*) FILTER(WHERE v.pv=1 AND v.custom=0)::int AS bounces,count(*) FILTER(WHERE cv.visit_id IS NOT NULL)::int AS conversions
      FROM visits v ${convertedJoin} GROUP BY 1)
    SELECT e.day,e.uv,e.pv,coalesce(v.sessions,0)::int AS sessions,v.duration,coalesce(v.bounces,0)::int AS bounces,coalesce(v.conversions,0)::int AS conversions
    FROM event_bins e LEFT JOIN visit_bins v USING(day) ORDER BY e.day`;
}
export type HumanFact =
  | 'daily'
  | 'geo'
  | 'sources'
  | 'environment'
  | 'pages'
  | 'heatmap'
  | 'goals'
  | 'converted'
  | 'journeys'
  | 'exits'
  | 'dailySources'
  | 'newVisitors'
  | 'dailyConversions'
  | 'previousSources'
  | 'previousGoals'
  | 'funnel';
export async function getHumanFacts(
  id: string,
  start: Date,
  end: Date,
  timezone: string,
  fields?: readonly HumanFact[],
  geographyReadLimit?: { rows: number; bytes: number },
) {
  const args: unknown[] = [id, start, end, timezone];
  const selected = new Set(fields);
  const needs = (field: HumanFact) => !fields || selected.has(field);
  const statements: Record<string, string> = {
    daily: humanBinsSql(),
    geo: ` SELECT ${getPostgresCountrySQL('v.country')} AS country,${getPostgresRegionSQL('v.country', 'v.region')} AS region,v.city,sum(v.duration)::float AS "durationTotal",count(v.duration)::int AS "durationSamples",${visitMetrics} FROM visits v ${convertedJoin} GROUP BY 1,2,3 ORDER BY sessions DESC,1,2,3`,
    sources: ` SELECT v.referrer,v."utmSource",v."utmMedium",v."utmCampaign",${visitMetrics} FROM visits v ${convertedJoin} GROUP BY 1,2,3,4 ORDER BY sessions DESC,1,2,3,4`,
    environment: ` SELECT device,browser,os,count(*)::int AS sessions FROM visits GROUP BY 1,2,3 ORDER BY sessions DESC,1,2,3`,
    pages: `, ordered AS (SELECT *,row_number() OVER(PARTITION BY visit_id,session_id ORDER BY created_at,event_id) AS ordinal,extract(epoch FROM lead(created_at) OVER(PARTITION BY visit_id,session_id ORDER BY created_at,event_id)-created_at)::float AS dwell FROM events WHERE event_type NOT IN(2,5))
      SELECT e.url_path AS path,count(*)::int AS pv,count(distinct e.session_id)::int AS uv,count(*) FILTER(WHERE e.ordinal=1)::int AS entries,avg(e.dwell)::float AS duration,count(e.dwell)::int AS samples,
      count(*) FILTER(WHERE e.ordinal=1 AND v.pv=1 AND v.custom=0)::int AS bounces FROM ordered e JOIN visits v USING(visit_id,session_id) GROUP BY 1 ORDER BY pv DESC,path`,
    heatmap: ` SELECT extract(dow FROM started AT TIME ZONE $4)::int AS weekday,extract(hour FROM started AT TIME ZONE $4)::int AS hour,count(*)::int AS count FROM visits GROUP BY 1,2 ORDER BY 1,2`,
    goals: ` SELECT d.report_id AS id,d.name,d.parameters->>'value' AS path,count(distinct m.event_id)::int AS count,count(distinct (m.visit_id,m.session_id)) FILTER(WHERE v.visit_id IS NOT NULL)::int AS "convertedSessions" FROM definitions d LEFT JOIN matches m USING(report_id) LEFT JOIN visits v ON v.visit_id=m.visit_id AND v.session_id=m.session_id GROUP BY 1,2,3`,
    converted: ` SELECT count(*)::int AS count,(SELECT count(distinct event_id)::int FROM matches) AS events FROM visits v JOIN converted cv USING(visit_id,session_id)`,
    journeys: `, paths AS (SELECT visit_id,(array_agg(url_path ORDER BY created_at,event_id))[1:6] AS path FROM events WHERE event_type=1 GROUP BY visit_id) SELECT array_to_string(path,' → ') AS path,count(*)::int AS count FROM paths GROUP BY 1 ORDER BY count DESC,path LIMIT 6`,
    exits: `, lasts AS (SELECT DISTINCT ON(visit_id,session_id) url_path AS path FROM events WHERE event_type=1 ORDER BY visit_id,session_id,created_at DESC,event_id DESC) SELECT path,count(*)::int AS count FROM lasts GROUP BY 1 ORDER BY count DESC,path LIMIT 1`,
    dailySources: ` SELECT to_char(started AT TIME ZONE $4,'YYYY-MM-DD') AS day,referrer,"utmSource","utmMedium","utmCampaign",count(*)::int AS count FROM visits GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5`,
    newVisitors: ` SELECT count(distinct v.session_id)::int AS count FROM visits v JOIN session s ON s.session_id=v.session_id AND s.website_id=$1::uuid WHERE s.created_at BETWEEN $2 AND $3`,
    dailyConversions: ` SELECT to_char(created_at AT TIME ZONE $4,'YYYY-MM-DD') AS day,count(distinct event_id)::int AS count FROM matches GROUP BY 1 ORDER BY 1`,
  };
  const detail = await readBrowserDetailFacts(
    id,
    start,
    end,
    timezone,
    Object.keys(statements).filter(key => needs(key as HumanFact)),
    { geographyReadLimit },
  );
  const remaining = Object.entries(statements).filter(
    ([key]) => needs(key as HumanFact) && !Object.hasOwn(detail || {}, key),
  );
  // Path projections share one eligible scan with the original date and identity boundaries.
  const currentCte =
    remaining.length && remaining.every(([key]) => key === 'journeys' || key === 'exits')
      ? `WITH events AS MATERIALIZED (SELECT e.event_id,e.session_id,e.visit_id,e.created_at,e.event_type,e.url_path
         FROM liekan_geographic_website_event e
         WHERE e.website_id=$1::uuid AND e.created_at BETWEEN $2::timestamptz AND $3::timestamptz
          AND e.event_type != 5 AND $4::text IS NOT NULL)`
      : cte;
  const projections = remaining.map(([key, tail]) => {
    const select = tail.trimStart().startsWith(',') ? 'WITH ' + tail.trimStart().slice(1) : tail;
    if (key === 'geo' && geographyReadLimit) {
      return `'geo',(SELECT CASE WHEN count(*) > $5::int OR coalesce(sum(octet_length(to_jsonb(fact)::text)),0) > $6::bigint THEN '{"limitExceeded":true}'::jsonb ELSE coalesce(jsonb_agg(to_jsonb(fact)), '[]'::jsonb) END FROM (${select} LIMIT ($5::int + 1)) fact)`;
    }
    return `'${key}',(SELECT coalesce(jsonb_agg(to_jsonb(fact)), '[]'::jsonb) FROM (${select}) fact)`;
  });
  if (geographyReadLimit && needs('geo') && !detail?.geo)
    args.push(geographyReadLimit.rows, geographyReadLimit.bytes);
  const [totals, definitions, current, previousSources, previousGoals] = await Promise.all([
    humanTotals(id, start, end, timezone),
    warehouseEnabled() ? (await import('./warehouse-report-snapshot')).warehouseReportMetadata(id).then(m=>m.reports) : query(
      "SELECT report_id AS id,name,type,parameters FROM report WHERE website_id=$1::uuid AND type IN('goal','funnel') ORDER BY created_at LIMIT 100",
      id,
    ),
    projections.length
      ? query(currentCte + ` SELECT jsonb_build_object(${projections.join(',')}) AS facts`, ...args)
      : Promise.resolve([]),
    needs('previousSources')
      ? (async () => {
          const previousStart = new Date(
            Math.max(0, start.getTime() - (end.getTime() - start.getTime() + 1)),
          );
          const previousEnd = new Date(start.getTime() - 1);
          const previous = await readBrowserDetailFacts(id, previousStart, previousEnd, timezone, [
            'sources',
          ]);
          if (previous)
            return previous.sources.map(
              ({ referrer, utmSource, utmMedium, utmCampaign, sessions, conversions }) => ({
                referrer,
                utmSource,
                utmMedium,
                utmCampaign,
                sessions,
                conversions,
              }),
            );
          return query(
            cte +
              ` SELECT v.referrer,v."utmSource",v."utmMedium",v."utmCampaign",count(*)::int AS sessions,count(*) FILTER(WHERE cv.visit_id IS NOT NULL)::int AS conversions FROM visits v ${convertedJoin} GROUP BY 1,2,3,4`,
            id,
            previousStart,
            previousEnd,
            timezone,
          );
        })()
      : Promise.resolve([]),
    needs('previousGoals')
      ? (async () => {
          const previousStart = new Date(Math.max(0, +start - (+end - +start + 1)));
          const previousEnd = new Date(+start - 1);
          const previous = await readBrowserDetailFacts(id, previousStart, previousEnd, timezone, [
            'goals',
          ]);
          if (previous) return previous.goals.map(({ id, count }) => ({ id, count }));
          return query(
            cte +
              ` SELECT report_id AS id,count(distinct event_id)::int AS count FROM matches GROUP BY 1`,
            id,
            previousStart,
            previousEnd,
            timezone,
          );
        })()
      : Promise.resolve([]),
  ]);
  const facts = { ...current[0]?.facts, ...detail };
  if (geographyReadLimit && facts.geo?.limitExceeded)
    throw new LiekanError('地域处理数据超过 100,000 组或 50 MiB，请缩小日期范围', 413);
  const {
    daily = [],
    geo = [],
    sources = [],
    environment = [],
    pages = [],
    heatmap = [],
    goals = [],
    converted = [],
    journeys = [],
    exits = [],
    dailySources = [],
    newVisitors = [],
    dailyConversions = [],
  } = facts;
  const allGoals = definitions
    .filter(d => d.type === 'goal' && d.parameters?.value && !Array.isArray(d.parameters?.steps))
    .map(d => ({
      id: d.id,
      name: d.name,
      path: d.parameters.value,
      count: goals.find(g => g.id === d.id)?.count ?? 0,
      convertedSessions: goals.find(g => g.id === d.id)?.convertedSessions ?? 0,
      previous: previousGoals.find(g => g.id === d.id)?.count ?? 0,
    }));
  const funnelDef = definitions.find(d => d.type === 'funnel');
  let funnel: Awaited<ReturnType<typeof getFunnel>> = [];
  let funnelState: 'available' | 'empty' | 'not_connected' | 'unsupported' = 'not_connected';
  let funnelError: string | null = null;
  if (funnelDef) {
    const parsed = funnelParametersSchema.safeParse(funnelDef.parameters);
    if (!parsed.success) {
      funnelState = 'unsupported';
      funnelError = '已保存的漏斗配置无效，请检查目标配置';
    } else if (needs('funnel')) {
      funnel = await getFunnel(
        id,
        { ...parsed.data, startDate: start, endDate: end },
        { startDate: start, endDate: end },
      );
      funnelState = funnel.length ? 'available' : 'empty';
    }
  }
  const previousPopulation =
    totals.population && needs('previousSources')
      ? await readBrowserPopulation(
          id,
          new Date(Math.max(0, +start - (+end - +start + 1))),
          new Date(+start - 1),
          timezone,
        )
      : undefined;
  return applyHumanFactsPopulation(
    {
      population: totals.population,
      totals,
      daily,
      geo,
      sources: sourceFacts(sources),
      sourceEvidence: sources.map(row => ({ ...row, ...classifyEntrySourceForDisplay(row) })),
      environment,
      pages,
      heatmap,
      goals: allGoals,
      converted: converted[0]?.count ?? 0,
      conversionEvents: converted[0]?.events ?? 0,
      dailyConversions,
      funnel,
      funnelState,
      funnelError,
      journeys,
      exits,
      dailySources: sourceFacts(dailySources),
      newVisitors: newVisitors[0]?.count ?? 0,
      previousSources: sourceFacts(previousSources).map(row =>
        identityUsable(previousPopulation)
          ? row
          : unavailableFields(row, ['sessions', 'conversions']),
      ),
    },
    totals.population,
  );
}
export async function getHumanConversions(id: string, start: Date, end: Date, timezone: string) {
  if(warehouseEnabled())return (await import('./warehouse-browser-queries')).warehouseBrowserConversions(id,start,end,timezone);
  return (
    (
      await query(
        `${cte} SELECT count(distinct event_id)::int AS count FROM matches`,
        id,
        start,
        end,
        timezone,
      )
    )[0]?.count ?? 0
  );
}
export async function getHumanDays(
  id: string,
  start: Date,
  end: Date,
  timezone: string,
  hour = false,
) {
  return nativeSnapshot(async () => {
    const detail = await readBrowserDetailFacts(id, start, end, timezone, ['daily'], { hour });
    const rows = detail?.daily ?? (await query(cte + humanBinsSql(hour), id, start, end, timezone));
    const population = await readBrowserPopulation(id, start, end, timezone);
    return identityUsable(population)
      ? rows
      : rows.map(row =>
          unavailableFields(row, ['uv', 'sessions', 'duration', 'bounces', 'conversions']),
        );
  });
}
