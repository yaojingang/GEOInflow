import { warehouseEnabled, warehouseIntakeEnabled } from '@/lib/liekan/warehouse/authority-routing';
import type { SessionReplaySaved } from '@/generated/prisma/client';
import { uuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';
import type { PageResult, QueryFilters } from '@/lib/types';

export interface CreateReplayChunkArgs {
  websiteId: string;
  sessionId: string;
  visitId: string;
  chunkIndex: number;
  events: Uint8Array;
  eventCount: number;
  startedAt: Date;
  endedAt: Date;
}

export async function getReplayChunks(websiteId: string, visitId: string) {
  return prisma.client.sessionReplay.findMany({
    where: {
      websiteId,
      visitId,
    },
    orderBy: {
      chunkIndex: 'asc',
    },
    select: {
      events: true,
      sessionId: true,
      chunkIndex: true,
      eventCount: true,
      startedAt: true,
      endedAt: true,
    },
  });
}

export async function createReplayChunk({
  websiteId,
  sessionId,
  visitId,
  chunkIndex,
  events,
  eventCount,
  startedAt,
  endedAt,
}: CreateReplayChunkArgs) {
  return prisma.client.sessionReplay.create({
    data: {
      id: uuid(),
      websiteId,
      sessionId,
      visitId,
      chunkIndex,
      events: new Uint8Array(events) as any,
      eventCount,
      startedAt,
      endedAt,
    },
  });
}

export async function deleteReplaysByWebsite(websiteId: string) {
  return prisma.client.sessionReplay.deleteMany({
    where: { websiteId },
  });
}

export async function getReplaySaved(websiteId: string, visitId: string): Promise<boolean> {
  const record = await prisma.client.sessionReplaySaved.findUnique({
    where: { websiteId_visitId: { websiteId, visitId } },
    select: { id: true },
  });
  return record !== null;
}

export async function createReplaySaved(
  websiteId: string,
  visitId: string,
  name: string,
  identity?: { userId: string },
) {
  if (warehouseEnabled())
    return (
      await import('@/lib/liekan/upstream/warehouse-replay-bookmarks')
    ).createWarehouseReplayBookmark(websiteId, visitId, name, identity);
  if (warehouseIntakeEnabled())
    return prisma.transaction(async tx => {
      const { LiekanError, lockWritableWebsite } = await import('@/lib/liekan/upstream/server');
      const [installation] = await tx.$queryRawUnsafe(
        'SELECT authority FROM liekan_warehouse_installation WHERE id=1 FOR SHARE',
      );
      if (installation?.authority !== 'postgres')
        throw new LiekanError('统计服务正在切换，请稍后重试', 503, 'warehouse-authority-frozen');
      await lockWritableWebsite(tx, websiteId, identity, 'share');
      const owners = await tx.$queryRawUnsafe(
        'SELECT DISTINCT session_id FROM session_replay WHERE website_id=$1::uuid AND visit_id=$2::uuid ORDER BY session_id LIMIT 2',
        websiteId,
        visitId,
      );
      if (owners.length !== 1)
        throw new LiekanError('录屏已删除或所属访问不明确', 409, 'warehouse-replay-unavailable');
      const pending = await tx.$queryRawUnsafe(
        "SELECT 1 FROM liekan_warehouse_deletion WHERE website_id=$1::uuid AND status NOT IN('active','reclaimed') AND (session_id IS NULL OR session_id=$2::uuid) LIMIT 1",
        websiteId,
        owners[0].session_id,
      );
      if (pending.length)
        throw new LiekanError(
          '录屏所属访问正在变化，请重试',
          409,
          'warehouse-replay-source-changed',
        );
      const saved = await tx.sessionReplaySaved.create({
        data: { id: uuid(), websiteId, visitId, name },
      });
      await tx.$executeRawUnsafe(
        'INSERT INTO liekan_warehouse_replay_bookmark_owner(saved_replay_id,website_id,session_id) VALUES($1::uuid,$2::uuid,$3::uuid)',
        saved.id,
        websiteId,
        owners[0].session_id,
      );
      return saved;
    });
  return prisma.client.sessionReplaySaved.create({
    data: { id: uuid(), websiteId, visitId, name },
  });
}

export async function updateReplaySaved(websiteId: string, visitId: string, name: string) {
  return prisma.client.sessionReplaySaved.updateMany({
    where: { websiteId, visitId },
    data: { name },
  });
}

export async function deleteReplaySaved(websiteId: string, visitId: string) {
  return prisma.client.sessionReplaySaved.deleteMany({
    where: { websiteId, visitId },
  });
}

export async function getSavedReplays(
  websiteId: string,
  filters: QueryFilters,
): Promise<PageResult<SessionReplaySaved[]>> {
  const { search } = filters;
  const { getSearchParameters, pagedQuery } = prisma;

  const where = {
    websiteId,
    ...getSearchParameters(search, [{ name: 'contains' }]),
  };

  return pagedQuery(
    'sessionReplaySaved',
    {
      where,
      orderBy: { createdAt: 'desc' },
    },
    filters,
  );
}
