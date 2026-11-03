import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ManualAuthorizationBoundary,
  ManualRefreshProvider,
  useManualRefresh,
} from '@/lib/liekan/contracts/manual-refresh';
import {
  defaultStorageSettings,
  type StorageRun,
  type StorageState,
} from '@/lib/liekan/contracts/storage-retention';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';
import { FeatureProvider } from './context';
import { StorageRetentionPanel } from './StorageRetentionPanel';

vi.mock('next/link', () => ({
  default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a>,
}));
vi.mock('@/lib/liekan/upstream/catalog-client', () => ({
  clientCatalogVersion: vi.fn(async () => 'fixture'),
}));
const site = '11111111-1111-4111-8111-111111111111';
const otherSite = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
function run(overrides: Partial<StorageRun> = {}): StorageRun {
  return {
    id: runId,
    scope: 'website',
    websiteId: site,
    kind: 'manual',
    status: 'preview',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
    startedAt: null,
    completedAt: null,
    candidateCount: 4,
    protectedCount: 2,
    estimatedBytes: '2097152',
    rowsDeleted: '0',
    generationsDeleted: 0,
    jobsDeleted: 0,
    releasedBytes: '0',
    physicalBytesBefore: null,
    physicalBytesAfter: null,
    errorCode: null,
    ...overrides,
  };
}
function state(overrides: Partial<StorageState> = {}): StorageState {
  return {
    scope: 'website',
    websiteId: site,
    canManageQueues: false,
    policy: { ...defaultStorageSettings, revision: 1 },
    capacity: {
      siteBytes: '1048576',
      globalBytes: '2097152',
      siteLimit: 10485760,
      globalLimit: 20971520,
    },
    preview: { candidateCount: 4, protectedCount: 2, estimatedBytes: '2097152', completedJobs: 7 },
    runs: [],
    ...overrides,
  };
}
const advance = (time = 100) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(time);
  });
