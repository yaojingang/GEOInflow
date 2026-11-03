// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  authorize: vi.fn(),
  control: vi.fn(),
  transactions: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  capacity: vi.fn(),
  preview: vi.fn(),
  freeze: vi.fn(),
  lockWebsite: vi.fn(),
  shortTransactions: vi.fn(),
  collect: vi.fn(),
  relational: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ checkAuth: m.auth }));
vi.mock('@/lib/db', () => ({ isRelationalOnly: m.relational }));
vi.mock('./server', async () => ({
  authorize: m.authorize,
  primary: () => ({ $transaction: m.shortTransactions }),
  lockWritableWebsite: m.lockWebsite,
  LiekanError: (await import('./errors')).LiekanError,
}));
vi.mock('./ai-db', () => ({
  aiTransaction: (work: any) => work({ query: m.query, execute: m.execute }),
  aiExecutor: (raw: any) => raw,
}));
vi.mock('./crawler-access', async importOriginal => ({
  ...(await importOriginal<typeof import('./crawler-access')>()),
  authorizeCrawler: m.control,
}));
vi.mock('./analysis-rollups-db', () => ({
  analysisTransaction: (work: any) => m.transactions(work),
  analysisCapacity: m.capacity,
}));
vi.mock('./analysis-rollups', () => ({
  createAnalysisBuild: vi.fn(),
  getAnalysisStatus: vi.fn(),
  actionAnalysisBuild: vi.fn(),
}));
vi.mock('./storage-generation-gc', () => ({
  previewGenerations: m.preview,
  collectGenerationBatch: m.collect,
  unreferencedGenerationSql: 'true',
}));
vi.mock('./storage-queue-retention', async importOriginal => ({
  ...(await importOriginal<typeof import('./storage-queue-retention')>()),
  freezeCompletedJobs: m.freeze,
}));

import { defaultStorageSettings } from '../contracts/storage-retention';
import { LiekanError } from './errors';
import * as storage from './storage-retention';
import { storageActionResponse, storageStateResponse } from './storage-retention-api';

const actor = { id: '11111111-1111-4111-8111-111111111111', role: 'admin' };
const site = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const raw = { $queryRawUnsafe: m.query, $executeRawUnsafe: m.execute };
const request = (method = 'GET', query = '', cookie = 'liekan.locale=en-US') =>
  new Request(`https://analytics.test/api/liekan/storage${query}`, {
    method,
    headers: { Cookie: cookie },
  });
const preview = { action: 'preview', requestId };
const run = () => ({
  id: runId,
  website_id: null,
  kind: 'manual',
  status: 'running',
  created_at: new Date('2026-01-01T00:00:00Z'),
  expires_at: new Date('2026-01-02T00:00:00Z'),
  candidate_count: 1,
  estimated_bytes: '0',
  rows_deleted: '0',
  released_bytes: '0',
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv(
    'DATABASE_URL',
    'postgresql://storage_test@127.0.0.1/liekan_storage_test?schema=storage_unit',
  );
  m.auth.mockResolvedValue({ authType: 'session', user: actor });
  m.authorize.mockResolvedValue({ website: { id: site } });
  m.control.mockResolvedValue({ id: site, canManage: true });
  m.relational.mockReturnValue(true);
  m.transactions.mockImplementation(work => work(raw));
  m.shortTransactions.mockImplementation(work => work(raw));
  m.query.mockResolvedValue([]);
  m.execute.mockResolvedValue(1);
  m.collect.mockResolvedValue({
    rowsDeleted: 0,
    generationsDeleted: 0,
    releasedBytes: '0',
    more: false,
  });
  m.capacity.mockResolvedValue({
    siteBytes: '0',
    globalBytes: '0',
    siteLimit: 1000,
    globalLimit: 1000,
  });
});

afterEach(() => vi.useRealTimers());

