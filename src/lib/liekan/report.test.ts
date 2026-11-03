import { populationFromRow } from './upstream/browser-population';
import { identityUnavailableReason } from './contracts/population-results';
import { translateSystemText } from './i18n/text';
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

import { liekanReportSchema } from './contracts/report';
import { pageReportParts, type ReportResource } from './contracts/page-report';
import { buildReport } from './report';
import { withDashboardClock } from './upstream/dashboard-clock';
import { sharedReportParts } from './contracts/shared-report';
import { geographyLabel, regionName } from './contracts/geography';

const params = { resource: 'overview', startAt: 0, endAt: 86400000, timezone: 'UTC' };
const website = { id: '5b4c0de0-6c47-5b51-8f53-11e5e8c79001', name: 'Test', domain: 'example.com' };

it.each([
  { method: 'edge', status: 'verified_edge', subjectId: 'gptbot', evidenceHash: 'a'.repeat(64) },
  null,
  'legacy-proof',
])('preserves crawler identity proof in scalar report rows: %s', async identityEvidence => {
  const logs = await mocks.logs();
  mocks.logs.mockResolvedValue({
    ...logs,
    recent: [{
      time: '1970-01-01T01:00:00Z', path: '/a', status: 200, bot: 'GPTBot', botId: 'gptbot',
      verification: 'verified_edge', identityEvidence,
    }],
  });
  const report = await buildReport(website, false, { ...params, resource: 'logs' });
  const row = report.tables.logBody[0];
  expect(row.identityEvidence).toBe(
    identityEvidence && typeof identityEvidence === 'object'
      ? JSON.stringify(identityEvidence)
      : identityEvidence,
  );
  expect(row.verification).toBe('verified_edge');
  expect(row.botId).toBe('gptbot');
  if (identityEvidence && typeof identityEvidence === 'object')
    expect(JSON.parse(String(row.identityEvidence))).toEqual(identityEvidence);
  expect(liekanReportSchema.safeParse(report).success).toBe(true);
});

it('shows automation evidence for an unregistered spider without granting an official identity', async () => {
  const logs = await mocks.logs();
  const unknown = {
    bot: '其他',
    recognitionState: 'unknown',
    aiEligible: false,
    path: '/cases/',
    time: '1970-01-01T01:00:00Z',
  };
  mocks.logs.mockResolvedValue({
    ...logs,
    recent: [
      { ...unknown, userAgent: 'YisouSpider' },
      { ...unknown, userAgent: 'Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36' },
      { ...unknown, userAgent: '' },
    ],
  });
  const report = await buildReport(website, false, { ...params, resource: 'logs' });
  expect(report.tables.logBody.map(row => row.classification)).toEqual([
    '自动化特征 · 身份未核验',
    '未知／未分类',
    '未知／未分类',
  ]);
  expect(
    report.tables.logBody.every(row => row.recognitionState === 'unknown' && !row.aiEligible),
  ).toBe(true);
});

it.each(['gptbot', null])(
  'keeps the selected %s identity separate in the estimated crawl sequence',
  async botId => {
    const logs = await mocks.logs();
    const selected = {
      bot: 'GPTBot',
      botId,
      path: '/selected',
      time: '1970-01-01T01:00:00Z',
      status: 200,
    };
    mocks.logs.mockResolvedValue({
      ...logs,
      latest: selected.time,
      recent: [
        selected,
        { ...selected, botId: botId === null ? 'gptbot' : null, path: '/other-identity' },
        { ...selected, path: '/earlier', time: '1970-01-01T00:30:00Z' },
      ],
    });
    const report = await buildReport(website, false, { ...params, resource: 'ai/preference' });
    expect(report.tables.pathList.map(row => row.path)).toEqual(['/earlier', '/selected']);
    expect(report.tables.pathList.every(row => row.botId === botId)).toBe(true);
  },
);

it.each(['gptbot', null])(
  'retains the winning %s crawler identity in page summaries',
  async botId => {
    const human = await mocks.human(),
      logs = await mocks.logs();
    mocks.human.mockResolvedValue({
      ...human,
      pages: [{ path: '/a', pv: 4, uv: 4, entries: 4, duration: null, bounces: 0 }],
    });
    mocks.logs.mockResolvedValue({
      ...logs,
      latest: '1970-01-01T01:00:00Z',
      pages: [
        {
          path: '/a',
          bot: 'GPTBot',
          botId: botId === null ? 'gptbot' : null,
          requests: 1,
          lastCrawled: '1970-01-01T01:00:00Z',
        },
        { path: '/a', bot: 'GPTBot', botId, requests: 9, lastCrawled: '1970-01-01T01:00:00Z' },
      ],
    });
    const report = await buildReport(website, false, params);
    expect(report.tables.apBody[0]).toMatchObject({ bot: 'GPTBot', botId, bots: 2, requests: 10 });
    expect(report.tables.topBody[0]).toMatchObject({ bot: 'GPTBot', botId, aiRequests: 10 });
  },
);

it('keeps equal-count pages and content preferences stable across SQL row order', async () => {
  const logs = await mocks.logs();
  const rows = ['/b', '/a'].map(path => ({
    path, bot: 'GPTBot', botId: 'gptbot', requests: 5,
    lastCrawled: '1970-01-01T01:00:00Z',
  }));
  const reports = [];
  for (const pages of [rows, [...rows].reverse()]) {
    mocks.logs.mockResolvedValue({
      ...logs, pages,
      bots: [{ name: 'GPTBot', botId: 'gptbot', vendor: 'OpenAI', type: '训练', requests: 10, pages: 2, lastVisit: rows[0].lastCrawled }],
      catalog: [{ path: '/a', type: 'article' }, { path: '/b', type: 'docs' }],
    });
    reports.push(await buildReport(website, false, { ...params, resource: 'ai/pages', crawlerMetricsVersion: 1 }));
  }
  expect(reports[0].tables.apBody.map(row => row.path)).toEqual(['/a', '/b']);
  expect(reports[1].tables.apBody).toEqual(reports[0].tables.apBody);
  expect(reports[0].tables.botBody[0].preference).toBe('article（50% 抓取集中）');
  expect(reports[1].tables.botBody).toEqual(reports[0].tables.botBody);
});

