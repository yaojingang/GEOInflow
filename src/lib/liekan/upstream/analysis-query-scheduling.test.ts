// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  query: vi.fn(),
  write: vi.fn(),
  compute: vi.fn(),
  permit: vi.fn(),
  admission: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ hasPermission: async () => false }));
vi.mock('../crawlers/published', () => ({ getPublishedCatalog: () => undefined }));
vi.mock('./crawler-registry-context', () => ({ withPublishedRegistry: (work: any) => work() }));
vi.mock('./analysis-rollups-db', () => ({
  analysisTransaction: (work: any) =>
    work({ $queryRawUnsafe: m.query, $executeRawUnsafe: m.write }),
  analysisCapacity: async () => ({
    globalBytes: '0',
    siteBytes: '0',
    globalLimit: '10000000',
    siteLimit: '10000000',
  }),
}));
vi.mock('./ai-db', () => ({ aiExecutor: (tx: unknown) => tx }));
vi.mock('./crawler-access', () => ({ authorizeCrawler: async () => ({ id: 'site' }) }));
vi.mock('./analytics-revision', () => ({
  readAnalyticsVersions: async () => ({ strong: 'strong' }),
}));
vi.mock('./analysis-page-admission', () => ({
  firstPageRange: () => ({ start: new Date(0), end: new Date(1000) }),
  canReadFirstPage: m.admission,
  FIRST_PAGE_BUDGET_MS: 750,
}));
vi.mock('./analysis-background', () => ({ withAnalysisPermit: m.permit }));
vi.mock('./analysis-query-execution', () => ({ executeAnalysisQuery: m.compute }));
vi.mock('./dashboard-snapshots', () => ({
  dashboardJobClock: async () => undefined,
  publishDashboardSnapshot: async () => {},
}));
import { processAnalysisQuery, processAnalysisQueryDelivery } from './analysis-queries';
import { currentCacheContext, noteCacheResult } from './cache-context';

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  website_id: 'site',
  actor_id: 'actor',
  target: 'feature:page-report',
  attempts: 0,
  foreground: true,
  parameters: { resource: 'overview', endAt: 1000, timezone: 'UTC' },
  strong_version: 'strong',
  epoch: 1n,
  forced: false,
  catalog_version: null,
  queued_at: new Date(),
  next_attempt_at: new Date(),
  lease_token: 'lease',
};
beforeEach(() => {
  vi.resetAllMocks();
  row.target = 'feature:page-report';
  row.attempts = 0;
  row.foreground = true;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  m.permit.mockImplementation(async (_kind, work) => ({
    acquired: true,
    value: await work(() => true, { token: 'token', epoch: '1' }),
  }));
  m.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT q.id FROM liekan_analysis_query q WHERE')) return [];
    if (sql.startsWith('SELECT q.*')) return [{ ...row }];
    if (sql.startsWith('UPDATE liekan_analysis_query'))
      return [{ ...row, attempts: row.attempts + 1, started_at: new Date() }];
    if (sql.startsWith('SELECT s.epoch')) return [{ epoch: 1n, mode: 'raw', siteNumber: 1 }];
    if (sql.startsWith('SELECT id FROM') || sql.startsWith('SELECT 1 FROM liekan_analysis_'))
      return [{ id: true }];
    throw new Error('Unexpected scheduling query');
  });
  m.admission.mockResolvedValue(true);
  m.write.mockResolvedValue(1);
  m.compute.mockResolvedValue({ pageviews: 1 });
});
afterEach(() => vi.restoreAllMocks());

it.each([
  ['feature:page-report', 0, true, 'dashboard', 60000],
  ['feature:page-report', 1, true, 'dashboard', 60000],
  ['feature:page-report', 0, false, 'interactive', 10000],
  ['native:stats', 0, true, 'dashboard', 10000],
  ['native:stats', 1, true, 'interactive', 60000],
  ['native:pageviews', 0, true, 'dashboard', 10000],
  ['native:pageviews', 1, true, 'interactive', 60000],
  ['native:heatmaps', 0, true, 'interactive', 10000],
  ['native:heatmaps', 1, true, 'interactive', 10000],
  ['native:metrics', 0, true, 'interactive', 60000],
] as const)(
  'uses the required budget and lane for %s attempt %s with demand %s',
  async (target, attempts, foreground, lane, budget) => {
    Object.assign(row, { target, attempts, foreground });
    m.compute.mockImplementation(async () => {
      expect(currentCacheContext().deadline - Date.now()).toBeGreaterThan(budget - 1000);
      expect(currentCacheContext().deadline - Date.now()).toBeLessThanOrEqual(budget);
      return { pageviews: 1 };
    });
    const result = await processAnalysisQuery(row.id);
    expect(result.value).toBeUndefined();
    expect(m.permit.mock.calls[0][0]).toBe(lane);
  },
);