describe('storage HTTP validation and full private authentication', () => {
  beforeEach(() => {
    vi.spyOn(storage, 'storageAction').mockResolvedValue({ ok: true });
    vi.spyOn(storage, 'readStorageState').mockResolvedValue({ state: true } as any);
    vi.spyOn(storage, 'readStorageRun').mockResolvedValue({ run: true } as any);
  });

  it('uses complete private session authentication for instance actions and captures locale', async () => {
    const req = request('POST');
    expect(await storageActionResponse(req, preview)).toEqual({ ok: true });
    expect(m.auth).toHaveBeenCalledWith(req);
    expect(storage.storageAction).toHaveBeenCalledWith(
      { actorId: actor.id, websiteId: undefined, locale: 'en-US' },
      { action: 'preview', requestId, generationHours: 24, completedHours: 24, wakeHours: 1 },
    );
    expect(m.authorize).not.toHaveBeenCalled();
  });

  it('resolves a website resource handle after full authentication and management authorization', async () => {
    const req = request('POST');
    await storageActionResponse(req, preview, '103');
    expect(m.auth).toHaveBeenCalledWith(req);
    expect(m.authorize).toHaveBeenCalledWith(req, '103', true);
    expect(m.control).toHaveBeenCalledWith(raw, actor, site, 'control');
    expect(storage.storageAction).toHaveBeenCalledWith(
      { actorId: actor.id, websiteId: site, locale: 'en-US' },
      expect.objectContaining({ action: 'preview' }),
    );
    expect(m.auth.mock.invocationCallOrder[0]).toBeLessThan(
      m.authorize.mock.invocationCallOrder[0],
    );
    expect(m.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      m.control.mock.invocationCallOrder[0],
    );
  });

  it.each(['api-key', 'share', 'partial', undefined])(
    'rejects real %s authentication for instance and website actions before the core mutates',
    async authType => {
      m.auth.mockResolvedValue({ authType, user: actor });
      for (const handle of [undefined, '103'])
        await expect(storageActionResponse(request('POST'), preview, handle)).rejects.toMatchObject(
          { status: 401 },
        );
      expect(m.auth).toHaveBeenCalledTimes(2);
      expect(m.authorize).not.toHaveBeenCalled();
      expect(m.control).not.toHaveBeenCalled();
      expect(storage.storageAction).not.toHaveBeenCalled();
      expect(m.execute).not.toHaveBeenCalled();
    },
  );

  it.each(['x-umami-share-token', 'x-umami-share-context'])(
    'rejects public context header %s before reading an otherwise complete session',
    async header => {
      const req = new Request('https://analytics.test/api/liekan/storage', {
        method: 'POST',
        headers: { [header]: 'stale-public-context' },
      });
      for (const handle of [undefined, '103'])
        await expect(storageActionResponse(req, preview, handle)).rejects.toMatchObject({
          status: 401,
        });
      expect(m.auth).not.toHaveBeenCalled();
      expect(storage.storageAction).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    { authType: 'session', user: { ...actor, deletedAt: new Date() } },
    { authType: 'session', user: actor, shareToken: { websiteId: site } },
  ])('rejects absent, deleted and mixed-share sessions before reading storage', async auth => {
    m.auth.mockResolvedValue(auth);
    await expect(storageStateResponse(request())).rejects.toMatchObject({ status: 401 });
    expect(storage.readStorageState).not.toHaveBeenCalled();
    expect(storage.readStorageRun).not.toHaveBeenCalled();
  });

  it('propagates revoked website management authority before any storage operation', async () => {
    m.control.mockRejectedValue(
      Object.assign(new Error('website control revoked'), { status: 403 }),
    );
    await expect(storageActionResponse(request('POST'), preview, '103')).rejects.toMatchObject({
      status: 403,
    });
    expect(storage.storageAction).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { action: 'vacuum', requestId },
    { ...preview, completedHours: 48 },
    { ...preview, websiteId: site },
    { ...preview, requestId: 'invalid' },
    { action: 'confirm', id: 'invalid', requestId },
    { action: 'stop', requestId },
    { action: 'policy', requestId, expectedRevision: -1, settings: defaultStorageSettings },
    {
      action: 'policy',
      requestId,
      expectedRevision: 0,
      settings: { ...defaultStorageSettings, hour: 24 },
    },
    {
      action: 'policy',
      requestId,
      expectedRevision: 0,
      settings: { ...defaultStorageSettings, timezone: 'Invalid/Zone' },
    },
  ])('rejects invalid action parameters before authentication or mutation: %j', async input => {
    await expect(storageActionResponse(request('POST'), input, '103')).rejects.toMatchObject({
      status: 400,
      code: 'storage-invalid-input',
    });
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.transactions).not.toHaveBeenCalled();
    expect(storage.storageAction).not.toHaveBeenCalled();
    expect(m.execute).not.toHaveBeenCalled();
  });

  it('rejects an invalid run UUID with HTTP 400 before lookup', async () => {
    await expect(storageStateResponse(request('GET', '?runId=invalid'))).rejects.toMatchObject({
      status: 400,
      code: 'storage-invalid-input',
    });
    expect(m.auth).not.toHaveBeenCalled();
    expect(storage.readStorageRun).not.toHaveBeenCalled();
    expect(storage.readStorageState).not.toHaveBeenCalled();
  });

  it('polls only the authorized lightweight run reader when a run ID is supplied', async () => {
    const req = request('GET', `?runId=${runId}`);
    expect(await storageStateResponse(req, '103')).toEqual({ run: true });
    expect(storage.readStorageRun).toHaveBeenCalledWith(
      { actorId: actor.id, websiteId: site, locale: 'en-US' },
      runId,
    );
    expect(storage.readStorageState).not.toHaveBeenCalled();
    expect(storage.storageAction).not.toHaveBeenCalled();
    expect(m.preview).not.toHaveBeenCalled();
    expect(m.freeze).not.toHaveBeenCalled();
  });

  it('uses the state reader for initial GET and defaults an absent locale cookie to Chinese', async () => {
    expect(await storageStateResponse(request('GET', '', ''))).toEqual({ state: true });
    expect(storage.readStorageState).toHaveBeenCalledWith({
      actorId: actor.id,
      websiteId: undefined,
      locale: 'zh-CN',
    });
    expect(storage.readStorageRun).not.toHaveBeenCalled();
  });

  it('rejects website generation cleanup on unsupported database engines before mutating', async () => {
    vi.stubEnv('CLICKHOUSE_URL', 'https://clickhouse.invalid');
    await expect(storageActionResponse(request('POST'), preview, '103')).rejects.toMatchObject({
      status: 501,
    });
    expect(m.auth).not.toHaveBeenCalled();
    expect(storage.storageAction).not.toHaveBeenCalled();
  });

  it('retains instance queue GET and POST with complete private authentication in ClickHouse mode', async () => {
    vi.stubEnv('CLICKHOUSE_URL', 'https://clickhouse.invalid');
    m.relational.mockReturnValue(false);
    expect(await storageStateResponse(request())).toEqual({ state: true });
    expect(await storageActionResponse(request('POST'), preview)).toEqual({ ok: true });
    expect(m.auth).toHaveBeenCalledTimes(2);
    expect(storage.readStorageState).toHaveBeenCalledWith({
      actorId: actor.id,
      websiteId: undefined,
      locale: 'en-US',
    });
    expect(storage.storageAction).toHaveBeenCalledWith(
      { actorId: actor.id, websiteId: undefined, locale: 'en-US' },
      expect.objectContaining({ action: 'preview' }),
    );
    expect(m.authorize).not.toHaveBeenCalled();
    expect(m.relational).not.toHaveBeenCalled();
  });

  it('continues rejecting partial identities for ClickHouse instance cleanup', async () => {
    vi.stubEnv('CLICKHOUSE_URL', 'https://clickhouse.invalid');
    m.relational.mockReturnValue(false);
    m.auth.mockResolvedValue({ authType: 'partial', user: actor });
    await expect(storageActionResponse(request('POST'), preview)).rejects.toMatchObject({
      status: 401,
    });
    expect(storage.storageAction).not.toHaveBeenCalled();
  });

  it.each(['', 'https://clickhouse.invalid'])(
    'preserves same-origin write protection for instance cleanup with ClickHouse URL %s',
    async clickhouse => {
      vi.stubEnv('CLICKHOUSE_URL', clickhouse);
      m.relational.mockReturnValue(!clickhouse);
      const invalid = new Request('http://container:3000/api/liekan/storage', {
        method: 'POST',
        headers: {
          host: 'analytics.test',
          'x-forwarded-proto': 'https',
          origin: 'https://other.test',
        },
      });
      await expect(storageActionResponse(invalid, preview)).rejects.toMatchObject({ status: 403 });
      expect(storage.storageAction).not.toHaveBeenCalled();
      const valid = new Request('http://container:3000/api/liekan/storage', {
        method: 'POST',
        headers: {
          host: 'analytics.test',
          'x-forwarded-proto': 'https',
          origin: 'https://analytics.test',
        },
      });
      expect(await storageActionResponse(valid, preview)).toEqual({ ok: true });
    },
  );
});

