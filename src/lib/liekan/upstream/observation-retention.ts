import { crawlerTransaction } from './crawler-access';
import { warehouseEnabled } from '../warehouse/runtime';
import { assertTransitionMaintenance } from './warehouse-maintenance';
/** Bounded transactions allow ingestion and reset to proceed during catch-up cleanup. */
export async function pruneTrafficObservations(now = new Date()) {
  // CH evidence is retained with its proof/receipt references. An empty legacy
  // PG table is not evidence that CH rows were pruned; preserve the old watermark
  // until the reference-aware warehouse collector actually removes those rows.
  if (warehouseEnabled()) return { deleted: 0, prunedBefore: null };
  const cutoff = new Date(now.getTime() - 30 * 86400000);
  let deleted = 0;
  while (true) {
    const count = await crawlerTransaction(
      async tx => {
        await assertTransitionMaintenance(
          { $queryRawUnsafe: (sql, ...values) => tx.query(sql, ...values) },
          'retention',
        );
        return tx.execute(
          `DELETE FROM liekan_event_observation WHERE event_id IN(
      SELECT event_id FROM liekan_event_observation WHERE received_at<$1 ORDER BY received_at,event_id LIMIT 5000 FOR UPDATE SKIP LOCKED
    )`,
          cutoff,
        );
      },
      { timeout: 30000 },
    );
    deleted += count;
    if (count < 5000) break;
  }
  await crawlerTransaction(
    async tx => {
      await assertTransitionMaintenance(
        { $queryRawUnsafe: (sql, ...values) => tx.query(sql, ...values) },
        'retention',
      );
      return tx.execute(
        `UPDATE liekan_observation_state s SET pruned_before=greatest(coalesce(pruned_before,$1),$1)
    WHERE NOT EXISTS(SELECT 1 FROM liekan_event_observation o WHERE o.website_id=s.website_id AND o.received_at<$1)`,
        cutoff,
      );
    },
    { timeout: 30000 },
  );
  return { deleted, prunedBefore: cutoff.toISOString() };
}
