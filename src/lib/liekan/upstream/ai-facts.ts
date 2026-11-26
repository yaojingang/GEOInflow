import { renderAiFacts } from './ai-facts-render';
import { warehouseEnabled, withinWarehouseAuthority } from '../warehouse/authority-routing';
import { readBrowserPopulation } from './browser-population';
import { identityUsable } from '../contracts/browser-population';
import { crawlerAiSql } from '../rules/population';
import { randomUUID } from 'node:crypto';
import { logInputConnectedSql } from './log-input';
import { type AiConversationPost, aiConversationPostSchema } from '../ai/contracts';
import { loadAiConversation } from '../ai/conversations';
import { AiError } from '../ai/error';
import {
  type AiFact,
  type AiFactsContext,
  normalizeAiRange,
  sanitizeAiFactsContext,
} from '../ai/facts-contracts';
import { aiChangePercent, safeAiCount, sanitizeAiText } from '../ai/sanitize';
import type { AiActor } from './ai-access';
import { getAiFactsClient } from './ai-facts-db';
import { waitForLogStatisticsReads } from './ai-log-read-priority';
import { channelFilterColumn } from './filter-extension';
import { withinQuerySnapshot } from './query-snapshot';
import { query } from './server';
import { getPublishedCatalog } from '../crawlers/published';
import { withPublishedRegistry } from './crawler-registry-context';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';

type Row = Record<string, any>;
const ai = crawlerAiSql();
const error = '(status IN (403,404) OR status BETWEEN 500 AND 599)';
const period = 'CASE WHEN created_at >= $2::timestamptz THEN 0 ELSE 1 END';
const logRange =
  'FROM liekan_reporting_log l LEFT JOIN liekan_crawler_evidence e ON e.website_id=l.website_id AND e.log_id=l.id WHERE l.website_id=$1::uuid AND created_at BETWEEN $4::timestamptz AND $3::timestamptz';
