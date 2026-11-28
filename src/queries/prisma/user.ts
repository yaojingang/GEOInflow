import { prepareWarehouseCascade } from '@/lib/liekan/upstream/warehouse-cascade';
import { Prisma } from '@/generated/prisma/client';
import { ROLES } from '@/lib/constants';
import { getRandomChars } from '@/lib/generate';
import { bumpAnalyticsRevision } from '@/lib/liekan/upstream/analytics-revision';
import { analyticsCache, invalidateWebsiteAnalytics } from '@/lib/liekan/upstream/query-cache';
import prisma, { getRawQueryClient } from '@/lib/prisma';
import redis from '@/lib/redis';
import { invalidateAiActorRunsInTransaction } from '@/lib/liekan/upstream/ai-lifecycle';
import { sanitizeSortFilters } from '@/lib/sort';
import type { PageResult, QueryFilters, Role } from '@/lib/types';

import UserFindManyArgs = Prisma.UserFindManyArgs;

const USER_SORT_FIELDS = ['username', 'role', 'createdAt'] as const;

export interface GetUserOptions {
  includePassword?: boolean;
  showDeleted?: boolean;
}

export interface UserSummary {
  id: string;
  username: string;
  role: string;
  createdAt: Date;
  twoFactorRequired: boolean;
  _count?: {
    websites: number;
  };
}

async function findUser(criteria: Prisma.UserFindUniqueArgs, options: GetUserOptions = {}) {
  const { includePassword = false, showDeleted = false } = options;

  return (
    getRawQueryClient(prisma.client, { write: true }) as typeof prisma.client
  ).user.findUnique({
    ...criteria,
    where: {
      ...criteria.where,
      ...(showDeleted ? {} : { deletedAt: null }),
    },
    select: {
      id: true,
      username: true,
      password: includePassword,
      role: true,
      createdAt: true,
      twoFactorRequired: true,
    },
  });
}

export async function getUser(userId: string, options: GetUserOptions = {}) {
  return findUser(
    {
      where: {
        id: userId,
      },
    },
    options,
  );
}

export async function getUserByUsername(username: string, options: GetUserOptions = {}) {
  return findUser({ where: { username: username.toLowerCase() } }, options);
}

export async function getUsers(
  criteria: UserFindManyArgs,
  filters: QueryFilters = {},
): Promise<PageResult<UserSummary[]>> {
  const sortFilters = sanitizeSortFilters(filters, USER_SORT_FIELDS, {
    orderBy: 'createdAt',
    sortDescending: true,
  });
  const { search } = sortFilters;

  const where: Prisma.UserWhereInput = {
    ...criteria.where,
    ...prisma.getSearchParameters(search, [{ username: 'contains' }]),
    deletedAt: null,
  };

  return prisma.pagedQuery(
    'user',
    {
      ...criteria,
      where,
    },
    sortFilters,
  );
}

export async function createUser(data: {
  id: string;
  username: string;
  password: string;
  role: Role;
}) {
  return prisma.client.user.create({
    data,
    select: {
      id: true,
      username: true,
      role: true,
    },
  });
}

export async function updateUser(userId: string, data: Prisma.UserUpdateInput) {
  return prisma.transaction(async tx => {
    const result = await tx.user.update({
      where: {
        id: userId,
      },
      data,
      select: {
        id: true,
        username: true,
        role: true,
        createdAt: true,
      },
    });
    if (data.role !== undefined) await invalidateAiActorRunsInTransaction(tx, userId);
    return result;
  });
}

