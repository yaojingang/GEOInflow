import { createHash, randomUUID } from 'node:crypto';
import { canonicalWireRow } from './candidate';
import type { Attempt } from './control';
import { type ControlDatabase, type ControlSQL, WarehouseConflict } from './control-db';
import { inputDigest, type LandedDecision } from './landing';

export type TransitionResult = {
  format: 'authority-result-v1';
  authority: 'postgres' | 'clickhouse';
  operationId: string;
  websiteId: string;
  epoch: string;
  siteVersion: string;
  kind: 'decision' | 'session' | 'reset' | 'website';
  result: unknown;
};
export type CapturedResult = {
  sequence: string;
  operation_id: string;
  authority: string;
  website_id: string;
  epoch: string;
  site_version: string;
  kind: string;
  payload: string;
  digest: string;
};
type Transition = {
  state: string;
  sequence: string;
  sent_sequence: string;
  ch_sequence: string;
  pg_sequence: string;
  generation: string;
  terminal_sequence: string | null;
};

export function decisionResult(
  authority: TransitionResult['authority'],
  attempt: Attempt,
  decisions: LandedDecision[],
): TransitionResult {
  if (
    !attempt.version ||
    !['confirmed', 'projected'].includes(attempt.status) ||
    inputDigest(decisions.map(d => d.input)) !== attempt.input_digest ||
    decisions.length !== attempt.input_count
  )
    throw new Error('warehouse-transition-unconfirmed-result');
  const payload = decisions.map(d => ({
    ...d,
    facts: d.facts.map(f => ({ ...f, row: canonicalWireRow(f.family, f.row) })),
  }));
  if (
    payload.some(
      d =>
        d.input.envelope.websiteId !== attempt.website_id ||
        d.input.partition !== attempt.partition ||
        d.input.envelope.topicId !== attempt.topic_id,
    )
  )
    throw new Error('warehouse-transition-result-boundary-mismatch');
  return {
    format: 'authority-result-v1',
    authority,
    operationId: attempt.attempt_id,
    websiteId: attempt.website_id,
    epoch: attempt.epoch,
    siteVersion: attempt.version,
    kind: 'decision',
    result: {
      attempt: {
        attempt_id: attempt.attempt_id,
        website_id: attempt.website_id,
        epoch: attempt.epoch,
        deletion_revision: attempt.deletion_revision,
        policy_revision: attempt.policy_revision,
        topic_id: attempt.topic_id,
        partition: attempt.partition,
        generation: attempt.generation,
        owner_id: attempt.owner_id,
        first_offset: attempt.first_offset,
        last_offset: attempt.last_offset,
        input_count: attempt.input_count,
        input_digest: attempt.input_digest,
        version: attempt.version,
        status: 'confirmed',
        decision_projected: false,
        effects: attempt.effects ?? [],
      },
      decisions: payload,
    },
  };
}

