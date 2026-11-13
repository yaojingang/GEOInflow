import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Navigation } from './Navigation';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  post: vi.fn(),
  clear: vi.fn(),
  cancel: vi.fn(() => Promise.resolve()),
  clearLogin: vi.fn(),
  prefetch: vi.fn((_options: any) => Promise.resolve()),
  get: vi.fn((_path: string, _params?: any, _signal?: AbortSignal, _options?: any) =>
    Promise.resolve({}),
  ),
  display: {} as Record<string, boolean>,
  displayError: false,
  reportedDisplay: {} as Record<string, boolean>,
  pathname: '/websites/site-a/goals/create',
  query: {} as Record<string, string>,
}));
vi.mock('next/link', () => ({
  useLinkStatus: () => ({ pending: false }),
  default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a>,
}));
vi.mock('@/lib/liekan/upstream/client', () => {
  const router = { push: mocks.push, replace: mocks.replace };
  return {
    useFeatureDateRange: () => ({ dateRange: { startDate: new Date(0), endDate: new Date(1000) } }),
    useNavigation: () => ({
      pathname: mocks.pathname,
      query: mocks.query,
      router,
    }),
  };
});
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  skipToken: Symbol('skipToken'),
  useQueryClient: () => ({
    clear: mocks.clear,
    cancelQueries: mocks.cancel,
    prefetchQuery: mocks.prefetch,
    getQueryCache: () => ({ subscribe: () => () => {} }),
  }),
  useQuery: ({ queryKey }: any) => ({
    isPending: false,
    data: queryKey.includes('website-display-settings')
      ? mocks.displayError
        ? undefined
        : { aiCrawlerEnabled: mocks.display[queryKey[3]] }
      : queryKey.includes('reported-crawler-display')
        ? mocks.reportedDisplay[queryKey[3]]
        : queryKey.includes('sites')
          ? [
              { id: 'site-a', name: '网站 A', domain: 'a.test' },
              { id: 'site-b', name: '网站 B', domain: 'b.test' },
            ]
          : [],
  }),
}));
vi.mock('@/lib/liekan/upstream/features-client', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/liekan/upstream/features-client')>()),
  getFeatureSites: vi.fn(),
  getAllFeatureRows: vi.fn(),
  featureApi: { post: mocks.post, get: mocks.get },
  clearFeatureLogin: mocks.clearLogin,
}));

