import { randomUUID } from 'node:crypto';
import { type ControlSQL, WarehouseConflict } from './control-db';
import { projectDeletionMarker } from './deletion-marker';
import { purgePostgresFacts } from './postgres-deletion';
import { captureAuthoritativeResult } from './transition-capture';
import { deletionResult } from './transition-control';
import { canonicalUUID } from './routing';
import type { WarehouseRuntime } from './runtime';

export type DeletionOperation = {
  operation_id: string;
  website_id: string;
  session_id: string | null;
  kind: 'session' | 'reset' | 'website';
  actor_id: string | null;
  epoch: string;
  revision: string;
  version: string;
  topic_id: string;
  boundary: { partition: number; offset: string }[] | null;
  status: string;
  owner_id: string | null;
  generation: string;
  created_at: Date;
  authority: 'postgres' | 'clickhouse';
};
export type DeletionHooks = {
  authorize: (tx: ControlSQL) => Promise<void>;
};
export type DeletionFinalizer = {
  // Same business-resource -> warehouse-resource lock order as collection confirmation.
  lock: (tx: ControlSQL, operation: DeletionOperation) => Promise<void>;
  apply: (tx: ControlSQL, operation: DeletionOperation) => Promise<void>;
};
export class WarehouseDeletions {
  constructor(private readonly runtime: WarehouseRuntime) {}
  async begin(
    site: string,
    kind: DeletionOperation['kind'],
    session: string | null,
    actor: string | null,
    hooks: DeletionHooks,
    id = randomUUID(),
  ) {
    if (
      [site, id, ...(session ? [session] : []), ...(actor ? [actor] : [])].some(
        v => canonicalUUID(v) !== v,
      ) ||
      (kind === 'session') !== !!session ||
      !['session', 'reset', 'website'].includes(kind)
    )
      throw new Error('warehouse-invalid-deletion');
    await this.runtime.queue.assertIdentity();
    return this.runtime.db.transaction(async tx => {
      await hooks.authorize(tx);
      const [installation] = (
        await tx.query<{ authority: string; topic_id: string }>(
          'SELECT authority,topic_id FROM liekan_warehouse_installation WHERE id=1 FOR SHARE',
        )
      ).rows;
      if (
        !installation ||
        !['postgres', 'clickhouse'].includes(installation.authority) ||
        installation.topic_id !== this.runtime.queue.installation.topicId
      )
        throw new WarehouseConflict('warehouse-deletion-authority-frozen');
      const [state] = (
        await tx.query<{
          epoch: string;
          version: string;
          deletion_revision: string;
          state: string;
        }>('SELECT * FROM liekan_warehouse_site WHERE website_id=$1 FOR UPDATE', [site])
      ).rows;
      const [old] = (
        await tx.query<DeletionOperation>(
          'SELECT * FROM liekan_warehouse_deletion WHERE operation_id=$1',
          [id],
        )
      ).rows;
      if (old) {
        if (
          old.website_id !== site ||
          old.kind !== kind ||
          old.session_id !== session ||
          old.actor_id !== actor
        )
          throw new WarehouseConflict('warehouse-deletion-id-conflict');
        return old;
      }
      if((await tx.query("SELECT 1 FROM liekan_warehouse_barrier WHERE status IN('draining','frozen') LIMIT 1")).rowCount)
        throw new WarehouseConflict('warehouse-transition-control-frozen');
      if (state?.state !== 'active') throw new WarehouseConflict('warehouse-resource-unavailable');
      const [pending] = (
        await tx.query<DeletionOperation>(
          "SELECT * FROM liekan_warehouse_deletion WHERE website_id=$1 AND status NOT IN('active','reclaimed')",
          [site],
        )
      ).rows;
      if (pending) {
        if (pending.kind === kind && pending.session_id === session) return pending;
        throw new WarehouseConflict('warehouse-delete-pending');
      }
      const version = (BigInt(state.version) + 1n).toString(),
        revision = (BigInt(state.deletion_revision) + 1n).toString();
      await tx.query(
        'UPDATE liekan_warehouse_site SET version=$2,updated_at=clock_timestamp() WHERE website_id=$1',
        [site, version],
      );
      // The active deletion pointer does not move until the CH marker and PG
      // lifecycle changes can be published together. Pending rows fence intake.
      return (
        await tx.query<DeletionOperation>(
          `INSERT INTO liekan_warehouse_deletion(operation_id,website_id,session_id,kind,actor_id,epoch,revision,version,topic_id,status,authority)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10) RETURNING *`,
          [
            id,
            site,
            session,
            kind,
            actor,
            state.epoch,
            revision,
            version,
            installation.topic_id,
            installation.authority,
          ],
        )
      ).rows[0];
    });
  }
  async advance(id: string, finalizer: DeletionFinalizer) {
    const owner = randomUUID();
    const [before] = await this.runtime.db.read<DeletionOperation>(
      'SELECT * FROM liekan_warehouse_deletion WHERE operation_id=$1',
      [id],
    );
    if (!before) throw new WarehouseConflict('warehouse-deletion-missing');
    if (['active', 'reclaimed'].includes(before.status)) return before;
    await this.runtime.queue.assertIdentity();
    if (before.topic_id !== this.runtime.queue.installation.topicId)
      throw new WarehouseConflict('warehouse-topic-identity-changed');
    const operation = await this.runtime.db.transaction(async tx => {
      const [op] = (
        await tx.query<DeletionOperation>(
          `UPDATE liekan_warehouse_deletion SET owner_id=$2,generation=generation+1,
        lease_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
        WHERE operation_id=$1 AND status NOT IN('active','reclaimed') AND (owner_id IS NULL OR lease_until<=clock_timestamp()) RETURNING *`,
          [id, owner],
        )
      ).rows;
      return op;
    });
    if (!operation) throw new WarehouseConflict('warehouse-deletion-owned');
    const guarded = async (tx: ControlSQL) => {
      const [op] = (
        await tx.query<DeletionOperation>(
          `SELECT * FROM liekan_warehouse_deletion WHERE operation_id=$1 AND owner_id=$2 AND generation=$3
        AND lease_until>clock_timestamp() FOR UPDATE`,
          [id, owner, operation.generation],
        )
      ).rows;
      if (!op) throw new WarehouseConflict('warehouse-deletion-owner-fenced');
      return op;
    };
    try {
      let op = operation;
      if (!op.boundary) {
        const boundary = await this.runtime.queue.highWatermarks();
        if (
          boundary.length !== this.runtime.queue.installation.partitions ||
          new Set(boundary.map(b => b.partition)).size !== boundary.length ||
          boundary.some(
            b =>
              !Number.isSafeInteger(b.partition) ||
              b.partition < 0 ||
              b.partition >= boundary.length ||
              !/^\d+$/.test(b.offset),
          )
        )
          throw new Error('warehouse-invalid-deletion-boundary');
        op = await this.runtime.db.transaction(async tx => {
          const locked = await guarded(tx);
          if (locked.boundary) return locked;
          return (
            await tx.query<DeletionOperation>(
              "UPDATE liekan_warehouse_deletion SET boundary=$2::jsonb,status='boundary',updated_at=clock_timestamp() WHERE operation_id=$1 RETURNING *",
              [id, JSON.stringify(boundary.sort((a, b) => a.partition - b.partition))],
            )
          ).rows[0];
        });
      }
      if (op.authority === 'clickhouse') await projectDeletionMarker(this.runtime.ch, op);
      else
        await purgePostgresFacts(this.runtime.db, op, async tx => {
          const [installation] = (
            await tx.query<{ authority: string }>(
              'SELECT authority FROM liekan_warehouse_installation WHERE id=1 FOR SHARE',
            )
          ).rows;
          if (installation?.authority !== 'postgres')
            throw new WarehouseConflict('warehouse-deletion-authority-frozen');
          await guarded(tx);
          await tx.query(
            "UPDATE liekan_warehouse_deletion SET lease_until=clock_timestamp()+interval '60 seconds' WHERE operation_id=$1",
            [id],
          );
          return true;
        });
      return await this.runtime.db.transaction(async tx => {
        await finalizer.lock(tx, op);
        const [installation] = (
          await tx.query<{ authority: string; topic_id: string }>(
            'SELECT authority,topic_id FROM liekan_warehouse_installation WHERE id=1 FOR SHARE',
          )
        ).rows;
        if (installation?.authority !== op.authority || installation.topic_id !== op.topic_id)
          throw new WarehouseConflict('warehouse-deletion-authority-frozen');
        const [state] = (
          await tx.query<{ epoch: string; deletion_revision: string; state: string }>(
            'SELECT * FROM liekan_warehouse_site WHERE website_id=$1 FOR UPDATE',
            [op.website_id],
          )
        ).rows;
        op = await guarded(tx);
        if (
          state?.state !== 'active' ||
          state.epoch !== op.epoch ||
          BigInt(state.deletion_revision) + 1n !== BigInt(op.revision)
        )
          throw new WarehouseConflict('warehouse-deletion-control-changed');
        // Confirmed work finishes publication first. In particular a repair's
        // accepted PG progress must not lose its parent during website reset.
        const waiting = await tx.query(
          "SELECT 1 FROM liekan_warehouse_attempt WHERE website_id=$1 AND epoch=$2 AND status='confirmed' AND ($4='clickhouse' OR NOT decision_projected) AND version<$3::bigint LIMIT 1",
          [op.website_id, op.epoch, op.version, op.authority],
        );
        if (waiting.rowCount)
          throw new WarehouseConflict('warehouse-deletion-awaiting-publication');
        await tx.query("SELECT set_config('liekan.warehouse_writer','lifecycle',true)");
        await finalizer.apply(tx, op);
        await captureAuthoritativeResult(tx, deletionResult(op));
        await tx.query(
          `UPDATE liekan_warehouse_site SET deletion_revision=$2,epoch=epoch+$3,state=$4,updated_at=clock_timestamp() WHERE website_id=$1`,
          [
            op.website_id,
            op.revision,
            op.kind === 'session' ? 0 : 1,
            op.kind === 'website' ? 'deleting' : 'active',
          ],
        );
        return (
          await tx.query<DeletionOperation>(
            "UPDATE liekan_warehouse_deletion SET status='active',owner_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE operation_id=$1 RETURNING *",
            [id],
          )
        ).rows[0];
      });
    } finally {
      await this.runtime.db.transaction(tx =>
        tx.query(
          'UPDATE liekan_warehouse_deletion SET owner_id=NULL,lease_until=NULL WHERE operation_id=$1 AND owner_id=$2 AND generation=$3',
          [id, owner, operation.generation],
        ),
      );
    }
  }
}
