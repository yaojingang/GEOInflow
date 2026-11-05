import { currentAnalyticsSignal } from './cache-context';
import { createHash, randomUUID } from 'node:crypto';
import { EXPORT_MAX_BYTES, EXPORT_MAX_ROWS } from '../contracts/exports';
import {
  addKeywordCandidate,
  type KeywordCandidate,
  type KeywordRow,
  keywordConditionsSchema,
  selectKeywords,
  supportsKeywordRedirect,
} from '../contracts/keywords';
import { applyReportPopulation } from '../contracts/population-results';
import type { ReportQuery } from '../contracts/query';
import type { LiekanReport } from '../contracts/report';
import { getSettings } from '../store';
import { warehouseEnabled } from '../warehouse/authority-routing';
import { convertedJoin, humanVisitsSql, visitMetrics } from './analytics';
import { readBrowserPopulation } from './browser-population';
import { currentCacheContext, withoutQueryCache } from './cache-context';
import { LiekanError } from './errors';
import {
  analyticsCache,
  analyticsCacheKey,
  type CachedResult,
  websiteCacheTag,
} from './query-cache';
import { getQuerySnapshot } from './query-snapshot';
import { query, reportSnapshot } from './server';
import { TRAFFIC_POLICY_VERSION, withTrafficPolicy } from './traffic-query';

type Website = LiekanReport['website'];
export type KeywordFacts = {
  rows: KeywordRow[];
  hasGoals: boolean;
  snapshot: string;
  readAt: number;
};
export function validateKeywordRange(p: { startAt: number; endAt: number; timezone: string }) {
  if (
    p.endAt < p.startAt ||
    p.endAt - p.startAt > 1096 * 86400000 ||
    p.endAt > Date.now() + 86400000
  )
    throw new LiekanError('日期范围无效，上限 3 年');
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: p.timezone }).format();
  } catch {
    throw new LiekanError('时区无效');
  }
  if (process.env.CLICKHOUSE_URL) throw new LiekanError('来源关键词当前支持 PostgreSQL', 501);
}

// A database cursor bounds raw evidence in memory and evaluates the entry/goal population once.
// Only redacted aggregates leave this module or enter a shared cache.
export async function readKeywordFacts(
  websiteId: string,
  p: { startAt: number; endAt: number; timezone: string },
  signal?: AbortSignal,
): Promise<KeywordFacts> {
  validateKeywordRange(p);
  if (warehouseEnabled()) throw new Error('warehouse-keyword-bounded-reader-required');
  const tx = getQuerySnapshot();
  if (!tx) return reportSnapshot(() => readKeywordFacts(websiteId, p, signal));
  const groups = new Map<string, KeywordRow>();
  const cursor = `keyword_${randomUUID().replaceAll('-', '')}`;
  const sql = `${humanVisitsSql(true, false)} SELECT v.referrer,v."utmSource",v."utmMedium",v."utmCampaign",v."referrerPath",v."referrerQuery",v."utmTerm",${visitMetrics}
    FROM visits v ${convertedJoin} GROUP BY 1,2,3,4,5,6,7`;
  let bytes = 0,
    candidates = 0;
  const aborted = () => {
    if (signal?.aborted) throw new LiekanError('导出已取消', 499);
  };
  aborted();
  await tx.$executeRawUnsafe(
    `DECLARE ${cursor} NO SCROLL CURSOR FOR ${withTrafficPolicy(sql)}`,
    websiteId,
    new Date(p.startAt),
    new Date(p.endAt),
    p.timezone,
  );
  try {
    for (;;) {
      aborted();
      const batch = await query<KeywordCandidate>(`FETCH FORWARD 500 FROM ${cursor}`);
      for (const row of batch) {
        if (!addKeywordCandidate(groups, row)) continue;
        candidates++;
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (candidates > EXPORT_MAX_ROWS || bytes > EXPORT_MAX_BYTES)
          throw new LiekanError('关键词证据超过 100,000 组或 50 MiB，请缩小统计范围', 413);
      }
      if (batch.length < 500) break;
    }
    aborted();
    const [goals] = await query<{ present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM report WHERE website_id=$1::uuid AND type='goal' AND coalesce(parameters->>'value','')!='' AND jsonb_typeof(parameters->'steps') IS DISTINCT FROM 'array') AS present",
      websiteId,
    );
    const rows = [...groups.values()];
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          1,
          goals.present,
          rows
            .map(row => [row.id, row.sessions, row.bounces, row.conversions])
            .sort((a, b) =>
              String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0,
            ),
        ]),
      )
      .digest('hex')
      .slice(0, 32);
    const snapshot = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
    return { rows, hasGoals: goals.present, snapshot, readAt: Date.now() };
  } finally {
    await Promise.resolve(tx.$executeRawUnsafe(`CLOSE ${cursor}`)).catch(() => {});
  }
}

