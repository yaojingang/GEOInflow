import { Decimal } from '@prisma/client/runtime/client';
import clickhouse from '@/lib/clickhouse';
import { getClickHouseCountrySQL } from '@/lib/country';
import { LiekanError } from './errors';
import { warehouseNativeQuery, warehouseNativeStringStream } from './warehouse-native-query';
import { warehouseRealtimeSources } from './warehouse-realtime-sources';
import { currentCacheContext } from './cache-context';

const first = (column: string, alias = '') =>
  `if(count()=0,NULL,argMin(tuple(${alias}${column}),tuple(${alias}created_at,${alias}event_id)).1)`;
const last = (column: string, alias = '') =>
  `if(count()=0,NULL,argMax(tuple(${alias}${column}),tuple(${alias}created_at,${alias}event_id)).1)`;
const seconds = (alias = '') =>
  `(toUnixTimestamp64Micro(maxOrNull(${alias}created_at))-toUnixTimestamp64Micro(minOrNull(${alias}created_at)))/1000000.0`;
export async function warehouseFeatureQuery(
  sql: string,
  params: Record<string, unknown>,
): Promise<any[]> {
  const rows = await warehouseNativeQuery<any[]>(sql, params);
  return rows.map(row =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (
          typeof value === 'string' &&
          /^(createdAt|firstAt|lastAt|startedAt|endedAt)$/.test(key)
        ) {
          const date = new Date(
            /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z',
          );
          return [key, Number.isFinite(+date) ? date.toISOString() : value];
        }
        if (key === 'amount' && value !== null) return [key, new Decimal(String(value)).toString()];
        return [key, value];
      }),
    ),
  );
}
export function warehouseFeatureSelection(
  websiteId: string,
  filters: any,
  all = false,
  name = 'selected',
) {
  const { filterQuery, cohortQuery, excludeBounceQuery, queryParams } = clickhouse.parseFilters({
    ...filters,
    websiteId,
  });
  return {
    cte: `WITH ${name} AS (SELECT website_event.* FROM website_event ${cohortQuery} ${excludeBounceQuery}
    WHERE website_event.website_id={websiteId:UUID} AND website_event.created_at BETWEEN {startDate:DateTime64(6)} AND {endDate:DateTime64(6)}
    ${all ? '' : 'AND website_event.event_type IN(1,2)'} ${filterQuery})`,
    params: queryParams,
  };
}
function attributed(cte: string, source: string, p: { model: string; type: string }, prefix = '') {
  const aggregate = p.model === 'first-click' ? 'argMin' : 'argMax';
  const column = p.type === 'path' ? 'url_path' : 'event_name';
  return `${cte},${prefix}conversions AS(SELECT session_id,max(created_at) AS last_conversion FROM ${source}
    WHERE event_type={${prefix}conversionType:UInt8} AND ${column}={${prefix}step:String} GROUP BY session_id),
    ${prefix}source_rows AS(SELECT c.session_id,e.referrer_domain,e.hostname,e.created_at,e.event_id FROM ${prefix}conversions c
      INNER JOIN website_event e ON e.session_id=c.session_id WHERE e.created_at BETWEEN {startDate:DateTime64(6)} AND {endDate:DateTime64(6)}
      AND e.created_at${p.model === 'last-click' ? '<' : '<='}c.last_conversion AND e.event_type IN(1,2)),
    ${prefix}source AS(SELECT session_id,${aggregate}(tuple(referrer_domain,hostname),tuple(created_at,event_id)) AS source FROM ${prefix}source_rows GROUP BY session_id),
    ${prefix}attributed AS(SELECT c.session_id,s.source.1 AS referrer_domain,s.source.2 AS hostname FROM ${prefix}conversions c LEFT JOIN ${prefix}source s USING(session_id))`;
}
export function warehouseSelectedFeatures(websiteId: string, p: any, filters: any) {
  let source = p.retentionDate ? 'cohort_events' : 'filtered_events';
  let { cte, params } = warehouseFeatureSelection(websiteId, filters, !!p.retentionDate, source);
  if (p.retentionDate) {
    if (!p.retentionDay) throw new LiekanError('留存观察日无效');
    cte += `,cohort_visitors AS(SELECT session_id FROM cohort_events GROUP BY session_id HAVING toDate(min(created_at),{timezone:String})={retentionDate:Date}),
      returned AS(SELECT DISTINCT e.session_id FROM website_event e INNER JOIN cohort_visitors c USING(session_id)
      WHERE e.created_at BETWEEN {startDate:DateTime64(6)} AND {endDate:DateTime64(6)} AND toDate(e.created_at,{timezone:String})=addDays({retentionDate:Date},{retentionDay:Int32})),
      retained_events AS(SELECT e.* FROM website_event e INNER JOIN returned r USING(session_id) WHERE e.created_at BETWEEN {startDate:DateTime64(6)} AND {endDate:DateTime64(6)})`;
    source = 'retained_events';
    params = { ...params, retentionDate: p.retentionDate, retentionDay: p.retentionDay };
  }
  if (p.attributionStep) {
    if (!p.attributionModel || !p.attributionType || p.attributionSource == null)
      throw new LiekanError('归因关联条件不完整');
    cte =
      attributed(
        cte,
        source,
        { model: p.attributionModel, type: p.attributionType },
        'association_',
      ) +
      `,associated_events AS(SELECT * FROM ${source} WHERE session_id IN(SELECT session_id FROM association_attributed WHERE referrer_domain={attributionSource:String}))`;
    source = 'associated_events';
    params = {
      ...params,
      association_step: p.attributionStep,
      association_conversionType: p.attributionType === 'path' ? 1 : 2,
      attributionSource: p.attributionSource,
    };
  }
  return { cte: cte + `,selected AS(SELECT * FROM ${source})`, params };
}
export async function warehouseFeatureAnalytics(websiteId: string, p: any, filters: any) {
  const { cte, params } = warehouseSelectedFeatures(websiteId, p, filters);
  const run = (sql: string, extra: any = {}) =>
    warehouseFeatureQuery(`${cte} ${sql}`, { ...params, ...extra });
  if (p.kind === 'events') {
    const [totals, rows, properties, values] = await sequential([
      () =>
        run(`SELECT count() AS total,uniqExact(session_id) AS visitors,uniqExact(event_name) AS types,
        countIf(event_id IN(SELECT website_event_id FROM event_data)) AS withProperties,maxOrNull(created_at) AS lastAt FROM selected WHERE event_type=2`),
      () =>
        run(
          `,properties_by_name AS(SELECT s.event_name,uniqExact(d.data_key) AS properties FROM selected s INNER JOIN event_data d ON d.website_event_id=s.event_id WHERE s.event_type=2 GROUP BY s.event_name)
        SELECT s.event_name AS name,count() AS triggers,uniqExact(s.session_id) AS visitors,maxOrNull(s.created_at) AS lastAt,coalesce(max(p.properties),0) AS properties
        FROM selected s LEFT JOIN properties_by_name p ON p.event_name=s.event_name WHERE s.event_type=2 GROUP BY s.event_name ORDER BY triggers DESC,name LIMIT 100 OFFSET {offset:UInt64}`,
          { offset: (p.page - 1) * 100 },
        ),
      () =>
        run(
          'SELECT d.data_key AS name,d.data_type AS dataType,uniqExact(d.website_event_id) AS total FROM event_data d INNER JOIN selected s ON s.event_id=d.website_event_id WHERE s.event_type=2 GROUP BY name,dataType ORDER BY name,dataType',
        ),
      () =>
        p.propertyName
          ? run(
              'SELECT d.string_value AS value,d.data_type AS dataType,uniqExact(d.website_event_id) AS total FROM event_data d INNER JOIN selected s ON s.event_id=d.website_event_id WHERE s.event_type=2 AND d.data_key={propertyName:String} GROUP BY value,dataType ORDER BY total DESC,value LIMIT 100',
              { propertyName: p.propertyName },
            )
          : Promise.resolve([]),
    ]);
    return {
      totals: totals[0],
      rows,
      properties,
      values,
      page: p.page,
      pageSize: 100,
      count: totals[0].types,
      limited: values.length === 100,
    };
  }
  if (p.kind === 'utm') {
    const [totals] =
      await run(`SELECT countIf(event_type=1) AS views,uniqExactIf(session_id,event_type=1) AS visitors,countIf(event_type=2) AS events FROM selected
      WHERE coalesce(utm_source,'')!='' OR coalesce(utm_medium,'')!='' OR coalesce(utm_campaign,'')!='' OR coalesce(utm_content,'')!='' OR coalesce(utm_term,'')!=''`);
    if (!p.dimension) return totals;
    const column = `utm_${p.dimension}`;
    const rows = await run(
      `SELECT ${column} AS utm,count() AS views FROM selected WHERE event_type=1 AND coalesce(${column},'')!='' GROUP BY utm ORDER BY views DESC,utm LIMIT 101`,
    );
    const [dimension] = await run(
      `SELECT count() AS views FROM selected WHERE event_type=1 AND coalesce(${column},'')!=''`,
    );
    return {
      ...totals,
      rows: rows.slice(0, 100),
      dimensionTotal: dimension.views,
      limited: rows.length > 100,
    };
  }
  if (p.kind === 'sources')
    return run(
      'SELECT referrer_domain AS referrer,uniqExact(session_id) AS visitors,count() AS views FROM selected WHERE event_type=1 GROUP BY referrer ORDER BY visitors DESC,referrer',
    );
  if (p.kind === 'performance') {
    const context = warehouseFeatureSelection(websiteId, filters, true, 'performance_events');
    const select = ['lcp', 'inp', 'cls', 'fcp', 'ttfb']
      .flatMap(m => [
        `count(${m}) AS ${m}Count`,
        ...[
          ['P50', 0.5],
          ['P75', 0.75],
          ['P95', 0.95],
        ].map(
          ([label, q]) => `quantileExactInclusiveOrNull(${q})(toFloat64(${m})) AS ${m}${label}`,
        ),
      ])
      .join(',');
    return (
      await warehouseFeatureQuery(
        `${cte},${context.cte.slice(5)} SELECT ${select} FROM performance_events WHERE event_type=5 ${p.retentionDate || p.attributionStep ? 'AND session_id IN(SELECT session_id FROM selected)' : ''}`,
        { ...params, ...context.params },
      )
    )[0];
  }
  if (p.kind === 'revenue') {
    if (!p.currency) throw new LiekanError('请选择币种');
    const sql = ` FROM website_revenue WHERE created_at BETWEEN {startDate:DateTime64(6)} AND {endDate:DateTime64(6)} AND upper(currency)={currency:String} AND session_id IN(SELECT session_id FROM selected)`;
    const [count] = await run(`SELECT count() AS count${sql}`, { currency: p.currency });
    const rows = await run(
      `SELECT event_id AS id,session_id AS sessionId,event_name AS event,revenue AS amount,currency,created_at AS createdAt${sql} ORDER BY createdAt DESC,id LIMIT 25 OFFSET {offset:UInt64}`,
      { currency: p.currency, offset: (p.page - 1) * 25 },
    );
    return { rows, count: count.count, page: p.page, pageSize: 25 };
  }
  if (p.kind === 'attribution') {
    if (!p.model || !p.type || !p.step) throw new LiekanError('归因条件不完整');
    const attr = attributed(cte, 'selected', p),
      known =
        "coalesce(referrer_domain,'')!='' AND referrer_domain!=replaceRegexpOne(coalesce(hostname,''),'^www\\\\.','')";
    const args = { ...params, conversionType: p.type === 'path' ? 1 : 2, step: p.step };
    const [total] = await warehouseFeatureQuery(
      `${attr} SELECT count() AS visitors,countIf(${known}) AS attributed FROM attributed`,
      args,
    );
    const rows = await warehouseFeatureQuery(
      `${attr} SELECT referrer_domain AS name,count() AS value FROM attributed WHERE ${known} GROUP BY name ORDER BY value DESC,name LIMIT 101`,
      args,
    );
    return { total, referrer: rows.slice(0, 100), limited: rows.length > 100 };
  }
  if (p.kind === 'session') {
    if (!p.sessionId) throw new LiekanError('请选择会话');
    const rows = await run(
      `SELECT event_id AS eventId,session_id AS sessionId,visit_id AS visitId,created_at AS createdAt,url_path AS urlPath,url_query AS urlQuery,referrer_domain AS referrerDomain,event_type AS eventType,event_name AS eventName,hostname FROM selected WHERE session_id={sessionId:UUID} ORDER BY created_at,event_id LIMIT 1001 OFFSET {offset:UInt64}`,
      { sessionId: p.sessionId, offset: (p.page - 1) * 1000 },
    );
    const [totals] = await run(
      `SELECT countIf(event_type=1) AS views,countIf(event_type=2) AS events,minOrNull(created_at) AS firstAt,maxOrNull(created_at) AS lastAt,${first('url_path')} AS entryPath,${last('url_path')} AS exitPath,${first('referrer_domain')} AS referrerDomain,${seconds()} AS seconds,count() AS count FROM selected WHERE session_id={sessionId:UUID}`,
      { sessionId: p.sessionId },
    );
    return {
      rows: rows.slice(0, 1000),
      totals,
      page: p.page,
      pageSize: 1000,
      more: rows.length > 1000,
    };
  }
  if (p.kind === 'sessions') {
    const [count] = await run('SELECT uniqExact(session_id) AS count FROM selected');
    const rows = await run(
      `SELECT session_id AS id,minOrNull(created_at) AS firstAt,maxOrNull(created_at) AS lastAt,uniqExact(visit_id) AS visits,countIf(event_type=1) AS views,countIf(event_type=2) AS events,${seconds()} AS seconds,${first('referrer_domain')} AS referrerDomain,${last('url_path')} AS urlPath,
      ${getClickHouseCountrySQL(last('liekan_country'))} AS country,${['region', 'city', 'browser', 'os', 'device'].map(c => `${last(`liekan_${c}`)} AS ${c}`).join(',')} FROM selected GROUP BY session_id ORDER BY lastAt DESC,session_id LIMIT 25 OFFSET {offset:UInt64}`,
      { offset: (p.page - 1) * 25 },
    );
    return { rows, count: count.count, page: p.page, pageSize: 25 };
  }
  if (p.kind === 'realtime') {
    const cutoff = new Date(p.endAt - 5 * 60000);
    const [totals] = await run(
      'SELECT uniqExactIf(session_id,created_at>={cutoff:DateTime64(6)}) AS active,countIf(event_type=1) AS views,countIf(event_type=2) AS events FROM selected',
      { cutoff },
    );
    const pages = await run(
      'SELECT url_path AS name,uniqExact(session_id) AS value FROM selected WHERE created_at>={cutoff:DateTime64(6)} AND event_type=1 GROUP BY name ORDER BY value DESC LIMIT 25',
      { cutoff },
    );
    const signal = currentCacheContext()?.request?.signal;
    const { ai, sources } = await warehouseRealtimeSources(
      emit =>
        warehouseNativeStringStream<{ id: string; referrer: string | null }>(
          `${cte} SELECT DISTINCT session_id AS id,referrer_domain AS referrer FROM selected WHERE created_at>={cutoff:DateTime64(6)}`,
          { ...params, cutoff },
          async rows => {
            for (const row of rows) await emit(row);
          },
          signal,
        ),
      signal,
    );
    return {
      totals: { ...totals, ai },
      pages,
      sources,
    };
  }
  if (p.kind === 'heatmap-scroll') {
    if (!p.urlPath) throw new LiekanError('请选择已采集页面');
    return (
      await run(
        `,depths AS(SELECT h.visit_id,max(h.scroll_pct) AS depth FROM heatmap_event h WHERE h.event_type=2 AND h.url_path={urlPath:String}
      AND h.created_at BETWEEN {startDate:DateTime64(6)} AND {endDate:DateTime64(6)} AND h.scroll_pct IS NOT NULL AND h.page_w IS NOT NULL AND h.page_h IS NOT NULL AND h.viewport_w IS NOT NULL AND h.viewport_h IS NOT NULL
      AND (h.session_id,h.visit_id) IN(SELECT session_id,visit_id FROM selected) GROUP BY h.visit_id) SELECT count() AS total,${[25, 50, 75, 100].map(d => `countIf(depth>=${d}) AS reach${d}`).join(',')} FROM depths`,
        { urlPath: p.urlPath },
      )
    )[0];
  }
  if (p.kind === 'replays')
    return (await import('./warehouse-feature-replays')).warehouseFeatureReplays(
      websiteId,
      p,
      cte,
      params,
    );
  const rows = await run(
    'SELECT d.data_key AS name,d.string_value AS value,d.data_type AS dataType,uniqExact(s.session_id) AS sessions FROM session_data d INNER JOIN selected s ON s.session_id=d.session_id GROUP BY name,value,dataType ORDER BY sessions DESC,name,value LIMIT 100 OFFSET {offset:UInt64}',
    { offset: (p.page - 1) * 100 },
  );
  return { rows, page: p.page, pageSize: 100, more: rows.length === 100 };
}