function Controls() {
  const reading = useManualRefresh();
  return <button onClick={() => reading.retirePage(reading.page.token)}>Retire page</button>;
}
function mount(
  get: any,
  post = vi.fn(),
  options: {
    websiteId?: string;
    role?: string;
    userId?: string;
    locale?: 'zh-CN' | 'en-US';
    authorized?: boolean;
    warehouseMode?: boolean;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (values = options) => (
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanLocaleContext.Provider value={values.locale || 'zh-CN'}>
          <FeatureProvider
            value={
              {
                user: { id: values.userId || 'owner', role: values.role || 'user' },
                api: { get, post },
                query: {},
                range: { timezone: 'UTC' },
              } as any
            }
          >
            <ManualAuthorizationBoundary authorized={values.authorized !== false}>
              <StorageRetentionPanel
                websiteId={values.websiteId}
                warehouseMode={values.warehouseMode}
              />
            </ManualAuthorizationBoundary>
            <Controls />
          </FeatureProvider>
        </LiekanLocaleContext.Provider>
      </ManualRefreshProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, rerenderScope: (values: typeof options) => view.rerender(tree(values)) };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('reads the website policy and validates drafts without using an unfinished time zone for dates', async () => {
  const get = vi.fn(async () =>
    state({
      runs: [
        run({ status: 'completed', physicalBytesBefore: '2097152', physicalBytesAfter: '1048576' }),
      ],
    }),
  );
  const post = vi.fn(async () => ({ ...defaultStorageSettings, revision: 2 }));
  mount(get, post, { websiteId: site });
  await advance();
  await advance();
  expect(screen.getByRole('heading', { name: '存储与清理' })).toBeVisible();
  expect(screen.getByText('1.0 MiB / 10.0 MiB')).toBeVisible();
  expect(screen.getByText('2.0 MiB → 1.0 MiB')).toBeVisible();
  expect(screen.queryByLabelText('清理范围')).toBeNull();
  fireEvent.change(screen.getByLabelText(/^清理时区/), { target: { value: 'Asia/' } });
  expect(screen.getByRole('button', { name: '保存清理策略' })).toBeDisabled();
  expect(screen.getByText('清理参数无效')).toBeVisible();
  expect(screen.getByText('已完成')).toBeVisible();
  fireEvent.change(screen.getByLabelText(/^清理时区/), { target: { value: 'UTC' } });
  fireEvent.change(screen.getByLabelText('无引用版本保留期'), { target: { value: '168' } });
  fireEvent.click(screen.getByRole('button', { name: '保存清理策略' }));
  await advance();
  expect(post).toHaveBeenCalledWith(
    `/liekan/websites/${site}/storage`,
    expect.objectContaining({
      action: 'policy',
      expectedRevision: 1,
      settings: expect.objectContaining({ timezone: 'UTC', generationHours: 168 }),
    }),
  );
});

it('requires a preview before confirmation and stops further batches through the same run', async () => {
  let latest = state();
  const get = vi.fn(async (_path: string, input?: any) => (input?.runId ? latest.runs[0] : latest));
  const post = vi.fn(async (_path: string, input: any) => {
    const value = run({
      status:
        input.action === 'confirm' ? 'queued' : input.action === 'stop' ? 'stopped' : 'preview',
    });
    latest = state({ runs: [value] });
    return value;
  });
  mount(get, post, { websiteId: site });
  await advance();
  await advance();
  expect(screen.queryByRole('button', { name: '确认清理' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
  await advance();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0][1]).toMatchObject({
    action: 'preview',
    generationHours: 24,
    completedHours: 24,
    wakeHours: 1,
  });
  expect(screen.getByText('候选记录：4，受保护版本：2，预计恢复额度：2.0 MiB。')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '确认清理' }));
  await advance();
  expect(post.mock.calls[1][1]).toMatchObject({ action: 'confirm', id: runId });
  expect(screen.queryByRole('button', { name: '确认清理' })).toBeNull();
  expect(screen.getByRole('button', { name: '预览清理' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '停止后续批次' }));
  await advance();
  await advance(10000);
  expect(post.mock.calls[2][1]).toMatchObject({ action: 'stop', id: runId });
  expect(screen.queryByRole('button', { name: '停止后续批次' })).toBeNull();
  expect(get.mock.calls.filter(([, input]) => input?.runId)).toHaveLength(0);
  expect(screen.getByText('已停止')).toBeVisible();
});

it('expires previews after fifteen minutes and clears them when settings change', async () => {
  const post = vi.fn(async () => run());
  mount(
    vi.fn(async () => state()),
    post,
    { websiteId: site },
  );
  await advance();
  await advance();
  fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
  await advance();
  await advance(15 * 60000);
  expect(screen.getByText('清理预览已过期，请重新预览')).toBeVisible();
  expect(screen.getByRole('button', { name: '确认清理' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '确认清理' }));
  expect(post).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('无引用版本保留期'), { target: { value: '6' } });
  expect(screen.queryByRole('button', { name: '确认清理' })).toBeNull();
});

