import type { ControlDatabase } from '../warehouse/control-db';
import type { WarehouseIngestionPressure } from './warehouse-background-budget';

/** Sample queue heads and recently committed uploads through the existing
 * offset, recovery and upload-key indexes. No new ingest writes are needed. */
export function warehouseIngestionPressure(database: () => ControlDatabase) {
  let sample: Promise<WarehouseIngestionPressure> | undefined;
  let sampledAt = 0;
  return () => {
    const now = Date.now();
    if (!sample || now - sampledAt >= 1000) {
      sampledAt = now;
      sample = database()
        .read<WarehouseIngestionPressure>(
          `WITH active_topic AS (
             SELECT topic_id FROM liekan_warehouse_installation LIMIT 1
           ), heads AS (
             SELECT pending.created_at FROM liekan_warehouse_partition p
             JOIN active_topic t USING(topic_id)
             CROSS JOIN LATERAL (
               SELECT w.created_at FROM liekan_warehouse_work w
               WHERE w.topic_id=p.topic_id AND w.partition=p.partition
                 AND w.status IN ('pending','working') ORDER BY w.offset_id LIMIT 1
             ) pending
             UNION ALL
             (SELECT a.created_at FROM liekan_warehouse_attempt a JOIN active_topic t USING(topic_id)
               WHERE a.status='confirmed' ORDER BY a.updated_at LIMIT 1)
           ), recent AS (
             SELECT a.effects FROM liekan_warehouse_attempt a JOIN active_topic t USING(topic_id)
             WHERE a.status='projected' AND a.updated_at>now()-interval '20 seconds'
             ORDER BY a.updated_at DESC LIMIT 32
           ), recent_batches AS (
             SELECT DISTINCT batches.id FROM recent r
             CROSS JOIN LATERAL (
               SELECT (e.value->>'batchId')::uuid AS id FROM jsonb_array_elements(r.effects) e
               WHERE e.value->>'kind'='log-upload' LIMIT 8
             ) batches
           )
           SELECT (SELECT greatest(0,extract(epoch FROM (now()-min(created_at)))*1000)::float8
                     FROM heads) AS "oldestMs",
             percentile_disc(0.95) WITHIN GROUP (ORDER BY
               greatest(0,extract(epoch FROM (u.updated_at-u.created_at))*1000)::float8
             ) AS "publishedP95Ms", count(*)::int AS samples
           FROM recent_batches b JOIN liekan_warehouse_upload u ON u.batch_id=b.id
           WHERE u.kind='automatic' AND u.status='processed' AND u.inserted>0
             AND u.updated_at>now()-interval '20 seconds'`,
        )
        .then(([pressure]) => {
          if (process.env.LIEKAN_WAREHOUSE_ANALYTICS_TIMING === '1')
            console.info(JSON.stringify({ event: 'warehouse-ingestion-pressure', ...pressure }));
          return pressure;
        });
    }
    return sample;
  };
}
