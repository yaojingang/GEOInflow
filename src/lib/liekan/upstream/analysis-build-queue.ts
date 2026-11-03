import type { PgBoss } from 'pg-boss';
import { withAnalysisPermit } from './analysis-background';
import { ANALYSIS_BUILD_QUEUE } from './analysis-query-model';
import { analysisCapacity, analysisTransaction } from './analysis-rollups-db';
import { analysisBuildPrioritySql, analysisBuildWaitingSql } from './analysis-rollups-model';
import { runOneAnalysisWorkUnit } from './analysis-rollups-worker';
import { storageHistoryAllowed, storageHistorySiteAllowedSql } from './storage-capacity';

export async function pumpAnalysisBuilds(boss: Pick<PgBoss, 'send'>) {
  const rows = await analysisTransaction(async tx => {
    const capacity = await analysisCapacity(tx, null);
    const globalHistoryAllowed = storageHistoryAllowed(capacity);
    await tx.$executeRawUnsafe(`UPDATE liekan_analysis_background_lease SET
     incremental_waiting_at=${analysisBuildWaitingSql.incremental},
     history_waiting_at=${analysisBuildWaitingSql.history(globalHistoryAllowed)} WHERE id`);
    return tx.$queryRawUnsafe<
      { id: string; actor_id: string | null; automatic_history: boolean }[]
    >(
      `WITH per_site AS (
      SELECT DISTINCT ON(b.website_id,((b.actor_id IS NOT NULL OR b.automatic_history))) b.id,b.actor_id,b.automatic_history,b.website_id,b.updated_at,
       CASE WHEN (b.actor_id IS NULL AND NOT b.automatic_history) THEN s.incremental_served_at ELSE s.history_served_at END AS served_at,
       min(b.updated_at) OVER(PARTITION BY b.website_id,(b.actor_id IS NOT NULL OR b.automatic_history)) AS waiting_at
      FROM liekan_analysis_build b JOIN liekan_analysis_site s ON s.website_id=b.website_id AND s.epoch=b.epoch
      WHERE s.mode='live' AND b.status IN('queued','running') AND (b.lease_until IS NULL OR b.lease_until<=clock_timestamp()) AND b.next_attempt_at<=clock_timestamp()
       AND ((b.actor_id IS NULL AND NOT b.automatic_history) OR (${storageHistorySiteAllowedSql} AND $1::boolean))
       AND ((b.actor_id IS NULL AND NOT b.automatic_history) OR NOT EXISTS(SELECT 1 FROM liekan_history_repair_run WHERE status IN('queued','scanning','preparing','running','validating')))
      ORDER BY b.website_id,((b.actor_id IS NOT NULL OR b.automatic_history)),${analysisBuildPrioritySql},b.updated_at,b.id
     ), ranked AS (SELECT *,row_number() OVER(PARTITION BY (actor_id IS NOT NULL OR automatic_history) ORDER BY served_at NULLS FIRST,waiting_at,website_id) AS kind_rank FROM per_site)
     SELECT id,actor_id,automatic_history FROM ranked ORDER BY kind_rank,(actor_id IS NOT NULL OR automatic_history),served_at NULLS FIRST,waiting_at,website_id LIMIT 8`,
      globalHistoryAllowed,
    );
  });
  for (const row of rows)
    await boss.send(
      ANALYSIS_BUILD_QUEUE,
      { id: row.id, kind: row.actor_id || row.automatic_history ? 'history' : 'incremental' },
      {
        singletonKey: row.id,
        retryLimit: 0,
        expireInSeconds: 120,
        retentionSeconds: 60,
        deleteAfterSeconds: 3600,
      },
    );
}
export async function processAnalysisBuild(
  _id: string,
  kind: 'history' | 'incremental',
  options: { shouldStop?: () => boolean } = {},
) {
  const deadline = Date.now() + 2000;
  let completed = 0;
  while (completed < 32 && Date.now() < deadline && !options.shouldStop?.()) {
    // Revalidate admission, including repair pause, even for an already delivered queue message.
    const [candidate] = await analysisTransaction(async tx => {
      const capacity = kind === 'history' ? await analysisCapacity(tx, null) : null;
      const globalHistoryAllowed = !capacity || storageHistoryAllowed(capacity);
      return tx.$queryRawUnsafe<{ id: string; website_id: string; epoch: bigint }[]>(
        `WITH runnable AS (
        SELECT b.id,b.website_id,b.epoch,
        CASE $1 WHEN 'incremental' THEN s.incremental_served_at ELSE s.history_served_at END AS served_at,
        min(b.updated_at) OVER(PARTITION BY b.website_id) AS waiting_at,
        row_number() OVER(PARTITION BY b.website_id ORDER BY ${analysisBuildPrioritySql},b.updated_at,b.id) AS site_rank
        FROM liekan_analysis_build b JOIN liekan_analysis_site s ON s.website_id=b.website_id AND s.epoch=b.epoch
       WHERE s.mode='live' AND b.status IN('queued','running')
       AND ($1='incremental' OR (${storageHistorySiteAllowedSql} AND $2::boolean))
       AND (b.lease_until IS NULL OR b.lease_until<=clock_timestamp()) AND b.next_attempt_at<=clock_timestamp()
       AND (((b.actor_id IS NULL AND NOT b.automatic_history) AND $1='incremental') OR ((b.actor_id IS NOT NULL OR b.automatic_history) AND $1='history'))
       AND ($1<>'history' OR NOT EXISTS(SELECT 1 FROM liekan_history_repair_run WHERE status IN('queued','scanning','preparing','running','validating')))
       ) SELECT id,website_id,epoch FROM runnable WHERE site_rank=1
       ORDER BY served_at NULLS FIRST,waiting_at,website_id,id LIMIT 1`,
        kind,
        globalHistoryAllowed,
      );
    });
    if (!candidate || options.shouldStop?.()) break;
    const result = await withAnalysisPermit(kind, async (owned, lease) => {
      if (!owned() || options.shouldStop?.()) return { worked: false };
      const served = await analysisTransaction(tx =>
        tx.$executeRawUnsafe(
          `UPDATE liekan_analysis_site SET incremental_served_at=CASE WHEN $3='incremental' THEN clock_timestamp() ELSE incremental_served_at END,
         history_served_at=CASE WHEN $3='history' THEN clock_timestamp() ELSE history_served_at END
         WHERE website_id=$1::uuid AND epoch=$2::bigint AND mode='live'`,
          candidate.website_id,
          String(candidate.epoch),
          kind,
        ),
      );
      if (!served || !owned() || options.shouldStop?.()) return { worked: false };
      return runOneAnalysisWorkUnit(candidate.id, lease);
    });
    if (!result.acquired || !result.value.worked) break;
    completed++;
    // Durable per-kind service times rotate sites; each site prioritizes its current recovery units.
  }
  return { completedUnits: completed };
}
