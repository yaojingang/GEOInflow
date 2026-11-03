import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ManualRefreshProvider } from '@/lib/liekan/contracts/manual-refresh';
import { defaultStorageSettings } from '@/lib/liekan/contracts/storage-retention';
import { AnalyticsAccelerationPage } from './AnalyticsAccelerationPage';
import { FeatureProvider } from './context';

vi.mock('next/link', () => ({
  default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a>,
}));
vi.mock('@/lib/liekan/upstream/catalog-client', () => ({
  clientCatalogVersion: vi.fn(async () => 'fixture'),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const id = '11111111-1111-4111-8111-111111111111';
const detail = {
  websiteId: id,
  revision: 1,
  mode: 'live',
  captureFrom: '2026-10-01T00:00:00Z',
  expansion: { path: true, visit: true },
  capacity: { siteBytes: '1', siteLimit: 1024, globalBytes: '1', globalLimit: 2048 },
  builds: [],
  coverage: [],
};
function mount(get: any, post: any, options: { role?: string; websiteId?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const value = {
    user: { id: 'owner', role: options.role || 'user' },
    query: { websiteId: options.websiteId ?? id },
    api: { get, post },
    range: { timezone: 'UTC' },
    href: () => '/websites',
    navigate: vi.fn(),
  } as any;
  return render(
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <FeatureProvider value={value}>
          <AnalyticsAccelerationPage />
        </FeatureProvider>
      </ManualRefreshProvider>
    </QueryClientProvider>,
  );
}
const advance = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
it('registers ordinary reads and keeps the submitted message after the status refresh', async () => {
  vi.useFakeTimers();
  const get = vi.fn(async (path: string) =>
    path === '/liekan/analytics-acceleration'
      ? { websites: [{ id, name: 'Fixture' }], nextCursor: null }
      : detail,
  );
  const post = vi.fn(async () => ({}));
  mount(get, post);
  await advance();
  await advance();
  expect(screen.getByRole('button', { name: '开始构建' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '开始构建' }));
  await advance();
  await advance();
  expect(post).toHaveBeenCalledWith(
    `/liekan/websites/${id}/analytics-acceleration/build`,
    expect.objectContaining({ preset: 'common', expectedRevision: 1, timezone: 'UTC' }),
  );
  expect(screen.getByText('操作已提交，关闭页面后后台继续处理。')).toBeVisible();
  expect(
    get.mock.calls.filter(([path]) => path.endsWith('/analytics-acceleration')).length,
  ).toBeGreaterThanOrEqual(3);
});
it('shows a failed initial read as an error without fabricating a maintenance state', async () => {
  vi.useFakeTimers();
  const get = vi.fn(async (path: string) => {
    if (path === '/liekan/analytics-acceleration') return { websites: [], nextCursor: null };
    throw Object.assign(new Error('无权访问该站点'), { status: 403 });
  });
  mount(get, vi.fn());
  await advance();
  await advance();
  expect(screen.getByText('无权访问该站点')).toBeVisible();
  expect(screen.queryByRole('button', { name: '开始构建' })).toBeNull();
});

it('removes controls and retained status after a previously authorized action is rejected', async () => {
  vi.useFakeTimers();
  const get = vi.fn(async (path: string) =>
    path === '/liekan/analytics-acceleration'
      ? { websites: [{ id, name: 'Fixture' }], nextCursor: null }
      : detail,
  );
  const post = vi.fn(async () => {
    throw Object.assign(new Error('无权访问该站点'), { status: 403 });
  });
  mount(get, post);
  await advance();
  await advance();
  fireEvent.click(screen.getByRole('button', { name: '开始构建' }));
  await advance();
  await advance();
  expect(screen.getByText('无权访问该站点')).toBeVisible();
  expect(screen.queryByRole('button', { name: '开始构建' })).toBeNull();
  expect(screen.queryByRole('button', { name: '停用加速' })).toBeNull();
});

const instanceStorage = {
  scope: 'instance',
  websiteId: null,
  canManageQueues: true,
  capacity: null,
  policy: { ...defaultStorageSettings, revision: 1 },
  preview: { candidateCount: 0, protectedCount: 0, estimatedBytes: '0', completedJobs: 7 },
  runs: [],
};
const unsupported = () => Object.assign(new Error('统计加速当前支持 PostgreSQL'), { status: 501 });

it.each([id, ''])(
  'keeps administrator instance cleanup reachable when analytics are unsupported for website %s',
  async websiteId => {
    vi.useFakeTimers();
    const get = vi.fn(async (path: string) => {
      if (path === '/liekan/storage') return instanceStorage;
      throw unsupported();
    });
    mount(get, vi.fn(), { role: 'admin', websiteId });
    await advance();
    await advance();
    expect(screen.getByRole('heading', { name: '存储与清理' })).toBeVisible();
    expect(screen.getByLabelText('高频已完成任务保留期')).toBeVisible();
    expect(screen.queryByLabelText('无引用版本保留期')).toBeNull();
    expect(get.mock.calls.some(([path]) => path === '/liekan/storage')).toBe(true);
    expect(
      get.mock.calls.some(([path]) => path.endsWith('/storage') && path !== '/liekan/storage'),
    ).toBe(false);
  },
);

it.each([401, 403, 404])(
  'keeps cleanup controls hidden after an analytics authorization failure %s despite an unsupported list',
  async status => {
    vi.useFakeTimers();
    const get = vi.fn(async (path: string) => {
      if (path === '/liekan/analytics-acceleration') throw unsupported();
      throw Object.assign(new Error('资源权限已变化'), { status });
    });
    mount(get, vi.fn(), { role: 'admin' });
    await advance();
    await advance();
    expect(screen.getByText('资源权限已变化')).toBeVisible();
    expect(screen.queryByRole('heading', { name: '存储与清理' })).toBeNull();
    expect(get.mock.calls.some(([path]) => path === '/liekan/storage')).toBe(false);
  },
);

it('does not expose instance cleanup to a non-administrator when analytics are unsupported', async () => {
  vi.useFakeTimers();
  const get = vi.fn(async (_path: string) => {
    throw unsupported();
  });
  mount(get, vi.fn());
  await advance();
  await advance();
  expect(screen.getByText('统计加速当前支持 PostgreSQL')).toBeVisible();
  expect(screen.queryByRole('heading', { name: '存储与清理' })).toBeNull();
  expect(get.mock.calls.some(([path]) => path === '/liekan/storage')).toBe(false);
});

it('retires retained website maintenance controls when a running status poll becomes unsupported', async () => {
  vi.useFakeTimers();
  let unavailable = false;
  const get = vi.fn(async (path: string) => {
    if (path === '/liekan/analytics-acceleration')
      return { websites: [{ id, name: 'Fixture' }], nextCursor: null };
    if (path === '/liekan/storage') return instanceStorage;
    if (path.endsWith('/storage'))
      return { ...instanceStorage, scope: 'website', websiteId: id, canManageQueues: false };
    if (unavailable) throw unsupported();
    return {
      ...detail,
      builds: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          status: 'running',
          progress: 0,
          completedUnits: '0',
          totalUnits: '1',
          rangeStart: '2026-10-01T00:00:00Z',
          rangeEnd: '2026-10-02T00:00:00Z',
          updatedAt: '2026-10-02T00:00:00Z',
          revision: 1,
        },
      ],
    };
  });
  mount(get, vi.fn(), { role: 'admin' });
  await advance();
  await advance();
  expect(screen.getByRole('button', { name: '停用加速' })).toBeVisible();
  expect(screen.getByRole('button', { name: '开始构建' })).toBeVisible();
  expect(screen.getByLabelText('无引用版本保留期')).toBeVisible();
  unavailable = true;
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  await advance();
  expect(screen.getByText('统计加速当前支持 PostgreSQL')).toBeVisible();
  expect(screen.queryByRole('button', { name: '停用加速' })).toBeNull();
  expect(screen.queryByRole('button', { name: '开始构建' })).toBeNull();
  expect(screen.queryByLabelText('无引用版本保留期')).toBeNull();
  expect(screen.getByLabelText('高频已完成任务保留期')).toBeVisible();
  expect(get.mock.calls.some(([path]) => path === '/liekan/storage')).toBe(true);
});

it.each([id, ''])(
  'keeps legacy cleanup available after identifying the ClickHouse backend for website %s',
  async websiteId => {
    vi.useFakeTimers();
    let resolveList: (value: any) => void;
    const pending = new Promise(resolve => {
      resolveList = resolve;
    });
    const get = vi.fn(async (path: string) => {
      if (path === '/liekan/analytics-acceleration') return pending;
      if (path === '/liekan/storage') return instanceStorage;
      if (path.endsWith('/storage'))
        return { ...instanceStorage, scope: 'website', websiteId: id, canManageQueues: false };
      return { ...detail, supported: false, backend: 'clickhouse' };
    });
    mount(get, vi.fn(), { role: 'admin', websiteId });
    await advance();
    expect(get.mock.calls.some(([path]) => path.endsWith('/storage'))).toBe(false);
    resolveList({
      supported: false,
      backend: 'clickhouse',
      websites: [{ id, name: 'Fixture' }],
      nextCursor: null,
    });
    await advance();
    await advance();
    expect(screen.getByText('ClickHouse 已直接提供统计，无需构建旧汇总')).toBeVisible();
    expect(screen.queryByText('正在读取加速状态')).toBeNull();
    expect(screen.queryByRole('button', { name: '开始构建' })).toBeNull();
    expect(screen.getByRole('heading', { name: '存储与清理' })).toBeVisible();
    expect(
      screen.getByText(
        '清理 PostgreSQL 中无引用的旧统计副本和已完成任务，不删除 ClickHouse 明细。',
      ),
    ).toBeVisible();
    expect(get.mock.calls.some(([path]) => path.endsWith('/storage'))).toBe(true);
    expect(screen.queryByText('网站派生空间估算')).toBeNull();
    expect(screen.queryByLabelText('容量达到 80% 时提前回收')).toBeNull();
  },
);
