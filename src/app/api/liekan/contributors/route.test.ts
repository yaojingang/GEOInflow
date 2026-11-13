// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let GET: typeof import('./route').GET;

const github = vi.fn();
const contributor = (id: number, login: string) => ({
  id,
  login,
  avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
  html_url: `https://github.com/${login}`,
});
beforeEach(async () => {
  vi.resetModules();
  ({ GET } = await import('./route'));
  github.mockReset();
  vi.stubGlobal('fetch', github);
});
afterEach(() => vi.unstubAllGlobals());

it('reads every page in GitHub order and exposes only public profile fields', async () => {
  github.mockResolvedValueOnce(
    Response.json([{ ...contributor(266242792, 'yaojingang'), email: 'unused@example.com' }], {
      headers: {
        link: '<https://api.github.com/repos/yaojingang/GEOInflow/contributors?per_page=100&page=2>; rel="next"',
      },
    }),
  );
  github.mockResolvedValueOnce(Response.json([contributor(31329690, 'lluck42')]));
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('s-maxage=3600');
  expect(await response.json()).toEqual({
    contributors: [
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
    ],
  });
  expect(github.mock.calls.map(([url]) => url)).toEqual(
    [1, 2].map(
      page =>
        `https://api.github.com/repos/yaojingang/GEOInflow/contributors?per_page=100&page=${page}`,
    ),
  );
  expect(github.mock.calls[0][1]).toMatchObject({ next: { revalidate: 3600 } });
  expect(github.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
});

it.each([200, 204])('handles an empty public repository with status %s', async status => {
  github.mockResolvedValue(status === 204 ? new Response(null, { status }) : Response.json([]));
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ contributors: [] });
});

it.each([403, 404, 429, 500])(
  'keeps upstream %s distinct from a successful empty result',
  async status => {
    github.mockResolvedValue(Response.json({ message: 'Upstream detail' }, { status }));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'GitHub contributors unavailable' });
  },
);

it.each([
  { message: 'Unexpected payload' },
  [{ ...contributor(1, 'user'), login: '../invalid' }],
  [{ ...contributor(1, 'user'), html_url: 'https://github.com.evil.test/user' }],
  [{ ...contributor(1, 'user'), avatar_url: 'https://evil.test/avatar' }],
])('rejects malformed external data', async payload => {
  github.mockResolvedValue(Response.json(payload));
  expect((await GET()).status).toBe(503);
});

it('returns no partial list if a later page fails', async () => {
  github
    .mockResolvedValueOnce(
      Response.json([contributor(1, 'user')], {
        headers: { link: '<https://example.com/untrusted>; rel="next"' },
      }),
    )
    .mockRejectedValueOnce(new Error('Network unavailable'));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty('contributors');
  expect(github.mock.calls[1][0]).toBe(
    'https://api.github.com/repos/yaojingang/GEOInflow/contributors?per_page=100&page=2',
  );
});

it('shares a short outage cooldown and resumes upstream reads after it expires', async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  github.mockResolvedValueOnce(Response.json({ message: 'Rate limit' }, { status: 429 }));
  expect((await GET()).status).toBe(503);
  expect((await GET()).status).toBe(503);
  expect(github).toHaveBeenCalledOnce();
  clock.mockReturnValue(now + 30001);
  github.mockResolvedValueOnce(Response.json([contributor(1, 'user')]));
  const response = await GET();
  expect(response.status).toBe(200);
  expect((await response.json()).contributors[0].login).toBe('user');
  expect(github).toHaveBeenCalledTimes(2);
});

it('preserves GitHub-supplied bot profiles and application avatars', async () => {
  github.mockResolvedValue(
    Response.json([
      {
        id: 49699333,
        login: 'dependabot[bot]',
        html_url: 'https://github.com/apps/dependabot',
        avatar_url: 'https://avatars.githubusercontent.com/in/29110?v=4',
      },
    ]),
  );
  const response = await GET();
  expect(await response.json()).toEqual({
    contributors: [
      {
        login: 'dependabot[bot]',
        profileUrl: 'https://github.com/apps/dependabot',
        avatarUrl: 'https://avatars.githubusercontent.com/in/29110?v=4&s=96',
      },
    ],
  });
});
