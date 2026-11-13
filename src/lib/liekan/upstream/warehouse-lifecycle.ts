import { setTimeout as delay } from 'node:timers/promises';
import { hasPermission } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/constants';
import { type ControlSQL, WarehouseConflict } from '../warehouse/control-db';
import {
  WarehouseDeletions,
  type DeletionFinalizer,
  type DeletionOperation,
} from '../warehouse/deletions';
import { warehouseRuntime, type WarehouseRuntime } from '../warehouse/runtime';
import { bumpAnalyticsRevision } from './analytics-revision';
import { clearAiWebsiteInTransaction } from './ai-lifecycle';
import { resetLiekanStatistics, stopWebsiteSources } from './lifecycle';
import { invalidateWebsiteAnalytics } from './query-cache';
import { LiekanError, lockWritableWebsite, type WriteIdentity } from './server';
import { warehouseControlAdapter } from './warehouse-authority';

export async function assertWarehouseLifecycleEditable(tx: any, site: string) {
  // The caller holds the business website lock. Consumer confirmation also
  // takes that lock before warehouse state, so no new confirmation can race us.
  const blocked = await tx.$queryRawUnsafe(
    `SELECT 1 FROM liekan_warehouse_deletion
    WHERE website_id=$1::uuid AND status NOT IN('active','reclaimed')
    UNION ALL SELECT 1 FROM liekan_warehouse_task WHERE website_id=$1::uuid AND status='confirmed' LIMIT 1`,
    site,
  );
  if (blocked.length)
    throw new LiekanError('网站数据操作尚未完成，请稍后重试', 409, 'warehouse-lifecycle-pending');
}

async function authorize(
  tx: ControlSQL,
  site: string,
  kind: DeletionOperation['kind'],
  identity: WriteIdentity,
) {
  if (!identity?.userId) throw new LiekanError('请先登录', 401);
  await lockWritableWebsite(warehouseControlAdapter(tx), site, identity);
  if (kind === 'reset') return;
  const [user] = (
    await tx.query<{ role: string }>(
      'SELECT role FROM "user" WHERE user_id=$1 AND deleted_at IS NULL FOR SHARE',
      [identity.userId],
    )
  ).rows;
  if (await hasPermission(user.role, PERMISSIONS.all)) return;
  const [owner] = (
    await tx.query<{ user_id: string | null; team_id: string | null }>(
      'SELECT user_id,team_id FROM website WHERE website_id=$1',
      [site],
    )
  ).rows;
  if (owner.user_id === identity.userId) return;
  const [member] = (
    await tx.query<{ role: string }>(
      'SELECT role FROM team_user WHERE team_id=$1 AND user_id=$2 FOR SHARE',
      [owner.team_id, identity.userId],
    )
  ).rows;
  if (!member || !(await hasPermission(member.role, PERMISSIONS.websiteDelete)))
    throw new LiekanError('站点删除权限已变更', 403);
}

