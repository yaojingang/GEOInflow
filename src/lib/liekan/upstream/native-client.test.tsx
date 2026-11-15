import { keepPreviousData, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBoardQuery } from '@/components/hooks/queries/useBoardQuery';
import { useEventStatsQuery } from '@/components/hooks/queries/useEventStatsQuery';
import { useRevenueMetricsQuery } from '@/components/hooks/queries/useRevenueMetricsQuery';
import { useRevenueStatsQuery } from '@/components/hooks/queries/useRevenueStatsQuery';
import { useTwoFactorStatusQuery } from '@/components/hooks/queries/useTwoFactorStatusQuery';
import { useTwoFactorUserStatusQuery } from '@/components/hooks/queries/useTwoFactorUserStatus';
import { useWebsiteExpandedMetricsQuery } from '@/components/hooks/queries/useWebsiteExpandedMetricsQuery';
import { useWebsiteMetricsQuery } from '@/components/hooks/queries/useWebsiteMetricsQuery';
import { useWebsiteQuery } from '@/components/hooks/queries/useWebsiteQuery';
import { useWebsiteStatsQuery } from '@/components/hooks/queries/useWebsiteStatsQuery';
import { useApi } from '@/components/hooks/useApi';
import { setShareData } from '@/store/app';
import { remainingFreshness } from './client-freshness';
import { featureApi } from './features-client';
import { nativeGet, nativeIdentityKey, useNativeQuery } from './native-client';
import { pageReportQuery } from './page-report-client';

const identity = vi.hoisted(() => ({ token: 'native-session-a' }));
const dates = vi.hoisted(() => ({ startAt: 100, endAt: 200, unit: 'day', timezone: 'UTC' }));
vi.mock('@/lib/client', () => ({
  getClientAuthToken: () => identity.token,
  removeClientAuthToken: vi.fn(),
  setClientAuthToken: vi.fn(),
}));
vi.mock('@/components/hooks/useDateParameters', () => ({
  useDateParameters: () => dates,
}));
vi.mock('@/components/hooks/useFilterParameters', () => ({
  useFilterParameters: () => ({ country: 'eq.CN' }),
}));

let client: QueryClient;
let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  visibility = 'visible';
  identity.token = 'native-session-a';
  dates.timezone = 'UTC';
  setShareData(null, null);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60000 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const wrapper = ({ children }: any) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const advance = (time: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(time);
  });
const response = (data: any = { pageviews: 7 }, ttl = 30000) =>
  Response.json(data, {
    headers: {
      'X-Liekan-Generated-At': String(Date.now()),
      'X-Liekan-Expires-At': String(Date.now() + ttl),
      'X-Liekan-Server-Time': String(Date.now()),
    },
  });

