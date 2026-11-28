vi.mock('@/lib/liekan/upstream/catalog-client', () => ({ clientCatalogVersion: vi.fn(async () => '96074773-f17b-46e9-9af5-b09bca5e4281') }));
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { featureApi } from '@/lib/liekan/upstream/features-client';
import { ManualRefreshProvider, useManualQuery } from '@/lib/liekan/contracts/manual-refresh';
import { ManualRefreshControl } from '../ManualRefreshControl';
import { FeatureProvider } from './context';
import { AnalyticsPages } from './AnalyticsPages';
import { CorePages } from './CorePages';

vi.mock('next/link', () => ({
  default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a>,
}));
vi.mock('./Chart', () => ({ Chart: () => <div /> }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const advance = (ms = 50) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

it.each(['websites', 'segments', 'cohorts'])(
  'reads %s statistics once after the refreshed source list arrives',
  async page => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const type = page === 'segments' ? 'segment' : 'cohort';
    const sources = (ids: string[]) =>
      ids.map(id => ({
        id,
        name: `资源${id}`,
        domain: `${id}.invalid`,
        userId: 'owner',
        parameters: { filters: [], action: { value: 'register' }, dateRange: '30day' },
      }));
    let definitions = 0;
    let finish!: (response: Response) => void;
    const records: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(page === 'websites' ? '/me/websites' : '/segments')) {
          if (++definitions === 1) return Response.json(sources(['a', 'b']));
          return new Promise<Response>(resolve => (finish = resolve));
        }
        records.push(url);
        return Response.json(
          page === 'websites'
            ? url.searchParams
                .get('ids')
                .split(',')
                .map(id => ({
                  id,
                  visitors: 7,
                  pageviews: 8,
                  aiVisits: 1,
                  received: true,
                  comparison: {},
                }))
            : { visitors: 7 },
        );
      }),
    );
    const value = {
      user: { id: 'owner', role: 'user' },
      siteId: page === 'websites' ? '' : 'site',
      site: { id: 'site', userId: 'owner' },
      sites: [],
      teams: [],
      route: { page },
      api: featureApi,
      query: {},
      filters: {},
      range: { startAt: 0, endAt: 1000, timezone: 'UTC', unit: 'day' },
      href: () => '/edit',
      navigate: vi.fn(),
      notify: vi.fn(),
    } as any;
    function Websites() {
      const sites = useManualQuery({
        queryKey: ['liekan-feature', 'owner', 'sites'],
        queryFn: ({ signal }) => featureApi.get('/me/websites', {}, signal),
      });
      return (
        <FeatureProvider
          value={{
            ...value,
            sites: sites.data || [],
            sitesReady: sites.isSuccess && !sites.isPlaceholderData,
          }}
        >
          <CorePages page="websites" />
        </FeatureProvider>
      );
    }
    try {
      render(
        <QueryClientProvider client={client}>
          <ManualRefreshProvider>
            <ManualRefreshControl />
            {page === 'websites' ? (
              <Websites />
            ) : (
              <FeatureProvider value={value}>
                <AnalyticsPages page={page} />
              </FeatureProvider>
            )}
          </ManualRefreshProvider>
        </QueryClientProvider>,
      );
      await advance(1);
      await advance();
      const dependent = () =>
        records.filter(url => page === 'websites' || url.searchParams.has(type));
      const initial = dependent();
      if (page === 'websites') {
        expect(initial.map(url => url.searchParams.get('ids')).sort()).toEqual(['a', 'a', 'b', 'b']);
        expect(new Set(initial.map(url => url.href)).size).toBe(4);
      } else {
        expect(initial).toHaveLength(2);
      }
      fireEvent.click(screen.getByRole('button', { name: '刷新' }));
      await advance(100);
      expect(definitions).toBe(2);
      expect(dependent()).toEqual(initial);
      await act(async () => finish(Response.json(sources(['c', 'a']))));
      await advance(1);
      await advance();
      const forced = dependent().filter(url => url.searchParams.get('refresh') === '1');
      if (page === 'websites') {
        expect(forced.map(url => url.searchParams.get('ids')).sort()).toEqual(['a', 'a', 'c', 'c']);
        expect(new Set(forced.map(url => url.href)).size).toBe(4);
        expect(dependent().slice(initial.length)).toEqual(forced);
      } else {
        expect(forced).toHaveLength(2);
        const ids = forced.flatMap(url => url.searchParams.get(type).split(','));
        expect(ids).not.toContain('b');
        expect(ids).toContain('a');
        expect(ids).toContain('c');
        expect(new Set(forced.map(url => url.href)).size).toBe(2);
      }
      expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled();
    } finally {
      client.clear();
    }
  },
);
