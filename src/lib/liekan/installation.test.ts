import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/liekan/websites/[websiteId]/installation/route';
import { installationActionSchema } from './contracts/installation';
import { getInstallation, saveInstallation } from './installation';
import { LiekanError } from './upstream/errors';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  lock: vi.fn(),
  authorize: vi.fn(),
  execute: vi.fn(),
  read: vi.fn(),
  observation: vi.fn(),
  warehouseLogs: vi.fn(),
  warehouseBrowser: vi.fn(),
}));
vi.mock('./upstream/warehouse-presence', () => ({
  warehouseInstallationLogs: mocks.warehouseLogs,
  warehouseCollectionPresence: mocks.warehouseBrowser,
}));
vi.mock('./upstream/installation-observation', () => ({
  readInstallationObservation: mocks.observation,
}));
vi.mock('./upstream/server', async () => ({
  LiekanError: (await import('./upstream/errors')).LiekanError,
  query: mocks.query,
  transaction: mocks.transaction,
  lockWritableWebsite: mocks.lock,
  authorize: mocks.authorize,
}));
const id = '5b4c0de0-6c47-5b51-8f53-11e5e8c79001';
const identity = { userId: '5b4c0de0-6c47-5b51-8f53-11e5e8c79002' };
const params = { params: Promise.resolve({ websiteId: id }) };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'postgresql');
  mocks.read.mockResolvedValue([]);
  mocks.observation.mockResolvedValue({ status: 'empty', sampleCount: 0, coverage: null });
  mocks.execute.mockResolvedValue(1);
  mocks.lock.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(work =>
    work({ $queryRawUnsafe: mocks.read, $executeRawUnsafe: mocks.execute }),
  );
  mocks.query.mockImplementation(sql =>
    Promise.resolve(
      sql.includes('liekan_reporting_log')
        ? [{ total: 0, ai: 0, demo: false, latestAt: null, latestImportAt: null }]
        : [],
    ),
  );
  mocks.authorize.mockResolvedValue({
    website: { id, domain: 'example.com' },
    canManage: true,
    writeIdentity: identity,
  });
});

