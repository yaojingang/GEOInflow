import { invalidateWebsiteAnalytics } from '@/lib/liekan/upstream/query-cache';
import {
  bumpAnalyticsRevision,
  setAnalyticsSchema,
} from '@/lib/liekan/upstream/analytics-revision';
import prisma from '@/lib/prisma';
import { warehouseIntakeEnabled } from '@/lib/liekan/warehouse/runtime';

export async function deleteSession(
  websiteId: string,
  sessionId: string,
  identity?: { userId: string },
): Promise<{ id: string } | null> {
  if (warehouseIntakeEnabled()) {
    await (await import('@/lib/liekan/upstream/warehouse-lifecycle')).deleteWarehouseStatistics(
      websiteId,
      'session',
      identity,
      sessionId,
    );
    return { id: sessionId };
  }
  const transaction = prisma.transaction as <T>(input: (tx: any) => Promise<T>) => Promise<T>;

  const result = await transaction(async tx => {
    // Match lifecycle lock order before child deletion invokes analysis capture.
    await setAnalyticsSchema(tx);
    await tx.$queryRawUnsafe(
      'SELECT website_id FROM website WHERE website_id=$1::uuid FOR UPDATE',
      websiteId,
    );
    const session = await tx.session.findFirst({
      where: {
        id: sessionId,
        websiteId,
      },
      select: {
        id: true,
      },
    });

    if (!session) {
      return null;
    }

    const websiteEvents = await tx.websiteEvent.findMany({
      where: {
        websiteId,
        sessionId,
      },
      select: {
        id: true,
        visitId: true,
      },
    });

    const sessionReplays = await tx.sessionReplay.findMany({
      where: {
        websiteId,
        sessionId,
      },
      select: {
        visitId: true,
      },
    });

    const eventIds = websiteEvents.map(({ id }) => id);
    const visitIds = Array.from(
      new Set([...websiteEvents, ...sessionReplays].map(({ visitId }) => visitId)),
    );

    if (eventIds.length) {
      await tx.eventData.deleteMany({
        where: {
          websiteEventId: {
            in: eventIds,
          },
        },
      });
    }

    if (visitIds.length) {
      await tx.sessionReplaySaved.deleteMany({
        where: {
          websiteId,
          visitId: {
            in: visitIds,
          },
        },
      });
    }

    await tx.sessionReplay.deleteMany({
      where: {
        websiteId,
        sessionId,
      },
    });

    await tx.heatmapEvent.deleteMany({
      where: {
        websiteId,
        sessionId,
      },
    });

    await tx.revenue.deleteMany({
      where: {
        websiteId,
        sessionId,
      },
    });

    await tx.sessionData.deleteMany({
      where: {
        websiteId,
        sessionId,
      },
    });

    await tx.sessionLink.deleteMany({
      where: {
        websiteId,
        sessionId,
      },
    });

    await tx.websiteEvent.deleteMany({
      where: {
        websiteId,
        sessionId,
      },
    });

    await tx.session.delete({
      where: {
        id: sessionId,
      },
    });

    await bumpAnalyticsRevision(tx, 'website', websiteId);
    return session;
  });
  invalidateWebsiteAnalytics(websiteId);
  return result;
}
