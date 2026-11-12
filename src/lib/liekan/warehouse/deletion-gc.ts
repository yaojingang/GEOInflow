import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { factTables, identifier } from './catalog';
import { type ControlDatabase, WarehouseConflict } from './control-db';
import type { DeletionOperation } from './deletions';
import { verifyBoundWarehouse } from './installation-identity';
import { warehouseAnalyticsTables } from './schema';

/** Physical reclamation follows a durable logical deletion. It never expires
 * live facts. Canonical receipt journals remain protected for session deletes;
 * an obsolete epoch can release them once every reference has gone. */
export class WarehouseDeletionGC {
  constructor(
    private db: ControlDatabase,
    private ch: ClickHouseClient,
  ) {}

  async collect(limit = 5, graceSeconds = 600) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      !Number.isSafeInteger(graceSeconds) ||
      graceSeconds < 0
    )
      throw new Error('warehouse-deletion-gc-options-invalid');
    await verifyBoundWarehouse(this.db, this.ch);
    const eligible = `
      NOT EXISTS(SELECT 1 FROM liekan_warehouse_transition WHERE state<>'closed')
      AND EXISTS(SELECT 1 FROM liekan_warehouse_installation WHERE id=1 AND authority='clickhouse' AND facts_fenced)
      AND d.status IN('active','reclaimed') AND d.boundary IS NOT NULL
      AND d.updated_at<clock_timestamp()-$1*interval '1 second'
      AND (s.epoch>d.epoch OR (d.kind='session' AND s.epoch=d.epoch AND s.deletion_revision>=d.revision))
      AND NOT EXISTS(SELECT 1 FROM liekan_warehouse_reference r WHERE r.website_id=d.website_id AND r.epoch=d.epoch
        AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp()))
      AND NOT EXISTS(SELECT 1 FROM liekan_history_repair_run r WHERE r.website_id=d.website_id)
      AND (g.operation_id IS NULL OR g.completed_at IS NULL OR g.completed_at<clock_timestamp()-interval '1 day')
      AND (g.owner_id IS NULL OR g.lease_until<clock_timestamp())`;
    const jobs = await this.db.read<{ operation_id: string }>(
      `SELECT d.operation_id FROM liekan_warehouse_deletion d JOIN liekan_warehouse_site s USING(website_id)
       LEFT JOIN liekan_warehouse_deletion_gc g USING(operation_id) WHERE ${eligible}
       ORDER BY g.updated_at NULLS FIRST,d.created_at LIMIT $2`,
      [graceSeconds, limit],
    );
    let tables = 0,
      completed = 0;
    operations: for (const job of jobs) {
      const owner = randomUUID();
      const claimed = await this.db.transaction(async tx => {
        // New report pins and GEO proofs take the same site lock. Once this
        // check succeeds, a new valid reader can only see the post-delete scope.
        await tx.query(
          `SELECT s.website_id FROM liekan_warehouse_site s JOIN liekan_warehouse_deletion d USING(website_id)
          WHERE d.operation_id=$1 FOR UPDATE OF s,d`,
          [job.operation_id],
        );
        // Use a fresh READ COMMITTED statement after acquiring the locks, so a
        // prior collector or a just-committed proof is visible in this check.
        const [op] = (
          await tx.query<DeletionOperation & { table_cursor: number }>(
            `SELECT d.*,coalesce(g.table_cursor,0) AS table_cursor FROM liekan_warehouse_deletion d
           JOIN liekan_warehouse_site s USING(website_id) LEFT JOIN liekan_warehouse_deletion_gc g USING(operation_id)
           WHERE d.operation_id=$2 AND ${eligible}`,
            [graceSeconds, job.operation_id],
          )
        ).rows;
        if (!op) return null;
        const [progress] = (
          await tx.query<{ table_cursor: number }>(
            `INSERT INTO liekan_warehouse_deletion_gc(operation_id,owner_id,lease_until) VALUES($1,$2,clock_timestamp()+interval '120 seconds')
           ON CONFLICT(operation_id) DO UPDATE SET owner_id=$2,lease_until=clock_timestamp()+interval '120 seconds',
             table_cursor=CASE WHEN liekan_warehouse_deletion_gc.completed_at IS NULL THEN liekan_warehouse_deletion_gc.table_cursor ELSE 0 END,
             completed_at=NULL,updated_at=clock_timestamp() RETURNING table_cursor`,
            [op.operation_id, owner],
          )
        ).rows;
        return { ...op, table_cursor: progress.table_cursor };
      });
      if (!claimed) continue;
      const op = claimed;
      try {
        const familyTables = factTables.map(f => ({ name: `warehouse_${f.name}`, fact: true }));
        if (op.kind !== 'session')
          familyTables.push(
            ...[
              'warehouse_landing',
              'warehouse_decision',
              'warehouse_publication',
              'warehouse_control_projection',
            ].map(name => ({ name, fact: false })),
          );
        const table = familyTables[op.table_cursor];
        if (!table) throw new WarehouseConflict('warehouse-deletion-gc-cursor-invalid');
        const done = op.table_cursor + 1 === familyTables.length;
        const targets = [table];
        if (done && op.kind !== 'session') {
          // Reclaim analytics by the same fenced epoch. Keep the durable cursor
          // compatible with older workers that can resume an interrupted pass.
          const derived = await this.ch
            .query({
              query:
                'SELECT name FROM system.tables WHERE database=currentDatabase() AND name IN {names:Array(String)}',
              query_params: { names: warehouseAnalyticsTables },
              format: 'JSONEachRow',
            })
            .then(result => result.json<{ name: string }>());
          targets.push(...derived.map(({ name }) => ({ name, fact: false })));
        }
        const params = {
          site: op.website_id,
          epoch: op.epoch,
          session: op.session_id,
          version: op.version,
          topic: op.topic_id,
          partitions: op.boundary.map(p => p.partition),
          offsets: op.boundary.map(p => p.offset),
        };
        const deleted =
          op.kind === 'session'
            ? ` AND _session_id={session:Nullable(UUID)} AND (_version<{version:UInt64} OR
             (_topic_id={topic:String} AND arrayExists(p->_partition=p.1 AND _offset<p.2,arrayZip({partitions:Array(UInt32)},arrayMap(x->toUInt64(x),{offsets:Array(String)})))))`
            : '';
        for (const target of targets) {
          const pending = await this.ch
            .query({
              query:
                'SELECT 1 FROM system.mutations WHERE database=currentDatabase() AND table={table:String} AND NOT is_done LIMIT 1',
              query_params: { table: target.name },
              format: 'JSONEachRow',
            })
            .then(result => result.json());
          // A lost synchronous reply can leave a mutation running.
          if (pending.length) continue operations;
          const scope = `${target.fact ? '_website_id' : 'website_id'}={site:UUID} AND ${target.fact ? '_epoch' : 'epoch'}={epoch:UInt64}`;
          await this.ch.command({
            query: `ALTER TABLE ${identifier(target.name)} DELETE WHERE ${scope}${deleted}`,
            query_params: params,
            clickhouse_settings: { mutations_sync: '1' },
          });
          tables++;
        }
        const changed = await this.db.read(
          `UPDATE liekan_warehouse_deletion_gc SET table_cursor=$3,completed_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
             pass=pass+CASE WHEN $4 THEN 1 ELSE 0 END,owner_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
           WHERE operation_id=$1 AND owner_id=$2 RETURNING operation_id`,
          [op.operation_id, owner, op.table_cursor + 1, done],
        );
        if (!changed.length) throw new WarehouseConflict('warehouse-deletion-gc-owner-lost');
        if (done) completed++;
      } finally {
        await this.db.read(
          'UPDATE liekan_warehouse_deletion_gc SET owner_id=NULL,lease_until=NULL WHERE operation_id=$1 AND owner_id=$2',
          [op.operation_id, owner],
        );
      }
    }
    // Revisit completed operations daily: a fenced old writer can finish a late
    // invisible CH write after the first pass. The immutable tombstone is kept.
    return { tables, completed };
  }
}
