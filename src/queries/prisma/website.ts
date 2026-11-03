import { invalidateWebsiteAnalytics } from '@/lib/liekan/upstream/query-cache';
import { bumpAnalyticsRevision } from '@/lib/liekan/upstream/analytics-revision';
import { z } from 'zod';
import type { Prisma, Website } from '@/generated/prisma/client';
import { ROLES } from '@/lib/constants';
import prisma, { getSchema } from '@/lib/prisma';
import redis from '@/lib/redis';
import { sanitizeSortFilters } from '@/lib/sort';
import type { PageResult, QueryFilters } from '@/lib/types';
import { warehouseIntakeEnabled } from '@/lib/liekan/warehouse/runtime';

const WEBSITE_SORT_FIELDS = ['name', 'domain', 'createdAt'] as const;

export type WebsiteListItem = Website & {
  shareId: string | null;
  user?: { id: string; username: string } | null;
  createUser?: { id: string; username: string } | null;
  team?: {
    members: { userId: string; role: string }[];
  } | null;
};

async function deleteWebsiteDependentData(tx: any, websiteId: string) {
  await tx.sessionReplaySaved.deleteMany({
    where: { websiteId },
  });

  await tx.sessionReplay.deleteMany({
    where: { websiteId },
  });

  await tx.heatmapEvent.deleteMany({
    where: { websiteId },
  });

  await tx.revenue.deleteMany({
    where: { websiteId },
  });

  await tx.eventData.deleteMany({
    where: { websiteId },
  });

  // Follow the real EventData -> WebsiteEvent dependency to clean up any legacy rows
  // whose duplicated websiteId drifted from the parent event row.
  const schema = getSchema();

  if (schema) {
    await tx.$executeRawUnsafe(`SET search_path TO "${schema}";`);
  }

  await tx.$executeRawUnsafe(
    `
      delete from event_data
      using website_event
      where event_data.website_event_id = website_event.event_id
        and website_event.website_id = $1
    `,
    websiteId,
  );

  await tx.sessionData.deleteMany({
    where: { websiteId },
  });

  await tx.sessionLink.deleteMany({
    where: { websiteId },
  });

  await tx.websiteEvent.deleteMany({
    where: { websiteId },
  });

  await tx.session.deleteMany({
    where: { websiteId },
  });
}

export async function findWebsite(criteria: Prisma.WebsiteFindUniqueArgs) {
  return prisma.client.website.findUnique(criteria);
}

// Websites are addressable by their UUID or by the short site number shown in URLs
// (site_number starts at 101 and is assigned by liekan_website_site_number_seq).
const WEBSITE_HANDLE_PATTERN = /^\d{1,9}$/;

export async function getWebsite(websiteId: string) {
  const website = z.uuid().safeParse(websiteId).success
    ? await findWebsite({
        where: {
          id: websiteId,
        },
      })
    : WEBSITE_HANDLE_PATTERN.test(websiteId)
      ? await prisma.client.website.findFirst({
          where: {
            siteNumber: Number(websiteId),
          },
        })
      : null;

  if (!website) {
    return null;
  }

  return attachShareIdToWebsite(website);
}

export async function getWebsites(
  criteria: Prisma.WebsiteFindManyArgs,
  filters: QueryFilters,
): Promise<PageResult<WebsiteListItem[]>> {
  const sortFilters = sanitizeSortFilters(filters, WEBSITE_SORT_FIELDS);
  const { search } = sortFilters;
  const { getSearchParameters, pagedQuery } = prisma;

  const where: Prisma.WebsiteWhereInput = {
    ...criteria.where,
    ...getSearchParameters(search, [
      {
        name: 'contains',
      },
      { domain: 'contains' },
    ]),
    deletedAt: null,
  };

  const websites = await pagedQuery('website', { ...criteria, where }, sortFilters);

  return attachShareIdToWebsites(websites);
}

export async function getAllUserWebsitesIncludingTeamAccess(
  userId: string,
  filters?: QueryFilters,
) {
  return getWebsites(
    {
      where: {
        OR: [
          { userId },
          {
            team: {
              deletedAt: null,
              members: {
                some: {
                  role: { in: [ROLES.teamOwner, ROLES.teamManager] },
                  userId,
                },
              },
            },
          },
        ],
      },
    },
    sanitizeSortFilters(filters, WEBSITE_SORT_FIELDS, { orderBy: 'name' }),
  );
}

export async function getUserWebsites(userId: string, filters?: QueryFilters) {
  return getWebsites(
    {
      where: {
        userId,
      },
      include: {
        user: {
          select: {
            username: true,
            id: true,
          },
        },
      },
    },
    sanitizeSortFilters(filters, WEBSITE_SORT_FIELDS, { orderBy: 'name' }),
  );
}

