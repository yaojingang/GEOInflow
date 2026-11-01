import { LiekanError } from './errors';

export interface RobotsStateTransaction {
  $queryRawUnsafe(sql: string, ...params: unknown[]): Promise<unknown[]>;
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>;
}

export async function lockRobotsState(tx: RobotsStateTransaction, websiteId: string) {
  // Website lifecycle and legacy settings hold the website lock before the helper state lock.
  try {
    return await tx.$queryRawUnsafe(
      'SELECT website_id FROM liekan_robots_state WHERE website_id=$1::uuid FOR UPDATE NOWAIT',
      websiteId,
    );
  } catch (error) {
    const cause = error as {
      code?: unknown;
      meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
    };
    if (
      [
        cause?.code,
        cause?.meta?.code,
        cause?.meta?.driverAdapterError?.cause?.originalCode,
      ].includes('55P03')
    )
      throw new LiekanError('robots 状态正在同步，请稍后重试', 409);
    throw error;
  }
}

export async function syncLegacyRobotsDraft(
  tx: RobotsStateTransaction,
  websiteId: string,
  content: string,
) {
  if ((await lockRobotsState(tx, websiteId)).length)
    await tx.$executeRawUnsafe(
      'UPDATE liekan_robots_state SET draft=$2,revision=revision+1 WHERE website_id=$1::uuid',
      websiteId,
      content,
    );
}
