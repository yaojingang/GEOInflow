import { emptyCounts, hash, workingStatuses } from '../history-repair/model';
import { WarehouseConflict } from '../warehouse/control-db';
import { type WarehouseRuntime, warehouseRuntime } from '../warehouse/runtime';
import { prepareWarehouseTask, waitWarehouseTask } from '../warehouse/tasks';
import {
  assertSnapshot,
  enqueueRepair,
  type RunRow,
  repairTransaction,
  runForSite,
} from './history-repair-db';
import { LiekanError, lockWritableWebsite } from './server';
import { authorizeWarehouseTask, warehouseControlAdapter } from './warehouse-authority';
import { planWarehouseRepairBatch } from './warehouse-history-repair-plan';
import { warehouseRepairSourceCounts } from './warehouse-history-repair-read';
import { warehouseReportMetadata } from './warehouse-report-snapshot';

async function requireLease(tx: any, acquired: RunRow) {
  await lockWritableWebsite(tx, acquired.website_id, { userId: acquired.actor_id }, 'share');
  const row = await runForSite(tx, acquired.website_id, false);
  if (
    !row ||
    row.lease_token !== acquired.lease_token ||
    !row.lease_until ||
    +row.lease_until < Date.now() ||
    row.generation !== acquired.generation ||
    row.revision !== acquired.revision ||
    !['scanning', 'preparing'].includes(row.status)
  )
    throw new LiekanError('工作租约已失效', 409, 'history-repair-lease-lost');
  await assertSnapshot(tx, row, false);
  return row;
}
async function boundary(acquired: RunRow, runtime: WarehouseRuntime) {
  const prepared = await repairTransaction(async tx => {
    const row = await requireLease(tx, acquired);
    const batches = await tx.$queryRawUnsafe<{ id: string; state: string }[]>(
      'SELECT id::text,state FROM liekan_ingest_batch WHERE website_id=$1::uuid AND repair_scope_id IS NULL ORDER BY id',
      row.website_id,
    );
    const freeze = row.snapshot.warehouseFreeze;
    if (!freeze)
      throw new LiekanError(
        '请重新生成 CH 冻结范围',
        409,
        'history-repair-source-boundary-required',
      );
    const waiting = await tx.$queryRawUnsafe(
      `SELECT 1 FROM liekan_warehouse_attempt WHERE website_id=$1::uuid AND epoch=$2::bigint AND version<=$3::bigint AND status='confirmed' LIMIT 1`,
      row.website_id,
      freeze.epoch,
      freeze.version,
    );
    if (batches.some(b => b.state === 'pending') || waiting.length) {
      await tx.$executeRawUnsafe(
        "UPDATE liekan_history_repair_run SET error_code='waiting-old-batches' WHERE id=$1::uuid",
        row.id,
      );
      await enqueueRepair(tx, row, 5);
      return null;
    }
    return {
      row,
      excluded: batches.filter(b => ['failed', 'cancelled'].includes(b.state)).map(b => b.id),
    };
  });
  if (!prepared) return;
  const source = (await warehouseReportMetadata(acquired.website_id)).boundary;
  if (
    source.epoch !== prepared.row.snapshot.warehouseFreeze.epoch ||
    source.deletionRevision !== prepared.row.snapshot.warehouseFreeze.deletionRevision
  )
    throw new LiekanError(
      '冻结后的历史输入发生变化，请重新预览',
      409,
      'history-repair-scope-changed',
    );
  prepared.row.snapshot.warehouseSource = source;
  const counts = await warehouseRepairSourceCounts(prepared.row);
  await runtime.db.transaction(async tx => {
    const [state] = (
      await tx.query<{ epoch: string; deletion_revision: string }>(
        'SELECT epoch,deletion_revision FROM liekan_warehouse_site WHERE website_id=$1 FOR UPDATE',
        [acquired.website_id],
      )
    ).rows;
    if (state?.epoch !== source.epoch || state.deletion_revision !== source.deletionRevision)
      throw new WarehouseConflict('warehouse-repair-source-changed');
    const sql = warehouseControlAdapter(tx),
      current = await requireLease(sql, acquired);
    if (current.scope_revision.toString() !== prepared.row.scope_revision.toString())
      throw new WarehouseConflict('warehouse-repair-scope-changed');
    const updated = await tx.query(
      `UPDATE liekan_history_repair_run SET snapshot=$2::jsonb,counts=$3::jsonb,excluded_batches=$4::uuid[],scope_finalized=true,
      phase='events',status='preparing',cursor=$5::jsonb,error_code=NULL,updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
      WHERE id=$1 AND lease_token=$6 AND phase='boundary'`,
      [
        current.id,
        JSON.stringify(prepared.row.snapshot),
        JSON.stringify({
          ...emptyCounts(),
          events: counts.events,
          logs: counts.logs,
          missingQuality: counts.missing,
        }),
        prepared.excluded,
        JSON.stringify({ membership: hash([current.repair_scope_id, prepared.excluded, counts]) }),
        acquired.lease_token,
      ],
    );
    if (updated.rowCount !== 1) throw new WarehouseConflict('warehouse-repair-control-changed');
    await enqueueRepair(sql as any, current);
  });
}

export async function processWarehouseHistoryRepairUnit(
  acquired: RunRow,
  supplied?: WarehouseRuntime,
) {
  const runtime = supplied ?? (await warehouseRuntime());
  if (acquired.phase === 'boundary') return boundary(acquired, runtime);
  const row = await repairTransaction(tx => requireLease(tx, acquired));
  const planned = await planWarehouseRepairBatch(row),
    site = await runtime.resource(row.website_id, 'website');
  const source = row.snapshot.warehouseSource;
  if (!source || source.epoch !== site.epoch || source.deletionRevision !== site.deletion_revision)
    throw new LiekanError(
      '冻结后的历史输入发生变化，请重新预览',
      409,
      'history-repair-scope-changed',
    );
  const task = await prepareWarehouseTask(
    runtime,
    site,
    planned.result,
    planned.facts,
    async tx => {
      await requireLease(warehouseControlAdapter(tx), acquired);
      if (!(await authorizeWarehouseTask(tx, row.website_id, planned.result)))
        throw new WarehouseConflict('warehouse-repair-authority-changed');
    },
  );
  try {
    await waitWarehouseTask(runtime.db, task);
  } catch (error) {
    if (error instanceof WarehouseConflict && error.code === 'warehouse-task-publication-pending')
      return;
    throw error;
  }
  await repairTransaction(async tx => {
    const next = await runForSite(tx, row.website_id);
    if (next && workingStatuses.includes(next.status)) await enqueueRepair(tx, next);
  });
}
