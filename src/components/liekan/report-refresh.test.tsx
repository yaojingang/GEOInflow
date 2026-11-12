import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiekanPage } from './LiekanPage';
import { freshAggregateFixture } from '@/test/liekan-freshness';
import { ManualRefreshProvider } from '@/lib/liekan/contracts/manual-refresh';
import { setTestUrl } from '@/test/navigation';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';
import { featureDateRange } from '@/lib/liekan/contracts/analysis';

const state = vi.hoisted(() => ({
  get: vi.fn(),
  compare: false,
  date: '30day' as string | undefined,
  dateMode: undefined as string | undefined,
  invalidDate: false,
  push: vi.fn(),
  replace: vi.fn(),
  updateParams: vi.fn(),
  afterSaved: undefined as undefined | (() => Promise<void>),
  extraQuery: {} as Record<string, string>,
}));
vi.mock('next/link', () => ({
  useLinkStatus: () => ({ pending: false }),
  default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a>,
}));
vi.mock('./LiekanShell', () => ({ useLiekanShell: () => null }));
vi.mock('./chartRuntime', () => ({ loadEcharts: () => Promise.resolve({}) }));
vi.mock('./AnalysisLoading', async () => {
  const { useReportActions } = await import('./ReportContext');
  const { Overview } = await import('./pages/Overview');
  return {
    AnalysisLoading: () => {
      const actions = useReportActions();
      return (
        <>
          <span>pending</span>
          <button onClick={() => actions.onAction('目录导入')}>打开管理</button>
          <button onClick={() => actions.onAction('生成内容建议')}>生成内容建议</button>
        </>
      );
    },
    reportViews: {
      overview: Overview,
      'ai/overview': ({ report }: any) => <span>{report?.value}</span>,
      'ai/bots': ({ report }: any) => <span>{report?.value}</span>,
      'ai/pages': ({ report }: any) => <span>{report?.value}</span>,
      'ai/preference': ({ report }: any) => <span>{report?.value}</span>,
      'human/overview': ({ report }: any) => <span>{report?.value}</span>,
      'human/geo': ({ report }: any) => <span>{report?.value}</span>,
      logs: ({ report }: any) => <span>{report?.value}</span>,
      content: ({ report }: any) => {
        const actions = useReportActions();
        return (
          <>
            <span data-test="report-value">{report?.value || 'pending'}</span>
            <button onClick={() => actions.onAction('目录导入')}>打开管理</button>
            <button onClick={() => actions.onAction('生成内容建议')}>生成内容建议</button>
          </>
        );
      },
    },
  };
});
vi.mock('./ManagementDrawer', () => ({
  ManagementDrawer: ({ onSaved, comparison }: any) => {
    state.afterSaved = onSaved;
    return comparison ? (
      <span data-test="comparison-value">{comparison.previous?.value || 'unavailable'}</span>
    ) : (
      <button onClick={() => onSaved()}>完成写入</button>
    );
  },
}));
vi.mock('@/lib/liekan/upstream/features-client', () => ({
  getFeaturePreferences: () => ({ timezone: 'Asia/Shanghai' }),
  featureApi: {
    get: (...args: any[]) =>
      args[0].endsWith('/settings')
        ? Promise.resolve({ aiCrawlerEnabled: true })
        : state.get(...args),
  },
}));
vi.mock('@/lib/liekan/upstream/client', async () => {
  const { useManualQuery: useQuery } = await import('@/lib/liekan/contracts/manual-refresh');
  return {
    useApi: () => ({ useQuery }),
    useFeatureAppState: (select: any) => select({ user: { id: 'current-user' } }),
    useWebsite: () => ({ id: 'site-a', name: '当前网站' }),
    useFeatureDateRange: () => ({
      dateRange: { startDate: new Date('2026-09-01'), endDate: new Date('2026-10-01') },
      invalidDate: state.invalidDate,
    }),
    useNavigation: () => ({
      pathname: '/websites/site-a/geo/content',
      websiteId: 'site-a',
      query: {
        date: state.date,
        dateMode: state.dateMode,
        ...(state.compare ? { compareWeek: '1' } : {}),
        ...state.extraQuery,
      },
      router: { push: state.push, replace: state.replace },
      updateParams: state.updateParams,
    }),
  };
});
function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}
const report = (value: string, range?: { startAt: number; endAt: number; timezone: string }) =>
  freshAggregateFixture({
    value,
    range:
      range ??
      featureDateRange(
        {
          startDate: new Date('2026-09-01'),
          endDate: new Date('2026-10-01'),
        },
        'Asia/Shanghai',
      ),
    website: { id: 'site-a' },
    tables: {},
    states: {},
    cards: [],
    meta: { canManage: true, demo: false },
  });
