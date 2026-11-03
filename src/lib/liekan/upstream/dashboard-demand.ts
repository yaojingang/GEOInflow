import type { AnalysisTx } from './analysis-rollups-model';
import { analysisConsumerDemandSql, analysisJobDemandSql } from './analysis-viewers';
import { DASHBOARD_INTERVAL } from './dashboard-snapshot-model';
export const dashboardCapacityLockNamespace = 1277339413;

// These predicates share the q alias across admission, dispatch, claim and permit guards.
export const analysisForegroundDemandSql = `(
  EXISTS(SELECT 1 FROM liekan_analysis_query_viewer v WHERE v.job_id=q.id AND v.lease_until>clock_timestamp())
  OR (EXISTS(SELECT 1 FROM liekan_analysis_query_consumer c WHERE c.job_id=q.id AND NOT c.managed)
   AND (NOT EXISTS(SELECT 1 FROM liekan_dashboard_snapshot d WHERE d.job_id=q.id)
    OR EXISTS(SELECT 1 FROM liekan_dashboard_snapshot d WHERE d.job_id=q.id
     AND d.last_read_at>clock_timestamp()-interval '2 minutes'))))`;
export const dashboardAnalysisWorkSql = `(${analysisForegroundDemandSql} AND
  (q.target='feature:page-report' OR (q.target IN('native:stats','native:pageviews')
    AND (q.attempts=0 OR (q.status='running' AND q.attempts=1)))))`;
// Published refreshes yield one update interval to first results while retaining their queue age.
export const dashboardRunnableHeadSql = `q.id IN(SELECT id FROM(
  SELECT DISTINCT ON(q.website_id) q.id FROM liekan_analysis_query q
  WHERE q.status='queued' AND q.next_attempt_at<=clock_timestamp()
    AND q.retention_until>clock_timestamp() AND ${dashboardAnalysisWorkSql}
  ORDER BY q.website_id,q.queued_at+CASE
    WHEN NOT EXISTS(SELECT 1 FROM liekan_dashboard_snapshot d WHERE d.job_id=q.id)
      OR EXISTS(SELECT 1 FROM liekan_dashboard_snapshot d WHERE d.job_id=q.id
        AND d.result IS NULL AND d.last_read_at>clock_timestamp()-interval '2 minutes')
    THEN interval '0 seconds' ELSE ${DASHBOARD_INTERVAL}*interval '1 millisecond' END,
    q.queued_at,q.sequence LIMIT 32) heads)`;
// Inline reads yield to the oldest waiting website before taking the next free slot.
export const dashboardFirstPageTurnSql = `q.id=(SELECT q.id FROM liekan_analysis_query q
 JOIN liekan_analysis_site s ON s.website_id=q.website_id AND s.epoch=q.epoch AND s.mode='live'
 JOIN website w ON w.website_id=q.website_id AND w.deleted_at IS NULL
 JOIN "user" u ON u.user_id=q.actor_id AND u.deleted_at IS NULL
 WHERE q.status='queued' AND q.next_attempt_at<=clock_timestamp()
 AND q.retention_until>clock_timestamp() AND ${dashboardAnalysisWorkSql} AND ${dashboardRunnableHeadSql}
 ORDER BY q.queued_at,q.sequence LIMIT 1)`;
export const foregroundAnalysisQueuedSql = `EXISTS(SELECT 1 FROM liekan_analysis_query q
  WHERE q.status='queued' AND ${analysisForegroundDemandSql})`;
export const coldDashboardPrewarmSql = `(q.target='feature:page-report'
  AND EXISTS(SELECT 1 FROM liekan_dashboard_snapshot d WHERE d.job_id=q.id)
  AND NOT EXISTS(SELECT 1 FROM liekan_dashboard_snapshot d WHERE d.job_id=q.id
    AND (d.result IS NOT NULL OR d.last_read_at>clock_timestamp()-interval '2 minutes')))`;

/** Keep deterministic input failures when the producer receipt is retired. */
export async function preserveDashboardFailure(tx: AnalysisTx, jobId?: string) {
  await tx.$executeRawUnsafe(
    `UPDATE liekan_dashboard_snapshot d SET error_code='dashboard-compute-failed'
     FROM liekan_analysis_query q WHERE q.id=d.job_id AND q.status='failed'
     AND q.error_code IN('analysis-query-timeout','analysis-count-overflow')
     AND ${jobId ? 'q.id=$1::uuid' : 'q.retention_until<=clock_timestamp()'}`,
    ...(jobId ? [jobId] : []),
  );
}

