import { populationFromRow } from '@/lib/liekan/upstream/browser-population';
import { identityUnavailableReason } from '@/lib/liekan/contracts/population-results';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AnalyticsPages } from './AnalyticsPages';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';

const mocks = vi.hoisted(() => ({
  context: null as any,
  query: {} as Record<string, any>,
  errors: {} as Record<string, Error>,
  pending: {} as Record<string, boolean>,
  href: vi.fn(),
  post: vi.fn(),
  navigate: vi.fn(),
  updateQuery: vi.fn(),
  actionBusy: false,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));
vi.mock('./context', () => ({
  useFeature: () => mocks.context,
  useData: (key: any[]) => ({
    data:
      typeof mocks.query[key[0]] === 'function' ? mocks.query[key[0]](key) : mocks.query[key[0]],
    error: mocks.errors[key[0]] || null,
    isPending: mocks.pending[key[0]] || false,
  }),
  useAction: () => ({
    run: async (action: () => Promise<any>) => action(),
    busy: mocks.actionBusy,
    error: '',
  }),
}));
vi.mock('./Chart', () => ({
  Chart: ({ title, labels, series }: any) => (
    <div role="img" aria-label={title}>
      {JSON.stringify({ labels, series })}
    </div>
  ),
}));
vi.mock('@/lib/liekan/upstream/features-client', () => ({ getAllFeatureRows: vi.fn() }));

beforeEach(() => {
  mocks.query = {};
  mocks.errors = {};
  mocks.pending = {};
  mocks.actionBusy = false;
  mocks.href.mockReset().mockReturnValue('/sessions');
  mocks.post.mockReset().mockResolvedValue({});
  mocks.navigate.mockReset();
  mocks.updateQuery.mockReset();
  mocks.context = {
    user: { id: 'owner', isAdmin: true },
    siteId: 'site',
    site: { userId: 'owner' },
    route: { page: 'breakdown' },
    query: {},
    range: { startAt: 1, endAt: 2, timezone: 'UTC' },
    filters: {},
    teams: [],
    api: { get: vi.fn(), post: mocks.post },
    href: mocks.href,
    navigate: mocks.navigate,
    updateQuery: mocks.updateQuery,
  };
});

it('applies saved audiences to mounted retention queries and restores them from URL filters', () => {
  const audiences: string[] = [];
  mocks.context.route.page = 'retention';
  mocks.context.range = {
    startAt: Date.UTC(2026, 8, 1),
    endAt: Date.UTC(2026, 8, 30),
    timezone: 'UTC',
  };
  mocks.query['retention-audiences'] = [
    { id: 'segment-a', type: 'segment', name: '移动访客' },
    { id: 'cohort-a', type: 'cohort', name: '注册人群' },
  ];
  mocks.query.retention = (key: any[]) => {
    audiences.push(key[2]);
    return [];
  };
  const view = render(<AnalyticsPages page="retention" />);
  expect(screen.getByLabelText('人群')).toHaveValue('');
  mocks.context = { ...mocks.context, filters: { segment: 'segment-a' } };
  view.rerender(<AnalyticsPages page="retention" />);
  expect(screen.getByLabelText('人群')).toHaveValue('segment:segment-a');
  expect(audiences.at(-1)).toBe('segment:segment-a');
  fireEvent.change(screen.getByLabelText('人群'), { target: { value: 'cohort:cohort-a' } });
  expect(mocks.updateQuery).toHaveBeenCalledWith({ cohort: 'cohort-a', segment: undefined });
  mocks.context = { ...mocks.context, filters: {} };
  view.rerender(<AnalyticsPages page="retention" />);
  expect(screen.getByLabelText('人群')).toHaveValue('');
  expect(audiences.at(-1)).toBe('');
});
it('preserves the selected audience while choices load or fail, then resolves its name', () => {
  mocks.context.filters = { segment: 'segment-a' };
  mocks.pending['retention-audiences'] = true;
  const view = render(<AnalyticsPages page="retention" />);
  expect(screen.getByLabelText('人群')).toHaveValue('segment:segment-a');
  expect(screen.getByRole('option', { name: '所选分群（正在读取）' })).toBeDisabled();
  mocks.pending['retention-audiences'] = false;
  mocks.errors['retention-audiences'] = new Error('读取失败');
  view.rerender(<AnalyticsPages page="retention" />);
  expect(screen.getByLabelText('人群')).toHaveValue('segment:segment-a');
  expect(screen.getByRole('option', { name: '所选分群（读取失败）' })).toBeDisabled();
  mocks.errors = {};
  mocks.query['retention-audiences'] = [{ id: 'segment-a', type: 'segment', name: '移动访客' }];
  view.rerender(<AnalyticsPages page="retention" />);
  expect(screen.getByLabelText('人群')).toHaveValue('segment:segment-a');
  expect(screen.getByRole('option', { name: '移动访客' })).not.toBeDisabled();
});

it('explains continuous visits and exposes the access-record heading', () => {
  mocks.query['sessions-rich'] = { rows: [], count: 0 };
  render(<AnalyticsPages page="sessions" />);
  expect(screen.getByRole('heading', { name: '访问记录' })).toBeInTheDocument();
  expect(screen.getByText(/会话是一次连续访问/)).toBeInTheDocument();
});

it('creates a behavior audience while retaining the native cohort contract', async () => {
  render(<AnalyticsPages page="cohort-editor" />);
  expect(screen.getByRole('heading', { name: '创建行为人群' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/行为人群名称/), { target: { value: '注册访客' } });
  fireEvent.change(screen.getByLabelText(/行为值/), { target: { value: 'signup' } });
  fireEvent.submit(screen.getByRole('button', { name: '保存行为人群' }).closest('form'));
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith('/websites/site/segments', {
      name: '注册访客',
      type: 'cohort',
      parameters: {
        filters: [],
        match: 'all',
        action: { type: 'event', value: 'signup' },
        dateRange: '30day',
      },
    }),
  );
  expect(mocks.navigate).toHaveBeenCalledWith('cohorts');
});

it('retains a goal-loading error on UTM activities instead of claiming no goal exists', () => {
  mocks.errors['utm-goal-list'] = new Error('目标读取暂不可用');
  mocks.query['utm-total'] = { views: 0, visitors: 0 };
  mocks.query['utm-dimension'] = { rows: [], dimensionTotal: 0 };
  render(<AnalyticsPages page="utm" />);
  expect(screen.getByRole('alert')).toHaveTextContent('目标读取暂不可用');
  expect(screen.queryByText('尚未配置')).not.toBeInTheDocument();
});

it('orders the breakdown chart by views and emits explicit missing-dimension drill conditions', () => {
  mocks.query.breakdown = [
    { path: '/small', country: 'CN', views: 2, visitors: 2 },
    { path: '/large', country: null, views: 20, visitors: 1 },
  ];
  render(<AnalyticsPages page="breakdown" />);
  expect(JSON.parse(screen.getByRole('img').textContent!)).toMatchObject({
    labels: ['/large × 未提供', '/small × CN'],
    series: [{ values: [20, 2] }],
  });
  expect(mocks.href).toHaveBeenCalledWith(
    'sessions',
    expect.objectContaining({
      drill_path: 'eq./large',
      drill_country: 'empty.',
    }),
  );
  expect(mocks.href).toHaveBeenCalledWith(
    'sessions',
    expect.objectContaining({ drill_path: 'eq./small', drill_country: 'eq.CN' }),
  );
});

it.each(['path', 'country'])(
  'keeps missing %s dimension rows in the same sort order through language changes',
  field => {
    mocks.context.site.domain = 'example.test';
    mocks.query.breakdown = [
      { path: '/known', country: 'CN', views: 2, visitors: 1 },
      { path: field === 'path' ? null : '/missing', country: null, views: 5, visitors: 2 },
    ];
    const view = render(
      <LiekanLocaleContext.Provider value="zh-CN">
        <AnalyticsPages page="breakdown" />
      </LiekanLocaleContext.Provider>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: field === 'path' ? /页面路径/ : /国家 \/ 地区/ }),
    );
    const counts = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map(row => row.children[2].textContent);
    const order = counts();
    expect(order).toHaveLength(2);
    view.rerender(
      <LiekanLocaleContext.Provider value="en-US">
        <AnalyticsPages page="breakdown" />
      </LiekanLocaleContext.Provider>,
    );
    expect(counts()).toEqual(order);
  },
);

