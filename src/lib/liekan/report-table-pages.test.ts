import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  human: vi.fn(),
  logs: vi.fn(),
  settings: vi.fn(),
  plotLogs: vi.fn(),
  conversions: vi.fn(),
  humanDays: vi.fn(),
  months: vi.fn(),
}));
vi.mock('./upstream/analytics', async importOriginal => ({
  ...(await importOriginal<typeof import('./upstream/analytics')>()),
  getHumanFacts: mocks.human,
  getHumanConversions: mocks.conversions,
  getHumanDays: mocks.humanDays,
}));
vi.mock('./upstream/logs', () => ({
  getLogFacts: mocks.logs,
  getLogToday: async () => ({ requests: 0, accepted: 0, abnormal: 0 }),
  getContentImpact: async () => [],
  getMonthlyAiShare: mocks.months,
  getPlotLogs: mocks.plotLogs,
}));
vi.mock('./store', () => ({ getSettings: mocks.settings }));
vi.mock('./upstream/server', () => ({ LiekanError: class extends Error {} }));
vi.mock('@/queries/sql', () => ({ getFunnel: vi.fn() }));

import { parseReportQuery } from './contracts/query';
import { buildReport } from './report';
import { reportLogRange } from './report-log-tables';

const params = { resource: 'overview', startAt: 0, endAt: 86400000, timezone: 'UTC' };
const website = { id: '5b4c0de0-6c47-5b51-8f53-11e5e8c79001', name: 'Test', domain: 'example.com' };