it.each([30000, 300000])(
  'keeps native statistics visible after its %s ms server deadline',
  async ttl => {
    const fetch = vi.fn(async (_url: string, _options: RequestInit) =>
      response({ pageviews: 7 }, ttl),
    );
    vi.stubGlobal('fetch', fetch);
    const q = renderHook(() => useWebsiteStatsQuery({ websiteId: 'site' }), { wrapper });
    await advance(1);
    expect(q.result.current.data.pageviews).toBe(7);
    const initial = new URL(fetch.mock.calls[0][0] as string, window.location.origin);
    expect(initial.pathname).toBe('/api/websites/site/stats');
    expect(initial.searchParams.get('country')).toBe('eq.CN');
    expect(initial.searchParams.get('endAt')).toBe('200');
    await advance(ttl + 600000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(q.result.current.data.pageviews).toBe(7);
  },
);

it('keeps selected event statistics visible without renewing the snapshot', async () => {
  const fetch = vi.fn(async () =>
    response({ data: { events: { value: 7 }, visitors: { value: 3 } } }),
  );
  vi.stubGlobal('fetch', fetch);
  const query = renderHook(() => useEventStatsQuery({ websiteId: 'site' }), { wrapper });
  await advance(1);
  const first = query.result.current.data;
  expect(first).toEqual({ events: { value: 7 }, visitors: { value: 3 } });
  await advance(600001);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(query.result.current.data).toEqual(first);
  expect(remainingFreshness(query.result.current.data, Date.now())).toBe(0);
});

it('does not read again after hidden statistics become visible', async () => {
  const fetch = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetch);
  renderHook(() => useWebsiteStatsQuery({ websiteId: 'site' }), { wrapper });
  await advance(1);
  visibility = 'hidden';
  fireEvent(document, new Event('visibilitychange'));
  await advance(35000);
  expect(fetch).toHaveBeenCalledTimes(1);
  visibility = 'visible';
  fireEvent(document, new Event('visibilitychange'));
  await advance(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('forces one native aggregate recomputation for overlapping manual refreshes', async () => {
  let finish!: (value: Response) => void;
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response())
    .mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
  vi.stubGlobal('fetch', fetch);
  const q = renderHook(() => useWebsiteStatsQuery({ websiteId: 'site' }), { wrapper });
  await advance(1);
  let first: Promise<any>, second: Promise<any>;
  act(() => {
    first = q.result.current.refetch();
    second = q.result.current.refetch();
  });
  await advance(1);
  expect(first).toBe(second);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(new URL(fetch.mock.calls[1][0], window.location.origin).searchParams.get('refresh')).toBe(
    '1',
  );
  finish(response({ pageviews: 8 }));
  await advance(1);
  expect(q.result.current.data.pageviews).toBe(8);
});

it('aborts the native transport when its last observer leaves', async () => {
  let signal: AbortSignal;
  const fetch = vi.fn(
    (_url: any, options: any) =>
      new Promise((_resolve, reject) => {
        signal = options.signal;
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const q = renderHook(() => useWebsiteStatsQuery({ websiteId: 'site' }), { wrapper });
  await advance(1);
  expect(signal.aborted).toBe(false);
  q.unmount();
  await advance(1);
  expect(signal.aborted).toBe(true);
});

it('preserves explicit headers, native parameter coercion and share credentials', async () => {
  const fetch = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetch);
  setShareData({ shareId: 'share' }, { token: 'share-proof' });
  const q = renderHook(() => useApi(), { wrapper });
  await q.result.current.get(
    '/websites/site/stats',
    { empty: '', omitted: undefined, array: ['a', 'b'] },
    { authorization: 'override', 'X-Custom': 'kept' },
  );
  const [url, options] = fetch.mock.calls[0] as any;
  const params = new URL(url, window.location.origin).searchParams;
  expect(params.get('array')).toBe('a,b');
  expect(params.get('empty')).toBe('');
  expect(params.has('omitted')).toBe(false);
  expect(options.headers.get('authorization')).toBe('override');
  expect(options.headers.get('x-custom')).toBe('kept');
  expect(options.headers.get('x-umami-share-token')).toBe('share-proof');
  expect(options.headers.get('x-umami-share-context')).toBe('1');
});

it('does not present data from the previous site or browser identity', async () => {
  const fetch = vi.fn(async (url: any) =>
    response({ pageviews: String(url).includes('/a/') ? 1 : 2 }),
  );
  vi.stubGlobal('fetch', fetch);
  const q = renderHook(
    ({ site }) =>
      useWebsiteStatsQuery({ websiteId: site }, { placeholderData: keepPreviousData } as any),
    { wrapper, initialProps: { site: 'a' } },
  );
  await advance(1);
  expect(q.result.current.data.pageviews).toBe(1);
  q.rerender({ site: 'b' });
  expect(q.result.current.data).toBeUndefined();
  await advance(1);
  expect(q.result.current.data.pageviews).toBe(2);
  identity.token = 'native-session-b';
  q.rerender({ site: 'b' });
  expect(q.result.current.data).toBeUndefined();
  await advance(1);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(nativeIdentityKey({ authorization: 'a' })).not.toBe(
    nativeIdentityKey({ authorization: 'b' }),
  );
});

it('preserves selected snapshots after explicit refresh fails and does not retry automatically', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response({ data: { value: 7 } }))
    .mockImplementation(async () =>
      Response.json(
        { error: { message: 'unavailable' } },
        { status: 503, headers: { 'Retry-After': '90' } },
      ),
    );
  vi.stubGlobal('fetch', fetch);
  const q = renderHook(
    () =>
      useNativeQuery({
        queryKey: ['websites:events:stats', { websiteId: 'site' }],
        queryFn: ({ signal }) => nativeGet('/websites/site/events/stats', {}, {}, signal),
        select: (data: any) => data.data,
      }),
    { wrapper },
  );
  await advance(1);
  expect(remainingFreshness(q.result.current.data, Date.now())).toBeGreaterThan(0);
  await act(async () => {
    await q.result.current.refetch();
  });
  await advance(1);
  expect(q.result.current.isError).toBe(true);
  expect(q.result.current.data).toEqual({ value: 7 });
  expect(fetch).toHaveBeenCalledTimes(2);
  await advance(600000);
  expect(q.result.current.data).toEqual({ value: 7 });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('keeps detail and configuration snapshots and reads again on reentry', async () => {
  const fetch = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetch);
  const details = renderHook(
    () =>
      useNativeQuery({
        queryKey: ['session', { websiteId: 'site', sessionId: 's' }],
        queryFn: ({ signal }) => nativeGet('/websites/site/sessions/s', {}, {}, signal),
        staleTime: Infinity,
      }),
    { wrapper },
  );
  const metadata = renderHook(
    () =>
      useNativeQuery({
        queryKey: ['website', { websiteId: 'site' }],
        queryFn: ({ signal }) => nativeGet('/websites/site', {}, {}, signal),
        staleTime: 300000,
      }),
    { wrapper },
  );
  await advance(1);
  const detailQuery = client.getQueryCache().find({ queryKey: ['session'], exact: false });
  const metadataQuery = client.getQueryCache().find({ queryKey: ['website'], exact: false });
  expect((detailQuery.options as any).staleTime).toBe(Infinity);
  expect((metadataQuery.options as any).staleTime).toBe(Infinity);
  details.unmount();
  await advance(1);
  expect(client.getQueryCache().find({ queryKey: ['session'], exact: false })).toBeDefined();
  metadata.unmount();
});

it('rechecks expired mounted cache using monotonic time after the wall clock moves back', async () => {
  const fetch = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetch);
  const first = renderHook(() => useWebsiteStatsQuery({ websiteId: 'site' }), { wrapper });
  await advance(1);
  first.unmount();
  await advance(35000);
  vi.setSystemTime(500000);
  renderHook(() => useWebsiteStatsQuery({ websiteId: 'site' }), { wrapper });
  await advance(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('rereads the shared Today card when mounting a cached long-range overview without polling', async () => {
  let requests = 20;
  const fetch = vi.fn(async () =>
    response({
      resource: 'overview',
      cards: [{ label: '今日总请求', value: requests }],
      meta: { todayRequests: { state: 'ready', intervalMs: 600000 } },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const options = pageReportQuery('principal', 'site', {
    resource: 'overview',
    startAt: 100,
    endAt: 200,
    timezone: 'UTC',
    chartPeriod: '30d',
  });
  await client.prefetchQuery(options);
  requests = 55;
  const q = renderHook(() => useApi().useQuery(options), { wrapper });
  await advance(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect((q.result.current.data as any).cards[0].value).toBe(55);
  await advance(600000);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('reuses a fresh product report and preserves explicit reads', async () => {
  const report = { websiteId: 'site', resource: 'content', total: 7 };
  const fetch = vi.fn(async (_url: URL | string) => response(report));
  vi.stubGlobal('fetch', fetch);
  const input = { resource: 'content' as const, startAt: 100, endAt: 200, timezone: 'UTC' };
  const prefetch = pageReportQuery('principal', 'site', input, undefined, undefined, 'prefetch');
  await client.prefetchQuery(prefetch);
  const options = pageReportQuery('principal', 'site', input);
  const q = renderHook(() => useApi().useQuery(options), { wrapper });
  await advance(1);
  expect(q.result.current.data).toEqual(report);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    client
      .getQueryCache()
      .getAll()
      .map(query => query.queryKey),
  ).toEqual([options.queryKey]);
  expect(client.getQueryData(options.queryKey)).toBe(q.result.current.data);
  // Product pages install their own lifecycle; this compatibility call keeps their policy intact.
  await advance(30000);
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    await q.result.current.refetch();
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  const url = new URL(String(fetch.mock.calls[1][0]), window.location.origin);
  expect(url.searchParams.has('refresh')).toBe(false);
});

it('bounds native and product reads together to six active browser transports', async () => {
  let active = 0;
  let peak = 0;
  const fetch = vi.fn(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return response();
  });
  vi.stubGlobal('fetch', fetch);
  const requests = Array.from({ length: 12 }, (_, index) => [
    nativeGet(`/websites/native-${index}/stats`),
    featureApi.get(`/liekan/websites/product-${index}/geo`),
  ]).flat();
  await advance(100);
  await Promise.all(requests);
  expect(fetch).toHaveBeenCalledTimes(24);
  expect(peak).toBe(6);
  expect(active).toBe(0);
});

it.each([
  ['board', useBoardQuery],
  ['website', useWebsiteQuery],
] as const)(
  'clears a previous private %s when its resource or browser identity changes',
  async (_label, useResource) => {
    let finish!: (value: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ name: 'private-a' }))
      .mockImplementation(
        (_url: string, options: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            finish = resolve;
            options.signal?.addEventListener('abort', () =>
              reject(new DOMException('cancelled', 'AbortError')),
            );
          }),
      );
    vi.stubGlobal('fetch', fetch);
    const q = renderHook(({ resource }) => useResource(resource), {
      wrapper,
      initialProps: { resource: 'a' },
    });
    await advance(1);
    expect(q.result.current.data).toEqual({ name: 'private-a' });
    q.rerender({ resource: 'b' });
    expect(q.result.current.data).toBeUndefined();
    expect(q.result.current.isPlaceholderData).toBe(false);
    await advance(1);
    finish(Response.json({ name: 'private-b' }));
    await advance(1);
    expect(q.result.current.data).toEqual({ name: 'private-b' });
    identity.token = 'native-session-b';
    q.rerender({ resource: 'b' });
    expect(q.result.current.data).toBeUndefined();
    expect(q.result.current.isPlaceholderData).toBe(false);
    await advance(1);
    finish(Response.json({ name: 'new-identity-b' }));
    await advance(1);
    expect(q.result.current.data).toEqual({ name: 'new-identity-b' });
  },
);

it('preserves configuration pagination placeholders within the same resource and identity', async () => {
  let finish!: (value: Response) => void;
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ rows: ['page-a'] }))
    .mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          finish = resolve;
        }),
    );
  vi.stubGlobal('fetch', fetch);
  const q = renderHook(
    ({ page }) =>
      useApi().useQuery({
        queryKey: ['boards', { teamId: 'team' }, page],
        queryFn: ({ signal }) => nativeGet('/teams/team/boards', { page }, {}, signal),
        placeholderData: keepPreviousData,
      }),
    { wrapper, initialProps: { page: 1 } },
  );
  await advance(1);
  q.rerender({ page: 2 });
  expect(q.result.current.data).toEqual({ rows: ['page-a'] });
  expect(q.result.current.isPlaceholderData).toBe(true);
  await advance(1);
  finish(Response.json({ rows: ['page-b'] }));
  await advance(1);
  expect(q.result.current.data).toEqual({ rows: ['page-b'] });
});