export const warehouseLifecycleFinalizer: DeletionFinalizer = {
  lock: async (tx, op) => {
    // begin() recorded an authorized durable command. Ownership changes are
    // fenced while pending; recovery completes that same command after a crash.
    const [state] = (
      await tx.query<{ resource_type: 'website' | 'link' | 'pixel' }>(
        'SELECT resource_type FROM liekan_warehouse_site WHERE website_id=$1',
        [op.website_id],
      )
    ).rows;
    if (!state || !['website', 'link', 'pixel'].includes(state.resource_type))
      throw new WarehouseConflict('warehouse-resource-unavailable');
    // A parent cascade can already have removed the business row. The durable
    // operation created by that same transaction still publishes its tombstone.
    const present = await tx.query(
      `SELECT ${state.resource_type}_id FROM ${state.resource_type} WHERE ${state.resource_type}_id=$1 FOR UPDATE`,
      [op.website_id],
    );
    if (!present.rowCount && op.kind !== 'website')
      throw new WarehouseConflict('warehouse-resource-unavailable');
  },
  apply: async (tx, op) => {
    const site = op.website_id,
      sql = warehouseControlAdapter(tx);
    const [state] = (
      await tx.query<{ resource_type: 'website' | 'link' | 'pixel' }>(
        'SELECT resource_type FROM liekan_warehouse_site WHERE website_id=$1',
        [site],
      )
    ).rows;
    if (state.resource_type !== 'website') {
      if (op.kind !== 'website') throw new WarehouseConflict('warehouse-invalid-resource-deletion');
      await bumpAnalyticsRevision(sql, state.resource_type, site);
      return;
    }
    const present = await tx.query(
      'SELECT 1 FROM website WHERE website_id=$1 AND deleted_at IS NULL',
      [site],
    );
    if (!present.rowCount) {
      await bumpAnalyticsRevision(sql, 'website', site);
      return;
    }
    if (op.kind === 'session') {
      await tx.query(
        `DELETE FROM session_replay_saved s USING liekan_warehouse_replay_bookmark_owner o
        WHERE s.saved_replay_id=o.saved_replay_id AND o.website_id=$1 AND o.session_id=$2`,
        [site, op.session_id],
      );
      // Repair output is retained for audit, but no longer claims that its frozen
      // source is intact. Current reports already filter deleted parent facts.
      await tx.query(
        `SELECT liekan_history_repair_mark_gap(id,website_id,generation,'warehouse-session-delete')
        FROM liekan_history_repair_run WHERE website_id=$1`,
        [site],
      );
      await tx.query(
        `UPDATE liekan_browser_risk_state SET next_window=least(next_window,date_trunc('minute',clock_timestamp()-interval '30 days')),
        next_attempt_at=clock_timestamp() WHERE website_id=$1`,
        [site],
      );
      await tx.query('DELETE FROM liekan_geo_weight_head WHERE website_id=$1', [site]);
      await tx.query('DELETE FROM liekan_dashboard_snapshot WHERE website_id=$1', [site]);
    } else {
      if (op.kind === 'reset') await resetLiekanStatistics(sql, site);
      else {
        await stopWebsiteSources(sql, site, true);
        await clearAiWebsiteInTransaction(sql, site);
      }
      await tx.query('DELETE FROM session_replay_saved WHERE website_id=$1', [site]);
      // These tasks have not been confirmed. Their queue copies are fenced by
      // the new epoch; accepted tasks were drained before this transaction.
      await tx.query(
        "UPDATE liekan_warehouse_task SET status='cancelled',updated_at=clock_timestamp() WHERE website_id=$1 AND status='pending'",
        [site],
      );
      await tx.query(
        "UPDATE liekan_warehouse_upload SET status='cancelled',updated_at=clock_timestamp() WHERE website_id=$1 AND status='pending'",
        [site],
      );
      if (op.kind === 'reset')
        await tx.query('UPDATE website SET reset_at=clock_timestamp() WHERE website_id=$1', [site]);
      else {
        for (const table of ['report', 'segment', 'annotation'])
          await tx.query(`DELETE FROM ${table} WHERE website_id=$1`, [site]);
        await tx.query('DELETE FROM share WHERE entity_id=$1', [site]);
        if (process.env.CLOUD_MODE)
          await tx.query('UPDATE website SET deleted_at=clock_timestamp() WHERE website_id=$1', [
            site,
          ]);
        else await tx.query('DELETE FROM website WHERE website_id=$1', [site]);
      }
    }
    await bumpAnalyticsRevision(sql, 'website', site);
  },
};

export async function deleteWarehouseStatistics(
  site: string,
  kind: DeletionOperation['kind'],
  identity: WriteIdentity,
  session: string | null = null,
  injected?: WarehouseRuntime,
) {
  const runtime = injected ?? (await warehouseRuntime()),
    deletions = new WarehouseDeletions(runtime);
  const operation = await deletions.begin(site, kind, session, identity?.userId ?? null, {
    authorize: tx => authorize(tx, site, kind, identity),
  });
  const deadline = Date.now() + 10000;
  do {
    try {
      const result = await deletions.advance(operation.operation_id, warehouseLifecycleFinalizer);
      invalidateWebsiteAnalytics(site);
      return result;
    } catch (error) {
      if (
        !(error instanceof WarehouseConflict) ||
        ![
          'warehouse-deletion-owned',
          'warehouse-deletion-awaiting-publication',
          'warehouse-control-busy',
        ].includes(error.code)
      )
        throw error;
      await delay(100);
    }
  } while (Date.now() < deadline);
  // No false success: the durable command will be recovered by the worker.
  throw new LiekanError(
    '删除任务已接收，正在等待数据处理完成，请稍后重试',
    503,
    'warehouse-deletion-pending',
  );
}

export async function recoverWarehouseDeletions(runtime: WarehouseRuntime) {
  const deletions = new WarehouseDeletions(runtime);
  const pending = await runtime.db.read<{
    operation_id: string;
  }>(`SELECT operation_id FROM liekan_warehouse_deletion
    WHERE status NOT IN('active','reclaimed') AND (owner_id IS NULL OR lease_until<=clock_timestamp()) ORDER BY created_at LIMIT 10`);
  for (const row of pending) {
    try {
      const op = await deletions.advance(row.operation_id, warehouseLifecycleFinalizer);
      invalidateWebsiteAnalytics(op.website_id);
    } catch (error) {
      if (!(error instanceof WarehouseConflict)) throw error;
      if (
        ![
          'warehouse-deletion-owned',
          'warehouse-deletion-awaiting-publication',
          'warehouse-control-busy',
        ].includes(error.code)
      )
        throw error;
    }
  }
}