/** A real reader can reuse a seat held by an unviewed queued refresh with published facts. */
export async function yieldIdleDashboard(
  tx: AnalysisTx,
  actorId: string,
  websiteId: string,
  input: {
    epoch: bigint;
    strong: string;
    targets: readonly string[];
    actorClass: boolean | null;
  },
) {
  const [capacityLock] = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
    `SELECT pg_try_advisory_xact_lock(${dashboardCapacityLockNamespace},hashtext($1::text)) AS locked`,
    websiteId,
  );
  if (!capacityLock.locked) return false;
  const [authority] = await tx.$queryRawUnsafe<{ website_id: string }[]>(
    "SELECT website_id FROM liekan_analysis_site WHERE website_id=$1::uuid AND epoch=$2::bigint AND mode='live' FOR SHARE SKIP LOCKED",
    websiteId,
    String(input.epoch),
  );
  if (!authority) return false;
  const candidates = await tx.$queryRawUnsafe<{ id: string; website_id: string }[]>(
    `SELECT q.id,q.website_id FROM liekan_analysis_query q WHERE q.status='queued' AND q.attempts=0
     AND q.website_id=$2::uuid AND q.actor_id=$1::uuid AND q.epoch=$3::bigint AND q.strong_version=$4
     AND q.retention_until>clock_timestamp() AND ($6::boolean IS NULL OR (q.target=ANY($5::text[]))=$6::boolean)
     AND EXISTS(SELECT 1 FROM liekan_analysis_query_consumer c WHERE c.job_id=q.id AND c.actor_id=$1::uuid AND ${analysisConsumerDemandSql()})
     AND NOT EXISTS(SELECT 1 FROM liekan_analysis_query_consumer c WHERE c.job_id=q.id AND c.actor_id<>$1::uuid AND ${analysisConsumerDemandSql()})
     AND EXISTS(SELECT 1 FROM liekan_dashboard_snapshot d WHERE d.job_id=q.id AND d.result IS NOT NULL)
     AND NOT EXISTS(SELECT 1 FROM liekan_dashboard_snapshot d WHERE d.job_id=q.id AND d.last_read_at>clock_timestamp()-interval '2 minutes')
     ORDER BY (q.website_id=$2::uuid) DESC,q.queued_at,q.sequence LIMIT 8`,
    actorId,
    websiteId,
    String(input.epoch),
    input.strong,
    [...input.targets],
    input.actorClass,
  );
  for (const candidate of candidates) {
    // Visible opens lock their publication first. Skip an in-flight reader or publisher.
    const links = await tx.$queryRawUnsafe<{ recent: boolean; published: boolean }[]>(
      `SELECT last_read_at>clock_timestamp()-interval '2 minutes' AS recent,result IS NOT NULL AS published
       FROM liekan_dashboard_snapshot WHERE job_id=$1::uuid ORDER BY website_id,query_key FOR UPDATE SKIP LOCKED`,
      candidate.id,
    );
    const [total] = await tx.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM liekan_dashboard_snapshot WHERE job_id=$1::uuid',
      candidate.id,
    );
    if (
      !links.length ||
      links.length !== total.n ||
      links.some(row => row.recent) ||
      !links.some(row => row.published)
    )
      continue;
    const [queued] = await tx.$queryRawUnsafe<{ id: string }[]>(
      "SELECT id FROM liekan_analysis_query WHERE id=$1::uuid AND status='queued' AND attempts=0 AND retention_until>clock_timestamp() FOR UPDATE SKIP LOCKED",
      candidate.id,
    );
    if (!queued) continue;
    await tx.$executeRawUnsafe(
      "UPDATE liekan_analysis_query SET status='failed',error_code='analysis-idle',updated_at=clock_timestamp() WHERE id=$1::uuid",
      candidate.id,
    );
    await tx.$executeRawUnsafe(
      `UPDATE liekan_dashboard_snapshot SET error_code='dashboard-paused',next_refresh_at='9999-12-31'::timestamptz,
       job_id=NULL,pending_fingerprint=NULL WHERE job_id=$1::uuid`,
      candidate.id,
    );
    return true;
  }
  return false;
}

/** Failed work loses background demand when its last real reader leaves. Cold seeds get one attempt. */
export async function pauseIdleDashboardRetries(tx: AnalysisTx) {
  const idle = `((q.status='queued' AND EXISTS(SELECT 1 FROM liekan_analysis_query_viewer v WHERE v.job_id=q.id)
      AND NOT ${analysisJobDemandSql()})
    OR (((q.status='queued' AND q.attempts>0)
      OR (q.status='failed' AND coalesce(q.error_code,'') NOT IN('analysis-query-timeout','analysis-count-overflow') AND q.error_code IS DISTINCT FROM 'analysis-idle'))
      AND EXISTS(SELECT 1 FROM liekan_dashboard_snapshot d WHERE d.job_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM liekan_analysis_query_viewer v WHERE v.job_id=q.id AND v.lease_until>clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM liekan_dashboard_snapshot d WHERE d.job_id=q.id AND d.last_read_at>clock_timestamp()-interval '2 minutes')))`;
  const locked = await tx.$queryRawUnsafe<{ id: string }[]>(
    `SELECT q.id FROM liekan_analysis_query q WHERE ${idle}
     ORDER BY (q.status='queued') DESC,q.queued_at LIMIT 32 FOR UPDATE OF q SKIP LOCKED`,
  );
  // A fresh statement sees joins or renewals committed while candidate selection was in flight.
  if (locked.length)
    await tx.$executeRawUnsafe(
      `UPDATE liekan_analysis_query q SET status='failed',error_code='analysis-idle',updated_at=clock_timestamp()
     WHERE q.id=ANY($1::uuid[]) AND ${idle}`,
      locked.map(row => row.id),
    );
  await tx.$executeRawUnsafe(
    `UPDATE liekan_dashboard_snapshot d SET error_code='dashboard-paused',next_refresh_at='9999-12-31'::timestamptz,
     job_id=NULL,pending_fingerprint=NULL
     WHERE (d.last_read_at<=clock_timestamp()-interval '2 minutes'
       OR NOT EXISTS(SELECT 1 FROM liekan_analysis_query_consumer c WHERE c.job_id=d.job_id AND ${analysisConsumerDemandSql()}))
     AND EXISTS(SELECT 1 FROM liekan_analysis_query q WHERE q.id=d.job_id AND q.status='failed' AND q.error_code='analysis-idle')`,
  );
}