describe('ClickHouse instance retention and PostgreSQL generation isolation', () => {
  beforeEach(() => {
    vi.stubEnv('CLICKHOUSE_URL', 'https://clickhouse.invalid');
    m.relational.mockReturnValue(false);
  });

  it('requires the live administrator role for instance GET and POST in ClickHouse mode', async () => {
    m.query.mockResolvedValue([{ role: 'user' }]);
    await expect(storageStateResponse(request())).rejects.toMatchObject({
      status: 403,
      code: 'storage-admin-required',
    });
    await expect(storageActionResponse(request('POST'), preview)).rejects.toMatchObject({
      status: 403,
      code: 'storage-admin-required',
    });
    expect(m.auth).toHaveBeenCalledTimes(2);
    expect(m.freeze).not.toHaveBeenCalled();
    expect(m.collect).not.toHaveBeenCalled();
    expect(m.execute.mock.calls.every(([sql]) => sql.startsWith('SET LOCAL'))).toBe(true);
  });

  it.each(['state', 'run', 'action', 'batch'] as const)(
    'rejects a direct website %s without consuming or stopping its retained generation run',
    async operation => {
      m.query.mockResolvedValue([{ ...run(), website_id: site, actor_id: actor.id }]);
      const scope = { actorId: actor.id, websiteId: site };
      await expect(
        operation === 'state'
          ? storage.readStorageState(scope)
          : operation === 'run'
            ? storage.readStorageRun(scope, runId)
            : operation === 'batch'
              ? storage.processStorageRun(runId, { deleteJob: vi.fn() })
              : storage.storageAction(scope, {
                  action: 'preview',
                  requestId,
                  generationHours: 24,
                  completedHours: 24,
                  wakeHours: 1,
                }),
      ).rejects.toMatchObject({ status: 501, code: 'storage-unsupported' });
      expect(m.lockWebsite).not.toHaveBeenCalled();
      expect(m.collect).not.toHaveBeenCalled();
      expect(m.preview).not.toHaveBeenCalled();
      expect(m.freeze).not.toHaveBeenCalled();
      expect(m.execute.mock.calls.every(([sql]) => sql.startsWith('SET LOCAL'))).toBe(true);
    },
  );

  it('progresses a completed-job batch while preserving generation facts in ClickHouse mode', async () => {
    const current = {
      ...run(),
      actor_id: actor.id,
      policy_revision: 3,
      conditions: {
        frozen: true,
        completedCutoff: '2026-01-01',
        wakeCutoff: '2026-01-01',
        shortCutoff: '2026-01-01',
      },
    };
    m.query.mockImplementation(async sql => {
      if (sql.includes('FROM "user"')) return [{ role: 'admin' }];
      if (sql.startsWith('SELECT * FROM liekan_storage_policy'))
        return [{ settings: defaultStorageSettings, revision: 3 }];
      if (sql.startsWith('SELECT * FROM liekan_storage_cleanup')) return [current];
      if (sql.includes('SELECT j.id,j.name FROM selected c'))
        return [{ id: site, name: 'liekan-analysis-query' }];
      if (sql.startsWith('SELECT count(*)')) return [{ count: 0 }];
      if (sql.startsWith('SELECT EXISTS')) return [{ more: false }];
      return [];
    });
    const boss = { deleteJob: vi.fn().mockResolvedValue(1) };
    expect(await storage.processStorageRun(runId, boss)).toBe(false);
    expect(boss.deleteJob).toHaveBeenCalledWith(
      'liekan-analysis-query',
      [site],
      expect.any(Object),
    );
    expect(m.collect).not.toHaveBeenCalled();
    expect(m.lockWebsite).not.toHaveBeenCalled();
    expect(m.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE liekan_storage_cleanup SET status=$2'),
      runId,
      'completed',
      0,
      0,
      1,
      '0',
    );
  });

  it('schedules only the instance and excludes website runs from the worker pump', async () => {
    const state = scheduleFixture({ website: false, lastDaily: '2026-10-27' });
    await storage.pumpStorageRetention({ deleteJob: vi.fn() });
    expect(state.created).toEqual([
      expect.objectContaining({ websiteId: null, kind: 'scheduled' }),
    ]);
    expect(m.execute.mock.calls.some(([sql]) => sql.includes('SELECT w.website_id::text'))).toBe(
      false,
    );
    const policySelect = m.query.mock.calls.find(([sql]) => sql.startsWith('SELECT p.*'));
    expect(policySelect[0]).toMatch(/p\.website_id IS NULL/);
    const runSelect = m.query.mock.calls.find(([sql]) =>
      sql.startsWith('SELECT id FROM liekan_storage_cleanup WHERE status IN'),
    );
    expect(runSelect[0]).toMatch(/website_id IS NULL/);
    expect(m.capacity).not.toHaveBeenCalled();
    expect(m.control).not.toHaveBeenCalled();
    expect(m.collect).not.toHaveBeenCalled();
    expect(m.freeze).not.toHaveBeenCalled();
  });
});