describe('website navigation transitions', () => {
  it('keeps canonicalizing after a date update replaces a cached legacy address', () => {
    const id = 'b880cb21-e65a-4fdf-9c0e-3da5aed4e0fa';
    mocks.pathname = `/websites/${id}/geo/ai/bots`;
    window.history.replaceState(null, '', mocks.pathname);
    const props = {
      user: { id: 'user', username: 'admin' } as any,
      route: { page: 'geo-bots', websiteId: id },
      site: { id, siteNumber: 102, name: '当前网站' },
      width: 228,
      onWidth: vi.fn(),
    };
    const view = render(<Navigation {...props} />);
    expect(mocks.replace).toHaveBeenCalledWith('/websites/102/geo/ai/bots', { scroll: false });
    mocks.replace.mockClear();
    mocks.query = { date: 'range:1788969600000:1791561599999', dateMode: 'default' };
    const suffix = '?date=range%3A1788969600000%3A1791561599999&dateMode=default';
    window.history.replaceState(null, '', mocks.pathname + suffix);
    view.rerender(<Navigation {...props} />);
    expect(mocks.replace).toHaveBeenCalledWith('/websites/102/geo/ai/bots' + suffix, {
      scroll: false,
    });
  });

  it('shortens website URLs when the app is mounted under a base path', () => {
    const id = 'b880cb21-e65a-4fdf-9c0e-3da5aed4e0fa';
    mocks.pathname = `/websites/${id}/geo/ai/bots`;
    vi.stubEnv('basePath', '/statistics');
    try {
      window.history.replaceState(null, '', `/statistics${mocks.pathname}?date=30day`);
      render(
        <Navigation
          user={{ id: 'user', username: 'admin' } as any}
          route={{ page: 'geo-bots', websiteId: id }}
          site={{ id, siteNumber: 102, name: '当前网站' }}
          width={228}
          onWidth={vi.fn()}
        />,
      );
      expect(mocks.replace).toHaveBeenCalledWith('/websites/102/geo/ai/bots?date=30day', {
        scroll: false,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('replaces a legacy website URL with its site number and keeps the date and fragment', () => {
    const id = 'b880cb21-e65a-4fdf-9c0e-3da5aed4e0fa';
    mocks.pathname = `/websites/${id}/geo/ai/bots`;
    const suffix = '?date=range%3A1788969600000%3A1791561599999&dateMode=default#risk';
    window.history.replaceState(null, '', mocks.pathname + suffix);
    render(
      <Navigation
        user={{ id: 'user', username: 'admin' } as any}
        route={{ page: 'geo-bots', websiteId: id }}
        site={{ id, siteNumber: 102, name: '当前网站' }}
        width={228}
        onWidth={vi.fn()}
      />,
    );
    expect(mocks.replace).toHaveBeenCalledWith(`/websites/102/geo/ai/bots${suffix}`, {
      scroll: false,
    });
    expect(screen.getByRole('link', { name: 'AI 爬虫' })).toHaveAttribute(
      'href',
      '/websites/102/geo/ai/bots',
    );
  });

  it('waits for matching website metadata before shortening a URL', () => {
    const id = 'b880cb21-e65a-4fdf-9c0e-3da5aed4e0fa';
    mocks.pathname = `/websites/${id}/geo/ai/bots`;
    window.history.replaceState(null, '', mocks.pathname);
    const props = {
      user: { id: 'user', username: 'admin' } as any,
      route: { page: 'geo-bots', websiteId: id },
      width: 228,
      onWidth: vi.fn(),
    };
    const view = render(<Navigation {...props} />);
    expect(mocks.replace).not.toHaveBeenCalled();
    view.rerender(
      <Navigation {...props} site={{ id: 'another-site', siteNumber: 101, name: '其他网站' }} />,
    );
    expect(mocks.replace).not.toHaveBeenCalled();
    view.rerender(<Navigation {...props} site={{ id, siteNumber: 102, name: '当前网站' }} />);
    expect(mocks.replace).toHaveBeenCalledWith('/websites/102/geo/ai/bots', { scroll: false });
  });

  it('uses the current report display mode when settings cannot be read and recovers with fresh settings', () => {
    mocks.displayError = true;
    mocks.reportedDisplay = { 'site-a': false };
    const props = { user: { id: 'user', username: 'admin' } as any, width: 228, onWidth: vi.fn() };
    const view = render(
      <Navigation {...props} route={{ page: 'overview', websiteId: 'site-a' }} />,
    );
    expect(screen.queryByRole('link', { name: '抓取总览' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '访客总览' })).toBeInTheDocument();
    mocks.displayError = false;
    mocks.display = { 'site-a': true };
    view.rerender(<Navigation {...props} route={{ page: 'overview', websiteId: 'site-a' }} />);
    expect(screen.getByRole('link', { name: '抓取总览' })).toBeInTheDocument();
  });
  it('hides only the current website crawler group and restores the default for another website', () => {
    mocks.display = { 'site-a': false };
    const props = { user: { id: 'user', username: 'admin' } as any, width: 228, onWidth: vi.fn() };
    const view = render(
      <Navigation {...props} route={{ page: 'overview', websiteId: 'site-a' }} />,
    );
    expect(screen.queryByText('AI 抓取分析')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '抓取总览' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '访客总览' })).toBeInTheDocument();
    view.rerender(<Navigation {...props} route={{ page: 'overview', websiteId: 'site-b' }} />);
    expect(screen.getByRole('link', { name: '抓取总览' })).toBeInTheDocument();
    view.rerender(<Navigation {...props} route={{ page: 'overview', websiteId: 'site-a' }} />);
    expect(screen.queryByRole('link', { name: '抓取总览' })).not.toBeInTheDocument();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.display = {};
    mocks.displayError = false;
    mocks.reportedDisplay = {};
    mocks.pathname = '/websites/site-a/goals/create';
    mocks.query = {};
    window.history.replaceState(null, '', '/');
    document.body.style.overflow = '';
  });
  it('keeps website switching and account actions available in the shared compact website layout', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    try {
      const view = render(
        <Navigation
          user={{ id: 'user', username: 'admin' } as any}
          route={{ page: 'segments', websiteId: 'site-a' }}
          site={{ id: 'site-a', name: '网站 A', domain: 'a.test' }}
          width={228}
          onWidth={vi.fn()}
          websiteContextTarget={target}
        />,
      );
      const primary = screen.getByRole('navigation', { name: '业务导航' });
      expect(within(primary).getAllByRole('link')).toHaveLength(14);
      expect(within(primary).queryAllByRole('button')).toHaveLength(0);
      expect(primary.querySelectorAll('a[aria-current="page"]')).toHaveLength(1);
      for (const link of within(primary).getAllByRole('link')) {
        expect(link.querySelector('svg')).not.toBeNull();
        expect(link.getAttribute('href')).toContain('site-a');
      }
      expect(within(primary).queryByRole('link', { name: '帮助中心' })).toBeNull();
      expect(within(primary).queryByRole('link', { name: '深度分析' })).toBeNull();
      expect(view.container.querySelector('aside .site-switch')).toBeNull();
      fireEvent.click(within(target).getByRole('button', { name: /切换网站，当前/ }));
      expect(screen.getByText('个人空间')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '选择网站 网站 B' }));
      await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/websites/site-b/segments'));
      fireEvent.click(screen.getByRole('button', { name: '个人账户' }));
      expect(screen.getByRole('link', { name: '账户安全' })).toHaveAttribute(
        'href',
        '/settings/security',
      );
      expect(screen.getByRole('link', { name: '网站设置' })).toHaveAttribute(
        'href',
        '/websites/site-a/settings',
      );
      view.unmount();
      expect(target).toBeEmptyDOMElement();
    } finally {
      target.remove();
    }
  });
  it('keeps account focus inside an open mobile sidebar after pointer blur', () => {
    render(
      <Navigation
        user={{ id: 'user', username: 'admin' } as any}
        route={{ page: 'events', websiteId: 'site-a' }}
        site={{ id: 'site-a', name: '网站 A', domain: 'a.test' }}
        width={228}
        onWidth={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '页面导航' }));
    (document.activeElement as HTMLElement).blur();
    const account = screen.getByRole('button', { name: '个人账户' });
    fireEvent.click(account);
    expect(account).toHaveFocus();
    expect(screen.getByRole('link', { name: '账户安全' })).toBeInTheDocument();
    expect(fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(
      within(screen.getByRole('navigation', { name: '业务导航' }))
        .getAllByRole('link')
        .at(-1),
    ).toHaveFocus();
  });
  it('reaches the account language selector by keyboard inside the mobile sidebar', () => {
    render(
      <Navigation
        user={{ id: 'user', username: 'member' } as any}
        route={{ page: 'events', websiteId: 'site-a' }}
        site={{ id: 'site-a', name: '网站 A', domain: 'a.test' }}
        width={228}
        onWidth={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '页面导航' }));
    fireEvent.click(screen.getByRole('button', { name: '个人账户' }));
    const language = screen.getByRole('combobox', { name: 'Language / 语言' });
    for (let step = 0; step < 50 && document.activeElement !== language; step++)
      fireEvent.keyDown(document, { key: 'Tab' });
    expect(language).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('link', { name: '账户资料' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(language).toHaveFocus();
  });
  it('releases navigation focus and page scrolling when an open mobile menu becomes desktop', () => {
    let change: () => void;
    const media = {
      matches: true,
      addEventListener: vi.fn((_event: string, callback: () => void) => {
        change = callback;
      }),
      removeEventListener: vi.fn(),
    };
    const matchMedia = window.matchMedia;
    window.matchMedia = vi.fn(() => media as any);
    try {
      const view = render(
        <>
          <Navigation
            user={{ id: 'user', username: 'admin' } as any}
            route={{ page: 'events', websiteId: 'site-a' }}
            width={228}
            onWidth={vi.fn()}
          />
          <button>主区操作</button>
        </>,
      );
      const toggle = screen.getByRole('button', { name: '页面导航' });
      fireEvent.click(toggle);
      expect(document.body.style.overflow).toBe('hidden');
      act(() => {
        media.matches = false;
        change?.();
        window.dispatchEvent(new Event('resize'));
      });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(document.body.style.overflow).toBe('');
      const action = screen.getByRole('button', { name: '主区操作' });
      action.focus();
      expect(fireEvent.keyDown(action, { key: 'Tab' })).toBe(true);
      expect(action).toHaveFocus();
      view.unmount();
      expect(media.removeEventListener).toHaveBeenCalledWith('change', change);
    } finally {
      window.matchMedia = matchMedia;
    }
  });
  it('searches by domain and closes the picker with Escape while restoring focus', () => {
    render(
      <Navigation
        user={{ id: 'user', username: 'admin' } as any}
        route={{ page: 'events', websiteId: 'site-a' }}
        site={{ id: 'site-a', name: '网站 A', domain: 'a.test' }}
        width={228}
        onWidth={vi.fn()}
      />,
    );
    const picker = screen.getByRole('button', { name: /切换网站，当前/ });
    fireEvent.click(picker);
    const search = screen.getByRole('textbox', { name: '搜索网站' });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: 'b.test' } });
    expect(screen.queryByRole('button', { name: '选择网站 网站 A' })).toBeNull();
    expect(screen.getByRole('button', { name: '选择网站 网站 B' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(picker).toHaveFocus();
  });
  it('restores picker focus when selecting the current website without navigating', () => {
    render(
      <Navigation
        user={{ id: 'user', username: 'admin' } as any}
        route={{ page: 'events', websiteId: 'site-a' }}
        site={{ id: 'site-a', name: '网站 A' }}
        width={228}
        onWidth={vi.fn()}
      />,
    );
    const picker = screen.getByRole('button', { name: /切换网站，当前/ });
    fireEvent.click(picker);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索网站' }), { key: 'ArrowDown' });
    const current = screen.getByRole('button', { name: '选择网站 网站 A' });
    expect(current).toHaveFocus();
    fireEvent.click(current);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(picker).toHaveFocus();
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it('uses resolved website ownership for the return link, including personal sites with a stale team parameter', () => {
    const props = { user: { id: 'user', username: 'admin' } as any, width: 228, onWidth: vi.fn() };
    const view = render(
      <Navigation
        {...props}
        route={{ page: 'events', websiteId: 'site-a', teamId: 'stale-team' }}
        site={{ id: 'site-a', name: '个人网站', teamId: null }}
      />,
    );
    expect(screen.getByRole('link', { name: '返回网站列表' })).toHaveAttribute('href', '/websites');
    view.rerender(
      <Navigation
        {...props}
        route={{ page: 'events', websiteId: 'site-a', teamId: 'stale-team' }}
        site={{ id: 'site-a', name: '团队网站', teamId: 'owner-team' }}
      />,
    );
    expect(screen.getByRole('link', { name: '返回网站列表' })).toHaveAttribute(
      'href',
      '/websites?teamId=owner-team',
    );
  });
  it.each(['websites', 'events', 'admin-users'])(
    'opens project information from the footer in %s without navigating away',
    async page => {
      const contributorFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          contributors: [
            {
              login: 'yaojingang',
              avatarUrl: 'https://avatars.githubusercontent.com/u/266242792?v=4',
              profileUrl: 'https://github.com/yaojingang',
            },
          ],
        }),
      );
      render(
        <Navigation
          user={{ id: 'user', username: 'admin', isAdmin: true } as any}
          route={{ page, ...(page === 'events' ? { websiteId: 'site-a' } : {}) }}
          site={{ id: 'site-a', name: '当前网站' }}
          width={228}
          onWidth={vi.fn()}
        />,
      );
      const trigger = screen.getByRole('button', { name: '关于 GEOInflow' });
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(trigger);
      const dialog = await screen.findByRole('dialog');
      expect(
        await within(dialog).findByRole('link', { name: 'yaojingang的 GitHub 主页' }),
      ).toBeVisible();
      expect(contributorFetch).toHaveBeenCalledOnce();
      expect(dialog.querySelector('[data-dialog-size="wide"]')).toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(mocks.push).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: '关闭弹窗' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(trigger).toHaveFocus();
    },
  );
  it('restores account focus and dismisses nested mobile menus one layer at a time', () => {
    render(
      <Navigation
        user={{ id: 'user', username: 'admin' } as any}
        route={{ page: 'events', websiteId: 'site-a' }}
        width={228}
        onWidth={vi.fn()}
      />,
    );
    const account = screen.getByRole('button', { name: '个人账户' });
    fireEvent.click(account);
    screen.getByRole('link', { name: '账户安全' }).focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(account).toHaveFocus();
    const toggle = screen.getByRole('button', { name: '页面导航' });
    fireEvent.click(toggle);
    fireEvent.click(account);
    screen.getByRole('link', { name: '账户安全' }).focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(account).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(account).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });
  it.each([
    ['boards', '数据看板'],
    ['board-editor', '数据看板'],
    ['board-view', '数据看板'],
    ['board-design', '数据看板'],
    ['sharing', '分享管理'],
    ['links', '追踪管理'],
    ['link-editor', '追踪管理'],
    ['link-detail', '追踪管理'],
    ['pixels', '追踪管理'],
    ['pixel-editor', '追踪管理'],
    ['pixel-detail', '追踪管理'],
  ])('shows grouped global entries with the correct selection for %s', (page, selected) => {
    render(
      <Navigation
        user={{ id: 'user', username: 'admin', isAdmin: true } as any}
        route={{ page }}
        width={228}
        onWidth={vi.fn()}
      />,
    );
    const primary = screen.getByRole('navigation', { name: '业务导航' });
    const entries = within(primary).getAllByRole('link');
    expect(entries.map(entry => entry.textContent)).toEqual([
      '快速发起',
      '网站管理',
      '数据看板',
      '追踪管理',
      '爬虫管理',
      '分享管理',
      '团队管理',
      '帮助中心',
      'AI配置器',
    ]);
    expect(within(primary).queryAllByRole('button')).toHaveLength(0);
    expect(within(primary).getByText('数据管理')).toBeInTheDocument();
    expect(within(primary).getByText('协作管理')).toBeInTheDocument();
    expect(primary.querySelectorAll('[data-navigation-group]')).toHaveLength(5);
    expect(primary.querySelectorAll('a[aria-current="page"]')).toHaveLength(1);
    expect(within(primary).getByRole('link', { name: selected })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const [label, href] of [
      ['数据看板', '/boards'],
      ['分享管理', '/liekan/sharing'],
      ['追踪管理', '/links'],
    ])
      expect(within(primary).getByRole('link', { name: label })).toHaveAttribute('href', href);
  });
  it('runs logout once while a delayed request is pending', async () => {
    let complete: () => void;
    mocks.post.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          complete = resolve;
        }),
    );
    render(
      <Navigation
        user={{ id: 'user', username: 'admin' } as any}
        route={{ page: 'account' }}
        width={228}
        onWidth={vi.fn()}
      />,
    );
    const logout = screen.getByRole('button', { name: '退出登录' });
    act(() => {
      logout.click();
      logout.click();
    });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(logout).toBeDisabled();
    expect(mocks.clearLogin).not.toHaveBeenCalled();
    await act(async () => complete());
    expect(mocks.clearLogin).toHaveBeenCalledTimes(1);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith('/login');
  });
  it('closes an unsaved website-switch prompt when history navigation changes the page', async () => {
    const props = {
      user: { id: 'user', username: 'admin' } as any,
      site: { id: 'site-a', name: '网站 A', domain: 'a.test' },
      width: 228,
      onWidth: vi.fn(),
    };
    const view = render(
      <>
        <form data-unsaved="true" />
        <Navigation {...props} route={{ page: 'goal-editor', websiteId: 'site-a' }} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: /切换网站，当前/ }));
    fireEvent.click(screen.getByRole('button', { name: '选择网站 网站 B' }));
    await screen.findByRole('dialog', { name: '放弃未保存的修改？' });
    await waitFor(() => expect(document.body.style.overflowY).toBe('hidden'));
    mocks.pathname = '/websites/site-a/goals';
    view.rerender(
      <>
        <form data-unsaved="true" />
        <Navigation {...props} route={{ page: 'goals', websiteId: 'site-a' }} />
      </>,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.style.overflowY).toBe('');
    expect(mocks.push).not.toHaveBeenCalled();
  });
  it('does not show a previous website domain or owner while the new site loads', () => {
    render(
      <Navigation
        user={{ id: 'user', username: 'admin' } as any}
        route={{ page: 'sessions', websiteId: 'site-b' }}
        site={{ id: 'site-a', name: '网站 A', domain: 'a.test', teamId: 'old-team' }}
        width={228}
        onWidth={vi.fn()}
      />,
    );
    expect(screen.queryByText('a.test')).not.toBeInTheDocument();
    expect(screen.queryByText('团队空间')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回网站列表' })).toHaveAttribute('href', '/websites');
  });
  it('shows one confirmation and restores scrolling after discarding an unsaved edit', async () => {
    render(
      <>
        <form data-unsaved="true">
          <input aria-label="目标名称" />
        </form>
        <Navigation
          user={{ id: 'user', username: 'admin', isAdmin: true } as any}
          route={{ page: 'goal-editor', websiteId: 'site-a' }}
          site={{ id: 'site-a', name: '网站 A', domain: 'a.test' }}
          width={228}
          onWidth={vi.fn()}
        />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: /切换网站，当前/ }));
    fireEvent.click(screen.getByRole('button', { name: '选择网站 网站 B' }));
    await screen.findByRole('dialog', { name: '放弃未保存的修改？' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '放弃修改并切换' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe('');
    expect(mocks.push).toHaveBeenCalledWith('/websites/site-b/goals');
  });
});

it('does not prefetch statistics on hover or keyboard focus', async () => {
  vi.useFakeTimers();
  mocks.prefetch.mockClear();
  mocks.get.mockClear();
  try {
    render(
      <Navigation
        user={{ id: 'user', username: 'admin' } as any}
        route={{ page: 'overview', websiteId: 'site-a' }}
        site={{ id: 'site-a', name: '网站 A', domain: 'a.test' }}
        width={228}
        onWidth={vi.fn()}
      />,
    );
    const link = screen.getByRole('link', { name: '访客总览' });
    fireEvent.mouseEnter(link);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    fireEvent.focus(link);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(mocks.prefetch).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
