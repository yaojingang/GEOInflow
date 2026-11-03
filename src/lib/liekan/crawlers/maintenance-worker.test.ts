// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  work: vi.fn(),
  send: vi.fn(),
  stop: vi.fn(),
  handlers: new Map<string, () => Promise<void>>(),
  ranges: vi.fn(),
  documents: vi.fn(),
  execute: vi.fn(async (_sql: string, ..._args: unknown[]) => 1),
  closeWarehouse: vi.fn(async () => {}),
}));
vi.mock('pg-boss', () => ({
  PgBoss: class {
    on() {}
    async start() {}
    work = h.work;
    send = h.send;
    stop = h.stop;
  },
}));
vi.mock('node:fs/promises', () => ({ writeFile: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ default: { client: { $disconnect: vi.fn() } } }));
vi.mock('../upstream/server', () => ({
  LiekanError: class extends Error {},
  query: vi.fn(async () => []),
  transaction: vi.fn(async work =>
    work({ $executeRawUnsafe: h.execute, $queryRawUnsafe: vi.fn(async () => []) }),
  ),
}));
vi.mock('../warehouse/process-resources', () => ({ closeWarehouseProcessResources: h.closeWarehouse }));
vi.mock('../upstream/crawler-registry-context', () => ({ initializeCrawlerRegistry: vi.fn(), withPublishedRegistry: (work: () => unknown) => work() }));
vi.mock('../geography/update', () => ({ maintainGeography: vi.fn() }));
vi.mock('../upstream/browser-risk', () => ({ processBrowserRisk: vi.fn() }));
vi.mock('../log-ingestion/maintenance', () => ({ reconcilePermissions: vi.fn() }));
vi.mock('../log-ingestion/recovery', () => ({ recoverBatches: vi.fn() }));
vi.mock('../log-ingestion/service', () => ({ processBatch: vi.fn() }));
vi.mock('../log-ingestion/cloudflare', () => ({ cleanupExpiredAuthorizations: vi.fn() }));
vi.mock('../log-ingestion/provider', () => ({ maintainProvider: vi.fn() }));
vi.mock('../log-ingestion/secrets', () => ({
  sealPlatformSecret: vi.fn(),
  openPlatformSecret: vi.fn(),
}));
vi.mock('../log-ingestion/ranges', () => ({ refreshRanges: h.ranges }));
vi.mock('../upstream/crawler-maintenance', () => ({ refreshDocumentSources: h.documents }));
vi.mock('./worker', () => ({ processCrawlerAnalysis: vi.fn() }));
vi.mock('../crawler-control/diagnostics', () => ({ processCrawlerCheck: vi.fn() }));
vi.mock('../crawler-control/retention', () => ({ maintainCrawlerRecords: vi.fn() }));
vi.mock('../crawler-control/deployments', () => ({ processCrawlerDeployment: vi.fn() }));
vi.mock('../crawler-control/restore', () => ({ pauseRestoredCrawlerControl: vi.fn() }));
import { CRAWLER_SOURCE_RETRY } from '../log-ingestion/queue';
import { DOCUMENT_JOB_SECONDS } from './document-sources';
const argv = [...process.argv];
afterEach(() => {
  process.argv = [...argv];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.handlers.clear();
});

describe('existing log worker document maintenance scheduling', () => {
  it.each([[true, false], [false, false], [true, true], [false, true]])('honors pause=%s and warehouse=%s', async (paused, warehouse) => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', warehouse ? 'clickhouse' : '');
    vi.stubEnv('LIEKAN_WAREHOUSE_TRANSITION', 'false');
    h.send.mockResolvedValue(null);
    h.stop.mockResolvedValue(undefined);
    process.argv = [...argv, ...(paused ? ['--pause-crawler-maintenance'] : [])];
    const listener = vi.spyOn(process, 'on').mockImplementation(((event, handler) => {
      if (event === 'SIGINT' || event === 'SIGTERM') h.handlers.set(event, handler);
      return process;
    }) as typeof process.on);
    await import('../../../liekan-worker/main');
    for (let n = 0; n < 100 && !h.handlers.has('SIGINT'); n++) await Promise.resolve();
    expect(listener).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    const queues = h.work.mock.calls.map(call => call[0]);
    for (const queue of [
      'liekan-range-refresh',
      'liekan-crawler-documents',
      'liekan-crawler-analysis',
    ])
      expect(queues.includes(queue)).toBe(!paused);
    expect(queues).toContain('liekan-log-ingest');
    await vi.advanceTimersByTimeAsync(3600001);
    const sent = h.send.mock.calls.map(call => call[0]);
    for (const queue of [
      'liekan-range-refresh',
      'liekan-crawler-documents',
      'liekan-crawler-analysis',
    ])
      expect(sent.includes(queue)).toBe(!paused);
    if (!paused) {
      for (const queue of ['liekan-range-refresh', 'liekan-crawler-documents'])
        expect(h.send).toHaveBeenCalledWith(
          queue,
          {},
          expect.objectContaining(CRAWLER_SOURCE_RETRY),
        );
      // Propagating the busy error is what makes pg-boss persist a retry instead of a successful skip.
      for (const [queue, handler] of [
        ['liekan-range-refresh', h.ranges],
        ['liekan-crawler-documents', h.documents],
      ] as const) {
        const busy = new Error('crawler_source_maintenance_busy');
        handler.mockRejectedValueOnce(busy).mockResolvedValueOnce(undefined);
        const work = h.work.mock.calls.find(call => call[0] === queue)[2];
        await expect(work([])).rejects.toBe(busy);
        await expect(work([])).resolves.toBeUndefined();
      }
      const minimumRetryWindow =
        (CRAWLER_SOURCE_RETRY.retryDelay * (2 ** CRAWLER_SOURCE_RETRY.retryLimit - 1)) / 2;
      expect(minimumRetryWindow).toBeGreaterThan(Math.max(DOCUMENT_JOB_SECONDS, 300));
      expect(h.send).toHaveBeenCalledWith(
        'liekan-crawler-documents',
        {},
        expect.objectContaining({ expireInSeconds: DOCUMENT_JOB_SECONDS }),
      );
    }
    h.handlers.get('SIGINT')();
    for (let n = 0; n < 100 && !h.closeWarehouse.mock.calls.length; n++) await Promise.resolve();
    expect(h.stop).toHaveBeenCalledWith({ graceful: true, timeout: 30000 });
    expect(h.closeWarehouse).toHaveBeenCalledOnce();
    expect(h.closeWarehouse.mock.invocationCallOrder[0]).toBeGreaterThan(h.stop.mock.invocationCallOrder[0]);
    const sql = h.execute.mock.calls.map(call => String(call[0]));
    expect(sql.some(text => text.includes('DELETE FROM liekan_geography_ingress'))).toBe(!warehouse);
    expect(sql.some(text => text.includes('DELETE FROM liekan_log_grant'))).toBe(true);
  });
});
