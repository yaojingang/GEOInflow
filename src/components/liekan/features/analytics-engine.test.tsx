import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ManualRefreshProvider } from '@/lib/liekan/contracts/manual-refresh';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';
import { AnalyticsEnginePage } from './AnalyticsEnginePage';
import { FeatureProvider } from './context';
import { canRenderFeatureRoute } from './FeatureApp';
import { featureHref, matchFeatureRoute } from './routes';

vi.mock('next/link', () => ({
  default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a>,
}));
afterEach(cleanup);
const status = {
  configured: true,
  supported: true,
  connection: 'http://analytics-clickhouse:8123/geoinflow_analytics',
  enabled: false,
  syncing: false,
  healthy: true,
  revision: 7,
  checkedAt: '2026-10-26T00:00:00Z',
  version: '26.8.34.13',
  workerAt: '2026-10-26T00:00:00Z',
  error: null,
  sites: [
    {
      websiteId: '11111111-1111-4111-8111-111111111111',
      name: '集成验收网站',
      completed: '24',
      pending: '0',
      failed: '0',
      rows: '1200',
      rangeStart: '2026-10-25T00:00:00Z',
      rangeEnd: '2026-10-26T00:00:00Z',
      lastPublishedAt: '2026-10-26T00:00:00Z',
      purgePending: false,
    },
  ],
};
function mount(get: any, post: any, isAdmin = true, locale: 'zh-CN' | 'en-US' = 'zh-CN') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanLocaleContext.Provider value={locale}>
          <FeatureProvider
            value={
              {
                user: { id: 'admin', isAdmin },
                api: { get, post },
                query: {},
                range: { timezone: 'UTC' },
              } as any
            }
          >
            <AnalyticsEnginePage />
          </FeatureProvider>
        </LiekanLocaleContext.Provider>
      </ManualRefreshProvider>
    </QueryClientProvider>,
  );
}
it('registers a renderable administrator route with no website context', () => {
  const route = matchFeatureRoute('/admin/analytics-engine', { websiteId: 'foreign' });
  expect(route).toEqual({ page: 'admin-analytics-engine', context: 'admin' });
  expect(canRenderFeatureRoute(route)).toBe(true);
  expect(featureHref('admin-analytics-engine', { websiteId: 'foreign' })).toBe(
    '/admin/analytics-engine',
  );
});
it('keeps ordinary users out of configuration and avoids sending a management read', async () => {
  const get = vi.fn();
  mount(get, vi.fn(), false);
  expect(screen.getByText('此操作需要系统管理员完整登录')).toBeVisible();
  expect(get).not.toHaveBeenCalled();
});
it.each(['zh-CN', 'en-US'] as const)(
  'shows coverage and sends a versioned action in %s',
  async locale => {
    const get = vi.fn(async () => status),
      post = vi.fn(async () => ({ ...status, enabled: true, revision: 8 }));
    mount(get, post, true, locale);
    const name = locale === 'zh-CN' ? '启用 ClickHouse 分析' : 'Enable ClickHouse analytics';
    const button = await screen.findByRole('button', { name });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/liekan/admin/analytics-engine',
        expect.objectContaining({ action: 'enable', expectedRevision: 7, locale }),
      ),
    );
    expect(await screen.findByText('PostgreSQL + ClickHouse')).toBeVisible();
    expect(screen.getByText('集成验收网站')).toBeVisible();
  },
);
it('clears retained administrator state after a permission rejection', async () => {
  const get = vi.fn(async () => status),
    post = vi.fn(async () => {
      throw Object.assign(new Error('权限已变更'), { status: 403 });
    });
  mount(get, post);
  const button = await screen.findByRole('button', { name: '启用 ClickHouse 分析' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByText('此操作需要系统管理员完整登录')).toBeVisible();
  expect(screen.queryByText('集成验收网站')).toBeNull();
});
it('keeps a successful action revision when an older status poll arrives afterward', async () => {
  let poll: () => void, release: (value: any) => void;
  const original = setInterval;
  const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
    callback: any,
    ms: number,
    ...args: any[]
  ) => {
    if (ms === 3000) {
      poll = () => callback(...args);
      return original(() => {}, 60000);
    }
    return original(callback, ms, ...args);
  }) as typeof setInterval);
  const get = vi
    .fn()
    .mockResolvedValueOnce({ ...status, syncing: true })
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
  const post = vi.fn(async () => ({ ...status, syncing: true, enabled: true, revision: 8 }));
  try {
    mount(get, post);
    const button = await screen.findByRole('button', { name: '启用 ClickHouse 分析' });
    await waitFor(() => expect(button).toBeEnabled());
    await act(async () => poll());
    fireEvent.click(button);
    expect(await screen.findByText('PostgreSQL + ClickHouse')).toBeVisible();
    await act(async () => release({ ...status, syncing: true, revision: 7 }));
    expect(screen.getByText('PostgreSQL + ClickHouse')).toBeVisible();
  } finally {
    timer.mockRestore();
  }
});
it('uses the global server readiness gate when the visible website page has no completed units', async () => {
  const page = {
    ...status,
    sites: [{ ...status.sites[0], completed: '0', pending: '24' }],
    nextCursor: status.sites[0].websiteId,
  };
  const post = vi.fn(async () => ({ ...page, enabled: true, revision: 8 }));
  mount(
    vi.fn(async () => page),
    post,
  );
  const button = await screen.findByRole('button', { name: '启用 ClickHouse 分析' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByText('PostgreSQL + ClickHouse')).toBeVisible();
});
