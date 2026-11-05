import { randomUUID } from 'node:crypto';
import { type ControlDatabase, type ControlSQL, WarehouseConflict } from './control-db';
import type { WarehouseQueue } from './transport';

type Barrier = {
  operation_id: string;
  kind: 'snapshot' | 'cutover' | 'rollback';
  authority: 'postgres' | 'clickhouse';
  installation_revision: string;
  topic_id: string;
  boundary: { partition: number; offset: string }[];
  status: string;
  result_sequence: string | null;
  frozen_revision: string | null;
  completed_revision: string | null;
};
type Installation = {
  authority: string;
  revision: string;
  topic_id: string;
  partition_count: number;
  facts_fenced: boolean;
  identity_bound: boolean;
};

export class TransitionCoordinator {
  constructor(
    private readonly db: ControlDatabase,
    private readonly queue: WarehouseQueue,
  ) {}
  private async installation(tx: ControlSQL) {
    const [row] = (
      await tx.query<Installation>(
        'SELECT * FROM liekan_warehouse_installation WHERE id=1 FOR UPDATE',
      )
    ).rows;
    if (
      !row ||
      !row.facts_fenced ||
      row.topic_id !== this.queue.installation.topicId ||
      row.partition_count !== this.queue.installation.partitions
    )
      throw new WarehouseConflict('warehouse-transition-installation-unready');
    return row;
  }
  private async barrier(tx: ControlSQL, id: string) {
    const [row] = (
      await tx.query<Barrier>(
        'SELECT * FROM liekan_warehouse_barrier WHERE operation_id=$1 FOR UPDATE',
        [id],
      )
    ).rows;
    if (!row) throw new WarehouseConflict('warehouse-transition-barrier-missing');
    return row;
  }
  async request(kind: Barrier['kind'], id: string = randomUUID()) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new Error('warehouse-transition-invalid-operation');
    if (!['snapshot', 'cutover', 'rollback'].includes(kind))
      throw new Error('warehouse-transition-invalid-action');
    await this.queue.assertIdentity();
    // Kafka may return complete partition metadata in broker response order.
    // Canonicalize without changing the offsets or the queue-owned array; the
    // checks below still reject missing, duplicate and invalid partitions.
    const boundary = [...(await this.queue.highWatermarks())].sort(
      (a, b) => a.partition - b.partition,
    );
    if (
      boundary.length !== this.queue.installation.partitions ||
      boundary.some((b, i) => b.partition !== i || !/^\d+$/.test(b.offset))
    )
      throw new Error('warehouse-transition-invalid-boundary');
    return this.db.transaction(async tx => {
      const installation = await this.installation(tx),
        authority = kind === 'rollback' ? 'clickhouse' : 'postgres';
      const [prior] = (
        await tx.query<Barrier>('SELECT * FROM liekan_warehouse_barrier WHERE operation_id=$1', [
          id,
        ])
      ).rows;
      if (prior) {
        if (prior.kind !== kind)
          throw new WarehouseConflict('warehouse-transition-barrier-conflict');
        return prior;
      }
      if (installation.authority !== authority)
        throw new WarehouseConflict('warehouse-transition-wrong-authority');
      if (
        (
          await tx.query(
            "SELECT 1 FROM liekan_warehouse_barrier WHERE status IN('draining','frozen')",
          )
        ).rowCount
      )
        throw new WarehouseConflict('warehouse-transition-barrier-active');
      const [capture] = (
        await tx.query<{ state: string }>(
          'SELECT state FROM liekan_warehouse_transition WHERE id=1 FOR UPDATE',
        )
      ).rows;
      if (capture?.state !== 'capturing')
        throw new WarehouseConflict('warehouse-transition-not-capturing');
      // Task registration holds the installation's shared lock until commit,
      // then delivers its durable outbox. The exclusive lock held here sees
      // every earlier registration and fences later ones behind this barrier.
      // A pending task may not have a queue position yet: fixing H now could
      // exclude its recovery delivery while freeze() waits for that same task.
      if (
        (
          await tx.query(
            "SELECT 1 FROM liekan_warehouse_task WHERE status IN('pending','confirmed') LIMIT 1",
          )
        ).rowCount
      )
        throw new WarehouseConflict('warehouse-transition-control-not-drained');
      return (
        await tx.query<Barrier>(
          `INSERT INTO liekan_warehouse_barrier(operation_id,kind,authority,installation_revision,topic_id,boundary,status)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,'draining') RETURNING *`,
          [
            id,
            kind,
            authority,
            installation.revision,
            installation.topic_id,
            JSON.stringify(boundary),
          ],
        )
      ).rows[0];
    });
  }
  async freeze(id: string) {
    await this.queue.assertIdentity();
    return this.db.transaction(async tx => {
      const installation = await this.installation(tx),
        barrier = await this.barrier(tx, id);
      if (barrier.status === 'frozen' || barrier.status === 'completed') return barrier;
      if (
        barrier.status !== 'draining' ||
        installation.authority !== barrier.authority ||
        installation.revision !== barrier.installation_revision
      )
        throw new WarehouseConflict('warehouse-transition-barrier-fenced');
      const partitions = (
        await tx.query<{ partition: number; safe_offset: string }>(
          'SELECT partition,safe_offset FROM liekan_warehouse_partition WHERE topic_id=$1 ORDER BY partition FOR UPDATE',
          [barrier.topic_id],
        )
      ).rows;
      if (
        partitions.length !== barrier.boundary.length ||
        barrier.boundary.some(
          b =>
            !partitions.some(
              p => p.partition === b.partition && BigInt(p.safe_offset) >= BigInt(b.offset) - 1n,
            ),
        )
      )
        throw new WarehouseConflict('warehouse-transition-input-not-drained');
      if (
        (
          await tx.query(
            `SELECT 1 FROM liekan_warehouse_attempt WHERE status='intent'
        OR(status='confirmed' AND ($1='clickhouse' OR NOT decision_projected)) LIMIT 1`,
            [barrier.authority],
          )
        ).rowCount
      )
        throw new WarehouseConflict('warehouse-transition-decisions-not-drained');
      if (
        (
          await tx.query(
            "SELECT 1 FROM liekan_warehouse_deletion WHERE status NOT IN('active','reclaimed') UNION ALL SELECT 1 FROM liekan_warehouse_task WHERE status IN('pending','confirmed') LIMIT 1",
          )
        ).rowCount
      )
        throw new WarehouseConflict('warehouse-transition-control-not-drained');
      const [capture] = (
        await tx.query<{ sequence: string; state: string }>(
          'SELECT sequence,state FROM liekan_warehouse_transition WHERE id=1 FOR UPDATE',
        )
      ).rows;
      if (capture?.state !== 'capturing')
        throw new WarehouseConflict('warehouse-transition-not-capturing');
      const [{ revision }] = (
        await tx.query<{ revision: string }>(
          "UPDATE liekan_warehouse_installation SET authority='frozen',revision=revision+1,updated_at=clock_timestamp() WHERE id=1 RETURNING revision",
        )
      ).rows;
      await tx.query(
        "UPDATE liekan_warehouse_transition SET state='frozen',updated_at=clock_timestamp() WHERE id=1",
      );
      return (
        await tx.query<Barrier>(
          "UPDATE liekan_warehouse_barrier SET status='frozen',result_sequence=$2,frozen_revision=$3,updated_at=clock_timestamp() WHERE operation_id=$1 RETURNING *",
          [id, capture.sequence, revision],
        )
      ).rows[0];
    });
  }
  async resumeSnapshot(id: string) {
    return this.complete(id, 'snapshot');
  }
  async switch(id: string) {
    return this.complete(id, 'switch');
  }
  private async complete(id: string, mode: 'snapshot' | 'switch') {
    await this.queue.assertIdentity();
    return this.db.transaction(async tx => {
      const installation = await this.installation(tx),
        barrier = await this.barrier(tx, id);
      if ((mode === 'snapshot') !== (barrier.kind === 'snapshot'))
        throw new WarehouseConflict('warehouse-transition-action-mismatch');
      if (barrier.status === 'completed') return barrier;
      if (
        barrier.status !== 'frozen' ||
        installation.authority !== 'frozen' ||
        installation.revision !== barrier.frozen_revision
      )
        throw new WarehouseConflict('warehouse-transition-barrier-fenced');
      const [capture] = (
        await tx.query<{
          state: string;
          sequence: string;
          sent_sequence: string;
          ch_sequence: string;
          pg_sequence: string;
          migration_id: string;
        }>('SELECT * FROM liekan_warehouse_transition WHERE id=1 FOR UPDATE')
      ).rows;
      if (capture?.state !== 'frozen' || capture.sequence !== barrier.result_sequence)
        throw new WarehouseConflict('warehouse-transition-control-boundary-changed');
      if (
        mode === 'snapshot' &&
        installation.identity_bound &&
        !(
          await tx.query(
            "SELECT 1 FROM liekan_warehouse_migration_business_control WHERE operation_id=$1 AND status='ready'",
            [id],
          )
        ).rowCount
      )
        throw new WarehouseConflict('warehouse-migration-controls-not-ready');
      if (mode === 'switch') {
        const verified = await tx.query(
          `SELECT 1 FROM liekan_warehouse_transition_baseline b JOIN liekan_warehouse_migration m USING(migration_id)
          WHERE b.id=1 AND b.status='ready' AND b.migration_id=$1 AND b.verified_digest=m.verified_digest AND m.phase IN('verify','shadow','cutover','rollback')`,
          [capture.migration_id],
        );
        if (!verified.rowCount)
          throw new WarehouseConflict('warehouse-transition-source-not-verified');
        if (
          [capture.sent_sequence, capture.ch_sequence, capture.pg_sequence].some(
            s => s !== barrier.result_sequence,
          )
        )
          throw new WarehouseConflict('warehouse-transition-results-not-drained');
        if (
          (
            await tx.query(
              "SELECT 1 FROM liekan_warehouse_publication WHERE status='reserved' UNION ALL SELECT 1 FROM liekan_warehouse_attempt WHERE status='confirmed' LIMIT 1",
            )
          ).rowCount
        )
          throw new WarehouseConflict('warehouse-transition-unpublished-results');
      }
      const authority = barrier.kind === 'cutover' ? 'clickhouse' : 'postgres';
      const [{ revision }] = (
        await tx.query<{ revision: string }>(
          `UPDATE liekan_warehouse_installation SET authority=$1,transition=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=1 RETURNING revision`,
          [authority, authority === 'clickhouse' ? 'rollback' : 'shadow'],
        )
      ).rows;
      await tx.query(
        "UPDATE liekan_warehouse_transition SET state='capturing',updated_at=clock_timestamp() WHERE id=1",
      );
      if (mode === 'switch')
        await tx.query(
          'UPDATE liekan_warehouse_migration SET phase=$2,revision=revision+1,updated_at=clock_timestamp() WHERE migration_id=$1',
          [capture.migration_id, barrier.kind],
        );
      return (
        await tx.query<Barrier>(
          "UPDATE liekan_warehouse_barrier SET status='completed',completed_revision=$2,updated_at=clock_timestamp() WHERE operation_id=$1 RETURNING *",
          [id, revision],
        )
      ).rows[0];
    });
  }
  async cancel(id: string) {
    return this.db.transaction(async tx => {
      const installation = await this.installation(tx),
        barrier = await this.barrier(tx, id);
      if (barrier.status === 'cancelled') return;
      if (
        barrier.status !== 'draining' ||
        installation.authority !== barrier.authority ||
        installation.revision !== barrier.installation_revision
      )
        throw new WarehouseConflict('warehouse-transition-cannot-cancel-frozen');
      await tx.query(
        "UPDATE liekan_warehouse_barrier SET status='cancelled',updated_at=clock_timestamp() WHERE operation_id=$1",
        [id],
      );
    });
  }
}