it('uses catalog titles and ranks two crawler identities per page without changing totals', async () => {
  const logs = await mocks.logs();
  const page = { path: '/article', lastCrawled: '1970-01-01T01:00:00Z' };
  mocks.logs.mockResolvedValue({
    ...logs,
    latest: page.lastCrawled,
    pages: [
      { ...page, bot: 'ThirdBot', botId: null, requests: 1 },
      { ...page, bot: 'GPTBot', botId: null, requests: 8 },
      { ...page, bot: 'GPTBot', botId: 'gptbot', requests: 12 },
      { ...page, path: '/missing', bot: 'OnlyBot', botId: null, requests: 2 },
      { ...page, path: '/blank', bot: 'OnlyBot', botId: null, requests: 1 },
    ],
    catalog: [
      { path: '/article', title: '文章标题 <test>' },
      { path: '/blank', title: '  ' },
    ],
  });
  const report = await buildReport(website, false, { ...params, resource: 'ai/pages' }, true);
  expect(report.tables.apBody[0]).toMatchObject({
    title: '文章标题 <test>',
    requests: 21,
    bots: 3,
    heat: 100,
    bot: 'GPTBot',
    botId: 'gptbot',
    bot2: 'GPTBot',
    bot2Id: null,
  });
  expect(report.tables.apBody.slice(1).every(row => row.title === null && row.bot2 === null)).toBe(
    true,
  );
  expect(liekanReportSchema.shape.tables.safeParse(report.tables).success).toBe(true);
});

it('keeps equal-count crawler ranks deterministic across input order', async () => {
  const logs = await mocks.logs();
  const rows = ['ZuluBot', 'AlphaBot', 'BetaBot'].map(bot => ({
    path: '/a',
    bot,
    botId: null,
    requests: 5,
    lastCrawled: '1970-01-01T01:00:00Z',
  }));
  for (const pages of [rows, [...rows].reverse()]) {
    mocks.logs.mockResolvedValue({ ...logs, pages });
    const report = await buildReport(website, false, { ...params, resource: 'ai/pages' });
    expect(report.tables.apBody[0]).toMatchObject({
      bot: 'AlphaBot',
      bot2: 'BetaBot',
      requests: 15,
    });
  }
});

it('matches generated and supplied direct-source trends by their distinct display identities', async () => {
  const human = await mocks.human();
  mocks.human.mockResolvedValue({
    ...human,
    totals: { visits: 10, visitors: 10, pageviews: 10, bounces: 0, totaltime: 0 },
    sources: [
      { source: '直接访问', channel: '直接访问', sourceLabel: 'direct', sessions: 3, bounces: 0 },
      { source: '直接访问', channel: '直接访问', referrer: '直接访问', sessions: 7, bounces: 0 },
    ],
    previousSources: [
      { source: '直接访问', channel: '直接访问', sourceLabel: 'direct', sessions: 2 },
      { source: '直接访问', channel: '直接访问', referrer: '直接访问', sessions: 5 },
    ],
  });
  const report = await buildReport(website, false, { ...params, resource: 'human/sources' });
  expect(report.tables.srcBody.find(row => row.sourceLabel === 'direct')).toMatchObject({
    sessions: 3,
    trend: 50,
  });
  expect(report.tables.srcBody.find(row => row.referrer === '直接访问')).toMatchObject({
    sessions: 7,
    trend: 40,
  });
});

it('keeps keywords on the dedicated page contract and rejects the full report path before reading', async () => {
  await expect(
    buildReport(website, false, { ...params, resource: 'human/keywords' }),
  ).rejects.toThrow('分页统计接口');
  expect(mocks.human).not.toHaveBeenCalled();
  expect(mocks.logs).not.toHaveBeenCalled();
});

it('builds the share profile without log rows or unrelated statistics and bounds trends to the selected dates', async () => {
  const startAt = 3 * 86400000;
  const report = await buildReport(
    website,
    false,
    { ...params, startAt, endAt: startAt + 86400000 },
    'share',
  );
  expect(Object.keys(report.charts)).toEqual(expect.arrayContaining([...sharedReportParts.charts]));
  expect(Object.keys(report.charts)).toHaveLength(8);
  expect(Object.keys(report.tables).sort()).toEqual(['cityBody', 'envGrid']);
  expect(mocks.logs.mock.calls[0][9]).toEqual(sharedReportParts.logs);
  expect(mocks.human.mock.calls[0][4]).toEqual(sharedReportParts.human);
  expect(mocks.humanDays.mock.calls[0][1]).toEqual(new Date(startAt));
  expect(mocks.months).not.toHaveBeenCalled();
  expect(mocks.conversions).not.toHaveBeenCalled();
  const localRange = await buildReport(
    website,
    false,
    {
      ...params,
      startAt: Date.parse('2026-09-05T16:00:00Z'),
      endAt: Date.parse('2026-10-05T15:59:59Z'),
      timezone: 'Asia/Shanghai',
    },
    'share',
  );
  expect(localRange.insights[0]).toMatch(/^2026-09-06 至 2026-10-05/);
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.human.mockResolvedValue({
    totals: { visits: 0, visitors: 0, pageviews: 0, bounces: 0, totaltime: 0 },
    daily: [],
    geo: [],
    sources: [],
    environment: [],
    pages: [],
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
    catalog: [{ path: '/a', type: '文档', wordCount: 300, structureScore: 70 }],
    latest: null,
    recent: [],
    totalLogs: 0,
    previousBots: [],
  });
  mocks.settings.mockResolvedValue({ isDemo: false, rules: [], robots: '' });
  mocks.plotLogs.mockResolvedValue([]);
  mocks.conversions.mockResolvedValue(0);
  mocks.humanDays.mockResolvedValue({ rows: [] });
  mocks.months.mockResolvedValue([]);
});

it.each([
  ['2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z', 'UTC', 30],
  ['2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', 'UTC', 7],
  ['2025-11-02T07:00:00Z', '2025-11-03T08:00:00Z', 'America/Los_Angeles', 1],
  ['2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z', 'America/Los_Angeles', 1],
  ['2026-03-07T21:00:00Z', '2026-03-08T21:00:00Z', 'America/Los_Angeles', 1],
] as const)('uses the selected day count for half-open crawler averages (%s to %s)', async (start, end, timezone, days) => {
  const logs = await mocks.logs();
  mocks.logs.mockResolvedValue({
    ...logs, latest: start, summary: { requests: 300, ai: 300 },
    bots: [{ name: 'GPTBot', vendor: 'OpenAI', type: '训练', requests: 300, pages: 1, lastVisit: start }],
    pages: [{ path: '/a', bot: 'GPTBot', type: '训练', requests: 300, lastCrawled: start }],
  });
  const r = await buildReport(website, false, {
    ...params, resource: 'ai/overview', startAt: Date.parse(start), endAt: Date.parse(end),
    timezone, crawlerMetricsVersion: 1,
  });
  const average = Math.round(300 / days * 100) / 100;
  expect(r.tables.botBody[0].dailyAverage).toBe(average);
  expect(r.cards.find(card => card.key === '单页日均最高抓取').value).toBe(average);
});

