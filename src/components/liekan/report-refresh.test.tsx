import { onlineManager, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { featureDateRange } from '@/lib/liekan/contracts/analysis';
import { ManualRefreshProvider } from '@/lib/liekan/contracts/manual-refresh';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';
import { readFeatureDateRange } from '@/lib/liekan/upstream/date-range';
import { freshAggregateFixture } from '@/test/liekan-freshness';
import { setTestUrl } from '@/test/navigation';
import { LiekanPage } from './LiekanPage';

const state = vi.hoisted(() => ({
  get: vi.fn(),
  compare: false,
  date: '30day' as string | undefined,
  dateMode: undefined as string | undefined,
  selectedRange: undefined as { startDate: Date; endDate: Date } | undefined,
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
      logs: ({ report }: any) => (
        <>
          <span>{report?.value}</span>
          <output data-test="log-count">{report?.meta?.totalLogs ?? 'pending-count'}</output>
          <output data-test="log-summary">{report?.cards?.[0]?.value ?? 'pending-summary'}</output>
        </>
      ),
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
      dateRange: state.selectedRange ?? {
        startDate: new Date('2026-09-01'),
        endDate: new Date('2026-10-01'),
      },
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
  let resolve: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve: (value: T | PromiseLike<T>) => resolve(value) };
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
  state.selectedRange = undefined;
  state.invalidDate = false;
  state.updateParams.mockReset().mockReturnValue('/next-range');
  state.push.mockReset();
  state.replace.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => client.clear());

function overviewFixture(page: number, path: string, version?: string, requests = 8737) {
  const first = report('first');
  const cutoff = first.range.endAt - 3600000;
  return freshAggregateFixture({
    ...first,
    range: { ...first.range, endAt: cutoff },
    cards: [{ key: 'requests', label: '今日总请求', value: requests, state: 'available' }],
    charts: {},
    insights: [],
    tables: { topBody: [{ path, humanPv: 3 }] },
    meta: {
      ...first.meta,
      generatedAt: cutoff,
      snapshot: { dataThrough: cutoff, state: 'ready', intervalMs: 1800000, version },
      tablePages: { topBody: { page, pageSize: 20, total: 41 } },
    },
  });
}

it('switches only the trend to a canonical published period without navigating the report', async () => {
  state.date = '7day';
  // The date hook must agree with the selected preset in every runner timezone.
  state.selectedRange = readFeatureDateRange(
    '7day',
    '',
    0,
    'Asia/Shanghai',
    'zh-CN',
    Date.parse('2026-10-01T04:00:00Z'),
  ).dateRange;
  const pending = deferred<any>();
  state.get.mockImplementation((_path, params) =>
    params.chartPeriod === '30d'
      ? pending.promise
      : Promise.resolve(overviewFixture(1, '/stable-ranking')),
  );
  render(
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanPage resource="overview" />
      </ManualRefreshProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('/stable-ranking');
  const card = screen.getByText('8,737');
  fireEvent.click(
    within(screen.getByText('AI 蜘蛛与浏览访问趋势').closest('section')).getByRole('button', {
      name: '30 天',
    }),
  );
  await waitFor(() =>
    expect(state.get.mock.calls.some(([, p]) => p.chartPeriod === '30d')).toBe(true),
  );
  const trendCall = state.get.mock.calls.find(([, p]) => p.chartPeriod === '30d')[1];
  const initialCall = state.get.mock.calls.find(([, p]) => p.chartPeriod === '7d')[1];
  expect(trendCall.startAt).toBe(Date.parse('2026-08-31T16:00:00Z'));
  expect(initialCall.startAt).toBe(Date.parse('2026-09-23T16:00:00Z'));
  expect(state.push).not.toHaveBeenCalled();
  expect(screen.getByText('8,737')).toBe(card);
  expect(screen.getByText('/stable-ranking')).toBeVisible();
  await act(async () => pending.resolve({ status: 'preparing' }));
  expect(await screen.findByText('数据准备中，请稍后查看')).toBeVisible();
  expect(screen.getByText('8,737')).toBe(card);
  expect(screen.getByText('/stable-ranking')).toBeVisible();
  expect(document.querySelector('[data-report-trend]')).toContainElement(
    screen.getByText('数据准备中，请稍后查看'),
  );
  expect(document.querySelector('[data-report-trend] [aria-busy="true"]')).toBeNull();
  expect(within(document.querySelector('[data-report-trend]') as HTMLElement).getByText(/近 30 天/)).toBeVisible();
  const reads = state.get.mock.calls.length;
  fireEvent.focus(window);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(state.get).toHaveBeenCalledTimes(reads);
});

it('keeps bookmarked chart periods out of the main report identity and ignores late trend responses', async () => {
  state.date = '7day';
  state.extraQuery = { chartPeriod: '30d' };
  const late = deferred<any>();
  state.get.mockImplementation((_path, p) =>
    p.chartPeriod === '30d' ? late.promise : Promise.resolve(overviewFixture(1, '/stable-ranking')),
  );
  render(
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanPage resource="overview" />
      </ManualRefreshProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('/stable-ranking');
  await waitFor(() =>
    expect(state.get.mock.calls.some(([, p]) => p.chartPeriod === '30d')).toBe(true),
  );
  const chart = within(document.querySelector('[data-report-trend]') as HTMLElement);
  fireEvent.click(chart.getByRole('button', { name: '7 天' }));
  await act(async () => late.resolve(overviewFixture(1, '/late-30day', undefined, 999)));
  expect(chart.getByRole('button', { name: '7 天' })).toHaveAttribute('aria-pressed', 'true');
  expect(chart.getByText(/近 7 天/)).toBeVisible();
  expect(screen.queryByText('/late-30day')).toBeNull();
  expect(screen.getByText('8,737')).toBeVisible();
  expect(state.get.mock.calls.filter(([, p]) => p.chartPeriod === '7d')).toHaveLength(1);
  expect(state.push).not.toHaveBeenCalled();
});

it.each([
  ['en-US', '11/01/2026', '11/02/2026'],
  ['zh-CN', '2026/11/01', '2026/11/02'],
] as const)('shows the last included date across a DST transition in %s', async (locale, day, nextDay) => {
  const source = overviewFixture(1, '/previous');
  // The New York fall-back day has 25 hours.
  const range = {
    startAt: Date.parse('2026-11-01T04:00:00Z'),
    endAt: Date.parse('2026-11-02T05:00:00Z'),
    timezone: 'America/New_York',
  };
  state.get.mockResolvedValue({
    ...source,
    range,
    meta: {
      ...source.meta,
      snapshot: {
        ...source.meta.snapshot,
        state: 'updating',
        fallback: { sourceRange: range, requestedRange: source.range, chartPeriod: 'today' },
      },
      crawlerMetrics: { timeBoundary: 'half_open' },
    },
  });
  render(
    <LiekanLocaleContext.Provider value={locale}>
      <QueryClientProvider client={client}>
        <LiekanPage resource="overview" />
      </QueryClientProvider>
    </LiekanLocaleContext.Provider>,
  );
  await screen.findByText('/previous');
  const notice = screen.getAllByRole('status').find(element => element.textContent?.includes(day));
  expect(notice).toBeVisible();
  expect(notice).not.toHaveTextContent(nextDay);
});

it('shows the actual period of a server-validated previous trend and clears it on permission failure', async () => {
  state.date = '7day';
  const original = overviewFixture(1, '/stable-ranking');
  const previous = overviewFixture(1, '/other-ranking', undefined, 999);
  (previous.meta.snapshot as any).fallback = {
    sourceRange: previous.range,
    requestedRange: original.range,
  } as any;
  state.get.mockImplementation((_path, p) =>
    Promise.resolve(p.chartPeriod === '30d' ? previous : original),
  );
  render(
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanPage resource="overview" />
      </ManualRefreshProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('/stable-ranking');
  let chart = within(document.querySelector('[data-report-trend]') as HTMLElement);
  fireEvent.click(chart.getByRole('button', { name: '30 天' }));
  expect(await chart.findByText(/上次统计：/)).toBeVisible();
  expect(screen.getByText('8,737')).toBeVisible();
  expect(screen.queryByText('/other-ranking')).toBeNull();
  state.get.mockRejectedValue({ status: 403, message: 'Forbidden' });
  fireEvent.click(chart.getByRole('button', { name: '今天' }));
  await waitFor(() => expect(screen.queryByText('8,737')).toBeNull());
  expect(screen.queryByText('/stable-ranking')).toBeNull();
  expect(screen.queryByText(/上次统计：/)).toBeNull();
  expect(state.push).not.toHaveBeenCalled();
});

it('revalidates the parent at most once when a bookmarked trend remains in conflict', async () => {
  state.date = '7day';
  state.extraQuery = { chartPeriod: '30d' };
  state.get.mockImplementation((_path, p) =>
    p.chartPeriod === '30d'
      ? Promise.reject({ status: 409, code: 'warehouse-control-changed' })
      : Promise.resolve(overviewFixture(1, '/stable-ranking')),
  );
  render(
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanPage resource="overview" />
      </ManualRefreshProvider>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      state.get.mock.calls.filter(([, p]) => p.chartPeriod === '7d').length,
    ).toBeGreaterThanOrEqual(2),
  );
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(state.get.mock.calls.filter(([, p]) => p.chartPeriod === '7d')).toHaveLength(2);
});

it.each([429, 503])(
  'removes a cached report when HTTP %i confirms no valid snapshot survives',
  async status => {
    state.get.mockResolvedValue(report('prior-result'));
    render(
      <QueryClientProvider client={client}>
        <LiekanPage resource="content" />
      </QueryClientProvider>,
    );
    await screen.findByText('prior-result');
    state.get.mockRejectedValue({ status, code: 'warehouse-report-no-valid-snapshot' });
    await act(async () => {
      await client.refetchQueries({ queryKey: ['liekan', 'site-a'] });
    });
    await waitFor(() => {
      expect(screen.queryByText('prior-result')).toBeNull();
      const failed = client
        .getQueryCache()
        .findAll()
        .filter(q => q.state.status === 'error');
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.every(q => q.state.data === undefined)).toBe(true);
    });
  },
);

it('retains a published trend after a transient refresh failure', async () => {
  state.date = '7day';
  state.get.mockImplementation(() => Promise.resolve(overviewFixture(1, '/stable-ranking')));
  render(
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanPage resource="overview" />
      </ManualRefreshProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('/stable-ranking');
  const section = document.querySelector('[data-report-trend]') as HTMLElement;
  fireEvent.click(within(section).getByRole('button', { name: '30 天' }));
  await within(section).findByText(/数据截至/);
  state.get.mockRejectedValue({ status: 503, message: 'Busy' });
  await act(async () => {
    await client.refetchQueries({
      predicate: q => q.queryKey[3] === 'overview' && q.queryKey[7] === '30d',
    });
  });
  expect(await within(section).findByText('更新失败，当前显示上次读取的数据')).toBeVisible();
  expect(section.querySelector('#d1')).toBeInTheDocument();
  expect(screen.getByText('/stable-ranking')).toBeVisible();
  state.get.mockRejectedValue({ status: 503, code: 'warehouse-report-no-valid-snapshot' });
  fireEvent.click(within(section).getByRole('button', { name: '重试' }));
  expect(await within(section).findByText(/无法读取此范围的数据/)).toBeVisible();
  expect(section.querySelector('#d1')).toBeNull();
  state.get.mockRejectedValue({ status: 503, message: 'Busy' });
  const attempts = state.get.mock.calls.length;
  fireEvent.click(within(section).getByRole('button', { name: '重试' }));
  await waitFor(() => {
    expect(state.get.mock.calls.length).toBeGreaterThan(attempts);
    const latest = client.getQueryCache().getAll().find(
      q => q.queryKey[3] === 'overview' && q.queryKey[7] === '30d',
    );
    expect(latest?.state.error?.message).toBe('Busy');
    expect(latest?.state.data).toBeUndefined();
  });
  expect(section.querySelector('#d1')).toBeNull();
  expect(screen.getByText('/stable-ranking')).toBeVisible();
});

it('keeps the overview visible while the TOP table reads its next page', async () => {
  const snapshot = overviewFixture;
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

it('uses one overview version when a refresh publishes during a page turn', async () => {
  const newerBase = deferred<ReturnType<typeof overviewFixture>>();
  let baseRequests = 0;
  state.get.mockImplementation((path, params) => {
    if (!path.endsWith('/page-report')) return Promise.resolve({});
    if (params.tp_topBody === 2)
      return Promise.resolve(overviewFixture(2, '/newer-second', 'b', 9010));
    if (++baseRequests === 1) return Promise.resolve(overviewFixture(1, '/older-first', 'a'));
    return newerBase.promise;
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanPage resource="overview" />
      </ManualRefreshProvider>
    </QueryClientProvider>
  );
  setTestUrl('/websites/site-a/geo?date=30day');
  const view = render(tree());
  await screen.findByText('/older-first');
  expect(baseRequests).toBe(1);

  state.extraQuery = { tp_topBody: '2' };
  setTestUrl('/websites/site-a/geo?date=30day&tp_topBody=2');
  view.rerender(tree());
  await waitFor(() => expect(baseRequests).toBe(2));
  expect(screen.getByText('8,737')).toBeVisible();
  expect(screen.queryByText('/newer-second')).toBeNull();

  await act(async () => newerBase.resolve(overviewFixture(1, '/newer-first', 'b', 9010)));
  expect(await screen.findByText('/newer-second')).toBeVisible();
  expect(screen.getByText('9,010')).toBeVisible();
  state.extraQuery = {};
  setTestUrl('/websites/site-a/geo?date=30day');
  view.rerender(tree());
  expect(screen.getByText('/newer-first')).toBeVisible();
  expect(screen.getByText('9,010')).toBeVisible();
});

it('resets to page one after a pinned overview page expires and ignores an earlier request', async () => {
  const firstVersion = 'a'.repeat(64);
  const newerVersion = 'b'.repeat(64);
  const latePage = deferred<ReturnType<typeof overviewFixture>>();
  const expired = deferred<ReturnType<typeof overviewFixture>>();
  let firstReads = 0;
  state.get.mockImplementation((path, params) => {
    if (!path.endsWith('/page-report')) return Promise.resolve({});
    if (params.tp_topBody === 2) return latePage.promise;
    if (params.tp_topBody === 4) return expired.promise;
    return Promise.resolve(
      ++firstReads === 1
        ? overviewFixture(1, '/old-first', firstVersion)
        : overviewFixture(1, '/new-first', newerVersion),
    );
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <LiekanPage resource="overview" />
    </QueryClientProvider>
  );
  const view = render(tree());
  await screen.findByText('/old-first');
  for (const page of ['2', '4']) {
    state.extraQuery = { tp_topBody: page };
    view.rerender(tree());
    await waitFor(() =>
      expect(
        state.get.mock.calls.some(
          ([, input]) => input.tp_topBody === Number(page) && input.reportVersion === firstVersion,
        ),
      ).toBe(true),
    );
  }
  await act(async () => {
    expired.promise.catch(() => {});
    expired.resolve(
      Promise.reject(
        Object.assign(new Error('Snapshot expired'), {
          status: 409,
          code: 'overview-version-invalidated',
        }),
      ),
    );
  });
  await waitFor(() => expect(state.updateParams).toHaveBeenCalledWith({ tp_topBody: undefined }));
  state.extraQuery = {};
  view.rerender(tree());
  await screen.findByText('/new-first');
  await act(async () => latePage.resolve(overviewFixture(2, '/late-page', firstVersion)));
  expect(screen.queryByText('/late-page')).toBeNull();
  expect(screen.getByText('/new-first')).toBeVisible();
});

it('delivers log rows before the independent count and summary finish', async () => {
  const count = deferred<any>(),
    summary = deferred<any>();
  const boundary = 'a'.repeat(64);
  state.get.mockImplementation((path: string, parameters: any) => {
    if (path.endsWith('/log-count')) return count.promise;
    if (path.endsWith('/log-summary')) return summary.promise;
    if (path.endsWith('/log-entries')) {
      const entries = report('visible-log-rows', parameters);
      Object.assign(entries.meta, { logReadBoundary: boundary });
      return Promise.resolve(entries);
    }
    return new Promise(() => {});
  });
  render(
    <QueryClientProvider client={client}>
      <LiekanPage resource="logs" />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('visible-log-rows')).toBeVisible();
  await waitFor(() =>
    expect(state.get.mock.calls.some(([path]) => path.endsWith('/log-count'))).toBe(true),
  );
  expect(screen.getByTestId('log-count')).toHaveTextContent('pending-count');
  await act(async () => {
    count.resolve({ readBoundary: boundary, total: 9876 });
  });
  await waitFor(() => expect(screen.getByTestId('log-count')).toHaveTextContent('9876'));
  expect(screen.getByText('visible-log-rows')).toBeVisible();
  await act(async () => {
    summary.resolve({
      readBoundary: boundary,
      cards: [],
      tables: {},
      states: { logs: 'available', catalog: 'empty' },
      meta: {},
    });
  });
});

it('hides independently loaded rows when the count read discovers revoked permission', async () => {
  const count = deferred<any>();
  state.get.mockImplementation((path: string, parameters: any) => {
    if (path.endsWith('/log-count')) return count.promise;
    if (path.endsWith('/log-summary')) return new Promise(() => {});
    const entries = report('private-log-rows', parameters);
    Object.assign(entries.meta, { logReadBoundary: 'a'.repeat(64) });
    return Promise.resolve(entries);
  });
  render(
    <QueryClientProvider client={client}>
      <LiekanPage resource="logs" />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('private-log-rows')).toBeVisible();
  await act(async () => {
    count.promise.catch(() => {});
    count.resolve(Promise.reject(Object.assign(new Error('权限已撤销'), { status: 403 })));
  });
  await waitFor(() => expect(screen.queryByText('private-log-rows')).not.toBeInTheDocument());
  expect(await screen.findByText('无法读取此范围的数据')).toBeVisible();
});

it.each([true, false])(
  'bounds log boundary recovery when the next attempt succeeds=%s',
  async succeeds => {
    const first = 'a'.repeat(64);
    const next = 'b'.repeat(64);
    let entriesRead = 0;
    state.get.mockImplementation(async (path, input) => {
      if (path.endsWith('/log-count')) {
        if (input.readBoundary === first || !succeeds)
          throw Object.assign(new Error('Logs changed'), {
            status: 409,
            code: 'log-read-boundary-conflict',
          });
        return { readBoundary: next, total: 17 };
      }
      if (path.endsWith('/log-summary')) return { readBoundary: input.readBoundary };
      if (!path.endsWith('/log-entries')) return {};
      const read = ++entriesRead;
      const result = report(`read-${read}`, input);
      Object.assign(result.meta, { logReadBoundary: read === 1 ? first : next });
      return result;
    });
    render(
      <QueryClientProvider client={client}>
        <LiekanPage resource="logs" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('read-2')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByTestId('log-count')).toHaveTextContent(succeeds ? '17' : 'pending-count'),
    );
    await waitFor(() =>
      expect(state.get.mock.calls.filter(([path]) => path.endsWith('/log-count'))).toHaveLength(2),
    );
    expect(entriesRead).toBe(2);
  },
);

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
  const initial = state.get.mock.calls.filter(call => call[0].endsWith('/log-entries'));
  expect(initial).toHaveLength(1);
  expect(initial[0][1]).toMatchObject({ page: 3, cursor: 'old-log-cursor', seek: 'after' });
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() =>
    expect(state.get.mock.calls.filter(call => call[0].endsWith('/log-entries'))).toHaveLength(2),
  );
  const refreshed = state.get.mock.calls.filter(call => call[0].endsWith('/log-entries'))[1][1];
  expect(refreshed.page).toBe(1);
  expect(refreshed.cursor).toBeFalsy();
  expect(refreshed.seek).toBe('after');
  expect(refreshed.endAt).toBeGreaterThanOrEqual(initial[0][1].endAt);
  expect(refreshed.startAt).toBe(refreshed.endAt - 30 * 86400000);
  expect(state.updateParams).toHaveBeenCalledWith(
    expect.objectContaining({ page: undefined, cursor: undefined, seek: undefined }),
  );
  state.extraQuery = { live: '1' };
  setTestUrl('/websites/site-a/geo/logs?dateMode=default&live=1');
  view.rerender(tree());
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled());
  expect(state.get.mock.calls.filter(call => call[0].endsWith('/log-entries'))).toHaveLength(2);
  state.extraQuery = { live: '1', page: '2', cursor: 'old-log-cursor', seek: 'after' };
  setTestUrl(
    '/websites/site-a/geo/logs?dateMode=default&live=1&page=2&cursor=old-log-cursor&seek=after',
  );
  view.rerender(tree());
  await waitFor(() =>
    expect(state.get.mock.calls.filter(call => call[0].endsWith('/log-entries'))).toHaveLength(3),
  );
  expect(state.get.mock.calls.filter(call => call[0].endsWith('/log-entries'))[2][1]).toMatchObject(
    {
      page: 2,
      cursor: 'old-log-cursor',
      seek: 'after',
    },
  );
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

it.each([401, 403, 404, 429, 503])(
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
        [429, 503].includes(status) ? 'previous' : 'unavailable',
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

it('keeps exact count and summary visible while refreshing the same log boundary', async () => {
  const boundary = 'c'.repeat(64),
    count = deferred<any>(),
    summary = deferred<any>();
  let refreshing = false;
  const summaryValue = {
    readBoundary: boundary,
    cards: [{ key: 'value', label: 'value', value: 42, state: 'available' }],
    tables: {},
    states: { logs: 'available', catalog: 'empty' },
    meta: {},
  };
  state.get.mockImplementation((path: string, parameters: any) => {
    if (path.endsWith('/log-count'))
      return refreshing ? count.promise : Promise.resolve({ readBoundary: boundary, total: 9876 });
    if (path.endsWith('/log-summary'))
      return refreshing ? summary.promise : Promise.resolve(summaryValue);
    const entries = report('retained-log-rows', parameters);
    Object.assign(entries.meta, { logReadBoundary: boundary });
    return Promise.resolve(entries);
  });
  render(
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanPage resource="logs" />
      </ManualRefreshProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('log-count')).toHaveTextContent('9876'));
  expect(screen.getByTestId('log-summary')).toHaveTextContent('42');
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled());
  refreshing = true;
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() =>
    expect(state.get.mock.calls.filter(([path]) => path.endsWith('/log-count')).length).toBe(2),
  );
  expect(screen.getByTestId('log-count')).toHaveTextContent('9876');
  expect(screen.getByTestId('log-summary')).toHaveTextContent('42');
  expect(screen.getByRole('button', { name: '正在读取' })).toBeDisabled();
  await act(async () => {
    count.resolve({ readBoundary: boundary, total: 9876 });
    summary.resolve(summaryValue);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled());
});

it('finishes loading for a preparing 30-day report and only rereads on an explicit click', async () => {
  state.get.mockResolvedValue({ status: 'preparing' });
  render(
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanPage resource="content" />
      </ManualRefreshProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('数据准备中，请稍后查看');
  expect(screen.queryByText('pending')).not.toBeInTheDocument();
  const initial = state.get.mock.calls.length;
  fireEvent(window, new Event('focus'));
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(state.get).toHaveBeenCalledTimes(initial);
  fireEvent.click(screen.getByRole('button', { name: '重新查看' }));
  await waitFor(() => expect(state.get.mock.calls.length).toBeGreaterThan(initial));
  expect(screen.queryByText('pending')).not.toBeInTheDocument();
});

it('clears a ready seven-day report when the selected thirty-day result is preparing', async () => {
  state.date = '7day';
  state.selectedRange = { startDate: new Date('2026-09-24'), endDate: new Date('2026-10-01') };
  state.get.mockImplementation((_path, p) =>
    Promise.resolve(
      p.chartPeriod === '7d'
        ? report('seven-day-only', { startAt: p.startAt, endAt: p.endAt, timezone: p.timezone })
        : { status: 'preparing' },
    ),
  );
  const tree = () => (
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanPage resource="content" />
      </ManualRefreshProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  await screen.findByText('seven-day-only');
  state.date = '30day';
  state.selectedRange = { startDate: new Date('2026-09-01'), endDate: new Date('2026-10-01') };
  view.rerender(tree());
  await screen.findByText('数据准备中，请稍后查看');
  expect(screen.queryByText('seven-day-only')).not.toBeInTheDocument();
  expect(screen.queryByText('pending')).not.toBeInTheDocument();
  const requests = state.get.mock.calls.length;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  try {
    fireEvent(window, new Event('focus'));
    await act(() => vi.advanceTimersByTimeAsync(65000));
    expect(state.get).toHaveBeenCalledTimes(requests);
  } finally {
    vi.useRealTimers();
  }
});

it('shows the server-validated last report with its actual dates until the requested range is published', async () => {
  const older = overviewFixture(1, '/retained-ranking', 'a'.repeat(64));
  const sourceRange = { ...older.range };
  const source = {
    ...older,
    meta: {
      ...older.meta,
      snapshot: {
        ...older.meta.snapshot,
        state: 'updating',
        fallback: {
          sourceRange,
          requestedRange: {
            startAt: 1794672000000,
            endAt: 1794758399999,
            timezone: 'Asia/Shanghai',
          },
          chartPeriod: '7d',
        },
      },
    },
  };
  state.get.mockResolvedValue(source);
  render(
    <QueryClientProvider client={client}>
      <ManualRefreshProvider>
        <LiekanPage resource="overview" />
      </ManualRefreshProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('/retained-ranking');
  const notice = screen.getByText(/当前区间尚未就绪，显示上次统计/);
  const expectedDay = new Intl.DateTimeFormat('zh-CN', {
    timeZone: source.range.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(source.range.startAt);
  expect(notice).toHaveTextContent(expectedDay);
  expect(notice.parentElement).toHaveTextContent(
    new Date(source.meta.snapshot.dataThrough).toLocaleString('zh-CN', {
      timeZone: source.range.timezone,
      hour12: false,
    }),
  );
  expect(screen.queryByText('数据准备中，请稍后查看')).not.toBeInTheDocument();
  expect(screen.queryByText('pending')).not.toBeInTheDocument();
  const initial = state.get.mock.calls.length;
  fireEvent(window, new Event('focus'));
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(state.get).toHaveBeenCalledTimes(initial);
  state.get.mockResolvedValue(overviewFixture(1, '/new-ranking', 'b'.repeat(64)));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByText('/new-ranking');
  expect(screen.queryByText('/retained-ranking')).not.toBeInTheDocument();
  expect(screen.queryByText(/当前区间尚未就绪，显示上次统计/)).not.toBeInTheDocument();
});