describe('storage core authorization and run polling', () => {
  it.each(['user', 'view-only', null])(
    'rechecks live instance administrator authority for role %s',
    async role => {
      m.query.mockResolvedValue(role ? [{ role }] : []);
      await expect(
        storage.storageAction(
          { actorId: actor.id },
          { action: 'preview', requestId, generationHours: 24, completedHours: 24, wakeHours: 1 },
        ),
      ).rejects.toMatchObject({ status: 403, code: 'storage-admin-required' });
      expect(m.query).toHaveBeenCalledExactlyOnceWith(
        'SELECT role FROM "user" WHERE user_id=$1::uuid AND deleted_at IS NULL FOR SHARE',
        actor.id,
      );
      expect(m.execute.mock.calls.every(([sql]) => sql.startsWith('SET LOCAL'))).toBe(true);
      expect(m.freeze).not.toHaveBeenCalled();
    },
  );

  it('allows a live administrator to update policy after its revision check', async () => {
    m.query.mockImplementation(sql =>
      Promise.resolve(
        sql.includes('FROM "user"')
          ? [{ role: 'admin' }]
          : sql.includes('FROM liekan_storage_policy')
            ? [{ settings: defaultStorageSettings, revision: 3 }]
            : [],
      ),
    );
    const settings = { ...defaultStorageSettings, completedHours: 720 as const };
    expect(
      await storage.storageAction(
        { actorId: actor.id },
        {
          action: 'policy',
          settings,
          expectedRevision: 3,
          requestId,
        },
      ),
    ).toEqual({ ...settings, revision: 4 });
    expect(m.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE liekan_storage_policy SET settings='),
      'instance',
      JSON.stringify(settings),
      actor.id,
    );
    expect(m.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO liekan_storage_operation'),
      requestId,
      'instance',
      actor.id,
      'policy',
      expect.any(String),
      expect.any(String),
    );
  });

  it('rejects a stale policy revision before writing settings or recording a receipt', async () => {
    m.query.mockImplementation(sql =>
      Promise.resolve(
        sql.includes('FROM "user"')
          ? [{ role: 'admin' }]
          : sql.includes('FROM liekan_storage_policy')
            ? [{ settings: defaultStorageSettings, revision: 3 }]
            : [],
      ),
    );
    await expect(
      storage.storageAction(
        { actorId: actor.id },
        {
          action: 'policy',
          settings: defaultStorageSettings,
          expectedRevision: 2,
          requestId,
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'storage-policy-changed' });
    expect(
      m.execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE liekan_storage_policy')),
    ).toBe(false);
    expect(
      m.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO liekan_storage_operation')),
    ).toBe(false);
  });

  it('captures the submitted locale and exact frozen membership when creating an instance preview', async () => {
    m.freeze.mockResolvedValue(4);
    m.query.mockImplementation(sql =>
      Promise.resolve(
        sql.includes('FROM "user"')
          ? [{ role: 'admin' }]
          : sql.includes('FROM liekan_storage_policy')
            ? [{ settings: defaultStorageSettings, revision: 3 }]
            : sql.startsWith('UPDATE liekan_storage_cleanup')
              ? [{ ...run(), status: 'preview', candidate_count: 4 }]
              : [],
      ),
    );
    expect(
      await storage.storageAction(
        { actorId: actor.id, locale: 'en-US' },
        {
          action: 'preview',
          requestId,
          generationHours: 24,
          completedHours: 720,
          wakeHours: 1,
        },
      ),
    ).toMatchObject({ status: 'preview', candidateCount: 4 });
    const inserted = m.execute.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT INTO liekan_storage_cleanup'),
    );
    expect(inserted.slice(2, 9)).toEqual([
      'instance',
      null,
      actor.id,
      'en-US',
      'manual',
      'preview',
      '3',
    ]);
    expect(JSON.parse(inserted[11])).toMatchObject({ frozen: true });
    expect(m.freeze).toHaveBeenCalledWith(
      raw,
      inserted[1],
      expect.objectContaining({ frozen: true }),
    );
  });

  it.each([
    ['different preview owner', { actor_id: site }, 403, 'storage-preview-owner'],
    ['expired preview', { expires_at: new Date(0) }, 410, 'storage-preview-expired'],
    ['changed policy', { policy_revision: 2 }, 409, 'storage-policy-changed'],
    ['stopped run', { status: 'stopped' }, 409, 'storage-run-terminal'],
  ])(
    'rejects confirmation of a %s before queueing or recording success',
    async (_label, change, status, code) => {
      const current = {
        ...run(),
        actor_id: actor.id,
        status: 'preview',
        policy_revision: 3,
        expires_at: new Date(Date.now() + 60000),
        ...change,
      };
      m.query.mockImplementation(sql =>
        Promise.resolve(
          sql.includes('FROM "user"')
            ? [{ role: 'admin' }]
            : sql.includes('FROM liekan_storage_policy')
              ? [{ settings: defaultStorageSettings, revision: 3 }]
              : sql.includes('FROM liekan_storage_cleanup')
                ? [current]
                : [],
        ),
      );
      await expect(
        storage.storageAction(
          { actorId: actor.id },
          {
            action: 'confirm',
            id: runId,
            requestId,
          },
        ),
      ).rejects.toMatchObject({ status, code });
      expect(
        m.execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE liekan_storage_cleanup')),
      ).toBe(false);
      expect(
        m.execute.mock.calls.some(([sql]) =>
          sql.startsWith('INSERT INTO liekan_storage_operation'),
        ),
      ).toBe(false);
    },
  );

  it('queues a current preview owned by the live administrator', async () => {
    const current = {
      ...run(),
      actor_id: actor.id,
      status: 'preview',
      policy_revision: 3,
      expires_at: new Date(Date.now() + 60000),
    };
    m.query.mockImplementation(sql =>
      Promise.resolve(
        sql.includes('FROM "user"')
          ? [{ role: 'admin' }]
          : sql.includes('FROM liekan_storage_policy')
            ? [{ settings: defaultStorageSettings, revision: 3 }]
            : sql.includes("status IN('queued','running')")
              ? []
              : sql.includes('FROM liekan_storage_cleanup')
                ? [{ ...current, status: sql.includes('FOR UPDATE') ? 'preview' : 'queued' }]
                : [],
      ),
    );
    expect(
      await storage.storageAction(
        { actorId: actor.id },
        {
          action: 'confirm',
          id: runId,
          requestId,
        },
      ),
    ).toMatchObject({ id: runId, status: 'queued' });
    expect(m.execute).toHaveBeenCalledWith(expect.stringContaining("SET status='queued'"), runId);
    expect(m.freeze).not.toHaveBeenCalled();
  });

  it('fences confirmation when the authorized website epoch changed after preview', async () => {
    const current = {
      ...run(),
      actor_id: actor.id,
      status: 'preview',
      policy_revision: 3,
      expires_at: new Date(Date.now() + 60000),
      epoch: '1',
      ownership: { user_id: actor.id, team_id: null },
    };
    m.query.mockImplementation(sql =>
      Promise.resolve(
        sql.includes('FROM "user"')
          ? [{ role: 'admin' }]
          : sql.includes('FROM liekan_analysis_site')
            ? [{ epoch: '2', user_id: actor.id, team_id: null }]
            : sql.includes('FROM liekan_storage_policy')
              ? [{ settings: defaultStorageSettings, revision: 3 }]
              : sql.includes('FROM liekan_storage_cleanup')
                ? [current]
                : [],
      ),
    );
    await expect(
      storage.storageAction(
        { actorId: actor.id, websiteId: site },
        {
          action: 'confirm',
          id: runId,
          requestId,
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'storage-scope-changed' });
    expect(m.lockWebsite).toHaveBeenCalledWith(raw, site, { userId: actor.id }, 'update');
    expect(
      m.execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE liekan_storage_cleanup')),
    ).toBe(false);
  });

  it('performs only authority and scoped run lookup during actual instance polling', async () => {
    m.query.mockImplementation(sql =>
      Promise.resolve(sql.includes('FROM "user"') ? [{ role: 'admin' }] : [run()]),
    );
    expect(await storage.readStorageRun({ actorId: actor.id }, runId)).toMatchObject({
      id: runId,
      status: 'running',
      scope: 'instance',
    });
    expect(m.query).toHaveBeenCalledTimes(2);
    expect(m.query).toHaveBeenLastCalledWith(
      'SELECT * FROM liekan_storage_cleanup WHERE id=$1::uuid AND scope_key=$2',
      runId,
      'instance',
    );
    expect(m.execute).not.toHaveBeenCalled();
    expect(m.capacity).not.toHaveBeenCalled();
    expect(m.preview).not.toHaveBeenCalled();
    expect(m.freeze).not.toHaveBeenCalled();
  });

  it('rechecks resource authority and limits a website poll to its resolved UUID', async () => {
    m.query.mockImplementation(sql =>
      Promise.resolve(
        sql.includes('FROM "user"')
          ? [{ role: 'admin' }]
          : sql.includes('FROM liekan_analysis_site')
            ? [{ epoch: '1' }]
            : [{ ...run(), website_id: site }],
      ),
    );
    expect(
      await storage.readStorageRun({ actorId: actor.id, websiteId: site }, runId),
    ).toMatchObject({ websiteId: site });
    expect(m.lockWebsite).toHaveBeenCalledWith(raw, site, { userId: actor.id }, 'share');
    expect(m.control).toHaveBeenCalledWith(raw, actor, site, 'control');
    expect(m.query).toHaveBeenLastCalledWith(
      'SELECT * FROM liekan_storage_cleanup WHERE id=$1::uuid AND scope_key=$2',
      runId,
      site,
    );
    expect(m.execute).not.toHaveBeenCalled();
    expect(m.preview).not.toHaveBeenCalled();
  });
});

function scheduleFixture(
  options: {
    now?: string;
    website?: boolean;
    timezone?: string;
    hour?: number;
    lastDaily?: string;
    pressure?: boolean;
    nextCheckAt?: Date;
  } = {},
) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(options.now || '2026-10-27T20:30:00Z'));
  const websiteId = options.website === false ? null : site;
  const policy = {
    scope_key: websiteId || 'instance',
    website_id: websiteId,
    actor_id: actor.id,
    revision: 3,
    settings: {
      ...defaultStorageSettings,
      timezone: options.timezone || 'Asia/Shanghai',
      hour: options.hour ?? 3,
    },
    next_check_at: options.nextCheckAt || new Date(Date.now() - 3600000),
    last_daily: options.lastDaily || null,
  };
  const created: Array<{
    id: string;
    websiteId: string | null;
    kind: string;
    conditions: Record<string, any>;
  }> = [];
  m.capacity.mockImplementation((_tx, id) =>
    Promise.resolve({
      siteBytes: id && options.pressure ? '850' : '0',
      globalBytes: '0',
      siteLimit: 1000,
      globalLimit: 1000,
    }),
  );
  m.query.mockImplementation(async (sql, ...values) => {
    if (sql.includes('FROM "user"')) return [{ role: 'admin' }];
    if (sql.includes('FROM liekan_analysis_site'))
      return [{ epoch: '1', user_id: actor.id, team_id: null }];
    if (sql.startsWith('SELECT p.* FROM liekan_storage_policy')) return [policy];
    if (sql.startsWith('SELECT * FROM liekan_storage_policy'))
      return values[0] === policy.scope_key ? [policy] : [];
    if (sql.startsWith('UPDATE liekan_storage_cleanup SET candidate_count='))
      return [{ ...run(), website_id: websiteId, status: 'queued' }];
    return [];
  });
  m.execute.mockImplementation(async (sql, ...values) => {
    if (sql.startsWith('INSERT INTO liekan_storage_cleanup'))
      created.push({
        id: values[0],
        websiteId: values[2],
        kind: values[5],
        conditions: JSON.parse(values[10]),
      });
    if (sql.startsWith('UPDATE liekan_storage_policy SET next_check_at=')) {
      policy.next_check_at = values[1];
      if (values[3]) policy.last_daily = values[2];
    }
    return 1;
  });
  return { policy, created };
}

