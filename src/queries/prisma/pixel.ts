import { prepareWarehouseCascade } from '@/lib/liekan/upstream/warehouse-cascade';
import { bumpAnalyticsRevision } from '@/lib/liekan/upstream/analytics-revision';
import { analyticsCache, invalidateWebsiteAnalytics } from '@/lib/liekan/upstream/query-cache';
import type { Pixel, Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { sanitizeSortFilters } from '@/lib/sort';
import type { PageResult, QueryFilters } from '@/lib/types';

const PIXEL_SORT_FIELDS = ['name', 'slug', 'createdAt'] as const;

export async function findPixel(criteria: Prisma.PixelFindUniqueArgs) {
  return prisma.client.pixel.findUnique(criteria);
}

export async function getPixel(pixelId: string) {
  return findPixel({
    where: {
      id: pixelId,
    },
  });
}

export async function getPixels(
  criteria: Prisma.PixelFindManyArgs,
  filters: QueryFilters = {},
): Promise<PageResult<Pixel[]>> {
  const sortFilters = sanitizeSortFilters(filters, PIXEL_SORT_FIELDS);
  const { search } = sortFilters;

  const where: Prisma.PixelWhereInput = {
    ...criteria.where,
    ...prisma.getSearchParameters(search, [{ name: 'contains' }, { slug: 'contains' }]),
  };

  return prisma.pagedQuery('pixel', { ...criteria, where }, sortFilters);
}

export async function getUserPixels(userId: string, filters?: QueryFilters) {
  return getPixels(
    {
      where: {
        userId,
      },
    },
    filters,
  );
}

export async function getTeamPixels(teamId: string, filters?: QueryFilters) {
  return getPixels(
    {
      where: {
        teamId,
      },
    },
    filters,
  );
}

export async function createPixel(data: Prisma.PixelUncheckedCreateInput) {
  const result = await prisma.transaction(async tx => {
    const result = await tx.pixel.create({ data });
    await bumpAnalyticsRevision(tx, 'pixel', result.id);
    return result;
  });
  analyticsCache.invalidate(`pixel:${result.id}`);
  invalidateWebsiteAnalytics(result.id);
  return result;
}

export async function updatePixel(pixelId: string, data: any) {
  const result = await prisma.transaction(async tx => {
    const result = await tx.pixel.update({ where: { id: pixelId }, data });
    await bumpAnalyticsRevision(tx, 'pixel', result.id);
    return result;
  });
  analyticsCache.invalidate(`pixel:${result.id}`);
  invalidateWebsiteAnalytics(result.id);
  return result;
}

export async function deletePixel(pixelId: string) {
  const result = await prisma.transaction(async tx => {
    await prepareWarehouseCascade(tx, [{ id: pixelId, kind: 'pixel' }]);
    const result = await tx.pixel.delete({ where: { id: pixelId } });
    await bumpAnalyticsRevision(tx, 'pixel', result.id);
    return result;
  });
  analyticsCache.invalidate(`pixel:${result.id}`);
  invalidateWebsiteAnalytics(result.id);
  return result;
}
