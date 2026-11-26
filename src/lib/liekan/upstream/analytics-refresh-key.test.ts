vi.mock('./browser-population', async importOriginal => {
  const actual = await importOriginal<typeof import('./browser-population')>();
  return {
    ...actual,
    readBrowserPopulation: async (_id: string, start: Date, end: Date, timezone = 'UTC') =>
      actual.populationFromRow(
        {
          resourceKind: 'website',
          eligibleEvents: 1,
          qualifiedEvents: 1,
          eligiblePV: 1,
          qualifiedPV: 1,
          qualifiedVisitors: 1,
        },
        { startAt: +start, endAt: +end, timezone },
      ),
  };
});
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chartIds } from '../contracts/report';
import { analysisQuery, journeyQuery } from '../contracts/analysis';
import { readPageReport } from './page-report';
import { warmSharedReport } from './shared-report';
import { featureAnalytics, featureJourney } from './feature-analytics';
import { readWebsiteSummary } from './website-summary';
import { nativeAggregate } from './native-aggregate';
import { analyticsCache, QueryCache, type CachedResult } from './query-cache';
import { AnalyticsRedis } from './analytics-redis';
import { installAnalyticsRuntime } from './analytics-runtime';
import {
  analyticsWorkerContext,
  bindCacheRequest,
  currentCacheContext,
  withQueryCacheHeaders,
} from './cache-context';

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  rawQuery: vi.fn(),
  query: vi.fn(),
  sites: vi.fn(),
  sharePermission: vi.fn(),
}));
// The catalog pointer is checked independently of the per-site log-state cache.
vi.mock('./crawler-registry', async () => {
  const { getBundledPublishedCatalog } = await import('../crawlers/catalog-seed');
  const catalog = getBundledPublishedCatalog();
  return {
    readCrawlerRegistryPointer: async () => ({
      version: catalog.version,
      revision: catalog.revision,
    }),
    readPublishedRegistry: async () => catalog,
  };
});
vi.mock('../report', () => ({ buildReport: mocks.build }));
vi.mock('@/lib/auth', () => ({
  checkAuth: async () => ({ user: { id: '20000000-0000-4000-8000-000000000001', role: 'admin' } }),
}));
vi.mock('@/lib/prisma', () => ({
  default: {
    client: { website: { findMany: mocks.sites } },
    rawQuery: mocks.rawQuery,
    parseFilters: (filters: any) => ({
      filterQuery: '',
      joinSessionQuery: '',
      cohortQuery: '',
      excludeBounceQuery: '',
      queryParams: {
        websiteId: filters.websiteId,
        startDate: new Date(1000),
        endDate: new Date(2000),
      },
    }),
  },
  getRawQueryClient: (client: unknown) => client,
}));
vi.mock('@/lib/request', () => ({ getQueryFilters: async (input: any) => ({ ...input }) }));
vi.mock('@/queries/prisma', () => ({ getWebsiteSegment: vi.fn(), getReport: vi.fn() }));
vi.mock('@/queries/sql', () => ({ getWebsiteStats: vi.fn(), getWebsiteDateRange: vi.fn() }));
vi.mock('@/permissions', () => ({
  canViewReport: vi.fn(),
  canViewWebsiteSection: async () => true,
}));
vi.mock('@/permissions/share', () => ({ canViewWebsiteSection: mocks.sharePermission }));
vi.mock('./live-share', () => ({ loadShareEntity: vi.fn() }));
vi.mock('./server', async () => ({
  ...(await import('./errors')),
  authorize: vi.fn(),
  query: mocks.query,
  reportSnapshot: (work: () => unknown) => work(),
}));
vi.mock('./analytics', () => ({ classifyEntrySource: vi.fn() }));
vi.mock('@/queries/sql/heatmap/getHeatmap', () => ({ getRelationalHeatmapFilterContext: vi.fn() }));
vi.mock('./analytics-hot', () => ({
  rememberAnalyticsHot: async () => {},
  reserveWorkerComputation: async () => true,
}));

