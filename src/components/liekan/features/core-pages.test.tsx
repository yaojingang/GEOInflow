import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conversionRate,
  featureNavigationPath,
  funnelPayload,
  goalPayload,
  recorderPayload,
  safeCallbackUrl,
  trackerSnippet,
} from '@/lib/liekan/contracts/core';
import { CorePages, FeatureAuthPage } from './CorePages';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';
import { remainingFreshness, hasClientFreshness } from '@/lib/liekan/upstream/client-freshness';
import {
  qualifiedBrowserReason,
  qualifiedBrowserUnavailableReason,
} from '@/lib/liekan/contracts/population-results';
import { translateText } from '@/lib/liekan/i18n/text';

const mocks = vi.hoisted(() => ({
  context: null as any,
  query: {} as Record<string, any>,
  queryStates: {} as Record<string, any>,
  post: vi.fn(),
  verify: vi.fn(),
  sso: vi.fn(),
  login: vi.fn(),
  resumeLogin: vi.fn(),
  replace: vi.fn(),
  params: new URLSearchParams(),
  queries: [] as any[],
  loaders: {} as Record<string, (signal?: AbortSignal) => Promise<any>>,
  managementDrawer: vi.fn(),
  preferences: {} as any,
  savePreferences: vi.fn(),
}));
vi.mock('@/lib/liekan/upstream/account-preferences-client', () => ({
  saveAccountPreferences: mocks.savePreferences,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.params,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('./Chart', () => ({
  Chart: ({ title, labels, series }: any) => (
    <div role="img" aria-label={title}>
      {JSON.stringify({ labels, series })}
    </div>
  ),
}));
vi.mock('./WorkspacePages', () => ({
  WebsiteSharing: () => <div>当前网站分享组件</div>,
}));
vi.mock('../ManagementDrawer', () => ({
  ManagementDrawer: (props: any) => {
    mocks.managementDrawer(props);
    return (
      <div role="dialog" aria-label={props.action}>
        当前网站管理操作
      </div>
    );
  },
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    cancelQueries: vi.fn().mockResolvedValue(undefined),
    setQueryData: vi.fn(),
  }),
}));
vi.mock('./context', () => ({
  useFeature: () => mocks.context,
  useData: (key: string | any[], load: any) => {
    const name = Array.isArray(key) ? key[0] : key;
    mocks.queries.push(key);
    mocks.loaders[name] = load;
    return {
      data: typeof mocks.query[name] === 'function' ? mocks.query[name](key) : mocks.query[name],
      isPending: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
      ...mocks.queryStates[name],
    };
  },
  useAction: () => {
    const [busy, setBusy] = useState(false);
    return {
      run: async (
        action: () => Promise<any>,
        message?: string,
        options?: { navigateTo?: string },
      ) => {
        setBusy(true);
        try {
          const result = await action();
          if (message) mocks.context.notify(message);
          if (options?.navigateTo)
            mocks.context.navigate(options.navigateTo, undefined, { replace: true });
          return result;
        } finally {
          setBusy(false);
        }
      },
      busy,
      error: '',
    };
  },
}));
vi.mock('@/lib/liekan/upstream/features-client', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/liekan/upstream/features-client')>()),
  featureApi: { post: mocks.post },
  acceptFeatureLogin: mocks.login,
  resumeFeatureLogin: mocks.resumeLogin,
  clearFeatureLogin: vi.fn(),
  verifyFeatureTwoFactor: mocks.verify,
  verifyFeatureSso: mocks.sso,
  getFeaturePreferences: () => mocks.preferences,
  saveFeaturePreferences: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preferences = {
    range: '30day',
    countryCode: 'CN',
    timezone: 'Asia/Shanghai',
    language: 'zh-CN',
    theme: 'light',
  };
  mocks.resumeLogin.mockResolvedValue(null);
  mocks.query = {
    'website-installation': {
      progress: {
        method: 'cloudflare',
        lastStep: 'js',
        browserCheckDeferred: false,
        logCheckDeferred: false,
        completedAt: null,
      },
      canManage: true,
      logs: { total: 0, ai: 0, latestAt: null, latestImportAt: null, demo: false },
      capabilities: { cloudflare: false, server: false },
    },
  };
  mocks.queryStates = {};
  mocks.queries = [];
  mocks.loaders = {};
  mocks.params = new URLSearchParams();
  sessionStorage.clear();
  mocks.context = {
    user: { id: 'user-1', username: 'owner', role: 'admin', isAdmin: true },
    route: { page: 'funnel-editor' },
    siteId: 'site-1',
    site: { id: 'site-1', name: '网站', domain: 'example.com', userId: 'user-1' },
    sites: [],
    teams: [],
    range: { startAt: 1, endAt: 2 },
    filters: {},
    query: {},
    api: { post: mocks.post, get: vi.fn(), del: vi.fn() },
    href: (page: string, params: Record<string, any> = {}) =>
      `/liekan/${page}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`,
    navigate: vi.fn(),
    notify: vi.fn(),
    refresh: vi.fn(),
  };
});