export function keywordReport(
  website: Website,
  p: ReportQuery,
  facts: KeywordFacts,
  settings: Awaited<ReturnType<typeof getSettings>>,
  canManage = false,
  prepared?: { selected: ReturnType<typeof selectKeywords>; count: number; engines: string[] },
): LiekanReport {
  const selected =
    prepared?.selected ??
    selectKeywords(
      facts.rows,
      keywordConditionsSchema.parse(p),
      facts.hasGoals,
      supportsKeywordRedirect(p),
    );
  const changed = Boolean(p.keywordSnapshot && p.keywordSnapshot !== facts.snapshot && p.page > 1);
  const count = prepared?.count ?? selected.rows.length;
  const page = changed ? 1 : Math.min(p.page, Math.max(1, Math.ceil(count / 20)));
  const state = selected.total ? 'available' : 'empty';
  const scope = `${p.engine || '全部搜索引擎'} · 所选统计范围`;
  return {
    contractVersion: 2,
    website,
    range: { startAt: p.startAt, endAt: p.endAt, timezone: p.timezone },
    states: {
      human: state,
      logs: 'not_connected',
      catalog: 'not_connected',
      goals: facts.hasGoals ? 'available' : 'not_connected',
    },
    cards: [
      { key: 'keyword-total', label: '搜索渠道会话', value: selected.total, detail: scope, state },
      {
        key: 'keyword-referrer',
        label: '来源搜索词会话',
        value: selected.referrer,
        detail: '来源网址中可读取的搜索词',
        state,
      },
      {
        key: 'keyword-utm',
        label: 'UTM 关键词会话',
        value: selected.utm,
        detail: 'utm_term 手动标记',
        state,
      },
      {
        key: 'keyword-availability',
        label: '关键词可用率',
        value: selected.availability,
        unit: '%',
        detail: '含来源搜索词与 UTM 手动标记',
        state,
      },
    ],
    charts: {},
    tables: {
      keywordBody: prepared ? selected.rows : selected.rows.slice((page - 1) * 20, page * 20),
    },
    insights: [],
    meta: {
      demo: settings.isDemo,
      canManage,
      latestImportAt: null,
      ruleCount: 0,
      aiCrawlerEnabled: settings.aiCrawlerEnabled ?? true,
      keywordSnapshot: facts.snapshot,
      keywordReset: changed,
      keywordReadAt: facts.readAt,
      keywordEngines: prepared?.engines ?? [...new Set(facts.rows.map(row => row.engine))].sort(),
      keywordHasGoals: facts.hasGoals,
      tablePages: { keywordBody: { page, pageSize: 20, total: count } },
    },
  };
}
export async function readKeywordPage(
  website: Website,
  p: ReportQuery,
  ttl: number,
  refresh: boolean,
): Promise<CachedResult<LiekanReport>> {
  validateKeywordRange(p);
  if (warehouseEnabled()) {
    const { withWarehouseKeywords } = await import('./warehouse-keywords');
    // Cache only the requested bounded page and scalar metadata. Conditions,
    // snapshot/reset state and page all participate in the cache identity.
    const { refresh: _refresh, ...parameters } = p;
    return analyticsCache.read(
      analyticsCacheKey(`source-keywords-ch-v1-${TRAFFIC_POLICY_VERSION}`, [
        process.env.DATABASE_URL,
        website.id,
        parameters,
      ]),
      ttl,
      [websiteCacheTag(website.id)],
      () =>
        reportSnapshot(() =>
          withoutQueryCache(() =>
            withWarehouseKeywords(
              website.id,
              p,
              async selection => {
                const count = await selection.rows.count();
                const changed = Boolean(
                  p.keywordSnapshot && p.keywordSnapshot !== selection.snapshot && p.page > 1,
                );
                const page = changed ? 1 : Math.min(p.page, Math.max(1, Math.ceil(count / 20)));
                const rows = await selection.rows.page((page - 1) * 20, 20);
                const report = keywordReport(
                  website,
                  p,
                  {
                    rows: [],
                    hasGoals: selection.hasGoals,
                    snapshot: selection.snapshot,
                    readAt: selection.readAt,
                  },
                  await getSettings(website.id),
                  false,
                  {
                    selected: {
                      rows,
                      total: selection.total,
                      referrer: selection.referrer,
                      utm: selection.utm,
                      availability: selection.availability,
                    },
                    count,
                    engines: selection.engines,
                  },
                );
                return applyReportPopulation(
                  report,
                  await readBrowserPopulation(
                    website.id,
                    new Date(p.startAt),
                    new Date(p.endAt),
                    p.timezone,
                  ),
                );
              },
              currentAnalyticsSignal(),
            ),
          ),
        ),
      refresh,
    );
  }
  const key = analyticsCacheKey(`source-keywords-v4-${TRAFFIC_POLICY_VERSION}`, [
    process.env.DATABASE_URL,
    website.id,
    p.startAt,
    p.endAt,
    p.timezone,
  ]);
  const result = await analyticsCache.read(
    key,
    ttl,
    [websiteCacheTag(website.id)],
    () =>
      reportSnapshot(() =>
        withoutQueryCache(async () => ({
          facts: await readKeywordFacts(website.id, p),
          settings: await getSettings(website.id),
          population: await readBrowserPopulation(
            website.id,
            new Date(p.startAt),
            new Date(p.endAt),
            p.timezone,
          ),
        })),
      ),
    refresh,
  );
  return {
    ...result,
    value: applyReportPopulation(
      keywordReport(website, p, result.value.facts, result.value.settings),
      result.value.population,
    ),
  };
}
