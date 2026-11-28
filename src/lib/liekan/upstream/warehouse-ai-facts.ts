import { safeAiCount } from '../ai/sanitize';
import type { AiConversationPost } from '../ai/contracts';
import { normalizeAiRange } from '../ai/facts-contracts';
import { loadAiConversation } from '../ai/conversations';
import { AiError } from '../ai/error';
import { identityUsable } from '../contracts/browser-population';
import { crawlerAiSql } from '../rules/population';
import { warehouseTime } from '../warehouse/fact-input';
import { factRelation } from '../warehouse/read';
import { geographicEventRelation, reportingLogRelation } from '../warehouse/reporting-relations';
import { warehouseReader } from '../warehouse/reader-runtime';
import { readBrowserPopulation } from './browser-population';
import {
  warehouseReportMetadata,
  warehouseReportQuery,
  withinWarehouseReport,
} from './warehouse-report-snapshot';
import { renderAiFacts } from './ai-facts-render';
import { channelFilterColumn } from './filter-extension';
import { logInputConnectedSql } from './log-input';
import { getAiFactsClient } from './ai-facts-db';
import type { AiActor } from './ai-access';

type Authorized = Awaited<ReturnType<typeof loadAiConversation>>;
export async function buildWarehouseAiFactsContext(
  input: { actor: AiActor; conversationId: string; signal: AbortSignal },
  authorized: Authorized,
  p: AiConversationPost,
  catalogVersion: string,
) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(90000)]);
  const check = () => {
    if (input.signal.aborted) throw new AiError('cancelled', 'AI 请求已取消', 409);
    if (signal.aborted) throw new AiError('facts_timeout', '读取统计事实超时，请稍后重试', 503);
  };
  const reauthorize = async () => {
    check();
    const current = await getAiFactsClient().$transaction(
      raw =>
        loadAiConversation(
          {
            query: (sql, ...args) => raw.$queryRawUnsafe(sql, ...args),
            execute: (sql, ...args) => raw.$executeRawUnsafe(sql, ...args),
          },
          input.actor,
          input.conversationId,
          true,
        ),
      { timeout: 6000, maxWait: 5000 },
    );
    if (
      current.row.website_epoch !== authorized.row.website_epoch ||
      current.site.ownerUserId !== authorized.site.ownerUserId ||
      current.site.teamId !== authorized.site.teamId
    )
      throw new AiError('resource_unavailable', '网站归属或数据已更新，请新建对话', 404);
  };
  try {
    await reauthorize();
    return await withinWarehouseReport(async () => {
      const generatedAt = new Date(),
        range = normalizeAiRange(p, generatedAt),
        site = authorized.site.id;
      const start = new Date(range.currentRange.startAt),
        end = new Date(range.currentRange.endAt),
        previousStart = new Date(range.previousRange.startAt),
        previousEnd = new Date(range.previousRange.endAt);
      const params = {
        start: warehouseTime(start),
        end: warehouseTime(end),
        previousStart: warehouseTime(previousStart),
        previousEnd: warehouseTime(previousEnd),
      };
      const run = async (sql: string, extra: Record<string, unknown> = {}) => {
        check();
        const rows = await warehouseReportQuery<any>(
          site,
          sql,
          { ...params, ...extra },
          { signal },
        );
        check();
        const counters = new Set([
          'pageviews',
          'visitors',
          'visits',
          'requests',
          'ai',
          'e403',
          'e404',
          'e5xx',
          'previous',
          'total',
          'pv',
          'previousPv',
          'count',
          'converted',
          'previousConverted',
        ]);
        for (const row of rows)
          for (const key of Object.keys(row))
            if (counters.has(key) && typeof row[key] === 'string' && /^[0-9]+$/.test(row[key]))
              row[key] = safeAiCount(BigInt(row[key]));
        return rows;
      };
      const metadata = await warehouseReportMetadata(site);
      const population = await readBrowserPopulation(site, start, end, p.timezone),
        previousPopulation = await readBrowserPopulation(
          site,
          previousStart,
          previousEnd,
          p.timezone,
        );
      const identityReady = identityUsable(population),
        previousIdentityReady = identityUsable(previousPopulation);
      const browserTotals =
        await run(`WITH visits AS(SELECT if(created_at>={start:DateTime64(6)},0,1) AS period,session_id,visit_id,countIf(event_type NOT IN(2,5)) AS pv
        FROM ${geographicEventRelation()} WHERE created_at BETWEEN {previousStart:DateTime64(6)} AND {end:DateTime64(6)} AND event_type!=5 AND (created_at>={start:DateTime64(6)} OR created_at<={previousEnd:DateTime64(6)}) GROUP BY period,session_id,visit_id HAVING pv>0)
        SELECT period,sum(pv) AS pageviews,uniqExact(session_id) AS visitors,uniqExact(visit_id) AS visits FROM visits GROUP BY period`);
      const browserRow = (period: number) => {
        const row = browserTotals.find(r => Number(r.period) === period);
        return {
          pageviews: Number(row?.pageviews ?? 0),
          visitors: (period ? previousIdentityReady : identityReady)
            ? Number(row?.visitors ?? 0)
            : null,
          visits: (period ? previousIdentityReady : identityReady)
            ? Number(row?.visits ?? 0)
            : null,
        };
      };
      const current = browserRow(0),
        previous = browserRow(1);
      const definitions = metadata.reports.filter(r => r.type === 'goal');
      const valid = definitions.filter(
        r =>
          ['path', 'event'].includes(r.parameters?.type) &&
          typeof r.parameters?.value === 'string' &&
          r.parameters.value.length > 0 &&
          !Object.hasOwn(r.parameters, 'steps'),
      );
      const [business] = await warehouseReader().db.read<any>(
        `SELECT ${logInputConnectedSql} AS connected,(SELECT count(*) FROM liekan_catalog WHERE website_id=$1) AS catalog`,
        [site],
      );
      const presence = await run(
        `SELECT 1 AS present FROM ${factRelation('website_event')} WHERE event_type NOT IN(2,5) LIMIT 1`,
      );
      const sources = {
        ...business,
        catalog: safeAiCount(BigInt(business.catalog)),
        browser: presence.length > 0,
        goals: definitions.length,
        invalid: definitions.length - valid.length,
      };
      const ai = crawlerAiSql('l'),
        logBase = `FROM ${reportingLogRelation()} l WHERE created_at BETWEEN {previousStart:DateTime64(6)} AND {end:DateTime64(6)}`;
      const period = 'if(created_at>={start:DateTime64(6)},0,1)',
        path = "splitByChar('#',splitByChar('?',path)[1])[1]";
      const logs = await run(
        `SELECT ${period} AS period,count() AS requests,countIf(${ai}) AS ai,countIf(status=403) AS e403,countIf(status=404) AS e404,countIf(status BETWEEN 500 AND 599) AS e5xx ${logBase} GROUP BY period`,
      );
      for (const row of logs) row.period = Number(row.period);
      const bots =
        await run(`SELECT bot AS name,vendor,bot_type AS class,if(verification IN('verified_range','verified_dns','verified_edge','range_mismatch'),verification,'unverified') AS verification,reporting_crawler_id AS bot_id,
        countIf(created_at>={start:DateTime64(6)}) AS requests,countIf(created_at<{start:DateTime64(6)}) AS previous,count() OVER() AS total ${logBase} AND ${ai}
        GROUP BY name,vendor,class,verification,bot_id ORDER BY requests DESC,previous DESC,name,vendor,class,verification,bot_id LIMIT 20`);
      const errorPaths =
        await run(`SELECT ${path} AS path,multiIf(status=403,'403',status=404,'404','5xx') AS statusGroup,count() AS requests,count() OVER() AS total ${logBase}
        AND created_at>={start:DateTime64(6)} AND (status IN(403,404) OR status BETWEEN 500 AND 599) GROUP BY path,statusGroup ORDER BY requests DESC,path,statusGroup LIMIT 20`);
      const pages =
        await run(`WITH counts AS(SELECT splitByChar('#',splitByChar('?',url_path)[1])[1] AS path,countIf(created_at>={start:DateTime64(6)}) AS pv,countIf(created_at<{start:DateTime64(6)}) AS previousPv,toUInt64(0) AS ai,toUInt64(0) AS previous
        FROM ${geographicEventRelation()} WHERE created_at BETWEEN {previousStart:DateTime64(6)} AND {end:DateTime64(6)} AND event_type NOT IN(2,5) GROUP BY path
        UNION ALL SELECT ${path} AS path,toUInt64(0) AS pv,toUInt64(0) AS previousPv,countIf(created_at>={start:DateTime64(6)}) AS ai,countIf(created_at<{start:DateTime64(6)}) AS previous ${logBase} AND ${ai} GROUP BY path)
        SELECT path,sum(counts.pv) AS pv,sum(counts.previousPv) AS previousPv,sum(counts.ai) AS ai,sum(counts.previous) AS previous,count() OVER() AS total FROM counts GROUP BY path ORDER BY pv+ai DESC,previousPv+previous DESC,path LIMIT 20`);
      const samples = await run(
        `SELECT created_at AS time,path,status,bot ${logBase} AND created_at>={start:DateTime64(6)} AND (status IN(403,404) OR status BETWEEN 500 AND 599) ORDER BY created_at DESC,id DESC LIMIT 20`,
      );
      for (const row of samples) row.time = String(row.time).replace(' ', 'T') + 'Z';
      const visits = `WITH attributed AS(SELECT *,argMinIf(tuple(utm_source,utm_medium,referrer_domain),tuple(created_at,event_id),event_type NOT IN(2,5)) OVER(PARTITION BY session_id,visit_id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS entry
        FROM ${geographicEventRelation()} WHERE created_at<={end:DateTime64(6)}),events AS(SELECT *,${period} AS period FROM attributed WHERE created_at>={previousStart:DateTime64(6)} AND event_type!=5),
        visits AS(SELECT period,visit_id,session_id,countIf(event_type NOT IN(2,5)) AS pv,any(entry) AS entry FROM events GROUP BY period,visit_id,session_id HAVING pv>0)`;
      const referrals = await run(
        `${visits} SELECT period,count() AS visits,sum(pv) AS pv FROM (SELECT *,entry.1 AS utm_source,entry.2 AS utm_medium,entry.3 AS referrer_domain FROM visits) e WHERE ${channelFilterColumn('e.')}='AI 搜索引荐' GROUP BY period`,
      );
      for (const row of referrals) row.period = Number(row.period);
      const goalParams = {
        ids: valid.map(r => r.id),
        types: valid.map(r => r.parameters.type),
        values: valid.map(r => r.parameters.value),
      };
      // CH 25.8 cannot bind parameters inside window specifications. Resolve
      // the period column before partitioning (ClickHouse issue #85192).
      const goalRows = await run(
        `WITH events AS(SELECT *,${period} AS period,countIf(event_type NOT IN(2,5)) OVER(PARTITION BY period,session_id,visit_id) AS visit_pv
        FROM ${geographicEventRelation()} WHERE created_at BETWEEN {previousStart:DateTime64(6)} AND {end:DateTime64(6)} AND event_type!=5)
        SELECT g.1 AS id,uniqExactIf(event_id,period=0) AS count,uniqExactIf(event_id,period=1) AS previous,
          uniqExactIf(tuple(visit_id,session_id),period=0 AND visit_pv>0) AS converted,uniqExactIf(tuple(visit_id,session_id),period=1 AND visit_pv>0) AS previousConverted
        FROM events ARRAY JOIN arrayFilter(g->((g.2='path' AND event_type=1) OR(g.2='event' AND event_type=2)) AND
          if(startsWith(g.3,'*') OR endsWith(g.3,'*'),if(g.2='path',url_path,event_name) LIKE replaceRegexpOne(replaceRegexpOne(g.3,'^[*]','%'),'[*]$','%'),if(g.2='path',url_path,event_name)=g.3),arrayZip({ids:Array(UUID)},{types:Array(String)},{values:Array(String)})) AS g
        GROUP BY id ORDER BY count DESC,id LIMIT 20`,
        goalParams,
      );
      const goals = goalRows.map(row => ({
        ...row,
        name: valid.find(d => d.id === row.id)!.name,
        type: valid.find(d => d.id === row.id)!.parameters.type,
        total: valid.length,
      }));
      if (goals.length < 20)
        for (const d of [...valid].sort((a, b) => a.id.localeCompare(b.id))) {
          if (!goals.some(g => g.id === d.id))
            goals.push({
              id: d.id,
              name: d.name,
              type: d.parameters.type,
              count: 0,
              previous: 0,
              converted: 0,
              previousConverted: 0,
              total: valid.length,
            });
          if (goals.length >= 20) break;
        }
      await reauthorize();
      check();
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
        live: { ...authorized.site, epoch: authorized.row.website_epoch },
        authorized,
        range,
        parsed: { data: p },
        generatedAt,
        catalogVersion,
        population,
        previousPopulation,
        repair: {
          generation: metadata.repairGeneration,
          revision: metadata.population.historyRevision ?? '0',
        },
      });
    });
  } catch (error) {
    check();
    if (error instanceof AiError) throw error;
    throw Object.assign(new AiError('facts_unavailable', '统计数据暂时不可读取，请稍后重试', 503), {
      cause: error,
    });
  }
}