it("clears a joined observer's manual force and keeps its snapshot idle", async () => {
  const fetch = vi.fn(async (_url: string) => response());
  vi.stubGlobal('fetch', fetch);
  const first = renderHook(() => useWebsiteStatsQuery({ websiteId: 'site' }), { wrapper });
  const second = renderHook(() => useWebsiteStatsQuery({ websiteId: 'site' }), { wrapper });
  await advance(1);
  await act(async () => {
    await Promise.all([first.result.current.refetch(), second.result.current.refetch()]);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(new URL(fetch.mock.calls[1][0], window.location.origin).searchParams.get('refresh')).toBe(
    '1',
  );
  first.unmount();
  await advance(600000);
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => {
    await second.result.current.refetch();
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(new URL(fetch.mock.calls[2][0], window.location.origin).searchParams.get('refresh')).toBe(
    '1',
  );
});

it.each([
  ['current user', () => useTwoFactorStatusQuery(true)],
  ['managed user', () => useTwoFactorUserStatusQuery('user')],
] as const)('reads fresh 2FA state on every %s status mount', async (_label, useStatus) => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ isRequired: false }))
    .mockResolvedValueOnce(Response.json({ isRequired: true }));
  vi.stubGlobal('fetch', fetch);
  const first = renderHook(useStatus, { wrapper });
  await advance(1);
  expect(first.result.current.data.isRequired).toBe(false);
  first.unmount();
  await advance(1);
  const second = renderHook(useStatus, { wrapper });
  await advance(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(second.result.current.data.isRequired).toBe(true);
});