const id = '10000000-0000-4000-8000-000000000001';
const auth = { user: { id: '20000000-0000-4000-8000-000000000001', role: 'admin' } };
const website = { id, name: 'Synthetic refresh fixture', domain: 'synthetic.invalid' };
const range = { startAt: 1000, endAt: 2000, timezone: 'UTC' };
let computations = 0;
let hold: Promise<void> | undefined;
let redis: MemoryRedis;
let cache: QueryCache;
let runtimeConfigured = true;
let dataRevision = 0;
let policyRevision = 0;
let fallbackRevision = { data: '0', policy: '0' };

class MemoryRedis extends AnalyticsRedis {
  entries = new Map<string, CachedResult<any>>();
  owners = new Map<string, string>();
  rounds = new Map<string, string>();
  reads = vi.fn<(key: string) => void>();
  async read<T>(key: string) {
    this.reads(key);
    const value = this.entries.get(key);
    return value && value.expiresAt > Date.now()
      ? ({ ...value, status: 'hit' as const, tier: 'redis' as const } as CachedResult<T>)
      : null;
  }
  async claim(key: string, forced = false) {
    if (this.owners.has(key)) return false as const;
    const owner = forced ? 'f:owner' : 'n:owner';
    this.owners.set(key, owner);
    return owner;
  }
  async refreshSlot(key: string, round: string) {
    const previous = this.rounds.get(key);
    if (previous) return previous === round ? 1 : 0;
    this.rounds.set(key, round);
    return 1;
  }
  async publish<T>(key: string, token: string, result: CachedResult<T> | 'unshareable' | 'error') {
    if (this.owners.get(key) !== token) return false;
    if (typeof result !== 'string') this.entries.set(key, result);
    this.owners.delete(key);
    return true;
  }
  async renew(key: string, token: string) {
    return this.owners.get(key) === token;
  }
  async release(key: string, token: string) {
    if (this.owners.get(key) === token) this.owners.delete(key);
  }
}

