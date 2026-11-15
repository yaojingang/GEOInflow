import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';
import { crawlerCatalog } from '@/lib/liekan/crawlers/catalog';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ManagementDrawer } from './ManagementDrawer';
import {
  FilterChip,
  LiveStatus,
  MetricCard,
  ReportList,
  ReportRows,
  SortHeading,
} from './ReportComponents';
import { type ReportActions, ReportContext } from './ReportContext';
import type { LiekanReport } from './types';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/liekan/upstream/client', () => ({ useApi: () => api }));
function report(): LiekanReport {
  return {
    contractVersion: 2,
    website: { id: 'site', name: '站点', domain: 'example.test' },
    range: { startAt: 1, endAt: 2, timezone: 'Asia/Shanghai' },
    states: {
      human: 'not_connected',
      logs: 'not_connected',
      catalog: 'not_connected',
      goals: 'not_connected',
    },
    cards: [{ key: 'requests', label: '今日总请求', value: null, state: 'not_connected' }],
    charts: {},
    tables: {},
    insights: [],
    meta: { demo: false, canManage: true, latestImportAt: null, ruleCount: 0 },
  };
}
const actions = (): ReportActions => ({
  filter: '',
  query: '',
  sort: { label: '', direction: -1 },
  period: '30 天',
  onFilter: vi.fn(),
  onSort: vi.fn(),
  onAction: vi.fn(),
});
describe('real data states and interactions', () => {
  it('keeps an unconnected metric empty and never adds source sample values', () => {
    render(<MetricCard label="今日总请求" className="card" valueClass="num" report={report()} />);
    expect(screen.getByText('–')).toBeInTheDocument();
    expect(screen.getByText('待接入')).toBeInTheDocument();
    expect(screen.queryByText('18,642')).not.toBeInTheDocument();
  });
  it('shows the shared Today cutoff in both locales independently of the selected report range', () => {
    const data = report();
    data.cards[0] = { ...data.cards[0], value: 55, state: 'available' };
    data.meta.todayRequests = {
      state: 'updating',
      range: { startAt: 1, endAt: 2, timezone: 'Asia/Shanghai' },
      intervalMs: 600000,
      dataThrough: Date.parse('2026-11-14T01:02:03Z'),
    };
    const { rerender } = render(
      <LiekanLocaleContext.Provider value="zh-CN">
        <MetricCard label="今日总请求" className="card" valueClass="num" report={data} />
      </LiekanLocaleContext.Provider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('2026/11/14 09:02:03');
    expect(screen.getByText('55')).toBeVisible();
    rerender(
      <LiekanLocaleContext.Provider value="en-US">
        <MetricCard label="今日总请求" className="card" valueClass="num" report={data} />
      </LiekanLocaleContext.Provider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('11/14/2026');
    expect(screen.getByRole('status')).not.toHaveTextContent('数据截至');
  });

  it('preserves table columns while showing the missing data state', () => {
    render(
      <ReportContext.Provider value={actions()}>
        <table>
          <ReportRows table="topBody" report={report()} />
        </table>
      </ReportContext.Provider>,
    );
    expect(screen.getByText('待接入').closest('td')).toHaveAttribute('colspan', '6');
  });
  it('keeps recent crawl rows at the reference limit and compacts real timestamps', () => {
    const data = report();
    data.tables.pathList = Array.from({ length: 12 }, (_, i) => ({
      time: '2026-10-01T04:04:01.000Z',
      path: `/real-page-${i}`,
      status: 200,
    }));
    render(<ReportList id="pathList" className="" report={data} />);
    expect(screen.getAllByText('12:04:01')).toHaveLength(7);
    expect(screen.queryByText('/real-page-7')).not.toBeInTheDocument();
    expect(screen.queryByText('2026-10-01T04:04:01.000Z')).not.toBeInTheDocument();
  });
  it('uses keyboard-native buttons for period and table sort actions', () => {
    const handlers = actions();
    render(
      <ReportContext.Provider value={handlers}>
        <FilterChip label="7 天" />
        <table>
          <thead>
            <tr>
              <SortHeading label="浏览 PV" className="" />
            </tr>
          </thead>
        </table>
      </ReportContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '7 天' }));
    expect(handlers.onFilter).toHaveBeenCalledWith('7 天');
    fireEvent.click(screen.getByRole('button', { name: '浏览 PV' }));
    expect(handlers.onSort).toHaveBeenCalledWith('浏览 PV');
  });
  it('provides the complete User-Agent on truncated log cells', () => {
    const data = report();
    data.tables.logBody = [
      {
        userAgent: 'Complete real User-Agent with additional identity evidence',
        path: '/actual',
        method: 'GET',
      },
    ];
    render(
      <ReportContext.Provider value={actions()}>
        <table>
          <ReportRows table="logBody" report={data} />
        </table>
      </ReportContext.Provider>,
    );
    expect(
      screen.getByText('Complete real User-Agent with additional identity evidence').closest('td'),
    ).toHaveAttribute('title', 'Complete real User-Agent with additional identity evidence');
  });
  it('shows only selected page metrics in the seven-day comparison dialog', () => {
    const data = report();
    data.cards = [
      { key: 'uv', label: '访客数 UV', value: 4, state: 'available' },
      { key: 'today', label: '今日转化', value: 10, state: 'available' },
      { key: 'unrelated', label: '识别 AI 蜘蛛', value: 3, state: 'available' },
    ];
    render(
      <ManagementDrawer
        centralCatalog={{ identities: crawlerCatalog } as any}
        action="对比上周"
        websiteId="site"
        canManage
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onSearch={vi.fn()}
        onRange={vi.fn()}
        comparison={{
          current: data,
          previous: data,
          startAt: Date.parse('2026-09-01T00:00:00Z'),
          endAt: Date.parse('2026-09-30T00:00:00Z'),
          previousStartAt: Date.parse('2026-08-25T00:00:00Z'),
          previousEndAt: Date.parse('2026-09-23T00:00:00Z'),
          labels: ['访客数 UV'],
        }}
      />,
    );
    expect(screen.getByText('访客数 UV')).toBeInTheDocument();
    expect(screen.queryByText('今日转化')).not.toBeInTheDocument();
    expect(screen.queryByText('识别 AI 蜘蛛')).not.toBeInTheDocument();
    expect(screen.getByText(/整体前移 7 天/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存 robots.txt' })).not.toBeInTheDocument();
  });
  it('retries a failed comparison and clears the loading state after recovery', () => {
    const data = report();
    data.cards = [{ key: 'uv', label: '访客数 UV', value: 4, state: 'available' }];
    const refetch = vi.fn();
    const props = {
      action: '对比上周',
      websiteId: 'site',
      canManage: true,
      onClose: vi.fn(),
      onSaved: vi.fn(),
      onSearch: vi.fn(),
      onRange: vi.fn(),
    };
    const comparison = {
      current: data,
      startAt: Date.parse('2026-09-01T00:00:00Z'),
      endAt: Date.parse('2026-09-30T00:00:00Z'),
      previousStartAt: Date.parse('2026-08-25T00:00:00Z'),
      previousEndAt: Date.parse('2026-09-23T00:00:00Z'),
      labels: ['访客数 UV'],
      error: new Error('Network unavailable'),
      fetching: false,
      refetch,
    };
    const { rerender } = render(<ManagementDrawer {...props} comparison={comparison} />);
    expect(screen.getByRole('alert')).toHaveTextContent('上周数据读取失败');
    expect(screen.queryByText('正在读取上周数据…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    expect(refetch).toHaveBeenCalledOnce();
    rerender(<ManagementDrawer {...props} comparison={{ ...comparison, fetching: true }} />);
    expect(screen.getByText('正在读取上周数据…')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('button', { name: '重新读取' })).not.toBeInTheDocument();
    rerender(
      <ManagementDrawer {...props} comparison={{ ...comparison, error: null, previous: data }} />,
    );
    expect(screen.getAllByRole('cell', { name: '4' })[1]).toBeInTheDocument();
    expect(screen.queryByText('正在读取上周数据…')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('keeps keyboard focus inside the dialog from both ends', async () => {
    const user = userEvent.setup();
    render(
      <ManagementDrawer
        centralCatalog={{ identities: crawlerCatalog } as any}
        action="sitemap 管理"
        websiteId="site"
        canManage
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onSearch={vi.fn()}
        onRange={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog');
    const first = screen.getByRole('button', { name: '关闭弹窗' });
    const last = screen.getByRole('button', { name: '导入页面目录' });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    last.focus();
    await user.tab();
    await waitFor(() => expect(first).toHaveFocus());
    await user.tab({ shift: true });
    await waitFor(() => expect(last).toHaveFocus());
  });
  it('saves only local robots settings and offers a download action', async () => {
    api.get.mockResolvedValue({ robots: 'User-agent: *\nAllow: /', allowlist: [], rules: [] });
    api.put.mockResolvedValue({
      robots: 'User-agent: *\nDisallow: /private',
      allowlist: [],
      rules: [],
    });
    const onSaved = vi.fn();
    render(
      <ManagementDrawer
        centralCatalog={{ identities: crawlerCatalog } as any}
        action="robots.txt 编辑"
        websiteId="site"
        canManage
        onClose={vi.fn()}
        onSaved={onSaved}
        onSearch={vi.fn()}
        onRange={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('User-agent: *\nAllow: /'));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'User-agent: *\nDisallow: /private' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存 robots.txt' }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/liekan/websites/site/settings', {
        robots: 'User-agent: *\nDisallow: /private',
      }),
    );
    expect(onSaved).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '下载 robots.txt' })).toBeInTheDocument();
  });
  it.each([
    ['蜘蛛白名单', '192.0.2.0/24', { allowlist: ['192.0.2.0/24'] }],
    ['特征库管理', '[]', { crawlerRules: { mode: 'legacy', rules: [] }, expectedRulesRevision: 7 }],
    ['解析规则', '[]', { crawlerRules: { mode: 'legacy', rules: [] }, expectedRulesRevision: 7 }],
  ])(
    'sends a scoped versioned update from %s and displays the authoritative saved response',
    async (action, content, patch) => {
      api.get.mockResolvedValue({
        robots: 'User-agent: *',
        allowlist: [],
        rules: [{ name: 'OldBot', vendor: 'Fixture', type: '搜索', pattern: 'OldBot' }],
        crawlerRules: {
          mode: 'legacy',
          rules: [{ name: 'OldBot', vendor: 'Fixture', type: '搜索', pattern: 'OldBot' }],
        },
        rulesRevision: 7,
        isDemo: true,
      });
      const returned = {
        robots: 'Changed elsewhere',
        allowlist: ['198.51.100.0/24'],
        rules: [],
        crawlerRules: { mode: 'legacy', rules: [] },
        rulesRevision: 8,
        isDemo: true,
      };
      api.put.mockResolvedValue(returned);
      render(
        <ManagementDrawer
          centralCatalog={{ identities: crawlerCatalog } as any}
          action={action}
          websiteId="site"
          canManage
          onClose={vi.fn()}
          onSaved={vi.fn()}
          onSearch={vi.fn()}
          onRange={vi.fn()}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByRole('button', {
            name: action === '蜘蛛白名单' ? '保存白名单' : '保存识别规则',
          }),
        ).not.toBeDisabled(),
      );
      if (action !== '蜘蛛白名单')
        fireEvent.click(screen.getByRole('button', { name: '高级 JSON 编辑' }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: content } });
      fireEvent.click(
        screen.getByRole('button', {
          name: action === '蜘蛛白名单' ? '保存白名单' : '保存识别规则',
        }),
      );
      await waitFor(() =>
        expect(api.put).toHaveBeenCalledWith('/liekan/websites/site/settings', patch),
      );
      expect(screen.getByRole('textbox')).toHaveValue(
        action === '蜘蛛白名单' ? returned.allowlist.join('\n') : '[]',
      );
      expect(await screen.findByRole('status')).toHaveTextContent('已保存');
    },
  );
  it('imports JSON logs through the query dialog with explicit format and records', async () => {
    api.post.mockResolvedValue({
      accepted: 1,
      inserted: 1,
      rejected: 0,
      duplicate: false,
      errors: [],
    });
    render(
      <ManagementDrawer
        centralCatalog={{ identities: crawlerCatalog } as any}
        action="日志查询"
        websiteId="site"
        canManage
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onSearch={vi.fn()}
        onRange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: '导入日志' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'json' } });
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '[{"path":"/product","status":200}]' },
    });
    fireEvent.click(screen.getByRole('button', { name: '导入日志' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/liekan/websites/site/logs/import', {
        format: 'json',
        records: [{ path: '/product', status: 200 }],
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      '校验通过 1 条 · 新增 1 条 · 重复 0 条 · 拒绝 0 条',
    );
  });
  it('reports partial log imports and duplicate batches with sanitized line errors', async () => {
    const errors = [{ line: 2, reason: '格式、时间、IP 或站点 URL 无效' }];
    api.post
      .mockResolvedValueOnce({ accepted: 2, inserted: 1, rejected: 1, duplicate: false, errors })
      .mockResolvedValueOnce({ accepted: 2, inserted: 0, rejected: 1, duplicate: true, errors });
    const onSaved = vi.fn();
    render(
      <ManagementDrawer
        centralCatalog={{ identities: crawlerCatalog } as any}
        action="日志查询"
        websiteId="site"
        canManage
        onClose={vi.fn()}
        onSaved={onSaved}
        onSearch={vi.fn()}
        onRange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: '导入日志' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'json' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '[{},{},{}]' } });
    fireEvent.click(screen.getByRole('button', { name: '导入日志' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        '新增 1 条 · 重复 1 条 · 拒绝 1 条，部分记录未导入。',
      ),
    );
    expect(within(screen.getByRole('status')).getByRole('cell', { name: '2' })).toBeVisible();
    expect(
      within(screen.getByRole('status')).getByRole('cell', {
        name: '格式、时间、IP 或站点 URL 无效',
      }),
    ).toBeVisible();
    expect(screen.getByRole('status')).not.toHaveTextContent('已保存');
    expect(onSaved).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '导入日志' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        '新增 0 条 · 重复 2 条 · 拒绝 1 条，部分记录未导入。',
      ),
    );
    expect(
      within(screen.getByRole('status')).getAllByRole('cell', {
        name: '格式、时间、IP 或站点 URL 无效',
      }),
    ).toHaveLength(1);
    expect(onSaved).toHaveBeenCalledTimes(2);
  });
  it('reports the actual accepted page count after a catalog upsert', async () => {
    api.put.mockResolvedValue({ accepted: 3, mode: 'upsert' });
    render(
      <ManagementDrawer
        centralCatalog={{ identities: crawlerCatalog } as any}
        action="sitemap 管理"
        websiteId="site"
        canManage
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onSearch={vi.fn()}
        onRange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'json' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '[{"path":"/actual"}]' } });
    fireEvent.click(screen.getByRole('button', { name: '导入页面目录' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('已新增或更新 3 个页面'),
    );
    expect(api.put).toHaveBeenCalledWith('/liekan/websites/site/catalog', {
      format: 'json',
      content: '[{"path":"/actual"}]',
    });
  });
});

