import { warehouseEnabled } from '../warehouse/authority-routing';
import { AnalyticsUnavailable } from './analytics-budget';
import { currentCacheContext } from './cache-context';
import { LiekanError } from './errors';

type DeletionState = { epoch: string; revision: string; pending: boolean };

/** Bind the cache key and the final HTTP check to the same committed deletion state. */
export async function bindReportDeletion(websiteId: string) {
  if (!warehouseEnabled()) return;
  const { warehouseV2Enabled } = await import('../warehouse-v2/runtime');
  if (!warehouseV2Enabled()) return;

  const context = currentCacheContext();
  if (!context) throw new Error('missing-report-request-context');
  const { warehouseReader } = await import('../warehouse/reader-runtime');
  const { db } = warehouseReader();
  const read = async () => {
    const [state] = await db.read<DeletionState>(
      `SELECT coalesce(s.epoch,1)::text AS epoch, coalesce(d.revision,0)::text AS revision,
              d.pending_kind IS NOT NULL AS pending
         FROM website w
         LEFT JOIN liekan_log_state s USING (website_id)
         LEFT JOIN liekan_v2_evidence_deletion d USING (website_id)
        WHERE w.website_id=$1::uuid AND w.deleted_at IS NULL`,
      [websiteId],
    );
    if (state?.pending) throw new AnalyticsUnavailable('站点统计正在清理，请稍后重试', 2);
    return state;
  };
  const initial = await read();
  if (!initial) throw new LiekanError('站点不存在', 404);
  context.reportDeletion = {
    key: [websiteId, initial.epoch, initial.revision],
    verify: async () => {
      const current = await read();
      if (!current || current.epoch !== initial.epoch || current.revision !== initial.revision)
        throw new AnalyticsUnavailable('站点统计已清理，请重新读取', 1, 409);
    },
  };
}