const primary = () => ({
  $transaction: async (work: (tx: any) => Promise<unknown>, options: any) => {
    const snapshot =
      options?.isolationLevel === 'RepeatableRead' ? { dataRevision, policyRevision } : undefined;
    if (options?.isolationLevel === 'RepeatableRead') {
      computations++;
      await hold;
    }
    return work({
      $executeRawUnsafe: async () => 0,
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM liekan_analytics_revision'))
          return [{ type: 'website', id, revision: '0' }];
        if (sql.includes('FROM liekan_log_state'))
          return [
            {
              id,
              data: String(snapshot?.dataRevision ?? dataRevision),
              policy: String(snapshot?.policyRevision ?? policyRevision),
            },
          ];
        if (sql.includes('SELECT role')) return [{ role: 'admin' }];
        if (sql.includes('WITH resources')) return [{ id }];
        return [];
      },
    });
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic:synthetic@localhost/synthetic');
  vi.stubEnv('CLICKHOUSE_URL', '');
  vi.stubEnv('CLOUD_MODE', '');
  computations = 0;
  dataRevision = 0;
  policyRevision = 0;
  fallbackRevision = { data: '0', policy: '0' };
  runtimeConfigured = true;
  hold = undefined;
  redis = new MemoryRedis('');
  cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, redis);
  vi.spyOn(analyticsCache, 'read').mockImplementation(cache.read.bind(cache));
  vi.spyOn(analyticsCache, 'isRuntimeConfigured', 'get').mockImplementation(
    () => runtimeConfigured,
  );
  mocks.sharePermission.mockResolvedValue(true);
  mocks.sites.mockResolvedValue([{ id, createdAt: new Date(0) }]);
  mocks.rawQuery.mockImplementation(async (sql: string) =>
    sql.includes('COUNT(DISTINCT session_id) AS visitors FROM eligible')
      ? [{ visitors: computations }]
      : sql.includes('FROM eligible')
        ? []
        : [{ value: computations }],
  );
  mocks.query.mockImplementation(async (sql: string) =>
    sql.includes('FROM liekan_log_state')
      ? [{ ...fallbackRevision }]
      : [{ id, current: { pageviews: computations }, previous: {}, received: true, last_at: null }],
  );
  mocks.build.mockImplementation(async () => ({
    contractVersion: 2,
    website,
    range,
    states: { human: 'available', logs: 'available', catalog: 'available', goals: 'available' },
    cards: [{ key: 'visitors', label: '访客数 UV', value: computations, state: 'available' }],
    charts: Object.fromEntries(chartIds.map(key => [key, { labels: [], series: [] }])),
    tables: { envGrid: [], cityBody: [] },
    insights: [],
    meta: { demo: true, canManage: false, latestImportAt: null, ruleCount: 0 },
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  ['ai/overview', 1, 0, 300000],
  ['ai/bots', 1, 0, 300000],
  ['ai/pages', 1, 0, 300000],
  ['ai/preference', 1, 0, 300000],
  ['ai/overview', undefined, 0, 30000],
  ['ai/overview', 1, 1, 30000],
  ['overview', 1, 0, 30000],
  ['conversions', 1, 0, 30000],
  ['logs', 1, 0, 0],
])('keeps %s cache lifetime correct at the local midnight boundary', async (resource, version, offset, ttl) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T06:00:00Z'));
  const today = Date.parse('2026-10-22T16:00:00Z');
  try {
    const result = await readPageReport(website, {
      resource, crawlerMetricsVersion: version, startAt: today - 86400000,
      endAt: today + Number(offset), timezone: 'Asia/Shanghai',
    });
    expect(result.expiresAt - result.generatedAt).toBe(ttl);
  } finally {
    vi.useRealTimers();
  }
});

const entries = [
  {
    name: 'page-report',
    read: async (p: any) =>
      (await readPageReport(website, { ...p, resource: 'human/geo' }, p.refresh === '1')).value
        .cards[0].value,
  },
  {
    name: 'shared-report',
    read: async (p: any) => (await warmSharedReport(website, p, auth)).cards[0].value,
  },
  {
    name: 'feature-analysis',
    read: async (p: any) => (await featureAnalytics(id, { ...p, kind: 'sources' })).rows[0].value,
  },
  { name: 'feature-journey', read: async (p: any) => (await featureJourney(id, p)).visitors },
  {
    name: 'native-attribution',
    read: async (p: any) =>
      (
        await nativeAggregate(
          'native-attribution-v1',
          id,
          { ...p, startDate: new Date(p.startAt), endDate: new Date(p.endAt) },
          {},
          async () => ({ value: computations }),
        )
      ).value,
  },
  {
    name: 'website-summary',
    read: async (p: any, request: Request) =>
      (await readWebsiteSummary(request, { ...p, ids: id }))[0].pageviews,
  },
];

function request(entry: (typeof entries)[number], refresh = false) {
  return withQueryCacheHeaders(async () => {
    const p = { ...range, ...(refresh ? { refresh: '1' } : {}) };
    const url = new URL('http://localhost/synthetic');
    if (refresh) url.searchParams.set('refresh', '1');
    const request = new Request(url);
    bindCacheRequest(request, auth, p);
    return Response.json({ value: await entry.read(p, request) });
  });
}

it.each(entries)(
  '$name refresh replaces the normal result and shares its cooldown key',
  async entry => {
    expect(await (await request(entry)).json()).toEqual({ value: 1 });
    const reads = redis.reads.mock.calls.length;
    expect(await (await request(entry, true)).json()).toEqual({ value: 2 });
    expect(redis.reads).toHaveBeenCalledTimes(reads);
    expect(await (await request(entry)).json()).toEqual({ value: 2 });
    expect(computations).toBe(2);
    expect(redis.entries.size).toBe(1);
    expect(redis.rounds.size).toBe(1);
    expect((await request(entry, true)).status).toBe(429);
    expect(computations).toBe(2);
  },
);

it.each(entries)(
  '$name waits for the same cold query, then coalesces forced requests',
  async entry => {
    let release!: () => void;
    hold = new Promise<void>(resolve => {
      release = resolve;
    });
    const ordinary = request(entry);
    await vi.waitFor(() => expect(computations).toBe(1));
    const forced = request(entry, true);
    const duplicate = request(entry, true);
    await new Promise(resolve => setTimeout(resolve, 10));
    try {
      expect(computations).toBe(1);
    } finally {
      release();
    }
    const responses = await Promise.all([ordinary, forced, duplicate]);
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(await responses[0].json()).toEqual({ value: 1 });
    expect(await responses[1].json()).toEqual({ value: 2 });
    expect(await responses[2].json()).toEqual({ value: 2 });
    expect(computations).toBe(2);
    expect(redis.entries.size).toBe(1);
    expect(await (await request(entry)).json()).toEqual({ value: 2 });
  },
);

it('validates the journey refresh control while retaining custom property filters', () => {
  expect(journeyQuery.safeParse({ ...range, refresh: '1' }).success).toBe(true);
  expect(journeyQuery.safeParse({ ...range, refresh: 'eq.business' }).success).toBe(false);
  const spf = JSON.stringify({ propertyName: 'refresh', operator: 'eq', value: 'retained' });
  expect(analysisQuery.parse({ ...range, refresh: '1', spf1: spf }).spf1).toBe(spf);
  expect(journeyQuery.parse({ ...range, refresh: '1', spf1: spf }).spf1).toBe(spf);
});

const reportEntries = entries.slice(0, 2);

it.each(reportEntries)(
  '$name configured warm reads use the primary runtime versions without an extra log-state query',
  async entry => {
    expect(await (await request(entry)).json()).toEqual({ value: 1 });
    expect(await (await request(entry)).json()).toEqual({ value: 1 });
    expect(computations).toBe(1);
    expect(mocks.query).not.toHaveBeenCalled();
    expect((await vi.mocked(analyticsCache.read).mock.results.at(-1).value).tier).toBe('memory');
  },
);

it.each(reportEntries)('$name fallback keys still include both log revisions', async entry => {
  const fallback = new QueryCache();
  runtimeConfigured = false;
  vi.mocked(analyticsCache.read).mockImplementation(fallback.read.bind(fallback));
  await request(entry);
  await request(entry);
  expect(mocks.build).toHaveBeenCalledOnce();
  fallbackRevision.data = '1';
  await request(entry);
  expect(mocks.build).toHaveBeenCalledTimes(2);
  fallbackRevision.policy = '1';
  await request(entry);
  expect(mocks.build).toHaveBeenCalledTimes(3);
  expect(mocks.query).toHaveBeenCalledTimes(4);
});

it.each(
  reportEntries.flatMap(entry => ['data', 'policy'].map(revision => ({ ...entry, revision }))),
)('$name applies bounded data freshness and immediate policy invalidation across instances ($revision)', async entry => {
  const first = cache;
  expect(await (await request(entry)).json()).toEqual({ value: 1 });
  const second = new QueryCache();
  installAnalyticsRuntime(second, primary, redis);
  vi.mocked(analyticsCache.read).mockImplementation(second.read.bind(second));
  expect(await (await request(entry)).json()).toEqual({ value: 1 });
  expect((await vi.mocked(analyticsCache.read).mock.results.at(-1).value).tier).toBe('redis');
  if (entry.revision === 'data') dataRevision++;
  else policyRevision++;
  const expected = entry.revision === 'data' ? 1 : 2;
  expect(await (await request(entry)).json()).toEqual({ value: expected });
  vi.mocked(analyticsCache.read).mockImplementation(first.read.bind(first));
  expect(await (await request(entry)).json()).toEqual({ value: expected });
  expect(computations).toBe(expected);
  expect(redis.entries.size).toBe(expected);
  expect(mocks.query).not.toHaveBeenCalled();
});

it.each(reportEntries)(
  '$name ingestion during computation retains a reusable snapshot with bounded freshness',
  async entry => {
    const build = mocks.build.getMockImplementation();
    mocks.build.mockImplementationOnce(async () => {
      dataRevision++;
      return build();
    });
    expect(await (await request(entry)).json()).toEqual({ value: 1 });
    const result = await vi.mocked(analyticsCache.read).mock.results[0].value;
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(redis.entries.size).toBe(1);
    expect(await (await request(entry)).json()).toEqual({ value: 1 });
    expect(computations).toBe(1);
    expect(mocks.query).not.toHaveBeenCalled();
  },
);

it.each(reportEntries)('$name retries a snapshot crossed by a policy change', async entry => {
  const build = mocks.build.getMockImplementation();
  mocks.build.mockImplementationOnce(async () => {
    policyRevision++;
    return build();
  });
  expect(await (await request(entry)).json()).toEqual({ value: 2 });
  expect(computations).toBe(2);
  expect(redis.entries.size).toBe(1);
  expect(await (await request(entry)).json()).toEqual({ value: 2 });
  expect(mocks.query).not.toHaveBeenCalled();
});

it.each(reportEntries)(
  '$name worker publication replaces the same foreground query in memory and Redis',
  async entry => {
    expect(await (await request(entry)).json()).toEqual({ value: 1 });
    expect(
      await analyticsWorkerContext(auth.user.id, { private: true }, () =>
        entry.read(range, new Request('http://localhost/synthetic')),
      ),
    ).toBe(2);
    expect(await (await request(entry)).json()).toEqual({ value: 2 });
    const second = new QueryCache();
    installAnalyticsRuntime(second, primary, redis);
    vi.mocked(analyticsCache.read).mockImplementation(second.read.bind(second));
    expect(await (await request(entry)).json()).toEqual({ value: 2 });
    expect((await vi.mocked(analyticsCache.read).mock.results.at(-1).value).tier).toBe('redis');
    expect(computations).toBe(2);
    expect(redis.entries.size).toBe(1);
    expect(mocks.query).not.toHaveBeenCalled();
  },
);

it('configured public share publication preserves its current scope and restricted projection', async () => {
  const publicAuth = {
    shareToken: {
      shareId: '30000000-0000-4000-8000-000000000001',
      websiteId: id,
      parameters: { overview: true, goals: false },
    },
  };
  mocks.sharePermission.mockResolvedValue(false);
  let scope: unknown;
  const read = () =>
    withQueryCacheHeaders(async () => {
      bindCacheRequest(new Request('http://localhost/synthetic'), publicAuth, range);
      scope = currentCacheContext().scope;
      return Response.json(await warmSharedReport(website, range, publicAuth));
    });
  const first = await (await read()).json();
  expect(first.cards[0].value).toBe(1);
  expect(first.capabilities.goals).toBe(false);
  expect(first.states.goals).toBe('unsupported');
  const warmed = await analyticsWorkerContext(publicAuth.shareToken.shareId, scope, () =>
    warmSharedReport(website, range, publicAuth),
  );
  expect(warmed.cards[0].value).toBe(2);
  const second = new QueryCache();
  installAnalyticsRuntime(second, primary, redis);
  vi.mocked(analyticsCache.read).mockImplementation(second.read.bind(second));
  const shared = await (await read()).json();
  expect(shared.cards[0].value).toBe(2);
  expect(shared.capabilities.goals).toBe(false);
  expect(shared.states.goals).toBe('unsupported');
  expect(shared.meta).toEqual({ demo: true, canManage: false, latestImportAt: null, ruleCount: 0 });
  expect((await vi.mocked(analyticsCache.read).mock.results.at(-1).value).tier).toBe('redis');
  expect(computations).toBe(2);
  expect(redis.entries.size).toBe(1);
  expect(mocks.query).not.toHaveBeenCalled();
});