it('describes a half-open crawler interval using its included local dates', async () => {
  const r = await buildReport(website, false, {
    ...params, resource: 'ai/preference', startAt: Date.parse('2026-01-01T00:00:00Z'),
    endAt: Date.parse('2026-01-31T00:00:00Z'), timezone: 'UTC', crawlerMetricsVersion: 1,
  }, true);
  expect(r.insights[0]).toContain('2026-01-01 至 2026-01-30');
});

it.each([
  ['Asia/Shanghai', '2026-09-05T16:00:00Z', '2026-10-05T15:59:59.999Z'],
  ['Pacific/Honolulu', '2026-09-06T10:00:00Z', '2026-10-06T09:59:59.999Z'],
])('describes the overview using the selected local dates in %s', async (timezone, from, to) => {
  const startAt = Date.parse(from), endAt = Date.parse(to);
  const report = await buildReport(website, false, {
    ...params, resource: 'overview', startAt, endAt, timezone,
  }, true);
  expect(report.insights[0]).toMatch(/^2026-09-06 至 2026-10-05/);
  expect(report.range).toMatchObject({ startAt, endAt, timezone });
  expect(mocks.human.mock.calls[0][1]).toEqual(new Date(startAt));
  expect(mocks.human.mock.calls[0][2]).toEqual(new Date(endAt));
});

it('keeps a stable current-day selection while reporting its actual read cutoff', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const now = Date.parse('2026-10-23T06:00:00Z');
  vi.setSystemTime(now);
  try {
    const r = await buildReport(website, false, {
      ...params, resource: 'ai/bots', startAt: Date.parse('2026-09-23T16:00:00Z'),
      endAt: Date.parse('2026-10-23T16:00:00Z'), timezone: 'Asia/Shanghai', crawlerMetricsVersion: 1,
    }, true);
    expect(r.range.endAt).toBe(now);
    expect(mocks.logs.mock.calls[0][2]).toEqual(new Date(now));
  } finally {
    vi.useRealTimers();
  }
});

it('rebuilds the same DST-day metrics and freshness from the actual export cutoff', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const now = Date.parse('2026-11-02T07:30:00Z');
  vi.setSystemTime(now);
  const logs = await mocks.logs();
  mocks.logs.mockResolvedValue({
    ...logs, latest: new Date(now).toISOString(), summary: { requests: 300, ai: 300 },
    bots: [{ name: 'GPTBot', vendor: 'OpenAI', type: '训练', requests: 300, pages: 1, lastVisit: new Date(now).toISOString() }],
    pages: [{ path: '/a', bot: 'GPTBot', type: '训练', requests: 300, lastCrawled: new Date(now).toISOString() }],
    catalog: [{ path: '/a', updatedAt: new Date(now - 23.75 * 3600000).toISOString() }],
  });
  const input = { ...params, resource: 'ai/bots', timezone: 'America/Los_Angeles',
    startAt: Date.parse('2026-10-03T07:00:00Z'), endAt: Date.parse('2026-11-02T08:00:00Z'), crawlerMetricsVersion: 1 };
  try {
    const shown = await buildReport(website, false, input);
    const exported = await buildReport(website, false, { ...input, ...shown.range });
    expect(shown.tables.botBody[0].dailyAverage).toBe(10);
    expect(shown.tables.apBody[0].freshness).toBe('0 天');
    expect(exported.tables.botBody).toEqual(shown.tables.botBody);
    expect(exported.tables.apBody).toEqual(shown.tables.apBody);
    expect(exported.range).toEqual(shown.range);
  } finally {
    vi.useRealTimers();
  }
});