describe('parseReportQuery flat table pages', () => {
  it('normalizes tp_* keys into sorted tablePages', () => {
    const parsed = parseReportQuery({
      ...params,
      tp_topBody: '3',
      tp_apBody: '2',
      tp_blindList: '5001',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.tablePages).toEqual({ apBody: 2, blindList: 5001, topBody: 3 });
  });

  it('rejects non-whitelisted table names and invalid pages', () => {
    expect(parseReportQuery({ ...params, tp_goalBody: '2' }).success).toBe(false);
    expect(parseReportQuery({ ...params, tp_topBody: '0' }).success).toBe(false);
    expect(parseReportQuery({ ...params, tp_topBody: 'x' }).success).toBe(false);
  });

  it('accepts an already parsed object with tablePages intact', () => {
    const parsed = parseReportQuery({ ...params, tablePages: { topBody: 2 } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.tablePages).toEqual({ topBody: 2 });
  });
});

describe('buildReport serialization slicing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.human.mockResolvedValue({
      totals: { visits: 0, visitors: 0, pageviews: 0, bounces: 0, totaltime: 0 },
      daily: [],
      geo: [],
      sources: [],
      environment: [],
      pages: Array.from({ length: 25 }, (_, i) => ({
        path: `/page-${i + 1}`,
        pv: 25 - i,
        uv: i,
        entries: i,
        bounces: 0,
        duration: null,
      })),
      heatmap: [],
      goals: [],
      converted: 0,
      funnel: [],
      journeys: [],
      exits: [],
      dailySources: [],
      newVisitors: 0,
      previousSources: [],
      previousGoals: [],
    });
    mocks.logs.mockResolvedValue({
      summary: { requests: 0, ai: 0 },
      daily: [],
      bots: [],
      pages: [],
      statuses: [],
      hours: [],
      catalog: [],
      latest: null,
      recent: [],
      totalLogs: 0,
      previousBots: [],
    });
    mocks.settings.mockResolvedValue({ isDemo: false, rules: [], robots: '' });
    mocks.plotLogs.mockResolvedValue([]);
    mocks.humanDays.mockResolvedValue([]);
    mocks.months.mockResolvedValue([]);
    mocks.conversions.mockResolvedValue({ goals: [] });
  });

  it('caps the requested table to its page and records tablePages meta', async () => {
    const report = await buildReport(
      website,
      false,
      { ...params, tablePages: { topBody: 2 } },
      true,
    );
    expect(report.tables.topBody).toHaveLength(5);
    expect(report.tables.topBody[0].path).toBe('/page-21');
    expect(report.meta.tablePages).toEqual({ topBody: { page: 2, pageSize: 20, total: 25 } });
    expect(Object.keys(report.tables)).toEqual(['topBody']);
  });

  it('keeps the prepared current-day cutoff after the adapter finishes later', async () => {
    const cutoff = Date.parse('2026-11-03T04:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(cutoff);
    try {
      const parsed = parseReportQuery({
        resource: 'ai/pages',
        crawlerMetricsVersion: 1,
        startAt: Date.parse('2026-11-03T00:00:00Z'),
        endAt: Date.parse('2026-11-03T23:59:59Z'),
        timezone: 'UTC',
      });
      if (!parsed.success) throw new Error('invalid cutoff fixture');
      const range = reportLogRange(parsed.data);
      clock.mockReturnValue(cutoff + 5000);
      const result = await buildReport(website, false, parsed.data, true, false, undefined, {
        range,
        human: await mocks.human(),
        logs: await mocks.logs(),
      });
      expect(result.range.endAt).toBe(cutoff);
      expect(result.range.startAt).toBe(parsed.data.startAt);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps an existing catalog without measured content impact empty rather than disconnected', async () => {
    const result = await buildReport(
      website,
      false,
      { ...params, resource: 'content' },
      true,
      false,
      undefined,
      {
        catalogCount: 100006,
        human: await mocks.human(),
        logs: await mocks.logs(),
      },
    );
    expect(result.states.catalog).toBe('available');
    expect(result.charts.c1).toMatchObject({
      labels: [],
      state: 'empty',
      series: [
        { name: '发布内容 PV（7天）', values: [] },
        { name: 'AI 抓取增量', values: [] },
      ],
    });
  });

  it('retains the full catalog count in the log pipeline without loading catalog rows', async () => {
    const result = await buildReport(
      website,
      false,
      { ...params, resource: 'logs' },
      true,
      false,
      undefined,
      {
        catalogCount: 100006,
        human: await mocks.human(),
        logs: await mocks.logs(),
      },
    );
    expect(result.states.catalog).toBe('available');
    expect(result.tables.pipeList.find(row => row.name === '内容目录')).toEqual({
      name: '内容目录',
      detail: '100006 条目录记录',
      state: '已接入',
    });
  });

  it('caps pagable tables to the first page by default on the page-report path', async () => {
    const report = await buildReport(website, false, params, true);
    expect(report.tables.topBody).toHaveLength(20);
    expect(report.tables.topBody[0].path).toBe('/page-1');
    expect(report.meta.tablePages).toEqual({ topBody: { page: 1, pageSize: 20, total: 25 } });
  });

  it('skips requested pages for tables the resource does not expose', async () => {
    const report = await buildReport(
      website,
      false,
      { ...params, tablePages: { apBody: 3 } },
      true,
    );
    // overview 只暴露 topBody；apBody 不在展示切片中，不产生它的 meta 键也不会报错。
    expect(report.meta.tablePages).toEqual({ topBody: { page: 1, pageSize: 20, total: 25 } });
  });

  it('keeps the legacy report path full unless a page is explicitly requested', async () => {
    const legacy = await buildReport(website, false, params, false);
    expect(legacy.tables.topBody).toHaveLength(25);
    expect(legacy.meta.tablePages).toBeUndefined();
    const capped = await buildReport(
      website,
      false,
      { ...params, tablePages: { topBody: 2 } },
      false,
    );
    expect(capped.tables.topBody).toHaveLength(5);
    expect(capped.meta.tablePages).toEqual({ topBody: { page: 2, pageSize: 20, total: 25 } });
  });

  it('returns bounded blind-spot pages from 100005 catalog rows without truncating legacy or export', async () => {
    const logs = await mocks.logs();
    logs.catalog = Array.from({ length: 100005 }, (_, i) => ({
      path: `/blind-${i + 1}`,
      title: `Page ${i + 1}`,
      contentType: 'article',
    }));
    logs.latest = new Date(86400000).toISOString();
    const query = { ...params, resource: 'ai/pages' };
    const first = await buildReport(website, false, query, true);
    expect(first.tables.blindList).toHaveLength(20);
    expect(first.meta.tablePages?.blindList).toEqual({ page: 1, pageSize: 20, total: 100005 });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(100000);
    const last = await buildReport(website, false, { ...query, tp_blindList: '5001' }, true);
    expect(last.tables.blindList.map(row => row.path)).toEqual([
      '/blind-100001',
      '/blind-100002',
      '/blind-100003',
      '/blind-100004',
      '/blind-100005',
    ]);
    expect(last.meta.tablePages?.blindList).toEqual({ page: 5001, pageSize: 20, total: 100005 });
    const legacy = await buildReport(website, false, query, false);
    expect(legacy.tables.blindList).toHaveLength(100005);
    expect(legacy.meta.tablePages).toBeUndefined();
    const exported = await buildReport(
      website,
      false,
      { ...query, tp_blindList: '5001' },
      true,
      true,
    );
    expect(exported.tables.blindList).toHaveLength(100005);
    expect(exported.tables.blindList.at(-1)?.path).toBe('/blind-100005');
    expect(exported.meta.tablePages).toBeUndefined();
  }, 15000);

  it('indexes 100005 previous sources while preserving first match, channel fallback and missing labels', async () => {
    const human = await mocks.human();
    const count = 100005;
    const source = (index: number, sessions: number, extra = {}) => ({
      source: `source-${index}.test`,
      channel: '外部引荐',
      sessions,
      bounces: 0,
      conversions: 0,
      ...extra,
    });
    human.sources = Array.from({ length: count }, (_, i) => source(i, 20));
    human.previousSources = Array.from({ length: count }, (_, i) => source(i, 10));
    // A duplicate later row must not overwrite the first. A null label must not match undefined.
    human.previousSources.push(source(0, 1));
    human.previousSources.unshift(source(1, 4, { sourceLabel: null }));
    human.sources[2].channel = undefined;
    human.previousSources[3].channel = undefined;
    human.sources[3].sourceLabel = 'direct';
    human.previousSources.push(source(3, 5, { sourceLabel: 'direct' }));
    human.sources[4].channel = '其他渠道';
    const result = await buildReport(
      website,
      false,
      { ...params, resource: 'human/sources' },
      true,
    );
    expect(result.meta.tablePages?.srcBody).toEqual({ page: 1, pageSize: 20, total: count });
    expect(result.tables.srcBody).toHaveLength(20);
    expect(result.tables.srcBody.slice(0, 5).map(row => row.trend)).toEqual([
      100,
      100,
      100,
      300,
      null,
    ]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(100000);
  }, 15000);
});
