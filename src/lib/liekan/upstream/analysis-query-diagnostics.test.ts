// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  query: vi.fn(),
  executeSql: vi.fn(),
  compute: vi.fn(),
  permit: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ hasPermission: vi.fn() }));
vi.mock('../crawlers/published', () => ({ getPublishedCatalog: () => undefined }));
vi.mock('./crawler-registry-context', () => ({
  withPublishedRegistry: (work: () => unknown) => work(),
}));
vi.mock('./analysis-rollups-db', () => ({
  analysisTransaction: (work: (tx: any) => unknown) =>
    work({ $queryRawUnsafe: m.query, $executeRawUnsafe: m.executeSql }),
  analysisCapacity: async () => ({
    globalBytes: '0',
    globalLimit: '1000000',
    siteBytes: '0',
    siteLimit: '1000000',
  }),
}));
vi.mock('./ai-db', () => ({ aiExecutor: (tx: unknown) => tx }));
vi.mock('./crawler-access', () => ({ authorizeCrawler: async () => ({ id: 'site' }) }));
vi.mock('./analytics-revision', () => ({
  readAnalyticsVersions: async () => ({ strong: 'strong' }),
}));
vi.mock('./analysis-background', () => ({ withAnalysisPermit: m.permit }));
vi.mock('./analysis-query-execution', () => ({ executeAnalysisQuery: m.compute }));
vi.mock('./dashboard-snapshots', () => ({
  dashboardJobClock: async () => undefined,
  publishDashboardSnapshot: async () => {},
}));
import { processAnalysisQuery } from './analysis-queries';
import { noteCacheResult } from './cache-context';
import { timeReportQuery } from './analysis-diagnostics';

const id = '11111111-1111-4111-8111-111111111111';
const row = {
  id,
  website_id: 'site',
  actor_id: 'actor',
  target: 'native:stats',
  attempts: 0,
  parameters: { endAt: 1000, timezone: 'UTC' },
  strong_version: 'strong',
  epoch: 1n,
  forced: false,
  catalog_version: null,
  foreground: true,
  queued_at: new Date(1000),
  started_at: null,
  next_attempt_at: new Date(9000),
  lease_token: 'lease',
};
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  row.attempts = 0;
  log = vi.spyOn(console, 'info').mockImplementation(() => {});
  m.permit.mockImplementation(async (_kind, work) => ({
    acquired: true,
    value: await work(() => true, { token: 'token', epoch: '1' }),
  }));
  m.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT q.id FROM liekan_analysis_query q WHERE')) return [];
    // Another delivery may have requeued the row after this initial read.
    if (sql.startsWith('SELECT q.*')) return [{ ...row, next_attempt_at: new Date(2000) }];
    if (sql.startsWith('UPDATE liekan_analysis_query'))
      return [{ ...row, attempts: row.attempts + 1, started_at: new Date(10000) }];
    if (sql.startsWith('SELECT s.epoch')) return [{ epoch: 1n, mode: 'raw', siteNumber: 1 }];
    if (sql.startsWith('SELECT 1 FROM liekan_analysis_background_lease WHERE'))
      return [{ id: true }];
    if (sql.startsWith('SELECT 1 FROM liekan_analysis_query q WHERE')) return [{ id }];
    if (sql.startsWith('SELECT id FROM')) return [{ id: true }];
    throw new Error('Unexpected mock query');
  });
  m.executeSql.mockResolvedValue(1);
  m.compute.mockImplementation(() =>
    timeReportQuery('human', async () => {
      noteCacheResult({
        value: {},
        generatedAt: Date.now(),
        expiresAt: Date.now() + 30000,
        status: 'miss',
      });
      return { pageviews: 1 };
    }),
  );
});
afterEach(() => vi.restoreAllMocks());

it('writes one bounded successful attempt record after actual compute and publication', async () => {
  expect((await processAnalysisQuery(id)).acquired).toBe(true);
  expect(m.compute).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
    event: 'analysis-attempt',
    attempt: 1,
    firstQueueWaitWallMs: 9000,
    retryEligibleWaitWallMs: null,
    outcome: 'ready',
    sourceResultState: 'computed',
    queryGroups: { human: { calls: 1, failures: 0 } },
  });
});

it('logs failed compute attempts without SQL, arbitrary parameters or exception messages', async () => {
  const error = new Error('SELECT secret visitor-ip full-UA credentials');
  m.compute.mockRejectedValue(error);
  expect((await processAnalysisQuery(id)).value).toBe(error);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
    outcome: 'failed',
    reason: 'compute-failed',
    sourceResultState: 'unobserved',
  });
  expect(log.mock.calls[0][0]).not.toMatch(
    /SELECT|secret|visitor-ip|full-UA|credentials|parameters|actor/,
  );
});

it('logs failed publication and retains retry timing separately from original queue age', async () => {
  row.attempts = 2;
  m.executeSql.mockImplementation(async (sql: string) => {
    if (sql.includes("SET status='ready'")) throw new Error('private publish SQL');
    return 1;
  });
  await processAnalysisQuery(id);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
    attempt: 3,
    attemptKind: 'retry',
    firstQueueWaitWallMs: null,
    retryEligibleWaitWallMs: 1000,
    outcome: 'failed',
    sourceResultState: 'computed',
    recoveryFailed: false,
  });
});

it('still emits its attempt record when recording failure recovery also fails', async () => {
  m.compute.mockRejectedValue(new Error('private compute'));
  m.executeSql.mockImplementation(async (sql: string) => {
    if (sql.includes('SET status=CASE')) throw new Error('private recovery');
    return 1;
  });
  await expect(processAnalysisQuery(id)).rejects.toThrow('private recovery');
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
    outcome: 'failed',
    recoveryFailed: true,
  });
  expect(log.mock.calls[0][0]).not.toContain('private');
});

it('emits no compute attempt when admission is contended or a candidate was already claimed', async () => {
  m.permit.mockResolvedValue({ acquired: false });
  expect(await processAnalysisQuery(id)).toMatchObject({ acquired: false, retryDelivery: true });
  expect(log).not.toHaveBeenCalled();
  expect(m.compute).not.toHaveBeenCalled();
  m.query.mockResolvedValue([]);
  expect(await processAnalysisQuery(id)).toMatchObject({ acquired: false, retryDelivery: false });
  expect(log).not.toHaveBeenCalled();
});
