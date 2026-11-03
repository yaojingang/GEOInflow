import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  website: vi.fn(),
  view: vi.fn(),
  update: vi.fn(),
  stats: vi.fn(),
  raw: vi.fn(),
  member: vi.fn(),
  report: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({
  checkAuth: mocks.auth,
  hasPermission: async (role: string, permission: string) =>
    role === 'admin'
      ? permission === 'all'
      : role === 'team-member' && permission === 'website:update',
}));
vi.mock('@/permissions', () => ({ canViewWebsite: mocks.view, canUpdateWebsite: mocks.update }));
vi.mock('@/lib/prisma', () => ({
  default: { client: { website: { findFirst: mocks.website } } },
  getRawQueryClient: mocks.raw,
}));
vi.mock('@/queries/sql', () => ({ getWebsiteStats: mocks.stats }));
vi.mock('./page-report', () => ({ readPageReport: mocks.report }));

import { authorize, humanTotals, lockWritableWebsite, query, reportSnapshot } from './server';
import { GET as pageReport } from '@/app/api/liekan/websites/[websiteId]/page-report/route';
import { api } from '@/lib/liekan/http';

const id = '5b4c0de0-6c47-5b51-8f53-11e5e8c79001';
const request = new Request(`http://localhost/api/liekan/websites/${id}/report`);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.raw.mockReturnValue({
    website: { findFirst: mocks.website },
    teamUser: { findFirst: mocks.member },
  });
  mocks.website.mockResolvedValue({ id, name: 'Website', domain: 'example.com' });
  mocks.view.mockResolvedValue(true);
  mocks.update.mockResolvedValue(false);
});
it.each(['acquisition', 'early-statement', 'expired-budget'])(
  'classifies report transaction failure from %s without blocking transient recovery',
  async phase => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const unavailable = Object.assign(
      new Error('Unable to start a transaction in the given time'),
      { code: 'P2028' },
    );
    const work = vi.fn(async () => {
      if (phase === 'expired-budget') clock.mockReturnValue(1101);
      throw unavailable;
    });
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      if (phase === 'acquisition') throw unavailable;
      return callback({ $executeRawUnsafe: vi.fn() });
    });
    mocks.raw.mockReturnValue({ $transaction: transaction });
    try {
      await expect(reportSnapshot(work, 1100)).rejects.toMatchObject({
        status: 503,
        code: phase === 'expired-budget' ? 'analysis-query-timeout' : 'liekan-error',
      });
      expect(work).toHaveBeenCalledTimes(phase === 'acquisition' ? 0 : 1);
    } finally {
      clock.mockRestore();
    }
  },
);
describe('Liekan authenticated website boundary', () => {
  it('rechecks direct detail access without a cache result', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'reader', role: 'user' } });
    mocks.website.mockResolvedValue({ id, userId: null, teamId: 'team' });
    mocks.member.mockResolvedValue({ role: 'team-member' });
    const response = await api(async () => {
      await authorize(request, id);
      mocks.member.mockResolvedValue(null);
      return { rows: [{ id: 'private-session' }] };
    });
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty('rows');
  });
  it('preserves a successful write that removes the authorized resource', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'reader', role: 'user' } });
    mocks.website.mockResolvedValue({ id, userId: 'reader', teamId: null });
    mocks.update.mockResolvedValue(true);
    const response = await api(async () => {
      await authorize(new Request(request.url, { method: 'DELETE' }), id, true);
      mocks.website.mockResolvedValue(null);
      return { deleted: true };
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
  });
  it.each(['member-removed', 'owner-changed', 'team-deleted'])(
    'rejects a direct log report when access changes during computation (%s)',
    async change => {
      mocks.auth.mockResolvedValue({ user: { id: 'reader', role: 'user' } });
      mocks.website.mockResolvedValue({
        id,
        name: 'Website',
        domain: 'example.com',
        userId: null,
        teamId: 'team',
      });
      mocks.member.mockResolvedValue({ role: 'team-member' });
      mocks.report.mockImplementation(async () => {
        if (change === 'owner-changed') {
          mocks.website.mockResolvedValue({ id, userId: 'other-owner', teamId: null });
        } else {
          mocks.member.mockResolvedValue(null);
        }
        return {
          value: { meta: {}, resource: 'logs' },
          generatedAt: 1,
          expiresAt: 0,
          status: 'miss',
          tier: 'computed',
        };
      });
      const response = await pageReport(new Request(`${request.url}?resource=logs`), {
        params: Promise.resolve({ websiteId: id }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).not.toHaveProperty('resource');
      if (change !== 'owner-changed')
        expect(mocks.member).toHaveBeenCalledWith({
          where: { teamId: 'team', userId: 'reader', team: { deletedAt: null } },
          select: { role: true },
        });
    },
  );
  it('permits a direct log report for a current team member', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'reader', role: 'user' } });
    mocks.website.mockResolvedValue({
      id,
      name: 'Website',
      domain: 'example.com',
      userId: null,
      teamId: 'team',
    });
    mocks.member.mockResolvedValue({ role: 'team-member' });
    mocks.report.mockResolvedValue({
      value: { meta: {}, resource: 'logs' },
      generatedAt: 1,
      expiresAt: 0,
      status: 'miss',
      tier: 'computed',
    });
    const response = await pageReport(new Request(`${request.url}?resource=logs`), {
      params: Promise.resolve({ websiteId: id }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('resource', 'logs');
  });
  it('requires full user authentication and excludes valid share context', async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(authorize(request, id)).rejects.toMatchObject({ status: 401 });
    mocks.auth.mockResolvedValue({ shareToken: { websiteId: id }, authType: 'share' });
    await expect(authorize(request, id)).rejects.toMatchObject({ status: 401 });
    expect(mocks.website).not.toHaveBeenCalled();
  });
  it('rejects deleted or missing sites even for an administrator', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'admin', isAdmin: true } });
    mocks.website.mockResolvedValue(null);
    await expect(authorize(request, id)).rejects.toMatchObject({ status: 404 });
    expect(mocks.view).not.toHaveBeenCalled();
  });
  it('resolves a short site number to the UUID and keys downstream checks on it', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'reader' } });
    mocks.website.mockResolvedValue({
      id,
      name: 'Website',
      domain: 'example.com',
      siteNumber: 101,
    });
    const access = await authorize(request, '101');
    expect(mocks.website).toHaveBeenCalledWith({
      where: { siteNumber: 101, deletedAt: null },
      select: { id: true, name: true, domain: true, siteNumber: true },
    });
    expect(mocks.view.mock.calls[0][1]).toBe(id);
    expect(access.website).toMatchObject({ id, siteNumber: 101 });
  });
  it('rejects a deleted site reached through its site number', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'admin', isAdmin: true } });
    mocks.website.mockResolvedValue(null);
    await expect(authorize(request, '101')).rejects.toMatchObject({ status: 404 });
  });
  it('permits read access but denies mutation for a viewer', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'viewer' } });
    await expect(authorize(request, id)).resolves.toMatchObject({ canManage: false });
    await expect(authorize(request, id, true)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects cross-website reads and invalid IDs', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'stranger' } });
    mocks.view.mockResolvedValue(false);
    await expect(authorize(request, id)).rejects.toMatchObject({ status: 403 });
    await expect(authorize(request, "';DROP TABLE website")).rejects.toMatchObject({ status: 400 });
  });
  it('rechecks ownership and live identity while holding the website write lock', async () => {
    const tx = {
      $queryRawUnsafe: vi
        .fn()
        .mockResolvedValueOnce([{ user_id: 'new-owner', team_id: null }])
        .mockResolvedValueOnce([{ role: 'user' }]),
    };
    await expect(lockWritableWebsite(tx, id, { userId: 'old-owner' })).rejects.toMatchObject({
      status: 403,
    });
    tx.$queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(lockWritableWebsite(tx, id, { userId: 'old-owner' })).rejects.toMatchObject({
      status: 404,
    });
    tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ user_id: 'old-owner', team_id: null }])
      .mockResolvedValueOnce([]);
    await expect(lockWritableWebsite(tx, id, { userId: 'old-owner' })).rejects.toMatchObject({
      status: 401,
    });
    tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ user_id: 'owner', team_id: null }])
      .mockResolvedValueOnce([{ role: 'user' }]);
    await expect(lockWritableWebsite(tx, id, { userId: 'owner' })).resolves.toBeUndefined();
  });
  it('rejects a team viewer after an initial authorization while allowing a current member', async () => {
    const tx = { $queryRawUnsafe: vi.fn() };
    for (const role of ['team-view-only', 'team-member']) {
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ user_id: null, team_id: 'team' }])
        .mockResolvedValueOnce([{ role: 'user' }])
        .mockResolvedValueOnce([{ role }]);
      const pending = lockWritableWebsite(tx, id, { userId: 'teammate' });
      if (role === 'team-member') await expect(pending).resolves.toBeUndefined();
      else await expect(pending).rejects.toMatchObject({ status: 403 });
    }
  });
});

