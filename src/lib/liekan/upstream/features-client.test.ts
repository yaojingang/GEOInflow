import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientAuthToken, setClientAuthToken } from '@/lib/client';
import { setReturnUrl } from '@/lib/return-url';
import { setUser, useApp } from '@/store/app';
import {
  acceptFeatureLogin,
  clearFeatureLogin,
  featureApi,
  featureRequest,
  FeatureApiError,
  getFeatureWebsiteSummary,
  getFeatureSites,
  invalidateFeatureWebsiteQueries,
  invalidateFeatureUserQueries,
  resumeFeatureLogin,
  refreshFeatureIdentity,
} from './features-client';
import { freshnessExpiry, withClientFreshness } from './client-freshness';

it.each([true, false])(
  'resumes an idle handle once and bounds rapid repeated idle failures: %s',
  async success => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const site = '11111111-1111-4111-8111-111111111111',
      id = '22222222-2222-4222-8222-222222222222';
    const job = {
      id,
      websiteId: site,
      status: 'queued',
      queuedAt: '2026-01-01',
      startedAt: null,
      completedAt: null,
      generatedAt: null,
      expiresAt: null,
      errorCode: null,
      retryAfterMs: 1000,
      resultUrl: `/liekan/websites/${site}/analytics-jobs/${id}/result`,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ analysisJob: job }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({ analysisJob: { ...job, status: 'failed', errorCode: 'analysis-idle' } }),
      )
      .mockResolvedValueOnce(
        success
          ? Response.json({ synthetic: 'resumed' })
          : Response.json({ analysisJob: job }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        Response.json({ analysisJob: { ...job, status: 'failed', errorCode: 'analysis-idle' } }),
      );
    const release = vi.fn(async () => Response.json({ released: true }));
    vi.stubGlobal('fetch', (url: any, options: any) =>
      options?.method === 'DELETE' ? release() : fetcher(url, options),
    );
    try {
      const pending = featureApi.get(`/liekan/websites/${site}/page-report`, {
        resource: 'ai/pages',
        startAt: 1,
        endAt: 2,
      });
      const checked = success
        ? expect(pending).resolves.toEqual({ synthetic: 'resumed' })
        : expect(pending).rejects.toMatchObject({ code: 'analysis-idle' });
      await vi.advanceTimersByTimeAsync(3000);
      await checked;
      expect(fetcher).toHaveBeenCalledTimes(success ? 3 : 4);
      expect(release).toHaveBeenCalledTimes(success ? 1 : 2);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  },
);

