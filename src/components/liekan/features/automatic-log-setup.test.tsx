import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { AutomaticLogSetup } from './AutomaticLogSetup';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';
const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  notify: vi.fn(),
  query: {} as any,
  user: { isAdmin: true },
}));
vi.mock('./context', () => ({ useFeature: () => mocks }));
const site = '5b4c0de0-6c47-5b51-8f53-11e5e8c79001';
const refresh = vi.fn().mockResolvedValue({});
const status: any = { capabilities: { server: true, cloudflare: true }, sources: [] };
it.each([
  ['zh-CN', 'provider-not-entitled', /尚未启用.*Logpush/],
  ['en-US', 'provider-not-entitled', /has not enabled.*Logpush/],
  ['zh-CN', 'provider-permission-denied', /缺少日志管理权限/],
  ['en-US', 'provider-permission-denied', /missing log management permissions/],
] as const)(
  'explains %s %s without misleading authorization-expired advice',
  (locale, errorCode, message) => {
    render(
      <LiekanLocaleContext.Provider value={locale}>
        <AutomaticLogSetup
          websiteId={site}
          method="cloudflare"
          manage
          refresh={refresh}
          status={{
            ...status,
            sources: [
              {
                id: 'source',
                kind: 'cloudflare',
                domain: 'example.com',
                state: 'paused',
                primary: false,
                errorCode,
                health: {},
              },
            ],
          }}
        />
      </LiekanLocaleContext.Provider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('alert')).not.toHaveTextContent('授权或网站配置已变更');
  },
);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query = {};
  mocks.user = { isAdmin: true };
});
it.each(['server', 'cloudflare'] as const)(
  'guides configuration in place for unavailable %s',
  async method => {
    mount(method, {
      ...status,
      capabilities: { server: false, cloudflare: false },
      availability: {
        [method]: {
          reason: '管理员尚未配置公网 HTTPS 接收地址',
          checks: [
            { id: 'public-url', state: 'missing' },
            { id: 'queue', state: 'ready' },
            { id: 'worker', state: 'ready' },
            ...(method === 'server'
              ? [{ id: 'agent-package', state: 'ready' }]
              : [
                  { id: 'cloudflare-oauth', state: 'missing' },
                  { id: 'credentials-key', state: 'missing' },
                ]),
          ],
        },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始配置' }));
    expect(screen.getByRole('textbox', { name: '统计服务公网地址' })).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: '统计服务公网地址' }), {
      target: { value: 'http://localhost:3002' },
    });
    expect(screen.getByRole('button', { name: '复制地址配置' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '统计服务公网地址' }), {
      target: { value: 'https://stats.example.com' },
    });
    expect(screen.getByText('LIEKAN_PUBLIC_URL=https://stats.example.com')).toBeVisible();
    expect(screen.getByRole('button', { name: '复制地址配置' })).toBeEnabled();
    if (method === 'cloudflare')
      expect(
        screen.getByText('https://stats.example.com/api/liekan/oauth/cloudflare/callback'),
      ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重新检查配置' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(mocks.api.post).not.toHaveBeenCalled();
  },
);
function mount(method: 'server' | 'cloudflare', data = status) {
  return render(
    <StrictMode>
      <AutomaticLogSetup websiteId={site} method={method} status={data} manage refresh={refresh} />
    </StrictMode>,
  );
}
it('confirms disconnection in the product dialog and preserves the connection on cancel or failure', async () => {
  const source = {
    id: 'source-a',
    kind: 'server',
    domain: 'example.com',
    state: 'connected',
    primary: true,
    health: {},
  };
  mocks.api.del.mockRejectedValueOnce(new Error('连接断开失败')).mockResolvedValueOnce({});
  const user = userEvent.setup();
  mount('server', { ...status, sources: [source] });
  const trigger = screen.getByRole('button', { name: '断开连接' });
  await user.click(trigger);
  expect(screen.getByRole('dialog', { name: '断开日志连接' })).toHaveTextContent(
    '历史数据继续保留',
  );
  await user.click(screen.getByRole('button', { name: '保留连接' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(mocks.api.del).not.toHaveBeenCalled();
  await user.click(trigger);
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '断开连接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('连接断开失败');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '断开连接' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(mocks.api.del).toHaveBeenCalledWith(`/liekan/websites/${site}/log-sources/source-a`);
  expect(refresh).toHaveBeenCalled();
});
it('generates the installation command in Strict Mode and guides an unavailable receiver', async () => {
  mocks.api.post.mockResolvedValue({
    command: 'signed-install-command',
    expiresAt: '2026-10-04T12:00:00Z',
  });
  const view = mount('server');
  fireEvent.click(screen.getByRole('button', { name: '生成一次安装命令' }));
  expect(await screen.findByText('signed-install-command')).toBeVisible();
  expect(mocks.api.post).toHaveBeenCalledWith(
    `/liekan/websites/${site}/log-sources/server/pairing`,
    { runtime: 'docker' },
  );
  view.unmount();
  mount('server', {
    ...status,
    capabilities: { server: false },
    availability: { server: { reason: '请配置公网 HTTPS 地址' } },
  });
  expect(screen.getByText('请配置公网 HTTPS 地址')).toBeVisible();
  expect(screen.queryByRole('button', { name: '生成一次安装命令' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '开始配置' })).toBeEnabled();
});
it('uses Docker by default and retains the supported direct-install path', async () => {
  mocks.api.post.mockResolvedValue({
    command: 'docker-command',
    pairingCode: 'temporary-code',
    expiresAt: '2026-10-10T12:00:00Z',
  });
  mount('server', {
    ...status,
    availability: { server: { runtimes: { docker: true, systemd: true } } },
  });
  expect(screen.getByRole('combobox', { name: '服务器安装方式' })).toHaveValue('docker');
  expect(screen.getByRole('button', { name: '下载 Docker 部署包' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '生成一次安装命令' }));
  expect(await screen.findByText('docker-command')).toBeVisible();
  expect(screen.getByText('temporary-code')).toBeVisible();
  fireEvent.change(screen.getByRole('combobox', { name: '服务器安装方式' }), {
    target: { value: 'systemd' },
  });
  expect(screen.queryByText('temporary-code')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '下载 Docker 部署包' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '生成一次安装命令' }));
  await waitFor(() =>
    expect(mocks.api.post).toHaveBeenLastCalledWith(
      `/liekan/websites/${site}/log-sources/server/pairing`,
      { runtime: 'systemd' },
    ),
  );
});
it('downloads a deployment package without creating a pairing grant', async () => {
  const create = vi.fn().mockReturnValue('blob:deployment'),
    revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  mocks.api.get.mockResolvedValue({
    archive: btoa('test-zip'),
    fileName: 'deployment.zip',
    command: 'prepare-only',
  });
  mount('server');
  fireEvent.click(screen.getByRole('button', { name: '下载 Docker 部署包' }));
  expect(await screen.findByText('sh start.sh')).toBeVisible();
  expect(screen.getByText('prepare-only')).not.toBeVisible();
  fireEvent.click(screen.getByText('通过命令准备运行环境（可选）'));
  expect(screen.getByText('prepare-only')).toBeVisible();
  expect(mocks.api.post).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalled();
  expect(click).toHaveBeenCalled();
  click.mockRestore();
});
it('falls back to direct installation when Docker delivery is unavailable', () => {
  mount('server', {
    ...status,
    availability: { server: { runtimes: { docker: false, systemd: true } } },
  });
  expect(screen.getByRole('combobox', { name: '服务器安装方式' })).toHaveValue('systemd');
  expect(screen.queryByRole('button', { name: '下载 Docker 部署包' })).not.toBeInTheDocument();
});
it('distinguishes collector connection, reception, processing and no AI matches', () => {
  mount('server', {
    ...status,
    logs: { total: 12, ai: 0 },
    sources: [
      {
        id: 'connected-source',
        kind: 'server',
        domain: 'example.com',
        state: 'active',
        primary: true,
        lastHeartbeatAt: new Date().toISOString(),
        lastReceivedAt: new Date().toISOString(),
        lastProcessedAt: null,
        backlog: 1,
        health: { errorCode: 'format-error' },
      },
    ],
  });
  expect(screen.getByText(/采集服务：已连接/)).toHaveTextContent(
    '真实日志：已接收 · 处理：等待处理',
  );
  expect(screen.getByText(/本站 AI 蜘蛛匹配/)).toHaveTextContent(
    '日志已收到，暂未匹配到 AI 蜘蛛请求。',
  );
  expect(screen.getByText(/存在无法识别的日志行/)).toBeVisible();
});
it('requires domain and fee confirmation before completing Cloudflare authorization', async () => {
  mocks.query = { flow: 'a-flow' };
  mocks.api.post.mockResolvedValue({
    domain: 'example.com',
    zones: [{ id: 'zone-a', name: 'example.com' }],
  });
  mount('cloudflare');
  const button = await screen.findByRole('button', { name: '确认并连接' });
  expect(button).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(button).not.toBeDisabled());
  mocks.api.post.mockResolvedValue({ sourceId: 'source-a' });
  fireEvent.click(button);
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(mocks.api.post).toHaveBeenLastCalledWith(
    `/liekan/websites/${site}/log-sources/cloudflare/finalize`,
    { flowId: 'a-flow', zoneId: 'zone-a', acceptCosts: true },
  );
});
it('shows deferred source confirmation and batch failures and allows a confirmed source switch', async () => {
  const source = {
    id: 'source-a',
    kind: 'server',
    domain: 'example.com',
    state: 'paused',
    primary: false,
    backlog: 3,
    failed: 2,
    errorCode: 'confirmation-required',
    health: {},
  };
  mocks.api.put.mockResolvedValue({ saved: true });
  mount('server', { ...status, sources: [source] });
  expect(screen.getByText(/有 2 批日志处理失败/)).toBeVisible();
  expect(screen.getByText(/主要来源已变更/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '设为主要来源' }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(mocks.api.put).toHaveBeenCalledWith(`/liekan/websites/${site}/log-sources/source-a`, {
    action: 'select',
  });
});
it('ignores an obsolete authorization response after leaving the setup page', async () => {
  mocks.query = { flow: 'a-flow' };
  let finish!: (value: any) => void;
  mocks.api.post.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const view = mount('cloudflare');
  view.unmount();
  await act(async () => finish({ sourceId: 'obsolete' }));
  expect(refresh).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
});
it('offers deployment instructions to website users without generating a connection', () => {
  mocks.user = { isAdmin: false };
  mount('server', { ...status, capabilities: { server: false, cloudflare: false } });
  fireEvent.click(screen.getByRole('button', { name: '查看配置说明' }));
  expect(screen.getByText(/请将配置说明交给部署管理员/)).toBeVisible();
  expect(mocks.api.post).not.toHaveBeenCalled();
});
it('keeps inspection failures visible and resumes generation only after runtime readiness', async () => {
  const unavailable = { ...status, capabilities: { server: false, cloudflare: false } };
  const view = mount('server', unavailable);
  fireEvent.click(screen.getByRole('button', { name: '开始配置' }));
  refresh.mockResolvedValueOnce({ error: new Error('配置读取失败') });
  fireEvent.click(screen.getByRole('button', { name: '重新检查配置' }));
  expect(await screen.findByText('配置读取失败')).toBeVisible();
  expect(screen.queryByText(/已重新读取运行配置/)).not.toBeInTheDocument();
  view.rerender(
    <StrictMode>
      <AutomaticLogSetup
        websiteId={site}
        method="server"
        status={status}
        manage
        refresh={refresh}
      />
    </StrictMode>,
  );
  expect(screen.getByRole('button', { name: '生成一次安装命令' })).toBeEnabled();
  expect(screen.getByRole('region', { name: '接收服务配置引导' })).toBeVisible();
});
it('copies normalized address configuration and reports clipboard failure', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  mount('server', { ...status, capabilities: { server: false } });
  fireEvent.click(screen.getByRole('button', { name: '开始配置' }));
  fireEvent.change(screen.getByRole('textbox', { name: '统计服务公网地址' }), {
    target: { value: 'https://stats.example.com/' },
  });
  fireEvent.click(screen.getByRole('button', { name: '复制地址配置' }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith('LIEKAN_PUBLIC_URL=https://stats.example.com'),
  );
  expect(mocks.notify).toHaveBeenCalledWith('配置说明已复制');
  writeText.mockRejectedValueOnce(new Error('无法访问剪贴板'));
  fireEvent.click(screen.getByRole('button', { name: '复制地址配置' }));
  expect(await screen.findByText('无法访问剪贴板')).toBeVisible();
});
it('treats omitted legacy checks as unverified and keeps runtime readiness authoritative', async () => {
  mount('cloudflare', {
    ...status,
    availability: { cloudflare: { available: true, reason: null, version: '1' } },
  });
  fireEvent.click(screen.getByRole('button', { name: '查看接收服务配置' }));
  expect(screen.queryByRole('button', { name: '复制待配置项' })).not.toBeInTheDocument();
  expect(screen.getByText(/尚未返回逐项检查结果/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '重新检查配置' }));
  expect(await screen.findByText(/接收服务已就绪/)).toBeVisible();
});