let client: QueryClient;
beforeEach(() => {
  // offline 用例会向 window 派发 offline 事件；onlineManager 是全局的，必须在每个用例前复位。
  onlineManager.setOnline(true);
  state.get.mockReset();
  state.compare = false;
  state.extraQuery = {};
  state.date = '30day';
  state.dateMode = undefined;
  state.invalidDate = false;
  state.updateParams.mockReset().mockReturnValue('/next-range');
  state.push.mockReset();
  state.replace.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => client.clear());

it('keeps the overview visible while the TOP table reads its next page', async () => {
  const first = report('first');
  const cutoff = first.range.endAt - 3600000;
  const snapshot = (page: number, path: string) =>
    freshAggregateFixture({
      ...first,
      range: { ...first.range, endAt: cutoff },
      cards: [{ key: 'requests', label: '今日总请求', value: 8737, state: 'available' }],
      charts: {},
      insights: [],
      tables: { topBody: [{ path, humanPv: 3 }] },
      meta: {
        ...first.meta,
        generatedAt: cutoff,
        snapshot: { dataThrough: cutoff, state: 'ready', intervalMs: 1800000 },
        tablePages: { topBody: { page, pageSize: 20, total: 41 } },
      },
    });
  const pending = deferred<ReturnType<typeof snapshot>>();
  state.get.mockImplementation((_path, params) =>
    params.tp_topBody === 2 ? pending.promise : Promise.resolve(snapshot(1, '/first-ranking')),
  );
  setTestUrl('/websites/site-a/geo?date=30day');
  state.updateParams.mockReturnValue('/websites/site-a/geo?date=30day&tp_topBody=2');
  const tree = () => (
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanPage resource="overview" />
      </ManualRefreshProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  await screen.findByText('/first-ranking');
  const metrics = screen.getByText('8,737');
  const trend = screen.getByText('AI 蜘蛛与浏览访问趋势');
  const chart = document.querySelector('#d1');
  expect(chart).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  const historyPage = new URLSearchParams(window.location.search).get('tp_topBody');
  state.extraQuery = { tp_topBody: '2' };
  setTestUrl('/websites/site-a/geo?date=30day&tp_topBody=2');
  view.rerender(tree());
  await waitFor(() =>
    expect(state.get.mock.calls.some(([, params]) => params.tp_topBody === 2)).toBe(true),
  );
  expect(screen.getByText('8,737')).toBe(metrics);
  expect(screen.getByText('AI 蜘蛛与浏览访问趋势')).toBe(trend);
  expect(document.querySelector('#d1')).toBe(chart);
  expect(chart).not.toHaveAttribute('aria-busy');
  expect(document.querySelector('#topBody')).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  expect(historyPage).toBe('2');
  expect(state.push).not.toHaveBeenCalled();

  await act(async () => pending.resolve(snapshot(2, '/second-ranking')));
  expect(await screen.findByText('/second-ranking')).toBeVisible();
  expect(screen.getByText('8,737')).toBe(metrics);
  expect(screen.getByText('AI 蜘蛛与浏览访问趋势')).toBe(trend);
  expect(document.querySelector('#topBody')).not.toHaveAttribute('aria-busy');

  state.updateParams.mockReturnValue('/websites/site-a/geo?date=30day');
  fireEvent.click(screen.getByRole('button', { name: '上一页' }));
  expect(new URLSearchParams(window.location.search).get('tp_topBody')).toBeNull();
  state.extraQuery = {};
  setTestUrl('/websites/site-a/geo?date=30day');
  view.rerender(tree());
  expect(screen.getByText('/first-ranking')).toBeVisible();
  expect(
    state.get.mock.calls
      .filter(([path]) => path.endsWith('/page-report'))
      .map(([, params]) => params.tp_topBody),
  ).toEqual([undefined, 2]);
});

it.each([
  [
    'zh-CN',
    '日期参数无效，当前使用默认日期范围。',
    '重置日期',
    '已清除当前页面不支持的筛选，统计采用页面显示的条件。',
  ],
  [
    'en-US',
    'Invalid date parameters. The default date range is in use.',
    'Reset dates',
    'Unsupported filters have been cleared. Analytics use the conditions shown on this page.',
  ],
] as const)(
  'retains GEO range recovery and cleared-filter notices in %s',
  async (locale, warning, reset, notice) => {
    state.invalidDate = true;
    state.extraQuery = { tp_cityBody: '2', clearedFilters: '1' };
    state.get.mockResolvedValue(report('geography'));
    render(
      <LiekanLocaleContext.Provider value={locale}>
        <QueryClientProvider client={client}>
          <LiekanPage resource="human/geo" />
        </QueryClientProvider>
      </LiekanLocaleContext.Provider>,
    );
    expect(await screen.findByText(warning)).toBeVisible();
    expect(screen.getByText(notice)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: reset }));
    expect(state.updateParams).toHaveBeenCalledWith({
      tp_cityBody: undefined,
      date: '0day',
      unit: undefined,
      offset: undefined,
      dateMode: undefined,
      live: undefined,
      page: undefined,
      cursor: undefined,
      seek: undefined,
    });
    expect(state.replace).toHaveBeenCalledWith('/next-range', { scroll: false });
  },
);