// Invoke inside the SAME transaction that confirms authoritative facts/decision.
// No query here reconstructs a result from mutable fact tables after commit.
export async function captureAuthoritativeResult(tx: ControlSQL, result: TransitionResult) {
  const [installation] = (
    await tx.query<{ authority: string }>(
      'SELECT authority FROM liekan_warehouse_installation WHERE id=1 FOR SHARE',
    )
  ).rows;
  const [transition] = (
    await tx.query<Transition>('SELECT * FROM liekan_warehouse_transition WHERE id=1 FOR UPDATE')
  ).rows;
  if (!transition || transition.state === 'closed' || transition.state === 'draining') return null;
  if (transition.state !== 'capturing') throw new WarehouseConflict('warehouse-transition-frozen');
  if (installation?.authority !== result.authority)
    throw new WarehouseConflict('warehouse-transition-wrong-authority');
  const payload = JSON.stringify(result),
    digest = createHash('sha256').update(payload).digest('hex');
  const [existing] = (
    await tx.query<CapturedResult>(
      'SELECT * FROM liekan_warehouse_transition_result WHERE operation_id=$1',
      [result.operationId],
    )
  ).rows;
  if (existing) {
    if (existing.digest !== digest)
      throw new WarehouseConflict('warehouse-transition-operation-conflict');
    return existing;
  }
  const sequence = (BigInt(transition.sequence) + 1n).toString();
  await tx.query(
    'UPDATE liekan_warehouse_transition SET sequence=$1,updated_at=clock_timestamp() WHERE id=1',
    [sequence],
  );
  return (
    await tx.query<CapturedResult>(
      `INSERT INTO liekan_warehouse_transition_result(sequence,operation_id,authority,website_id,epoch,site_version,kind,payload,digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        sequence,
        result.operationId,
        result.authority,
        result.websiteId,
        result.epoch,
        result.siteVersion,
        result.kind,
        payload,
        digest,
      ],
    )
  ).rows[0];
}

export function decodeAuthoritativeResult(row: CapturedResult): TransitionResult {
  if (createHash('sha256').update(row.payload).digest('hex') !== row.digest)
    throw new Error('warehouse-transition-payload-corrupt');
  const value = JSON.parse(row.payload) as TransitionResult;
  if (
    value.format !== 'authority-result-v1' ||
    value.operationId !== row.operation_id ||
    value.authority !== row.authority ||
    value.websiteId !== row.website_id ||
    value.epoch !== row.epoch ||
    value.siteVersion !== row.site_version ||
    value.kind !== row.kind
  )
    throw new Error('warehouse-transition-envelope-corrupt');
  if (value.kind === 'decision') {
    const data = value.result as { attempt: Attempt; decisions: LandedDecision[] };
    if (
      JSON.stringify(decisionResult(value.authority, data.attempt, data.decisions)) !== row.payload
    )
      throw new Error('warehouse-transition-decision-corrupt');
  }
  return value;
}

export class TransitionCapture {
  constructor(private readonly db: ControlDatabase) {}
  async start(topic: { name: string; id: string }, migrationId: string | null = null) {
    if (
      !/^[a-zA-Z0-9_.-]{1,249}$/.test(topic.name) ||
      !/^[0-9a-f]{32}$/.test(topic.id) ||
      topic.id === '0'.repeat(32)
    )
      throw new Error('warehouse-transition-invalid-topic');
    return this.db.transaction(async tx => {
      if (
        !(await tx.query('SELECT id FROM liekan_warehouse_installation WHERE id=1 FOR UPDATE'))
          .rowCount
      )
        throw new Error('warehouse-installation-unavailable');
      const prior = await tx.query('SELECT 1 FROM liekan_warehouse_transition WHERE id=1');
      if (prior.rowCount) throw new WarehouseConflict('warehouse-transition-already-created');
      return (
        await tx.query(
          `INSERT INTO liekan_warehouse_transition(id,transition_id,migration_id,state,topic_name,topic_id)
        VALUES(1,$1,$2,'capturing',$3,$4) RETURNING transition_id,generation`,
          [randomUUID(), migrationId, topic.name, topic.id],
        )
      ).rows[0];
    });
  }
  async pending(after: string, limit = 100) {
    if (!/^\d+$/.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('warehouse-transition-invalid-cursor');
    // Bound rows AND returned payload bytes. One accepted package may exceed the
    // target batch, but is never truncated or silently skipped.
    const rows = await this.db.read<CapturedResult>(
      `WITH sizes AS (
      SELECT sequence,sum(octet_length(payload)) OVER(ORDER BY sequence) AS bytes
      FROM (SELECT sequence,payload FROM liekan_warehouse_transition_result WHERE sequence>$1 ORDER BY sequence LIMIT $2)r)
      SELECT r.* FROM liekan_warehouse_transition_result r JOIN sizes s USING(sequence)
      WHERE s.bytes-octet_length(r.payload)<8388608 ORDER BY r.sequence`,
      [after, limit],
    );
    rows.forEach(decodeAuthoritativeResult);
    return rows;
  }
  async stopCapture() {
    return this.db.transaction(async tx => {
      // Installation first: all accepting transactions hold its shared lock.
      const [installation] = (
        await tx.query<{ authority: string }>(
          'SELECT authority FROM liekan_warehouse_installation WHERE id=1 FOR UPDATE',
        )
      ).rows;
      if (installation?.authority !== 'clickhouse')
        throw new WarehouseConflict('warehouse-transition-exit-requires-clickhouse');
      const [state] = (
        await tx.query<Transition>(
          'SELECT * FROM liekan_warehouse_transition WHERE id=1 FOR UPDATE',
        )
      ).rows;
      if (!state) throw new Error('warehouse-transition-missing');
      if (state.state === 'draining' || state.state === 'closed') return state.terminal_sequence;
      if (state.state !== 'capturing') throw new WarehouseConflict('warehouse-transition-frozen');
      await tx.query(
        "UPDATE liekan_warehouse_transition SET state='draining',terminal_sequence=sequence,generation=generation+1,owner_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=1",
      );
      return state.sequence;
    });
  }
  async close() {
    return this.db.transaction(async tx => {
      await tx.query('SELECT id FROM liekan_warehouse_installation WHERE id=1 FOR UPDATE');
      const [state] = (
        await tx.query<Transition>(
          'SELECT * FROM liekan_warehouse_transition WHERE id=1 FOR UPDATE',
        )
      ).rows;
      if (state?.state === 'closed') return;
      if (
        state?.state !== 'draining' ||
        state.sent_sequence !== state.terminal_sequence ||
        state.ch_sequence !== state.terminal_sequence ||
        state.pg_sequence !== state.terminal_sequence
      )
        throw new WarehouseConflict('warehouse-transition-not-drained');
      if (
        (
          await tx.query(
            "SELECT 1 FROM liekan_warehouse_deletion d JOIN liekan_warehouse_transition_result r ON r.operation_id=d.operation_id WHERE r.sequence<=$1 AND d.status NOT IN('active','reclaimed') LIMIT 1",
            [state.terminal_sequence],
          )
        ).rowCount
      )
        throw new WarehouseConflict('warehouse-transition-pending-control');
      if (
        (
          await tx.query(
            "SELECT 1 FROM liekan_warehouse_attempt a JOIN liekan_warehouse_transition_result r ON r.operation_id=a.attempt_id WHERE r.sequence<=$1 AND (a.status='confirmed' OR NOT a.decision_projected) LIMIT 1",
            [state.terminal_sequence],
          )
        ).rowCount ||
        (
          await tx.query(
            "SELECT 1 FROM liekan_warehouse_publication p CROSS JOIN LATERAL jsonb_array_elements(p.manifest) m JOIN liekan_warehouse_transition_result r ON r.operation_id=(m->>'attemptId')::uuid WHERE r.sequence<=$1 AND p.status='reserved' LIMIT 1",
            [state.terminal_sequence],
          )
        ).rowCount
      )
        throw new WarehouseConflict('warehouse-transition-unpublished-results');
      await tx.query(
        "UPDATE liekan_warehouse_transition SET state='closed',generation=generation+1,owner_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=1",
      );
      await tx.query(
        "UPDATE liekan_warehouse_installation SET transition='exited',revision=revision+1,updated_at=clock_timestamp() WHERE id=1",
      );
      await tx.query(
        "UPDATE liekan_warehouse_migration SET phase='exited',revision=revision+1,updated_at=clock_timestamp() WHERE migration_id=(SELECT migration_id FROM liekan_warehouse_transition WHERE id=1)",
      );
    });
  }
}