it('resumes each new visible reading round without repeating immediate idle failures', async () => {
  vi.useFakeTimers();
  let visible = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visible as DocumentVisibilityState,
  );
  const site = '11111111-1111-4111-8111-111111111111',
    id = '22222222-2222-4222-8222-222222222222';
  const job = {
    id,
    websiteId: site,
    status: 'running',
    queuedAt: '2026-01-01',
    startedAt: null,
    completedAt: null,
    generatedAt: null,
    expiresAt: null,
    errorCode: null,
    retryAfterMs: 1000,
    resultUrl: `/liekan/websites/${site}/analytics-jobs/${id}/result`,
  };
  let submissions = 0;
  vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
    if (options?.method === 'DELETE') return Response.json({ released: true });
    if (url.pathname.endsWith('/page-report'))
      return ++submissions === 3
        ? Response.json({ synthetic: 'resumed twice' })
        : Response.json({ analysisJob: job }, { status: 202 });
    return Response.json(
      { error: { code: 'analysis-idle', message: 'expired viewer' } },
      { status: 410 },
    );
  });
  const controller = new AbortController();
  try {
    const pending = featureApi.get(
      `/liekan/websites/${site}/page-report`,
      { resource: 'ai/pages', startAt: 3, endAt: 4 },
      controller.signal,
    );
    const checked = expect(pending).resolves.toEqual({ synthetic: 'resumed twice' });
    void checked.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(submissions).toBe(1);
    for (let round = 0; round < 2; round++) {
      visible = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(20000);
      visible = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await checked;
    expect(submissions).toBe(3);
  } finally {
    controller.abort();
    vi.useRealTimers();
  }
});
it('keeps a delayed old release from expiring a rejoined running task', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const site = '11111111-1111-4111-8111-111111111111',
    id = '22222222-2222-4222-8222-222222222222';
  const job = {
    id,
    websiteId: site,
    status: 'running',
    queuedAt: '2026-01-01',
    startedAt: null,
    completedAt: null,
    generatedAt: null,
    expiresAt: null,
    errorCode: null,
    retryAfterMs: 1000,
    resultUrl: `/liekan/websites/${site}/analytics-jobs/${id}/result`,
  };
  const active = new Set<string>(),
    submissions: string[] = [],
    releases: (() => void)[] = [];
  let polls = 0;
  vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
    const viewer = new Headers(options?.headers).get('X-Liekan-View');
    if (options?.method === 'DELETE')
      return new Promise<Response>(resolve =>
        releases.push(() => {
          active.delete(viewer);
          resolve(Response.json({ released: true }));
        }),
      );
    if (url.pathname.endsWith('/page-report')) {
      submissions.push(viewer);
      active.add(viewer);
      if (submissions.length === 2) releases[0]();
      return Response.json({ analysisJob: job }, { status: 202 });
    }
    if (url.pathname.endsWith('/result')) return Response.json({ synthetic: 'running result' });
    if (++polls === 1 || !active.has(viewer))
      return Response.json(
        { error: { code: 'analysis-idle', message: 'expired viewer' } },
        { status: 410 },
      );
    return Response.json({ analysisJob: { ...job, status: 'ready' } });
  });
  const controller = new AbortController();
  try {
    const pending = featureApi.get(
      `/liekan/websites/${site}/page-report`,
      { resource: 'ai/pages', startAt: 5, endAt: 6 },
      controller.signal,
    );
    const checked = expect(pending).resolves.toEqual({ synthetic: 'running result' });
    void checked.catch(() => {});
    await vi.advanceTimersByTimeAsync(3000);
    await checked;
    expect(submissions).toHaveLength(2);
    expect(new Set(submissions).size).toBe(2);
  } finally {
    controller.abort();
    for (const release of releases) release();
    vi.useRealTimers();
  }
});

it('keeps previous and final async populations with their own exact range and freshness headers', async () => {
  vi.useFakeTimers();
  const site = '11111111-1111-4111-8111-111111111111';
  const jobId = '22222222-2222-4222-8222-222222222222';
  const range = { startAt: 1000, endAt: 2000, timezone: 'UTC' };
  const population = {
    resourceId: site,
    populationVersion: 'browser-population-v4',
    resourceKind: 'website',
    capability: 'supported',
    scope: 'resource-window',
    policyRevision: '1',
    historyActiveGeneration: null,
    historyRevision: null,
    epoch: '3',
    governanceRevision: '4',
    governanceWatermark: null,
    identity: {
      status: 'partial',
      eligibleEvents: 8,
      eligiblePV: 5,
      qualifiedPV: 2,
      qualifiedVisitors: 1,
      coverage: 0.4,
      versions: ['identity-v1'],
    },
    ruleVersions: ['rule-v1'],
    catalogVersions: ['catalog-v1'],
    versionSetsTruncated: false,
    range,
  };
  const finalPopulation = {
    ...population,
    policyRevision: '2',
    identity: { ...population.identity, status: 'complete', coverage: 1 },
  };
  const job = {
    id: jobId,
    websiteId: site,
    status: 'queued',
    queuedAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    generatedAt: null,
    expiresAt: null,
    errorCode: null,
    retryAfterMs: 3000,
    resultUrl: `/liekan/websites/${site}/analytics-jobs/${jobId}/result`,
  };
  const now = Date.now();
  const headers = (p: unknown, lifetime: number) => ({
    'X-Liekan-Population': JSON.stringify({ populations: [p] }),
    'X-Liekan-Generated-At': String(now),
    'X-Liekan-Server-Time': String(now),
    'X-Liekan-Expires-At': String(now + lifetime),
  });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { analysisJob: job, previousResult: [{ x: 'old', y: null }] },
        { status: 202, headers: headers(population, 10000) },
      ),
    )
    .mockResolvedValueOnce(Response.json({ analysisJob: { ...job, status: 'ready' } }))
    .mockResolvedValueOnce(
      Response.json([{ x: 'new', y: 2 }], { headers: headers(finalPopulation, 60000) }),
    );
  vi.stubGlobal('fetch', fetcher);
  const previous = vi.fn();
  try {
    const pending = featureApi.get(
      `/liekan/websites/${site}/analytics`,
      { ...range, kind: 'visitors' },
      undefined,
      { onPrevious: previous },
    );
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous.mock.calls[0][0].population).toEqual(population);
    expect(freshnessExpiry(previous.mock.calls[0][0])).toBe(now + 10000);
    expect(result.population).toEqual(finalPopulation);
    expect(freshnessExpiry(result)).toBe(now + 60000);
    expect(JSON.stringify(result)).toBe('[{"x":"new","y":2}]');
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const wrong of [
      { ...population, range: { ...range, startAt: 0 } },
      { ...population, range: { ...range, timezone: 'Asia/Shanghai' } },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json([], { headers: headers(wrong, 60000) }));
      const mismatch = await featureApi.get(`/liekan/websites/${site}/analytics`, {
        ...range,
        kind: 'visitors',
      });
      expect(mismatch.population).toBeUndefined();
    }
  } finally {
    vi.useRealTimers();
  }
});