it.each(['ai/overview', 'ai/bots', 'ai/pages', 'ai/preference'] as const)(
  'reuses the current-day crawler aggregate when reentering %s later',
  async resource => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T05:00:00Z'));
    state.dateMode = 'default';
    state.get.mockImplementation((_path, { startAt, endAt, timezone }) =>
      Promise.resolve(report('crawler-aggregate', { startAt, endAt, timezone })),
    );
    const tree = () => (
      <QueryClientProvider client={client}>
        <ManualRefreshProvider>
          <LiekanPage resource={resource} />
        </ManualRefreshProvider>
      </QueryClientProvider>
    );
    try {
      const first = render(tree());
      await waitFor(() =>
        expect(state.get.mock.calls.filter(call => call[1]?.resource === resource)).toHaveLength(1),
      );
      await waitFor(() => expect(client.isFetching()).toBe(0));
      first.unmount();
      vi.setSystemTime(new Date('2026-10-23T05:00:01Z'));
      render(tree());
      await waitFor(() => expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled());
      expect(state.get.mock.calls.filter(call => call[1]?.resource === resource)).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: '刷新' }));
      await waitFor(() =>
        expect(state.get.mock.calls.filter(call => call[1]?.resource === resource)).toHaveLength(2),
      );
    } finally {
      vi.useRealTimers();
    }
  },
);

