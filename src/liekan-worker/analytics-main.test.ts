// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  events: [] as string[],
  history: vi.fn(),
}));
vi.mock('pg-boss', () => ({
  PgBoss: class {
    on() {}
    async start() {}
    async work() {}
  },
}));
vi.mock('node:fs/promises', () => ({ writeFile: async () => {} }));
vi.mock('../lib/prisma', () => ({ default: { client: {} } }));
vi.mock('../lib/liekan/log-ingestion/queue', () => ({ QUEUE_SCHEMA: 'synthetic' }));
vi.mock('../lib/liekan/upstream/analytics-engine-worker', () => ({
  pumpAnalyticsEngine: async () => {},
}));
vi.mock('../lib/liekan/upstream/analysis-expansion', () => ({
  probeAnalysisExpansion: async () => {},
}));
vi.mock('../lib/liekan/upstream/analysis-queries', () => ({
  pumpAnalysisQueries: async () => {
    m.events.push('queries');
  },
  processAnalysisQueryDelivery: async () => {},
}));
vi.mock('../lib/liekan/upstream/dashboard-snapshots', () => ({
  pumpDashboardDemand: async (dispatch?: () => Promise<void>) => {
    m.events.push('dashboard-batch-1');
    await dispatch?.();
    m.events.push('dashboard-batch-2');
  },
}));
vi.mock('../lib/liekan/upstream/analysis-build-queue', () => ({
  pumpAnalysisBuilds: async () => {
    m.events.push('builds');
  },
  processAnalysisBuild: async () => {},
}));
vi.mock('../lib/liekan/upstream/analysis-rollups-worker', () => ({
  bootstrapAnalysisHistory: () => m.history(),
  reconcileAnalysisRollups: async () => {
    m.events.push('reconcile');
  },
}));
vi.mock('../lib/liekan/upstream/analysis-background', () => ({
  withAnalysisPermit: async () => {},
}));
vi.mock('../lib/liekan/upstream/geo-weight-snapshots', () => ({
  GEO_SNAPSHOT_QUEUE: 'synthetic-geo',
  processGeoSnapshotJob: async () => {},
  reconcileGeoSnapshots: async () => {},
}));
vi.mock('../lib/liekan/upstream/analytics-hot', () => ({
  ANALYTICS_QUEUE: 'synthetic-hot',
  pumpAnalyticsHot: async () => {
    m.events.push('hot');
  },
}));
vi.mock('../lib/liekan/upstream/analytics-redis', () => ({ analyticsRedis: {} }));
vi.mock('./analytics-refresh', () => ({
  processAnalyticsRefresh: async () => {},
  readAnalyticsHotStrongVersion: async () => '',
}));
vi.mock('../lib/liekan/upstream/storage-retention', () => ({
  pumpStorageRetention: async () => {},
}));
vi.mock('../lib/liekan/upstream/analytics-input-summary', () => ({
  maintainAnalyticsInputSummaries: async () => {},
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('dispatches queued reads before blocked history discovery and between dashboard batches', async () => {
  vi.useFakeTimers();
  vi.spyOn(process, 'on').mockReturnValue(process);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  m.history.mockImplementation(async () => {
    m.events.push('history');
    await gate;
  });
  await import('./analytics-main');
  expect(m.events).toEqual(['queries', 'history']);
  release();
  await vi.waitFor(() => expect(m.events.at(-1)).toBe('hot'));
  expect(m.events).toEqual([
    'queries',
    'history',
    'queries',
    'reconcile',
    'dashboard-batch-1',
    'queries',
    'dashboard-batch-2',
    'queries',
    'builds',
    'hot',
  ]);
});