it('pins help catalog, source health and website status to one read round while management reads stay current', async () => {
  const version = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const fetcher = vi.fn(async (url: URL) =>
    Response.json(url.pathname.endsWith('/catalog-version') ? { version } : { fixture: true }),
  );
  vi.stubGlobal('fetch', fetcher);
  try {
    const catalogScope = crypto.randomUUID();
    for (const path of [
      '/liekan/crawler-registry',
      '/liekan/admin/crawler-sources',
      '/liekan/websites/fixture/crawler-recognition',
      '/liekan/admin/crawler-registry',
    ]) {
      const signal = new AbortController().signal;
      await withClientFreshness(signal, () => featureRequest('GET', path, {}, signal), {
        catalogScope,
      });
    }
    const calls = fetcher.mock.calls as unknown as [URL, RequestInit][];
    expect(calls.filter(([url]) => url.pathname.endsWith('/catalog-version'))).toHaveLength(1);
    for (const [url, options] of calls.filter(
      ([url]) => !url.pathname.endsWith('/catalog-version'),
    )) {
      const header = new Headers(options.headers).get('X-Liekan-Catalog-Version');
      expect(header).toBe(url.pathname.endsWith('/admin/crawler-registry') ? null : version);
    }
  } finally {
    vi.unstubAllGlobals();
  }
});

