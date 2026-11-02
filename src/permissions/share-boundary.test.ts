import { beforeEach, expect, test, vi } from 'vitest';
import { getEntity } from '@/lib/entity';
import { getTeamUser } from '@/queries/prisma';
import {
  canViewAuthenticatedWebsite,
  canViewSharedWebsite,
  canViewSharedWebsiteFilters,
  canViewWebsiteSection,
} from './share';

vi.mock('@/lib/entity', () => ({ getEntity: vi.fn() }));
vi.mock('@/queries/prisma', () => ({ getTeamUser: vi.fn(), getWebsite: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));
vi.mock('@/lib/auth', () => ({ hasPermission: vi.fn() }));

const user = { id: 'unrelated', username: 'reader', role: 'user', isAdmin: false };
const shareToken = {
  websiteId: 'target',
  parameters: { overview: true, sessions: false, allowFilter: false },
};

beforeEach(() => {
  vi.mocked(getEntity)
    .mockReset()
    .mockResolvedValue({ userId: 'owner' } as any);
  vi.mocked(getTeamUser).mockReset().mockResolvedValue(null);
});

test('an unrelated account cannot use a share to pass a private website guard', async () => {
  expect(await canViewAuthenticatedWebsite({ user }, 'target')).toBe(false);
  expect(await canViewAuthenticatedWebsite({ shareToken }, 'target')).toBe(false);
  expect(await canViewAuthenticatedWebsite({ user, shareToken }, 'target')).toBe(false);
});

test('mixed identities retain the share section and filter restrictions', async () => {
  const auth = { user, shareToken };
  expect(await canViewWebsiteSection(auth, 'target', 'overview')).toBe(true);
  expect(await canViewWebsiteSection(auth, 'target', 'sessions')).toBe(false);
  expect(await canViewSharedWebsiteFilters(auth, 'target')).toBe(false);
  expect(await canViewSharedWebsite(auth, 'target')).toBe(true);
  expect(await canViewSharedWebsite(auth, 'another-site')).toBeFalsy();
});

test('owners, team members and administrators retain their private permissions', async () => {
  expect(
    await canViewAuthenticatedWebsite({ user: { ...user, id: 'owner' }, shareToken }, 'target'),
  ).toBe(true);
  vi.mocked(getEntity).mockResolvedValue({ teamId: 'team' } as any);
  vi.mocked(getTeamUser).mockResolvedValue({ role: 'team-view-only' } as any);
  expect(await canViewAuthenticatedWebsite({ user, shareToken }, 'target')).toBe(true);
  expect(await canViewWebsiteSection({ user, shareToken }, 'target', 'sessions')).toBe(true);
  expect(await canViewAuthenticatedWebsite({ user: { ...user, isAdmin: true } }, 'target')).toBe(
    true,
  );
});
