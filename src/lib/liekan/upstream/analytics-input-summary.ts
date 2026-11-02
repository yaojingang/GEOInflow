import { analysisTransaction } from './analysis-rollups-db';

/** One short transaction resumes durable progress after foreground dispatch. */
export async function maintainAnalyticsInputSummaries(): Promise<void> {
  await analysisTransaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout TO '1s'");
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout TO '100ms'");
    await tx.$queryRawUnsafe(`WITH removed AS (
      DELETE FROM liekan_analytics_input_summary d WHERE
       (d.website_id,d.epoch,d.source,d.family,d.day,d.shard) IN (
        SELECT stale.website_id,stale.epoch,stale.source,stale.family,stale.day,stale.shard
        FROM liekan_analysis_site s CROSS JOIN LATERAL (
         (SELECT p.website_id,p.epoch,p.source,p.family,p.day,p.shard
          FROM liekan_analytics_input_summary p WHERE p.website_id=s.website_id AND p.epoch<s.epoch
          ORDER BY p.epoch,p.source,p.family,p.day,p.shard LIMIT 512)
         UNION ALL
         (SELECT p.website_id,p.epoch,p.source,p.family,p.day,p.shard
          FROM liekan_analytics_input_summary p WHERE p.website_id=s.website_id AND p.epoch>s.epoch
          ORDER BY p.epoch,p.source,p.family,p.day,p.shard LIMIT 512)
        ) stale LIMIT 512
       ) RETURNING 1
     ),states AS (
      DELETE FROM liekan_analytics_input_state p WHERE (p.website_id,p.epoch) IN (
       SELECT b.website_id,b.epoch FROM liekan_analytics_input_state b
       JOIN liekan_analysis_site s USING(website_id) WHERE b.epoch<>s.epoch
        AND NOT EXISTS(SELECT 1 FROM liekan_analytics_input_summary d
         WHERE d.website_id=b.website_id AND d.epoch=b.epoch)
       ORDER BY b.website_id,b.epoch LIMIT 16
      ) RETURNING 1
     ) SELECT liekan_analytics_input_backfill() AS processed`);
  });
}