const browserCte = `WITH events AS (
 SELECT e.*, CASE WHEN e.created_at >= $2::timestamptz THEN 0 ELSE 1 END AS period
 FROM website_event e JOIN session s ON s.website_id=e.website_id AND s.session_id=e.session_id
 WHERE e.website_id=$1::uuid AND e.created_at BETWEEN $4::timestamptz AND $3::timestamptz AND e.event_type != 5
), visits AS (
 SELECT period,visit_id,session_id,count(*) FILTER(WHERE event_type NOT IN (2,5)) AS pv
 FROM events GROUP BY 1,2,3 HAVING count(*) FILTER(WHERE event_type NOT IN (2,5)) > 0
)`;
function checkSignal(signal: AbortSignal) {
  if (signal.aborted) throw new AiError('cancelled', 'AI 请求已取消', 409);
}
/** One primary, read-only repeatable-read snapshot; every SQL statement uses its remaining shared budget. */
async function buildAiFactsContextWithinAuthority(input: {
  actor: AiActor;
  conversationId: string;
  input: AiConversationPost;
  signal: AbortSignal;
}): Promise<AiFactsContext> {
  const parsed = aiConversationPostSchema.safeParse(input.input);
  if (!parsed.success) throw new AiError('invalid_request', 'AI 请求参数无效');
  normalizeAiRange(parsed.data, new Date());
  checkSignal(input.signal);
  const catalog = getPublishedCatalog();
  if (!catalog) return withPublishedRegistry(() => buildAiFactsContext(input));
  const catalogVersion = catalog.version;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new AiError('database_unavailable', '数据库尚未配置', 503);
  const schema = new URL(databaseUrl).searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema))
    throw new AiError('database_unavailable', '数据库设置无效', 503);
  const primary = getAiFactsClient();
  const deadline = Date.now() + 5000;
  const fail = (error: any): never => {
    checkSignal(input.signal);
    if (error instanceof AiError) throw error;
    const sqlState = error?.meta?.code ?? error?.meta?.driverAdapterError?.cause?.originalCode;
    if (Date.now() >= deadline || sqlState === '57014' || error?.code === 'P2028')
      throw new AiError('facts_timeout', '读取统计事实超时，请缩小日期范围后重试', 503);
    throw Object.assign(new AiError('facts_unavailable', '统计数据暂时不可读取，请稍后重试', 503), {
      cause: error,
    });
  };
  const execution = (raw: any) => {
    const remaining = async () => {
      checkSignal(input.signal);
      await waitForLogStatisticsReads(input.signal, deadline);
      checkSignal(input.signal);
      const ms = deadline - Date.now();
      if (ms <= 0) throw new AiError('facts_timeout', '读取统计事实超时，请缩小范围后重试', 503);
      await raw.$executeRawUnsafe(`SET LOCAL statement_timeout TO '${ms}ms'`);
    };
    return {
      remaining,
      executor: {
        aiPrivate: true,
        $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
          await remaining();
          return raw.$executeRawUnsafe(`/* liekan_ai */ ${sql}`, ...params);
        },
        $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
          await remaining();
          const rows = await raw.$queryRawUnsafe(`/* liekan_ai */ ${sql}`, ...params);
          checkSignal(input.signal);
          return rows;
        },
      },
    };
  };
  await waitForLogStatisticsReads(input.signal, deadline);
  // Authorization uses the private pool as well; its row locks end before the facts snapshot.
  const authorized = await primary
    .$transaction(
      async raw => {
        const { remaining, executor } = execution(raw);
        await remaining();
        await raw.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        return loadAiConversation(
          {
            query: (sql, ...params) => executor.$queryRawUnsafe(sql, ...params),
            execute: (sql, ...params) => executor.$executeRawUnsafe(sql, ...params),
          },
          input.actor,
          input.conversationId,
          true,
        );
      },
      { timeout: 6000, maxWait: Math.max(1, deadline - Date.now()) },
    )
    .catch(fail);
  if (warehouseEnabled())
    return (await import('./warehouse-ai-facts')).buildWarehouseAiFactsContext(
      input,
      authorized,
      parsed.data,
      catalogVersion,
    );
  if (process.env.CLICKHOUSE_URL) return unsupportedAiFactsContext(authorized, parsed.data);
  await waitForLogStatisticsReads(input.signal, deadline);
  const context = await primary
    .$transaction(
      async (raw: any) => {
        const { remaining, executor } = execution(raw);
        await remaining();
        await raw.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        await raw.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        // A shared preprocessing lane keeps three admitted runs from competing with statistics browsing.
        // Waiting consumes the same five-second deadline as the subsequent snapshot queries.
        await executor.$queryRawUnsafe(
          'SELECT true AS acquired FROM pg_advisory_xact_lock(12800073)',
        );
        await executor.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather=0');
        return withinQuerySnapshot(executor, async () => {
          const [live] = await query<Row>(
            `SELECT w.website_id AS id,w.name,w.domain,w.user_id AS owner,w.team_id AS team,s.epoch
        FROM website w JOIN liekan_ai_website_state s ON s.website_id=w.website_id
        JOIN liekan_ai_conversation c ON c.website_id=w.website_id AND c.id=$2::uuid AND c.creator_id=$3::uuid AND c.expires_at>now()
        JOIN "user" actor ON actor.user_id=$3::uuid AND actor.deleted_at IS NULL
        LEFT JOIN "user" owner ON owner.user_id=w.user_id AND owner.deleted_at IS NULL
        LEFT JOIN team t ON t.team_id=w.team_id AND t.deleted_at IS NULL
        LEFT JOIN team_user member ON member.team_id=w.team_id AND member.user_id=$3::uuid
        WHERE w.website_id=$1::uuid AND w.deleted_at IS NULL AND c.website_epoch=s.epoch
        AND c.owner_user_id IS NOT DISTINCT FROM w.user_id AND c.team_id IS NOT DISTINCT FROM w.team_id
        AND s.owner_user_id IS NOT DISTINCT FROM w.user_id AND s.team_id IS NOT DISTINCT FROM w.team_id
        AND ((w.user_id IS NOT NULL AND owner.user_id IS NOT NULL AND (w.user_id=$3::uuid OR actor.role='admin')) OR
          (w.team_id IS NOT NULL AND t.team_id IS NOT NULL AND (member.user_id IS NOT NULL OR actor.role='admin')))
        AND actor.role != 'view-only' AND (member.role IS NULL OR member.role != 'team-view-only')`,
            authorized.site.id,
            input.conversationId,
            input.actor.id,
          );
          if (
            !live ||
            live.epoch !== authorized.row.website_epoch ||
            live.owner !== authorized.site.ownerUserId ||
            live.team !== authorized.site.teamId
          )
            throw new AiError('resource_unavailable', '网站归属或数据已更新，请新建对话', 404);
          const [repair] = await query<Row>(
            'SELECT active_generation::text AS generation,active_revision::text AS revision FROM liekan_history_repair_run WHERE website_id=$1::uuid',
            live.id,
          );
          const generatedAt = new Date();
          const range = normalizeAiRange(parsed.data, generatedAt);
          const start = new Date(range.currentRange.startAt),
            end = new Date(range.currentRange.endAt),
            previousStart = new Date(range.previousRange.startAt),
            previousEnd = new Date(range.previousRange.endAt);
          const population = await readBrowserPopulation(live.id, start, end, parsed.data.timezone);
          const previousPopulation = await readBrowserPopulation(
            live.id,
            previousStart,
            previousEnd,
            parsed.data.timezone,
          );
          const identityReady = identityUsable(population),
            previousIdentityReady = identityUsable(previousPopulation);
          const args = [live.id, start, end, previousStart];
          const q = (sql: string) => query<Row>(sql, ...args.slice(0, sql.includes('$4') ? 4 : 3));
          // Sequential execution keeps each remaining statement_timeout tied to the statement that uses it.
          // Scan both browser periods once. Preserve the dashboard's pageview and distinct
          // session/visit counts, including its millisecond end boundary and custom-only exclusion.
          const browserTotals = await query<Row>(
            `WITH visits AS (
          SELECT CASE WHEN created_at >= $2::timestamptz THEN 0 ELSE 1 END AS period,
            session_id,visit_id,count(*) FILTER(WHERE event_type NOT IN(2,5)) AS pv
          FROM website_event WHERE website_id=$1::uuid
            AND created_at BETWEEN $4::timestamptz AND $3::timestamptz AND event_type != 5
            AND (created_at >= $2::timestamptz OR created_at <= $5::timestamptz)
          GROUP BY 1,2,3 HAVING count(*) FILTER(WHERE event_type NOT IN(2,5)) > 0
        ) SELECT period,coalesce(sum(pv),0)::bigint AS "pageviews",
          count(distinct session_id)::bigint AS "visitors",
          count(distinct visit_id)::bigint AS "visits" FROM visits GROUP BY period`,
            live.id,
            start,
            end,
            previousStart,
            previousEnd,
          );
          const browserRow = (period: number) => {
            const row = browserTotals.find(row => row.period === period);
            return {
              pageviews: safeAiCount(row?.pageviews ?? 0),
              visitors: (period === 0 ? identityReady : previousIdentityReady)
                ? safeAiCount(row?.visitors ?? 0)
                : null,
              visits: (period === 0 ? identityReady : previousIdentityReady)
                ? safeAiCount(row?.visits ?? 0)
                : null,
            };
          };
          const current = browserRow(0),
            previous = browserRow(1);
          const [sources] = await query<Row>(
            `SELECT ${logInputConnectedSql} AS connected,
        EXISTS(SELECT 1 FROM liekan_raw_website_event WHERE website_id=$1::uuid AND event_type NOT IN(2,5)) AS browser,
        (SELECT count(*) FROM liekan_catalog WHERE website_id=$1::uuid) AS catalog,
        (SELECT count(*) FROM report WHERE website_id=$1::uuid AND type='goal') AS goals,
        (SELECT count(*) FROM report WHERE website_id=$1::uuid AND type='goal' AND NOT COALESCE(
          (parameters->>'type' IN ('path','event') AND jsonb_typeof(parameters->'value')='string' AND length(parameters->>'value')>0 AND NOT(parameters ? 'steps')),false)) AS invalid`,
            live.id,
          );
          // Aggregate eligible logs once in the snapshot, then derive bounded fact lists.
          const classifiedLogs = await q(`WITH input AS (
  SELECT ${period} AS period,
    bot AS name,vendor,l.reporting_crawler_id AS bot_id,bot_type,${ai} AS ai_eligible,
    CASE WHEN verification IN ('verified_range','verified_dns','verified_edge','range_mismatch') THEN verification ELSE 'unverified' END AS verification,
    status,CASE WHEN ${ai} OR status IN (403,404) OR status BETWEEN 500 AND 599 THEN split_part(split_part(path,'?',1),'#',1) END AS path
  ${logRange}
), bins AS MATERIALIZED (
  SELECT period,name,vendor,bot_type,verification,status,path,ai_eligible,bot_id,count(*) AS n
  FROM input GROUP BY 1,2,3,4,5,6,7,8,9
), summary AS (
  SELECT 'summary' AS kind,period,NULL::text AS name,NULL::text AS vendor,NULL::text AS class,NULL::text AS verification,
    sum(n)::bigint AS requests,NULL::bigint AS previous,
    coalesce(sum(n) FILTER(WHERE ai_eligible),0)::bigint AS ai,
    coalesce(sum(n) FILTER(WHERE status=403),0)::bigint AS e403,
    coalesce(sum(n) FILTER(WHERE status=404),0)::bigint AS e404,
    coalesce(sum(n) FILTER(WHERE status BETWEEN 500 AND 599),0)::bigint AS e5xx,NULL::bigint AS total,
    NULL::text AS path,NULL::bigint AS pv,NULL::bigint AS "previousPv",NULL::text AS "statusGroup",NULL::text AS bot_id
  FROM bins GROUP BY period
), bot_groups AS (
  SELECT name,vendor,bot_type AS class,verification,bot_id,
    coalesce(sum(n) FILTER(WHERE period=0),0)::bigint AS requests,
    coalesce(sum(n) FILTER(WHERE period=1),0)::bigint AS previous
  FROM bins WHERE ai_eligible GROUP BY 1,2,3,4,5
), top_bots AS (
  SELECT 'bot' AS kind,NULL::integer AS period,name,vendor,class,verification,requests,previous,
    NULL::bigint AS ai,NULL::bigint AS e403,NULL::bigint AS e404,NULL::bigint AS e5xx,count(*) OVER() AS total,
    NULL::text AS path,NULL::bigint AS pv,NULL::bigint AS "previousPv",NULL::text AS "statusGroup",bot_id
  FROM bot_groups ORDER BY requests DESC,previous DESC,name,vendor,class,verification,bot_id LIMIT 20
), humans AS (
  SELECT split_part(split_part(url_path,'?',1),'#',1) AS path,
    count(*) FILTER(WHERE created_at >= $2::timestamptz) AS pv,
    count(*) FILTER(WHERE created_at < $2::timestamptz) AS "previousPv"
  FROM website_event WHERE website_id=$1::uuid AND created_at BETWEEN $4::timestamptz AND $3::timestamptz
    AND event_type NOT IN(2,5) GROUP BY 1
), bot_pages AS (
  SELECT path,coalesce(sum(n) FILTER(WHERE period=0),0)::bigint AS ai,
    coalesce(sum(n) FILTER(WHERE period=1),0)::bigint AS "previousAi"
  FROM bins WHERE ai_eligible GROUP BY path
), top_pages AS (
  SELECT 'page' AS kind,NULL::integer AS period,NULL::text AS name,NULL::text AS vendor,
    NULL::text AS class,NULL::text AS verification,NULL::bigint AS requests,coalesce(b."previousAi",0)::bigint AS previous,
    coalesce(b.ai,0)::bigint AS ai,NULL::bigint AS e403,NULL::bigint AS e404,NULL::bigint AS e5xx,count(*) OVER() AS total,
    coalesce(h.path,b.path) AS path,coalesce(h.pv,0)::bigint AS pv,coalesce(h."previousPv",0)::bigint AS "previousPv",NULL::text AS "statusGroup",NULL::text AS bot_id
  FROM humans h FULL JOIN bot_pages b USING(path)
  ORDER BY coalesce(h.pv,0)+coalesce(b.ai,0) DESC,coalesce(h."previousPv",0)+coalesce(b."previousAi",0) DESC,path LIMIT 20
), error_groups AS (
  SELECT path,CASE WHEN status=403 THEN '403' WHEN status=404 THEN '404' ELSE '5xx' END AS "statusGroup",sum(n)::bigint AS requests
  FROM bins WHERE period=0 AND (status IN (403,404) OR status BETWEEN 500 AND 599) GROUP BY 1,2
), top_errors AS (
  SELECT 'error' AS kind,NULL::integer AS period,NULL::text AS name,NULL::text AS vendor,NULL::text AS class,
    NULL::text AS verification,requests,NULL::bigint AS previous,NULL::bigint AS ai,NULL::bigint AS e403,
    NULL::bigint AS e404,NULL::bigint AS e5xx,count(*) OVER() AS total,path,NULL::bigint AS pv,
    NULL::bigint AS "previousPv","statusGroup",NULL::text AS bot_id
  FROM error_groups ORDER BY requests DESC,path,"statusGroup" LIMIT 20
) SELECT * FROM summary UNION ALL SELECT * FROM top_bots UNION ALL SELECT * FROM top_pages UNION ALL SELECT * FROM top_errors`);
          const logs = classifiedLogs.filter(row => row.kind === 'summary');
          const bots = classifiedLogs.filter(row => row.kind === 'bot');
          const errorPaths = classifiedLogs.filter(row => row.kind === 'error');
          const pages = classifiedLogs.filter(row => row.kind === 'page');
          const samples = await q(
            `SELECT created_at AS time,path,status,bot FROM liekan_reporting_log WHERE website_id=$1::uuid AND created_at BETWEEN $2::timestamptz AND $3::timestamptz AND ${error} ORDER BY created_at DESC,id DESC LIMIT 20`,
          );
          const referrals = await q(
            browserCte +
              `, entry_visits AS (
        SELECT v.*,e.utm_source,e.utm_medium,e.referrer_domain FROM visits v LEFT JOIN LATERAL (
          SELECT utm_source,utm_medium,referrer_domain FROM website_event e WHERE e.website_id=$1::uuid AND e.visit_id=v.visit_id AND e.session_id=v.session_id
            AND e.created_at <= CASE WHEN v.period=0 THEN $3::timestamptz ELSE $2::timestamptz-interval '1 millisecond' END AND e.event_type NOT IN(2,5)
          ORDER BY e.created_at,e.event_id LIMIT 1) e ON true
        ) SELECT period,count(*) AS visits,coalesce(sum(pv),0)::bigint AS pv FROM entry_visits e WHERE ${channelFilterColumn('e.')}='AI 搜索引荐' GROUP BY 1`,
          );
          const goals = await q(
            browserCte +
              `, definitions AS (
        SELECT report_id,name,parameters FROM report WHERE website_id=$1::uuid AND type='goal' AND parameters->>'type' IN('path','event')
        AND jsonb_typeof(parameters->'value')='string' AND length(parameters->>'value')>0 AND NOT(parameters ? 'steps')
      ), matches AS (
        SELECT d.report_id,e.period,e.event_id,e.visit_id,e.session_id FROM definitions d JOIN events e ON
          ((d.parameters->>'type'='path' AND e.event_type=1 AND CASE WHEN left(d.parameters->>'value',1)='*' OR right(d.parameters->>'value',1)='*'
            THEN e.url_path LIKE regexp_replace(regexp_replace(d.parameters->>'value','^[*]','%'),'[*]$','%') ELSE e.url_path=d.parameters->>'value' END) OR
          (d.parameters->>'type'='event' AND e.event_type=2 AND CASE WHEN left(d.parameters->>'value',1)='*' OR right(d.parameters->>'value',1)='*'
            THEN e.event_name LIKE regexp_replace(regexp_replace(d.parameters->>'value','^[*]','%'),'[*]$','%') ELSE e.event_name=d.parameters->>'value' END))
      ) SELECT d.name,d.parameters->>'type' AS type,
        count(distinct m.event_id) FILTER(WHERE m.period=0) AS count,count(distinct m.event_id) FILTER(WHERE m.period=1) AS previous,
        count(distinct (m.visit_id,m.session_id)) FILTER(WHERE m.period=0 AND v.visit_id IS NOT NULL) AS converted,
        count(distinct (m.visit_id,m.session_id)) FILTER(WHERE m.period=1 AND v.visit_id IS NOT NULL) AS "previousConverted",count(*) OVER() AS total
        FROM definitions d LEFT JOIN matches m ON m.report_id=d.report_id LEFT JOIN visits v ON v.visit_id=m.visit_id AND v.session_id=m.session_id AND v.period=m.period
        GROUP BY d.report_id,d.name,d.parameters ORDER BY count DESC,d.report_id LIMIT 20`,
          );
          if (Date.now() > deadline)
            throw new AiError('facts_timeout', '读取统计事实超时，请缩小范围后重试', 503);
          return renderAiFacts({
            logs,
            bots,
            errorPaths,
            pages,
            samples,
            referrals,
            goals,
            sources,
            current,
            previous,
            identityReady,
            previousIdentityReady,
            live,
            authorized,
            range,
            parsed,
            generatedAt,
            catalogVersion,
            population,
            previousPopulation,
            repair,
          });
        });
      },
      {
        timeout: 6000,
        maxWait: Math.max(1, deadline - Date.now()),
        isolationLevel: 'RepeatableRead',
      },
    )
    .catch(fail);
  checkSignal(input.signal);
  return context;
}

