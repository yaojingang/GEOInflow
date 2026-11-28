import { publishedReport } from '../contracts/report-status';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getClientAuthToken, removeClientAuthToken, setClientAuthToken } from '@/lib/client';
import { AUTH_TOKEN } from '@/lib/constants';
import { setLocale, setUser, useApp } from '@/store/app';
import { BrowserCacheProvider, BrowserSnapshotCache, pruneBrowserClient } from './cache-client';
import {
  aggregateRequestResources,
  browserCacheLimits,
  browserQueryPolicy,
  stableBusinessKey,
} from './cache-policy';
import {
  monotonicNow,
  remainingFreshness,
  rememberResponseFreshness,
  restoreClientFreshness,
  serializeClientFreshness,
} from './client-freshness';
import { geoWeightSnapshotKey, useGeoWeight } from './geo-weight-client';
import { ManualRefreshProvider, useManualQuery, useManualRefresh } from './manual-client';

vi.mock('next/navigation', () => ({
  usePathname: () => '/websites',
  useSearchParams: () => new URLSearchParams(),
}));

const website = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const instanceId = '33333333-3333-4333-8333-333333333333';
const resource = { type: 'website' as const, id: website };
const key = [
  'liekan',
  website,
  null,
  'overview',
  1000,
  2000,
  'UTC',
  '30d',
  '',
  '',
  1,
  '',
  'after',
  '{}',
  userId,
];
const serverTime = 1900000000000;
const caches: BrowserSnapshotCache[] = [];
const clients: QueryClient[] = [];
afterEach(() => {
  caches.forEach(cache => {
    cache.dispose();
  });
  clients.forEach(client => {
    client.clear();
  });
  caches.length = 0;
  clients.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture(existing = new Map<string, string>(), nativeReceiver = false) {
  let token = 'session-a';
  let strongVersion = 'strong-a';
  let dataRevision = 'data-a';
  let geoVersion = 'geo-a';
  let authorized = true;
  let installation = instanceId;
  let time = serverTime;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const storage = {
    getItem: vi.fn(async (name: string) => existing.get(name) || null),
    setItem: vi.fn(async (name: string, data: string) => {
      existing.set(name, data);
    }),
    removeItem: vi.fn(async (name: string) => {
      existing.delete(name);
    }),
    clear: vi.fn(async () => existing.clear()),
  };
  const request = vi.fn(async function (this: unknown, input: any) {
    if (nativeReceiver && this !== undefined && this !== globalThis)
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    const requested = JSON.parse(new URL(String(input)).searchParams.get('resources'));
    return new Response(
      JSON.stringify({
        userId,
        instanceId: installation,
        serverTime: time,
        resources: requested.map((value: any) =>
          authorized
            ? { ...value, authorized: true, strongVersion, dataRevision, geoVersion }
            : { ...value, authorized: false },
        ),
      }),
      { status: 200 },
    );
  });
  const cache = new BrowserSnapshotCache(client, storage, request as typeof fetch, () => token);
  caches.push(cache);
  return {
    client,
    cache,
    storage,
    request,
    existing,
    change: (value: {
      token?: string;
      strongVersion?: string;
      dataRevision?: string;
      geoVersion?: string;
      authorized?: boolean;
      instanceId?: string;
      serverTime?: number;
    }) => {
      token = value.token ?? token;
      strongVersion = value.strongVersion ?? strongVersion;
      dataRevision = value.dataRevision ?? dataRevision;
      geoVersion = value.geoVersion ?? geoVersion;
      authorized = value.authorized ?? authorized;
      installation = value.instanceId ?? installation;
      time = value.serverTime ?? time;
    },
  };
}
async function write(
  f: ReturnType<typeof fixture>,
  value: any = { visitors: 7 },
  input = key,
  visit = '1',
) {
  const prepared = await f.cache.prepare(input, {}, visit, 'zh-CN');
  f.client.setQueryDefaults(prepared.key, {
    meta: {
      browserCache: f.cache.envelope(prepared),
      manualClock: { scope: '/websites/test?', conditions: '|||UTC', now: 1899999999000 },
    },
  });
  rememberResponseFreshness(
    value,
    new Headers({
      'X-Liekan-Generated-At': String(serverTime),
      'X-Liekan-Expires-At': String(serverTime + 30000),
      'X-Liekan-Server-Time': String(serverTime),
    }),
    monotonicNow(),
    monotonicNow(),
    [resource],
  );
  f.client.setQueryData(prepared.key, value);
  await f.cache.save();
  return prepared;
}

it('persists aggregates when browser fetch rejects a foreign receiver', async () => {
  const f = fixture(new Map(), true);
  const prepared = await write(f);
  expect(f.request).toHaveBeenCalledTimes(2);
  const saved = JSON.parse([...f.existing.values()][0]);
  expect(saved.clientState.queries).toHaveLength(1);
  expect(saved.clientState.queries[0].queryKey).toEqual(prepared.key);
  expect(saved.clientState.queries[0].state.data).toEqual({ visitors: 7 });
});

it('restores only after current full-session and resource authorization, keeping the server deadline', async () => {
  const first = fixture();
  const prepared = await write(first);
  expect(first.existing.size).toBe(1);
  const saved = JSON.parse([...first.existing.values()][0]);
  expect(saved.clientState.mutations).toEqual([]);
  expect(saved.clientState.queries[0].meta.browserCache.freshness).toMatchObject({
    generatedAt: serverTime,
    expiresAt: serverTime + 30000,
  });
  const next = fixture(first.existing);
  next.change({ serverTime: serverTime + 20000 });
  const restored = await next.cache.prepare(key, {}, 'reopen', 'zh-CN');
  expect(restored.key).toEqual(prepared.key);
  expect(next.request).toHaveBeenCalledTimes(2);
  expect(next.client.getQueryData(restored.key)).toEqual({ visitors: 7 });
  expect(remainingFreshness(next.client.getQueryData(restored.key), 0)).toBeGreaterThan(9900);
  expect(remainingFreshness(next.client.getQueryData(restored.key), 0)).toBeLessThanOrEqual(10000);
});

it.each([false, 'changed'])(
  'blocks restored results for denied or changed strong boundaries: %s',
  async boundary => {
    const first = fixture();
    await write(first);
    const next = fixture(first.existing);
    next.change(boundary === false ? { authorized: false } : { strongVersion: 'strong-b' });
    if (boundary === false)
      await expect(next.cache.prepare(key, {}, 'reopen', 'zh-CN')).rejects.toMatchObject({
        status: 403,
      });
    else {
      const restored = await next.cache.prepare(key, {}, 'reopen', 'zh-CN');
      expect(next.client.getQueryData(restored.key)).toBeUndefined();
    }
    expect(
      next.client
        .getQueryCache()
        .getAll()
        .some(query => query.state.data),
    ).toBe(false);
  },
);

it('keeps append-only data revisions out of stable business identity', async () => {
  const f = fixture();
  const first = await write(f);
  f.change({ dataRevision: 'data-b' });
  expect((await f.cache.prepare(key, {}, '2', 'zh-CN')).key).toEqual(first.key);
});

it('separates API prefixes, installations, users and translated projections', async () => {
  const f = fixture();
  const first = await write(f);
  expect((await f.cache.prepare(key, {}, '2', 'en-US')).key).not.toEqual(first.key);
  const next = fixture(f.existing);
  next.change({ instanceId: '44444444-4444-4444-8444-444444444444' });
  const prepared = await next.cache.prepare(key, {}, '3', 'zh-CN');
  expect(next.client.getQueryData(prepared.key)).toBeUndefined();
  expect(prepared.key).not.toEqual(first.key);
  const before = process.env.apiUrl;
  process.env.apiUrl = '/private-api';
  try {
    const other = fixture(f.existing);
    const value = await other.cache.prepare(key, {}, '4', 'zh-CN');
    expect(value.key).not.toEqual(first.key);
    expect(other.client.getQueryData(value.key)).toBeUndefined();
  } finally {
    if (before === undefined) delete process.env.apiUrl;
    else process.env.apiUrl = before;
  }
});

it('retains an expired authorized result without renewing its freshness', async () => {
  const f = fixture();
  await write(f);
  const next = fixture(f.existing);
  next.change({ serverTime: serverTime + 60000 });
  const value = await next.cache.prepare(key, {}, '2', 'zh-CN');
  expect(next.client.getQueryData(value.key)).toEqual({ visitors: 7 });
  expect(remainingFreshness(next.client.getQueryData(value.key), Date.now())).toBe(0);
});

it('does not restore after seven days, failed authorization, corrupted storage or offline entry', async () => {
  const f = fixture();
  await write(f);
  const old = fixture(f.existing);
  old.change({ serverTime: serverTime + browserCacheLimits.maxAge + 1 });
  const value = await old.cache.prepare(key, {}, '2', 'zh-CN');
  expect(old.client.getQueryData(value.key)).toBeUndefined();
  const corrupt = fixture(new Map([...f.existing.keys()].map(name => [name, '{broken'])));
  const missing = await corrupt.cache.prepare(key, {}, '2', 'zh-CN');
  expect(corrupt.client.getQueryData(missing.key)).toBeUndefined();
  const denied = fixture(f.existing);
  denied.request.mockImplementation(async () => new Response('{}', { status: 401 }));
  await expect(denied.cache.prepare(key, {}, '2', 'zh-CN')).rejects.toMatchObject({ status: 401 });
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const offline = fixture(f.existing);
  await expect(offline.cache.prepare(key, {}, '2', 'zh-CN')).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(offline.storage.getItem).not.toHaveBeenCalled();
});

it('discards a late disk restore after logout before it can hydrate or write', async () => {
  const f = fixture();
  await write(f);
  const next = fixture(f.existing);
  let release: (value: string) => void;
  const saved = [...f.existing.values()][0];
  next.storage.getItem.mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  const restoring = next.cache.prepare(key, {}, '2', 'zh-CN');
  await vi.waitFor(() => expect(next.storage.getItem).toHaveBeenCalled());
  next.change({ token: 'session-b' });
  next.cache.invalidate(false);
  release(saved);
  await expect(restoring).rejects.toMatchObject({ name: 'AbortError' });
  await next.cache.save();
  expect(next.client.getQueryCache().getAll()).toEqual([]);
  expect(next.storage.clear).toHaveBeenCalledOnce();
  expect(next.storage.setItem).not.toHaveBeenCalled();
});

it('merges same-visit resource checks and batches larger lists at twenty', async () => {
  const f = fixture();
  const ids = Array.from(
    { length: 45 },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  );
  const requests = ids.map(id =>
    f.cache.prepare(['liekan-feature', userId, id, { startAt: 1, endAt: 2 }], {}, 'same', 'zh-CN'),
  );
  await Promise.all(requests);
  const batches = f.request.mock.calls.map(([url]) =>
    JSON.parse(new URL(String(url)).searchParams.get('resources')),
  );
  expect(batches.map(batch => batch.length)).toEqual([0, 20, 20, 5]);
  const before = f.request.mock.calls.length;
  await f.cache.prepare(
    ['liekan-feature', userId, ids[0], { startAt: 1, endAt: 2 }],
    {},
    'same',
    'zh-CN',
  );
  expect(f.request.mock.calls.length).toBe(before);
});

it.each([
  { apiKey: 'secret' },
  { password: 'secret' },
  { visitorId: 'private' },
  { sessionId: 'private' },
  { userAgent: 'private' },
])('excludes sensitive projections from persistence %j', async value => {
  const f = fixture();
  await write(f, value);
  const saved = [...f.existing.values()].map(value => JSON.parse(value));
  expect(saved.flatMap(value => value.clientState.queries)).toEqual([]);
});

it('does not persist a response without successful private aggregate request proof', async () => {
  const f = fixture();
  const prepared = await f.cache.prepare(key, {}, '1', 'zh-CN');
  f.client.setQueryDefaults(prepared.key, { meta: { browserCache: f.cache.envelope(prepared) } });
  f.client.setQueryData(prepared.key, { secret: 'configuration' });
  await f.cache.save();
  expect(JSON.parse([...f.existing.values()][0]).clientState.queries).toEqual([]);
});

it('removes only protocol suffix objects and preserves business refresh filters', () => {
  const business = ['test', { filter: { refresh: true }, refresh: 'business', startAt: 1 }];
  expect(stableBusinessKey([...business, { manualPage: 2, manualRound: 3 }])).toEqual([
    ...business,
    { manualPage: 2, manualRound: 3 },
  ]);
  expect(stableBusinessKey(['test', { refresh: 1 }])).toEqual(['test', { refresh: 1 }]);
  expect(
    stableBusinessKey([
      ...business,
      {
        cacheFormat: browserCacheLimits.format,
        cacheNamespace: 'namespace',
        cacheUser: userId,
        cacheScope: 'scope',
        cacheLocale: 'zh-CN',
      },
    ]),
  ).toEqual(business);
  expect(stableBusinessKey(['test', { nativeIdentity: 'business' }])).toEqual([
    'test',
    { nativeIdentity: 'business' },
  ]);
  expect(
    browserQueryPolicy(['liekan-public', userId, website, { startAt: 1, endAt: 2 }]),
  ).toBeNull();
  expect(
    browserQueryPolicy(['liekan-feature', userId, website, { startAt: 1, endAt: 2 }, 'api-keys']),
  ).toBeNull();
  expect(browserQueryPolicy([...key.slice(0, 3), 'logs', ...key.slice(4)])).toBeNull();
  expect(aggregateRequestResources(`/websites/${website}/stats`, { eventType: 3 })).toEqual([
    { type: 'link', id: website },
  ]);
});

it('bounds entry count, individual size, aggregate bytes and LRU order', () => {
  const envelope = {
    namespace: 'n',
    userId,
    resources: [{ ...resource, strongVersion: 's' }],
    freshness: { generatedAt: serverTime, expiresAt: serverTime + 30000, resources: [resource] },
    savedAt: serverTime,
    accessedAt: serverTime,
  };
  const query = (index: number, size = 10) => ({
    queryHash: String(index),
    queryKey: [index],
    state: { status: 'success', data: { text: 'x'.repeat(size) } },
    meta: {
      browserCache: { ...envelope, accessedAt: serverTime + index },
      manualPage: 2,
      manualRound: 4,
    },
  });
  const persisted = (queries: any[]) => ({
    timestamp: Date.now(),
    buster: browserCacheLimits.format,
    clientState: { mutations: [], queries },
  });
  const small = pruneBrowserClient(
    persisted(Array.from({ length: 205 }, (_, index) => query(index))) as any,
    serverTime,
  );
  expect(small.clientState.queries).toHaveLength(200);
  expect(small.clientState.queries[0].queryKey).toEqual([204]);
  expect(small.clientState.queries.at(-1).queryKey).toEqual([5]);
  expect(small.clientState.queries[0].meta.manualPage).toBeUndefined();
  expect(
    pruneBrowserClient(persisted([query(0, browserCacheLimits.resultBytes)]) as any, serverTime)
      .clientState.queries,
  ).toEqual([]);
  const large = pruneBrowserClient(
    persisted(Array.from({ length: 100 }, (_, index) => query(index, 150000))) as any,
    serverTime,
  );
  expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeLessThanOrEqual(
    browserCacheLimits.bytes,
  );
  expect(large.clientState.queries.length).toBeGreaterThan(1);
  expect(large.clientState.queries.length).toBeLessThan(100);
});

it('serializes day-long lifetimes and restores using server time under clock skew', () => {
  const data = {};
  rememberResponseFreshness(
    data,
    new Headers({
      'X-Liekan-Generated-At': String(serverTime),
      'X-Liekan-Expires-At': String(serverTime + 86400000),
      'X-Liekan-Server-Time': String(serverTime),
    }),
    monotonicNow(),
    monotonicNow(),
    [resource],
  );
  const proof = serializeClientFreshness(data);
  const restored = {};
  restoreClientFreshness(restored, proof, serverTime + 3600000);
  expect(remainingFreshness(restored, Date.now())).toBeGreaterThan(22 * 3600000);
  expect(remainingFreshness(restored, Date.now())).toBeLessThanOrEqual(23 * 3600000);
});

it('restores the fresh relative anchor and leaves expired anchors unresolved', async () => {
  const first = fixture();
  await write(first);
  const next = fixture(first.existing);
  expect(await next.cache.clock('/websites/test?', '|||UTC')).toBe(1899999999000);
  const expired = fixture(first.existing);
  expired.change({ serverTime: serverTime + 30001 });
  expect(await expired.cache.clock('/websites/test?', '|||UTC')).toBeUndefined();
});

it('keeps unopened authorized disk snapshots when another query is saved', async () => {
  const first = fixture();
  await write(first);
  const next = fixture(first.existing);
  const secondKey = [...key];
  secondKey[3] = 'content';
  await write(next, { visitors: 8 }, secondKey);
  expect(JSON.parse([...next.existing.values()][0]).clientState.queries).toHaveLength(2);
});

it('removes revoked disk rows and cancels an in-flight old strong scope', async () => {
  const f = fixture();
  const first = await write(f);
  let signal: AbortSignal;
  const request = f.client.fetchQuery({
    queryKey: first.key,
    meta: { browserCache: f.cache.envelope(first) },
    queryFn: context => {
      signal = context.signal;
      return new Promise(() => {});
    },
  });
  void request.catch(() => {});
  f.change({ strongVersion: 'strong-b' });
  const next = await f.cache.prepare(key, {}, 'next', 'zh-CN');
  expect(signal.aborted).toBe(true);
  expect(() => f.cache.assertCurrent(first)).toThrow(/retired/);
  expect(f.client.getQueryData(first.key)).toBeUndefined();
  expect(f.client.getQueryData(next.key)).toBeUndefined();
  expect(JSON.parse([...f.existing.values()][0]).clientState.queries).toEqual([]);
});

it('recognizes link/pixel list and detail aggregates with exact resource identities', () => {
  const common = [
    'liekan-feature',
    userId,
    '',
    null,
    null,
    null,
    website,
    { startAt: 1, endAt: 2 },
  ];
  expect(browserQueryPolicy([...common, 'links-list-stats', [website]]).resources).toEqual([
    { type: 'link', id: website },
  ]);
  expect(
    browserQueryPolicy([...common, 'resource-detail-stats', 'pixel', website]).resources,
  ).toEqual([{ type: 'pixel', id: website }]);
  expect(browserQueryPolicy([...common, 'link-joint-sources', website, 2]).resources).toEqual([
    { type: 'link', id: website },
  ]);
  const board = { type: 'board' as const, id: instanceId };
  expect(
    browserQueryPolicy(['liekan-feature', 'board-widget', userId, website, {}], {
      cacheAggregate: true,
      cacheResources: [board, { type: 'pixel', id: website }],
    }).resources,
  ).toEqual([board, { type: 'pixel', id: website }]);
  expect(
    browserQueryPolicy(['liekan-feature', 'board-widget', userId, website, {}], {
      cacheAggregate: false,
      cacheResources: [board],
    }),
  ).toBeNull();
});

it('keeps GEO scope stable through ordinary configuration changes and retires corrected GEO evidence', async () => {
  const f = fixture();
  const geoKey = [
    'liekan-feature',
    userId,
    'geo-weight-snapshot',
    website,
    { mode: 'current', timezone: 'UTC' },
    'summary',
    null,
  ];
  const metadata = { geoSnapshot: true, cacheAggregate: true, cacheResources: [resource] };
  const first = await f.cache.prepare(geoKey, metadata, '1', 'raw');
  f.change({ strongVersion: 'renamed-config', dataRevision: 'new-log' });
  expect((await f.cache.prepare(geoKey, metadata, '2', 'raw')).key).toEqual(first.key);
  f.change({ geoVersion: 'corrected-evidence' });
  expect((await f.cache.prepare(geoKey, metadata, '3', 'raw')).key).not.toEqual(first.key);
});

it('still performs the lightweight GEO state read after an authorized fresh browser restore', async () => {
  const f = fixture();
  const geoKey = geoWeightSnapshotKey(userId, website, undefined, 'UTC', 'summary');
  const metadata = { geoSnapshot: true, cacheAggregate: true, cacheResources: [resource] };
  const prepared = await f.cache.prepare(geoKey, metadata, 'seed', 'raw');
  const payload = {
    format: 'geo-snapshot-v1',
    taskStatus: 'ready',
    result: { current: { level: null, state: 'missing' } },
    snapshotId: instanceId,
    requestedAsOf: '2030-03-16',
    servedAsOf: '2030-03-16',
    stale: false,
    taskId: null,
    nextRetryAt: null,
    errorCode: null,
    canRecalculate: false,
    strongVersion: 'geo-a',
  };
  rememberResponseFreshness(
    payload,
    new Headers({
      'X-Liekan-Generated-At': String(serverTime),
      'X-Liekan-Expires-At': String(serverTime + 86400000),
      'X-Liekan-Server-Time': String(serverTime),
    }),
    monotonicNow(),
    monotonicNow(),
    [resource],
  );
  f.client.setQueryDefaults(prepared.key, {
    meta: { browserCache: f.cache.envelope(prepared), geoSnapshot: true },
  });
  f.client.setQueryData(prepared.key, payload);
  await f.cache.save();
  const restored = fixture(f.existing);
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any) => {
      if (String(input).includes('/cache-manifest')) return restored.request(input);
      reads++;
      return Response.json(
        { ...payload, stale: true },
        {
          headers: {
            'X-Liekan-Generated-At': String(serverTime),
            'X-Liekan-Expires-At': String(serverTime + 86400000),
            'X-Liekan-Server-Time': String(serverTime),
          },
        },
      );
    }),
  );
  setClientAuthToken('session-a');
  try {
    const hook = renderHook(() => useGeoWeight(userId, website, undefined, 'UTC', 'summary'), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={restored.client}>
          <BrowserCacheProvider storage={restored.storage}>{children}</BrowserCacheProvider>
        </QueryClientProvider>
      ),
    });
    await waitFor(() => expect(hook.result.current.data?.snapshotId).toBe(instanceId));
    await waitFor(() => expect(reads).toBe(1));
    await waitFor(() => expect(hook.result.current.data?.stale).toBe(true));
    expect(serializeClientFreshness(hook.result.current.data)).toBeDefined();
  } finally {
    cleanup();
    removeClientAuthToken();
    vi.unstubAllGlobals();
  }
});