describe('report evidence states', () => {
  it('keeps published metric keys while clarifying visitor display labels', async () => {
    const report = await buildReport(website, false, params);
    expect(report.cards.find(card => card.key === '人类访客（UV）')).toMatchObject({
      label: '访客（UV）',
      detail: '按当前流量策略去重，可能含未识别自动化',
    });
    expect(report.cards.find(card => card.key === '案例页 AI/人 比值')).toMatchObject({
      label: '案例页 AI/浏览 比值',
    });
  });
  it('accepts existing report contracts without geography display metadata and validates stable city IDs when provided', async () => {
    const report = await buildReport(website, false, params);
    expect(liekanReportSchema.safeParse(report).success).toBe(true);
    const legacy = structuredClone(report);
    delete legacy.meta.geography;
    expect(liekanReportSchema.safeParse(legacy).success).toBe(true);
    const invalid = structuredClone(report);
    invalid.meta.geography.cards = {
      test: { country: 'CN', region: 'CN-61', city: '西安', cityId: '1790630' as any },
    };
    expect(liekanReportSchema.safeParse(invalid).success).toBe(false);
  });
  it('excludes missing provinces from rankings and retains observed city metadata', async () => {
    const human = await mocks.human();
    human.totals.visits = 1;
    human.geo = [
      {
        country: 'CN',
        region: null,
        city: 'Unlisted Town',
        sessions: 1,
        duration: 0,
        bounces: 0,
        conversions: 0,
      },
    ];
    mocks.human.mockResolvedValue(human);
    const report = await buildReport(website, false, { ...params, resource: 'human/geo' }, true);
    expect(report.charts.g1.labels).toEqual([]);
    expect(report.charts.g1.series[0].values).toEqual([]);
    expect(report.meta.geography.charts.g1).toEqual([]);
    expect(report.meta.geographyCoverage).toMatchObject({
      totalVisits: 1,
      chinaProvinceKnownVisits: 0,
      chinaProvinceUnknownVisits: 1,
    });
    const location = report.meta.geography.tables.cityBody[0];
    expect(location).toEqual({ country: 'CN', region: null, city: 'Unlisted Town', cityId: null });
    expect(regionName(location.region, location.country, 'en-US')).toBe('Unknown');
  });
  it('merges historical geography before ranking, search and server pagination', async () => {
    const human = await mocks.human();
    human.totals.visits = 39;
    const fact = (city, sessions, region = 'CN-SN') => ({
      country: 'CN',
      region,
      city,
      sessions,
      duration: 10,
      pv: sessions,
      bounces: 0,
      conversions: 0,
    });
    human.geo = [
      fact(null, 8),
      fact("Xi'an", 3),
      fact('西安', 3, 'CN-61'),
      ...Array.from({ length: 25 }, (_, i) => fact(`Unlisted City ${i}`, 1)),
    ];
    mocks.human.mockResolvedValue(human);
    const report = await buildReport(website, false, { ...params, resource: 'human/geo' }, true);
    expect(report.cards.find(row => row.label === 'TOP1 城市').value).toBe('西安');
    expect(report.charts.g1.labels).toEqual(['陕西']);
    expect(report.charts.g1.series[0].values).toEqual([39]);
    expect(report.meta.tablePages.cityBody).toMatchObject({ total: 26, page: 1 });
    expect(report.tables.cityBody).toHaveLength(20);
    expect(report.meta.geography.charts.g1).toEqual([
      { country: 'CN', region: 'CN-61', city: null, cityId: null },
    ]);
    expect(report.meta.geography.cards['TOP1 城市'].cityId).toBe(1790630);
    expect(report.meta.geography.tables.cityBody).toHaveLength(20);
    report.tables.cityBody.forEach((row, index) =>
      expect(geographyLabel(report.meta.geography.tables.cityBody[index])).toBe(row.city),
    );
    const searched = await buildReport(
      website,
      false,
      { ...params, resource: 'human/geo', search: 'Xian' },
      true,
    );
    expect(searched.meta.tablePages.cityBody.total).toBe(1);
    expect(searched.tables.cityBody[0]).toMatchObject({ city: '西安', sessions: 6, share: 15.38 });
    expect(searched.meta.geography.tables.cityBody).toHaveLength(1);
    expect(geographyLabel(searched.meta.geography.tables.cityBody[0], 'en-US')).toBe("Xi'an");
    const narrowed = await buildReport(
      website,
      false,
      { ...params, resource: 'human/geo', search: 'Xian', tp_cityBody: 2 },
      true,
    );
    expect(narrowed.meta.tablePages.cityBody).toMatchObject({ total: 1, page: 1 });
    expect(narrowed.tables.cityBody[0]).toMatchObject({ city: '西安', sessions: 6 });
    const empty = await buildReport(
      website,
      false,
      { ...params, resource: 'human/geo', search: 'no such city', tp_cityBody: 2 },
      true,
    );
    expect(empty.meta.tablePages.cityBody).toMatchObject({ total: 0, page: 1 });
    expect(empty.meta.geography.tables.cityBody).toEqual([]);
    const last = await buildReport(
      website,
      false,
      { ...params, resource: 'human/geo', tp_cityBody: 2 },
      true,
    );
    expect(last.tables.cityBody).toHaveLength(6);
    expect(last.meta.geography.tables.cityBody).toHaveLength(6);
    last.tables.cityBody.forEach((row, index) =>
      expect(geographyLabel(last.meta.geography.tables.cityBody[index])).toBe(row.city),
    );
  });
  it('excludes private funnel configuration diagnostics from the public share profile', async () => {
    const human = await mocks.human();
    const funnelError = '已保存的漏斗配置无效，请检查目标配置';
    mocks.human.mockResolvedValue({ ...human, funnelError, funnelState: 'unsupported' });
    const shared = await buildReport(website, false, params, 'share');
    expect(shared.insights).not.toContain(funnelError);
    const privateReport = await buildReport(website, false, params);
    expect(privateReport.insights).toContain(funnelError);
  });
  it('keeps the report usable and shows a safe unsupported state for an invalid saved funnel', async () => {
    const human = await mocks.human();
    mocks.human.mockResolvedValue({
      ...human,
      funnel: [],
      funnelState: 'unsupported',
      funnelError: '已保存的漏斗配置无效，请检查目标配置',
    });
    const report = await buildReport(website, false, params);
    expect(report.charts.f1).toMatchObject({ state: 'unsupported', labels: [], series: [] });
    expect(report.insights).toContain('已保存的漏斗配置无效，请检查目标配置');
    expect(liekanReportSchema.safeParse(report).success).toBe(true);
  });
  it('returns page insights only when the loaded facts support them', async () => {
    const human = await mocks.human();
    const logs = await mocks.logs();
    mocks.human.mockResolvedValue({
      ...human,
      funnelError: '已保存的漏斗配置无效，请检查目标配置',
    });
    mocks.logs.mockImplementation(async (...args: any[]) => ({
      ...logs,
      latest: '2026-01-01',
      summary: { requests: 1, ai: 1 },
      pages:
        !args[9] || args[9].includes('pages')
          ? [{ path: '/a', bot: 'GPTBot', requests: 1, lastCrawled: '2026-01-01' }]
          : [],
    }));
    const full = await buildReport(website, false, params);
    expect(full.insights).toContain('目录 1 个 URL，0 个在所选范围没有 AI 抓取。');
    expect(full.insights).toContain('已保存的漏斗配置无效，请检查目标配置');
    for (const resource of Object.keys(pageReportParts).filter(
      resource => resource !== 'human/keywords',
    ) as ReportResource[]) {
      const page = await buildReport(website, false, { ...params, resource }, true);
      expect(page.insights).toEqual(
        resource === 'overview' || resource === 'ai/preference' ? full.insights : [],
      );
    }
  });
  it('joins encoded logs and catalog to upstream human paths without decoding human paths twice', async () => {
    const human = await mocks.human(),
      logs = await mocks.logs();
    const humanPaths = ['/文档/AI 入门', '/literal%20space', '/reserved%2Fslash'];
    const encodedPaths = [
      '/%E6%96%87%E6%A1%A3/AI%20%E5%85%A5%E9%97%A8',
      '/literal%2520space',
      '/reserved%2Fslash',
    ];
    mocks.human.mockResolvedValue({
      ...human,
      totals: { visits: 3, visitors: 3, pageviews: 3, bounces: 0, totaltime: 0 },
      pages: humanPaths.map(path => ({
        path,
        pv: 1,
        uv: 1,
        entries: 1,
        bounces: 0,
        duration: null,
      })),
    });
    mocks.logs.mockResolvedValue({
      ...logs,
      latest: '2026-01-01',
      summary: { requests: 6, ai: 6 },
      pages: encodedPaths.map((path, i) => ({
        path,
        bot: 'GPTBot',
        requests: i + 1,
        lastCrawled: '2026-01-01',
      })),
      catalog: encodedPaths.map((path, i) => ({ path, type: `类型${i}` })),
    });
    const report = await buildReport(website, false, params);
    expect(report.tables.topBody.map(row => [row.path, row.aiRequests, row.evaluation])).toEqual(
      humanPaths.map((path, i) => [path, i + 1, '已被抓取']),
    );
    expect(report.tables.pgBody.map(row => row.aiRequests)).toEqual([1, 2, 3]);
    expect(report.charts.pf1.series.find(series => series.name === '浏览 PV').values).toEqual([
      33.33, 33.33, 33.33,
    ]);
  });
  it('preserves undefined chart percentages as gaps and measured zero percentages as zero', async () => {
    const logs = await mocks.logs();
    mocks.logs.mockResolvedValue({ ...logs, latest: '2026-01-01' });
    mocks.humanDays.mockResolvedValue({ rows: [
      { day: '1970-01-01', pv: 0, uv: 0, sessions: 0, bounces: 0 },
      { day: '1970-01-02', pv: 3, uv: 3, sessions: 3, bounces: 0 },
    ] });
    mocks.months.mockResolvedValue([
      { month: '2026-01', ai: 0, total: 0 },
      { month: '2026-02', ai: 0, total: 5 },
    ]);
    const empty = await buildReport(website, false, params);
    expect(empty.charts.pf1.series.map(series => series.values)).toEqual([[null], [null]]);
    expect(empty.charts.h1.series[2].values).toEqual([null, 0]);
    expect(empty.charts.a2.series[0].values).toEqual([null, 0]);
    expect(liekanReportSchema.safeParse(empty).success).toBe(true);
    const human = await mocks.human();
    mocks.human.mockResolvedValue({
      ...human,
      totals: { visits: 5, visitors: 5, pageviews: 5, bounces: 0, totaltime: 0 },
      pages: [
        {
          path: '/outside-catalog',
          pv: 5,
          uv: 5,
          entries: 5,
          bounces: 0,
          duration: null,
          samples: 0,
        },
      ],
    });
    mocks.logs.mockResolvedValue({
      ...logs,
      latest: '2026-01-01',
      summary: { requests: 4, ai: 4 },
    });
    const measured = await buildReport(website, false, params);
    expect(measured.charts.pf1.series.map(series => series.values)).toEqual([[0], [0]]);
  });
  it('distinguishes an undefined AI referral rate from a measured zero conversion rate', async () => {
    const human = await mocks.human();
    const input = {
      ...human,
      totals: { visits: 5, visitors: 5, pageviews: 5, bounces: 0, totaltime: 0 },
      goals: [
        {
          id: 'goal',
          name: 'download',
          path: 'download',
          count: 0,
          convertedSessions: 0,
          previous: 0,
        },
      ],
      sources: [
        { source: '直接访问', channel: '直接访问', sessions: 5, conversions: 0, bounces: 0 },
      ],
    };
    mocks.human.mockResolvedValue(input);
    const noAi = await buildReport(website, false, params);
    expect(noAi.cards.find(c => c.label === 'AI 引荐转化率')).toMatchObject({
      value: null,
      state: 'empty',
    });
    mocks.human.mockResolvedValue({
      ...input,
      sources: [
        { source: 'chatgpt.com', channel: 'AI 搜索引荐', sessions: 2, conversions: 0, bounces: 0 },
        { source: '直接访问', channel: '直接访问', sessions: 3, conversions: 0, bounces: 0 },
      ],
    });
    const observedAi = await buildReport(website, false, params);
    expect(observedAi.cards.find(c => c.label === 'AI 引荐转化率')).toMatchObject({
      value: 0,
      state: 'available',
    });
  });
  it('keeps event counts available when a custom-only window has no defined conversion rate', async () => {
    const human = await mocks.human();
    mocks.human.mockResolvedValue({
      ...human,
      goals: [
        {
          id: 'goal',
          name: '白皮书下载',
          path: 'download',
          count: 3,
          convertedSessions: 0,
          previous: 0,
        },
      ],
      dailyConversions: [{ day: '1970-01-02', count: 3 }],
    });
    mocks.conversions.mockResolvedValue(3);
    const report = await buildReport(website, false, params);
    expect(report.tables.goalBody[0]).toMatchObject({ count: 3, rate: null, rateState: 'empty' });
    expect(report.cards.find(c => c.label === '全站转化率')).toMatchObject({
      value: null,
      state: 'empty',
    });
    expect(report.cards.find(c => c.label === '今日转化')).toMatchObject({
      value: 3,
      state: 'available',
    });
    expect(report.cards.find(c => c.label === '白皮书下载').value).toBe(3);
    expect(report.charts.f3.series[0].values).toEqual([3]);
  });
  it('keeps card rates and a page without entry observations undefined at zero denominators', async () => {
    const empty = await buildReport(website, false, params);
    for (const label of ['跳出率', '直接访问', '传统搜索', 'AI 搜索引荐'])
      expect(
        empty.cards.find(c => c.label === label),
        label,
      ).toMatchObject({ value: null, state: 'empty' });
    const human = await mocks.human();
    mocks.human.mockResolvedValue({
      ...human,
      totals: { visits: 2, visitors: 2, pageviews: 3, bounces: 0, totaltime: 0 },
      pages: [
        { path: '/secondary', pv: 1, uv: 1, entries: 0, bounces: 0, duration: null, samples: 0 },
        { path: '/entry', pv: 2, uv: 2, entries: 2, bounces: 0, duration: null, samples: 0 },
      ],
    });
    const observed = await buildReport(website, false, params);
    expect(observed.tables.pgBody.find(row => row.path === '/secondary').bounceRate).toBeNull();
    expect(observed.tables.pgBody.find(row => row.path === '/entry').bounceRate).toBe(0);
    expect(observed.cards.find(c => c.label === '跳出率')).toMatchObject({
      value: 0,
      state: 'available',
    });
  });
  it('uses the entry channel consistently for source rows, daily channels and conversion rates', async () => {
    const human = await mocks.human();
    mocks.human.mockResolvedValue({
      ...human,
      totals: { visits: 4, visitors: 4, pageviews: 4, bounces: 0, totaltime: 0 },
      daily: [{ day: '1970-01-01', sessions: 4, conversions: 1 }],
      goals: [
        {
          id: 'goal',
          name: 'download',
          path: 'download',
          count: 3,
          convertedSessions: 1,
          previous: 0,
        },
      ],
      sources: [
        {
          source: 'google.com',
          channel: '其他引荐',
          utmMedium: 'email',
          referrer: 'google.com',
          sessions: 2,
          conversions: 1,
          bounces: 0,
        },
      ],
      previousSources: [
        { source: 'google.com', channel: '传统搜索', sessions: 20 },
        { source: 'google.com', channel: '其他引荐', sessions: 1 },
      ],
      dailySources: [{ day: '1970-01-01', source: 'google.com', channel: '其他引荐', count: 2 }],
    });
    const report = await buildReport(website, false, params);
    expect(report.tables.srcBody[0]).toMatchObject({
      channel: '其他引荐',
      utmMedium: 'email',
      referrer: 'google.com',
      conversionRate: 50,
      trend: 100,
    });
    expect(report.charts.s1.series.find(s => s.name === '其他引荐').values).toEqual([2]);
    expect(report.charts.s1.series.find(s => s.name === '传统搜索').values).toEqual([0]);
    expect(report.charts.f2).toMatchObject({
      labels: ['其他引荐'],
      series: [{ name: '转化率', values: [50] }],
    });
  });
  it('counts matched events while rates use converted visits and trends follow event dates', async () => {
    const human = await mocks.human();
    mocks.human.mockResolvedValue({
      ...human,
      totals: { visits: 4, visitors: 4, pageviews: 4, bounces: 0, totaltime: 0 },
      daily: [{ day: '1970-01-01', sessions: 4, conversions: 1 }],
      dailyConversions: [{ day: '1970-01-02', count: 3 }],
      goals: [
        {
          id: 'goal',
          name: '白皮书下载',
          path: 'download',
          count: 3,
          convertedSessions: 1,
          previous: 2,
        },
      ],
      converted: 1,
      sources: [
        { source: 'chatgpt.com', channel: 'AI 搜索引荐', sessions: 1, conversions: 1, bounces: 0 },
      ],
    });
    mocks.conversions.mockResolvedValue(3);
    const report = await buildReport(website, false, params);
    expect(report.tables.goalBody[0]).toMatchObject({ count: 3, rate: 25, trend: 50 });
    expect(report.cards.find(c => c.label === '白皮书下载').value).toBe(3);
    expect(report.cards.find(c => c.label === '今日转化').value).toBe(3);
    expect(report.cards.find(c => c.label === '全站转化率').value).toBe(25);
    expect(report.cards.find(c => c.label === 'AI 引荐转化率').value).toBe(100);
    expect(report.charts.f3).toMatchObject({
      labels: ['1970-01-02'],
      series: [{ name: '转化数', values: [3] }],
    });
  });
  it('keeps missing AI evidence separate from a measured zero', async () => {
    const report = await buildReport(website, false, params);
    for (const name of ['AI 抓取页面覆盖率', '从未被抓页面', '识别 AI 蜘蛛']) {
      expect(report.cards.find(card => card.label === name)).toMatchObject({
        value: null,
        state: 'not_connected',
      });
    }
    expect(report.tables.blindList).toEqual([]);
    expect(report.charts.a3.series).toEqual([]);
    expect(report.charts.pf2.state).toBe('not_connected');
    expect(report.charts.f2.series).toEqual([]);
  });
  it('validates date range and timezone before accessing storage', async () => {
    await expect(buildReport(website, false, { ...params, endAt: -1 })).rejects.toThrow();
    await expect(
      buildReport(website, false, { ...params, timezone: 'invalid/timezone' }),
    ).rejects.toThrow();
    expect(mocks.human).not.toHaveBeenCalled();
  });
  it('accepts the selected current day boundary during a 25-hour DST day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T07:05:00Z'));
    const endAt = Date.parse('2026-11-02T08:00:00Z');
    try {
      await buildReport(website, false, {
        ...params, resource: 'ai/overview', timezone: 'America/Los_Angeles', crawlerMetricsVersion: 1,
        startAt: Date.parse('2026-10-04T07:00:00Z'), endAt,
      }, true);
      expect(mocks.logs.mock.calls[0][2]).toEqual(new Date(Date.now()));
      const reads = mocks.logs.mock.calls.length;
      await expect(buildReport(website, false, {
        ...params, endAt: endAt + 86400000, timezone: 'America/Los_Angeles',
      }, true)).rejects.toThrow('日期范围无效');
      expect(mocks.logs).toHaveBeenCalledTimes(reads);
    } finally {
      vi.useRealTimers();
    }
  });
  it('rejects an upstream response with a missing chart contract', async () => {
    const report = await buildReport(website, false, params);
    expect(liekanReportSchema.safeParse(report).success).toBe(true);
    const damaged = structuredClone(report);
    delete damaged.charts.h1;
    expect(liekanReportSchema.safeParse(damaged).success).toBe(false);
  });
  it('keeps historical classifications stable and distinguishes unmapped vendor identities', async () => {
    const logs = await mocks.logs();
    mocks.logs.mockResolvedValue({
      ...logs,
      latest: '2026-01-01',
      summary: { requests: 5, ai: 5 },
      daily: [
        { day: '1970-01-01', bot: 'GPTBot', vendor: 'OpenAI', count: 3 },
        { day: '1970-01-01', bot: 'GPTBot', vendor: 'Changed vendor', count: 2 },
      ],
      bots: [
        {
          name: 'GPTBot',
          vendor: 'OpenAI',
          type: '训练',
          requests: 3,
          pages: 1,
          lastVisit: '2026-01-01',
        },
        {
          name: 'GPTBot',
          vendor: 'Changed vendor',
          type: '搜索',
          requests: 2,
          pages: 1,
          lastVisit: '2026-01-01',
        },
      ],
    });
    mocks.plotLogs.mockResolvedValue([
      { day: '1970-01-01', bot: 'GPTBot', type: '训练', count: 3 },
      { day: '1970-01-01', bot: 'GPTBot', type: '搜索', count: 2 },
    ]);
    const report = await buildReport(website, false, params);
    expect(report.cards.find(c => c.label === '识别 AI 蜘蛛').value).toBe(2);
    expect(report.charts.a1.series).toEqual([
      { name: 'GPTBot', values: [3] },
      { name: 'GPTBot', values: [2] },
    ]);
    expect(report.charts.d2.labels).toEqual(['GPTBot', 'GPTBot']);
    expect(report.charts.d2.series[0].values).toEqual([3, 2]);
    expect(report.charts.d1.series[1].values).toEqual([5]);
    expect(report.tables.botBody).toHaveLength(2);
  });
});