describe('storage scheduling cadence and timezone behavior', () => {
  const boss = { deleteJob: vi.fn() };

  it('starts a full website daily run on the next local calendar day after its configured hour', async () => {
    const state = scheduleFixture({ lastDaily: '2026-10-27' });
    await storage.pumpStorageRetention(boss);
    expect(state.created).toEqual([
      expect.objectContaining({
        websiteId: site,
        kind: 'scheduled',
        conditions: expect.objectContaining({ hourlyOnly: false, frozen: false }),
      }),
    ]);
    expect(state.policy.last_daily).toBe('2026-10-28');
    expect(m.control).toHaveBeenCalledWith(raw, actor, site, 'control');
    expect(m.shortTransactions).toHaveBeenCalled();
    expect(m.collect).not.toHaveBeenCalled();
  });

  it('uses the policy timezone when the same UTC instant is still before the Los Angeles daily hour', async () => {
    const state = scheduleFixture({
      timezone: 'America/Los_Angeles',
      hour: 14,
      lastDaily: '2026-10-26',
    });
    await storage.pumpStorageRetention(boss);
    expect(state.created).toEqual([]);
    expect(state.policy.last_daily).toBe('2026-10-26');
    expect(state.policy.next_check_at.toISOString()).toBe('2026-10-27T21:00:00.000Z');
  });

  it('does not create a second full website run on the same local last_daily date', async () => {
    const state = scheduleFixture({ lastDaily: '2026-10-28' });
    await storage.pumpStorageRetention(boss);
    expect(state.created).toEqual([]);
    expect(state.policy.last_daily).toBe('2026-10-28');
    expect(m.shortTransactions).toHaveBeenCalled();
  });

  it('defers a low-pressure website until its local configured hour', async () => {
    const state = scheduleFixture({ now: '2026-10-27T18:30:00Z', lastDaily: '2026-10-27' });
    await storage.pumpStorageRetention(boss);
    expect(state.created).toEqual([]);
    expect(state.policy.next_check_at.toISOString()).toBe('2026-10-27T19:00:00.000Z');
    expect(m.capacity).toHaveBeenCalledWith(raw, site);
  });

  it('starts a one-hour pressure run ahead of the website daily hour and future next check', async () => {
    const state = scheduleFixture({
      now: '2026-10-27T18:30:00Z',
      pressure: true,
      lastDaily: '2026-10-27',
      nextCheckAt: new Date('2026-10-27T19:00:00Z'),
    });
    await storage.pumpStorageRetention(boss);
    expect(state.created).toEqual([
      expect.objectContaining({
        websiteId: site,
        kind: 'pressure',
        conditions: expect.objectContaining({
          generationCutoff: '2026-10-27T17:30:00.000Z',
          hourlyOnly: false,
        }),
      }),
    ]);
    expect(state.policy.last_daily).toBe('2026-10-27');
  });

  it.each([
    ['before the local daily hour', '2026-10-27T18:30:00Z', '2026-10-27'],
    ['after the daily run already occurred', '2026-10-27T20:30:00Z', '2026-10-28'],
  ])('creates an instance wake/short run %s', async (_label, now, lastDaily) => {
    const state = scheduleFixture({ website: false, now, lastDaily });
    await storage.pumpStorageRetention(boss);
    expect(state.created).toEqual([
      expect.objectContaining({
        websiteId: null,
        kind: 'scheduled',
        conditions: expect.objectContaining({ hourlyOnly: true }),
      }),
    ]);
    expect(state.policy.last_daily).toBe(lastDaily);
    expect(m.control).not.toHaveBeenCalled();
  });

  it('includes all managed queues in the instance daily run', async () => {
    const state = scheduleFixture({ website: false, lastDaily: '2026-10-27' });
    await storage.pumpStorageRetention(boss);
    expect(state.created).toEqual([
      expect.objectContaining({
        websiteId: null,
        conditions: expect.objectContaining({ hourlyOnly: false }),
      }),
    ]);
    expect(state.policy.last_daily).toBe('2026-10-28');
  });

  it.each([401, 403, 404])(
    'disables eight stale actor policies after HTTP %s so the next valid policy can run',
    async status => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      const state = scheduleFixture({ lastDaily: '2026-10-27' });
      const staleActor = '66666666-6666-4666-8666-666666666666';
      const invalid = Array.from({ length: 8 }, (_, index) => ({
        ...state.policy,
        scope_key: `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        website_id: `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        actor_id: staleActor,
        settings: { ...state.policy.settings },
      }));
      const policies = [...invalid, state.policy];
      const disabled: Array<{ sql: string; values: any[] }> = [];
      let concurrentPolicy: (typeof invalid)[number];
      let concurrentSnapshot: (typeof invalid)[number];
      const baseQuery = m.query.getMockImplementation(),
        baseExecute = m.execute.getMockImplementation();
      const binding = (sql: string, values: any[], column: string) => {
        const where = sql.slice(sql.indexOf('WHERE'));
        const match = where.match(
          new RegExp(`\\b${column}\\s*(?:=|IS NOT DISTINCT FROM)\\s*\\$(\\d+)`, 'i'),
        );
        return match ? values[Number(match[1]) - 1] : undefined;
      };
      m.query.mockImplementation(async (sql, ...values) => {
        if (sql.startsWith('SELECT p.* FROM liekan_storage_policy'))
          return policies
            .filter(policy => policy.settings.enabled && +policy.next_check_at <= Date.now())
            .slice(0, 8)
            .map(policy => ({ ...policy, settings: { ...policy.settings } }));
        if (sql.startsWith('SELECT * FROM liekan_storage_policy'))
          return policies.filter(policy => policy.scope_key === values[0]);
        return baseQuery(sql, ...values);
      });
      m.control.mockImplementation(async (_tx, _actor, websiteId) => {
        if (concurrentPolicy?.website_id === websiteId) {
          concurrentPolicy.revision += 1;
          concurrentPolicy.settings = { ...concurrentPolicy.settings, hour: 9 };
          concurrentSnapshot = { ...concurrentPolicy, settings: { ...concurrentPolicy.settings } };
        }
        if (websiteId !== site)
          throw new LiekanError(
            'saved actor no longer authorized',
            status,
            'storage-authority-changed',
          );
      });
      m.execute.mockImplementation(async (sql, ...values) => {
        if (
          sql.startsWith('UPDATE liekan_storage_policy') &&
          sql.includes('enabled') &&
          sql.includes('revision')
        ) {
          disabled.push({ sql, values });
          const scope = binding(sql, values, 'scope_key'),
            revision = binding(sql, values, 'revision'),
            savedActor = binding(sql, values, 'actor_id');
          const target = policies.find(
            policy =>
              policy.scope_key === scope &&
              String(policy.revision) === String(revision) &&
              policy.actor_id === savedActor,
          );
          if (!target) return 0;
          target.settings = { ...target.settings, enabled: false };
          target.revision += 1;
          return 1;
        }
        return baseExecute(sql, ...values);
      });

      await storage.pumpStorageRetention(boss);
      expect(state.created).toEqual([]);
      expect(disabled).toHaveLength(8);
      for (const policy of invalid) {
        expect(policy.settings).toEqual({ ...defaultStorageSettings, enabled: false });
        expect(policy.revision).toBe(4);
        expect(policy.actor_id).toBe(staleActor);
      }
      await storage.pumpStorageRetention(boss);
      expect(state.created).toEqual([
        expect.objectContaining({ websiteId: site, kind: 'scheduled' }),
      ]);
      expect(state.policy.settings.enabled).toBe(true);

      concurrentPolicy = {
        ...invalid[0],
        scope_key: '88888888-8888-4888-8888-888888888888',
        website_id: '88888888-8888-4888-8888-888888888888',
        revision: 10,
        settings: { ...defaultStorageSettings },
      };
      policies.push(concurrentPolicy);
      await storage.pumpStorageRetention(boss);
      expect(disabled).toHaveLength(9);
      expect(concurrentPolicy).toEqual(concurrentSnapshot);
      expect(concurrentPolicy.settings.enabled).toBe(true);
      expect(concurrentPolicy.revision).toBe(11);
      expect(state.created).toHaveLength(1);
      for (const { sql, values } of disabled) {
        const scope = binding(sql, values, 'scope_key');
        expect(scope).toMatch(/^(70000000|88888888)-/);
        expect(String(binding(sql, values, 'revision'))).toBe(
          scope === concurrentPolicy.scope_key ? '10' : '3',
        );
        expect(binding(sql, values, 'actor_id')).toBe(staleActor);
        expect(sql).toContain("jsonb_set(settings,'{enabled}','false'::jsonb)");
        expect(sql).toMatch(/revision\s*=\s*revision\s*\+\s*1/);
        expect(sql.slice(0, sql.indexOf('WHERE'))).not.toMatch(/actor_id\s*=/);
      }
      expect(m.collect).not.toHaveBeenCalled();
      expect(m.freeze).not.toHaveBeenCalled();
      expect(boss.deleteJob).not.toHaveBeenCalled();
    },
  );
});