it('rejects an older manifest before it can overwrite a newer strong scope', async () => {
  const f = fixture();
  await f.cache.prepare(key, {}, 'initialize', 'zh-CN');
  let release: (response: Response) => void;
  const load = f.request.getMockImplementation();
  f.request.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  const old = f.cache.prepare(key, {}, 'old-visit', 'zh-CN');
  void old.catch(() => {});
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  f.change({ strongVersion: 'strong-b' });
  f.request.mockImplementation(load);
  const current = await f.cache.prepare(key, {}, 'new-visit', 'zh-CN');
  f.client.setQueryDefaults(current.key, { meta: { browserCache: f.cache.envelope(current) } });
  f.client.setQueryData(current.key, { visitors: 12 });
  release(
    Response.json({
      userId,
      instanceId,
      serverTime,
      resources: [
        {
          ...resource,
          authorized: true,
          strongVersion: 'strong-a',
          dataRevision: 'old',
          geoVersion: 'geo-a',
        },
      ],
    }),
  );
  await expect(old).rejects.toMatchObject({ name: 'AbortError' });
  expect(() => f.cache.assertCurrent(current)).not.toThrow();
  expect(f.client.getQueryData(current.key)).toEqual({ visitors: 12 });
});

it('deducts manifest round trip and never rewinds the estimated server clock', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const respond = f.request.getMockImplementation();
  f.request.mockImplementation(async input => {
    await new Promise(resolve => setTimeout(resolve, 500));
    return respond(input);
  });
  const prepared = f.cache.prepare(key, {}, 'first', 'zh-CN');
  await vi.advanceTimersByTimeAsync(1000);
  await prepared;
  expect(f.cache.serverNow()).toBeGreaterThanOrEqual(serverTime + 1000);
  const before = f.cache.serverNow();
  f.change({ serverTime: serverTime - 10000 });
  const next = f.cache.prepare(key, {}, 'second', 'zh-CN');
  await vi.advanceTimersByTimeAsync(500);
  await next;
  expect(f.cache.serverNow()).toBeGreaterThanOrEqual(before + 500);
});

