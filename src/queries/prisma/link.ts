import { prepareWarehouseCascade } from '@/lib/liekan/upstream/warehouse-cascade';
import { bumpAnalyticsRevision } from '@/lib/liekan/upstream/analytics-revision';
import { analyticsCache, invalidateWebsiteAnalytics } from '@/lib/liekan/upstream/query-cache';
import type { Link, Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { sanitizeSortFilters } from '@/lib/sort';
import type { PageResult, QueryFilters } from '@/lib/types';

const LINK_SORT_FIELDS = ['name', 'slug', 'url', 'createdAt'] as const;

export async function findLink(criteria: Prisma.LinkFindUniqueArgs) {
  return prisma.client.link.findUnique(criteria);
}

export async function getLink(linkId: string) {
  return findLink({
    where: {
      id: linkId,
    },
  });
}

export async function getLinks(
  criteria: Prisma.LinkFindManyArgs,
  filters: QueryFilters = {},
): Promise<PageResult<Link[]>> {
  const sortFilters = sanitizeSortFilters(filters, LINK_SORT_FIELDS);
  const { search } = sortFilters;
  const { getSearchParameters, pagedQuery } = prisma;

  const where: Prisma.LinkWhereInput = {
    ...criteria.where,
    ...getSearchParameters(search, [
      { name: 'contains' },
      { url: 'contains' },
      { slug: 'contains' },
    ]),
  };

  return pagedQuery('link', { ...criteria, where }, sortFilters);
}

export async function getUserLinks(userId: string, filters?: QueryFilters) {
  return getLinks(
    {
      where: {
        userId,
        deletedAt: null,
      },
    },
    filters,
  );
}

export async function getTeamLinks(teamId: string, filters?: QueryFilters) {
  return getLinks(
    {
      where: {
        teamId,
      },
    },
    filters,
  );
}

export async function createLink(data: Prisma.LinkUncheckedCreateInput) {
  const result = await prisma.transaction(async tx => {
    const result = await tx.link.create({ data });
    await bumpAnalyticsRevision(tx, 'link', result.id);
    return result;
  });
  analyticsCache.invalidate(`link:${result.id}`);
  invalidateWebsiteAnalytics(result.id);
  return result;
}

export async function updateLink(linkId: string, data: any) {
  const result = await prisma.transaction(async tx => {
    const result = await tx.link.update({ where: { id: linkId }, data });
    await bumpAnalyticsRevision(tx, 'link', result.id);
    return result;
  });
  analyticsCache.invalidate(`link:${result.id}`);
  invalidateWebsiteAnalytics(result.id);
  return result;
}

export async function deleteLink(linkId: string) {
  const result = await prisma.transaction(async tx => {
    await prepareWarehouseCascade(tx, [{ id: linkId, kind: 'link' }]);
    const result = await tx.link.delete({ where: { id: linkId } });
    await bumpAnalyticsRevision(tx, 'link', result.id);
    return result;
  });
  analyticsCache.invalidate(`link:${result.id}`);
  invalidateWebsiteAnalytics(result.id);
  return result;
}