describe('live website storage authority changes', () => {
  it.each(['state', 'run', 'action'] as const)(
    'rejects a downgraded website owner on a direct core %s request',
    async operation => {
      m.query.mockImplementation(async sql =>
        sql.includes('FROM "user"')
          ? [{ role: 'view-only' }]
          : [{ epoch: '1', user_id: actor.id, team_id: null }],
      );
      m.control.mockImplementation(async (_tx, current) => {
        if (current.role === 'view-only') throw new LiekanError('website control revoked', 403);
      });
      const scope = { actorId: actor.id, websiteId: site };
      await expect(
        operation === 'state'
          ? storage.readStorageState(scope)
          : operation === 'run'
            ? storage.readStorageRun(scope, runId)
            : storage.storageAction(scope, {
                action: 'preview',
                requestId,
                generationHours: 24,
                completedHours: 24,
                wakeHours: 1,
              }),
      ).rejects.toMatchObject({ status: 403 });
      expect(m.control).toHaveBeenCalledWith(
        raw,
        { id: actor.id, role: 'view-only' },
        site,
        'control',
      );
      expect(m.execute.mock.calls.every(([sql]) => sql.startsWith('SET LOCAL'))).toBe(true);
      expect(m.collect).not.toHaveBeenCalled();
      expect(m.freeze).not.toHaveBeenCalled();
    },
  );

  it.each(['owner becomes view-only', 'team manager becomes team member'])(
    'stops an old run and prevents automatic replacement after %s',
    async downgrade => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      const state = scheduleFixture({ lastDaily: '2026-10-27' });
      let liveRole = 'user',
        liveTeamRole = 'team-manager',
        polls = 0;
      const teamId = downgrade.startsWith('team') ? '55555555-5555-4555-8555-555555555555' : null;
      const current = {
        ...run(),
        website_id: site,
        actor_id: actor.id,
        policy_revision: 3,
        epoch: '1',
        ownership: { user_id: actor.id, team_id: teamId },
        conditions: {
          generationCutoff: new Date(Date.now() - 86400000).toISOString(),
          frozen: true,
        },
      };
      const baseQuery = m.query.getMockImplementation(),
        baseExecute = m.execute.getMockImplementation();
      m.query.mockImplementation(async (sql, ...values) => {
        if (sql.includes('FROM "user"')) return [{ role: liveRole }];
        if (sql.includes('FROM liekan_analysis_site'))
          return [{ epoch: '1', ...current.ownership }];
        if (sql.startsWith('SELECT * FROM liekan_storage_cleanup WHERE id='))
          return ['queued', 'running'].includes(current.status) ? [current] : [];
        if (sql.startsWith('SELECT id FROM liekan_storage_cleanup WHERE status IN'))
          return polls++ === 0 && current.status === 'running' ? [{ id: runId }] : [];
        return baseQuery(sql, ...values);
      });
      m.execute.mockImplementation(async (sql, ...values) => {
        if (sql.includes("SET status='stopped',error_code='storage-authority-changed'"))
          current.status = 'stopped';
        else if (sql.startsWith('UPDATE liekan_storage_cleanup SET status=$2'))
          current.status = values[1];
        return baseExecute(sql, ...values);
      });
      m.control.mockImplementation(async (_tx, liveActor) => {
        if (liveActor.role === 'view-only' || liveTeamRole === 'team-member')
          throw new LiekanError('website control revoked', 403, 'storage-authority-changed');
      });
      m.collect.mockResolvedValue({
        rowsDeleted: 1,
        generationsDeleted: 0,
        releasedBytes: '0',
        more: true,
      });
      const boss = { deleteJob: vi.fn() };
      expect(await storage.processStorageRun(runId, boss)).toBe(true);
      expect(m.collect).toHaveBeenCalledOnce();
      if (teamId) liveTeamRole = 'team-member';
      else liveRole = 'view-only';
      await expect(storage.processStorageRun(runId, boss)).rejects.toMatchObject({ status: 403 });
      expect(m.collect).toHaveBeenCalledOnce();
      await storage.pumpStorageRetention(boss);
      expect(current.status).toBe('stopped');
      expect(state.created).toEqual([]);
      expect(m.collect).toHaveBeenCalledOnce();
      expect(m.freeze).not.toHaveBeenCalled();
      expect(m.control).toHaveBeenLastCalledWith(
        raw,
        { id: actor.id, role: liveRole },
        site,
        'control',
      );
      expect(m.execute).toHaveBeenCalledWith(
        expect.stringContaining("error_code='storage-authority-changed'"),
        runId,
      );
    },
  );
});