it('keeps public aggregate identity stable across proof rotation and separates scope changes', async () => {
  const scope = {
    shareId: 'public',
    shareType: 1,
    websiteId: 'site',
    parameters: { overview: true },
  };
  setShareData(scope, { token: 'proof-a' });
  const fetch = vi.fn(async (_url: string, _options: RequestInit) =>
    response({ pageviews: 7 }, 300000),
  );
  vi.stubGlobal('fetch', fetch);
  const q = renderHook(() => useWebsiteStatsQuery({ websiteId: 'site' }), { wrapper });
  await advance(1);
  act(() => setShareData({ ...scope, name: 'renamed' }, { token: 'proof-b' }));
  await advance(1);
  expect(q.result.current.data.pageviews).toBe(7);
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    await q.result.current.refetch();
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect((fetch.mock.calls[1][1].headers as Headers).get('x-umami-share-token')).toBe('proof-b');
  act(() =>
    setShareData({ ...scope, parameters: { overview: true, events: true } }, { token: 'proof-c' }),
  );
  expect(q.result.current.data).toBeUndefined();
  await advance(1);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect((fetch.mock.calls[2][1].headers as Headers).get('x-umami-share-token')).toBe('proof-c');
});

it('revalidates direct security state for a new observer after the wall clock moves back', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ isRequired: false }))
    .mockResolvedValueOnce(Response.json({ isRequired: true }));
  vi.stubGlobal('fetch', fetch);
  renderHook(() => useTwoFactorStatusQuery(true), { wrapper });
  await advance(1);
  vi.setSystemTime(500000);
  const second = renderHook(() => useTwoFactorStatusQuery(true), { wrapper });
  await advance(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(second.result.current.data.isRequired).toBe(true);
});