it.each(['未提供', 'Not provided'])(
  'keeps the bilingual missing-dimension search %s through language changes',
  term => {
    mocks.query.breakdown = [
      { path: '/known', country: 'CN', views: 2, visitors: 1 },
      { path: '/missing', country: null, views: 5, visitors: 2 },
    ];
    const view = render(
      <LiekanLocaleContext.Provider value="zh-CN">
        <AnalyticsPages page="breakdown" />
      </LiekanLocaleContext.Provider>,
    );
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索本页记录' }), {
      target: { value: term },
    });
    expect(screen.getAllByRole('cell').map(cell => cell.textContent)).toContain('/missing');
    expect(screen.queryByRole('cell', { name: '/known' })).not.toBeInTheDocument();
    view.rerender(
      <LiekanLocaleContext.Provider value="en-US">
        <AnalyticsPages page="breakdown" />
      </LiekanLocaleContext.Provider>,
    );
    expect(screen.getByRole('searchbox', { name: 'Search this page' })).toHaveValue(
      term,
    );
    expect(screen.getAllByRole('cell').map(cell => cell.textContent)).toContain('/missing');
    expect(screen.queryByRole('cell', { name: '/known' })).not.toBeInTheDocument();
  },
);

it('keeps the selected event property while its value query is pending', () => {
  mocks.context.query.eventName = 'signup';
  const keys: string[] = [];
  let initialReads = 0;
  const data = {
    totals: { total: 3, visitors: 2 },
    properties: [{ name: 'plan', total: 3 }],
    values: [{ value: 'pro', dataType: 1, total: 3 }],
  };
  mocks.query['event-detail'] = (key: any[]) => {
    keys.push(key[2]);
    if (!key[2] && initialReads++ < 2) return data;
    return undefined;
  };
  const view = render(<AnalyticsPages page="event-detail" />);
  expect(keys.at(-1)).toBe('plan');
  view.rerender(<AnalyticsPages page="event-detail" />);
  expect(keys.at(-1)).toBe('plan');
  expect(keys.filter(key => key === '')).toHaveLength(1);
  mocks.query['event-detail'] = (key: any[]) => {
    keys.push(key[2]);
    return data;
  };
  view.rerender(<AnalyticsPages page="event-detail" />);
  expect(screen.getByText('plan 的各属性值对应触发次数。')).toBeInTheDocument();
  expect(JSON.parse(screen.getByRole('img').textContent!).series[0].values).toEqual([3]);
});

