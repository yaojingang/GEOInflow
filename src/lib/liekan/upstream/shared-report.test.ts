import { beforeEach, expect, it, vi } from 'vitest';
import { ENTITY_TYPE } from '@/lib/constants';
import { sharedReportParts } from '../contracts/shared-report';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  entity: vi.fn(),
  build: vi.fn(),
  authorize: vi.fn(),
  snapshot: vi.fn(),
  query: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ checkAuth: mocks.auth }));
vi.mock('@/permissions/website', () => ({ canViewWebsite: vi.fn() }));
vi.mock('./live-share', () => ({ loadShareEntity: mocks.entity }));
vi.mock('../report', () => ({ buildReport: mocks.build }));
vi.mock('./cache-context', async importOriginal => ({
  ...(await importOriginal<typeof import('./cache-context')>()),
  withoutQueryCache: (work: () => unknown) => work(),
}));
vi.mock('./server', async () => ({
  ...(await import('./errors')),
  authorize: mocks.authorize,
  reportSnapshot: mocks.snapshot,
  query: mocks.query,
}));
import { readSharedReport } from './shared-report';
import { analyticsCache } from './query-cache';
import { populationFromRow } from './browser-population';

const id = '5b4c0de0-6c47-5b51-8f53-11e5e8c79001';
const website = { id, name: '测试站', domain: 'example.com' };
const input = { startAt: 0, endAt: 86400000, timezone: 'Asia/Shanghai', chartPeriod: '30d' };
const request = (extra = '') =>
  new Request(
    `http://localhost/api/liekan/websites/${id}/shared-report?${new URLSearchParams({ ...Object.fromEntries(Object.entries(input).map(([key, value]) => [key, String(value)])) })}${extra}`,
  );