it('resets a rolling log cursor before reading the refreshed window and fetches only the first batch', async () => {
  state.dateMode = 'default';
  state.extraQuery = { live: '1', page: '3', cursor: 'old-log-cursor', seek: 'after' };
  setTestUrl(
    '/websites/site-a/geo/logs?dateMode=default&live=1&page=3&cursor=old-log-cursor&seek=after',
  );
  state.get.mockResolvedValue(report('loaded-log-batch'));
  const tree = () => (
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanPage resource="logs" />
      </ManualRefreshProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  await screen.findByText('loaded-log-batch');
  const initial = state.get.mock.calls.filter(call => call[1]?.resource === 'logs');
  expect(initial).toHaveLength(1);
  expect(initial[0][1]).toMatchObject({ page: 3, cursor: 'old-log-cursor', seek: 'after' });
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() =>
    expect(state.get.mock.calls.filter(call => call[1]?.resource === 'logs')).toHaveLength(2),
  );
  const refreshed = state.get.mock.calls.filter(call => call[1]?.resource === 'logs')[1][1];
  expect(refreshed.page).toBe(1);
  expect(refreshed.cursor).toBeFalsy();
  expect(refreshed.seek).toBeFalsy();
  expect(refreshed.endAt).toBeGreaterThanOrEqual(initial[0][1].endAt);
  expect(refreshed.startAt).toBe(refreshed.endAt - 30 * 86400000);
  expect(state.updateParams).toHaveBeenCalledWith(
    expect.objectContaining({ page: undefined, cursor: undefined, seek: undefined }),
  );
  state.extraQuery = { live: '1' };
  setTestUrl('/websites/site-a/geo/logs?dateMode=default&live=1');
  view.rerender(tree());
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled());
  expect(state.get.mock.calls.filter(call => call[1]?.resource === 'logs')).toHaveLength(2);
  state.extraQuery = { live: '1', page: '2', cursor: 'old-log-cursor', seek: 'after' };
  setTestUrl(
    '/websites/site-a/geo/logs?dateMode=default&live=1&page=2&cursor=old-log-cursor&seek=after',
  );
  view.rerender(tree());
  await waitFor(() =>
    expect(state.get.mock.calls.filter(call => call[1]?.resource === 'logs')).toHaveLength(3),
  );
  expect(state.get.mock.calls.filter(call => call[1]?.resource === 'logs')[2][1]).toMatchObject({
    page: 2,
    cursor: 'old-log-cursor',
    seek: 'after',
  });
});
describe('GEO refresh after a successful write', () => {
  it.each([false, true])(
    'replaces an old in-flight read with fresh data (cached=%s)',
    async cached => {
      const oldRead = deferred<any>();
      const latestRead = deferred<any>();
      const signals: AbortSignal[] = [];
      state.get.mockImplementation((_path, _params, signal) => {
        signals.push(signal);
        if (cached && signals.length === 1) return Promise.resolve(report('initial'));
        return signals.length === (cached ? 2 : 1) ? oldRead.promise : latestRead.promise;
      });
      render(
        <QueryClientProvider client={client}>
          <LiekanPage resource="content" />
        </QueryClientProvider>,
      );
      if (cached) {
        await screen.findByText('initial');
        act(() => {
          void client.refetchQueries({ queryKey: ['liekan', 'site-a'] });
        });
      }
      await waitFor(() => expect(state.get).toHaveBeenCalledTimes(cached ? 2 : 1));
      fireEvent.click(screen.getByRole('button', { name: '打开管理' }));
      fireEvent.click(screen.getByRole('button', { name: '完成写入' }));
      await waitFor(() => expect(state.get).toHaveBeenCalledTimes(cached ? 3 : 2));
      expect(signals[cached ? 1 : 0].aborted).toBe(true);
      expect(state.get.mock.calls.at(-1)[1]).toMatchObject({ refresh: '1' });
      await act(async () => latestRead.resolve(report('after-write')));
      await screen.findByText('after-write');
      await act(async () => oldRead.resolve(report('before-write')));
      expect(screen.getByTestId('report-value')).toHaveTextContent('after-write');
      expect(
        client.getQueryCache().find({ queryKey: ['liekan', 'site-a'], exact: false })?.state.data,
      ).toMatchObject({ value: 'after-write' });
    },
  );
});