it('shows an active log source without an import as empty and keeps its import time unknown', async () => {
  mocks.logs.mockResolvedValue({ ...(await mocks.logs()), connected: true, latest: null });
  const result = await buildReport(website, false, params);
  expect(result.states.logs).toBe('empty');
  expect(result.meta.latestImportAt).toBeNull();
});

it('projects visitor-only overview while preserving crawler analytics and re-enabling the original overview', async () => {
  mocks.settings.mockResolvedValue({
    isDemo: false,
    rules: [],
    robots: '',
    aiCrawlerEnabled: false,
  });
  const report = await buildReport(website, true, params, true);
  expect(report.meta.aiCrawlerEnabled).toBe(false);
  expect(report.cards.map(card => card.label)).toEqual([
    '访客数 UV',
    '浏览量 PV',
    '跳出率',
    '平均访问时长',
  ]);
  expect(report.charts.d1.series.map(series => series.name)).toEqual(['浏览量 PV']);
  expect(Object.keys(report.charts)).toEqual(['d1', 'd3']);
  expect(Object.keys(report.tables)).toEqual(['visitorTopBody']);
  expect(report.insights.join('')).not.toMatch(/AI|抓取|目录|蜘蛛/);
  const history = await buildReport(website, true, { ...params, resource: 'ai/overview' }, true);
  expect(history.cards.map(card => card.label)).toContain('AI 蜘蛛请求（30天）');
  mocks.settings.mockResolvedValue({
    isDemo: false,
    rules: [],
    robots: '',
    aiCrawlerEnabled: true,
  });
  expect((await buildReport(website, true, params, true)).cards.map(card => card.label)).toContain(
    'AI 蜘蛛请求',
  );
});

