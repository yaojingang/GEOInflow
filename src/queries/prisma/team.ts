import { prepareWarehouseCascade } from '@/lib/liekan/upstream/warehouse-cascade';
import { Prisma, type Team, type TeamUser } from '@/generated/prisma/client';
import { ROLES } from '@/lib/constants';
import { uuid } from '@/lib/crypto';
import { bumpAnalyticsRevision } from '@/lib/liekan/upstream/analytics-revision';
import { analyticsCache, invalidateWebsiteAnalytics } from '@/lib/liekan/upstream/query-cache';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { sanitizeSortFilters } from '@/lib/sort';
import type { PageResult, QueryFilters } from '@/lib/types';

import TeamFindManyArgs = Prisma.TeamFindManyArgs;

const TEAM_SORT_FIELDS = ['name', 'createdAt'] as const;

export async function findTeam(criteria: Prisma.TeamFindUniqueArgs): Promise<Team> {
  return prisma.client.team.findUnique(criteria);
}

export async function getTeam(
  teamId: string,
  options: { includeMembers?: boolean } = {},
): Promise<Team> {
  const { includeMembers } = options;

  return findTeam({
    where: {
      id: teamId,
    },
    ...(includeMembers && { include: { members: true } }),
  });
}

export async function getTeams(
  criteria: TeamFindManyArgs,
  filters: QueryFilters,
): Promise<PageResult<Team[]>> {
  const { getSearchParameters } = prisma;
  const sortFilters = sanitizeSortFilters(filters, TEAM_SORT_FIELDS);
  const { search } = sortFilters;

  const where: Prisma.TeamWhereInput = {
    ...criteria.where,
    ...getSearchParameters(search, [{ name: 'contains' }]),
  };

  return prisma.pagedQuery<TeamFindManyArgs>(
    'team',
    {
      ...criteria,
      where,
    },
    sortFilters,
  );
}

export async function getUserTeams(userId: string, filters: QueryFilters = {}) {
  return getTeams(
    {
      where: {
        deletedAt: null,
        members: {
          some: { userId },
        },
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
              },
            },
          },
        },
        _count: {
          select: {
            websites: {
              where: { deletedAt: null },
            },
            members: {
              where: {
                user: { deletedAt: null },
              },
            },
          },
        },
      },
    },
    filters,
  );
}

export async function getAllUserTeams(userId: string) {
  return prisma.client.team.findMany({
    where: {
      deletedAt: null,
      members: {
        some: { userId },
      },
    },
    select: {
      id: true,
      name: true,
      logoUrl: true,
    },
  });
}

export async function getUserOwnedTeamCount(userId: string) {
  return prisma.client.team.count({
    where: {
      deletedAt: null,
      members: {
        some: { userId, role: ROLES.teamOwner },
      },
    },
  });
}

export async function getTeamOwner(teamId: string) {
  return prisma.client.teamUser.findFirst({
    where: { teamId, role: ROLES.teamOwner },
    select: { userId: true },
  });
}

export async function createTeam(
  data: Prisma.TeamCreateInput,
  userId: string,
): Promise<[Team, TeamUser]> {
  const { id } = data;
  const { client, transaction } = prisma;

  return transaction([
    client.team.create({
      data,
    }),
    client.teamUser.create({
      data: {
        id: uuid(),
        teamId: id,
        userId,
        role: ROLES.teamOwner,
      },
    }),
  ]) as Promise<[Team, TeamUser]>;
}

export async function updateTeam(teamId: string, data: Prisma.TeamUpdateInput): Promise<Team> {
  const { client } = prisma;

  return client.team.update({
    where: {
      id: teamId,
    },
    data: {
      ...data,
      updatedAt: new Date(),
    },
  });
}

export async function deleteTeam(teamId: string) {
  const cloudMode = !!process.env.CLOUD_MODE;
  const { result, websites, links, pixels } = await prisma.transaction(async tx => {
    const [links, pixels, boards, websites] = await Promise.all([
      tx.link.findMany({ where: { teamId }, select: { id: true, slug: true, deletedAt: true } }),
      tx.pixel.findMany({ where: { teamId }, select: { id: true, slug: true, deletedAt: true } }),
      tx.board.findMany({ where: { teamId }, select: { id: true } }),
      tx.website.findMany({ where: { teamId }, select: { id: true } }),
    ]);
    const entityIds = [
      ...links.map(link => link.id),
      ...pixels.map(pixel => pixel.id),
      ...boards.map(board => board.id),
    ];
    await prepareWarehouseCascade(tx, [
      ...links.map(w => ({ id: w.id, kind: 'link' as const })),
      ...pixels.map(w => ({ id: w.id, kind: 'pixel' as const })),
    ]);
    await (await import('@/lib/liekan/upstream/ai-lifecycle')).clearAiTeamInTransaction(tx, teamId);
    // Membership creation and deletion share this lock even without AI tables.
    await tx.$queryRawUnsafe('SELECT team_id FROM team WHERE team_id=$1::uuid FOR UPDATE', teamId);
    const result: any[] = [];
    if (cloudMode) {
      result.push(
        await tx.team.update({
          data: { deletedAt: new Date(), accessCode: null },
          where: { id: teamId },
        }),
      );
      result.push(await tx.share.deleteMany({ where: { entityId: { in: entityIds } } }));
      result.push(
        await tx.link.updateMany({
          data: { deletedAt: new Date() },
          where: { teamId, deletedAt: null },
        }),
      );
      result.push(
        await tx.pixel.updateMany({
          data: { deletedAt: new Date() },
          where: { teamId, deletedAt: null },
        }),
      );
      result.push(await tx.board.deleteMany({ where: { teamId } }));
    } else {
      result.push(await tx.teamUser.deleteMany({ where: { teamId } }));
      result.push(await tx.share.deleteMany({ where: { entityId: { in: entityIds } } }));
      result.push(await tx.link.deleteMany({ where: { teamId } }));
      result.push(await tx.pixel.deleteMany({ where: { teamId } }));
      result.push(await tx.board.deleteMany({ where: { teamId } }));
      result.push(await tx.team.delete({ where: { id: teamId } }));
    }
    await bumpAnalyticsRevision(tx, 'website', ...websites.map(website => website.id));
    await bumpAnalyticsRevision(tx, 'link', ...links.map(link => link.id));
    await bumpAnalyticsRevision(tx, 'pixel', ...pixels.map(pixel => pixel.id));
    return { result, websites, links, pixels };
  });
  invalidateWebsiteAnalytics(
    ...websites.map(website => website.id),
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
