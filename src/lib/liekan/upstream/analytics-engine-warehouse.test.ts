// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), auth: vi.fn() }));
vi.mock('./analysis-rollups-db', () => ({
  analysisTransaction: (work: any) => work({ $queryRawUnsafe: m.read, $executeRawUnsafe: m.write }),
  findAnalysisVersions: vi.fn(),
}));
vi.mock('./crawler-maintenance', () => ({ authenticateCrawlerMaintenance: m.auth }));
import { changeAnalyticsEngine, engineStatus } from './analytics-engine';
beforeEach(() => {
  vi.stubEnv('LIEKAN_WAREHOUSE_TRANSITION', 'true');
  m.read.mockReset();
  m.write.mockReset();
  m.auth.mockResolvedValue({ id: 'admin' });
});
afterEach(() => vi.unstubAllEnvs());
it.each(['postgres', 'clickhouse', 'frozen'])(
  'reports %s authority without scanning the retired replica',
  async authority => {
    m.read
      .mockResolvedValueOnce([{ role: 'admin' }])
      .mockResolvedValueOnce([{ authority, transition: 'shadow', revision: '4' }])
      .mockResolvedValueOnce([{ pending: true, configured: false }]);
    const status = await engineStatus('admin');
    expect(status.warehouse).toEqual({
      authority,
      transition: 'shadow',
      legacyCleanupPending: true,
      legacyCleanupConfigured: false,
    });
    expect(status.revision).toBe(4);
    expect(m.read).toHaveBeenCalledTimes(3);
    expect(m.write).not.toHaveBeenCalled();
  },
);
it('does not expose warehouse status to an ordinary user', async () => {
  m.read.mockResolvedValueOnce([{ role: 'user' }]);
  await expect(engineStatus('user')).rejects.toMatchObject({ status: 403 });
  expect(m.read).toHaveBeenCalledTimes(1);
});
it.each(['check', 'prepare', 'enable', 'disable', 'pause', 'resume', 'retry', 'verify'])(
  'rejects legacy %s before changing persistent state',
  async action => {
    m.read.mockResolvedValueOnce([{ role: 'admin' }]);
    await expect(
      changeAnalyticsEngine(new Request('http://localhost'), {
        action,
        requestId: crypto.randomUUID(),
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'engine-warehouse-managed' });
    expect(m.read).toHaveBeenCalledTimes(1);
    expect(m.write).not.toHaveBeenCalled();
  },
);
