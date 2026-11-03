import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RobotsManagement } from '@/lib/liekan/contracts/robots-management';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';

const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/liekan/upstream/features-client', () => ({ featureRequest: mock.request }));

import { RobotsManagementPanel } from './RobotsManagementPanel';

let data: RobotsManagement;
const id = '12345678-1234-4234-8234-123456789012';
beforeEach(() => {
  vi.clearAllMocks();
  data = {
    hostname: 'example.com',
    draft: 'User-agent: *\nAllow: /',
    revision: 1,
    monitor: false,
    interval: 60,
    checkedAt: null,
    observedContent: 'User-agent: *\nDisallow: /private',
    observedStatus: 200,
    observedHostname: 'example.com',
    lastError: null,
    changePending: false,
    agent: {
      connected: true,
      seenAt: new Date().toISOString(),
      path: '/var/www/site/robots.txt',
      contextValid: true,
    },
    permissions: { canDraft: true, canControl: true },
    snapshots: [],
    deployments: [],
  };
  mock.request.mockImplementation(async (method, path, input) => {
    if (path.endsWith('/crawler-domain-verification'))
      return { name: '_liekan-verify.example.com', verifiedAt: new Date().toISOString() };
    if (path.endsWith('/crawler-analysis'))
      return {
        range: { startAt: 1000, endAt: 2000, timezone: 'UTC' },
        quality: { state: 'missing' },
        bots: [],
        pages: [],
        directory: [],
        criticalPaths: [],
        generatedAt: new Date().toISOString(),
      };
    if (method === 'GET') return structuredClone(data);
    if (input.action === 'save') {
      if (input.revision !== data.revision)
        throw Object.assign(new Error('robots 草稿已被更新，请重新读取后合并'), { status: 409 });
      data = { ...data, draft: input.content, revision: data.revision + 1 };
      return { data: structuredClone(data) };
    }
    if (input.action === 'pair')
      return { code: 'a'.repeat(43), hostname: data.hostname, data: structuredClone(data) };
    if (input.action === 'preview') {
      data = {
        ...data,
        deployments: [
          {
            id,
            state: 'preview',
            before_content: 'User-agent: *\nAllow: /',
            content: data.draft,
            expires_at: new Date(Date.now() + 600000).toISOString(),
            created_at: new Date().toISOString(),
            rollback_of: null,
            error_code: null,
          },
        ],
      };
      return { id, data: structuredClone(data) };
    }
    if (input.action === 'confirm')
      data = { ...data, deployments: data.deployments.map(job => ({ ...job, state: 'queued' })) };
    return { data: structuredClone(data) };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it('keeps an edited draft during live reads and requires an explicit load action', async () => {
  render(<RobotsManagementPanel websiteId={id} />);
  const editor = await screen.findByLabelText('robots.txt 内容');
  fireEvent.change(editor, { target: { value: 'User-agent: GPTBot\nDisallow: /draft' } });
  fireEvent.click(screen.getByRole('button', { name: '读取线上 robots.txt' }));
  await screen.findByText('线上 robots.txt 已读取，草稿保持当前内容。');
  expect(editor).toHaveValue('User-agent: GPTBot\nDisallow: /draft');
  fireEvent.click(screen.getByRole('button', { name: '将线上文件载入草稿' }));
  expect(editor).toHaveValue(data.observedContent);
});
it('saves an edit with its revision and confirms only a reviewed preview', async () => {
  render(<RobotsManagementPanel websiteId={id} />);
  const editor = await screen.findByLabelText('robots.txt 内容');
  fireEvent.change(editor, { target: { value: 'User-agent: GPTBot\nDisallow: /private' } });
  expect(screen.getByRole('button', { name: '预览发布 robots.txt' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '保存 robots 草稿' }));
  await screen.findByText('robots 草稿已保存，发布需要单独预览确认。');
  expect(mock.request).toHaveBeenCalledWith('POST', expect.stringContaining('/robots'), {
    action: 'save',
    content: 'User-agent: GPTBot\nDisallow: /private',
    revision: 1,
  });
  fireEvent.click(screen.getByRole('button', { name: '预览发布 robots.txt' }));
  const confirm = await screen.findByRole('button', { name: '确认发布到服务器' });
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(mock.request).toHaveBeenCalledWith('POST', expect.stringContaining('/robots'), {
      action: 'confirm',
      id,
    }),
  );
});
it.each(['refresh', 'read', 'monitor'])(
  'preserves the edited draft base revision after a remote change and %s',
  async action => {
    render(<RobotsManagementPanel websiteId={id} />);
    const editor = await screen.findByLabelText('robots.txt 内容');
    const local = 'User-agent: GPTBot\nDisallow: /local';
    fireEvent.change(editor, { target: { value: local } });
    data = { ...data, draft: 'User-agent: GPTBot\nDisallow: /remote', revision: 2 };
    const button = {
      refresh: '重新读取 robots 状态',
      read: '读取线上 robots.txt',
      monitor: '启用或更新监控',
    }[action];
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '保存 robots 草稿' })).toBeEnabled(),
    );
    expect(editor).toHaveValue(local);
    fireEvent.click(screen.getByRole('button', { name: '保存 robots 草稿' }));
    await screen.findByText('robots 草稿已被更新，请重新读取后合并');
    expect(mock.request).toHaveBeenCalledWith('POST', expect.stringContaining('/robots'), {
      action: 'save',
      content: local,
      revision: 1,
    });
    expect(data.draft).toBe('User-agent: GPTBot\nDisallow: /remote');
    expect(editor).toHaveValue(local);
  },
);
it('preserves the edited draft base revision during automatic status polling', async () => {
  render(<RobotsManagementPanel websiteId={id} />);
  const editor = await screen.findByLabelText('robots.txt 内容');
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '生成十分钟服务器授权码' }));
  });
  const local = 'User-agent: GPTBot\nDisallow: /local';
  fireEvent.change(editor, { target: { value: local } });
  data = { ...data, draft: 'User-agent: GPTBot\nDisallow: /remote', revision: 2 };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(editor).toHaveValue(local);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '保存 robots 草稿' }));
  });
  expect(screen.getByText('robots 草稿已被更新，请重新读取后合并')).toBeInTheDocument();
  expect(mock.request).toHaveBeenCalledWith('POST', expect.stringContaining('/robots'), {
    action: 'save',
    content: local,
    revision: 1,
  });
  expect(data.revision).toBe(2);
});
it('compares a newer saved draft and explicitly loads it before saving a merged edit', async () => {
  render(<RobotsManagementPanel websiteId={id} />);
  const editor = await screen.findByLabelText('robots.txt 内容');
  const local = 'User-agent: GPTBot\nDisallow: /local';
  const remote = 'User-agent: GPTBot\nDisallow: /remote';
  fireEvent.change(editor, { target: { value: local } });
  data = { ...data, draft: remote, revision: 2 };
  fireEvent.click(screen.getByRole('button', { name: '保存 robots 草稿' }));
  await screen.findByText('robots 草稿已被更新，请重新读取后合并');
  await screen.findByText('已保存草稿已更新。当前编辑内容已保留，请核对最新草稿后合并。');
  const comparison = screen.getByText('查看最新保存草稿').closest('details');
  fireEvent.click(screen.getByText('查看最新保存草稿'));
  expect(comparison.querySelector('pre')?.textContent).toBe(remote);
  expect(editor).toHaveValue(local);
  const load = screen.getByRole('button', { name: '将最新保存草稿载入编辑器' });
  expect(load).toBeDisabled();
  fireEvent.click(
    screen.getByRole('checkbox', { name: '我已核对最新草稿，确认替换当前编辑内容。' }),
  );
  fireEvent.click(load);
  await waitFor(() => expect(editor).toHaveValue(remote));
  expect(screen.getByRole('button', { name: '保存 robots 草稿' })).toBeDisabled();
  const merged = `${remote}\nDisallow: /local`;
  fireEvent.change(editor, { target: { value: merged } });
  fireEvent.click(screen.getByRole('button', { name: '保存 robots 草稿' }));
  await screen.findByText('robots 草稿已保存，发布需要单独预览确认。');
  expect(mock.request).toHaveBeenLastCalledWith('POST', expect.stringContaining('/robots'), {
    action: 'save',
    content: merged,
    revision: 2,
  });
  expect(data.draft).toBe(merged);
});
it.each([
  ['/analytics', '', '/analytics/api/liekan/robots-agent'],
  ['/analytics', '/internal-api', '/analytics/internal-api/liekan/robots-agent'],
  [
    '/analytics',
    'https://api.example/custom-api',
    'https://api.example/custom-api/liekan/robots-agent',
  ],
  [
    '/analytics',
    "https://api.example/it's-api",
    "https://api.example/it's-api/liekan/robots-agent",
  ],
])(
  'uses the configured API endpoint in the pairing command (%s, %s)',
  async (basePath, apiUrl, path) => {
    vi.stubEnv('basePath', basePath);
    vi.stubEnv('apiUrl', apiUrl);
    render(<RobotsManagementPanel websiteId={id} />);
    await screen.findByLabelText('robots.txt 内容');
    fireEvent.click(screen.getByRole('button', { name: '生成十分钟服务器授权码' }));
    const command = await screen.findByText(/node liekan-robots-agent\.mjs pair/);
    const endpoint = new URL(path, window.location.origin).href;
    expect(command.textContent).toContain(`--url '${endpoint.replaceAll("'", "'\\''")}'`);
  },
);
it('adds a scoped crawler disallow rule to the draft without publishing', async () => {
  data.draft = 'User-agent: *\nDisallow: /private';
  render(<RobotsManagementPanel websiteId={id} />);
  const editor = await screen.findByLabelText('robots.txt 内容');
  fireEvent.click(screen.getByRole('button', { name: '添加屏蔽规则' }));
  await waitFor(() =>
    expect((editor as HTMLTextAreaElement).value).toContain('User-agent: GPTBot'),
  );
  expect(mock.request.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(0);
});
it('clears draft and server details after permission loss', async () => {
  render(<RobotsManagementPanel websiteId={id} />);
  await screen.findByLabelText('robots.txt 内容');
  mock.request.mockRejectedValueOnce(Object.assign(new Error('权限已变更'), { status: 403 }));
  fireEvent.click(screen.getByRole('button', { name: '重新读取 robots 状态' }));
  await screen.findByText('权限已变更');
  expect(screen.queryByLabelText('robots.txt 内容')).not.toBeInTheDocument();
  expect(screen.queryByText('/var/www/site/robots.txt')).not.toBeInTheDocument();
});
it('renders English controls while keeping raw robots content unchanged', async () => {
  render(
    <LiekanLocaleContext.Provider value="en-US">
      <RobotsManagementPanel websiteId={id} />
    </LiekanLocaleContext.Provider>,
  );
  expect(await screen.findByLabelText('robots.txt content')).toHaveValue(data.draft);
  expect(screen.getByRole('button', { name: 'Read live robots.txt' })).toBeVisible();
});
it('keeps viewer controls read only', async () => {
  data.permissions = { canDraft: false, canControl: false };
  render(<RobotsManagementPanel websiteId={id} />);
  expect(await screen.findByLabelText('robots.txt 内容')).toBeDisabled();
  expect(screen.getByRole('button', { name: '生成十分钟服务器授权码' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '预览发布 robots.txt' })).toBeDisabled();
});

it('opens with the online overview and retains draft edits across tabs and live reads', async () => {
  render(<RobotsManagementPanel websiteId={id} initialView="overview" />);
  await screen.findByRole('heading', { name: '当前 robots.txt 概览' });
  expect(screen.queryByRole('textbox', { name: 'robots.txt 内容' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'https://example.com/robots.txt' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '管理当前 robots.txt' }));
  const editor = screen.getByRole('textbox', { name: 'robots.txt 内容' });
  fireEvent.change(editor, { target: { value: 'User-agent: GPTBot\nDisallow: /draft' } });
  fireEvent.click(screen.getByRole('tab', { name: '概览与建议' }));
  fireEvent.click(screen.getByRole('button', { name: '读取线上 robots.txt' }));
  await screen.findByText('线上 robots.txt 已读取，草稿保持当前内容。');
  fireEvent.click(screen.getByRole('tab', { name: '编辑与发布' }));
  expect(editor).toHaveValue('User-agent: GPTBot\nDisallow: /draft');
  expect(editor.closest('form')).toHaveAttribute('data-unsaved', 'true');
});
