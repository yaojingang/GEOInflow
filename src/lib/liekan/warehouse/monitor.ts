import type { ClickHouseClient } from '@clickhouse/client';
import type { ControlDatabase } from './control-db';
import type { WarehouseQueue } from './transport';

// Operational measurements, never synthetic storage quotas or admission gates.
// Physical CH rows include candidates/versions and are not product PV totals.
export async function warehouseMonitor(
  db: ControlDatabase,
  ch: ClickHouseClient,
  queue: WarehouseQueue,
) {
  const installation = await db.read(
    'SELECT installation_id,authority,transition,schema_version,routing_version,revision,identity_bound FROM liekan_warehouse_installation WHERE id=1',
  );
  const partitions = await db.read<{
    partition: number;
    safe_offset: string;
    reclaimed_offset: string;
    discovered_offset: string;
  }>(
    'SELECT partition,safe_offset,reclaimed_offset,discovered_offset FROM liekan_warehouse_partition WHERE topic_id=$1 ORDER BY partition',
    [queue.installation.topicId],
  );
  const watermarks = await queue.highWatermarks();
  const lag = partitions.map(p => {
    const high = watermarks.find(h => h.partition === p.partition)?.offset;
    if (high === undefined) throw new Error('warehouse-monitor-partition-missing');
    const pending = BigInt(high) - BigInt(p.safe_offset) - 1n;
    return { ...p, highOffset: high, pendingInputs: String(pending > 0n ? pending : 0n) };
  });
  const storage = await ch
    .query({
      query: `SELECT table,sum(bytes_on_disk) AS physicalBytes,sum(rows) AS physicalRows,count() AS activeParts
        FROM system.parts WHERE database=currentDatabase() AND active GROUP BY table ORDER BY table`,
      format: 'JSONEachRow',
    })
    .then(r => r.json());
  const disks = await ch
    .query({
      query:
        'SELECT name,total_space,free_space,unreserved_space,keep_free_space FROM system.disks',
      format: 'JSONEachRow',
    })
    .then(r => r.json());
  const postgres = await db.read(
    `SELECT pg_database_size(current_database())::text AS database_bytes,
       (SELECT count(*)::text FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS waiting_locks`,
  );
  const transition = await db.read(
    'SELECT state,sequence,sent_sequence,ch_sequence,pg_sequence,terminal_sequence FROM liekan_warehouse_transition WHERE id=1',
  );
  const reclamation = await db.read(
    `SELECT count(*) FILTER(WHERE g.completed_at IS NULL)::text AS pending_deletions,
      min(d.created_at) FILTER(WHERE g.completed_at IS NULL) AS oldest_pending_deletion
      FROM liekan_warehouse_deletion d LEFT JOIN liekan_warehouse_deletion_gc g USING(operation_id)
      WHERE d.status IN('active','reclaimed')`,
  );
  return {
    at: new Date().toISOString(),
    installation: installation[0],
    queue: { topic: queue.installation.topicName, partitions: lag, storage: await queue.storage() },
    transition: transition[0] ?? null,
    reclamation: reclamation[0],
    postgres: postgres[0],
    clickhouse: { storage, disks },
  };
}