it('limits instance scope to administrators and resets the policy and preview on scope changes', async () => {
  const get = vi.fn(async (path: string) =>
    path === '/liekan/storage'
      ? state({
          scope: 'instance',
          websiteId: null,
          capacity: null,
          canManageQueues: true,
          policy: { ...defaultStorageSettings, hour: 5, revision: 1 },
        })
      : state(),
  );
  const post = vi.fn(async () => run());
  const view = mount(get, post);
  await advance();
  expect(get).not.toHaveBeenCalled();
  view.rerenderScope({ role: 'admin', websiteId: site });
  await advance();
  await advance();
  fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
  await advance();
  fireEvent.change(screen.getByLabelText('清理范围'), { target: { value: 'instance' } });
  await advance();
  await advance();
  expect(get).toHaveBeenCalledWith('/liekan/storage', undefined, expect.any(AbortSignal));
  expect(screen.queryByRole('button', { name: '确认清理' })).toBeNull();
  expect(screen.getByLabelText('集中清理小时')).toHaveValue(5);
  expect(screen.getByLabelText('高频已完成任务保留期')).toBeVisible();
  expect(screen.queryByLabelText('无引用版本保留期')).toBeNull();
  post.mockResolvedValueOnce(
    run({ scope: 'instance', websiteId: null, candidateCount: 7, estimatedBytes: '0' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
  await advance();
  expect(post).toHaveBeenLastCalledWith(
    '/liekan/storage',
    expect.objectContaining({ action: 'preview' }),
  );
  expect(screen.getByText('候选记录 7 · 按完成流水数量计量')).toBeVisible();
  view.rerenderScope({ role: 'user', websiteId: site });
  await advance();
  await advance();
  expect(screen.queryByLabelText('清理范围')).toBeNull();
  expect(screen.getByLabelText('集中清理小时')).toHaveValue(3);
});

it('discards a late preview after switching websites and never refreshes the departed scope', async () => {
  let resolvePreview: (value: StorageRun) => void;
  const get = vi.fn(async (path: string) =>
    state({ websiteId: path.includes(otherSite) ? otherSite : site }),
  );
  const post = vi.fn(
    () =>
      new Promise<StorageRun>(resolve => {
        resolvePreview = resolve;
      }),
  );
  const view = mount(get, post, { websiteId: site });
  await advance();
  await advance();
  fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
  view.rerenderScope({ websiteId: otherSite });
  await advance();
  await advance();
  const reads = get.mock.calls.length;
  await act(async () => resolvePreview(run()));
  await advance();
  expect(screen.queryByRole('button', { name: '确认清理' })).toBeNull();
  expect(get).toHaveBeenCalledTimes(reads);
  expect(screen.getByRole('button', { name: '预览清理' })).toBeEnabled();
});

it('rejects a late run response after the website changes', async () => {
  let resolveRun: (value: StorageRun) => void;
  let signal: AbortSignal;
  const get = vi.fn(async (path: string, input?: any, requestSignal?: AbortSignal) => {
    if (input?.runId) {
      signal = requestSignal;
      return new Promise<StorageRun>(resolve => {
        resolveRun = resolve;
      });
    }
    return path.includes(otherSite)
      ? state({ websiteId: otherSite })
      : state({ runs: [run({ status: 'queued' })] });
  });
  const view = mount(get, vi.fn(), { websiteId: site });
  await advance();
  await advance();
  await advance(3000);
  view.rerenderScope({ websiteId: otherSite });
  await advance();
  await advance();
  expect(signal.aborted).toBe(true);
  const reads = get.mock.calls.length;
  await act(async () => resolveRun(run({ status: 'completed', generationsDeleted: 99 })));
  await advance(10000);
  expect(get).toHaveBeenCalledTimes(reads);
  expect(screen.queryByText('已完成')).toBeNull();
  expect(screen.queryByRole('button', { name: '停止后续批次' })).toBeNull();
});

it('clears policy drafts and late operations when the signed-in account changes', async () => {
  let resolvePreview: (value: StorageRun) => void;
  const get = vi.fn(async () => state());
  const post = vi.fn(
    () =>
      new Promise<StorageRun>(resolve => {
        resolvePreview = resolve;
      }),
  );
  const view = mount(get, post, { websiteId: site });
  await advance();
  await advance();
  fireEvent.change(screen.getByLabelText('无引用版本保留期'), { target: { value: '168' } });
  fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
  view.rerenderScope({ websiteId: site, userId: 'another-owner' });
  await advance();
  await advance();
  expect(screen.getByLabelText('无引用版本保留期')).toHaveValue('24');
  await act(async () => resolvePreview(run()));
  await advance();
  expect(screen.queryByRole('button', { name: '确认清理' })).toBeNull();
});

it('shows an initial authorization failure without retaining policy controls', async () => {
  mount(
    vi.fn(async () => {
      throw Object.assign(new Error('无权访问该站点'), { status: 403 });
    }),
    vi.fn(),
    { websiteId: site },
  );
  await advance();
  await advance();
  expect(screen.getByRole('alert')).toHaveTextContent('无权访问该站点');
  expect(screen.queryByRole('button', { name: '预览清理' })).toBeNull();
  expect(screen.getByRole('button', { name: '重新读取' })).toBeEnabled();
});

it('removes restricted state and recovers only after a successful explicit read', async () => {
  const get = vi.fn(async () => state());
  const post = vi.fn(async () => {
    throw Object.assign(new Error('无权访问该站点'), { status: 403 });
  });
  mount(get, post, { websiteId: site });
  await advance();
  await advance();
  fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
  await advance();
  expect(screen.getByRole('alert')).toHaveTextContent('无权访问该站点');
  expect(screen.queryByRole('button', { name: '保存清理策略' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
  await advance();
  await advance();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: '预览清理' })).toBeEnabled();
});

it('keeps controls blocked when a state read started before permission was rejected', async () => {
  let resolveRead: (value: StorageState) => void;
  let delayed = false;
  const get = vi.fn(async () =>
    delayed
      ? new Promise<StorageState>(resolve => {
          resolveRead = resolve;
        })
      : state(),
  );
  const post = vi.fn(async () => {
    throw Object.assign(new Error('无权访问该站点'), { status: 403 });
  });
  mount(get, post, { websiteId: site });
  await advance();
  await advance();
  delayed = true;
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
  fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
  await advance();
  await act(async () => resolveRead(state()));
  await advance();
  expect(screen.getByRole('alert')).toHaveTextContent('无权访问该站点');
  expect(screen.queryByRole('button', { name: '预览清理' })).toBeNull();
  delayed = false;
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
  await advance();
  expect(screen.getByRole('button', { name: '预览清理' })).toBeEnabled();
});

it('follows only a known active run and stops status reads as soon as it completes', async () => {
  let active = run({ status: 'queued' });
  const get = vi.fn(async (_path: string, input?: any) =>
    input?.runId ? active : state({ runs: [active] }),
  );
  mount(get, vi.fn(), { websiteId: site });
  await advance();
  await advance();
  active = run({ status: 'running', generationsDeleted: 1, releasedBytes: '1048576' });
  await advance(3000);
  expect(get).toHaveBeenLastCalledWith(
    `/liekan/websites/${site}/storage`,
    { runId },
    expect.any(AbortSignal),
  );
  expect(screen.getByText('已清理 1 个统计版本和 0 条任务流水，恢复额度 1.0 MiB。')).toBeVisible();
  active = run({ status: 'completed', generationsDeleted: 2, releasedBytes: '2097152' });
  await advance(3000);
  await advance();
  const reads = get.mock.calls.length;
  await advance(30000);
  expect(get).toHaveBeenCalledTimes(reads);
  expect(screen.getByText('已完成')).toBeVisible();
});

it('pauses polling while hidden or offline and retains the fifteen minute budget across status changes', async () => {
  let status: StorageRun['status'] = 'queued';
  const get = vi.fn(async (_path: string, input?: any) =>
    input?.runId ? run({ status }) : state({ runs: [run({ status })] }),
  );
  mount(get, vi.fn(), { websiteId: site });
  await advance();
  await advance();
  await advance(8 * 60000);
  const beforePause = get.mock.calls.length;
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  await advance(20 * 60000);
  expect(get).toHaveBeenCalledTimes(beforePause);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  fireEvent(document, new Event('visibilitychange'));
  fireEvent(window, new Event('offline'));
  await advance(20 * 60000);
  expect(get).toHaveBeenCalledTimes(beforePause);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  fireEvent(window, new Event('online'));
  status = 'running';
  await advance(7 * 60000 + 3000);
  expect(screen.getByRole('button', { name: '继续查看' })).toBeVisible();
  const pausedReads = get.mock.calls.length;
  await advance(60000);
  expect(get).toHaveBeenCalledTimes(pausedReads);
  fireEvent.click(screen.getByRole('button', { name: '继续查看' }));
  await advance(3000);
  expect(get.mock.calls.length).toBeGreaterThan(pausedReads);
});

it('drops late polling results and stops background reads when manual authorization is retired', async () => {
  let resolveRun: (value: StorageRun) => void;
  const get = vi.fn(async (_path: string, input?: any) =>
    input?.runId
      ? new Promise<StorageRun>(resolve => {
          resolveRun = resolve;
        })
      : state({ runs: [run({ status: 'queued' })] }),
  );
  mount(get, vi.fn(), { websiteId: site });
  await advance();
  await advance();
  await advance(3000);
  fireEvent.click(screen.getByRole('button', { name: 'Retire page' }));
  expect(screen.queryByRole('heading', { name: '存储与清理' })).toBeNull();
  const reads = get.mock.calls.length;
  await act(async () => resolveRun(run({ status: 'completed' })));
  await advance(30000);
  expect(get).toHaveBeenCalledTimes(reads);
});

it('honors the shared authorization boundary for controls and polling', async () => {
  const get = vi.fn(async () => state({ runs: [run({ status: 'running' })] }));
  const view = mount(get, vi.fn(), { websiteId: site });
  await advance();
  await advance();
  view.rerenderScope({ websiteId: site, authorized: false });
  expect(screen.queryByRole('button', { name: '停止后续批次' })).toBeNull();
  const reads = get.mock.calls.length;
  await advance(30000);
  expect(get).toHaveBeenCalledTimes(reads);
});

it.each(['budget', 'error'] as const)(
  'starts a new run with a fresh polling budget after the preceding run paused for %s',
  async pause => {
    const nextId = '44444444-4444-4444-8444-444444444444';
    let latest = state({ runs: [run({ status: 'running' })] });
    const get = vi.fn(async (_path: string, input?: { runId: string }) => {
      if (!input?.runId) return latest;
      if (input.runId === runId && pause === 'error')
        throw Object.assign(new Error('暂时无法读取'), { status: 503 });
      return latest.runs.find(value => value.id === input.runId);
    });
    const post = vi.fn(async (_path: string, input: any) => {
      const value =
        input.action === 'stop'
          ? run({ status: 'stopped' })
          : run({ id: nextId, status: input.action === 'confirm' ? 'queued' : 'preview' });
      latest = state({ runs: [value] });
      return value;
    });
    mount(get, post, { websiteId: site });
    await advance();
    await advance();
    await advance(pause === 'budget' ? 15 * 60000 + 3000 : 3000);
    expect(screen.getByRole('button', { name: '继续查看' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '停止后续批次' }));
    await advance();
    fireEvent.click(screen.getByRole('button', { name: '预览清理' }));
    await advance();
    fireEvent.click(screen.getByRole('button', { name: '确认清理' }));
    await advance();
    expect(screen.queryByRole('button', { name: '继续查看' })).toBeNull();
    latest = state({ runs: [run({ id: nextId, status: 'completed', generationsDeleted: 4 })] });
    await advance(3000);
    expect(get.mock.calls.some(([, input]) => input?.runId === nextId)).toBe(true);
    expect(screen.getByText('已完成')).toBeVisible();
    expect(screen.queryByRole('button', { name: '停止后续批次' })).toBeNull();
  },
);

it('renders the policy and explicit confirmation in English', async () => {
  mount(
    vi.fn(async () => state()),
    vi.fn(async () => run()),
    { websiteId: site, locale: 'en-US' },
  );
  await advance();
  await advance();
  expect(screen.getByRole('heading', { name: 'Storage and cleanup' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  await advance();
  expect(screen.getByRole('button', { name: 'Confirm cleanup' })).toBeEnabled();
  expect(
    screen.getByText(
      'Eligible records: 4. Protected versions: 2. Estimated quota recovery: 2.0 MiB.',
    ),
  ).toBeVisible();
  expect(screen.queryByText('存储与清理')).toBeNull();
});

it.each(['zh-CN', 'en-US'] as const)(
  'describes legacy PostgreSQL cleanup without a ClickHouse quota in %s',
  async locale => {
    const get = vi.fn(async () => state());
    mount(get, vi.fn(), { websiteId: site, warehouseMode: true, locale });
    await advance();
    await advance();
    expect(
      screen.getByText(
        locale === 'zh-CN'
          ? '清理 PostgreSQL 中无引用的旧统计副本和已完成任务，不删除 ClickHouse 明细。'
          : 'Clean up unreferenced legacy analytics copies and completed jobs in PostgreSQL. ClickHouse detail records are retained.',
      ),
    ).toBeVisible();
    expect(screen.queryByText('1.0 MiB / 10.0 MiB')).toBeNull();
    expect(screen.queryByLabelText('容量达到 80% 时提前回收')).toBeNull();
    expect(screen.queryByText('预计可回收额度')).toBeNull();
    expect(
      screen.getByText(locale === 'zh-CN' ? '预计可回收数据量' : 'Estimated reclaimable data'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: locale === 'zh-CN' ? '预览清理' : 'Preview cleanup' }),
    ).toBeEnabled();
  },
);
