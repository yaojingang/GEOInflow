import { factTables, identifier } from './catalog';
import type { ControlDatabase, ControlSQL } from './control-db';
import type { DeletionOperation } from './deletions';

// Delete children first so each batch is bounded, including FK cascades. Keep
// event parents until UUID tombstones and all event evidence have been removed.
const parents = ['session_data', 'session_link', 'website_event', 'liekan_log', 'session'];
const families = [...factTables].sort((a, b) => {
  const rank = (name: string) => (parents.includes(name) ? parents.indexOf(name) + 1 : 0);
  return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
});
export async function purgePostgresFacts(
  db: ControlDatabase,
  op: DeletionOperation,
  guard: (tx: ControlSQL) => Promise<boolean>,
  batchSize = 1000,
) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000)
    throw new Error('warehouse-delete-batch-invalid');
  let removed = 0;
  for (const table of families) {
    let predicate = 'f.website_id=$1';
    const values: unknown[] = [op.website_id];
    if (op.session_id) {
      values.push(op.session_id);
      if (table.columns.some(c => c.name === 'session_id')) predicate += ' AND f.session_id=$2';
      else if (table.name === 'event_data')
        predicate +=
          ' AND f.website_event_id IN(SELECT event_id FROM website_event WHERE website_id=$1 AND session_id=$2)';
      else if (table.columns.some(c => c.name === 'event_id'))
        predicate +=
          ' AND f.event_id IN(SELECT event_id FROM website_event WHERE website_id=$1 AND session_id=$2)';
      else if (table.name === 'liekan_history_repair_result')
        predicate +=
          " AND f.kind='event' AND f.record_id IN(SELECT event_id::text FROM website_event WHERE website_id=$1 AND session_id=$2)";
      else continue;
    }
    for (;;) {
      const count = await db.transaction(async tx => {
        if (!(await guard(tx))) return 0;
        await tx.query("SELECT set_config('liekan.warehouse_writer','lifecycle',true)");
        const selection = `SELECT f.ctid FROM ${identifier(table.name)} f WHERE ${predicate} ORDER BY ${table.primaryKey.map(k => `f.${identifier(k)}`).join(',')} LIMIT ${batchSize}`;
        if (table.name === 'liekan_collection_receipt') {
          await tx.query(
            `INSERT INTO liekan_warehouse_pg_receipt_tombstone(operation_id,website_id,client_event_id,session_id)
            SELECT $${values.length + 1}::uuid,r.website_id,r.client_event_id,e.session_id FROM liekan_collection_receipt r
            LEFT JOIN website_event e ON e.website_id=r.website_id AND e.event_id=r.event_id
            WHERE r.ctid IN(${selection}) ON CONFLICT DO NOTHING`,
            [...values, op.operation_id],
          );
        }
        return (
          (
            await tx.query(
              `DELETE FROM ${identifier(table.name)} WHERE ctid IN(${selection})`,
              values,
            )
          ).rowCount ?? 0
        );
      });
      removed += count;
      if (count < batchSize) break;
    }
  }
  return removed;
}