describe('upstream human metric contract', () => {
  const start = new Date('2026-10-01T00:00:00Z');
  const end = new Date('2026-10-02T00:00:00Z');
  const totals = { pageviews: 20, visitors: 8, visits: 10, bounces: 3, totaltime: 300 };
  it('returns validated numeric totals and ignores compatible additional fields', async () => {
    mocks.stats.mockResolvedValue({ ...totals, additionalField: 'upstream extension' });
    await expect(humanTotals(id, start, end)).resolves.toEqual(totals);
    expect(mocks.stats).toHaveBeenCalledWith(id, {
      startDate: start,
      endDate: end,
      timezone: 'UTC',
    });
    mocks.stats.mockResolvedValue({
      pageviews: 0,
      visitors: 0,
      visits: 0,
      bounces: 0,
      totaltime: 0.5,
    });
    await expect(humanTotals(id, start, end)).resolves.toMatchObject({ totaltime: 0.5 });
  });
  it('carries an explicit reporting timezone without a request cache context', async () => {
    mocks.stats.mockResolvedValue(totals);
    await humanTotals(id, start, end, 'Asia/Shanghai');
    expect(mocks.stats).toHaveBeenCalledWith(id, {
      startDate: start,
      endDate: end,
      timezone: 'Asia/Shanghai',
    });
  });
  it('normalizes the native PostgreSQL bigint counts without losing precision', async () => {
    mocks.stats.mockResolvedValue({
      pageviews: 20n,
      visitors: 8n,
      visits: 10n,
      bounces: 3n,
      totaltime: 300n,
    });
    await expect(humanTotals(id, start, end)).resolves.toEqual(totals);
  });
  it('preserves unavailable identities when accompanied by population evidence', async () => {
    const { populationFromRow } = await import('./browser-population');
    const population = populationFromRow(
      {
        resourceKind: 'website',
        eligibleEvents: 4,
        qualifiedEvents: 1,
        eligiblePV: 4,
        qualifiedPV: 1,
        qualifiedVisitors: 1,
      },
      { startAt: +start, endAt: +end, timezone: 'UTC' },
    );
    mocks.stats.mockResolvedValue({
      pageviews: 4n,
      visitors: null,
      visits: null,
      bounces: null,
      totaltime: null,
      population,
    });
    await expect(humanTotals(id, start, end)).resolves.toMatchObject({
      pageviews: 4,
      visitors: null,
      visits: null,
      population,
    });
  });
  it('rejects missing or renamed units with a redacted contract failure', async () => {
    const { totaltime, ...remaining } = totals;
    for (const result of [
      undefined,
      null,
      [],
      remaining,
      { ...remaining, totaltimeMs: totaltime * 1000 },
    ]) {
      mocks.stats.mockResolvedValue(result);
      await expect(humanTotals(id, start, end)).rejects.toMatchObject({
        status: 500,
        message: '统计数据契约不兼容',
      });
    }
  });
  it('rejects nonnumeric, fractional counts, negative, nonfinite and unsafe values', async () => {
    for (const field of ['pageviews', 'visitors', 'visits', 'bounces']) {
      for (const invalid of [
        undefined,
        null,
        '5',
        NaN,
        Infinity,
        -1,
        1.5,
        -1n,
        BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      ]) {
        mocks.stats.mockResolvedValue({ ...totals, [field]: invalid });
        await expect(
          humanTotals(id, start, end),
          `${field}: ${String(invalid)}`,
        ).rejects.toMatchObject({ status: 500, message: '统计数据契约不兼容' });
      }
    }
    for (const invalid of [undefined, null, '300', NaN, Infinity, -0.5]) {
      mocks.stats.mockResolvedValue({ ...totals, totaltime: invalid });
      await expect(humanTotals(id, start, end)).rejects.toMatchObject({
        status: 500,
        message: '统计数据契约不兼容',
      });
    }
  });
});

describe('queued analytics queries', () => {
  it('waits for a pooled connection while other report queries are running', async () => {
    vi.useFakeTimers();
    const originalUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://localhost/liekan';
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ value: 1 }]),
    };
    mocks.raw.mockReturnValue({
      $transaction: (work: (tx: any) => Promise<any>, options: { maxWait?: number }) =>
        new Promise((resolve, reject) => {
          const deadline = setTimeout(() => {
            clearTimeout(acquire);
            reject(new Error('Unable to start a transaction in the given time'));
          }, options.maxWait ?? 2000);
          const acquire = setTimeout(() => {
            clearTimeout(deadline);
            Promise.resolve(work(tx)).then(resolve, reject);
          }, 3000);
        }),
    });
    try {
      const result = query('SELECT 1 AS value').then(
        value => ({ value }),
        error => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(3000);
      expect(await result).toEqual({ value: [{ value: 1 }] });
      expect(tx.$queryRawUnsafe).toHaveBeenCalledWith('SELECT 1 AS value');
      expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL search_path TO "public"');
    } finally {
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      vi.useRealTimers();
    }
  });
});
