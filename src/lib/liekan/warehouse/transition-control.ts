import type { ClickHouseClient } from '@clickhouse/client';
import { type ControlDatabase, type ControlSQL, WarehouseConflict } from './control-db';
import { deletionMarker, projectDeletionMarker } from './deletion-marker';
import type { DeletionOperation } from './deletions';
import { purgePostgresFacts } from './postgres-deletion';
import type { ApplyControlResult, TransitionTarget } from './transition-apply';
import type { TransitionResult } from './transition-capture';

export function deletionResult(op: DeletionOperation): TransitionResult {
  return {
    format: 'authority-result-v1',
    authority: op.authority,
    operationId: op.operation_id,
    websiteId: op.website_id,
    epoch: op.epoch,
    siteVersion: op.version,
    kind: op.kind,
    result: { marker: deletionMarker(op) },
  };
}
export class TransitionControls implements ApplyControlResult {
  constructor(
    private readonly db: ControlDatabase,
    private readonly ch: ClickHouseClient,
  ) {}
  private async operation(tx: ControlSQL, result: TransitionResult) {
    const [op] = (
      await tx.query<DeletionOperation>(
        'SELECT * FROM liekan_warehouse_deletion WHERE operation_id=$1',
        [result.operationId],
      )
    ).rows;
    if (
      !op ||
      !['active', 'reclaimed'].includes(op.status) ||
      JSON.stringify(deletionResult(op)) !== JSON.stringify(result)
    )
      throw new WarehouseConflict('warehouse-transition-control-mismatch');
    return op;
  }
  async project(result: TransitionResult, target: TransitionTarget) {
    const op = await this.db.transaction(tx => this.operation(tx, result));
    if (target === 'clickhouse') await projectDeletionMarker(this.ch, op);
    else if (result.authority === 'clickhouse') {
      await purgePostgresFacts(this.db, op, async tx => {
        await tx.query('SELECT id FROM liekan_warehouse_installation WHERE id=1 FOR SHARE');
        const [state] = (
          await tx.query<{ state: string; pg_sequence: string }>(
            'SELECT state,pg_sequence FROM liekan_warehouse_transition WHERE id=1 FOR UPDATE',
          )
        ).rows;
        const [row] = (
          await tx.query<{ sequence: string }>(
            'SELECT sequence FROM liekan_warehouse_transition_result WHERE operation_id=$1',
            [result.operationId],
          )
        ).rows;
        if (!state || !row || state.state === 'closed')
          throw new WarehouseConflict('warehouse-transition-closed');
        if (BigInt(state.pg_sequence) >= BigInt(row.sequence)) return false;
        if (BigInt(state.pg_sequence) + 1n !== BigInt(row.sequence))
          throw new WarehouseConflict('warehouse-transition-apply-sequence-gap');
        await this.operation(tx, result);
        return true;
      });
    }
  }
  async apply(tx: ControlSQL, result: TransitionResult, _target: TransitionTarget) {
    await this.operation(tx, result);
  }
}