it('keeps a completed resource grant valid when another visit confirms the same strong boundary', async () => {
  const f = fixture();
  const first = await f.cache.prepare(key, {}, 'first-consumer', 'zh-CN');
  await f.cache.prepare(key, {}, 'second-consumer', 'zh-CN');
  expect(() => f.cache.assertCurrent(first)).not.toThrow();
  f.change({ strongVersion: 'changed' });
  await f.cache.prepare(key, {}, 'changed-consumer', 'zh-CN');
  expect(() => f.cache.assertCurrent(first)).toThrow(/retired/);
});

it('keeps a verified aggregate key while the same resource metadata temporarily disables reading', async () => {
  const { useManualQuery } = await import('./manual-client');
  const f = fixture();
  vi.stubGlobal('fetch', f.request);
  setClientAuthToken('session-a');
  try {
    const hook = renderHook(
      ({ enabled }) =>
        useManualQuery({ queryKey: key, queryFn: async () => ({ visitors: 7 }), enabled }),
      {
        initialProps: { enabled: true },
        wrapper: ({ children }) => (
          <QueryClientProvider client={f.client}>
            <BrowserCacheProvider storage={f.storage}>{children}</BrowserCacheProvider>
          </QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(hook.result.current.data).toEqual({ visitors: 7 }));
    const verified = (hook.result.current as any).resolvedQueryKey;
    hook.rerender({ enabled: false });
    expect((hook.result.current as any).resolvedQueryKey).toEqual(verified);
    hook.rerender({ enabled: true });
    await waitFor(() => expect((hook.result.current as any).resolvedQueryKey).toEqual(verified));
  } finally {
    cleanup();
    removeClientAuthToken();
    vi.unstubAllGlobals();
  }
});

it.each([false, true])(
  'preserves a declared raw statistics snapshot through language changes (locale invariant: %s)',
  async localeInvariant => {
    const f = fixture();
    const previousUser = useApp.getState().user;
    const previousLocale = useApp.getState().locale;
    const load = vi.fn(async () => {
      const value = { visitors: 7 };
      rememberResponseFreshness(
        value,
        new Headers({
          'X-Liekan-Generated-At': String(serverTime),
          'X-Liekan-Expires-At': String(serverTime + 30000),
          'X-Liekan-Server-Time': String(serverTime),
        }),
        monotonicNow(),
        monotonicNow(),
        [resource],
      );
      return value;
    });
    vi.stubGlobal('fetch', f.request);
    setClientAuthToken('locale-fixture-session');
    setUser({ id: userId });
    setLocale('en-US');
    try {
      const hook = renderHook(
        () =>
          useManualQuery({
            queryKey: key,
            queryFn: load,
            meta: { localeInvariant },
          }),
        {
          wrapper: ({ children }) => (
            <QueryClientProvider client={f.client}>
              <BrowserCacheProvider storage={f.storage}>
                <ManualRefreshProvider>{children}</ManualRefreshProvider>
              </BrowserCacheProvider>
            </QueryClientProvider>
          ),
        },
      );
      await waitFor(() => expect(hook.result.current.data?.visitors).toBe(7));
      expect(load).toHaveBeenCalledTimes(1);
      const before = (hook.result.current as any).resolvedQueryKey;
      await act(async () => {
        setLocale('zh-CN');
        await new Promise(resolve => setTimeout(resolve, 50));
      });
      await waitFor(() => expect(hook.result.current.data?.visitors).toBe(7));
      expect(load).toHaveBeenCalledTimes(localeInvariant ? 1 : 2);
      if (localeInvariant) expect((hook.result.current as any).resolvedQueryKey).toEqual(before);
      else expect((hook.result.current as any).resolvedQueryKey).not.toEqual(before);
    } finally {
      cleanup();
      removeClientAuthToken();
      setUser(previousUser);
      setLocale(previousLocale);
      vi.unstubAllGlobals();
    }
  },
);

it('keeps mounted drafts and pauses cross-tab credential changes until an explicit refresh', async () => {
  const f = fixture();
  const previousUser = useApp.getState().user;
  let mounts = 0;
  const load = vi.fn(async () => {
    const value = { identity: getClientAuthToken(), visitors: 7 };
    rememberResponseFreshness(
      value,
      new Headers({
        'X-Liekan-Generated-At': String(serverTime),
        'X-Liekan-Expires-At': String(serverTime + 30000),
        'X-Liekan-Server-Time': String(serverTime),
      }),
      monotonicNow(),
      monotonicNow(),
      [resource],
    );
    return value;
  });
  vi.stubGlobal('fetch', f.request);
  setClientAuthToken('session-a');
  setUser({ id: userId });
  try {
    const hook = renderHook(
      () => {
        const [draft, setDraft] = useState(() => {
          mounts++;
          return '';
        });
        return {
          draft,
          setDraft,
          reading: useManualRefresh(),
          query: useManualQuery({ queryKey: key, queryFn: load }),
        };
      },
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={f.client}>
            <BrowserCacheProvider storage={f.storage}>
              <ManualRefreshProvider>{children}</ManualRefreshProvider>
            </BrowserCacheProvider>
          </QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(hook.result.current.query.data?.identity).toBe('session-a'));
    await waitFor(() => expect(f.existing.size).toBe(1));
    const oldKey = (hook.result.current.query as any).resolvedQueryKey;
    act(() => hook.result.current.setDraft('unsaved report notes'));
    await act(async () => {
      localStorage.setItem(AUTH_TOKEN, JSON.stringify('session-b'));
      window.dispatchEvent(new StorageEvent('storage', { key: AUTH_TOKEN }));
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(hook.result.current.query.data).toBeUndefined();
    expect(hook.result.current.reading.authorized).toBe(false);
    expect(hook.result.current.draft).toBe('unsaved report notes');
    expect(mounts).toBe(1);
    expect(f.client.getQueryData(oldKey)).toBeUndefined();
    expect(f.storage.clear).toHaveBeenCalled();
    expect(f.existing.size).toBe(0);
    let pending: Promise<void>;
    act(() => {
      pending = hook.result.current.reading.refresh();
    });
    await waitFor(() => expect(hook.result.current.query.data?.identity).toBe('session-b'));
    await act(async () => pending);
    expect(load).toHaveBeenCalledTimes(2);
    expect(hook.result.current.draft).toBe('unsaved report notes');
    expect(mounts).toBe(1);
  } finally {
    cleanup();
    removeClientAuthToken();
    setUser(previousUser);
    vi.unstubAllGlobals();
  }
});

it('clears private projections on a same-user token replacement without remounting the page', async () => {
  const f = fixture();
  const previousUser = useApp.getState().user;
  let mounts = 0;
  const load = vi.fn(async () => ({ identity: getClientAuthToken(), visitors: 7 }));
  vi.stubGlobal('fetch', f.request);
  setClientAuthToken('session-a');
  setUser({ id: userId });
  try {
    const hook = renderHook(
      () => {
        const [draft, setDraft] = useState(() => {
          mounts++;
          return '';
        });
        return {
          draft,
          setDraft,
          query: useManualQuery({ queryKey: key, queryFn: load }),
        };
      },
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={f.client}>
            <BrowserCacheProvider storage={f.storage}>
              <ManualRefreshProvider>{children}</ManualRefreshProvider>
            </BrowserCacheProvider>
          </QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(hook.result.current.query.data?.identity).toBe('session-a'));
    const oldData = hook.result.current.query.data;
    act(() => hook.result.current.setDraft('retained after token renewal'));
    act(() => setClientAuthToken('session-b'));
    await waitFor(() => expect(hook.result.current.query.data?.identity).toBe('session-b'));
    expect(load).toHaveBeenCalledTimes(2);
    expect(f.storage.clear).toHaveBeenCalled();
    expect(
      f.client
        .getQueryCache()
        .getAll()
        .some(query => query.state.data === oldData),
    ).toBe(false);
    expect(hook.result.current.draft).toBe('retained after token renewal');
    expect(mounts).toBe(1);
  } finally {
    cleanup();
    removeClientAuthToken();
    setUser(previousUser);
    vi.unstubAllGlobals();
  }
});

it.each([false, true])(
  'revalidates a replaced cache controller before reading after an invalidation broadcast (delayed manifest: %s)',
  async delayed => {
    const f = fixture();
    const previousUser = useApp.getState().user;
    let blockManifest = false;
    let release: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const respond = f.request.getMockImplementation();
    f.request.mockImplementation(async input => {
      if (blockManifest) await gate;
      return respond(input);
    });
    const errors: string[] = [];
    const stop = f.client.getQueryCache().subscribe(event => {
      if (event.type === 'updated' && event.query.state.error)
        errors.push(event.query.state.error.name);
    });
    const load = vi.fn(async () => {
      const value = { identity: getClientAuthToken(), visitors: load.mock.calls.length };
      rememberResponseFreshness(
        value,
        new Headers({
          'X-Liekan-Generated-At': String(serverTime),
          'X-Liekan-Expires-At': String(serverTime + 30000),
          'X-Liekan-Server-Time': String(serverTime),
        }),
        monotonicNow(),
        monotonicNow(),
        [resource],
      );
      return value;
    });
    vi.stubGlobal('fetch', f.request);
    setClientAuthToken('same-session');
    setUser({ id: userId });
    try {
      const hook = renderHook(
        () => ({
          reading: useManualRefresh(),
          query: useManualQuery({ queryKey: key, queryFn: load }),
        }),
        {
          wrapper: ({ children }) => (
            <QueryClientProvider client={f.client}>
              <BrowserCacheProvider storage={f.storage}>
                <ManualRefreshProvider>{children}</ManualRefreshProvider>
              </BrowserCacheProvider>
            </QueryClientProvider>
          ),
        },
      );
      await waitFor(() => expect(hook.result.current.query.data?.visitors).toBe(1));
      await waitFor(() => expect(f.existing.size).toBe(1));
      const beforeRequests = f.request.mock.calls.length;
      const beforePage = hook.result.current.reading.page.token;
      const beforeRound = hook.result.current.reading.page.round;
      const oldData = hook.result.current.query.data;
      blockManifest = delayed;
      await act(async () => {
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: 'liekan-cache-invalidation-v1',
            newValue: 'same-user-cache-invalidation',
          }),
        );
        await new Promise(resolve => setTimeout(resolve, 50));
      });
      expect(hook.result.current.reading.page.token).toBe(beforePage);
      expect(hook.result.current.reading.page.round).toBe(beforeRound);
      await waitFor(() => expect(f.request.mock.calls.length).toBeGreaterThan(beforeRequests));
      expect(errors).not.toContain('AbortError');
      if (delayed) {
        expect(load).toHaveBeenCalledTimes(1);
        expect(hook.result.current.query.data).toBeUndefined();
        await act(async () => {
          blockManifest = false;
          release();
        });
      }
      await waitFor(() => expect(hook.result.current.query.data?.visitors).toBe(2));
      expect(load).toHaveBeenCalledTimes(2);
      expect(hook.result.current.query.isError).toBe(false);
      expect(errors).not.toContain('AbortError');
      expect(f.storage.clear).toHaveBeenCalled();
      expect(
        f.client
          .getQueryCache()
          .getAll()
          .some(query => query.state.data === oldData),
      ).toBe(false);
    } finally {
      release();
      stop();
      cleanup();
      removeClientAuthToken();
      setUser(previousUser);
      vi.unstubAllGlobals();
    }
  },
);

it('shows a 202 previous report on the authorized resolved key while the current task remains in flight', async () => {
  const { pageReportQuery } = await import('./page-report-client');
  const { featureApi } = await import('./features-client');
  const { chartIds } = await import('../contracts/report');
  const f = fixture();
  vi.stubGlobal('fetch', f.request);
  setClientAuthToken('session-a');
  setUser({ id: userId });
  const previous = {
    contractVersion: 2,
    resource: 'ai/overview',
    website: { id: website, name: 'Fixture', domain: 'fixture.invalid' },
    range: { startAt: 1000, endAt: 2000, timezone: 'UTC' },
    states: { human: 'empty', logs: 'available', catalog: 'empty', goals: 'empty' },
    cards: [{ key: 'requests', label: 'AI 蜘蛛请求', value: 17, state: 'available' }],
    charts: Object.fromEntries(chartIds.map(id => [id, { labels: [], series: [] }])),
    tables: {},
    insights: [],
    meta: {
      demo: false,
      canManage: false,
      latestImportAt: null,
      ruleCount: 0,
      generatedAt: serverTime - 10000,
      expiresAt: serverTime - 1,
    },
  };
  let finish!: (value: any) => void;
  const get = vi
    .spyOn(featureApi, 'get')
    .mockImplementation(async (_path, _params, _signal, options) => {
      options?.onPrevious?.(previous);
      return new Promise(resolve => {
        finish = resolve;
      });
    });
  const options = pageReportQuery(userId, website, {
    resource: 'ai/overview',
    startAt: 1000,
    endAt: 2000,
    timezone: 'UTC',
  });
  try {
    const hook = renderHook(() => useManualQuery(options), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={f.client}>
          <BrowserCacheProvider storage={f.storage}>
            <ManualRefreshProvider>{children}</ManualRefreshProvider>
          </BrowserCacheProvider>
        </QueryClientProvider>
      ),
    });
    await waitFor(() => expect(publishedReport(hook.result.current.data)?.cards[0].value).toBe(17));
    expect(hook.result.current.fetchStatus).toBe('fetching');
    const resolved = (hook.result.current as any).resolvedQueryKey;
    expect(resolved).not.toEqual(options.queryKey);
    expect(f.client.getQueryData(options.queryKey)).toBeUndefined();
    await act(async () => {
      finish({ ...previous, cards: [{ ...previous.cards[0], value: 18 }] });
    });
    await waitFor(() => expect(publishedReport(hook.result.current.data)?.cards[0].value).toBe(18));
  } finally {
    get.mockRestore();
    cleanup();
    removeClientAuthToken();
    vi.unstubAllGlobals();
  }
});
