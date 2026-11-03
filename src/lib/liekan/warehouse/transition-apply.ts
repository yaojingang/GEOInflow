import type { ClickHouseClient } from '@clickhouse/client';
import type { Attempt } from './control';
import { type ControlDatabase, type ControlSQL, WarehouseConflict } from './control-db';
import { WarehouseDeriver } from './derivation';
import { LandingStore, type LandedDecision } from './landing';
import { applyPostgresFacts } from './postgres-facts';
import {
  decodeAuthoritativeResult,
  type CapturedResult,
  type TransitionResult,
} from './transition-capture';
import type { TransitionStream } from './transition-stream';
import { TransitionControls } from './transition-control';

export type TransitionTarget = 'postgres' | 'clickhouse';
export type ApplyControlResult = {
  project: (result: TransitionResult, target: TransitionTarget) => Promise<void>;
  apply: (tx: ControlSQL, result: TransitionResult, target: TransitionTarget) => Promise<void>;
};

export class TransitionApplier {
  private readonly applyControl: ApplyControlResult;
  constructor(
    private readonly db: ControlDatabase,
    private readonly ch: ClickHouseClient,
    private readonly stream: TransitionStream,
    applyControl?: ApplyControlResult,
  ) {
    this.applyControl = applyControl ?? new TransitionControls(db, ch);
  }

  private async requireAttempt(row: CapturedResult) {
    const [attempt] = await this.db.read<Attempt>(
      'SELECT * FROM liekan_warehouse_attempt WHERE attempt_id=$1',
      [row.operation_id],
    );
    if (
      !attempt ||
      !['confirmed', 'projected'].includes(attempt.status) ||
      attempt.website_id !== row.website_id ||
      attempt.epoch !== row.epoch ||
      attempt.version !== row.site_version
    )
      throw new WarehouseConflict('warehouse-transition-acceptance-missing');
    return attempt;
  }
  private async existing(target: TransitionTarget, row: CapturedResult) {
    const [value] = await this.db.read<{ operation_id: string; digest: string }>(
      'SELECT operation_id,digest FROM liekan_warehouse_transition_applied WHERE target=$1 AND sequence=$2',
      [target, row.sequence],
    );
    if (value && (value.operation_id !== row.operation_id || value.digest !== row.digest))
      throw new WarehouseConflict('warehouse-transition-applied-conflict');
    return !!value;
  }
  async apply(target: TransitionTarget, row: CapturedResult) {
    const result = decodeAuthoritativeResult(row);
    if (await this.existing(target, row)) return;
    const [before] = await this.db.read<{
      state: string;
      ch_sequence: string;
      pg_sequence: string;
    }>('SELECT state,ch_sequence,pg_sequence FROM liekan_warehouse_transition WHERE id=1');
    if (!before || before.state === 'closed')
      throw new WarehouseConflict('warehouse-transition-closed');
    if (
      BigInt(before[target === 'postgres' ? 'pg_sequence' : 'ch_sequence']) + 1n !==
      BigInt(row.sequence)
    )
      throw new WarehouseConflict('warehouse-transition-apply-sequence-gap');
    const data =
      result.kind === 'decision'
        ? (result.result as { attempt: Attempt; decisions: LandedDecision[] })
        : null;
    if (data) {
      const accepted = await this.requireAttempt(row);
      if (
        accepted.input_digest !== data.attempt.input_digest ||
        accepted.input_count !== data.attempt.input_count
      )
        throw new WarehouseConflict('warehouse-transition-input-conflict');
      if (target === 'clickhouse') {
        // A shadow applies the sealed authority outcome. It never invokes the
        // browser/log planner against newer policy, receipts or deletion state.
        const landing = new LandingStore(this.ch);
        await landing.stage(accepted, data.decisions);
        await landing.projectDecision(accepted);
        await new WarehouseDeriver(this.db, this.ch).derive(accepted.attempt_id);
      }
    } else {
      if (!this.applyControl)
        throw new WarehouseConflict('warehouse-transition-control-applier-required');
      await this.applyControl.project(result, target);
    }
    return this.db.transaction(async tx => {
      await tx.query('SELECT id FROM liekan_warehouse_installation WHERE id=1 FOR SHARE');
      const [state] = (
        await tx.query<{ state: string; ch_sequence: string; pg_sequence: string }>(
          'SELECT state,ch_sequence,pg_sequence FROM liekan_warehouse_transition WHERE id=1 FOR UPDATE',
        )
      ).rows;
      if (!state || state.state === 'closed')
        throw new WarehouseConflict('warehouse-transition-closed');
      const prior = (
        await tx.query<{ operation_id: string; digest: string }>(
          'SELECT operation_id,digest FROM liekan_warehouse_transition_applied WHERE target=$1 AND sequence=$2',
          [target, row.sequence],
        )
      ).rows[0];
      if (prior) {
        if (prior.operation_id !== row.operation_id || prior.digest !== row.digest)
          throw new WarehouseConflict('warehouse-transition-applied-conflict');
        return;
      }
      const column = target === 'postgres' ? 'pg_sequence' : 'ch_sequence';
      if (BigInt(row.sequence) !== BigInt(state[column]) + 1n)
        throw new WarehouseConflict('warehouse-transition-apply-sequence-gap');
      if (data) {
        if (target === 'postgres' && result.authority !== 'postgres')
          await applyPostgresFacts(tx, result.websiteId, data.decisions, 'replica');
        if (target === 'clickhouse') {
          const [accepted] = (
            await tx.query<Attempt>(
              'SELECT * FROM liekan_warehouse_attempt WHERE attempt_id=$1 FOR SHARE',
              [row.operation_id],
            )
          ).rows;
          if (accepted?.status !== 'projected')
            throw new WarehouseConflict('warehouse-transition-publication-incomplete');
          await tx.query(
            'UPDATE liekan_warehouse_attempt SET decision_projected=true WHERE attempt_id=$1',
            [row.operation_id],
          );
          await tx.query(
            "UPDATE liekan_warehouse_work SET status='confirmed',updated_at=clock_timestamp() WHERE attempt_id=$1 AND status='working'",
            [row.operation_id],
          );
        }
      } else await this.applyControl.apply(tx, result, target);
      await tx.query(
        'INSERT INTO liekan_warehouse_transition_applied(target,sequence,operation_id,digest) VALUES($1,$2,$3,$4)',
        [target, row.sequence, row.operation_id, row.digest],
      );
      await tx.query(
        `UPDATE liekan_warehouse_transition SET ${column}=$1,updated_at=clock_timestamp() WHERE id=1`,
        [row.sequence],
      );
    });
  }
  async drain(target: TransitionTarget, limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('warehouse-transition-apply-limit-invalid');
    let applied = 0;
    for (; applied < limit; applied++) {
      const [state] = await this.db.read<{
        sent_sequence: string;
        ch_sequence: string;
        pg_sequence: string;
        state: string;
      }>(
        'SELECT state,sent_sequence,ch_sequence,pg_sequence FROM liekan_warehouse_transition WHERE id=1',
      );
      if (!state || state.state === 'closed') break;
      const current = target === 'postgres' ? state.pg_sequence : state.ch_sequence;
      if (BigInt(current) >= BigInt(state.sent_sequence)) break;
      await this.apply(target, await this.stream.read(String(BigInt(current) + 1n)));
    }
    return applied;
  }
}