describe('website installation progress', () => {
  it('verifies both warehouse inputs while setup metadata remains in PG', async () => {
    vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'clickhouse');
    const logs = { total: 8, ai: 3, demo: false, latestAt: null, latestImportAt: null };
    const browser = { pageviews: 4, firstAt: null, lastAt: null };
    mocks.warehouseLogs.mockResolvedValue(logs);
    mocks.warehouseBrowser.mockResolvedValue(browser);
    const status = await getInstallation(id, false);
    expect(status.logs).toEqual(logs);
    expect(status.browser).toEqual(browser);
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        /liekan_reporting_log|liekan_raw_website_event/.test(sql),
      ),
    ).toBe(false);
  });
  it.each(['api-key', 'partial', 'share', undefined])(
    'preserves old fields and omits new private observation for identity %s',
    async authType => {
      mocks.authorize.mockResolvedValue({
        website: { id },
        canManage: true,
        auth: {
          authType,
          user: { id: identity.userId },
          ...(authType === 'share' ? { shareToken: {} } : {}),
        },
      });
      const response = await GET(new Request('http://localhost/api'), params);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.progress).toHaveProperty('completedAt', null);
      expect(body.identityIngress).not.toHaveProperty('observation');
      expect(mocks.observation).not.toHaveBeenCalled();
    },
  );
  it('adds the optional observation only for a complete private session', async () => {
    mocks.authorize.mockResolvedValue({
      website: { id },
      canManage: false,
      auth: { authType: 'session', user: { id: identity.userId } },
    });
    const response = await GET(new Request('http://localhost/api'), params);
    expect(response.status).toBe(200);
    expect((await response.json()).identityIngress.observation).toMatchObject({
      status: 'empty',
      coverage: null,
    });
    expect(mocks.observation).toHaveBeenCalledWith(id, identity.userId);
  });
  it('keeps saved progress, raw browser receipts and logs when the diagnostic times out', async () => {
    mocks.observation.mockResolvedValue({
      status: 'temporarily_unavailable',
      sampleCount: null,
      coverage: null,
      reasons: ['diagnostic_timeout'],
    });
    const result = await getInstallation(id, false, identity);
    expect(result).toMatchObject({
      progress: { completedAt: null },
      logs: { total: 0 },
      browser: { pageviews: 0 },
      identityIngress: { observation: { status: 'temporarily_unavailable', coverage: null } },
    });
  });
  it('rejects observation authority changes without returning the old fields', async () => {
    mocks.authorize.mockResolvedValue({
      website: { id },
      canManage: false,
      auth: { authType: 'session', user: { id: identity.userId } },
    });
    mocks.observation.mockRejectedValue(new LiekanError('站点读取权限已变更', 403));
    const response = await GET(new Request('http://localhost/api'), params);
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty('progress');
  });
  it('reports received collection independently of the eligible analytics population', async () => {
    const original = mocks.query.getMockImplementation();
    mocks.query.mockImplementation((sql, ...params) =>
      sql.includes('FROM liekan_raw_website_event')
        ? Promise.resolve([{ pageviews: 3, firstAt: new Date(1000), lastAt: new Date(2000) }])
        : original(sql, ...params),
    );
    expect((await getInstallation(id, false)).browser).toEqual({
      pageviews: 3,
      firstAt: new Date(1000).toISOString(),
      lastAt: new Date(2000).toISOString(),
    });
  });
  it('reports a source-state read failure instead of presenting an empty source list', async () => {
    const original = mocks.query.getMockImplementation();
    mocks.query.mockImplementation((sql, ...params) =>
      sql.includes('FROM liekan_log_source')
        ? Promise.reject(new LiekanError('日志接入状态暂时无法读取', 503))
        : original(sql, ...params),
    );
    const result = await GET(new Request('http://localhost/api'), params);
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ error: { message: '日志接入状态暂时无法读取' } });
  });
  it('keeps missing data and unavailable automatic connections distinct from saved completion', async () => {
    const result = await getInstallation(id, false);
    expect(result).toMatchObject({
      canManage: false,
      progress: { completedAt: null, browserCheckDeferred: false, logCheckDeferred: false },
      logs: { total: 0, ai: 0 },
      capabilities: { cloudflare: false, server: false },
    });
    const websiteQueries = mocks.query.mock.calls.filter(
      call => !call[0].includes('liekan_worker_state'),
    );
    expect(websiteQueries.length).toBeGreaterThan(0);
    expect(websiteQueries.every(call => call[1] === id)).toBe(true);
  });
  it('rejects arbitrary connection or analytics state in guide actions', async () => {
    for (const value of [
      { action: 'finish', method: 'server', authorized: true },
      { action: 'finish', method: 'other' },
      { action: 'connected' },
      { action: 'skip-browser', websiteId: 'other-site' },
      { action: 'continue', step: 'complete', method: 'manual' },
      { action: 'continue', step: 'finish', method: 'manual', completedAt: '2026-10-04' },
    ]) {
      expect(installationActionSchema.safeParse(value).success).toBe(false);
      await expect(saveInstallation(id, value, identity)).rejects.toThrow('接入设置格式无效');
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('locks website permissions before reading and changes only the selected progress fields', async () => {
    const saved = {
      method: 'cloudflare',
      browserCheckDeferred: true,
      logCheckDeferred: false,
      completedAt: '2026-10-01T00:00:00.000Z',
    };
    mocks.read.mockResolvedValue([saved]);
    const result = await saveInstallation(id, { action: 'skip-logs', method: 'server' }, identity);
    expect(result.progress).toEqual({
      ...saved,
      method: 'server',
      logCheckDeferred: true,
      lastStep: 'finish',
    });
    expect(mocks.lock).toHaveBeenCalledWith(expect.anything(), id, identity);
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.read.mock.invocationCallOrder[0],
    );
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO liekan_installation'),
      id,
      'server',
      true,
      true,
      saved.completedAt,
      'finish',
    );
    expect(mocks.execute.mock.calls[0][0]).not.toMatch(/liekan_log|liekan_import/);
  });
  it('records all postponed checks and makes repeated completion idempotent', async () => {
    const deferred = await saveInstallation(
      id,
      { action: 'skip-checks', method: 'manual' },
      identity,
    );
    expect(deferred.progress).toMatchObject({
      browserCheckDeferred: true,
      logCheckDeferred: true,
      completedAt: null,
    });
    mocks.read.mockResolvedValue([deferred.progress]);
    const first = await saveInstallation(id, { action: 'finish', method: 'manual' }, identity);
    mocks.read.mockResolvedValue([first.progress]);
    const second = await saveInstallation(id, { action: 'finish', method: 'manual' }, identity);
    expect(first.progress.completedAt).toBeTruthy();
    expect(second.progress).toEqual(first.progress);
  });
  it.each(['logs', 'finish'])(
    'persists normal advancement to %s without changing check or completion state',
    async step => {
      const result = await saveInstallation(
        id,
        { action: 'continue', step, method: 'server' },
        identity,
      );
      expect(result.progress).toEqual({
        method: 'server',
        lastStep: step,
        browserCheckDeferred: false,
        logCheckDeferred: false,
        completedAt: null,
      });
      expect(mocks.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO liekan_installation'),
        id,
        'server',
        false,
        false,
        null,
        step,
      );
      mocks.query.mockImplementation(sql =>
        Promise.resolve(
          sql.includes('liekan_reporting_log')
            ? [{ total: 0, ai: 0, demo: false, latestAt: null, latestImportAt: null }]
            : [result.progress],
        ),
      );
      expect((await getInstallation(id, true)).progress).toEqual(result.progress);
    },
  );
  it('revalidates revoked ownership and rejects the write without persisting', async () => {
    mocks.lock.mockRejectedValue(new LiekanError('站点管理权限已变更', 403));
    await expect(
      saveInstallation(id, { action: 'finish', method: 'manual' }, identity),
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('protects both endpoints with full website authorization and private responses', async () => {
    const read = await GET(new Request('http://localhost/api'), params);
    expect(read.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.authorize).toHaveBeenCalledWith(expect.any(Request), id);
    const write = await POST(
      new Request('http://localhost/api', {
        method: 'POST',
        body: JSON.stringify({ action: 'skip-browser' }),
      }),
      params,
    );
    expect(write.status).toBe(200);
    expect(mocks.authorize).toHaveBeenLastCalledWith(expect.any(Request), id, true);
    for (const status of [401, 403, 404]) {
      mocks.authorize.mockRejectedValue(new LiekanError('访问被拒绝', status));
      expect((await GET(new Request('http://localhost/api'), params)).status).toBe(status);
      expect(
        (await POST(new Request('http://localhost/api', { method: 'POST', body: '{}' }), params))
          .status,
      ).toBe(status);
    }
  });
  it('bounds setup requests without accepting oversized bodies', async () => {
    const result = await POST(
      new Request('http://localhost/api', {
        method: 'POST',
        body: JSON.stringify({ action: 'skip-browser', extra: 'x'.repeat(2200) }),
      }),
      params,
    );
    expect(result.status).toBe(413);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
