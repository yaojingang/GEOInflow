import { z } from 'zod';
import type { Prisma, Website } from '@/generated/prisma/client';
import { ROLES } from '@/lib/constants';
import { bumpAnalyticsRevision } from '@/lib/liekan/upstream/analytics-revision';
import { invalidateWebsiteAnalytics } from '@/lib/liekan/upstream/query-cache';
import prisma, { getSchema } from '@/lib/prisma';
import redis from '@/lib/redis';
import { sanitizeSortFilters } from '@/lib/sort';
import type { PageResult, QueryFilters } from '@/lib/types';

const WEBSITE_SORT_FIELDS = ['name', 'domain', 'createdAt'] as const;

export type WebsiteListItem = Website & {
  shareId: string | null;
  user?: { id: string; username: string } | null;
  createUser?: { id: string; username: string } | null;
  team?: {
    members: { userId: string; role: string }[];
  } | null;
};

const DELETE_BATCH = 5000;
const PURGE_ATTEMPTS = 5;
const UMAMI_TABLES_BEFORE_EVENT_SAFETY = [
  'session_replay_saved',
  'session_replay',
  'heatmap_event',
  'revenue',
  'event_data',
] as const;
const UMAMI_TABLES_AFTER_EVENT_SAFETY = [
  'session_data',
  'session_link',
  'website_event',
  'session',
] as const;
const HISTORY_REPAIR_TABLES = [
  'liekan_history_repair_result',
  'liekan_history_repair_day',
  'liekan_history_repair_visitor',
  'liekan_history_repair_input',
  'liekan_history_repair_action',
  'liekan_history_repair_run',
] as const;
const WEBSITE_CASCADE_SQL = `WITH RECURSIVE tree AS (
  SELECT con.conrelid AS child, 1 AS depth, ARRAY[con.conrelid] AS seen
  FROM pg_constraint con
  JOIN pg_class parent ON parent.oid = con.confrelid
  JOIN pg_namespace pn ON pn.oid = parent.relnamespace
  WHERE con.contype = 'f' AND con.confdeltype = 'c'
    AND parent.relname = 'website' AND pn.nspname = current_schema()
  UNION ALL
  SELECT con.conrelid, tree.depth + 1, tree.seen || con.conrelid
  FROM pg_constraint con
  JOIN tree ON con.confrelid = tree.child
  WHERE con.contype = 'f' AND con.confdeltype = 'c' AND NOT con.conrelid = ANY(tree.seen)
)
SELECT name FROM (
  SELECT c.relname AS name, max(tree.depth) AS depth
  FROM tree
  JOIN pg_class c ON c.oid = tree.child
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attname = 'website_id' AND NOT a.attisdropped
    )
  GROUP BY c.relname
) ordered_tables
ORDER BY depth DESC, name`;

function assertSqlIdentifier(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Invalid SQL identifier');
}

function websiteBatchDeleteSql(table: string, keys: string[], where: string) {
  assertSqlIdentifier(table);
  const columns = keys.length ? keys : ['ctid'];
  for (const column of columns) assertSqlIdentifier(column);
  const list = columns.join(',');
  // shortcut: 5000-row batches, lower DELETE_BATCH if one batch exceeds the 30s transaction
  return `DELETE FROM ${table} WHERE (${list}) IN (SELECT ${list} FROM ${table} WHERE ${where} LIMIT ${DELETE_BATCH})`;
}

async function inShortTransaction<T>(fn: (tx: any) => Promise<T>) {
  return prisma.transaction(
    async tx => {
      const schema = getSchema();
      if (schema) {
        assertSqlIdentifier(schema);
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      }
      return fn(tx);
    },
    { timeout: 30000 },
  );
}

async function primaryKeyColumns(table: string) {
  const rows = await inShortTransaction(tx =>
    tx.$queryRawUnsafe(
      `SELECT a.attname AS name
       FROM pg_index i
       JOIN pg_attribute a
         ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) AND a.attnum > 0 AND NOT a.attisdropped
       WHERE i.indrelid = to_regclass($1) AND i.indisprimary
       ORDER BY array_position(i.indkey, a.attnum)`,
      table,
    ),
  );
  return (rows as { name: string }[]).map(row => row.name);
}

async function deleteInBatches(table: string, websiteId: string, where = 'website_id = $1::uuid') {
  const sql = websiteBatchDeleteSql(table, await primaryKeyColumns(table), where);
  for (;;) {
    const removed = Number(await inShortTransaction(tx => tx.$executeRawUnsafe(sql, websiteId)));
    if (!Number.isFinite(removed) || removed < DELETE_BATCH) break;
  }
}