type PreviewRow = Record<string, any>;

function previewFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T04:00:00Z'));
  const state = {
    runs: new Map<string, PreviewRow>(),
    candidates: new Map<string, number>(),
    receipts: new Map<string, PreviewRow>(),
    events: [] as Array<{ name: string; scope: string; tx: number }>,
    policies: new Map<string, PreviewRow>(),
    site: { epoch: '1', user_id: actor.id, team_id: null as string | null },
    beforeFreeze: undefined as undefined | ((scope: string) => Promise<void>),
  };
  for (const scope of ['instance', site])
    state.policies.set(scope, {
      scope_key: scope,
      website_id: scope === 'instance' ? null : scope,
      revision: 3,
      settings: { ...defaultStorageSettings },
    });
  type Context = {
    id: number;
    scope: string;
    runs: Map<string, PreviewRow>;
    candidates: Map<string, number>;
    receipts: Map<string, PreviewRow>;
    release?: () => void;
  };
  const locks = new Map<string, Promise<void>>();
  const contexts = new WeakMap<object, Context>();
  let transactionId = 0;
  const event = (ctx: Context, name: string) =>
    state.events.push({ name, scope: ctx.scope, tx: ctx.id });
  const freeze = async (ctx: Context, id: string) => {
    event(ctx, 'freeze');
    await state.beforeFreeze?.(ctx.scope);
    ctx.candidates.set(id, 4);
    return 4;
  };
  m.freeze.mockImplementation((tx, id) => freeze(contexts.get(tx), id));
  m.transactions.mockImplementation(async work => {
    const ctx: Context = {
      id: ++transactionId,
      scope: '',
      runs: new Map(),
      candidates: new Map(),
      receipts: new Map(),
    };
    const tx = {
      $queryRawUnsafe: async (sql: string, ...values: any[]) => {
        if (sql.includes('FROM "user"')) return [{ role: 'admin' }];
        if (sql.includes('FROM liekan_analysis_site')) return [{ ...state.site }];
        if (sql.startsWith('SELECT * FROM liekan_storage_policy')) {
          ctx.scope = values[0];
          if (sql.includes('FOR UPDATE')) {
            const previous = locks.get(ctx.scope) || Promise.resolve();
            let release: () => void;
            const current = new Promise<void>(resolve => {
              release = resolve;
            });
            locks.set(
              ctx.scope,
              previous.then(() => current),
            );
            await previous;
            ctx.release = release;
            event(ctx, 'policy-lock');
          }
          ctx.runs = structuredClone(state.runs);
          ctx.candidates = new Map(state.candidates);
          return [{ ...state.policies.get(ctx.scope) }];
        }
        if (sql.startsWith('SELECT * FROM liekan_storage_operation')) {
          const receipt = ctx.receipts.get(values[0]) || state.receipts.get(values[0]);
          return receipt ? [receipt] : [];
        }
        if (sql.startsWith('SELECT id FROM liekan_storage_cleanup')) {
          event(ctx, 'active-check');
          return [...ctx.runs.values()].filter(
            row => row.scope_key === values[0] && ['queued', 'running'].includes(row.status),
          );
        }
        if (sql.startsWith('SELECT * FROM liekan_storage_cleanup WHERE scope_key='))
          return [...ctx.runs.values()]
            .filter(row => row.scope_key === values[0] && row.status === 'preview')
            .slice(-1);
        if (sql.startsWith('UPDATE liekan_storage_cleanup SET candidate_count=')) {
          const row = ctx.runs.get(values[0]);
          Object.assign(row, {
            candidate_count: values[1],
            protected_count: values[2],
            estimated_bytes: values[3],
          });
          return [row];
        }
        if (sql.includes('JOIN liekan_analysis_generation'))
          return [{ count: ctx.candidates.get(values[0]), bytes: '400' }];
        if (sql.includes('FROM liekan_analysis_generation')) return [{ count: 0 }];
        throw new Error(`Unexpected preview query: ${sql}`);
      },
      $executeRawUnsafe: async (sql: string, ...values: any[]) => {
        if (sql.startsWith('SET LOCAL') || sql.startsWith('INSERT INTO liekan_storage_policy'))
          return 1;
        if (sql.includes("error_code='storage-preview-replaced'")) {
          event(ctx, 'stop-previous');
          for (const row of ctx.runs.values())
            if (row.scope_key === values[0] && row.status === 'preview')
              Object.assign(row, { status: 'stopped', error_code: 'storage-preview-replaced' });
          return 1;
        }
        if (sql.startsWith('DELETE FROM liekan_storage_candidate')) {
          event(ctx, 'release-candidates');
          for (const row of ctx.runs.values())
            if (
              row.scope_key === values[0] &&
              ['completed', 'stopped', 'failed'].includes(row.status)
            )
              ctx.candidates.delete(row.id);
          return 1;
        }
        if (sql.startsWith('INSERT INTO liekan_storage_cleanup')) {
          event(ctx, 'insert-run');
          ctx.runs.set(values[0], {
            ...run(),
            id: values[0],
            scope_key: values[1],
            website_id: values[2],
            actor_id: values[3],
            locale: values[4],
            kind: values[5],
            status: values[6],
            policy_revision: values[7],
            epoch: values[8],
            ownership: values[9] ? JSON.parse(values[9]) : null,
            conditions: JSON.parse(values[10]),
            created_at: new Date(),
            expires_at: new Date(Date.now() + 15 * 60000),
          });
          return 1;
        }
        if (sql.startsWith('UPDATE liekan_storage_cleanup SET physical_bytes_before=')) return 1;
        if (sql.startsWith('INSERT INTO liekan_storage_candidate')) return freeze(ctx, values[2]);
        if (sql.startsWith('INSERT INTO liekan_storage_operation')) {
          event(ctx, 'receipt');
          ctx.receipts.set(values[0], {
            request_hash: values[4],
            scope_key: values[1],
            actor_id: values[2],
            response: JSON.parse(values[5]),
          });
          return 1;
        }
        throw new Error(`Unexpected preview statement: ${sql}`);
      },
    };
    contexts.set(tx, ctx);
    try {
      const result = await work(tx);
      for (const row of state.runs.values())
        if (row.scope_key === ctx.scope) {
          state.runs.delete(row.id);
          state.candidates.delete(row.id);
        }
      for (const row of ctx.runs.values())
        if (row.scope_key === ctx.scope) {
          state.runs.set(row.id, row);
          if (ctx.candidates.has(row.id)) state.candidates.set(row.id, ctx.candidates.get(row.id));
        }
      for (const [id, receipt] of ctx.receipts) state.receipts.set(id, receipt);
      return result;
    } finally {
      ctx.release?.();
    }
  });
  const submit = (
    index: number,
    retention: Partial<{ generationHours: number; completedHours: number; wakeHours: number }> = {},
    scope = { actorId: actor.id } as { actorId: string; websiteId?: string },
  ) =>
    storage.storageAction(scope, {
      action: 'preview',
      generationHours: 24,
      completedHours: 24,
      wakeHours: 1,
      ...retention,
      requestId: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
    });
  return { state, submit };
}