it.each([401, 403, 404, 503])(
  'masks cached comparison values only for hard read errors (%s)',
  async status => {
    state.compare = true;
    let revoked = false;
    let currentStart: number;
    state.get.mockImplementation((_path, params) => {
      currentStart ??= params.startAt;
      if (params.startAt === currentStart) return Promise.resolve(report('current'));
      if (revoked)
        return Promise.reject(Object.assign(new Error('comparison read failed'), { status }));
      return Promise.resolve(report('previous'));
    });
    render(
      <QueryClientProvider client={client}>
        <LiekanPage resource="human/overview" />
      </QueryClientProvider>,
    );
    await screen.findByText('previous');
    revoked = true;
    await act(async () => {
      await client.refetchQueries({ queryKey: ['liekan', 'site-a'] });
    });
    await waitFor(() => {
      expect(
        client
          .getQueryCache()
          .getAll()
          .some(query => (query.state.error as any)?.status === status),
      ).toBe(true);
      expect(screen.getByTestId('comparison-value')).toHaveTextContent(
        status === 503 ? 'previous' : 'unavailable',
      );
    });
  },
);

it.each(['feature', 'report'])(
  'keeps an unrelated active %s read intact when an earlier save finishes',
  async kind => {
    state.get.mockResolvedValue(report('initial'));
    const view = render(
      <QueryClientProvider client={client}>
        <LiekanPage resource="content" />
      </QueryClientProvider>,
    );
    await screen.findByText('initial');
    fireEvent.click(screen.getByRole('button', { name: '打开管理' }));
    const afterSaved = state.afterSaved!;
    const pending = deferred<string>();
    const signals: AbortSignal[] = [];
    function NextPage() {
      const next = useQuery({
        queryKey:
          kind === 'feature'
            ? ['liekan-feature', 'current-user', 'site-b', 'next-page']
            : [
                'liekan',
                'site-a',
                undefined,
                'ai/pages',
                1,
                2,
                'UTC',
                '30d',
                '',
                '',
                1,
                '',
                '',
                'current-user',
              ],
        queryFn: ({ signal }) => {
          signals.push(signal);
          return signals.length === 1 ? pending.promise : Promise.resolve('next-page-ready');
        },
      });
      return <span>{next.data || 'next-page-pending'}</span>;
    }
    view.rerender(
      <QueryClientProvider client={client}>
        <NextPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(signals).toHaveLength(1));
    await act(async () => {
      await afterSaved();
    });
    expect(screen.getByText('next-page-pending')).toBeInTheDocument();
    expect(signals[0].aborted).toBe(false);
    expect(signals).toHaveLength(1);
    expect(state.get).toHaveBeenCalledOnce();
    await act(async () => pending.resolve('old-page-result'));
    expect(await screen.findByText('old-page-result')).toBeInTheDocument();
  },
);

it('reports a real post-write query failure to the saving drawer', async () => {
  state.get.mockResolvedValueOnce(report('initial'));
  render(
    <QueryClientProvider client={client}>
      <LiekanPage resource="content" />
    </QueryClientProvider>,
  );
  await screen.findByText('initial');
  fireEvent.click(screen.getByRole('button', { name: '打开管理' }));
  state.get.mockRejectedValue(Object.assign(new Error('statistics unavailable'), { status: 503 }));
  await act(async () => {
    await expect(state.afterSaved!()).rejects.toMatchObject({ status: 503 });
  });
  expect(screen.getByTestId('report-value')).toHaveTextContent('initial');
  await screen.findByText('更新失败，当前显示上次读取的数据');
});