async function deleteEventDataLinkedToWebsite(websiteId: string) {
  const sql = `DELETE FROM event_data WHERE (ctid) IN (
    SELECT event_data.ctid FROM event_data
    JOIN website_event ON event_data.website_event_id = website_event.event_id
    WHERE website_event.website_id = $1::uuid
    LIMIT ${DELETE_BATCH}
  )`;
  for (;;) {
    const removed = Number(await inShortTransaction(tx => tx.$executeRawUnsafe(sql, websiteId)));
    if (!Number.isFinite(removed) || removed < DELETE_BATCH) break;
  }
}

async function purgeUmamiFacts(websiteId: string) {
  for (const table of UMAMI_TABLES_BEFORE_EVENT_SAFETY) await deleteInBatches(table, websiteId);
  await deleteEventDataLinkedToWebsite(websiteId);
  for (const table of UMAMI_TABLES_AFTER_EVENT_SAFETY) await deleteInBatches(table, websiteId);
}

async function cascadedWebsiteTables() {
  const rows = await inShortTransaction(tx => tx.$queryRawUnsafe(WEBSITE_CASCADE_SQL));
  return (rows as { name: string }[]).map(row => {
    assertSqlIdentifier(row.name);
    return row.name;
  });
}

async function purgeResetFacts(websiteId: string) {
  const lifecycle = await import('@/lib/liekan/upstream/lifecycle');
  for (const table of HISTORY_REPAIR_TABLES) await deleteInBatches(table, websiteId);
  for (const table of lifecycle.LIEKAN_GEO_TABLES) await deleteInBatches(table, websiteId);
  for (const table of lifecycle.LIEKAN_RESET_FACT_TABLES) await deleteInBatches(table, websiteId);
  await deleteInBatches(
    'liekan_crawler_check',
    websiteId,
    "website_id = $1::uuid AND state NOT IN('queued','running')",
  );
  for (const table of lifecycle.LIEKAN_RESET_TAIL_TABLES) await deleteInBatches(table, websiteId);
  await purgeUmamiFacts(websiteId);
}

async function purgeDeleteFacts(websiteId: string, cloudMode: boolean) {
  const lifecycle = await import('@/lib/liekan/upstream/lifecycle');
  // Hard delete would cascade these inside the website-row transaction.
  if (!cloudMode) {
    for (const table of await cascadedWebsiteTables()) await deleteInBatches(table, websiteId);
  }
  for (const table of HISTORY_REPAIR_TABLES) await deleteInBatches(table, websiteId);
  for (const table of lifecycle.LIEKAN_GEO_TABLES) await deleteInBatches(table, websiteId);
  for (const table of lifecycle.LIEKAN_DELETE_FACT_TABLES) await deleteInBatches(table, websiteId);
  await purgeUmamiFacts(websiteId);
}

async function commitAfterPurge<T>(purge: () => Promise<void>, commit: () => Promise<T>) {
  for (let attempt = 1; ; attempt++) {
    await purge();
    try {
      return await commit();
    } catch (error) {
      // shortcut: five purge attempts, raise the cap if the final 30s transaction still times out
      if ((error as { code?: string })?.code !== 'P2028' || attempt >= PURGE_ATTEMPTS) throw error;
    }
  }
}

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
  const cloudMode = !!process.env.CLOUD_MODE;
  await inShortTransaction(async tx => {
    await (await import('@/lib/liekan/upstream/server')).lockWritableWebsite(
      tx,
      websiteId,
      identity,
    );
  });

  const data = await commitAfterPurge(
    () => purgeResetFacts(websiteId),
    () =>
      inShortTransaction(async tx => {
        await (await import('@/lib/liekan/upstream/lifecycle')).resetLiekanStatistics(
          tx,
          websiteId,
          identity,
        );
        await deleteWebsiteDependentData(tx, websiteId);
        const website = await tx.website.update({
          where: { id: websiteId },
          data: { resetAt: new Date() },
        });
        await bumpAnalyticsRevision(tx, 'website', websiteId);
        return website;
      }),
  );
  invalidateWebsiteAnalytics(websiteId);
  if (cloudMode) await redis.client.set(`website:${websiteId}`, data);
  return data;
}

export async function deleteWebsite(websiteId: string) {
  const cloudMode = !!process.env.CLOUD_MODE;
  const data = await commitAfterPurge(
    () => purgeDeleteFacts(websiteId, cloudMode),
    () =>
      inShortTransaction(async tx => {
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
        await tx.report.deleteMany({ where: { websiteId } });
        await tx.segment.deleteMany({ where: { websiteId } });
        await tx.annotation.deleteMany({ where: { websiteId } });
        await tx.share.deleteMany({ where: { entityId: websiteId } });
        const website = cloudMode
          ? await tx.website.update({
              data: { deletedAt: new Date() },
              where: { id: websiteId },
            })
          : await tx.website.delete({ where: { id: websiteId } });
        await bumpAnalyticsRevision(tx, 'website', websiteId);
        return website;
      }),
  );
  invalidateWebsiteAnalytics(websiteId);
  if (cloudMode) await redis.client.del(`website:${websiteId}`);
  return data;
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