describe('storage preview candidate amplification protection', () => {
  it('reuses one frozen set and preserves its deadline for 1000 different request identifiers', async () => {
    const { state, submit } = previewFixture();
    const first = await submit(1);
    const original = structuredClone([...state.runs.values()][0]);
    for (let index = 2; index <= 1000; index++) {
      vi.setSystemTime(new Date(+original.created_at + index));
      expect(await submit(index)).toEqual(first);
    }
    expect(state.runs.size).toBe(1);
    expect(state.candidates).toEqual(new Map([[first.id, 4]]));
    expect([...state.runs.values()][0]).toEqual(original);
    expect(m.freeze).toHaveBeenCalledOnce();
    expect(state.receipts.size).toBe(1000);
    expect(new Set([...state.receipts.values()].map(receipt => receipt.response.id))).toEqual(
      new Set([first.id]),
    );
    expect(state.events.filter(event => event.name === 'release-candidates')).toHaveLength(1);
  });

  it.each(['generationHours', 'completedHours', 'wakeHours'] as const)(
    'replaces a preview after %s changes and releases old members before freezing the new set',
    async field => {
      const { state, submit } = previewFixture();
      const first = await submit(1);
      const boundary = state.events.length;
      const second = await submit(2, { [field]: 6 });
      expect(second.id).not.toBe(first.id);
      expect(state.runs.get(first.id)).toMatchObject({
        status: 'stopped',
        error_code: 'storage-preview-replaced',
      });
      expect(state.candidates).toEqual(new Map([[second.id, 4]]));
      const names = state.events.slice(boundary).map(event => event.name);
      expect(names.indexOf('stop-previous')).toBeLessThan(names.indexOf('release-candidates'));
      expect(names.indexOf('release-candidates')).toBeLessThan(names.indexOf('insert-run'));
      expect(names.indexOf('insert-run')).toBeLessThan(names.indexOf('freeze'));
      expect(state.receipts.size).toBe(2);
    },
  );

  it('creates a new frozen set for another authorized actor in the same scope', async () => {
    const { state, submit } = previewFixture();
    const first = await submit(1);
    const secondActor = '55555555-5555-4555-8555-555555555555';
    const second = await submit(2, {}, { actorId: secondActor });
    expect(second.id).not.toBe(first.id);
    expect(state.runs.get(first.id).status).toBe('stopped');
    expect(state.runs.get(second.id).actor_id).toBe(secondActor);
    expect(state.candidates).toEqual(new Map([[second.id, 4]]));
    expect(m.freeze).toHaveBeenCalledTimes(2);
  });

  it('reuses an unexpired preview and replaces it at the exact expiration boundary', async () => {
    const { state, submit } = previewFixture();
    const first = await submit(1);
    vi.setSystemTime(new Date(+new Date(first.expiresAt) - 1));
    expect(await submit(2)).toEqual(first);
    vi.setSystemTime(new Date(first.expiresAt));
    const replacement = await submit(3);
    expect(replacement.id).not.toBe(first.id);
    expect(state.runs.get(first.id).status).toBe('stopped');
    expect(state.candidates).toEqual(new Map([[replacement.id, 4]]));
    expect(m.freeze).toHaveBeenCalledTimes(2);
  });

  it.each(['revision', 'epoch', 'ownership'] as const)(
    'replaces a website preview after its %s fence changes',
    async fence => {
      const { state, submit } = previewFixture();
      const scope = { actorId: actor.id, websiteId: site };
      const first = await submit(1, {}, scope);
      if (fence === 'revision') state.policies.get(site).revision++;
      if (fence === 'epoch') state.site.epoch = '2';
      if (fence === 'ownership') state.site.team_id = '55555555-5555-4555-8555-555555555555';
      const replacement = await submit(2, {}, scope);
      expect(replacement.id).not.toBe(first.id);
      expect(state.runs.get(first.id).status).toBe('stopped');
      expect(state.candidates).toEqual(new Map([[replacement.id, 4]]));
    },
  );

  it.each(['queued', 'running'])(
    'rejects preview while a %s cleanup owns the scope without recycling its candidates',
    async status => {
      const { state, submit } = previewFixture();
      const first = await submit(1);
      state.runs.get(first.id).status = status;
      const boundary = state.events.length;
      await expect(submit(2)).rejects.toMatchObject({ status: 409, code: 'storage-run-active' });
      expect(state.runs.get(first.id).status).toBe(status);
      expect(state.candidates).toEqual(new Map([[first.id, 4]]));
      expect(state.receipts.size).toBe(1);
      expect(state.events.slice(boundary).map(event => event.name)).toEqual([
        'policy-lock',
        'active-check',
      ]);
      expect(m.freeze).toHaveBeenCalledOnce();
    },
  );

  it('serializes concurrent requests on their scope policy before checking or freezing candidates', async () => {
    const { state, submit } = previewFixture();
    let entered: () => void, release: () => void;
    const freezing = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    state.beforeFreeze = async () => {
      entered();
      await gate;
    };
    const first = submit(1);
    await freezing;
    let secondCompleted = false;
    const second = submit(2).then(result => {
      secondCompleted = true;
      return result;
    });
    for (let step = 0; step < 20; step++) await Promise.resolve();
    expect(secondCompleted).toBe(false);
    expect(state.runs.size).toBe(0);
    expect(m.freeze).toHaveBeenCalledOnce();
    release();
    const results = await Promise.all([first, second]);
    expect(results[0].id).toBe(results[1].id);
    expect(state.runs.size).toBe(1);
    expect(state.receipts.size).toBe(2);
    expect(state.candidates).toEqual(new Map([[results[0].id, 4]]));
    expect(m.freeze).toHaveBeenCalledOnce();
    for (const tx of [1, 2]) {
      const events = state.events.filter(event => event.tx === tx).map(event => event.name);
      expect(events[0]).toBe('policy-lock');
      expect(events[1]).toBe('active-check');
    }
  });

  it('allows a different scope to finish while another scope is freezing its preview', async () => {
    const { state, submit } = previewFixture();
    let entered: () => void, release: () => void;
    const freezing = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    state.beforeFreeze = async scope => {
      if (scope === 'instance') {
        entered();
        await gate;
      }
    };
    const instance = submit(1);
    await freezing;
    const website = await submit(2, {}, { actorId: actor.id, websiteId: site });
    expect(state.runs.size).toBe(1);
    expect(state.runs.get(website.id).scope_key).toBe(site);
    release();
    const instancePreview = await instance;
    expect(state.runs.size).toBe(2);
    expect(state.candidates).toEqual(
      new Map([
        [website.id, 4],
        [instancePreview.id, 4],
      ]),
    );
  });

  it('preserves the previous preview and its members when replacement freezing fails', async () => {
    const { state, submit } = previewFixture();
    const first = await submit(1);
    const original = structuredClone(state.runs.get(first.id));
    state.beforeFreeze = async () => {
      throw new Error('preview-freeze-timeout');
    };
    await expect(submit(2, { generationHours: 6 })).rejects.toThrow('preview-freeze-timeout');
    expect(state.runs.size).toBe(1);
    expect(state.runs.get(first.id)).toEqual(original);
    expect(state.candidates).toEqual(new Map([[first.id, 4]]));
    expect(state.receipts.size).toBe(1);
    state.beforeFreeze = undefined;
    expect(await submit(3)).toEqual(first);
  });
});
