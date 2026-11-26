import { randomUUID } from 'node:crypto';
import { type AiFact, type AiFactsContext, sanitizeAiFactsContext } from '../ai/facts-contracts';
import { aiChangePercent, safeAiCount, sanitizeAiText } from '../ai/sanitize';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
function topMetadata(rows: Record<string, any>[], length = rows.length) {
  const total = rows.length ? safeAiCount(rows[0].total) : 0;
  return { total, omitted: Math.max(0, total - length), truncated: total > length };
}

export function renderAiFacts({
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
}: Record<string, any>): AiFactsContext {
  const emptyLog = { requests: 0n, ai: 0n, e403: 0n, e404: 0n, e5xx: 0n };
  const logRow = (n: number) => {
    const row = logs.find(row => row.period === n) ?? emptyLog;
    return {
      requests: safeAiCount(row.requests),
      aiRequests: safeAiCount(row.ai),
      errors403: safeAiCount(row.e403),
      errors404: safeAiCount(row.e404),
      errors5xx: safeAiCount(row.e5xx),
    };
  };
  const logCurrent = sources.connected ? logRow(0) : null,
    logPrevious = sources.connected ? logRow(1) : null;
  const humanState = !sources.browser ? 'not_connected' : current.pageviews ? 'available' : 'empty';
  const logState = !sources.connected
    ? 'not_connected'
    : logCurrent?.requests
      ? 'available'
      : 'empty';
  const sourceStates = {
    human: humanState,
    logs: logState,
    catalog: safeAiCount(sources.catalog) ? 'available' : 'not_connected',
    goals: !safeAiCount(sources.goals)
      ? 'not_connected'
      : safeAiCount(sources.invalid) === safeAiCount(sources.goals)
        ? 'unsupported'
        : goals.some(row => safeAiCount(row.count) > 0)
          ? 'available'
          : 'empty',
    aiReferrals: !identityReady
      ? 'unavailable'
      : !sources.browser
        ? 'not_connected'
        : referrals.some(row => row.period === 0 && safeAiCount(row.visits) > 0)
          ? 'available'
          : 'empty',
  } as AiFactsContext['sourceStates'];
  const refRow = (n: number) => referrals.find(row => row.period === n) ?? { visits: 0n, pv: 0n };
  const rc = refRow(0),
    rp = refRow(1);
  const errorCounts = (row: ReturnType<typeof logRow> | null) =>
    row
      ? {
          requests: safeAiCount(row.errors403 + row.errors404 + row.errors5xx),
          errors403: row.errors403,
          errors404: row.errors404,
          errors5xx: row.errors5xx,
        }
      : null;
  const currentErrors = errorCounts(logCurrent),
    previousErrors = errorCounts(logPrevious);
  const totalErrors = currentErrors?.requests ?? 0;
  const facts: AiFact[] = [
    {
      id: 'summary',
      label: '网站统计概况',
      state: humanState,
      data: {
        current: sources.browser
          ? {
              pageviews: current.pageviews,
              visitors: current.visitors,
              visits: current.visits,
            }
          : null,
        previous: sources.browser
          ? {
              pageviews: previous.pageviews,
              visitors: previous.visitors,
              visits: previous.visits,
            }
          : null,
        changePercent: {
          pageviews: aiChangePercent(current.pageviews, previous.pageviews),
          visitors: aiChangePercent(current.visitors, previous.visitors),
          visits: aiChangePercent(current.visits, previous.visits),
        },
        logs: logCurrent,
        previousLogs: logPrevious,
        scope: 'human browser events and imported server logs',
      },
    },
    {
      id: 'bots',
      label: 'AI 爬虫分类与变化',
      state: logState,
      data: {
        ...topMetadata(bots),
        requests: logCurrent?.aiRequests ?? null,
        previousRequests: logPrevious?.aiRequests ?? null,
        changePercent:
          logCurrent && logPrevious
            ? aiChangePercent(logCurrent.aiRequests, logPrevious.aiRequests)
            : null,
        rows: bots.map(row => ({
          name: sanitizeAiText(row.name),
          botId: row.bot_id ?? null,
          vendor: sanitizeAiText(row.vendor),
          class: row.class,
          verification: row.verification,
          requests: safeAiCount(row.requests),
          previousRequests: safeAiCount(row.previous),
          changePercent: aiChangePercent(safeAiCount(row.requests), safeAiCount(row.previous)),
        })),
        scope:
          'AI-qualified requests at ingestion; legacy recorded-type fallback; declared UA with separate verification',
      },
    },
    {
      id: 'log-errors',
      label: '日志 403、404 与服务端错误',
      state: logState,
      data: {
        ...topMetadata(errorPaths),
        requests: currentErrors?.requests ?? null,
        previousRequests: previousErrors?.requests ?? null,
        current: currentErrors,
        previous: previousErrors,
        changePercent:
          currentErrors && previousErrors
            ? aiChangePercent(currentErrors.requests, previousErrors.requests)
            : null,
        paths: errorPaths.map(row => ({
          path: row.path,
          statusGroup: row.statusGroup,
          requests: safeAiCount(row.requests),
        })),
        samples: samples.map(row => ({
          time: new Date(row.time).toISOString(),
          path: row.path,
          status: row.status,
          bot: sanitizeAiText(row.bot),
        })),
        sampleTotal: totalErrors,
        samplesOmitted: Math.max(0, totalErrors - samples.length),
        samplesTruncated: totalErrors > samples.length,
        sampleMethod: 'latest_by_created_at_desc_id_desc',
        scope:
          'imported logs: HTTP 403, 404 and 500–599; current and previous aggregate counts; paths and latest samples from current period; coverage unverified',
      },
    },
    {
      id: 'ai-referrals',
      label: 'AI 来源引荐',
      state: sourceStates.aiReferrals,
      data: {
        visits: sources.browser && identityReady ? safeAiCount(rc.visits) : null,
        pageviews: sources.browser && identityReady ? safeAiCount(rc.pv) : null,
        previousVisits: sources.browser && previousIdentityReady ? safeAiCount(rp.visits) : null,
        previousPageviews: sources.browser && previousIdentityReady ? safeAiCount(rp.pv) : null,
        changePercent: aiChangePercent(
          identityReady ? safeAiCount(rc.visits) : null,
          previousIdentityReady ? safeAiCount(rp.visits) : null,
        ),
        scope: 'first browser pageview attribution using the approved AI channel catalog',
      },
    },
    {
      id: 'pages',
      label: '主要页面',
      state:
        current.pageviews || (logCurrent?.aiRequests ?? 0)
          ? 'available'
          : !sources.browser && !sources.connected
            ? 'not_connected'
            : 'empty',
      data: {
        ...topMetadata(pages),
        rows: pages.map(row => ({
          path: row.path,
          humanPageviews: sources.browser ? safeAiCount(row.pv) : null,
          previousHumanPageviews: sources.browser ? safeAiCount(row.previousPv) : null,
          aiRequests: sources.connected ? safeAiCount(row.ai) : null,
          previousAiRequests: sources.connected ? safeAiCount(row.previous) : null,
        })),
        scope:
          'browser paths and encoded imported AI request paths; union of current and previous periods ranked by current then previous counts; stored forms may differ; query and fragment excluded',
      },
    },
    {
      id: 'goals',
      label: '已配置转化目标',
      state: sourceStates.goals,
      data: {
        ...topMetadata(goals),
        configured: safeAiCount(sources.goals),
        invalidDefinitions: safeAiCount(sources.invalid),
        rows: goals.map(row => ({
          name: sanitizeAiText(row.name),
          type: row.type,
          count: safeAiCount(row.count),
          previousCount: safeAiCount(row.previous),
          convertedVisits: identityReady ? safeAiCount(row.converted) : null,
          previousConvertedVisits: previousIdentityReady
            ? safeAiCount(row.previousConverted)
            : null,
          ratePercent:
            identityReady && current.visits > 0
              ? Math.round((safeAiCount(row.converted) / current.visits) * 10000) / 100
              : null,
          previousRatePercent:
            previousIdentityReady && previous.visits > 0
              ? Math.round((safeAiCount(row.previousConverted) / previous.visits) * 10000) / 100
              : null,
          changePercent: aiChangePercent(safeAiCount(row.count), safeAiCount(row.previous)),
        })),
        scope:
          'configured goal matching events; rates use converted browser visits divided by browser visits',
      },
    },
  ];
  return sanitizeAiFactsContext({
    protocolVersion: 1,
    id: randomUUID(),
    website: { id: live.id, name: sanitizeAiText(live.name), domain: live.domain ?? null },
    space: authorized.space,
    websiteEpoch: live.epoch,
    ...range,
    timeZone: parsed.data.timezone,
    generatedAt: generatedAt.toISOString(),
    metricVersion: 'liekan-ai-facts-v1',
    catalogVersion,
    trafficPolicyVersion: TRAFFIC_POLICY_VERSION,
    population,
    previousPopulation,
    historyRepair: repair || { generation: null, revision: '0' },
    promptVersion: 'liekan-ai-prompt-v1',
    coverage: 'unverified',
    sourceStates,
    businessProfile: { state: 'unconfigured', value: null },
    metrics: [
      ...(['pageviews', 'visitors', 'visits'] as const).map(key => ({
        key,
        label: { pageviews: '浏览量', visitors: '访客', visits: '访问次数' }[key],
        value: sources.browser ? current[key] : null,
        state: key !== 'pageviews' && !identityReady ? 'unavailable' : humanState,
        changePercent: aiChangePercent(current[key], previous[key]),
      })),
      {
        key: 'aiRequests',
        label: 'AI 爬虫请求',
        value: logCurrent?.aiRequests ?? null,
        state: logState,
        changePercent:
          logCurrent && logPrevious
            ? aiChangePercent(logCurrent.aiRequests, logPrevious.aiRequests)
            : null,
      },
      {
        key: 'aiReferrals',
        label: 'AI 引荐访问',
        value: sources.browser && identityReady ? safeAiCount(rc.visits) : null,
        state: sourceStates.aiReferrals,
        changePercent: aiChangePercent(
          identityReady ? safeAiCount(rc.visits) : null,
          previousIdentityReady ? safeAiCount(rp.visits) : null,
        ),
      },
    ],
    facts,
  });
}