describe('core API mappings', () => {
  it('preserves an explicit legacy rolling preference when the country changes', async () => {
    mocks.preferences.range = '24hour';
    const { container } = render(<CorePages page="preferences" />);
    const range = await screen.findByLabelText('默认日期范围');
    expect(range).toHaveValue('24hour');
    await userEvent.selectOptions(container.querySelector('select[name="countryCode"]')!, 'JP');
    await userEvent.click(screen.getByRole('button', { name: '保存偏好' }));
    await waitFor(() =>
      expect(mocks.savePreferences).toHaveBeenCalledWith({
        countryCode: 'JP',
        timezone: 'Asia/Tokyo',
        range: '24hour',
      }),
    );
  });
  it('localizes website section tabs while retaining the form draft and canonical navigation', async () => {
    mocks.query['site-record'] = mocks.context.site;
    const page = (locale: 'zh-CN' | 'en-US') => (
      <LiekanLocaleContext.Provider value={locale}>
        <CorePages page="website-settings" />
      </LiekanLocaleContext.Provider>
    );
    const view = render(page('en-US'));
    expect(screen.getByRole('tab', { name: 'Basic information' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const name = screen.getByRole('textbox', { name: /Website name/ });
    fireEvent.change(name, { target: { value: 'Raw draft 网站' } });
    view.rerender(page('zh-CN'));
    expect(name).toHaveValue('Raw draft 网站');
    expect(screen.getByRole('tab', { name: '基本信息' })).toHaveAttribute('aria-selected', 'true');
    view.rerender(page('en-US'));
    await userEvent.click(screen.getByRole('tab', { name: 'Installation' }));
    expect(mocks.context.navigate).toHaveBeenLastCalledWith('website-settings', {
      websiteId: 'site-1',
      section: 'install',
    });
  });
  it('keeps bilingual website status and space searches stable across language changes', () => {
    mocks.context.sites = [
      { id: 'example', name: 'Example', domain: 'example.com', userId: 'user-1' },
      { id: 'raw', name: '网站管理', domain: 'raw.example', userId: 'user-1' },
    ];
    mocks.query['website-management-stats'] = [{ id: 'example', received: true }];
    const page = (locale: 'zh-CN' | 'en-US') => (
      <LiekanLocaleContext.Provider value={locale}>
        <CorePages page="websites" />
      </LiekanLocaleContext.Provider>
    );
    const view = render(page('en-US'));
    const search = screen.getByRole('searchbox');
    for (const term of ['Personal space', 'Browsing data received']) {
      fireEvent.change(search, { target: { value: term } });
      expect(screen.getByText('Example')).toBeInTheDocument();
      view.rerender(page('zh-CN'));
      expect(search).toHaveValue(term);
      expect(screen.getByText('Example')).toBeInTheDocument();
      view.rerender(page('en-US'));
    }
    fireEvent.change(search, { target: { value: 'Website Management' } });
    expect(screen.queryByText('网站管理', { selector: 'a' })).toBeNull();
    fireEvent.change(search, { target: { value: '网站管理' } });
    expect(screen.getByText('网站管理', { selector: 'a' })).toBeInTheDocument();
  });
  it('restores the saved login at the login entry and resumes its internal return path', async () => {
    mocks.resumeLogin.mockResolvedValue('/websites');
    render(<FeatureAuthPage page="login" />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/websites'));
  });
  it('aborts saved-login restoration when leaving the login page', () => {
    mocks.resumeLogin.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<FeatureAuthPage page="login" />);
    expect(screen.getByRole('button', { name: '正在登录…' })).toBeDisabled();
    const signal = mocks.resumeLogin.mock.calls[0][0];
    unmount();
    expect(signal.aborted).toBe(true);
  });
  it('marks reordered funnel steps as unsaved without requiring text input', () => {
    const { container } = render(<CorePages page="funnel-editor" />);
    expect(container.querySelector('form')).not.toHaveAttribute('data-unsaved', 'true');
    fireEvent.click(screen.getByRole('button', { name: '下移步骤 1' }));
    expect(container.querySelector('form')).toHaveAttribute('data-unsaved', 'true');
  });
  it('passes logical paths to Next navigation when a base path is configured', () => {
    expect(featureNavigationPath('/stats/dashboard', '/stats')).toBe('/dashboard');
    expect(featureNavigationPath('/stats', '/stats')).toBe('/');
    expect(featureNavigationPath('/stats-other/dashboard', '/stats')).toBe(
      '/stats-other/dashboard',
    );
    expect(featureNavigationPath('//attacker.example', '/stats')).toBe('/websites');
    expect(featureNavigationPath('/\n/attacker.example', '/stats')).toBe('/websites');
  });
  it('converts recorder percentages and minutes and keeps both collection switches off', () => {
    expect(
      recorderPayload({
        replayRate: '25',
        heatRate: '5',
        duration: '15',
        mask: 'strict',
        blockSelector: ' .private ',
      }),
    ).toEqual({
      replayConfig: {
        replayEnabled: false,
        heatmapEnabled: false,
        sampleRate: 0.25,
        heatmapSampleRate: 0.05,
        maskLevel: 'strict',
        maxDuration: 900000,
        blockSelector: '.private',
      },
    });
    expect(
      recorderPayload({
        replay: 'on',
        heatmap: 'on',
        replayRate: '100',
        heatRate: '100',
        duration: '5',
        mask: 'moderate',
      }).replayConfig.replayEnabled,
    ).toBe(true);
    expect(() => recorderPayload({ replayRate: '101', heatRate: '5', duration: '5' })).toThrow();
  });
  it('retains goal descriptions and validates the trigger type', () => {
    expect(
      goalPayload({
        name: ' 报名 ',
        goalType: 'event',
        value: ' submit ',
        description: ' 活动报名 ',
      }),
    ).toEqual({
      name: '报名',
      description: '活动报名',
      parameters: { type: 'event', value: 'submit' },
    });
    expect(() => goalPayload({ name: '报名', goalType: 'arbitrary', value: 'submit' })).toThrow();
  });
  it('retains ordered funnel steps, property operators, and the real stored window', () => {
    const steps: any[] = [
      {
        type: 'event',
        value: 'purchase',
        filters: [{ property: 'plan', operator: 'neq', value: 'free' }],
      },
      {
        type: 'path',
        value: '/thank-you',
        filters: [{ property: 'discard', operator: 'eq', value: 'x' }],
      },
    ];
    expect(funnelPayload({ name: '购买', window: '45', description: '保留说明' }, steps)).toEqual({
      name: '购买',
      description: '保留说明',
      parameters: {
        window: 45,
        steps: [
          {
            type: 'event',
            value: 'purchase',
            filters: [{ property: 'plan', operator: 'neq', value: 'free' }],
          },
          { type: 'path', value: '/thank-you' },
        ],
      },
    });
    expect(() => funnelPayload({ name: '购买', window: '0' }, steps)).toThrow();
    expect(() => funnelPayload({ name: '购买', window: '1' }, steps.slice(0, 1))).toThrow();
    expect(() => funnelPayload({ name: '购买', window: '1' }, Array(9).fill(steps[0]))).toThrow();
  });
  it('creates instance-specific code with the actual site UUID and base path', () => {
    const snippet = trackerSnippet(
      'https://stats.example.com',
      '/analytics/',
      '507825b2-37c1-4d3a-9684-7bcd9d6aabc8',
    );
    expect(snippet).toContain('https://stats.example.com/analytics/script.js');
    expect(snippet).toContain('507825b2-37c1-4d3a-9684-7bcd9d6aabc8');
    expect(snippet).not.toContain('demo-website-id');
    expect(trackerSnippet('https://stats.example.com', '', 'real-site')).toContain(
      'https://stats.example.com/script.js',
    );
  });
  it('distinguishes zero visitors and blocks unsafe callback redirects', () => {
    expect(conversionRate(0, 0)).toBe('—');
    expect(conversionRate(0, 100)).toBe('0.00%');
    expect(conversionRate(25, 100)).toBe('25.00%');
    expect(safeCallbackUrl('/websites?websiteId=abc')).toBe('/websites?websiteId=abc');
    for (const url of ['//attacker.example', 'javascript:alert(1)', '/\\attacker.example', '/a:b'])
      expect(safeCallbackUrl(url)).toBeNull();
    for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
      expect(safeCallbackUrl(`/${String.fromCharCode(code)}/attacker.example`)).toBeNull();
    }
  });
});

describe('core form flows', () => {
  it('blocks 2FA cancellation during confirmation and retains the returned backup codes', async () => {
    let resolve: (value: any) => void;
    mocks.query['2fa-status'] = { isEnabled: false, isConfigured: true };
    mocks.post.mockImplementation(path =>
      path === '/2fa/setup/initiate'
        ? Promise.resolve({
            manualKey: 'temporary-manual-key',
            qrCodeDataUrl: 'data:image/png;base64,AA==',
          })
        : path === '/2fa/setup/confirm'
          ? new Promise(done => {
              resolve = done;
            })
          : Promise.resolve({}),
    );
    const user = userEvent.setup();
    const { rerender } = render(<CorePages page="two-factor" />);
    await user.click(screen.getByRole('button', { name: '生成绑定信息' }));
    await user.type(await screen.findByLabelText(/6 位验证码/), '123456');
    await user.click(screen.getByRole('button', { name: '验证并继续' }));
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(mocks.post).not.toHaveBeenCalledWith('/2fa/setup/cancel');
    resolve({ backupCodes: ['backup-current-session'] });
    await waitFor(() => expect(mocks.context.navigate).toHaveBeenCalledWith('backup-codes'));
    rerender(<CorePages page="backup-codes" />);
    expect(screen.getByText('backup-current-session')).toBeInTheDocument();
  });
  it('discards a delayed setup response after the binding page is unmounted', async () => {
    let resolve: (value: any) => void;
    mocks.query['2fa-status'] = { isEnabled: false, isConfigured: true };
    mocks.post.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const user = userEvent.setup();
    const { rerender } = render(<CorePages page="two-factor" />);
    await user.click(screen.getByRole('button', { name: '生成绑定信息' }));
    rerender(<CorePages page="account" />);
    resolve({ manualKey: 'obsolete-manual-key', qrCodeDataUrl: 'data:image/png;base64,AA==' });
    await user.click(screen.getByRole('button', { name: '修改用户名' }));
    expect(screen.queryByText('obsolete-manual-key')).not.toBeInTheDocument();
    expect(mocks.context.navigate).not.toHaveBeenCalled();
  });
  it.each(['goals', 'funnels'])(
    'clamps %s to the preceding page when the last definition on its final page is deleted',
    async kind => {
      let deleted = false;
      const first = {
        id: 'first',
        name: '首页定义',
        parameters: {
          type: 'path',
          value: '/',
          window: 30,
          steps: [
            { type: 'path', value: '/' },
            { type: 'event', value: 'submit' },
          ],
        },
      };
      const last = { ...first, id: 'last', name: '最后一页定义' };
      mocks.query[kind] = (key: any[]) => ({
        data: key[1] === 2 ? (deleted ? [] : [last]) : [first],
        count: deleted ? 20 : 21,
        page: key[1],
        pageSize: 20,
      });
      mocks.context.api.del.mockImplementation(async () => {
        deleted = true;
        return {};
      });
      const user = userEvent.setup();
      render(<CorePages page={kind} />);
      await user.click(screen.getByRole('button', { name: '下一页' }));
      await user.click(screen.getByRole('button', { name: '删除' }));
      await user.type(screen.getByLabelText(/输入 最后一页定义 确认/), '最后一页定义');
      await user.click(
        screen.getByRole('button', { name: kind === 'goals' ? '删除目标' : '删除漏斗' }),
      );
      await waitFor(() => expect(mocks.queries.filter(key => key[0] === kind).at(-1)?.[1]).toBe(1));
      expect(screen.queryByText('最后一页定义')).not.toBeInTheDocument();
      expect(screen.getAllByText('首页定义').length).toBeGreaterThan(0);
    },
  );
  it.each(['goals', 'funnels'])(
    'returns %s directly to page one when refresh removes several final pages',
    async kind => {
      let removed = false;
      const first = {
        id: 'first',
        name: '首页定义',
        parameters: {
          type: 'path',
          value: '/',
          window: 30,
          steps: [
            { type: 'path', value: '/' },
            { type: 'event', value: 'submit' },
          ],
        },
      };
      mocks.query[kind] = (key: any[]) => ({
        data: removed && key[1] === 4 ? [] : [first],
        count: removed ? 40 : 61,
        page: key[1],
        pageSize: 20,
      });
      const user = userEvent.setup();
      const view = render(<CorePages page={kind} />);
      for (let index = 0; index < 3; index++)
        await user.click(screen.getByRole('button', { name: '下一页' }));
      const before = mocks.queries.length;
      removed = true;
      view.rerender(<CorePages page={kind} />);
      await waitFor(() => expect(mocks.queries.filter(key => key[0] === kind).at(-1)?.[1]).toBe(1));
      const recovery = mocks.queries
        .slice(before)
        .filter(key => key[0] === kind)
        .map(key => key[1]);
      expect(recovery).not.toContain(2);
      expect(recovery).not.toContain(3);
    },
  );
  it.each(['goals', 'funnels'])(
    'clamps %s to page one when deleting the final remaining definition',
    async kind => {
      let deleted = false;
      const only = {
        id: 'only',
        name: '唯一的定义',
        parameters: {
          type: 'path',
          value: '/',
          window: 30,
          steps: [
            { type: 'path', value: '/' },
            { type: 'event', value: 'submit' },
          ],
        },
      };
      mocks.query[kind] = (key: any[]) => ({
        data: deleted ? [] : [only],
        count: deleted ? 0 : 1,
        page: key[1],
        pageSize: 20,
      });
      mocks.context.api.del.mockImplementation(async () => {
        deleted = true;
        return {};
      });
      const user = userEvent.setup();
      render(<CorePages page={kind} />);
      await user.click(screen.getByRole('button', { name: '删除' }));
      await user.type(screen.getByLabelText(/输入 唯一的定义 确认/), '唯一的定义');
      await user.click(
        screen.getByRole('button', { name: kind === 'goals' ? '删除目标' : '删除漏斗' }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mocks.queries.filter(key => key[0] === kind).at(-1)?.[1]).toBe(1);
      expect(screen.queryByText('唯一的定义')).not.toBeInTheDocument();
    },
  );
  it('distinguishes permission failures, server failures, partial subtotals, and real zero website data', () => {
    mocks.context.sites = [
      { id: 'active', name: '活跃网站' },
      { id: 'zero', name: '零访问网站' },
      { id: 'denied', name: '权限网站' },
      { id: 'expired', name: '过期会话网站' },
      { id: 'failed', name: '故障网站' },
    ];
    mocks.query['website-management-stats'] = [
      {
        id: 'active',
        views: 120,
        visitors: 60,
        pageviews: 120,
        aiVisits: 15,
        received: true,
        lastAt: '2026-10-01T00:00:00Z',
        comparison: { pageviews: 100, visitors: 50, aiVisits: 12 },
      },
      {
        id: 'zero',
        views: 0,
        visitors: 0,
        pageviews: 0,
        aiVisits: 0,
        received: false,
        comparison: { pageviews: 0, visitors: 0, aiVisits: 0 },
      },
      { id: 'denied', error: { status: 403, message: 'Forbidden' } },
      { id: 'expired', error: { status: 401, message: 'Expired' } },
      { id: 'failed', error: { status: 503, message: 'Unavailable' } },
    ];
    mocks.query['website-management-today'] = [
      {
        id: 'active',
        views: 12,
        visitors: 6,
        visits: 9,
        bounces: 3,
        aiVisits: 2,
        comparison: { pageviews: 8, visitors: 4, visits: 6, bounces: 2, aiVisits: 1 },
      },
      {
        id: 'zero',
        views: 0,
        visitors: 0,
        visits: 0,
        bounces: 0,
        aiVisits: 0,
        comparison: { pageviews: 0, visitors: 0, visits: 0, bounces: 0, aiVisits: 0 },
      },
    ];
    const { rerender } = render(<CorePages page="websites" />);
    expect(screen.getByText('无统计权限')).toBeInTheDocument();
    expect(screen.getByText('需要重新登录')).toBeInTheDocument();
    expect(screen.getByText('读取失败')).toBeInTheDocument();
    const metricCard = (index: number) =>
      document.querySelectorAll('.metric')[index] as HTMLElement;
    expect(within(metricCard(0)).getByText('60')).toBeInTheDocument();
    expect(metricCard(0)).toHaveTextContent('已读取 2/5 个网站 · 前期 50 · 变化 10');
    expect(within(metricCard(1)).getByText('120')).toBeInTheDocument();
    expect(metricCard(1)).toHaveTextContent('前期 100 · 变化 20');
    expect(within(metricCard(2)).getByText('15')).toBeInTheDocument();
    expect(metricCard(2)).toHaveTextContent('按网站累计，跨网站不去重');
    expect(within(metricCard(3)).getByText('个人 / 团队')).toBeInTheDocument();
    const views = document.querySelectorAll('.metric')[0] as HTMLElement;
    expect(
      within(screen.getByText('零访问网站').closest('tr')).getAllByText('0').length,
    ).toBeGreaterThanOrEqual(3);
    // 昨日块沿用 summary 的 pageviews 字段，不提供 views 别名。
    const activeRow = screen.getByText('活跃网站').closest('tr');
    const yesterdayLabel = within(activeRow as HTMLElement).getAllByText('昨日')[0];
    expect(yesterdayLabel.nextElementSibling).toHaveTextContent('8');
    // 今日/昨日/预计今日文案只保留访问次数列一组，其余三列仅渲染数值行。
    expect(within(activeRow as HTMLElement).getAllByText('预计今日')).toHaveLength(1);
    expect((activeRow as HTMLElement).querySelectorAll('.site-metric-bare')).toHaveLength(9);
    expect(
      within(screen.getByText('故障网站').closest('tr')).getAllByText('—').length,
    ).toBeGreaterThanOrEqual(9);
    mocks.context.sites = [{ id: 'failed', name: '故障网站' }];
    mocks.query['website-management-stats'] = [
      { id: 'failed', error: { status: 503, message: 'Unavailable' } },
    ];
    rerender(<CorePages page="websites" />);
    const visitorCard = document.querySelectorAll('.metric')[0] as HTMLElement;
    expect(within(visitorCard).getByText('—')).toBeInTheDocument();
    expect(within(visitorCard).queryByText('0')).not.toBeInTheDocument();
    expect(within(metricCard(3)).getByText('个人 / 团队')).toBeInTheDocument();
  });
  it.each(['zh-CN', 'en-US'] as const)(
    'explains unavailable browser identity and preserves genuine zero (%s)',
    locale => {
      mocks.context.sites = [{ id: 'history', name: 'Historical site' }];
      const population = {
        metricScope: 'qualified-browser',
        identity: { status: 'unavailable', qualifiedPV: 0 },
      };
      const missing = {
        id: 'history',
        pageviews: null,
        views: null,
        visitors: null,
        visits: null,
        bounces: null,
        aiVisits: null,
        received: true,
        population,
      };
      mocks.query['website-management-stats'] = [{ ...missing, comparison: missing }];
      mocks.query['website-management-today'] = [{ ...missing, comparison: missing }];
      const page = () => (
        <LiekanLocaleContext.Provider value={locale}>
          <CorePages page="websites" />
        </LiekanLocaleContext.Provider>
      );
      const { rerender } = render(page());
      expect(
        screen.getByText(translateText(qualifiedBrowserUnavailableReason, locale)),
      ).toBeVisible();
      const pvCard = document.querySelectorAll('.metric')[1] as HTMLElement;
      expect(pvCard).toHaveTextContent(translateText('未提供', locale));
      expect(
        within(screen.getByText('Historical site').closest('tr')).getAllByText('—').length,
      ).toBeGreaterThanOrEqual(9);
      expect(screen.getByText(translateText('已收到浏览数据', locale))).toBeVisible();
      const partial = {
        ...missing,
        pageviews: 4,
        views: 4,
        visitors: 2,
        population: { ...population, identity: { status: 'partial', qualifiedPV: 4 } },
      };
      mocks.query['website-management-stats'] = [{ ...partial, comparison: missing }];
      mocks.query['website-management-today'] = [{ ...partial, comparison: missing }];
      rerender(page());
      expect(screen.getByText(translateText(qualifiedBrowserReason, locale))).toBeVisible();
      expect(
        within(document.querySelectorAll('.metric')[1] as HTMLElement).getByText('4'),
      ).toBeVisible();
      const zero = {
        ...missing,
        pageviews: 0,
        views: 0,
        visitors: 0,
        visits: 0,
        bounces: 0,
        aiVisits: 0,
        received: false,
        population: { ...population, identity: { status: 'empty', qualifiedPV: 0 } },
      };
      mocks.query['website-management-stats'] = [{ ...zero, comparison: zero }];
      mocks.query['website-management-today'] = [{ ...zero, comparison: zero }];
      rerender(page());
      expect(
        within(document.querySelectorAll('.metric')[1] as HTMLElement).getByText('0'),
      ).toBeVisible();
      expect(
        screen.queryByText(translateText(qualifiedBrowserUnavailableReason, locale)),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(translateText(qualifiedBrowserReason, locale)),
      ).not.toBeInTheDocument();
    },
  );
  it('renders the dashboard-style summary cards with previous-period comparison', () => {
    mocks.context.sites = [
      { id: 'alpha', name: 'Alpha 站' },
      { id: 'beta', name: 'Beta 站' },
    ];
    mocks.query['website-management-stats'] = [
      {
        id: 'alpha',
        received: true,
        visitors: 40,
        pageviews: 80,
        aiVisits: 5,
        comparison: { visitors: 30, pageviews: 70, aiVisits: 4 },
      },
      {
        id: 'beta',
        received: true,
        visitors: 10,
        pageviews: 20,
        aiVisits: 2,
        comparison: { visitors: 15, pageviews: 18, aiVisits: 1 },
      },
    ];
    mocks.query['website-management-today'] = [];
    const { rerender } = render(<CorePages page="websites" />);
    const metricCard = (index: number) =>
      document.querySelectorAll('.metric')[index] as HTMLElement;
    expect(within(metricCard(0)).getByText('50')).toBeInTheDocument();
    expect(metricCard(0)).toHaveTextContent('所选 2 个网站 · 前期 45 · 变化 5');
    expect(within(metricCard(1)).getByText('100')).toBeInTheDocument();
    expect(metricCard(1)).toHaveTextContent('前期 88 · 变化 12');
    expect(within(metricCard(2)).getByText('7')).toBeInTheDocument();
    expect(within(metricCard(3)).getByText('个人 / 团队')).toBeInTheDocument();
    // 对比块缺失时，数值仍展示，前期对比进入独立的未提供状态。
    mocks.query['website-management-stats'] = [
      { id: 'alpha', received: true, visitors: 40, pageviews: 80, aiVisits: 5 },
      { id: 'beta', received: true, visitors: 10, pageviews: 20, aiVisits: 2 },
    ];
    rerender(<CorePages page="websites" />);
    expect(metricCard(0)).toHaveTextContent('前期数据未提供');
    expect(within(metricCard(0)).getByText('50')).toBeInTheDocument();
  });
  it('keeps new website recorder collection off and saves actual units', async () => {
    mocks.query['site-record'] = { ...mocks.context.site, replayConfig: {} };
    mocks.post.mockResolvedValue({});
    const user = userEvent.setup();
    render(<CorePages page="recorder-settings" />);
    expect(screen.getByLabelText(/启用会话回放/)).not.toBeChecked();
    expect(screen.getByLabelText(/启用热力图/)).not.toBeChecked();
    fireEvent.change(screen.getByLabelText(/回放采样率/), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('最长录制时长'), { target: { value: '10' } });
    await user.click(screen.getByRole('button', { name: '保存采集配置' }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/websites/site-1', {
        replayConfig: {
          replayEnabled: false,
          heatmapEnabled: false,
          sampleRate: 0.5,
          heatmapSampleRate: 0.15,
          maskLevel: 'strict',
          maxDuration: 600000,
          blockSelector: '',
        },
      }),
    );
  });
  it('disables mutation controls for a view-only identity even if it owns a website', () => {
    mocks.context.user = { ...mocks.context.user, role: 'view-only', isAdmin: false };
    render(<CorePages page="goal-editor" />);
    expect(screen.getByRole('button', { name: '保存目标' })).toBeDisabled();
  });
  it('permits team-member website editing and creation while keeping transfer restricted', async () => {
    mocks.context.user = { ...mocks.context.user, role: 'user', isAdmin: false };
    mocks.context.site = { ...mocks.context.site, userId: null, teamId: 'team-1' };
    mocks.context.teams = [
      { id: 'team-1', name: '研究团队', members: [{ userId: 'user-1', role: 'team-member' }] },
    ];
    const { rerender } = render(<CorePages page="goal-editor" />);
    expect(screen.getByRole('button', { name: '保存目标' })).toBeEnabled();
    mocks.query['site-record'] = mocks.context.site;
    rerender(<CorePages page="website-settings" />);
    expect(screen.getByRole('button', { name: '保存网站设置' })).toBeEnabled();
    mocks.context.query.section = 'danger';
    rerender(<CorePages page="website-settings" />);
    expect(screen.getByRole('button', { name: '转移网站' })).toBeDisabled();
    rerender(<CorePages page="onboarding" />);
    expect(
      within(screen.getByLabelText('所属空间')).getByRole('option', { name: '研究团队' }),
    ).toBeInTheDocument();
  });
  it('only offers team-to-personal transfer to a team owner or admin', () => {
    mocks.context.user = { ...mocks.context.user, role: 'user', isAdmin: false };
    mocks.context.site = { ...mocks.context.site, userId: null, teamId: 'team-1' };
    mocks.context.teams = [
      { id: 'team-1', name: '研究团队', members: [{ userId: 'user-1', role: 'team-manager' }] },
    ];
    mocks.query['site-record'] = mocks.context.site;
    mocks.context.query.section = 'danger';
    const { rerender } = render(<CorePages page="website-settings" />);
    expect(screen.getByRole('button', { name: '转移网站' })).toBeDisabled();
    mocks.context.teams[0].members[0].role = 'team-owner';
    rerender(<CorePages page="website-settings" />);
    expect(screen.getByRole('button', { name: '转移网站' })).toBeEnabled();
  });
  it('excludes team-member destinations from personal-to-team transfer', async () => {
    mocks.context.user = { ...mocks.context.user, role: 'user', isAdmin: false };
    mocks.context.teams = [
      { id: 'member-team', name: '成员团队', role: 'team-member' },
      { id: 'manager-team', name: '管理团队', role: 'team-manager' },
    ];
    mocks.query['site-record'] = mocks.context.site;
    mocks.context.query.section = 'danger';
    const user = userEvent.setup();
    render(<CorePages page="website-settings" />);
    await user.click(screen.getByRole('button', { name: '转移网站' }));
    const select = screen.getByLabelText('目标空间');
    expect(within(select).getByRole('option', { name: '管理团队' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: '成员团队' })).not.toBeInTheDocument();
  });
  it('shows conversion occurrences and a real series while calculating rate from distinct visitors', () => {
    mocks.query.goals = {
      data: [{ id: 'goal-1', name: '报名', parameters: { type: 'event', value: 'submit' } }],
      count: 1,
    };
    mocks.query['goal-results'] = [
      {
        id: 'goal-1',
        conversions: 386,
        num: 348,
        total: 10944,
        series: [
          { x: '2026-10-01', y: 120 },
          { x: '2026-10-02', y: 266 },
        ],
      },
    ];
    render(<CorePages page="goals" />);
    expect(screen.getAllByText('386')).toHaveLength(2);
    expect(screen.getAllByText('3.18%')).toHaveLength(2);
    expect(screen.getByRole('columnheader', { name: '转化次数' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '报名的转化趋势' })).toHaveTextContent('120,266');
  });
  it('marks all failed goal statistics for aggregate retry instead of configuration caching', async () => {
    mocks.query.goals = { data: [{ id: 'goal-1', name: '报名' }], count: 1 };
    const error = Object.assign(new Error('统计暂时不可用'), { status: 503, retryAfterMs: 90000 });
    mocks.context.api.get.mockRejectedValue(error);
    render(<CorePages page="goals" />);
    const rows = await mocks.loaders['goal-results'](new AbortController().signal);
    expect(rows).toEqual([{ id: 'goal-1', error }]);
    expect(hasClientFreshness(rows)).toBe(true);
    expect(remainingFreshness(rows, Date.now(), 300000)).toBe(0);
  });
  it('honors enforced 2FA and does not offer simulator policy switches', () => {
    mocks.query['2fa-status'] = {
      isEnabled: true,
      isConfigured: true,
      isRequired: true,
      requiredReason: 'team',
    };
    render(<CorePages page="security" />);
    expect(screen.getByRole('button', { name: '关闭双重验证' })).toBeDisabled();
    expect(screen.getByText('团队强制启用')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
  it('clears the complete API key after its creation drawer closes', async () => {
    const persist = vi.spyOn(window.Storage.prototype, 'setItem');
    mocks.query['api-keys'] = [
      { id: 'key-1', name: '已有集成', keyPrefix: 'lk_prefix', createdAt: '2026-10-01T00:00:00Z' },
    ];
    mocks.post.mockResolvedValue({ key: 'lk_private_one_time_value' });
    const user = userEvent.setup();
    render(<CorePages page="api-keys" />);
    await user.click(screen.getByRole('button', { name: '创建密钥' }));
    await user.type(screen.getByLabelText(/密钥名称/), '新集成');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: '创建 API 密钥' }),
    );
    expect(await screen.findByText('lk_private_one_time_value')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '已保存，关闭' }));
    expect(screen.queryByText('lk_private_one_time_value')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '创建密钥' }));
    expect(screen.queryByText('lk_private_one_time_value')).not.toBeInTheDocument();
    expect(persist).not.toHaveBeenCalled();
  });
  it('keeps a delayed API key response available until its creation dialog is explicitly closed', async () => {
    let resolve: (value: any) => void;
    mocks.query['api-keys'] = [];
    mocks.post.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const user = userEvent.setup();
    render(<CorePages page="api-keys" />);
    await user.click(screen.getByRole('button', { name: '创建密钥' }));
    await user.type(screen.getByLabelText(/密钥名称/), '慢响应集成');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: '创建 API 密钥' }),
    );
    await user.click(screen.getByRole('button', { name: '关闭弹窗' }));
    expect(screen.getByLabelText(/密钥名称/)).toBeVisible();
    expect(screen.queryByRole('group', { name: '放弃未保存的修改？' })).not.toBeInTheDocument();
    resolve({ key: 'lk_delayed_private_value' });
    expect(await screen.findByText('lk_delayed_private_value')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '已保存，关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '创建密钥' }));
    expect(screen.getByLabelText(/密钥名称/)).toBeInTheDocument();
    expect(screen.queryByText('lk_delayed_private_value')).not.toBeInTheDocument();
  });
  it('persists an ordered funnel with event property conditions after moving a step', async () => {
    const user = userEvent.setup();
    mocks.context.route.id = 'funnel-1';
    mocks.query['funnel-definition'] = {
      id: 'funnel-1',
      name: '购买路径',
      description: '已有说明',
      parameters: {
        window: 30,
        steps: [
          { type: 'path', value: '/pricing' },
          {
            type: 'event',
            value: 'purchase',
            filters: [{ property: 'plan', operator: 'eq', value: 'pro' }],
          },
        ],
      },
    };
    mocks.post.mockResolvedValue({});
    render(<CorePages page="funnel-editor" />);
    await user.click(screen.getByRole('button', { name: '上移步骤 2' }));
    const first = document.querySelectorAll('.step-editor')[0] as HTMLElement;
    expect(within(first).getByDisplayValue('purchase')).toBeInTheDocument();
    expect(within(first).getByDisplayValue('plan')).toBeInTheDocument();
    fireEvent.change(within(first).getByLabelText('运算符'), { target: { value: 'dnc' } });
    await user.click(screen.getByRole('button', { name: '保存漏斗' }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/websites/site-1/funnels/funnel-1', {
        name: '购买路径',
        description: '已有说明',
        parameters: {
          window: 30,
          steps: [
            {
              type: 'event',
              value: 'purchase',
              filters: [{ property: 'plan', operator: 'dnc', value: 'pro' }],
            },
            { type: 'path', value: '/pricing' },
          ],
        },
      }),
    );
  });
  it('requires a real persisted website before showing installation code', async () => {
    mocks.context.route.page = 'onboarding';
    mocks.post.mockResolvedValue({
      id: 'persisted-site-id',
      name: '研究站',
      domain: 'research.example.com',
      createdAt: '2026-10-01T00:00:00Z',
    });
    const user = userEvent.setup();
    render(<CorePages page="onboarding" />);
    expect(screen.queryByText(/data-website-id=/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '查看安装说明' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '采集与隐私设置' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/网站名称/), '研究站');
    await user.type(screen.getByLabelText(/域名/), 'research.example.com');
    await user.click(screen.getByRole('button', { name: '创建并继续' }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/websites', {
        name: '研究站',
        domain: 'research.example.com',
      }),
    );
    expect(await screen.findByText(/data-website-id="persisted-site-id"/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看安装说明' })).toHaveAttribute(
      'href',
      '/liekan/tracking?websiteId=persisted-site-id',
    );
  });
  it('defaults creation to the permitted current team and keeps the created website bound through verification', async () => {
    mocks.context.route = { page: 'onboarding', teamId: 'team-1' };
    mocks.context.user = { ...mocks.context.user, role: 'user', isAdmin: false };
    mocks.context.teams = [{ id: 'team-1', name: '研究团队', role: 'team-member' }];
    mocks.query.install = { pageviews: 1, firstAt: '2026-10-01T00:00:00Z' };
    mocks.post.mockResolvedValue({
      id: 'created-team-site',
      name: '团队研究站',
      domain: 'team.example.com',
      teamId: 'team-1',
    });
    const user = userEvent.setup();
    render(<CorePages page="onboarding" />);
    expect(screen.getByLabelText('所属空间')).toHaveValue('team-1');
    await user.type(screen.getByLabelText(/网站名称/), '团队研究站');
    await user.type(screen.getByLabelText(/域名/), 'team.example.com');
    await user.click(screen.getByRole('button', { name: '创建并继续' }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/websites', {
        name: '团队研究站',
        domain: 'team.example.com',
        teamId: 'team-1',
      }),
    );
    expect(screen.getByText('团队研究站')).toBeInTheDocument();
    expect(screen.getByText('team.example.com')).toBeInTheDocument();
    expect(screen.getByText('研究团队')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '检查安装（可选）' }));
    expect(screen.getByRole('link', { name: '查看该网站统计' })).toHaveAttribute(
      'href',
      '/liekan/overview?websiteId=created-team-site',
    );
    expect(mocks.context.navigate).not.toHaveBeenCalled();
  });
  it('falls back to personal creation with a truthful warning when the current team is not permitted', async () => {
    mocks.context.route = { page: 'onboarding', teamId: 'read-team' };
    mocks.context.user = { ...mocks.context.user, role: 'user', isAdmin: false };
    mocks.context.teams = [{ id: 'read-team', name: '只读团队', role: 'team-view-only' }];
    mocks.post.mockResolvedValue({
      id: 'personal-created',
      name: '个人研究站',
      domain: 'personal.example.com',
    });
    const user = userEvent.setup();
    render(<CorePages page="onboarding" />);
    expect(screen.getByLabelText('所属空间')).toHaveValue('');
    expect(screen.getByText(/所属空间已选为个人空间/)).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('所属空间')).queryByRole('option', { name: '只读团队' }),
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/网站名称/), '个人研究站');
    await user.type(screen.getByLabelText(/域名/), 'personal.example.com');
    await user.click(screen.getByRole('button', { name: '创建并继续' }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/websites', {
        name: '个人研究站',
        domain: 'personal.example.com',
      }),
    );
  });
  it('rejects a submitted team ownership outside the permitted destinations', async () => {
    mocks.context.user = { ...mocks.context.user, role: 'user', isAdmin: false };
    const user = userEvent.setup();
    render(<CorePages page="onboarding" />);
    await user.type(screen.getByLabelText(/网站名称/), '研究站');
    await user.type(screen.getByLabelText(/域名/), 'research.example.com');
    const ownership = screen.getByLabelText('所属空间') as HTMLSelectElement;
    ownership.add(new Option('未授权团队', 'forbidden-team'));
    ownership.value = 'forbidden-team';
    fireEvent.submit(ownership.closest('form'));
    expect(await screen.findByRole('alert')).toHaveTextContent('没有在所选团队创建网站的权限');
    expect(mocks.post).not.toHaveBeenCalled();
    expect(screen.queryByText(/data-website-id=/)).not.toBeInTheDocument();
  });
  it('derives settings sections from the URL and binds collection operations to the current website', async () => {
    mocks.context.query.section = 'collection';
    mocks.query['site-record'] = mocks.context.site;
    mocks.query.install = { pageviews: 1 };
    mocks.query['website-setup-report'] = {
      states: { logs: 'not_connected', catalog: 'available' },
      meta: {},
    };
    const user = userEvent.setup();
    const { rerender } = render(<CorePages page="website-settings" />);
    expect(screen.getByRole('tab', { name: '采集设置' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('尚未导入日志')).toBeInTheDocument();
    expect(screen.getByText('已有内容目录')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '回放与热力图设置' })).toHaveAttribute(
      'href',
      '/liekan/recorder-settings?websiteId=site-1',
    );
    await user.click(screen.getByRole('button', { name: '导入网站日志' }));
    expect(mocks.managementDrawer).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: '导入日志', websiteId: 'site-1', canManage: true }),
    );
    await user.click(screen.getByRole('tab', { name: '基本信息' }));
    expect(mocks.context.navigate).toHaveBeenCalledWith('website-settings', {
      websiteId: 'site-1',
      section: 'basic',
    });
    mocks.context.query.section = 'basic';
    rerender(<CorePages page="website-settings" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存网站设置' })).toBeInTheDocument();
    mocks.context.query.section = 'sharing';
    rerender(<CorePages page="website-settings" />);
    expect(screen.getByRole('tab', { name: '分享设置' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('当前网站分享组件')).toBeInTheDocument();
    mocks.context.query.section = 'invalid-section';
    rerender(<CorePages page="website-settings" />);
    expect(screen.getByRole('tab', { name: '基本信息' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: '删除网站' })).not.toBeInTheDocument();
  });
  it('keeps failed collection checks distinct from received data and recorder configuration', () => {
    mocks.context.query.section = 'collection';
    mocks.query['site-record'] = {
      ...mocks.context.site,
      replayConfig: { replayEnabled: true, heatmapEnabled: true },
    };
    mocks.query.install = { pageviews: 10 };
    mocks.query['website-setup-report'] = {
      states: { logs: 'available', catalog: 'available' },
      meta: { latestImportAt: '2026-10-01T00:00:00Z' },
    };
    mocks.queryStates.install = { error: { status: 503, message: '浏览统计不可用' } };
    mocks.queryStates['website-setup-report'] = {
      error: { status: 503, message: '日志统计不可用' },
    };
    render(<CorePages page="website-settings" />);
    expect(screen.getAllByText('读取失败')).toHaveLength(3);
    expect(screen.queryByText('已收到浏览数据')).not.toBeInTheDocument();
    expect(screen.queryByText('已收到日志数据')).not.toBeInTheDocument();
    expect(screen.queryByText('已有内容目录')).not.toBeInTheDocument();
    expect(screen.queryByText(/最近导入日志/)).not.toBeInTheDocument();
    expect(screen.getByText('回放已启用 · 热力图已启用 · 数据状态未验证')).toBeInTheDocument();
  });
  it('formats collection reception times in the displayed statistics timezone', () => {
    mocks.context.query.section = 'collection';
    mocks.context.range.timezone = 'Pacific/Honolulu';
    mocks.query['site-record'] = mocks.context.site;
    mocks.query.install = { pageviews: 1 };
    mocks.query['website-setup-report'] = {
      states: { logs: 'available', catalog: 'available' },
      meta: { latestImportAt: '2026-10-03T00:00:00Z' },
    };
    const formatter = vi.spyOn(Date.prototype, 'toLocaleString');
    try {
      render(<CorePages page="website-settings" />);
      expect(screen.getByText(/日志统计期间/)).toHaveTextContent('Pacific/Honolulu');
      expect(formatter).toHaveBeenCalledWith('zh-CN', { timeZone: 'Pacific/Honolulu' });
      expect(screen.getByText(/最近导入日志/)).toHaveTextContent('2026/10/2 14:00:00');
    } finally {
      formatter.mockRestore();
    }
  });
  it('does not treat custom event timestamps as the first browser pageview', () => {
    mocks.context.route = { page: 'website-settings' };
    mocks.query['site-record'] = mocks.context.site;
    mocks.context.range.timezone = 'Asia/Shanghai';
    mocks.context.query = { section: 'install' };
    mocks.query.install = {
      pageviews: 0,
      firstAt: '2026-10-01T00:00:00Z',
      lastAt: '2026-10-01T00:00:00Z',
    };
    mocks.query['website-setup-report'] = {
      states: { logs: 'not_connected', catalog: 'not_connected' },
      meta: {},
    };
    render(<CorePages page="website-settings" />);
    expect(screen.getByText('尚未收到浏览数据')).toBeInTheDocument();
    expect(screen.queryByText('已收到浏览数据')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '跳过检查，下一步' })).toBeEnabled();
  });
  it('saves each skipped check and completes setup without recording a fake connection', async () => {
    mocks.query['site-record'] = mocks.context.site;
    mocks.query.install = { pageviews: 0 };
    mocks.context.query = { section: 'install', step: 'js' };
    mocks.post.mockResolvedValue({});
    const user = userEvent.setup();
    const { rerender } = render(<CorePages page="website-settings" />);
    await user.click(screen.getByRole('button', { name: '跳过检查，下一步' }));
    expect(mocks.post).toHaveBeenLastCalledWith('/liekan/websites/site-1/installation', {
      action: 'skip-browser',
    });
    expect(mocks.context.navigate).toHaveBeenLastCalledWith('website-settings', {
      websiteId: 'site-1',
      section: 'install',
      step: 'logs',
      method: 'cloudflare',
    });
    mocks.context.query = { section: 'install', step: 'logs', method: 'server' };
    rerender(<CorePages page="website-settings" />);
    const setup = screen.getByRole('button', { name: /开始配置|查看配置说明/ });
    expect(setup).toBeEnabled();
    await user.click(setup);
    expect(screen.getByRole('region', { name: '接收服务配置引导' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '跳过检查，继续' }));
    expect(mocks.post).toHaveBeenLastCalledWith('/liekan/websites/site-1/installation', {
      action: 'skip-logs',
      method: 'server',
    });
    mocks.context.query.step = 'finish';
    rerender(<CorePages page="website-settings" />);
    expect(screen.getAllByText('尚未收到浏览数据')[0]).toBeVisible();
    expect(screen.getAllByText('尚未收到日志')[0]).toBeVisible();
    await user.click(screen.getByRole('button', { name: '完成设置' }));
    expect(mocks.post).toHaveBeenLastCalledWith('/liekan/websites/site-1/installation', {
      action: 'finish',
      method: 'server',
    });
    expect(mocks.context.navigate).toHaveBeenLastCalledWith('website-settings', {
      websiteId: 'site-1',
      section: 'install',
      step: 'complete',
      method: 'server',
    });
    expect(mocks.post.mock.calls.every(([path]) => path.endsWith('/installation'))).toBe(true);
  });
  it('shows delayed progress after completion and reopens the exact website steps', () => {
    mocks.query['site-record'] = mocks.context.site;
    mocks.query.install = { pageviews: 0 };
    mocks.query['website-installation'].progress = {
      method: 'server',
      browserCheckDeferred: true,
      logCheckDeferred: true,
      completedAt: '2026-10-04T00:00:00Z',
    };
    mocks.context.query = { section: 'install' };
    render(<CorePages page="website-settings" />);
    expect(
      screen.getByRole('heading', { name: '接入设置已保存', level: 3 }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('检查已延后')).toHaveLength(2);
    expect(screen.getByRole('link', { name: '服务器安装页面' })).toHaveAttribute(
      'href',
      '/liekan/website-settings?websiteId=site-1&section=install&step=logs&method=server',
    );
    expect(screen.getByRole('link', { name: '获取 JS 代码' })).toHaveAttribute(
      'href',
      '/liekan/website-settings?websiteId=site-1&section=install&step=js',
    );
  });
  it('saves normal advancement and resumes the saved step without deferring checks', async () => {
    mocks.query['site-record'] = mocks.context.site;
    mocks.query.install = { pageviews: 100 };
    mocks.query['website-installation'].logs.total = 5;
    mocks.context.query = { section: 'install' };
    mocks.post.mockImplementation(async (_path, body) => {
      mocks.query['website-installation'].progress.lastStep = body.step;
      return {};
    });
    const user = userEvent.setup();
    const { rerender } = render(<CorePages page="website-settings" />);
    await user.click(screen.getByText('下一步：接入日志', { exact: true }));
    expect(mocks.post).toHaveBeenLastCalledWith('/liekan/websites/site-1/installation', {
      action: 'continue',
      step: 'logs',
      method: 'cloudflare',
    });
    expect(mocks.context.navigate).toHaveBeenLastCalledWith('website-settings', {
      websiteId: 'site-1',
      section: 'install',
      step: 'logs',
      method: 'cloudflare',
    });
    rerender(<CorePages page="website-settings" />);
    expect(screen.getByText('接入 AI 蜘蛛日志')).toBeInTheDocument();
    await user.click(screen.getByText('下一步：完成设置', { exact: true }));
    expect(mocks.post).toHaveBeenLastCalledWith('/liekan/websites/site-1/installation', {
      action: 'continue',
      step: 'finish',
      method: 'cloudflare',
    });
    rerender(<CorePages page="website-settings" />);
    expect(screen.getByText('完成接入设置')).toBeInTheDocument();
    expect(mocks.query['website-installation'].progress).toMatchObject({
      browserCheckDeferred: false,
      logCheckDeferred: false,
      completedAt: null,
    });
  });
  it.each(['js', 'finish', 'logs'])(
    'preserves newer same-website navigation after a delayed save (%s)',
    async target => {
      mocks.query['site-record'] = mocks.context.site;
      mocks.query.install = { pageviews: 0 };
      mocks.context.query = { section: 'install', step: 'logs', method: 'cloudflare' };
      let resolve: (value: any) => void;
      mocks.post.mockImplementationOnce(
        () =>
          new Promise(done => {
            resolve = done;
          }),
      );
      const user = userEvent.setup();
      const { rerender } = render(<CorePages page="website-settings" />);
      await user.click(screen.getByRole('button', { name: '跳过检查，继续' }));
      mocks.context.navigate.mockClear();
      mocks.context.query.step = target === 'logs' ? 'js' : target;
      rerender(<CorePages page="website-settings" />);
      if (target === 'logs') {
        mocks.context.query.step = 'logs';
        rerender(<CorePages page="website-settings" />);
      }
      resolve({});
      await waitFor(() => expect(mocks.context.notify).toHaveBeenCalledWith('接入进度已保存'));
      expect(mocks.context.navigate).not.toHaveBeenCalled();
    },
  );
  it.each(['js', undefined])(
    'labels demo browser events at the installation and settings entries (%s)',
    step => {
      mocks.query['site-record'] = mocks.context.site;
      mocks.query.install = { pageviews: 100 };
      mocks.query['website-installation'].logs.demo = true;
      mocks.context.query = step ? { section: 'install', step } : {};
      render(<CorePages page="website-settings" />);
      expect(screen.getByText(/已有示例浏览数据/)).toBeInTheDocument();
      expect(screen.queryByText('已收到浏览数据')).not.toBeInTheDocument();
      expect(screen.getByText(/示例浏览访问和日志/)).toBeInTheDocument();
    },
  );
  it('keeps a pending method choice when moving to finish and saving completion', async () => {
    mocks.query['site-record'] = mocks.context.site;
    mocks.query.install = { pageviews: 0 };
    mocks.context.query = { section: 'install', step: 'logs', method: 'cloudflare' };
    let resolve: (value: any) => void;
    mocks.post.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const user = userEvent.setup();
    const { rerender } = render(<CorePages page="website-settings" />);
    await user.click(screen.getByRole('radio', { name: /服务器一次安装/ }));
    const finishLink = within(screen.getByRole('navigation', { name: '接入设置步骤' })).getByRole(
      'link',
      { name: /完成设置/ },
    );
    expect(finishLink).toHaveAttribute(
      'href',
      '/liekan/website-settings?websiteId=site-1&section=install&step=finish&method=server',
    );
    mocks.context.query = { section: 'install', step: 'finish', method: 'server' };
    rerender(<CorePages page="website-settings" />);
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled();
    mocks.query['website-installation'].progress.method = 'server';
    resolve({ progress: mocks.query['website-installation'].progress });
    await waitFor(() => expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled());
    mocks.post.mockResolvedValue({});
    await user.click(screen.getByRole('button', { name: '完成设置' }));
    expect(mocks.post).toHaveBeenLastCalledWith('/liekan/websites/site-1/installation', {
      action: 'finish',
      method: 'server',
    });
  });
  it.each(['complete', 'overview'])(
    'uses the saved method on %s even when a historical URL disagrees',
    step => {
      mocks.query['site-record'] = mocks.context.site;
      mocks.query.install = { pageviews: 0 };
      mocks.query['website-installation'].progress.method = 'server';
      mocks.query['website-installation'].progress.completedAt = '2026-10-04T00:00:00Z';
      mocks.context.query = { section: 'install', step, method: 'cloudflare' };
      render(<CorePages page="website-settings" />);
      expect(screen.getByRole('link', { name: '服务器安装页面' })).toHaveAttribute(
        'href',
        '/liekan/website-settings?websiteId=site-1&section=install&step=logs&method=server',
      );
      expect(screen.queryByRole('link', { name: '授权连接页面' })).not.toBeInTheDocument();
    },
  );
  it('uses the saved method when continuing from a historical check URL', async () => {
    mocks.query['site-record'] = mocks.context.site;
    mocks.query.install = { pageviews: 0 };
    mocks.query['website-installation'].progress.method = 'server';
    mocks.context.query = { section: 'install', step: 'check', method: 'cloudflare' };
    mocks.post.mockResolvedValue({});
    const user = userEvent.setup();
    render(<CorePages page="website-settings" />);
    await user.click(screen.getByRole('button', { name: '跳过检查，继续设置' }));
    expect(mocks.post).toHaveBeenLastCalledWith('/liekan/websites/site-1/installation', {
      action: 'skip-checks',
      method: 'server',
    });
  });
  it('keeps normal next-step browsing available to read-only users', async () => {
    mocks.query['site-record'] = mocks.context.site;
    mocks.query.install = { pageviews: 100 };
    mocks.query['website-installation'].canManage = false;
    mocks.context.query = { section: 'install', step: 'js' };
    render(<CorePages page="website-settings" />);
    expect(screen.getByRole('link', { name: '下一步：接入日志' })).toHaveAttribute(
      'href',
      '/liekan/website-settings?websiteId=site-1&section=install&step=logs&method=cloudflare',
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('lets a historical URL take over after a method draft leaves its original navigation', async () => {
    mocks.query['site-record'] = mocks.context.site;
    mocks.query.install = { pageviews: 0 };
    mocks.context.query = { section: 'install', step: 'logs', method: 'cloudflare' };
    mocks.post.mockResolvedValue({});
    const user = userEvent.setup();
    const { rerender } = render(<CorePages page="website-settings" />);
    await user.click(screen.getByRole('radio', { name: /服务器一次安装/ }));
    expect(screen.getByRole('radio', { name: /服务器一次安装/ })).toBeChecked();
    mocks.context.query.method = 'server';
    rerender(<CorePages page="website-settings" />);
    mocks.context.query.method = 'cloudflare';
    rerender(<CorePages page="website-settings" />);
    expect(screen.getByRole('radio', { name: /Cloudflare 授权连接/ })).toBeChecked();
    expect(
      within(screen.getByRole('navigation', { name: '接入设置步骤' })).getByRole('link', {
        name: /完成设置/,
      }),
    ).toHaveAttribute(
      'href',
      '/liekan/website-settings?websiteId=site-1&section=install&step=finish&method=cloudflare',
    );
  });
  it('keeps browser errors and zero AI matches visible after skipping, and marks demo receipts', () => {
    mocks.query['site-record'] = mocks.context.site;
    mocks.query.install = { pageviews: 100 };
    mocks.queryStates.install = { error: { message: '服务暂时不可用' } };
    mocks.query['website-installation'].progress.browserCheckDeferred = true;
    mocks.query['website-installation'].progress.logCheckDeferred = true;
    mocks.query['website-installation'].logs = {
      total: 5,
      ai: 0,
      demo: true,
      latestAt: null,
      latestImportAt: null,
    };
    render(<CorePages page="install-check" />);
    expect(screen.getByText('读取失败')).toBeInTheDocument();
    expect(screen.queryByText('已收到浏览数据')).not.toBeInTheDocument();
    expect(screen.getByText('日志已收到，暂未匹配到 AI 蜘蛛请求。')).toBeInTheDocument();
    expect(screen.getByText('已有示例日志')).toBeInTheDocument();
    expect(screen.getByText(/示例.*不能证明/)).toBeInTheDocument();
  });
  it('uses the unified guide at old tracking URLs and prevents read-only progress changes', () => {
    mocks.query['site-record'] = mocks.context.site;
    mocks.query.install = { pageviews: 0 };
    mocks.query['website-installation'].canManage = false;
    render(<CorePages page="tracking" />);
    expect(screen.getByText('安装网站统计 JS')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制安装代码' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '跳过检查，下一步' })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('does not navigate back to the old website after a delayed save resolves', async () => {
    mocks.query['site-record'] = mocks.context.site;
    mocks.query.install = { pageviews: 0 };
    let resolve: (value: any) => void;
    mocks.post.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const user = userEvent.setup();
    const { rerender } = render(<CorePages page="tracking" />);
    await user.click(screen.getByRole('button', { name: '跳过检查，下一步' }));
    mocks.context.siteId = 'site-2';
    mocks.query['site-record'] = { ...mocks.context.site, id: 'site-2', name: '第二个网站' };
    rerender(<CorePages page="tracking" />);
    resolve({});
    await waitFor(() => expect(screen.getByText('第二个网站')).toBeInTheDocument());
    expect(mocks.context.navigate).not.toHaveBeenCalled();
  });
  it('names the website in the save result and keeps website sharing links scoped', async () => {
    mocks.query['site-record'] = mocks.context.site;
    mocks.post.mockResolvedValue({});
    const user = userEvent.setup();
    render(<CorePages page="website-settings" />);
    await user.clear(screen.getByLabelText(/网站名称/));
    await user.type(screen.getByLabelText(/网站名称/), '更新的网站');
    await user.click(screen.getByRole('button', { name: '保存网站设置' }));
    await waitFor(() =>
      expect(mocks.context.notify).toHaveBeenCalledWith('「更新的网站」的网站设置已保存'),
    );
    expect(screen.getByRole('link', { name: '分享设置' })).toHaveAttribute(
      'href',
      '/liekan/sharing?websiteId=site-1&context=website',
    );
  });
  it('states the actual clear-data scope and retains the existing reset endpoint and confirmation', async () => {
    mocks.context.query.section = 'danger';
    mocks.query['site-record'] = { ...mocks.context.site, name: '研究站' };
    mocks.post.mockResolvedValue({});
    const user = userEvent.setup();
    render(<CorePages page="website-settings" />);
    await user.click(screen.getByRole('button', { name: '清空访问数据' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('alert')).toHaveTextContent('GEOInflow 日志与导入记录');
    expect(dialog.getByRole('alert')).toHaveTextContent(
      '内容目录、策略、网站设置和安装标识继续保留',
    );
    expect(dialog.getByRole('alert')).toHaveTextContent('回放、热力图、收入记录');
    expect(dialog.queryByRole('button', { name: '确认操作' })).not.toBeInTheDocument();
    await user.type(dialog.getByLabelText(/输入 RESET 确认/), 'RESET');
    await user.click(dialog.getByRole('button', { name: '清空访问数据' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/websites/site-1/reset'));
    expect(mocks.context.notify).toHaveBeenCalledWith('「研究站」的访问数据已清空');
    expect(mocks.context.api.del).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '删除网站' }));
    await user.type(screen.getByLabelText(/输入 研究站 确认/), '错误名称');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除网站' }));
    expect(mocks.context.api.del).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText(/输入 研究站 确认/));
    await user.type(screen.getByLabelText(/输入 研究站 确认/), '研究站');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除网站' }));
    await waitFor(() => expect(mocks.context.api.del).toHaveBeenCalledWith('/websites/site-1'));
    expect(mocks.context.navigate).toHaveBeenCalledWith('websites', undefined, { replace: true });
  });
  it('runs login without the normal app provider and honors partial authentication', async () => {
    mocks.context = null;
    mocks.post.mockResolvedValue({ requiresTwoFactor: true, partialToken: 'partial' });
    mocks.login.mockReturnValue('/login/two-factor');
    const user = userEvent.setup();
    render(<FeatureAuthPage page="login" />);
    await user.type(screen.getByLabelText(/用户名/), 'admin');
    await user.type(screen.getByLabelText(/^密码/), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/login/two-factor'));
  });
  it('rejects unsafe SSO callbacks before verifying any token', async () => {
    mocks.context = null;
    mocks.params = new URLSearchParams({ token: 'callback-token', url: '//attacker.example' });
    render(<FeatureAuthPage page="sso" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('回调地址无效');
    expect(mocks.sso).not.toHaveBeenCalled();
  });
  it.each(['collection', 'install'])(
    'waits for both post-import refreshes at the %s entry',
    async section => {
      mocks.context.query = { section, step: 'logs', method: 'manual' };
      mocks.query['site-record'] = mocks.context.site;
      mocks.query.install = { pageviews: 1 };
      mocks.query['website-setup-report'] = { states: {}, meta: {} };
      let finishIdentity: () => void;
      let finishReport: () => void;
      mocks.context.refresh.mockReturnValue(
        new Promise<void>(resolve => {
          finishIdentity = resolve;
        }),
      );
      const refetch = vi.fn(
        () =>
          new Promise<void>(resolve => {
            finishReport = resolve;
          }),
      );
      mocks.queryStates[
        section === 'collection' ? 'website-setup-report' : 'website-installation'
      ] = { refetch };
      const user = userEvent.setup();
      render(<CorePages page="website-settings" />);
      await user.click(screen.getByRole('button', { name: '导入网站日志' }));
      const onSaved = mocks.managementDrawer.mock.lastCall[0].onSaved;
      let settled = false;
      const result = Promise.resolve(onSaved()).finally(() => {
        settled = true;
      });
      try {
        await Promise.resolve();
        expect(settled).toBe(false);
        finishIdentity();
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(refetch).toHaveBeenCalledWith({ throwOnError: true });
      } finally {
        finishIdentity();
        finishReport();
        await result;
      }
      expect(settled).toBe(true);
    },
  );
  it.each(['collection', 'install'])(
    'reports a post-import refresh error after all refreshes settle at the %s entry',
    async section => {
      mocks.context.query = { section, step: 'logs', method: 'manual' };
      mocks.query['site-record'] = mocks.context.site;
      mocks.query.install = { pageviews: 1 };
      mocks.query['website-setup-report'] = { states: {}, meta: {} };
      const failure = new Error('页面统计刷新失败');
      let finishIdentity: () => void;
      mocks.context.refresh.mockReturnValue(
        new Promise<void>(resolve => {
          finishIdentity = resolve;
        }),
      );
      const refetch = vi.fn((options?: { throwOnError?: boolean }) =>
        options?.throwOnError ? Promise.reject(failure) : Promise.resolve({ error: failure }),
      );
      mocks.queryStates[
        section === 'collection' ? 'website-setup-report' : 'website-installation'
      ] = { refetch };
      const user = userEvent.setup();
      render(<CorePages page="website-settings" />);
      await user.click(screen.getByRole('button', { name: '导入网站日志' }));
      let outcome: unknown = 'pending';
      const result = Promise.resolve(mocks.managementDrawer.mock.lastCall[0].onSaved()).then(
        () => {
          outcome = 'resolved';
        },
        error => {
          outcome = error;
        },
      );
      try {
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(outcome).toBe('pending');
      } finally {
        finishIdentity();
        await result;
      }
      expect(outcome).toBe(failure);
    },
  );
});

it('reports the username as saved when the subsequent identity refresh fails', async () => {
  mocks.context.refresh.mockRejectedValue(new Error('刷新暂时不可用'));
  const user = userEvent.setup();
  render(<CorePages page="account" />);
  await user.click(screen.getByRole('button', { name: '修改用户名' }));
  await user.clear(screen.getByRole('textbox', { name: /^用户名/ }));
  await user.type(screen.getByRole('textbox', { name: /^用户名/ }), 'saved-owner');
  await user.click(screen.getByRole('button', { name: '保存用户名' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(mocks.post).toHaveBeenCalledWith('/users/user-1', { username: 'saved-owner' });
  expect(mocks.context.notify).toHaveBeenCalledWith('用户名已保存，页面状态刷新失败，请重新读取。');
});
it('displays the current account profile response while keeping another identity out', () => {
  mocks.query['account-profile'] = {
    user: { ...mocks.context.user, username: 'updated-account', role: 'view-only' },
  };
  const view = render(<CorePages page="account" />);
  expect(screen.getByText('updated-account')).toBeVisible();
  mocks.query['account-profile'] = { user: { id: 'other', username: 'another-account' } };
  view.rerender(<CorePages page="account" />);
  expect(screen.queryByText('another-account')).not.toBeInTheDocument();
});
