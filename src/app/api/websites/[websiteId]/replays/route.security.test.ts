import { beforeEach, expect, test, vi } from 'vitest';
const state = vi.hoisted(() => ({ auth: {} as any, list: vi.fn(), chunks: vi.fn() }));
vi.mock('@/lib/request', () => ({
  parseRequest: async () => ({ auth: state.auth, query: {} }),
  getQueryFilters: async () => ({}),
}));
vi.mock('@/lib/liekan/upstream/cache-context', () => ({
  withQueryCacheHeaders: (work: () => unknown) => work(),
}));
vi.mock('@/lib/entity', () => ({ getEntity: async () => ({ userId: 'owner' }) }));
vi.mock('@/queries/prisma', () => ({ getTeamUser: async () => null, getWebsite: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));
vi.mock('@/lib/auth', () => ({ hasPermission: vi.fn() }));
vi.mock('@/permissions', async () => ({
  canViewAuthenticatedWebsite: (await import('@/permissions/share')).canViewAuthenticatedWebsite,
}));
vi.mock('@/queries/sql', () => ({ getSessionReplays: state.list, getReplayChunks: state.chunks }));
import { GET as listReplays } from './route';
import { GET as readReplay } from './[replayId]/route';
beforeEach(() => {
  state.auth = { user: { id: 'unrelated', isAdmin: false }, shareToken: { websiteId: 'target' } };
  state.list.mockReset().mockResolvedValue([]);
  state.chunks.mockReset().mockResolvedValue([]);
});
test('mixed login and share identities cannot list or read private recordings', async () => {
  const request = new Request('https://example.com/api/websites/target/replays');
  expect(
    (await listReplays(request, { params: Promise.resolve({ websiteId: 'target' }) })).status,
  ).toBe(401);
  expect(
    (
      await readReplay(request, {
        params: Promise.resolve({ websiteId: 'target', replayId: 'recording' }),
      })
    ).status,
  ).toBe(401);
  expect(state.list).not.toHaveBeenCalled();
  expect(state.chunks).not.toHaveBeenCalled();
});
test('the website owner can still read recordings with a share header present', async () => {
  state.auth.user.id = 'owner';
  const response = await readReplay(new Request('https://example.com/'), {
    params: Promise.resolve({ websiteId: 'target', replayId: 'recording' }),
  });
  expect(response.status).toBe(200);
  expect(state.chunks).toHaveBeenCalledWith('target', 'recording', expect.any(Object));
});