it.each([
  ['stats', () => useWebsiteStatsQuery({ websiteId: 'site' })],
  ['event stats', () => useEventStatsQuery({ websiteId: 'site' })],
  ['metrics', () => useWebsiteMetricsQuery('site', { type: 'url' })],
  ['expanded metrics', () => useWebsiteExpandedMetricsQuery('site', { type: 'url' })],
  ['revenue stats', () => useRevenueStatsQuery({ websiteId: 'site', currency: 'USD' })],
  ['revenue metrics', () => useRevenueMetricsQuery('site', { type: 'country', currency: 'USD' })],
] as const)(
  'includes the resolved timezone in native %s cache keys and requests',
  async (_label, useStatistics) => {
    dates.timezone = 'America/Los_Angeles';
    const fetch = vi.fn(async (_url: string) => response());
    vi.stubGlobal('fetch', fetch);
    const q = renderHook(() => useStatistics(), { wrapper });
    await advance(1);
    expect(
      new URL(fetch.mock.calls[0][0], window.location.origin).searchParams.get('timezone'),
    ).toBe('America/Los_Angeles');
    expect(client.getQueryCache().getAll()[0].queryKey[1]).toMatchObject({
      timezone: 'America/Los_Angeles',
    });
    dates.timezone = 'Asia/Shanghai';
    q.rerender();
    expect(q.result.current.data).toBeUndefined();
    await advance(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      new URL(fetch.mock.calls[1][0], window.location.origin).searchParams.get('timezone'),
    ).toBe('Asia/Shanghai');
  },
);

it('keeps ordinary statistics for ten minutes and loads only after manual refresh', async () => {
  const fetch = vi.fn(async (_url: string, _options: RequestInit) => response({ pageviews: 7 }));
  vi.stubGlobal('fetch', fetch);
  const q = renderHook(() => useWebsiteStatsQuery({ websiteId: 'site' }), { wrapper });
  await advance(1);
  expect(q.result.current.data.pageviews).toBe(7);
  await advance(600000);
  act(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await advance(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(q.result.current.data.pageviews).toBe(7);
  await act(async () => {
    await q.result.current.refetch();
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(
    new URL(fetch.mock.calls[1][0] as string, window.location.origin).searchParams.get('refresh'),
  ).toBe('1');
});