export function unsupportedAiFactsContext(
  authorized: {
    site: { id: string; name: string; domain: string | null };
    space: AiFactsContext['space'];
    row: { website_epoch: string };
  },
  input: AiConversationPost,
): AiFactsContext {
  const asOf = new Date(),
    range = normalizeAiRange(input, asOf);
  const keys = ['pageviews', 'visitors', 'visits', 'aiRequests', 'aiReferrals'] as const;
  return sanitizeAiFactsContext({
    protocolVersion: 1,
    id: randomUUID(),
    website: {
      id: authorized.site.id,
      name: sanitizeAiText(authorized.site.name),
      domain: authorized.site.domain,
    },
    space: authorized.space,
    websiteEpoch: authorized.row.website_epoch,
    ...range,
    timeZone: input.timezone,
    generatedAt: asOf.toISOString(),
    metricVersion: 'liekan-ai-facts-v1',
    catalogVersion: getPublishedCatalog()?.version,
    trafficPolicyVersion: TRAFFIC_POLICY_VERSION,
    promptVersion: 'liekan-ai-prompt-v1',
    coverage: 'unverified',
    sourceStates: {
      human: 'unsupported',
      logs: 'unsupported',
      catalog: 'unsupported',
      goals: 'unsupported',
      aiReferrals: 'unsupported',
    },
    businessProfile: { state: 'unconfigured', value: null },
    metrics: keys.map(key => ({
      key,
      label: {
        pageviews: '浏览量',
        visitors: '访客',
        visits: '访问次数',
        aiRequests: 'AI 爬虫请求',
        aiReferrals: 'AI 引荐访问',
      }[key],
      value: null,
      state: 'unsupported',
      changePercent: null,
    })),
    facts: [],
  });
}

export function buildAiFactsContext(
  input: Parameters<typeof buildAiFactsContextWithinAuthority>[0],
) {
  return withinWarehouseAuthority(() => buildAiFactsContextWithinAuthority(input));
}