it('isolates a revoked website within a summary batch while retaining accessible statistics', async () => {
  const get = vi.fn(async (_path: string, params: any) => {
    const ids = params.ids.split(',');
    if (ids.includes('revoked')) throw new FeatureApiError('无权访问', 403);
    return ids.map((id: string) => ({ id, views: 7, received: true }));
  });
  const rows = await getFeatureWebsiteSummary(
    ['a', 'revoked', 'b'],
    { startAt: 0, endAt: 1000 },
    undefined,
    get as any,
  );
  expect(rows.find(row => row.id === 'a').views).toBe(7);
  expect(rows.find(row => row.id === 'b').views).toBe(7);
  expect(rows.find(row => row.id === 'revoked').error.status).toBe(403);
});
it('cancels pre-save website reads so their late results cannot refresh the cache', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ['liekan', 'site', undefined, 'overview'];
  const other = ['liekan', 'other', undefined, 'overview'];
  client.setQueryData(key, { value: 'before' });
  let finish!: (value: any) => void;
  let oldSignal!: AbortSignal;
  const pending = client.prefetchQuery({
    queryKey: key,
    queryFn: ({ signal }) => {
      oldSignal = signal;
      return new Promise(resolve => {
        finish = resolve;
      });
    },
  });
  await client.prefetchQuery({ queryKey: other, queryFn: async () => ({ value: 'other' }) });
  await invalidateFeatureWebsiteQueries(client, 'site');
  expect(oldSignal.aborted).toBe(true);
  finish({ value: 'stale' });
  await pending;
  expect(client.getQueryData(key)).toEqual({ value: 'before' });
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  expect(client.getQueryState(other)?.isInvalidated).toBe(false);
});
it('invalidates GEO, metadata and resource queries after a global settings refresh', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const geo = (user: string) => [
    'liekan',
    'site',
    undefined,
    'overview',
    0,
    1,
    'UTC',
    '30d',
    '',
    '',
    1,
    '',
    '',
    '{}',
    user,
  ];
  const keys = [
    geo('user'),
    ['liekan-feature', 'user', 'site', 'site'],
    ['liekan-feature', 'resource-analytics', 'user', 'site'],
  ];
  for (const key of [...keys, geo('other-user')]) client.setQueryData(key, { value: 'before' });
  let finish!: (value: any) => void;
  let oldSignal!: AbortSignal;
  const pending = client.prefetchQuery({
    queryKey: keys[0],
    queryFn: ({ signal }) => {
      oldSignal = signal;
      return new Promise(resolve => {
        finish = resolve;
      });
    },
  });
  await invalidateFeatureUserQueries(client, 'user');
  expect(oldSignal.aborted).toBe(true);
  finish({ value: 'stale' });
  await pending;
  for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  expect(client.getQueryData(keys[0])).toEqual({ value: 'before' });
  expect(client.getQueryState(geo('other-user'))?.isInvalidated).toBe(false);
});
it('loads large team memberships through a bounded request window', async () => {
  const teams = Array.from({ length: 201 }, (_, index) => ({ id: `team-${index}` }));
  const fetch = vi.fn(async (input: URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/me/teams')) {
      const page = Number(url.searchParams.get('page'));
      return Response.json({
        data: teams.slice((page - 1) * 100, page * 100),
        count: teams.length,
      });
    }
    if (url.pathname.endsWith('/me/websites')) return Response.json({ data: [], count: 0 });
    const team = url.pathname.match(/teams\/(team-\d+)\/websites/)[1];
    return Response.json({ data: [{ id: `site-${team}` }], count: 1 });
  });
  vi.stubGlobal('fetch', fetch);
  expect(await getFeatureSites()).toHaveLength(201);
  expect(fetch).toHaveBeenCalledTimes(205);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('saved login restoration', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setUser(null);
  });
  it('restores a persisted token, verifies live identity and consumes a safe return path', async () => {
    setClientAuthToken('saved-token');
    setReturnUrl('/websites');
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 'user-1', username: 'owner' }));
    vi.stubGlobal('fetch', fetch);
    expect(await resumeFeatureLogin()).toBe('/websites');
    expect(fetch.mock.calls[0][1].headers.authorization).toBe('Bearer saved-token');
    expect(useApp.getState().user.id).toBe('user-1');
    expect(getClientAuthToken()).toBe('saved-token');
    expect(sessionStorage.getItem('umami.return-url')).toBeNull();
  });
  it('leaves the login form available without a saved session', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await resumeFeatureLogin()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('clears an expired session after a verified 401', async () => {
    setClientAuthToken('expired');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status: 401 })));
    expect(await resumeFeatureLogin()).toBeNull();
    expect(getClientAuthToken()).toBeUndefined();
    expect(useApp.getState().user).toBeNull();
  });
  it.each(['network', 'service'])(
    'retains the saved session during a transient %s failure',
    async kind => {
      setClientAuthToken('saved');
      vi.stubGlobal(
        'fetch',
        kind === 'network'
          ? vi.fn().mockRejectedValue(new Error('offline'))
          : vi.fn().mockResolvedValue(Response.json({}, { status: 503 })),
      );
      await expect(resumeFeatureLogin()).rejects.toThrow();
      expect(getClientAuthToken()).toBe('saved');
    },
  );
  it.each([200, 401])(
    'ignores a stale restoration response after a newer login (HTTP %s)',
    async status => {
      setClientAuthToken('previous');
      let resolve!: (value: Response) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockReturnValue(
          new Promise<Response>(r => {
            resolve = r;
          }),
        ),
      );
      const pending = resumeFeatureLogin();
      acceptFeatureLogin({ token: 'new-session', user: { id: 'new-user' } });
      resolve(Response.json({ id: 'old-user' }, { status }));
      expect(await pending).toBeNull();
      expect(getClientAuthToken()).toBe('new-session');
      expect(useApp.getState().user.id).toBe('new-user');
    },
  );
  it.each(['switch', 'logout'])('ignores a late manual identity refresh after %s', async mode => {
    setClientAuthToken('previous');
    setUser({ id: 'old-user' } as any);
    let resolve!: (value: Response) => void;
    const fetch = vi.fn().mockReturnValue(
      new Promise<Response>(r => {
        resolve = r;
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const pending = refreshFeatureIdentity();
    void pending.catch(() => {});
    if (mode === 'switch') acceptFeatureLogin({ token: 'new-session', user: { id: 'new-user' } });
    else clearFeatureLogin();
    resolve(Response.json({ id: 'old-user' }));
    await expect(pending).rejects.toThrow('身份');
    expect(fetch.mock.calls[0][1].headers.authorization).toBe('Bearer previous');
    expect(useApp.getState().user?.id ?? null).toBe(mode === 'switch' ? 'new-user' : null);
  });
  it('clears the current identity when manual verification rejects its session', async () => {
    acceptFeatureLogin({ token: 'expired', user: { id: 'old-user' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status: 401 })));
    await expect(refreshFeatureIdentity()).rejects.toMatchObject({ status: 401 });
    expect(getClientAuthToken()).toBeUndefined();
    expect(useApp.getState().user).toBeNull();
  });
  it.each(['network', 'service'])(
    'retains the current identity during a transient manual %s failure',
    async kind => {
      acceptFeatureLogin({ token: 'saved', user: { id: 'current-user' } });
      vi.stubGlobal(
        'fetch',
        kind === 'network'
          ? vi.fn().mockRejectedValue(new Error('offline'))
          : vi.fn().mockResolvedValue(Response.json({}, { status: 503 })),
      );
      await expect(refreshFeatureIdentity()).rejects.toThrow();
      expect(getClientAuthToken()).toBe('saved');
      expect(useApp.getState().user.id).toBe('current-user');
    },
  );
  it('retains a newer login when an earlier manual verification returns 401', async () => {
    acceptFeatureLogin({ token: 'previous', user: { id: 'old-user' } });
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>(r => (resolve = r))));
    const pending = refreshFeatureIdentity();
    acceptFeatureLogin({ token: 'new-session', user: { id: 'new-user' } });
    resolve(Response.json({}, { status: 401 }));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(getClientAuthToken()).toBe('new-session');
    expect(useApp.getState().user.id).toBe('new-user');
  });
  it('aborting restoration prevents late identity changes and leaves return paths intact', async () => {
    setClientAuthToken('saved');
    setReturnUrl('/websites');
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>(r => {
          resolve = r;
        }),
      ),
    );
    const controller = new AbortController();
    const pending = resumeFeatureLogin(controller.signal);
    controller.abort();
    resolve(Response.json({ id: 'user-1' }));
    expect(await pending).toBeNull();
    expect(useApp.getState().user).toBeNull();
    expect(sessionStorage.getItem('umami.return-url')).not.toBeNull();
  });
  it('logout clears the persistent token and prevents login restoration', async () => {
    acceptFeatureLogin({ token: 'saved', user: { id: 'user-1' } });
    expect(getClientAuthToken()).toBe('saved');
    clearFeatureLogin();
    expect(await resumeFeatureLogin()).toBeNull();
    expect(getClientAuthToken()).toBeUndefined();
    expect(useApp.getState().user).toBeNull();
  });
});
describe('accessible website collection', () => {
  it('includes member and read-only team websites in all accessible sources', async () => {
    const get = vi.spyOn(featureApi, 'get').mockImplementation(async path => {
      if (path === '/me/websites') return [{ id: 'personal', name: '个人网站' }];
      if (path === '/me/teams')
        return [
          { id: 'member-team', role: 'team-member' },
          { id: 'reader-team', role: 'team-view-only' },
        ];
      if (path === '/teams/member-team/websites') return [{ id: 'member-site', name: '成员网站' }];
      if (path === '/teams/reader-team/websites') return [{ id: 'reader-site', name: '只读网站' }];
      throw new Error(`Unexpected fixture request ${path}`);
    });
    const rows = await getFeatureSites(undefined, undefined, 'all');
    expect(rows.map(site => site.id)).toEqual(['personal', 'member-site', 'reader-site']);
    expect(get).toHaveBeenCalledWith('/teams/reader-team/websites', expect.any(Object), undefined);
  });
  it('keeps the default personal list independent of team enumeration', async () => {
    const get = vi.spyOn(featureApi, 'get').mockResolvedValue([{ id: 'personal' }]);
    expect(await getFeatureSites(undefined, undefined, 'personal')).toEqual([{ id: 'personal' }]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe('/me/websites');
    expect(get.mock.calls[0][1]).not.toHaveProperty('includeTeams');
  });
});

it('forces only covered aggregate GETs on a manual read and keeps ordinary reads unforced', async () => {
  const { withClientFreshness } = await import('./client-freshness');
  const fetch = vi.fn(async (_input: URL) => Response.json({ value: 7 }));
  vi.stubGlobal('fetch', fetch);
  await withClientFreshness(new AbortController().signal, async () => {
    const signal = new AbortController().signal;
    return featureApi.get('/websites/site/stats', {}, signal);
  });
  const signal = new AbortController().signal;
  await withClientFreshness(
    signal,
    async () => {
      await featureApi.get('/websites/site/stats', {}, signal);
      await featureApi.get('/websites/site', {}, signal);
    },
    { refresh: true },
  );
  expect(new URL(String(fetch.mock.calls[0][0])).searchParams.has('refresh')).toBe(false);
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('refresh')).toBe('1');
  expect(new URL(String(fetch.mock.calls[2][0])).searchParams.has('refresh')).toBe(false);
});
it('keeps privacy detail reads outside the aggregate refresh policy', async () => {
  const { isAggregateRequest } = await import('./features-client');
  expect(isAggregateRequest('/liekan/websites/site/analytics', { kind: 'session' })).toBe(false);
  expect(isAggregateRequest('/liekan/websites/site/analytics', { kind: 'revenue' })).toBe(false);
  expect(isAggregateRequest('/websites/site/replays/visit')).toBe(false);
  expect(isAggregateRequest('/websites/site/journeys/details')).toBe(false);
  expect(isAggregateRequest('/websites/site/revenue/stats')).toBe(true);
});
it('retains server retry guidance on automatic read failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({}, { status: 503, headers: { 'Retry-After': '90' } })),
  );
  await expect(featureApi.get('/websites/site/stats')).rejects.toMatchObject({
    status: 503,
    retryAfterMs: 90000,
  });
});