it('builds platform shares from the same sources and only requests human source facts', async () => {
  const human = await mocks.human();
  mocks.human.mockResolvedValue({
    ...human,
    totals: { ...human.totals, visits: 10 },
    sources: [
      {
        source: 'www.google.com',
        channel: '传统搜索',
        sessions: 2,
        pv: 3,
        bounces: 1,
        conversions: 1,
      },
      {
        source: 'google.com.hk',
        channel: '传统搜索',
        sessions: 1,
        pv: 1,
        bounces: 1,
        conversions: 0,
      },
      {
        source: 'chatgpt.com',
        channel: 'AI 搜索引荐',
        sessions: 1,
        pv: 2,
        bounces: 0,
        conversions: 1,
      },
      { source: '直接访问', channel: '直接访问', sessions: 6, pv: 6, bounces: 6, conversions: 0 },
    ],
    goals: [{ id: 'goal', count: 2, convertedSessions: 2 }],
  });
  const page = await buildReport(
    website,
    false,
    { ...params, resource: 'human/search-engines' },
    true,
  );
  expect(mocks.human.mock.calls[1][4]).toEqual(['sources']);
  expect(mocks.logs.mock.calls[0][9]).toEqual([]);
  expect(page.cards.map(card => card.value)).toEqual([4, 3, 1, 25]);
  expect(page.charts.se1).toMatchObject({
    labels: ['Google'],
    series: [{ name: '会话', values: [3] }],
  });
  expect(page.charts.se2.labels).toEqual(['ChatGPT']);
  expect(page.tables.searchEngineBody[0]).toMatchObject({
    share: 75,
    categoryShare: 100,
    bounceRate: 66.67,
    conversionRate: 33.33,
  });
  expect(Object.keys(page.tables)).toEqual(['searchEngineBody']);
});