it('localizes property types while retaining original property names and values', () => {
  mocks.context.query.eventName = '网站管理';
  mocks.query['event-detail'] = {
    totals: { total: 6, visitors: 1 },
    properties: [{ name: '网站名称', total: 6 }],
    values: [null, '未提供', 17, true, '2026-10-14', '页面访问'].map((value, dataType) => ({
      value,
      dataType,
      total: 1,
    })),
  };
  render(
    <LiekanLocaleContext.Provider value="en-US">
      <AnalyticsPages page="event-detail" />
    </LiekanLocaleContext.Provider>,
  );
  for (const type of ['Missing', 'String', 'Number', 'Boolean', 'Date', 'Array'])
    expect(screen.getByRole('cell', { name: type })).toBeVisible();
  expect(screen.getByRole('tab', { name: '网站名称' })).toBeVisible();
  expect(screen.getByRole('cell', { name: '未提供' })).toBeVisible();
  expect(screen.getByRole('cell', { name: '页面访问' })).toBeVisible();
});
it('localizes anonymous visitor labels and long durations while preserving their suffix and query identities', () => {
  mocks.query['sessions-rich'] = {
    rows: [{ id: 'anonymous-123456', views: 2, seconds: 90000 }],
    count: 1,
  };
  render(
    <LiekanLocaleContext.Provider value="en-US">
      <AnalyticsPages page="sessions" />
    </LiekanLocaleContext.Provider>,
  );
  expect(screen.getByRole('cell', { name: 'Visitor 123456' })).toBeVisible();
  expect(screen.getByRole('cell', { name: '1d 1h' })).toBeVisible();
  expect(mocks.href).toHaveBeenCalledWith(
    'session-detail',
    expect.objectContaining({ id: 'anonymous-123456' }),
  );
});
it('formats missing session sources while retaining supplied names and bilingual source search', () => {
  mocks.query['sessions-rich'] = {
    rows: [
      { id: 'missing-111111', referrerDomain: null },
      { id: 'supplied-222222', referrerDomain: '直接访问' },
      { id: 'named-333333', referrerDomain: '网站管理' },
    ],
    count: 3,
  };
  const page = (locale: 'en-US' | 'zh-CN') => (
    <LiekanLocaleContext.Provider value={locale}>
      <AnalyticsPages page="sessions" />
    </LiekanLocaleContext.Provider>
  );
  const view = render(page('en-US'));
  expect(screen.getByRole('cell', { name: 'Direct traffic' })).toBeVisible();
  expect(screen.getByRole('cell', { name: '直接访问' })).toBeVisible();
  expect(screen.getByRole('cell', { name: '网站管理' })).toBeVisible();
  const search = screen.getByRole('searchbox');
  fireEvent.change(search, { target: { value: 'Direct traffic' } });
  expect(screen.getByText('Visitor 111111')).toBeVisible();
  expect(screen.queryByText('Visitor 222222')).not.toBeInTheDocument();
  view.rerender(page('zh-CN'));
  expect(search).toHaveValue('Direct traffic');
  expect(screen.getByText('访客 111111')).toBeVisible();
  expect(screen.queryByText('访客 222222')).not.toBeInTheDocument();
});
it('keeps generated and supplied compare sources separate with correctly aligned periods', () => {
  mocks.query['compare-rich'] = {
    current: {},
    previous: {},
    currentSeries: {},
    previousSeries: {},
    sources: {
      rows: [
        { referrer: null, visitors: 3 },
        { referrer: '直接访问', visitors: 7 },
      ],
    },
    oldSources: {
      rows: [
        { referrer: null, visitors: 2 },
        { referrer: '直接访问', visitors: 5 },
      ],
    },
  };
  render(
    <LiekanLocaleContext.Provider value="en-US">
      <AnalyticsPages page="compare" />
    </LiekanLocaleContext.Provider>,
  );
  const generated = screen.getByRole('cell', { name: 'Direct traffic' }).closest('tr');
  const supplied = screen.getByRole('cell', { name: '直接访问' }).closest('tr');
  expect(generated).toHaveTextContent('3');
  expect(generated).toHaveTextContent('2');
  expect(generated).toHaveTextContent('+50.00%');
  expect(supplied).toHaveTextContent('7');
  expect(supplied).toHaveTextContent('5');
  expect(supplied).toHaveTextContent('+40.00%');
});
it('localizes realtime source metadata while retaining unmarked legacy and supplied labels', () => {
  mocks.query['realtime-rich'] = {
    totals: { active: 2, views: 2, events: 0, ai: 0 },
    sources: [
      { name: '直接访问', sourceLabel: 'direct', value: 1 },
      { name: '直接访问', value: 1 },
      { name: '网站管理', value: 1 },
    ],
  };
  render(
    <LiekanLocaleContext.Provider value="en-US">
      <AnalyticsPages page="realtime" />
    </LiekanLocaleContext.Provider>,
  );
  expect(screen.getByRole('cell', { name: 'Direct traffic' })).toBeVisible();
  expect(screen.getByRole('cell', { name: '直接访问' })).toBeVisible();
  expect(screen.getByRole('cell', { name: '网站管理' })).toBeVisible();
});
it('formats empty attribution sources while preserving supplied names and canonical query values', async () => {
  mocks.query.attribution = {
    total: { visitors: 3, attributed: 3 },
    referrer: [
      { name: '', value: 1 },
      { name: '直接访问', value: 1 },
      { name: '网站管理', value: 1 },
    ],
  };
  render(
    <LiekanLocaleContext.Provider value="en-US">
      <AnalyticsPages page="attribution" />
    </LiekanLocaleContext.Provider>,
  );
  fireEvent.change(screen.getByRole('textbox', { name: /^Conversion steps/ }), {
    target: { value: 'purchase' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Apply attribution settings' }));
  await waitFor(() => expect(screen.getByRole('cell', { name: 'Direct traffic' })).toBeVisible());
  expect(screen.getByRole('cell', { name: '直接访问' })).toBeVisible();
  expect(screen.getByRole('cell', { name: '网站管理' })).toBeVisible();
  expect(mocks.href).toHaveBeenCalledWith(
    'sessions',
    expect.objectContaining({ attributionSource: '直接访问' }),
  );
});
it('localizes the selected unavailable retention placeholder while keeping audience names and option values', () => {
  mocks.context.filters = { segment: 'segment-a' };
  mocks.pending['retention-audiences'] = true;
  render(
    <LiekanLocaleContext.Provider value="en-US">
      <AnalyticsPages page="retention" />
    </LiekanLocaleContext.Provider>,
  );
  expect(screen.getByRole('option', { name: 'Selected segment (Loading)' })).toHaveValue(
    'segment:segment-a',
  );
  expect(screen.getByRole('option', { name: 'Selected segment (Loading)' })).toBeDisabled();
});
it('shows the current dimension selection and enforces the three dimension limit', async () => {
  render(<AnalyticsPages page="breakdown" />);
  fireEvent.click(screen.getByRole('button', { name: '选择维度' }));
  expect(screen.getByText('已选择 2 / 3 个维度')).toBeVisible();
  fireEvent.click(screen.getByRole('checkbox', { name: '浏览器' }));
  expect(screen.getByText('已选择 3 / 3 个维度')).toBeVisible();
  expect(screen.getByRole('checkbox', { name: '设备' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: '页面路径' }));
  expect(screen.getByRole('checkbox', { name: '设备' })).toBeEnabled();
});
it('keeps the current period and timezone visible while editing comparison dates', () => {
  mocks.context.range = {
    startAt: Date.UTC(2026, 8, 1),
    endAt: Date.UTC(2026, 8, 30),
    timezone: 'Asia/Shanghai',
  };
  render(<AnalyticsPages page="compare" />);
  fireEvent.click(screen.getByRole('button', { name: '调整对照期间' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Asia/Shanghai');
  expect(screen.getByRole('dialog')).toHaveTextContent('当前期间');
});
it('keeps a submitting annotation open until its request completes', async () => {
  let complete!: (value: any) => void;
  mocks.post.mockImplementation(() => new Promise(resolve => (complete = resolve)));
  const view = render(<AnalyticsPages page="annotations" />);
  fireEvent.click(screen.getByRole('button', { name: '添加注释' }));
  fireEvent.change(screen.getByLabelText('注释'), { target: { value: '待保存注释' } });
  fireEvent.submit(screen.getByLabelText('注释').closest('form')!);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  mocks.actionBusy = true;
  view.rerender(<AnalyticsPages page="annotations" />);
  fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
  const discard = screen.queryByRole('button', { name: '放弃修改并关闭' });
  if (discard) fireEvent.click(discard);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  complete({});
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('keeps retention observation cells fixed across midnight until an explicit month selection', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-10-09T23:59:59Z'));
    mocks.context.range = { startAt: Date.UTC(2026, 9, 1), endAt: Date.now(), timezone: 'UTC' };
    mocks.query.retention = [
      { date: '2026-10-08', day: 0, visitors: 10 },
      { date: '2026-10-08', day: 1, returnVisitors: 5 },
    ];
    const view = render(<AnalyticsPages page="retention" />);
    expect(screen.queryByRole('button', { name: /第 1 天，留存 50.00%/ })).not.toBeInTheDocument();
    vi.setSystemTime(new Date('2026-10-10T00:00:01Z'));
    view.rerender(<AnalyticsPages page="retention" />);
    expect(screen.queryByRole('button', { name: /第 1 天，留存 50.00%/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('月份'), { target: { value: '2026-09' } });
    fireEvent.change(screen.getByLabelText('月份'), { target: { value: '2026-10' } });
    expect(screen.getByRole('button', { name: /第 1 天，留存 50.00%/ })).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('keeps unavailable path completion distinct from a measured empty path', () => {
  mocks.context.query = { sequence: '["/","/done"]' };
  const population = populationFromRow(
    { eligibleEvents: 2, qualifiedEvents: 1, eligiblePV: 2, qualifiedPV: 1, qualifiedVisitors: 1 },
    { startAt: 1, endAt: 2, timezone: 'UTC' },
  );
  mocks.query['journey-rich'] = { rows: [], visitors: null, count: null, sessions: [], population };
  const view = render(<AnalyticsPages page="path-detail" />);
  expect(screen.getAllByText(identityUnavailableReason).length).toBeGreaterThan(0);
  expect(screen.queryByText('当前范围无匹配路径')).not.toBeInTheDocument();
  expect(
    screen.queryByText('当前条件没有匹配路径，请返回访问旅程调整条件。'),
  ).not.toBeInTheDocument();
  expect(screen.getByText('完成路径').parentElement).toHaveTextContent('—');
  mocks.query['journey-rich'] = {
    rows: [],
    visitors: 0,
    count: 0,
    sessions: [],
    population: { ...population, identity: { ...population.identity, status: 'empty' } },
  };
  view.rerender(<AnalyticsPages page="path-detail" />);
  expect(screen.getByText('完成路径').parentElement).toHaveTextContent('0');
  expect(screen.getByText('当前范围无匹配路径')).toBeInTheDocument();
});

it('keeps partial-identity session association details unavailable without false empty states', () => {
  mocks.context.route = { page: 'session-detail', id: 'fallback-session-id' };
  const population = populationFromRow(
    { eligibleEvents: 2, qualifiedEvents: 1, eligiblePV: 2, qualifiedPV: 1, qualifiedVisitors: 1 },
    { startAt: 1, endAt: 2, timezone: 'UTC' },
  );
  mocks.query['session-timeline'] = {
    rows: [],
    more: false,
    totals: {
      views: 2,
      events: 1,
      seconds: null,
      entryPath: null,
      exitPath: null,
      firstAt: null,
      lastAt: null,
      referrerDomain: null,
    },
    population,
  };
  mocks.query['session-record'] = { population, browser: 'Chrome' };
  mocks.query['session-props'] = [];
  mocks.query['session-replays'] = { data: [], count: null, population };
  render(<AnalyticsPages page="session-detail" />);
  expect(screen.queryByText(identityUnavailableReason)).not.toBeInTheDocument();
  expect(screen.queryByText('直接访问')).not.toBeInTheDocument();
  expect(screen.queryByText('当前范围没有访问行为。')).not.toBeInTheDocument();
  expect(screen.queryByText('当前会话未提供属性。')).not.toBeInTheDocument();
  expect(screen.queryByText('未采集回放')).not.toBeInTheDocument();
  expect(screen.queryByText(/fallback-session/)).not.toBeInTheDocument();
  expect(screen.getByText('页面访问').parentElement).toHaveTextContent('2');
});

it('preserves unavailable comparison channels and series as missing', () => {
  mocks.context.range = {
    startAt: Date.parse('2026-01-09T00:00:00Z'),
    endAt: Date.parse('2026-01-10T00:00:00Z') - 1,
    timezone: 'UTC',
  };
  const missing = populationFromRow(
    {
      resourceKind: 'website',
      metricScope: 'qualified-browser',
      eligibleEvents: 5,
      qualifiedEvents: 0,
      eligiblePV: 5,
      qualifiedPV: 0,
      qualifiedVisitors: 0,
    },
    {
      startAt: Date.parse('2026-01-08T00:00:00Z'),
      endAt: Date.parse('2026-01-09T00:00:00Z') - 1,
      timezone: 'UTC',
    },
  );
  mocks.query['compare-rich'] = {
    current: { pageviews: 2, visitors: 2, visits: 2, bounces: 1, totaltime: 10 },
    previous: {
      pageviews: 0,
      visitors: null,
      visits: null,
      bounces: null,
      totaltime: null,
      population: missing,
    },
    currentSeries: { sessions: [{ x: '2026-01-09', y: 2 }] },
    previousSeries: { sessions: [], population: missing },
    sources: { rows: [{ referrer: null, visitors: 2 }] },
    oldSources: { rows: [], population: missing },
    population: missing,
  };
  render(<AnalyticsPages page="compare" />);
  const row = screen.getByRole('cell', { name: '直接访问' }).closest('tr');
  expect(row).toHaveTextContent('—');
  expect(row).not.toHaveTextContent('新增');
  const chart = JSON.parse(screen.getByRole('img', { name: '同期访问趋势' }).textContent);
  expect(chart.series[1].values).toEqual([null]);
});

it('keeps a measured empty comparison period at zero and marks a new source', () => {
  mocks.context.range = {
    startAt: Date.parse('2026-01-09T00:00:00Z'),
    endAt: Date.parse('2026-01-10T00:00:00Z') - 1,
    timezone: 'UTC',
  };
  const missing = populationFromRow(
    {
      resourceKind: 'website',
      metricScope: 'qualified-browser',
      eligibleEvents: 0,
      qualifiedEvents: 0,
      eligiblePV: 0,
      qualifiedPV: 0,
      qualifiedVisitors: 0,
    },
    {
      startAt: Date.parse('2026-01-08T00:00:00Z'),
      endAt: Date.parse('2026-01-09T00:00:00Z') - 1,
      timezone: 'UTC',
    },
  );
  mocks.query['compare-rich'] = {
    current: { pageviews: 2, visitors: 2, visits: 2, bounces: 1, totaltime: 10 },
    previous: {
      pageviews: 0,
      visitors: null,
      visits: null,
      bounces: null,
      totaltime: null,
      population: missing,
    },
    currentSeries: { sessions: [{ x: '2026-01-09', y: 2 }] },
    previousSeries: { sessions: [], population: missing },
    sources: { rows: [{ referrer: null, visitors: 2 }] },
    oldSources: { rows: [], population: missing },
    population: missing,
  };
  render(<AnalyticsPages page="compare" />);
  const row = screen.getByRole('cell', { name: '直接访问' }).closest('tr');
  expect(row).toHaveTextContent('0');
  expect(row).toHaveTextContent('新增');
  const chart = JSON.parse(screen.getByRole('img', { name: '同期访问趋势' }).textContent);
  expect(chart.series[1].values).toEqual([0]);
});