it.each([
  '/liekan/websites/site/crawler-analysis',
  '/liekan/websites/site/goals/goal/analytics',
  '/websites/site/goals/stats',
  '/websites/site/funnels/stats',
  '/websites/site/goals/goal/stats',
  '/websites/site/funnels/funnel/savedstats',
])('uses the aggregate freshness and manual refresh policy for %s', async path => {
  const { isAggregateRequest } = await import('./features-client');
  const { hasClientFreshness, withClientFreshness } = await import('./client-freshness');
  expect(isAggregateRequest(path)).toBe(true);
  const fetch = vi.fn(async (_input: URL) => Response.json({ visitors: 7 }));
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  const value = await withClientFreshness(signal, () => featureApi.get(path, {}, signal), {
    refresh: true,
  });
  expect(hasClientFreshness(value)).toBe(true);
  expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('refresh')).toBe('1');
});

it('marks private AI data for later entry without clearing another identity', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const keys = [
    ['liekan-ai', 'user', 'catalog'],
    ['liekan-ai', 'user', 'conversation', 'site', 'conversation'],
    ['liekan-ai', 'user', 'messages', 'site', 'conversation'],
    ['liekan-ai', 'user', 'context', 'conversation', 'snapshot'],
  ];
  for (const key of keys) client.setQueryData(key, { private: 'old data' });
  const other = ['liekan-ai', 'other', 'messages', 'site', 'conversation'];
  client.setQueryData(other, { private: 'other identity' });
  await invalidateFeatureUserQueries(client, 'user');
  for (const key of keys) {
    expect(client.getQueryData(key)).toEqual({ private: 'old data' });
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  }
  expect(client.getQueryData(other)).toEqual({ private: 'other identity' });
  client.clear();
});
it('marks website AI content for later entry and retains other websites', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const keys = [
    ['liekan-ai', 'user', 'catalog'],
    ['liekan-ai', 'user', 'catalog-selected', 'site'],
    ['liekan-ai', 'user', 'conversation', 'site', 'conversation'],
    ['liekan-ai', 'user', 'messages', 'site', 'conversation'],
    ['liekan-ai', 'user', 'history', 'site'],
    ['liekan-ai', 'user', 'context', 'conversation', 'snapshot'],
  ];
  for (const key of keys) client.setQueryData(key, { private: 'old data' });
  const other = ['liekan-ai', 'user', 'messages', 'other-site', 'conversation'];
  client.setQueryData(other, { private: 'other website' });
  await invalidateFeatureWebsiteQueries(client, 'site');
  for (const key of keys) {
    expect(client.getQueryData(key)).toEqual({ private: 'old data' });
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  }
  expect(client.getQueryData(other)).toEqual({ private: 'other website' });
  client.clear();
});