it('shows empty category charts and unavailable conversion rates without excluding missing keywords', async () => {
  const human = await mocks.human();
  mocks.human.mockResolvedValue({
    ...human,
    totals: { ...human.totals, visits: 1 },
    sources: [
      { source: 'baidu.com', channel: '传统搜索', sessions: 1, pv: 1, bounces: 1, conversions: 0 },
    ],
  });
  const page = await buildReport(
    website,
    false,
    { ...params, resource: 'human/search-engines' },
    true,
  );
  expect(page.tables.searchEngineBody[0].conversionRate).toBeNull();
  expect(page.cards.map(card => card.value)).toEqual([1, 1, 0, 0]);
  expect(page.charts.se2).toMatchObject({
    state: 'empty',
    labels: [],
    series: [{ name: '会话', values: [] }],
  });
});

it.each([false, true])(
  'keeps unavailable identities out of private/share insights when visitor-only=%s',
  async visitorOnly => {
    const human = await mocks.human();
    const population = populationFromRow(
      {
        eligibleEvents: 3,
        qualifiedEvents: 1,
        eligiblePV: 3,
        qualifiedPV: 1,
        qualifiedVisitors: 1,
      },
      { startAt: params.startAt, endAt: params.endAt, timezone: params.timezone },
    );
    mocks.human.mockResolvedValue({
      ...human,
      totals: {
        pageviews: 3,
        visitors: null,
        visits: null,
        bounces: null,
        totaltime: null,
        population,
      },
    });
    mocks.settings.mockResolvedValue({
      ...(await mocks.settings()),
      aiCrawlerEnabled: !visitorOnly,
    });
    for (const pageOnly of [undefined, 'share'] as const) {
      const report = await buildReport(website, false, params, pageOnly);
      expect(report.insights).toContain(identityUnavailableReason);
      expect(report.insights[0]).toContain('3 次浏览');
      expect(report.insights.join(' ')).not.toMatch(/null|undefined|NaN|0 次访问|0 位访客/);
      const english = report.insights.map(line => translateSystemText(line, 'en-US'));
      expect(english[0]).toContain('3 pageviews');
      expect(english.join(' ')).not.toMatch(/[\u4e00-\u9fff]|null|undefined|NaN/);
      if (report.tables.recoList)
        expect(report.tables.recoList.map(row => row.detail)).toEqual(report.insights);
    }
  },
);

it('keeps the selected trend start while a dashboard batch clips its data end', async () => {
  const selectedEnd = +new Date('2026-10-24T23:59:59.999+08:00');
  const cutoff = +new Date('2026-10-24T10:05:00+08:00');
  await withDashboardClock(
    cutoff,
    () =>
      buildReport(
        website,
        false,
        {
          ...params,
          resource: 'overview',
          startAt: +new Date('2026-09-25T00:00:00+08:00'),
          endAt: selectedEnd,
          timezone: 'Asia/Shanghai',
          chartPeriod: '30d',
        },
        true,
      ),
  );
  expect(mocks.humanDays.mock.calls[0][1]).toEqual(new Date(selectedEnd - 30 * 86400000));
  expect(mocks.plotLogs.mock.calls[0][1]).toEqual(new Date(selectedEnd - 30 * 86400000));
  expect(mocks.humanDays.mock.calls[0][2]).toEqual(new Date(cutoff - 1));
});