it.each([false, true])(
  'forces a fresh manual read while an older read is running (cached=%s)',
  async cached => {
    const oldRead = deferred<any>();
    const latestRead = deferred<any>();
    const signals: AbortSignal[] = [];
    state.get.mockImplementation((_path, _params, signal) => {
      signals.push(signal);
      if (cached && signals.length === 1) return Promise.resolve(report('initial'));
      return signals.length === (cached ? 2 : 1) ? oldRead.promise : latestRead.promise;
    });
    render(
      <QueryClientProvider client={client}>
        <LiekanPage resource="content" />
      </QueryClientProvider>,
    );
    if (cached) {
      await screen.findByText('initial');
      act(() => {
        void client.refetchQueries({ queryKey: ['liekan', 'site-a'] });
      });
    }
    await waitFor(() => expect(state.get).toHaveBeenCalledTimes(cached ? 2 : 1));
    fireEvent.click(screen.getByRole('button', { name: '生成内容建议' }));
    await waitFor(() => expect(state.get).toHaveBeenCalledTimes(cached ? 3 : 2));
    expect(signals[cached ? 1 : 0].aborted).toBe(true);
    expect(state.get.mock.calls.at(-1)[1]).toMatchObject({ refresh: '1' });
    await act(async () => latestRead.resolve(report('manual-fresh')));
    await screen.findByText('manual-fresh');
    expect(screen.queryByText('已根据当前数据重新生成内容建议')).not.toBeInTheDocument();
    await act(async () => oldRead.resolve(report('old-read')));
    expect(screen.getByTestId('report-value')).toHaveTextContent('manual-fresh');
  },
);

it('shares repeated manual refreshes and renders fresh data without a success banner', async () => {
  const fresh = deferred<any>();
  const signals: AbortSignal[] = [];
  state.get.mockImplementation((_path, _params, signal) => {
    signals.push(signal);
    return signals.length === 1 ? Promise.resolve(report('initial')) : fresh.promise;
  });
  render(
    <QueryClientProvider client={client}>
      <LiekanPage resource="content" />
    </QueryClientProvider>,
  );
  await screen.findByText('initial');
  const generate = screen.getByRole('button', { name: '生成内容建议' });
  fireEvent.click(generate);
  await waitFor(() => expect(state.get).toHaveBeenCalledTimes(2));
  fireEvent.click(generate);
  await act(async () => {
    await Promise.resolve();
  });
  expect(state.get).toHaveBeenCalledTimes(2);
  expect(signals[1].aborted).toBe(false);
  expect(screen.queryByText('已根据当前数据重新生成内容建议')).not.toBeInTheDocument();
  await act(async () => fresh.resolve(report('manual-fresh')));
  await screen.findByText('manual-fresh');
  expect(screen.queryByText('已根据当前数据重新生成内容建议')).not.toBeInTheDocument();
});

it('suppresses manual confirmation when a write replaces the pending read', async () => {
  const manual = deferred<any>();
  const saved = deferred<any>();
  const signals: AbortSignal[] = [];
  state.get.mockImplementation((_path, _params, signal) => {
    signals.push(signal);
    return signals.length === 1
      ? Promise.resolve(report('initial'))
      : signals.length === 2
        ? manual.promise
        : saved.promise;
  });
  render(
    <QueryClientProvider client={client}>
      <LiekanPage resource="content" />
    </QueryClientProvider>,
  );
  await screen.findByText('initial');
  fireEvent.click(screen.getByRole('button', { name: '生成内容建议' }));
  await waitFor(() => expect(state.get).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: '打开管理' }));
  fireEvent.click(screen.getByRole('button', { name: '完成写入' }));
  await waitFor(() => expect(state.get).toHaveBeenCalledTimes(3));
  expect(signals[1].aborted).toBe(true);
  expect(screen.queryByText('已根据当前数据重新生成内容建议')).not.toBeInTheDocument();
  await act(async () => saved.resolve(report('saved-fresh')));
  await screen.findByText('saved-fresh');
  await act(async () => manual.resolve(report('obsolete-manual')));
  expect(screen.getByTestId('report-value')).toHaveTextContent('saved-fresh');
  expect(screen.queryByText('已根据当前数据重新生成内容建议')).not.toBeInTheDocument();
});

it('reports a failed manual read while retaining the previous data', async () => {
  state.get.mockResolvedValueOnce(report('initial'));
  render(
    <QueryClientProvider client={client}>
      <LiekanPage resource="content" />
    </QueryClientProvider>,
  );
  await screen.findByText('initial');
  state.get.mockRejectedValue(Object.assign(new Error('statistics unavailable'), { status: 503 }));
  fireEvent.click(screen.getByRole('button', { name: '生成内容建议' }));
  await screen.findByText('更新失败，当前显示上次读取的数据');
  await screen.findByText('更新失败，当前显示上次读取的数据');
  expect(screen.getByTestId('report-value')).toHaveTextContent('initial');
});