it('keeps saved configuration locked until its report refresh completes', async () => {
  const settings = { robots: 'User-agent: *', allowlist: [], rules: [] };
  api.get.mockResolvedValue(settings);
  api.put.mockResolvedValue(settings);
  let finish!: () => void;
  const updating = new Promise<void>(resolve => {
    finish = resolve;
  });
  const onSaved = vi.fn(() => updating);
  render(
    <ManagementDrawer
      centralCatalog={{ identities: crawlerCatalog } as any}
      action="robots.txt 编辑"
      websiteId="site"
      canManage
      onClose={vi.fn()}
      onSaved={onSaved}
      onSearch={vi.fn()}
      onRange={vi.fn()}
    />,
  );
  const input = await screen.findByRole('textbox');
  await waitFor(() => expect(input).toBeEnabled());
  const save = screen.getByRole('button', { name: '保存 robots.txt' });
  fireEvent.click(save);
  await screen.findByText('robots.txt 已保存到当前网站设置。下载后部署到网站根目录。');
  expect(onSaved).toHaveBeenCalledOnce();
  expect(input).toBeDisabled();
  expect(save).toBeDisabled();
  await act(async () => finish());
  await waitFor(() => expect(input).toBeEnabled());
  expect(save).toBeEnabled();
});

it('preserves write confirmation when the follow-up refresh fails', async () => {
  const settings = { robots: 'User-agent: *', allowlist: [], rules: [] };
  api.get.mockResolvedValue(settings);
  api.put.mockResolvedValue(settings);
  const onSaved = vi.fn(async () => {
    throw new Error('identity refresh unavailable');
  });
  render(
    <ManagementDrawer
      centralCatalog={{ identities: crawlerCatalog } as any}
      action="robots.txt 编辑"
      websiteId="site"
      canManage
      onClose={vi.fn()}
      onSaved={onSaved}
      onSearch={vi.fn()}
      onRange={vi.fn()}
    />,
  );
  const input = await screen.findByRole('textbox');
  await waitFor(() => expect(input).toBeEnabled());
  const save = screen.getByRole('button', { name: '保存 robots.txt' });
  fireEvent.click(save);
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent(
      'robots.txt 已保存到当前网站设置。下载后部署到网站根目录。',
    ),
  );
  expect(screen.getByRole('status')).toHaveTextContent('页面状态刷新失败');
  expect(input).toBeEnabled();
});

it('keeps empty connected log ranges refreshing and distinguishes missing input', () => {
  const input = report();
  input.states.logs = 'empty';
  const view = render(<LiveStatus report={input} live />);
  expect(screen.getByText('本次快照')).toBeInTheDocument();
  view.rerender(<LiveStatus report={input} />);
  expect(screen.getByText('历史快照')).toBeInTheDocument();
  input.states.logs = 'not_connected';
  view.rerender(<LiveStatus report={input} />);
  expect(screen.getByText('待接入')).toBeInTheDocument();
});