export async function warehouseFeatureGoal(
  websiteId: string,
  goal: { type: string; value: string },
  p: any,
  filters: any,
) {
  let { cte, params } = warehouseFeatureSelection(websiteId, filters, false, 'goal_events');
  cte += `,selected AS(SELECT * FROM goal_events ${p.requireUtm === '1' ? "WHERE coalesce(utm_source,'')!='' OR coalesce(utm_medium,'')!='' OR coalesce(utm_campaign,'')!='' OR coalesce(utm_content,'')!='' OR coalesce(utm_term,'')!=''" : ''})`;
  const column = goal.type === 'path' ? 'url_path' : 'event_name';
  const operator = goal.value.startsWith('*') || goal.value.endsWith('*') ? 'LIKE' : '=';
  const matching = `event_type=${goal.type === 'path' ? 1 : 2} AND ${column} ${operator} {target:String}`;
  const date =
    p.unit === 'week'
      ? "formatDateTime(toStartOfWeek(created_at,1,{timezone:String}),'%Y-%m-%dT00:00:00Z',{timezone:String})"
      : clickhouse.getDateSQL('created_at', p.unit, p.timezone);
  const run = (sql: string) =>
    warehouseFeatureQuery(`${cte} ${sql}`, {
      ...params,
      target: goal.value.replace(/^\*|\*$/g, '%'),
    });
  return sequential([
    () =>
      run(
        `SELECT countIf(${matching}) AS conversions,uniqExactIf(session_id,${matching}) AS num,uniqExact(session_id) AS total FROM selected`,
      ),
    () =>
      run(`SELECT ${date} AS x,count() AS y FROM selected WHERE ${matching} GROUP BY x ORDER BY x`),
  ]);
}

async function sequential<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  const values: T[] = [];
  for (const task of tasks) values.push(await task());
  return values;
}
