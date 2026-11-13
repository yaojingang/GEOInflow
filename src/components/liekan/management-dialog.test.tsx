import { crawlerCatalog } from '@/lib/liekan/crawlers/catalog';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManagementDrawer } from './ManagementDrawer';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/liekan/upstream/client', () => ({ useApi: () => api }));
vi.mock('@/lib/liekan/upstream/features-client', () => ({
  getFeaturePreferences: () => ({ timezone: 'Asia/Shanghai' }),
}));
const rule = {
  name: 'ExampleBot',
  vendor: 'Example',
  type: '搜索',
  pattern: 'ExampleBot',
  extension: 'retained',
};
const settings = { robots: 'User-agent: *\nAllow: /', allowlist: [], rules: [rule] };
it.each(['half_open', 'legacy_inclusive'] as const)('preserves selected dates when reopening a %s range', timeBoundary => {
  const onRange = vi.fn();
  const startAt = Date.parse('2026-09-30T16:00:00Z');
  const endAt = Date.parse('2026-10-23T16:00:00Z');
  render(<ManagementDrawer action="统计范围" websiteId="site-a" canManage={true}
    onClose={() => {}} onSaved={() => {}} onSearch={() => {}} onRange={onRange}
    report={{ contractVersion: 2, website: { id: 'site-a', name: 'Fixture', domain: 'example.test' },
      range: { startAt, endAt, timezone: 'Asia/Shanghai' },
      states: { human: 'empty', logs: 'empty', catalog: 'empty', goals: 'empty' }, cards: [], charts: {}, tables: {}, insights: [],
      meta: { demo: false, canManage: true, latestImportAt: null, ruleCount: 0,
        crawlerMetrics: { scope: 'all', version: 1, population: 'ai_qualified', timeBoundary } },
    }} />);
  expect(screen.getByLabelText('开始日期')).toHaveValue('2026-10-01');
  expect(screen.getByLabelText('结束日期')).toHaveValue(timeBoundary === 'half_open' ? '2026-10-23' : '2026-10-24');
  fireEvent.click(screen.getByRole('button', { name: '应用日期范围' }));
  expect(onRange).toHaveBeenCalledWith(startAt, timeBoundary === 'half_open' ? endAt - 1 : endAt + 86400000 - 1);
});
it('localizes the submit control of a canonical range dialog', () => {
  render(
    <LiekanLocaleContext.Provider value="en-US">
      <Mount action="统计范围" />
    </LiekanLocaleContext.Provider>,
  );
  expect(screen.getByRole('button', { name: 'Apply date range' })).toBeVisible();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it.each([401, 403, 404])('clears sensitive settings after reload status %s', async status => {
  render(<Mount action="robots.txt 编辑" />);
  const input = await screen.findByLabelText('robots.txt 内容');
  await waitFor(() => expect(input).toHaveValue(settings.robots));
  api.get.mockRejectedValueOnce(Object.assign(new Error('权限已变更'), { status }));
  fireEvent.click(screen.getByRole('button', { name: '重新读取设置' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('权限已变更');
  expect(input).toHaveValue('');
  expect(input).toBeDisabled();
});
beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockResolvedValue(settings);
});
it('protects a draft edited after a temporary reload failure', async () => {
  render(<Mount action="robots.txt 编辑" />);
  const input = await screen.findByLabelText('robots.txt 内容');
  await waitFor(() => expect(input).toHaveValue(settings.robots));
  api.get.mockRejectedValueOnce(Object.assign(new Error('暂时不可用'), { status: 503 }));
  fireEvent.click(screen.getByRole('button', { name: '重新读取设置' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时不可用');
  fireEvent.change(input, { target: { value: 'my recovery draft' } });
  expect(screen.getByRole('button', { name: '重新读取设置' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '重新读取设置' }));
  expect(input).toHaveValue('my recovery draft');
  expect(api.get).toHaveBeenCalledTimes(2);
});
function Mount({
  action,
  manage = true,
  onSaved = () => {},
}: {
  action: string;
  manage?: boolean;
  onSaved?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  return (
    open && (
      <ManagementDrawer
        centralCatalog={{ identities: crawlerCatalog } as any}
        action={action}
        websiteId="site-a"
        websiteName="演示网站"
        websiteDomain="example.test"
        canManage={manage}
        onClose={() => setOpen(false)}
        onSaved={onSaved}
        onSearch={() => {}}
        onRange={() => {}}
      />
    )
  );
}
it('keeps healthy settings idle, rereads on demand and preserves an editing draft', async () => {
  vi.useFakeTimers();
  render(<Mount action="robots.txt 编辑" />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(screen.getByLabelText('robots.txt 内容')).toHaveValue(settings.robots);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600000);
  });
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  expect(api.get).toHaveBeenCalledTimes(1);
  api.get.mockResolvedValue({ ...settings, robots: 'User-agent: *\nDisallow: /new' });
  fireEvent.click(screen.getByRole('button', { name: '重新读取设置' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  const input = screen.getByLabelText('robots.txt 内容');
  expect(input).toHaveValue('User-agent: *\nDisallow: /new');
  fireEvent.change(input, { target: { value: 'my unsaved draft' } });
  expect(screen.getByRole('button', { name: '重新读取设置' })).toBeDisabled();
  expect(input).toHaveValue('my unsaved draft');
  expect(api.get).toHaveBeenCalledTimes(2);
});
it('retries reading settings and keeps a failed save draft for correction', async () => {
  api.get.mockRejectedValueOnce(new Error('读取失败'));
  api.put.mockRejectedValueOnce(new Error('保存失败'));
  const user = userEvent.setup();
  render(<Mount action="robots.txt 编辑" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
  await user.click(screen.getByRole('button', { name: '重新读取设置' }));
  const input = await screen.findByLabelText('robots.txt 内容');
  await waitFor(() => expect(input).toHaveValue(settings.robots));
  await user.type(input, '\nDisallow: /private');
  await user.click(screen.getByRole('button', { name: '保存 robots.txt' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');
  expect(input).toHaveValue(settings.robots + '\nDisallow: /private');
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.getByRole('group', { name: '放弃未保存的修改？' })).toBeVisible();
});
it('validates CIDR with its line before invoking the write endpoint', async () => {
  const user = userEvent.setup();
  render(<Mount action="蜘蛛白名单" />);
  await waitFor(() => expect(screen.getByLabelText('CIDR 白名单')).toBeEnabled());
  await user.type(screen.getByLabelText('CIDR 白名单'), '192.0.2.0/24\ninvalid');
  await user.click(screen.getByRole('button', { name: '保存白名单' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('第 2 行 CIDR 无效');
  expect(api.put).not.toHaveBeenCalled();
});
it('preserves rule extensions while reordering and editing entries', async () => {
  api.get.mockResolvedValue({ ...settings, rules: [rule, { ...rule, name: 'Second' }] });
  api.put.mockImplementation(async (_, patch) => ({
    ...settings,
    ...patch,
    rules: patch.crawlerRules?.rules ?? settings.rules,
  }));
  const user = userEvent.setup();
  render(<Mount action="解析规则" />);
  const name = await screen.findByLabelText('第 1 条蜘蛛名称');
  await user.clear(name);
  await user.type(name, 'Renamed');
  await user.click(screen.getByRole('button', { name: '下移第 1 条规则' }));
  await user.click(screen.getByRole('button', { name: '保存识别规则' }));
  await waitFor(() => expect(api.put).toHaveBeenCalled());
  expect(api.put.mock.calls[0]).toEqual([
    '/liekan/websites/site-a/settings',
    {
      crawlerRules: {
        mode: 'legacy',
        rules: [
          { ...rule, name: 'Second' },
          { ...rule, name: 'Renamed' },
        ],
      },
      expectedRulesRevision: 0,
    },
  ]);
  expect(await screen.findByRole('status')).toHaveTextContent('共 2 条');
});
it('keeps invalid advanced JSON editable and rejects it without saving', async () => {
  api.get.mockResolvedValue({ ...settings, rules: [{ ...rule, type: { invalid: true } }] });
  const user = userEvent.setup();
  render(<Mount action="特征库管理" />);
  const input = await screen.findByLabelText('规则 JSON');
  await waitFor(() => expect(input).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '保存识别规则' }));
  expect(await screen.findByText(/第 1 条规则的类型须为/)).toBeVisible();
  expect(api.put).not.toHaveBeenCalled();
  expect(input).toHaveValue(JSON.stringify([{ ...rule, type: { invalid: true } }], null, 2));
});
it('shows accepted, new, duplicate, rejected counts and original row errors after partial import', async () => {
  api.post.mockResolvedValue({
    accepted: 2,
    inserted: 1,
    rejected: 1,
    duplicate: false,
    errors: [{ line: 3, reason: '状态码无效' }],
  });
  const user = userEvent.setup();
  render(<Mount action="导入日志" />);
  await user.type(screen.getByLabelText('访问日志内容'), 'example combined lines');
  await user.click(screen.getByRole('button', { name: '导入日志' }));
  const result = await screen.findByRole('status');
  expect(result).toHaveTextContent('校验通过 2 条 · 新增 1 条 · 重复 1 条 · 拒绝 1 条');
  expect(within(result).getByRole('cell', { name: '3' })).toBeVisible();
  expect(within(result).getByRole('cell', { name: '状态码无效' })).toBeVisible();
  expect(screen.getByRole('dialog', { name: '导入访问日志' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('preserves an import draft when switching to query and back', async () => {
  const user = userEvent.setup();
  render(<Mount action="日志查询" />);
  await user.click(screen.getByRole('tab', { name: '导入日志' }));
  await user.type(screen.getByLabelText('访问日志内容'), 'draft');
  await user.click(screen.getByRole('tab', { name: '查询记录' }));
  await user.click(screen.getByRole('tab', { name: '导入日志' }));
  expect(screen.getByLabelText('访问日志内容')).toHaveValue('draft');
  await user.keyboard('{Escape}');
  expect(screen.getByRole('group', { name: '放弃未保存的修改？' })).toBeVisible();
});
it('preserves an unapplied query when switching to import and back', async () => {
  const user = userEvent.setup();
  render(<Mount action="日志查询" />);
  const input = screen.getByLabelText('查询关键词');
  await user.type(input, 'draft query');
  await user.click(screen.getByRole('tab', { name: '导入日志' }));
  await user.click(screen.getByRole('tab', { name: '查询记录' }));
  expect(screen.getByLabelText('查询关键词')).toHaveValue('draft query');
});
it('locks log operation tabs through import and report refresh', async () => {
  let finishImport!: (result: any) => void;
  let finishRefresh!: () => void;
  const imported = new Promise(resolve => (finishImport = resolve));
  const refreshed = new Promise<void>(resolve => (finishRefresh = resolve));
  const result = { accepted: 1, inserted: 1, rejected: 0, duplicate: false, errors: [] };
  api.post.mockReturnValueOnce(imported);
  const onSaved = vi.fn(() => refreshed);
  const user = userEvent.setup();
  render(<Mount action="日志查询" onSaved={onSaved} />);
  await user.click(screen.getByRole('tab', { name: '导入日志' }));
  await user.type(screen.getByLabelText('访问日志内容'), 'record');
  await user.click(screen.getByRole('button', { name: '导入日志' }));
  try {
    expect(screen.getByRole('tab', { name: '查询记录' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: '导入日志' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: '查询记录' }));
    expect(screen.getByRole('tab', { name: '导入日志' })).toHaveAttribute('aria-selected', 'true');
    finishImport(result);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('tab', { name: '查询记录' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: '导入日志' })).toBeDisabled();
  } finally {
    finishImport(result);
    finishRefresh();
  }
  await waitFor(() => expect(screen.getByRole('tab', { name: '查询记录' })).toBeEnabled());
  expect(screen.getByRole('tab', { name: '导入日志' })).toBeEnabled();
});
it('keeps an imported draft saved after an attempted tab switch during the request', async () => {
  let finishImport!: (result: any) => void;
  api.post.mockReturnValueOnce(new Promise(resolve => (finishImport = resolve)));
  const user = userEvent.setup();
  render(<Mount action="日志查询" />);
  await user.click(screen.getByRole('tab', { name: '导入日志' }));
  await user.type(screen.getByLabelText('访问日志内容'), 'record');
  await user.click(screen.getByRole('tab', { name: '查询记录' }));
  await user.click(screen.getByRole('tab', { name: '导入日志' }));
  await user.click(screen.getByRole('button', { name: '导入日志' }));
  await user.click(screen.getByRole('tab', { name: '查询记录' }));
  finishImport({ accepted: 1, inserted: 1, rejected: 0, duplicate: false, errors: [] });
  await waitFor(() => expect(screen.getByRole('tab', { name: '查询记录' })).toBeEnabled());
  await screen.findByRole('status');
  await user.click(screen.getByRole('tab', { name: '查询记录' }));
  await user.click(screen.getByRole('tab', { name: '导入日志' }));
  expect(screen.getByLabelText('访问日志内容')).toHaveValue('record');
  expect(screen.getByLabelText('访问日志内容').closest('form')).toHaveAttribute(
    'data-unsaved',
    'false',
  );
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('unlocks operation tabs and preserves an import draft after failure', async () => {
  api.post.mockRejectedValueOnce(new Error('导入失败'));
  const user = userEvent.setup();
  render(<Mount action="日志查询" />);
  await user.click(screen.getByRole('tab', { name: '导入日志' }));
  await user.type(screen.getByLabelText('访问日志内容'), 'record');
  await user.click(screen.getByRole('button', { name: '导入日志' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('导入失败');
  expect(screen.getByRole('tab', { name: '查询记录' })).toBeEnabled();
  expect(screen.getByRole('tab', { name: '导入日志' })).toBeEnabled();
  await user.click(screen.getByRole('tab', { name: '查询记录' }));
  await user.click(screen.getByRole('tab', { name: '导入日志' }));
  expect(screen.getByLabelText('访问日志内容')).toHaveValue('record');
  await user.keyboard('{Escape}');
  expect(screen.getByRole('group', { name: '放弃未保存的修改？' })).toBeVisible();
});
it('keeps website settings readable with no write affordance for a viewer', async () => {
  render(<Mount action="robots.txt 编辑" manage={false} />);
  await waitFor(() =>
    expect(screen.getByLabelText('robots.txt 内容')).toHaveValue(settings.robots),
  );
  expect(screen.getByRole('button', { name: '保存 robots.txt' })).toBeDisabled();
  expect(screen.getByLabelText('robots.txt 内容')).toBeDisabled();
  expect(api.put).not.toHaveBeenCalled();
});

it('keeps saved settings locked until the report refresh completes', async () => {
  let finish!: () => void;
  const onSaved = vi.fn(() => new Promise<void>(resolve => (finish = resolve)));
  api.put.mockImplementation(async (_, patch) => ({
    ...settings,
    ...patch,
    rules: patch.crawlerRules?.rules ?? settings.rules,
  }));
  const user = userEvent.setup();
  render(<Mount action="robots.txt 编辑" onSaved={onSaved} />);
  await waitFor(() => expect(screen.getByLabelText('robots.txt 内容')).toBeEnabled());
  await user.type(screen.getByLabelText('robots.txt 内容'), '\nDisallow: /draft');
  await user.click(screen.getByRole('button', { name: '保存 robots.txt' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  try {
    expect(screen.getByLabelText('robots.txt 内容')).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  } finally {
    finish();
  }
  await waitFor(() => expect(screen.getByLabelText('robots.txt 内容')).toBeEnabled());
});
it('saves official enable and type overrides with a revision and token-based custom rules', async () => {
  const crawlerRules = { mode: 'official', disabledIds: [], overrides: {}, customRules: [] };
  api.get.mockResolvedValue({ ...settings, crawlerRules, rulesRevision: 7 });
  api.put.mockImplementation(async (_, patch) => ({ ...settings, ...patch }));
  render(<Mount action="特征库管理" />);
  fireEvent.click(await screen.findByLabelText('启用 GPTBot'));
  fireEvent.change(screen.getByLabelText('OAI-SearchBot 类型'), { target: { value: '其他' } });
  fireEvent.click(screen.getByRole('button', { name: '添加识别规则' }));
  fireEvent.change(screen.getByLabelText('自定义第 1 条蜘蛛名称'), {
    target: { value: 'PrivateBot' },
  });
  fireEvent.change(screen.getByLabelText('自定义第 1 条厂商'), { target: { value: 'Private' } });
  fireEvent.change(screen.getByLabelText('自定义第 1 条 UA 匹配词'), {
    target: { value: 'PrivateBot' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存识别规则' }));
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith('/liekan/websites/site-a/settings', {
      expectedRulesRevision: 7,
      crawlerRules: {
        mode: 'official',
        disabledIds: ['gptbot'],
        overrides: { 'oai-searchbot': { type: '其他' } },
        customRules: [
          {
            name: 'PrivateBot',
            vendor: 'Private',
            type: '其他',
            pattern: 'PrivateBot',
            matchMode: 'token',
          },
        ],
      },
    }),
  );
});
it('converts legacy rules only after the displayed preview is acknowledged', async () => {
  api.get.mockResolvedValue({
    ...settings,
    crawlerRules: { mode: 'legacy', rules: [rule] },
    rulesRevision: 3,
  });
  api.put.mockImplementation(async (_, patch) => ({ ...settings, ...patch }));
  render(<Mount action="特征库管理" />);
  fireEvent.click(await screen.findByRole('button', { name: '预览转换为官方目录' }));
  expect(screen.getByRole('button', { name: '确认转换草稿' })).toBeDisabled();
  expect(screen.getByLabelText('规则转换预览')).toHaveTextContent('ExampleBot');
  expect(api.put).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('已核对转换差异与匹配行为变化'));
  fireEvent.click(screen.getByRole('button', { name: '确认转换草稿' }));
  expect(api.put).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存识别规则' }));
  await waitFor(() => expect(api.put).toHaveBeenCalled());
  expect(api.put.mock.calls[0][1]).toMatchObject({
    expectedRulesRevision: 3,
    conversionConfirmed: true,
    crawlerRules: {
      mode: 'official',
      customRules: [
        {
          name: rule.name,
          vendor: rule.vendor,
          type: rule.type,
          pattern: rule.pattern,
          matchMode: 'literal',
        },
      ],
    },
  });
});
it('keeps rule policy absent from unrelated robots writes', async () => {
  api.get.mockResolvedValue({
    ...settings,
    crawlerRules: { mode: 'official', disabledIds: [], overrides: {}, customRules: [] },
    rulesRevision: 4,
  });
  api.put.mockImplementation(async (_, patch) => ({ ...settings, ...patch }));
  render(<Mount action="robots.txt 编辑" />);
  const textarea = await screen.findByLabelText('robots.txt 内容');
  fireEvent.change(textarea, { target: { value: 'User-agent: *\nDisallow: /private' } });
  fireEvent.click(screen.getByRole('button', { name: '保存 robots.txt' }));
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith('/liekan/websites/site-a/settings', {
      robots: 'User-agent: *\nDisallow: /private',
    }),
  );
});

it.each(['pending', 'failed'] as const)(
  'keeps independent log paging available when count is %s',
  count => {
    const onPage = vi.fn();
    render(
      <ManagementDrawer
        action="日志查询"
        websiteId="site-a"
        canManage={true}
        onClose={() => {}}
        onSaved={() => {}}
        onSearch={() => {}}
      onRange={() => {}}
        onPage={onPage}
        isFetching={false}
        report={{
          contractVersion: 2,
          website: { id: 'site-a', name: 'Fixture', domain: 'example.test' },
          range: { startAt: 1, endAt: 1000, timezone: 'UTC' },
          states: { human: 'empty', logs: 'available', catalog: 'empty', goals: 'empty' },
          cards: [],
          charts: {},
          tables: { logBody: [{ path: '/available' }] },
          insights: [],
          meta: {
            demo: false,
            canManage: true,
            ruleCount: 0,
            latestImportAt: null,
            logReadBoundary: 'a'.repeat(64),
            logHasMore: true,
            logParts: { count, summary: 'ready' },
            page: 1,
            pageSize: 100,
          },
        }}
      />,
    );
    expect(screen.queryByText(/共 1 条/)).not.toBeInTheDocument();
    expect(
      screen.getByText(count === 'pending' ? '正在读取记录…' : '无法读取此范围的数据'),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(onPage).toHaveBeenCalledWith(2);
  },
);