it('advances the default Today range across site midnight', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T15:59:59Z'));
  state.date = 'range:old:old';
  state.dateMode = 'default';
  state.get.mockImplementation(() => Promise.resolve(report('calendar')));
  try {
    render(
      <QueryClientProvider client={client}>
        <LiekanPage resource="content" />
      </QueryClientProvider>,
    );
    await act(async () => vi.advanceTimersByTimeAsync(1));
    const first = state.get.mock.calls[0][1];
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    const second = state.get.mock.calls.at(-1)[1];
    expect(second.startAt).toBe(first.endAt + 1);
    expect(second.endAt).toBeGreaterThan(first.endAt);
    expect(state.updateParams).toHaveBeenLastCalledWith(
      expect.objectContaining({
        date: '0day',
        dateMode: undefined,
      }),
    );
  } finally {
    vi.useRealTimers();
  }
});

it('preserves an offline GEO snapshot beyond the server cache deadline', async () => {
  const { rememberResponseFreshness } = await import('@/lib/liekan/upstream/client-freshness');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T00:00:00Z'));
  let online = true;
  const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  state.get.mockImplementation(() => {
    const value = report('offline-value');
    rememberResponseFreshness(
      value,
      new Headers({
        'X-Liekan-Server-Time': String(Date.now()),
        'X-Liekan-Generated-At': String(Date.now()),
        'X-Liekan-Expires-At': String(Date.now() + 30000),
      }),
      performance.now(),
    );
    return Promise.resolve(value);
  });
  try {
    render(
      <QueryClientProvider client={client}>
        <LiekanPage resource="content" />
      </QueryClientProvider>,
    );
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText('offline-value')).toBeInTheDocument();
    online = false;
    fireEvent(window, new Event('offline'));
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(screen.queryByText('统计待更新')).not.toBeInTheDocument();
    expect(screen.getByText('offline-value')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(screen.getByText('offline-value')).toBeInTheDocument();
    expect(state.get).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('pending')).not.toBeInTheDocument();
  } finally {
    onLineSpy.mockRestore();
    vi.useRealTimers();
  }
});

it('clears dateMode, live and log pagination when an empty-state range shortcut is used', async () => {
  // dateMode=default 残留会让 dynamicDefault 忽略新 token 并把 URL 回写成 range:，快捷键必须清掉它。
  state.date = 'range:1727827200000:1791388799999';
  state.dateMode = 'default';
  state.get.mockRejectedValue(new Error('statistics unavailable'));
  render(
    <QueryClientProvider client={client}>
      <LiekanPage resource="content" />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: '近 7 天' }, { timeout: 5000 }));
  expect(state.updateParams).toHaveBeenCalledWith({
    date: '7day',
    unit: undefined,
    offset: undefined,
    dateMode: undefined,
    live: undefined,
    page: undefined,
    cursor: undefined,
    seek: undefined,
  });
  expect(state.push).toHaveBeenCalledWith('/next-range', { scroll: false });
});

it.each([
  ['7 天', false, '7day'],
  ['30 天', true, '30day'],
] as const)('returns geography to the first page through %s', async (button, invalid, date) => {
  state.invalidDate = invalid;
  state.extraQuery = { tp_cityBody: '2' };
  state.get.mockResolvedValue(report('geography'));
  render(
    <QueryClientProvider client={client}>
      <LiekanPage resource="human/geo" />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: button }));
  expect(state.updateParams).toHaveBeenCalledWith(
    expect.objectContaining({ date, tp_cityBody: undefined }),
  );
  expect(state.push).toHaveBeenCalledWith('/next-range', {
    scroll: false,
  });
});
