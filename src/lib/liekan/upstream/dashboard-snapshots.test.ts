// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  failure: null as any,
  row: null as any,
  request: vi.fn(),
  query: vi.fn(),
}));
vi.mock('./analysis-rollups-db', () => ({
  analysisTransaction: async (work: any, isolation?: string) => {
    if (isolation === 'RepeatableRead') throw m.failure;
    return work({ $queryRawUnsafe: m.query, $executeRawUnsafe: async () => 1 });
  },
  analysisCapacity: async () => ({
    globalBytes: '0',
    siteBytes: '0',
    globalLimit: 1e9,
    siteLimit: 1e9,
  }),
}));
vi.mock('./analysis-queries', () => ({
  analysisQueryState: async () => ({
    mode: 'live',
    strong: 'same',
    epoch: 1n,
    website: { id: '11111111-1111-4111-8111-111111111111', domain: 'snapshot.invalid' },
  }),
  requestAnalysisQuery: m.request,
}));
vi.mock('./crawler-registry-context', () => ({ withPublishedRegistry: (work: any) => work() }));
vi.mock('./report-evidence-view', () => ({
  attachReportEvidenceView: async (value: any) => value,
}));
vi.mock('./cache-context', () => ({ noteBrowserPopulation: () => {} }));
import { requestDashboardSnapshot } from './dashboard-snapshots';
import { ANALYSIS_RESULT_FORMAT } from './analysis-query-model';
const now = Date.parse('2026-11-02T12:05:35Z');
const parameters = {
  resource: 'ai/bots',
  timezone: 'UTC',
  crawlerMetricsVersion: 1,
  startAt: Date.parse('2026-11-02T00:00Z'),
  endAt: Date.parse('2026-11-03T00:00Z'),
};
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  m.row = {
    website_id: '11111111-1111-4111-8111-111111111111',
    query_key: 'saved',
    target: 'feature:page-report',
    parameters,
    strong_version: 'same',
    epoch: 1n,
    data_through: new Date(now - 35000),
    dependency_end: new Date(now - 35000),
    last_read_at: new Date(now),
    next_refresh_at: new Date(now - 1),
    generated_at: new Date(now - 35000),
    result: {
      format: ANALYSIS_RESULT_FORMAT,
      value: { range: { ...parameters, endAt: now - 35000 }, meta: {} },
      populations: [],
    },
  };
  m.query.mockImplementation(async (statement: string) => {
    if (statement.includes('UPDATE liekan_dashboard_snapshot SET actor_id')) return [m.row];
    if (statement.includes('liekan_dashboard_fingerprint')) return [{ fingerprint: 'same' }];
    if (statement.includes('max(created_at)::text')) return [{ latest: null, count: '0' }];
    throw new Error(`Unexpected synthetic query: ${statement}`);
  });
  m.request.mockResolvedValue({ ready: false, analysisJob: { id: 'queued' } });
});
afterEach(() => vi.restoreAllMocks());
const request = () =>
  requestDashboardSnapshot(
    m.row.website_id,
    { id: 'actor', role: 'user' },
    'feature:page-report',
    parameters,
  );

it('rejoins normal admission for nested Prisma raw-query serialization errors', async () => {
  m.failure = {
    code: 'P2010',
    meta: { driverAdapterError: { cause: { originalCode: '40001' } } },
  };
  expect(await request()).toMatchObject({ ready: true, snapshotState: 'updating' });
  expect(m.request).toHaveBeenCalled();
});
it('preserves nested Prisma raw-query errors with other SQL states', async () => {
  m.request.mockClear();
  m.failure = {
    code: 'P2010',
    meta: { driverAdapterError: { cause: { originalCode: '42P01' } } },
  };
  await expect(request()).rejects.toBe(m.failure);
  expect(m.request).not.toHaveBeenCalled();
});
