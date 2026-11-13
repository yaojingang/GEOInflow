import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';
import { ProductAboutDialog } from './ProductAboutDialog';

const contributors = [
  {
    login: 'yaojingang',
    avatarUrl: 'https://avatars.githubusercontent.com/u/266242792?v=4&s=96',
    profileUrl: 'https://github.com/yaojingang',
  },
  {
    login: 'lluck42',
    avatarUrl: 'https://avatars.githubusercontent.com/u/31329690?v=4&s=96',
    profileUrl: 'https://github.com/lluck42',
  },
];
const fetchContributors = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchContributors);
  fetchContributors.mockReset().mockResolvedValue(Response.json({ contributors }));
});
afterEach(() => vi.unstubAllGlobals());

vi.mock('next/link', () => ({
  default: ({ children, prefetch: _prefetch, onClick, ...props }: any) => (
    <a
      {...props}
      onClick={event => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));

it.each(['zh-CN', 'en-US'] as const)(
  'shows GitHub contributors and attributed publisher links in %s',
  async locale => {
    const onClose = vi.fn();
    render(
      <LiekanLocaleContext.Provider value={locale}>
        <ProductAboutDialog onClose={onClose} />
      </LiekanLocaleContext.Provider>,
    );
    const dialog = within(await screen.findByRole('dialog'));
    for (const contributor of contributors) {
      const link = await dialog.findByRole('link', {
        name:
          locale === 'zh-CN'
            ? `${contributor.login}的 GitHub 主页`
            : `${contributor.login} on GitHub`,
      });
      expect(link).toHaveAttribute('href', contributor.profileUrl);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link.querySelector('img')).toHaveAttribute('src', contributor.avatarUrl);
      expect(link).toHaveTextContent(contributor.login);
    }
    expect(dialog.getByText('v1.2')).toBeVisible();
    const biographies =
      locale === 'zh-CN'
        ? [
            ['姚金刚', '猎看科技创始人，《AI营销：从SEO到GEO》作者，中国GEO大会发起人'],
            ['向阳乔木', '知名AI自媒体，《AI营销：从SEO到GEO》作者，中国GEO大会发起人'],
            ['任强', '北京日报智源GEO负责人，北京日报京报移动副总经理'],
          ]
        : [
            [
              '姚金刚',
              'Founder of 猎看科技; author of AI营销：从SEO到GEO; initiator of 中国GEO大会',
            ],
            [
              '向阳乔木',
              'Prominent AI content creator; author of AI营销：从SEO到GEO; initiator of 中国GEO大会',
            ],
            ['任强', 'Head of 北京日报智源GEO; Deputy General Manager of 北京日报京报移动'],
          ];
    for (const [name, description] of biographies) {
      const person = dialog.getByText(name).closest('[data-project-initiator]') as HTMLElement;
      expect(within(person).getByText(description)).toBeVisible();
    }
    const ren = dialog.getByText('任强').closest('[data-project-initiator]') as HTMLElement;
    expect(within(ren).queryByRole('link')).toBeNull();

    for (const [name, href] of [
      ['猎看科技', 'https://www.liekan.com/?GEOInflow'],
      ['北京日报社智源GEO', 'https://geo.takefoto.cn/?GEOInflow'],
      [locale === 'zh-CN' ? '姚金刚的 X 主页' : '姚金刚 on X', 'https://x.com/yaojingang'],
      [locale === 'zh-CN' ? '向阳乔木的 X 主页' : '向阳乔木 on X', 'https://x.com/vista8'],
    ]) {
      const link = dialog.getByRole('link', { name });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(dialog.queryByText(/贡献者 \d|Contributor \d|排版示意/)).toBeNull();
    expect(dialog.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/yaojingang/GEOInflow',
    );
    expect(dialog.queryByRole('link', { name: /MIT|Umami/ })).toBeNull();
    const about = dialog.getByRole('link', {
      name: locale === 'zh-CN' ? '项目说明' : 'About GEOInflow',
    });
    expect(about).toHaveAttribute('href', '/liekan/help?article=project-about');
    fireEvent.click(about);
    expect(onClose).toHaveBeenCalledOnce();
  },
);

it('distinguishes pending and empty results and includes the deployment base path', async () => {
  let resolve: (response: Response) => void;
  fetchContributors.mockReturnValue(
    new Promise<Response>(done => {
      resolve = done;
    }),
  );
  vi.stubEnv('basePath', '/statistics');
  try {
    render(<ProductAboutDialog onClose={vi.fn()} />);
    expect(await screen.findByRole('status')).toHaveTextContent('正在加载贡献者…');
    expect(screen.queryByText('暂无公开贡献者')).toBeNull();
    expect(fetchContributors).toHaveBeenCalledWith('/statistics/api/liekan/contributors', {
      signal: expect.any(AbortSignal),
    });
    resolve(Response.json({ contributors: [] }));
    expect(await screen.findByText('暂无公开贡献者')).toBeVisible();
    expect(screen.queryByText('正在加载贡献者…')).toBeNull();
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each(['zh-CN', 'en-US'] as const)(
  'allows retry after GitHub is unavailable in %s',
  async locale => {
    fetchContributors.mockResolvedValueOnce(
      Response.json({ error: 'unavailable' }, { status: 503 }),
    );
    render(
      <LiekanLocaleContext.Provider value={locale}>
        <ProductAboutDialog onClose={vi.fn()} />
      </LiekanLocaleContext.Provider>,
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      locale === 'zh-CN' ? '暂时无法加载贡献者' : 'Contributors are temporarily unavailable',
    );
    const all = screen.getByRole('link', {
      name: locale === 'zh-CN' ? '查看全部贡献者' : 'View all contributors',
    });
    expect(all).toHaveAttribute(
      'href',
      'https://github.com/yaojingang/GEOInflow/graphs/contributors',
    );
    fireEvent.click(screen.getByRole('button', { name: locale === 'zh-CN' ? '重试' : 'Retry' }));
    expect(await screen.findByText('lluck42')).toBeVisible();
    expect(fetchContributors).toHaveBeenCalledTimes(2);
  },
);

it('cancels an in-flight read on close', async () => {
  fetchContributors.mockReturnValue(new Promise(() => {}));
  const view = render(<ProductAboutDialog onClose={vi.fn()} />);
  await waitFor(() => expect(fetchContributors).toHaveBeenCalledOnce());
  const signal = fetchContributors.mock.calls[0][1].signal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});

it('keeps raw GitHub identity and the current read when switching locales', async () => {
  const view = render(
    <LiekanLocaleContext.Provider value="zh-CN">
      <ProductAboutDialog onClose={vi.fn()} />
    </LiekanLocaleContext.Provider>,
  );
  await screen.findByText('lluck42');
  view.rerender(
    <LiekanLocaleContext.Provider value="en-US">
      <ProductAboutDialog onClose={vi.fn()} />
    </LiekanLocaleContext.Provider>,
  );
  expect(screen.getByRole('link', { name: 'lluck42 on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/lluck42',
  );
  expect(fetchContributors).toHaveBeenCalledOnce();
});
