import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RobotsManagement } from '@/lib/liekan/contracts/robots-management';
import { crawlerDirectory } from '@/lib/liekan/crawlers/directory';
const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/liekan/upstream/features-client', () => ({ featureRequest: mock.request }));
import { RobotsOverview } from './RobotsOverview';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';
const data: RobotsManagement = {
  hostname: 'example.com',
  draft: '',
  revision: 1,
  monitor: true,
  interval: 60,
  checkedAt: '2026-10-31T00:00:00Z',
  observedContent: 'User-agent: *\nAllow: /',
  observedHostname: 'example.com',
  observedStatus: 200,
  lastError: null,
  changePending: false,
  agent: { connected: true, contextValid: true, seenAt: null, path: '/www/site/robots.txt' },
  permissions: { canDraft: true, canControl: true },
  snapshots: [],
  deployments: [],
};
const response = () => ({
  range: { startAt: 1000, endAt: 2000, timezone: 'UTC' },
  generatedAt: '2026-10-31T00:00:00Z',
  quality: { state: 'unknown' },
  bots: [{ botId: 'gptbot', requests: 5, denied403429: 2 }],
  directory: crawlerDirectory,
  criticalPaths: [],
  pages: [{ botId: 'gptbot', path: '/docs', requests: 5, successfulGets: 3, denied403429: 2 }],
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('shows an actual address, server path and evidence-based suggestions for the selected range', async () => {
  mock.request.mockResolvedValue(response());
  const manage = vi.fn();
  render(
    <RobotsOverview
      websiteId="site-a"
      data={data}
      range={{ startAt: 1000, endAt: 2000, timezone: 'UTC' }}
      onManage={manage}
      onRead={() => {}}
    />,
  );
  expect(screen.getByRole('link', { name: 'https://example.com/robots.txt' })).toHaveAttribute(
    'href',
    'https://example.com/robots.txt',
  );
  expect(screen.getByText('/www/site/robots.txt')).toBeVisible();
  expect(await screen.findByText('核对允许路径的 403 / 429 响应')).toBeVisible();
  expect(mock.request).toHaveBeenCalledWith(
    'GET',
    '/liekan/websites/site-a/crawler-analysis',
    { startAt: 1000, endAt: 2000, timezone: 'UTC' },
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole('button', { name: '管理当前 robots.txt' }));
  expect(manage).toHaveBeenCalledOnce();
});
it('keeps file management available when statistics fail', async () => {
  mock.request.mockRejectedValue(new Error('offline'));
  render(<RobotsOverview websiteId="site-a" data={data} onManage={() => {}} onRead={() => {}} />);
  expect(await screen.findByText('统计建议暂不可用，文件管理仍可使用。')).toBeVisible();
  expect(screen.getByRole('button', { name: '管理当前 robots.txt' })).toBeEnabled();
});
it('retains the statistics snapshot and raw file address across a language change', async () => {
  mock.request.mockResolvedValue(response());
  const view = render(
    <LiekanLocaleContext.Provider value="zh-CN">
      <RobotsOverview websiteId="site-a" data={data} onManage={() => {}} onRead={() => {}} />
    </LiekanLocaleContext.Provider>,
  );
  await screen.findByText('核对允许路径的 403 / 429 响应');
  view.rerender(
    <LiekanLocaleContext.Provider value="en-US">
      <RobotsOverview websiteId="site-a" data={data} onManage={() => {}} onRead={() => {}} />
    </LiekanLocaleContext.Provider>,
  );
  expect(screen.getByRole('link', { name: 'https://example.com/robots.txt' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Current robots.txt overview' })).toBeVisible();
  expect(screen.getByText('Review 403 / 429 responses on allowed paths')).toBeVisible();
  await waitFor(() => expect(mock.request).toHaveBeenCalledTimes(1));
});
it('keeps prior-domain file evidence and expired server authorization outside the current overview', async () => {
  mock.request.mockResolvedValue(response());
  render(
    <RobotsOverview
      websiteId="site-a"
      data={{
        ...data,
        observedHostname: 'old.example.com',
        agent: { ...data.agent, contextValid: false },
      }}
      onManage={() => {}}
      onRead={() => {}}
    />,
  );
  expect(screen.getByText('尚未读取当前网站文件')).toBeVisible();
  expect(screen.getByText('最近成功检查').nextElementSibling).toHaveTextContent('尚未检查');
  expect(screen.queryByText('/www/site/robots.txt')).not.toBeInTheDocument();
  expect(screen.getByText('完成服务器授权后显示实际路径')).toBeVisible();
  await screen.findByText('结合数据覆盖范围评估建议');
  expect(screen.queryByText('核对允许路径的 403 / 429 响应')).not.toBeInTheDocument();
});