export async function getTeamWebsites(teamId: string, filters?: QueryFilters) {
  return getWebsites(
    {
      where: {
        teamId,
      },
      include: {
        createUser: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    },
    filters,
  );
}

export async function createWebsite(
  data: Prisma.WebsiteCreateInput | Prisma.WebsiteUncheckedCreateInput,
) {
  return prisma.client.website.create({
    data,
  });
}

export async function updateWebsite(
  websiteId: string,
  data: Prisma.WebsiteUpdateInput | Prisma.WebsiteUncheckedUpdateInput,
) {
  const result = await prisma.transaction(async tx => {
    const before = await tx.website.findUnique({ where: { id: websiteId } });
    const updated = await tx.website.update({ where: { id: websiteId }, data });
    if (
      before &&
      (before.domain !== updated.domain ||
        before.userId !== updated.userId ||
        before.teamId !== updated.teamId)
    ) {
      await (await import('@/lib/liekan/upstream/lifecycle')).stopWebsiteSources(tx, websiteId);
      await (await import('@/lib/liekan/upstream/ai-lifecycle')).clearAiWebsiteInTransaction(
        tx,
        websiteId,
      );
    }
    await bumpAnalyticsRevision(tx, 'website', websiteId);
    return updated;
  });
  invalidateWebsiteAnalytics(websiteId);
  return result;
}

export async function resetWebsite(websiteId: string, identity?: { userId: string }) {
  const { transaction } = prisma;
  const cloudMode = !!process.env.CLOUD_MODE;

  if (warehouseIntakeEnabled()) {
    await (await import('@/lib/liekan/upstream/warehouse-lifecycle')).deleteWarehouseStatistics(
      websiteId,
      'reset',
      identity,
    );
    const data = await prisma.client.website.findUnique({ where: { id: websiteId } });
    if (cloudMode) await redis.client.set(`website:${websiteId}`, data);
    return data;
  }

  return transaction(
    async tx => {
      await (await import('@/lib/liekan/upstream/lifecycle')).resetLiekanStatistics(
        tx,
        websiteId,
        identity,
      );
      await deleteWebsiteDependentData(tx, websiteId);

      const website = await tx.website.update({
        where: { id: websiteId },
        data: {
          resetAt: new Date(),
        },
      });

      await bumpAnalyticsRevision(tx, 'website', websiteId);
      return website;
    },
    {
      timeout: 30000,
    },
  ).then(async data => {
    invalidateWebsiteAnalytics(websiteId);
    if (cloudMode) {
      await redis.client.set(`website:${websiteId}`, data);
    }

    return data;
  });
}

export async function deleteWebsite(websiteId: string, identity?: { userId: string }) {
  const { transaction } = prisma;
  const cloudMode = !!process.env.CLOUD_MODE;

  if (warehouseIntakeEnabled()) {
    const data = await prisma.client.website.findUnique({ where: { id: websiteId } });
    await (await import('@/lib/liekan/upstream/warehouse-lifecycle')).deleteWarehouseStatistics(
      websiteId,
      'website',
      identity,
    );
    if (cloudMode) await redis.client.del(`website:${websiteId}`);
    return data;
  }

  return transaction(
    async tx => {
      await (await import('@/lib/liekan/upstream/lifecycle')).stopWebsiteSources(
        tx,
        websiteId,
        true,
      );
      await (await import('@/lib/liekan/upstream/ai-lifecycle')).clearAiWebsiteInTransaction(
        tx,
        websiteId,
      );
      await deleteWebsiteDependentData(tx, websiteId);

      await tx.report.deleteMany({
        where: { websiteId },
      });

      await tx.segment.deleteMany({
        where: { websiteId },
      });

      await tx.annotation.deleteMany({
        where: { websiteId },
      });

      await tx.share.deleteMany({
        where: { entityId: websiteId },
      });

      const website = cloudMode
        ? await tx.website.update({
            data: {
              deletedAt: new Date(),
            },
            where: { id: websiteId },
          })
        : await tx.website.delete({
            where: { id: websiteId },
          });

      await bumpAnalyticsRevision(tx, 'website', websiteId);
      return website;
    },
    {
      timeout: 30000,
    },
  ).then(async data => {
    invalidateWebsiteAnalytics(websiteId);
    if (cloudMode) {
      await redis.client.del(`website:${websiteId}`);
    }

    return data;
  });
}

export async function getWebsiteCount(userId: string) {
  return prisma.client.website.count({
    where: {
      userId,
      deletedAt: null,
    },
  });
}

export async function getTeamWebsiteCount(teamId: string) {
  return prisma.client.website.count({
    where: {
      teamId,
      deletedAt: null,
    },
  });
}

export async function attachShareIdToWebsite(website: Website) {
  const share = await prisma.client.share.findFirst({
    where: {
      entityId: website.id,
    },
    orderBy: {
      createdAt: 'desc',
    },
    select: {
      slug: true,
    },
  });

  return {
    ...website,
    shareId: share?.slug ?? null,
  };
}

export async function attachShareIdToWebsites(
  websites: PageResult<(Website & Partial<WebsiteListItem>)[]>,
): Promise<PageResult<WebsiteListItem[]>> {
  const websiteIds = websites.data.map(website => website.id);

  if (websiteIds.length === 0) {
    return {
      ...websites,
      data: websites.data.map(website => ({ ...website, shareId: null })),
    };
  }

  const shares = await prisma.client.share.findMany({
    where: {
      entityId: { in: websiteIds },
    },
    distinct: ['entityId'],
    orderBy: {
      createdAt: 'desc',
    },
  });

  const shareByWebsiteId = new Map(shares.map(share => [share.entityId, share.slug]));

  return {
    ...websites,
    data: websites.data.map(website => ({
      ...website,
      shareId: shareByWebsiteId.get(website.id) ?? null,
    })),
  };
}