it('anchors Today hourly trends to the selected comparison date',async () => {
 const startAt=Date.parse('2026-03-01T05:00Z');
 const endAt=Date.parse('2026-03-02T04:59:59.999Z');
 await buildReport(website,false,{...params,resource:'human/overview',startAt,endAt,timezone:'America/New_York',chartPeriod:'today'},true);
 expect(mocks.humanDays).toHaveBeenCalledWith(website.id,new Date(startAt),new Date(endAt),'America/New_York',true);
 expect(mocks.plotLogs.mock.calls[0][1]).toEqual(new Date(startAt));
});

it('keeps qualified history in an independent trend window when the card window lacks identity', async () => {
  const range = {
    startAt: Date.parse('2026-01-09T00:00:00Z'),
    endAt: Date.parse('2026-01-10T00:00:00Z') - 1,
    timezone: 'UTC',
  };
  const human = await mocks.human();
  const population = populationFromRow(
    {
      resourceKind: 'website',
      metricScope: 'qualified-browser',
      eligibleEvents: 5,
      qualifiedEvents: 0,
      eligiblePV: 5,
      qualifiedPV: 0,
      qualifiedVisitors: 0,
    },
    range,
  );
  mocks.human.mockResolvedValue({
    ...human,
    totals: {
      pageviews: 0,
      visitors: null,
      visits: null,
      bounces: null,
      totaltime: null,
      population,
    },
  });
  mocks.humanDays.mockResolvedValue({
    rows: [{ day: '2026-01-08', pv: 3, uv: 2, sessions: 2, bounces: 1 }],
    population: populationFromRow(
      {
        resourceKind: 'website',
        metricScope: 'qualified-browser',
        eligibleEvents: 3,
        qualifiedEvents: 3,
        eligiblePV: 3,
        qualifiedPV: 3,
        qualifiedVisitors: 2,
      },
      { ...range, startAt: range.startAt - 7 * 86400000 },
    ),
  });
  const actual = await buildReport(
    website,
    false,
    { ...range, resource: 'human/overview', chartPeriod: '7d' },
    true,
  );
  expect(+mocks.humanDays.mock.calls[0][1]).toBeLessThan(range.startAt);
  expect(actual.charts.h1.series[0].values).toEqual([3]);
  expect(actual.charts.h1.series[1].values).toEqual([2]);
  expect(actual.charts.h1.state).toBe('available');
  expect(actual.cards.find(card => card.key === '访客数 UV')).toMatchObject({
    value: null,
    state: 'unavailable',
  });
});

it('uses the trend population without clearing usable card metrics', async () => {
  const range = {
    startAt: Date.parse('2026-01-02T00:00:00Z'),
    endAt: Date.parse('2026-01-10T00:00:00Z') - 1,
    timezone: 'UTC',
  };
  const human = await mocks.human();
  const population = populationFromRow(
    {
      resourceKind: 'website',
      metricScope: 'qualified-browser',
      eligibleEvents: 3,
      qualifiedEvents: 3,
      eligiblePV: 3,
      qualifiedPV: 3,
      qualifiedVisitors: 2,
    },
    range,
  );
  const trendPopulation = populationFromRow(
    {
      resourceKind: 'website',
      metricScope: 'qualified-browser',
      eligibleEvents: 5,
      qualifiedEvents: 0,
      eligiblePV: 5,
      qualifiedPV: 0,
      qualifiedVisitors: 0,
    },
    { ...range, startAt: Date.parse('2026-01-09T00:00:00Z') },
  );
  mocks.human.mockResolvedValue({
    ...human,
    totals: { pageviews: 3, visitors: 2, visits: 2, bounces: 1, totaltime: 10, population },
  });
  mocks.humanDays.mockResolvedValue({ rows: [], population: trendPopulation });
  mocks.plotLogs.mockResolvedValue([{ day: '2026-01-09', bot: 'GPTBot', count: 5, aiRequests: 5 }]);
  const actual = await buildReport(
    website,
    false,
    { ...range, resource: 'human/overview', chartPeriod: 'today' },
    true,
  );
  expect(actual.cards.find(card => card.key === '访客数 UV').value).toBe(2);
  expect(actual.charts.h1.series.map(series => series.values)).toEqual([[null], [null], [null]]);
  expect(actual.charts.h1.state).toBe('unavailable');
  expect(actual.meta.trendPopulation.range.startAt).toBeGreaterThan(range.startAt);
  expect(liekanReportSchema.shape.meta.parse(actual.meta).trendPopulation).toEqual(trendPopulation);
});

const unavailableReviewRange = {
  startAt: Date.parse('2026-01-09T00:00:00Z'),
  endAt: Date.parse('2026-01-10T00:00:00Z') - 1,
  timezone: 'UTC',
};
async function missingBrowserReport() {
  const human = await mocks.human();
  const population = populationFromRow(
    {
      resourceKind: 'website',
      metricScope: 'qualified-browser',
      eligibleEvents: 5,
      qualifiedEvents: 0,
      eligiblePV: 5,
      qualifiedPV: 0,
      qualifiedVisitors: 0,
    },
    unavailableReviewRange,
  );
  mocks.human.mockResolvedValue({
    ...human,
    totals: {
      pageviews: 0,
      visitors: null,
      visits: null,
      bounces: null,
      totaltime: null,
      population,
    },
  });
  mocks.humanDays.mockResolvedValue({ rows: [], population });
}
it('keeps unavailable geography coverage distinct from measured zero', async () => {
  await missingBrowserReport();
  const actual = await buildReport(
    website,
    false,
    { ...unavailableReviewRange, resource: 'human/geo' },
    true,
  );
  for (const key of ['覆盖省份', '海外国家/地区'])
    expect(actual.cards.find(card => card.key === key)).toMatchObject({
      value: null,
      state: 'unavailable',
    });
});
it('keeps unavailable browser PV missing while retaining the log trend', async () => {
  await missingBrowserReport();
  const logs = await mocks.logs();
  mocks.logs.mockResolvedValue({
    ...logs,
    latest: '2026-01-09T12:00:00Z',
    summary: { requests: 5, ai: 5 },
  });
  mocks.plotLogs.mockResolvedValue([{ day: '2026-01-09', bot: 'GPTBot', count: 5, aiRequests: 5 }]);
  const actual = await buildReport(
    website,
    false,
    { ...unavailableReviewRange, resource: 'overview', chartPeriod: '24h' },
    true,
  );
  expect(actual.charts.d1.series[0].values).toEqual([null]);
  expect(actual.charts.d1.series[1].values).toEqual([5]);
});
