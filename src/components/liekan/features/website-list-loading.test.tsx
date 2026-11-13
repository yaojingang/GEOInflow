import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { websiteDayWindow } from '@/lib/liekan/upstream/website-day-metrics';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DataLoading } from '../DataLoading';
import { CorePages } from './CorePages';
import { FeatureProvider } from './context';

const mocks = vi.hoisted(() => ({ summary: vi.fn() }));
vi.mock('@/lib/liekan/upstream/features-client', async original => ({
  ...(await original<typeof import('@/lib/liekan/upstream/features-client')>()),
  getFeatureWebsiteSummary: mocks.summary,
}));
vi.mock('next/link', () => ({
  useLinkStatus: () => ({ pending: false }),
  default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a>,
}));
vi.mock('./Chart', () => ({ Chart: () => null }));

const site = {
  id: '11111111-1111-4111-8111-111111111111',
  siteNumber: 101,
  name: '即时展示站',
  domain: 'example.invalid',
  userId: 'owner',
};
const totals = { pageviews: 9, views: 9, visitors: 3, visits: 4, bounces: 1, aiVisits: 2 };
const summary = [{ id: site.id, ...totals, received: true, comparison: totals }];
let client: QueryClient;
let resolveSummary: (rows: any[]) => void;
let rejectSummary: (error: any) => void;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending = new Promise((resolve, reject) => {
    resolveSummary = resolve;
    rejectSummary = reject;
  });
  mocks.summary.mockReset().mockReturnValue(pending);
});
afterEach(() => client.clear());

function page(loading = false, range = { startAt: 0, endAt: 1000, timezone: 'Asia/Shanghai' }) {
  return (
    <QueryClientProvider client={client}>
      <FeatureProvider
        value={
          {
            user: { id: 'owner', role: 'user' },
            route: { page: 'websites' },
            sites: [site],
            sitesReady: !loading,
            teams: [],
            siteId: '',
            range,
            query: {},
            filters: {},
            api: { get: vi.fn() },
            href: (page: string) => `/websites/101/${page}`,
            navigate: vi.fn(),
            notify: vi.fn(),
            refresh: vi.fn(),
          } as any
        }
      >
        <DataLoading loading={loading}>
          <CorePages page="websites" />
        </DataLoading>
      </FeatureProvider>
    </QueryClientProvider>
  );
}

it('shares a single natural-day request between the totals and the website rows', async () => {
  const range = websiteDayWindow('Asia/Shanghai');
  render(page(false, range));
  await waitFor(() => expect(mocks.summary).toHaveBeenCalledTimes(1));
  expect(mocks.summary.mock.calls[0][1]).toEqual(range);
  await act(async () => resolveSummary(summary));
  expect(await within(screen.getByRole('table')).findByText('已收到浏览数据')).toBeVisible();
  expect(document.querySelectorAll('.metric')[1]).toHaveTextContent('9');
  expect(mocks.summary).toHaveBeenCalledTimes(1);
});

it('shows searchable website identities and actions while both statistics reads are pending', async () => {
  render(page());
  await waitFor(() => expect(mocks.summary).toHaveBeenCalledTimes(2));
  const table = screen.getByRole('table');
  expect(within(table).getByRole('link', { name: site.name })).toBeVisible();
  expect(within(table).getByText(site.domain)).toBeVisible();
  expect(within(table).getByRole('link', { name: '网站设置' })).toHaveAttribute(
    'href',
    '/websites/101/website-settings',
  );
  expect(within(table).queryByText('0')).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole('searchbox', { name: '搜索本页记录' }), '不存在');
  expect(within(table).queryByText(site.name)).not.toBeInTheDocument();
  await userEvent.clear(screen.getByRole('searchbox', { name: '搜索本页记录' }));
  expect(within(table).getByText(site.name)).toBeVisible();
  await act(async () => resolveSummary(summary));
  expect(await within(table).findByText('已收到浏览数据')).toBeVisible();
  expect(within(table).getAllByText('9').length).toBeGreaterThan(0);
});

it.each([500, 403])('keeps website links available when statistics fail with %s', async status => {
  render(page());
  await waitFor(() => expect(mocks.summary).toHaveBeenCalledTimes(2));
  await act(async () => rejectSummary({ status, message: '统计暂不可用' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    status === 403 ? '没有访问权限' : '读取失败',
  );
  expect(screen.getByRole('link', { name: site.name })).toBeVisible();
  expect(screen.getByRole('link', { name: '网站设置' })).toBeVisible();
  expect(
    within(screen.getByRole('table')).getByText(status === 403 ? '无统计权限' : '读取失败'),
  ).toBeVisible();
});

it('fills daily metrics while the selected-period summary is still pending', async () => {
  // The selected-period query starts first; keep it waiting while the daily query completes.
  mocks.summary.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(summary);
  render(page());
  const table = screen.getByRole('table');
  expect((await within(table).findAllByText('9')).length).toBeGreaterThan(0);
  expect(within(table).getByText('等待查询')).toBeVisible();
  expect(within(table).getByRole('link', { name: site.name })).toBeVisible();
  expect(table.querySelector('[aria-busy="true"]')).toBeNull();
});

it('shows collection status while daily metrics are still pending', async () => {
  mocks.summary.mockResolvedValueOnce(summary);
  render(page());
  const table = screen.getByRole('table');
  expect(await within(table).findByText('已收到浏览数据')).toBeVisible();
  expect(table.querySelectorAll('.site-metrics[aria-busy="true"]')).toHaveLength(4);
  expect(within(table).queryByText('9')).not.toBeInTheDocument();
});

it('keeps the metadata skeleton until the website list itself is authorized and loaded', async () => {
  const view = render(page(true));
  expect(screen.queryByRole('link', { name: site.name })).not.toBeInTheDocument();
  expect(mocks.summary).not.toHaveBeenCalled();
  view.rerender(page());
  await waitFor(() => expect(mocks.summary).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('link', { name: site.name })).toBeVisible();
});
