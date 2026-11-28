// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  website: vi.fn(),
  member: vi.fn(),
  read: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ checkAuth: mocks.auth, hasPermission: async () => false }));
vi.mock('@/lib/prisma', () => ({
  default: { client: {} },
  getRawQueryClient: () => ({
    website: { findFirst: mocks.website },
    teamUser: { findFirst: mocks.member },
  }),
}));
vi.mock('@/permissions', () => ({
  canViewWebsite: async () => true,
  canUpdateWebsite: async () => false,
}));
vi.mock('@/queries/sql', () => ({ getWebsiteStats: vi.fn() }));
vi.mock('../report', () => ({ buildReport: vi.fn() }));
vi.mock('./query-cache', async original => ({
  ...(await original<typeof import('./query-cache')>()),
  analyticsCache: { isRuntimeConfigured: true, read: mocks.read },
}));

import { api } from '../http';
import { readSharedReport } from './shared-report';

const site = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: 'reader', role: 'user' } });
  mocks.website.mockResolvedValue({
    id: site,
    userId: null,
    teamId: 'team',
    name: 'Fixture',
    domain: 'example.test',
  });
  mocks.member.mockResolvedValue({ role: 'team-member' });
  mocks.read.mockResolvedValue({
    value: { privateMetric: 123 },
    status: 'hit',
    tier: 'memory',
    generatedAt: 1,
    expiresAt: Date.now() + 1000,
  });
});

it.each(['none', 'membership', 'owner', 'website'])(
  'checks site authority after the cache consumer finishes: %s',
  async change => {
    const request = new Request(
      `http://localhost/api/liekan/websites/${site}/shared-report?startAt=0&endAt=86400000&timezone=Asia%2FShanghai&chartPeriod=30d`,
    );
    const response = await api(async () => {
      // The cache/runtime permission check has already passed. Revoke precisely
      // between returning that result and the real HTTP final authorization.
      const result = await readSharedReport(request, site);
      if (change === 'membership') mocks.member.mockResolvedValue(null);
      if (change === 'owner')
        mocks.website.mockResolvedValue({ id: site, userId: 'other', teamId: null });
      if (change === 'website') mocks.website.mockResolvedValue(null);
      return result;
    });
    expect(response.status).toBe(change === 'none' ? 200 : 403);
    const body = await response.json();
    if (change === 'none') expect(body.privateMetric).toBe(123);
    else expect(body).not.toHaveProperty('privateMetric');
  },
);