const share = (parameters = { overview: true, goals: true }) => ({
  shareToken: { shareType: ENTITY_TYPE.website, websiteId: id, parameters },
});
beforeEach(() => {
  vi.clearAllMocks();
  analyticsCache.clear();
  mocks.query.mockResolvedValue([{ data: '1', policy: '1' }]);
  mocks.auth.mockResolvedValue(share());
  mocks.entity.mockResolvedValue({ ...website, userId: 'private-owner' });
  mocks.snapshot.mockImplementation(async work => work());
  mocks.build.mockResolvedValue({
    contractVersion: 2,
    website,
    range: input,
    states: { human: 'available', logs: 'available', catalog: 'available', goals: 'available' },
    cards: [
      { key: 'visitors', label: '访客数 UV', value: 10, state: 'available' },
      { key: 'private', label: '蜘蛛识别规则', value: 99, state: 'available' },
    ],
    charts: Object.fromEntries(
      sharedReportParts.charts.map(key => [
        key,
        {
          labels: ['A'],
          series: [{ name: '会话', values: [10] }],
          rows: [{ conversionRate: 12, ip: 'private-ip' }],
        },
      ]),
    ),
    tables: {
      envGrid: [{ category: 'browser', name: 'chrome', share: 100, private: 'hidden' }],
      cityBody: Array.from({ length: 15 }, (_, i) => ({
        city: `城市${i}`,
        sessions: 10,
        share: 10,
        duration: 60,
        bounceRate: 10,
        conversionRate: 12,
        private: 'hidden',
      })),
      logBody: [{ ip: 'private-ip' }],
      goalBody: [{ name: 'private-goal' }],
    },
    insights: ['已导入日志识别 10 次 AI 请求；按 UA 分类，官方 IP 范围匹配结果见访问流。'],
    meta: {
      demo: true,
      canManage: true,
      latestImportAt: 'private-date',
      ruleCount: 99,
      nextCursor: 'private-cursor',
    },
  });
});
it('returns only aggregate fields in one snapshot and preserves the demo marker', async () => {
  const report = await readSharedReport(request(), id);
  expect(mocks.build).toHaveBeenCalledWith(
    website,
    false,
    { ...input, resource: 'overview' },
    'share',
  );
  expect(mocks.snapshot).toHaveBeenCalledOnce();
  expect(report.meta).toEqual({ demo: true, canManage: false, latestImportAt: null, ruleCount: 0 });
  expect(report.tables.cityBody).toHaveLength(12);
  expect(report.cards).toHaveLength(1);
  expect(JSON.stringify(report)).not.toMatch(/private-|hidden|访问流/);
});
it('uses the pinned public timezone even when the request supplies another viewer timezone', async () => {
  mocks.auth.mockResolvedValue(share({ overview: true, goals: true, timezone: 'America/New_York' } as any));
  await readSharedReport(new Request(request().url.replace('Asia%2FShanghai', 'Asia%2FTokyo')), id);
  expect(mocks.build).toHaveBeenCalledWith(website, false, {
    ...input, timezone: 'America/New_York', resource: 'overview',
  }, 'share');
});
it('removes every conversion result when the live share does not permit goals', async () => {
  mocks.auth.mockResolvedValue(share({ overview: true, goals: false }));
  const report = await readSharedReport(request(), id);
  expect(report.capabilities.goals).toBe(false);
  expect(report.states.goals).toBe('unsupported');
  expect(report.tables.cityBody.every(row => row.conversionRate === null)).toBe(true);
  expect(report.charts.g1.rows).toEqual([{ conversionRate: null }]);
});
it.each([true, false])(
  'projects only retained geography display identities with aligned TOP12 rows when goals=%s',
  async goals => {
    const source = await mocks.build();
    source.cards.push(
      { key: 'top-city', label: 'TOP1 城市', value: '西安', state: 'available' },
      { key: 'overseas-country', label: '海外 TOP1', value: '美国', state: 'available' },
    );
    source.tables.cityBody[0].city = '西安';
    source.charts.g1.labels = ['陕西'];
    source.charts.g2.labels = ['美国'];
    const city = { country: 'CN', region: 'CN-61', city: '西安', cityId: 1790630 };
    source.meta.geography = {
      charts: {
        g1: [
          { ...city, ip: 'private-ip', conversionRate: 99 },
          { ...city, city: 'private-extra-chart-city' },
        ],
        g2: [
          { country: 'US', region: 'private-region', city: 'private-chart-city', cityId: 1790630 },
        ],
        a1: [{ ...city, city: 'private-chart' }],
      },
      tables: {
        cityBody: source.tables.cityBody.map((row, i) => ({
          ...city,
          city: i > 11 ? `private-city-${i}` : row.city,
          cityId: i === 0 ? 1790630 : null,
          ip: 'private-ip',
        })),
        logBody: [{ ...city, city: 'private-log' }],
      },
      cards: {
        'top-city': { ...city, ip: 'private-ip' },
        'overseas-country': {
          country: 'US',
          region: 'private-region',
          city: 'private-card-city',
          cityId: 1790630,
        },
        private: { ...city, city: 'private-card' },
        orphan: { ...city, city: 'private-orphan' },
        visitors: { ...city, city: 'private-numeric-card' },
      },
    };
    mocks.auth.mockResolvedValue(share({ overview: true, goals }));
    mocks.build.mockResolvedValue(source);
    const report = await readSharedReport(request(), id);
    expect(report.meta.geography).toEqual({
      charts: {
        g1: [{ country: 'CN', region: 'CN-61', city: null, cityId: null }],
        g2: [{ country: 'US', region: null, city: null, cityId: null }],
      },
      tables: {
        cityBody: source.tables.cityBody
          .slice(0, 12)
          .map((row, i) => ({ ...city, city: row.city, cityId: i === 0 ? 1790630 : null })),
      },
      cards: {
        'top-city': city,
        'overseas-country': { country: 'US', region: null, city: null, cityId: null },
      },
    });
    expect(report.meta.geography.tables.cityBody).toHaveLength(report.tables.cityBody.length);
    expect(report.meta.geography.charts.g1).toHaveLength(report.charts.g1.labels.length);
    expect(report.meta.geography.charts.g2).toHaveLength(report.charts.g2.labels.length);
    expect(report.capabilities.goals).toBe(goals);
    expect(JSON.stringify(report)).not.toMatch(/private-|hidden/);
    expect(source.meta.geography.tables.cityBody).toHaveLength(15);
    expect(source.meta.geography.charts.g1[0].ip).toBe('private-ip');
  },
);

