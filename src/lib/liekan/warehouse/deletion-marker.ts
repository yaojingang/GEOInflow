import type { ClickHouseClient } from '@clickhouse/client';
import { WarehouseConflict } from './control-db';
import type { DeletionOperation } from './deletions';
import { warehouseTime } from './fact-input';

export function deletionMarker(op: DeletionOperation) {
  if (!op.boundary) throw new Error('warehouse-deletion-boundary-missing');
  return {
    website_id: op.website_id,
    epoch: op.epoch,
    revision: op.revision,
    operation_id: op.operation_id,
    session_id: op.session_id,
    version: op.version,
    topic_id: op.topic_id,
    partitions: op.boundary.map(b => b.partition),
    offsets: op.boundary.map(b => b.offset),
    created_at: warehouseTime(op.created_at),
  };
}
export async function projectDeletionMarker(ch: ClickHouseClient, op: DeletionOperation) {
  const marker = deletionMarker(op);
  await ch.insert({ table: 'warehouse_deletion', values: [marker], format: 'JSONEachRow' });
  const found = await ch
    .query({
      query:
        'SELECT DISTINCT * FROM warehouse_deletion WHERE website_id={site:UUID} AND operation_id={id:UUID}',
      query_params: { site: op.website_id, id: op.operation_id },
      format: 'JSONEachRow',
    })
    .then(r => r.json<typeof marker>());
  if (
    found.length !== 1 ||
    Object.keys(marker).some(k => JSON.stringify(found[0][k]) !== JSON.stringify(marker[k]))
  )
    throw new WarehouseConflict('warehouse-deletion-marker-mismatch');
}