it('allows an ordinary first computation beyond ten seconds within its original deadline', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
  m.compute.mockImplementation(async () => {
    clock.mockReturnValue(111000);
    if (currentCacheContext().deadline <= Date.now()) throw new Error('deadline expired');
    return { pageviews: 1 };
  });
  expect((await processAnalysisQuery(row.id)).value).toBeUndefined();
  expect(m.write.mock.calls.some(([sql]) => sql.includes("SET status='ready'"))).toBe(true);
});

it('keeps source refresh within the same ordinary attempt deadline', async () => {
  const deadlines: number[] = [];
  m.compute.mockImplementation(async () => {
    deadlines.push(currentCacheContext().deadline);
    noteCacheResult({
      value: {},
      generatedAt: Date.now(),
      expiresAt: Date.now() + (deadlines.length === 1 ? -1 : 30000),
      status: 'miss',
    });
    return { pageviews: 1 };
  });
  expect((await processAnalysisQuery(row.id)).value).toBeUndefined();
  expect(deadlines).toHaveLength(2);
  expect(deadlines[0]).toBe(deadlines[1]);
});

it.each([
  ['feature:page-report', 0, false],
  ['native:stats', 1, true],
  ['native:pageviews', 1, true],
  ['native:heatmaps', 0, true],
] as const)(
  'does not scan for dashboard successors after shared %s attempt %s demand %s',
  async (target, attempts, foreground) => {
    Object.assign(row, { target, attempts, foreground });
    const boss = { send: vi.fn(), fail: vi.fn(), update: vi.fn() };
    await processAnalysisQueryDelivery({ id: row.id, retryCount: 0, data: { id: row.id } }, boss);
    expect(m.compute).toHaveBeenCalledOnce();
    expect(m.query.mock.calls.some(([sql]) => sql.includes('true AS foreground'))).toBe(false);
    expect(boss.send).not.toHaveBeenCalled();
  },
);

it('keeps a failed dashboard computation on its durable retry without a successor scan', async () => {
  m.compute.mockRejectedValue(new Error('synthetic dashboard computation failure'));
  const boss = { send: vi.fn(), fail: vi.fn(), update: vi.fn() };
  await processAnalysisQueryDelivery({ id: row.id, retryCount: 0, data: { id: row.id } }, boss);
  expect(m.query.mock.calls.some(([sql]) => sql.includes('true AS foreground'))).toBe(false);
  expect(boss.send).not.toHaveBeenCalled();
});

it('publishes the existing report with a shared 750ms foreground deadline', async () => {
  m.compute.mockImplementation(async () => {
    expect(currentCacheContext().deadline - Date.now()).toBeGreaterThan(650);
    expect(currentCacheContext().deadline - Date.now()).toBeLessThanOrEqual(750);
    return { pageviews: 7 };
  });
  expect((await processAnalysisQuery(row.id, { firstPage: true })).value).toBeUndefined();
  expect(m.admission).toHaveBeenCalledOnce();
  expect(
    m.query.mock.calls.some(([sql]) => sql.includes('fast_attempted_at=clock_timestamp()')),
  ).toBe(true);
  expect(m.write.mock.calls.some(([sql]) => sql.includes("SET status='ready'"))).toBe(true);
});
it.each(['oversized', 'timeout', 'metadata'])(
  'returns %s foreground work to the same queued task without worker backoff',
  async reason => {
    if (reason === 'oversized') m.admission.mockResolvedValue(false);
    else {
      const { LiekanError } = await import('./errors');
      m.admission.mockRejectedValue(
        new LiekanError(
          'bounded',
          503,
          reason === 'metadata' ? 'liekan-error' : 'analysis-query-timeout',
        ),
      );
    }
    const result = await processAnalysisQuery(row.id, { firstPage: true });
    expect(result.value).toBeInstanceOf(Error);
    expect(m.compute).not.toHaveBeenCalled();
    const reset = m.write.mock.calls.find(([sql]) =>
      sql.includes('attempts=greatest(0,attempts-1)'),
    );
    expect(reset?.[0]).toContain('next_attempt_at=clock_timestamp()');
    expect(m.write.mock.calls.some(([sql]) => sql.includes('WHEN 1 THEN 5'))).toBe(false);
  },
);
it('keeps a foreground permission failure fenced instead of treating it as a budget deferral', async () => {
  const { LiekanError } = await import('./errors');
  m.admission.mockRejectedValue(new LiekanError('denied', 403));
  await processAnalysisQuery(row.id, { firstPage: true });
  expect(m.write.mock.calls.some(([sql]) => sql.includes('attempts=greatest'))).toBe(false);
  expect(
    m.write.mock.calls.some(([sql, ...args]) => sql.includes('WHEN 1 THEN 5') && args[2] === 403),
  ).toBe(true);
});