it('omits incomplete or oversized geography metadata while retaining the original shared aggregates', async () => {
  const source = await mocks.build();
  source.meta.geography = {
    charts: { g1: [], g2: [{ country: 'US', region: null, city: null, cityId: null }] },
    tables: {
      cityBody: Array.from({ length: 11 }, () => ({
        country: 'CN',
        region: null,
        city: 'unknown',
        cityId: null,
      })),
    },
    cards: { private: { country: 'CN', region: null, city: 'private-card', cityId: null } },
  };
  source.charts.g2.labels = Array.from({ length: 9 }, (_, i) => String(i));
  mocks.build.mockResolvedValue(source);
  const report = await readSharedReport(request(), id);
  expect(report.meta.geography).toBeUndefined();
  expect(report.tables.cityBody).toHaveLength(12);
  expect(report.charts.g1.labels).toEqual(['A']);
  expect(report.charts.g2.labels).toHaveLength(9);
});
it('coalesces viewers while rechecking permissions and redacting cached goal results after scope changes', async () => {
  await Promise.all([readSharedReport(request(), id), readSharedReport(request(), id)]);
  expect(mocks.build).toHaveBeenCalledOnce();
  mocks.auth.mockResolvedValue(share({ overview: true, goals: false }));
  expect((await readSharedReport(request(), id)).tables.cityBody[0].conversionRate).toBeNull();
  expect(mocks.build).toHaveBeenCalledTimes(2);
  mocks.auth.mockResolvedValue(null);
  await expect(readSharedReport(request(), id)).rejects.toMatchObject({ status: 401 });
  expect(mocks.auth).toHaveBeenCalledTimes(4);
  mocks.auth.mockResolvedValue(share());
  mocks.query.mockResolvedValue([{ data: '2', policy: '1' }]);
  await readSharedReport(request(), id);
  expect(mocks.build).toHaveBeenCalledTimes(3);
});
it.each([
  null,
  { shareToken: { shareType: ENTITY_TYPE.website, websiteId: 'other-site' } },
  { shareToken: { shareType: ENTITY_TYPE.board, websiteId: id, websiteIds: [id] } },
  { shareToken: { shareType: ENTITY_TYPE.link, websiteId: id } },
  share({ overview: false, goals: true }),
  { ...share(), user: { id: 'admin' } },
])(
  'rejects invalid, cross-resource, restricted and mixed identities before reading statistics: %j',
  async auth => {
    mocks.auth.mockResolvedValue(auth);
    await expect(readSharedReport(request(), id)).rejects.toMatchObject({
      status: auth ? 403 : 401,
    });
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  },
);
it('uses the existing complete-login authorization and rejects unsupported query filters', async () => {
  mocks.auth.mockResolvedValue({ user: { id: 'user' } });
  mocks.authorize.mockResolvedValue({ website });
  await expect(readSharedReport(request(), id)).resolves.toMatchObject({
    capabilities: { goals: true },
  });
  expect(mocks.authorize).toHaveBeenCalledWith(expect.any(Request), id);
  await expect(readSharedReport(request('&path=eq.secret'), id)).rejects.toMatchObject({
    status: 400,
  });
});
it('rejects deleted websites and failed complete-login authorization', async () => {
  mocks.entity.mockResolvedValue(null);
  await expect(readSharedReport(request(), id)).rejects.toMatchObject({ status: 404 });
  mocks.auth.mockResolvedValue({ user: { id: 'user' } });
  mocks.authorize.mockRejectedValue(new Error('incomplete login'));
  await expect(readSharedReport(request(), id)).rejects.toThrow('incomplete login');
  expect(mocks.build).not.toHaveBeenCalled();
});

it('conceals crawler integration states from public reports when display is disabled, including cached reads', async () => {
  await readSharedReport(request(), id);
  const source = await mocks.build();
  mocks.build.mockResolvedValue({ ...source, meta: { ...source.meta, aiCrawlerEnabled: false } });
  mocks.query.mockResolvedValue([{ data: '2', policy: '1' }]);
  for (let i = 0; i < 2; i++) {
    const report = await readSharedReport(request(), id);
    expect(report.states.logs).toBe('unsupported');
    expect(report.states.catalog).toBe('unsupported');
    expect(report.states.human).toBe('available');
  }
  expect(mocks.snapshot).toHaveBeenCalledTimes(2);
});

it('preserves the public trend population for its independent date window', async () => {
  const source = await mocks.build();
  const trend = populationFromRow({
    resourceKind: 'website', metricScope: 'qualified-browser', eligibleEvents: 4,
    qualifiedEvents: 4, eligiblePV: 4, qualifiedPV: 4, qualifiedVisitors: 2,
  }, { startAt: 0, endAt: 86400000, timezone: 'Asia/Shanghai' });
  source.meta.trendPopulation = trend;
  source.meta.population = populationFromRow({
    resourceKind: 'website', metricScope: 'qualified-browser', eligibleEvents: 3,
    qualifiedEvents: 0, eligiblePV: 3, qualifiedPV: 0, qualifiedVisitors: 0,
  }, { startAt: 43200000, endAt: 86400000, timezone: 'Asia/Shanghai' });
  mocks.build.mockResolvedValue(source);
  const actual = await readSharedReport(request(), id);
  expect(actual.meta.population).toEqual(source.meta.population);
  expect(actual.meta.trendPopulation).toEqual(trend);
});