export async function deleteUser(userId: string) {
  const cloudMode = !!process.env.CLOUD_MODE;
  const { result, websiteIds, links, pixels } = await prisma.transaction(async tx => {
    const websites = await tx.website.findMany({ where: { userId }, select: { id: true } });
    const ownedWebsiteIds = websites.map(website => website.id);
    const teams = await tx.team.findMany({
      where: { members: { some: { userId, role: ROLES.teamOwner } } },
      select: { id: true },
    });
    const teamIds = teams.map(team => team.id);
    const ownedFilter = cloudMode ? { userId } : { OR: [{ userId }, { teamId: { in: teamIds } }] };
    const [links, pixels, boards, teamWebsites, reports] = await Promise.all([
      tx.link.findMany({ where: ownedFilter, select: { id: true, slug: true, deletedAt: true } }),
      tx.pixel.findMany({ where: ownedFilter, select: { id: true, slug: true, deletedAt: true } }),
      tx.board.findMany({ where: ownedFilter, select: { id: true } }),
      cloudMode
        ? []
        : tx.website.findMany({ where: { teamId: { in: teamIds } }, select: { id: true } }),
      cloudMode
        ? []
        : tx.report.findMany({
            where: { OR: [{ websiteId: { in: ownedWebsiteIds } }, { userId }] },
            select: { websiteId: true },
          }),
    ]);
    const entityIds = [
      ...links.map(link => link.id),
      ...pixels.map(pixel => pixel.id),
      ...boards.map(board => board.id),
    ];
    const websiteIds = [
      ...new Set([
        ...ownedWebsiteIds,
        ...teamWebsites.map(website => website.id),
        ...reports.map(report => report.websiteId),
      ]),
    ];
    await prepareWarehouseCascade(tx, [
      ...ownedWebsiteIds.map(id => ({ id, kind: 'website' as const })),
      ...links.map(w => ({ id: w.id, kind: 'link' as const })),
      ...pixels.map(w => ({ id: w.id, kind: 'pixel' as const })),
    ]);
    await (await import('@/lib/liekan/upstream/ai-lifecycle')).clearAiUserInTransaction(
      tx,
      userId,
      !cloudMode,
    );
    await tx.$queryRawUnsafe(
      'SELECT user_id FROM "user" WHERE user_id=$1::uuid FOR UPDATE',
      userId,
    );
    if (!cloudMode && teamIds.length)
      await tx.$queryRawUnsafe(
        'SELECT team_id FROM team WHERE team_id=ANY($1::uuid[]) ORDER BY team_id FOR UPDATE',
        [...teamIds].sort(),
      );
    const result: any[] = [];
    const deletedAt = new Date();
    if (cloudMode) {
      result.push(
        await tx.website.updateMany({
          data: { deletedAt },
          where: { id: { in: ownedWebsiteIds } },
        }),
      );
      result.push(
        await tx.user.update({
          data: { username: getRandomChars(32), deletedAt },
          where: { id: userId },
        }),
      );
      result.push(await tx.share.deleteMany({ where: { entityId: { in: entityIds } } }));
      result.push(
        await tx.link.updateMany({ data: { deletedAt }, where: { userId, deletedAt: null } }),
      );
      result.push(
        await tx.pixel.updateMany({ data: { deletedAt }, where: { userId, deletedAt: null } }),
      );
      result.push(await tx.board.deleteMany({ where: { userId } }));
    } else {
      result.push(await tx.eventData.deleteMany({ where: { websiteId: { in: ownedWebsiteIds } } }));
      result.push(
        await tx.sessionData.deleteMany({ where: { websiteId: { in: ownedWebsiteIds } } }),
      );
      result.push(
        await tx.websiteEvent.deleteMany({ where: { websiteId: { in: ownedWebsiteIds } } }),
      );
      result.push(await tx.session.deleteMany({ where: { websiteId: { in: ownedWebsiteIds } } }));
      result.push(
        await tx.teamUser.deleteMany({ where: { OR: [{ teamId: { in: teamIds } }, { userId }] } }),
      );
      result.push(await tx.team.deleteMany({ where: { id: { in: teamIds } } }));
      result.push(
        await tx.report.deleteMany({
          where: { OR: [{ websiteId: { in: ownedWebsiteIds } }, { userId }] },
        }),
      );
      result.push(await tx.share.deleteMany({ where: { entityId: { in: entityIds } } }));
      result.push(await tx.link.deleteMany({ where: ownedFilter }));
      result.push(await tx.pixel.deleteMany({ where: ownedFilter }));
      result.push(await tx.board.deleteMany({ where: ownedFilter }));
      result.push(await tx.website.deleteMany({ where: { id: { in: ownedWebsiteIds } } }));
      result.push(await tx.user.delete({ where: { id: userId } }));
    }
    // Keep revisions after deletion so a late calculation cannot republish the old resource.
    await bumpAnalyticsRevision(tx, 'website', ...websiteIds);
    await bumpAnalyticsRevision(tx, 'link', ...links.map(link => link.id));
    await bumpAnalyticsRevision(tx, 'pixel', ...pixels.map(pixel => pixel.id));
    return { result, websiteIds, links, pixels };
  });
  invalidateWebsiteAnalytics(
    ...websiteIds,
    ...links.map(link => link.id),
    ...pixels.map(pixel => pixel.id),
  );
  for (const link of links) analyticsCache.invalidate(`link:${link.id}`);
  for (const pixel of pixels) analyticsCache.invalidate(`pixel:${pixel.id}`);
  if (redis.enabled) {
    await Promise.all([
      ...links.filter(link => !link.deletedAt).map(link => redis.client.del(`link:${link.slug}`)),
      ...pixels
        .filter(pixel => !pixel.deletedAt)
        .map(pixel => redis.client.del(`pixel:${pixel.slug}`)),
    ]);
  }
  return result;
}