it.each(['ready', 'queued', 'running', 'failed'])(
  'only grants browser persistence proof to completed GEO snapshots: %s',
  async taskStatus => {
    const { serializeClientFreshness } = await import('./client-freshness');
    const now = Date.now();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { taskStatus, result: { current: { level: null } } },
          {
            headers: {
              'X-Liekan-Generated-At': String(now),
              'X-Liekan-Expires-At': String(now + 86400000),
              'X-Liekan-Server-Time': String(now),
            },
          },
        ),
      ),
    );
    const path = '/liekan/websites/11111111-1111-4111-8111-111111111111/geo-weight/snapshot';
    const result = await featureApi.get(path, { mode: 'current', timezone: 'UTC' });
    expect(!!serializeClientFreshness(result)).toBe(taskStatus === 'ready');
    if (taskStatus === 'ready')
      expect(serializeClientFreshness(result).expiresAt).toBe(now + 86400000);
  },
);

it('merges identical page reads and releases one transport lease after the last reader finishes', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const site = '11111111-1111-4111-8111-111111111111',
    id = '22222222-2222-4222-8222-222222222222';
  const job = {
    id,
    websiteId: site,
    status: 'queued',
    queuedAt: '2026-01-01',
    startedAt: null,
    completedAt: null,
    generatedAt: null,
    expiresAt: null,
    errorCode: null,
    retryAfterMs: 1000,
    resultUrl: `/liekan/websites/${site}/analytics-jobs/${id}/result`,
  };
  const fetcher = vi.fn(async (url: URL, options: any) => {
    if (options?.method === 'DELETE') return Response.json({ released: true });
    if (url.pathname.endsWith('/result')) return Response.json({ synthetic: 'shared' });
    if (url.pathname.endsWith('/' + id))
      return Response.json({ analysisJob: { ...job, status: 'ready' } });
    return Response.json({ analysisJob: job }, { status: 202 });
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    const controller = new AbortController(),
      params = { resource: 'ai/pages', startAt: 11, endAt: 22 };
    const first = featureRequest(
      'GET',
      `/liekan/websites/${site}/page-report`,
      params,
      controller.signal,
    ).catch(error => error);
    const second = featureRequest('GET', `/liekan/websites/${site}/page-report`, params);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    controller.abort();
    expect((await first).name).toBe('AbortError');
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await second).toEqual({ synthetic: 'shared' });
    expect(fetcher.mock.calls.filter(([, o]) => o?.method === 'DELETE')).toHaveLength(1);
    const views = fetcher.mock.calls.map(([, o]) => o.headers['X-Liekan-View']);
    expect(new Set(views).size).toBe(1);
    expect(views[0]).toBeTruthy();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
