import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { processSingleton } from './process-singleton';
import type { AnalysisTx } from './analysis-rollups-model';
import { analysisTransaction } from './analysis-rollups-db';
import type { CrawlerActor } from './crawler-access';
import { LiekanError } from './errors';

const context = processSingleton('analysis-viewer', () => new AsyncLocalStorage<string>());
export const currentAnalysisViewer = () => context.getStore();
export const withAnalysisViewer = <T>(id: string | undefined, work: () => Promise<T>) =>
  context.run(id, work);
export function analysisViewerId(request: Request) {
  const id = request.headers.get('X-Liekan-View');
  if (id && !z.uuid().safeParse(id).success) throw new LiekanError('统计任务标识无效', 400);
  return id || undefined;
}

export const analysisConsumerDemandSql = (alias = 'c') =>
  `(NOT ${alias}.managed OR EXISTS(SELECT 1 FROM liekan_analysis_query_viewer v
    WHERE v.job_id=${alias}.job_id AND v.actor_id=${alias}.actor_id AND v.lease_until>clock_timestamp()))`;
export const analysisJobDemandSql = (job = 'q') =>
  `EXISTS(SELECT 1 FROM liekan_analysis_query_consumer c WHERE c.job_id=${job}.id AND ${analysisConsumerDemandSql()})`;

/** Legacy consumers retain their existing lifetime; each new browser read owns its own lease. */
export async function registerAnalysisViewer(tx: AnalysisTx, jobId: string, actorId: string) {
  const viewer = currentAnalysisViewer();
  const live = await tx.$executeRawUnsafe(
    "SELECT 1 FROM liekan_analysis_query WHERE id=$1::uuid AND status IN('queued','running') FOR KEY SHARE",
    jobId,
  );
  if (live !== 1)
    throw new LiekanError('统计任务登记繁忙，请稍后重试', 503, 'analysis-admission-busy');
  await tx.$executeRawUnsafe(
    `INSERT INTO liekan_analysis_query_consumer(job_id,actor_id,managed) VALUES($1::uuid,$2::uuid,$3)
     ON CONFLICT(job_id,actor_id) DO UPDATE SET managed=liekan_analysis_query_consumer.managed AND EXCLUDED.managed`,
    jobId,
    actorId,
    Boolean(viewer),
  );
  if (viewer) {
    // The consumer upsert holds its row lock, serializing lease admission for this actor/job.
    await tx.$executeRawUnsafe(
      `DELETE FROM liekan_analysis_query_viewer WHERE job_id=$1::uuid AND actor_id=$2::uuid
       AND lease_until<=clock_timestamp() AND viewer_id<>$3::uuid`,
      jobId,
      actorId,
      viewer,
    );
    const admitted = await tx.$executeRawUnsafe(
      `INSERT INTO liekan_analysis_query_viewer(job_id,actor_id,viewer_id,lease_until)
       SELECT $1::uuid,$2::uuid,$3::uuid,clock_timestamp()+interval '15 seconds'
       WHERE (SELECT count(*) FROM liekan_analysis_query_viewer
         WHERE job_id=$1::uuid AND actor_id=$2::uuid AND viewer_id<>$3::uuid)<32
       ON CONFLICT(job_id,actor_id,viewer_id) DO UPDATE SET lease_until=EXCLUDED.lease_until`,
      jobId,
      actorId,
      viewer,
    );
    if (admitted !== 1)
      throw new LiekanError(
        '后台统计任务已达上限，请等待当前任务完成',
        429,
        'analysis-concurrency-limited',
      );
  }
}

export async function renewAnalysisViewer(tx: AnalysisTx, jobId: string, actorId: string) {
  const viewer = currentAnalysisViewer();
  if (!viewer) return;
  const changed = await tx.$executeRawUnsafe(
    `UPDATE liekan_analysis_query_viewer SET lease_until=clock_timestamp()+interval '15 seconds'
     WHERE job_id=$1::uuid AND actor_id=$2::uuid AND viewer_id=$3::uuid AND lease_until>clock_timestamp()`,
    jobId,
    actorId,
    viewer,
  );
  if (changed !== 1) throw new LiekanError('统计任务已过期，请重新读取', 410, 'analysis-idle');
}

/** Published responses expose no poll handle; retain the existing two-minute refresh demand. */
export async function retainPublishedAnalysisViewer(
  websiteId: string,
  actorId: string,
  jobId: string,
) {
  const viewer = currentAnalysisViewer();
  if (!viewer) return false;
  return analysisTransaction(async tx => {
    const live = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT q.id FROM liekan_analysis_query q JOIN liekan_analysis_query_consumer c ON c.job_id=q.id AND c.actor_id=$3::uuid
       WHERE q.id=$1::uuid AND q.website_id=$2::uuid AND q.status IN('queued','running') FOR KEY SHARE OF q`,
      jobId,
      websiteId,
      actorId,
    );
    if (!live.length) return false;
    return (
      (await tx.$executeRawUnsafe(
        `UPDATE liekan_analysis_query_viewer SET lease_until=greatest(lease_until,clock_timestamp()+interval '2 minutes')
       WHERE job_id=$1::uuid AND actor_id=$2::uuid AND viewer_id=$3::uuid AND lease_until>clock_timestamp()`,
        jobId,
        actorId,
        viewer,
      )) === 1
    );
  });
}

export async function releaseAnalysisViewer(websiteId: string, actor: CrawlerActor, jobId: string) {
  const viewer = currentAnalysisViewer();
  if (!viewer) throw new LiekanError('统计任务标识无效', 400);
  const { analysisQueryState } = await import('./analysis-queries');
  return analysisTransaction(async tx => {
    await analysisQueryState(tx, websiteId, actor);
    // Keep the receipt until the job is collected so a disconnected viewer cannot revive it.
    await tx.$executeRawUnsafe(
      `UPDATE liekan_analysis_query_viewer v SET lease_until=clock_timestamp()
       FROM liekan_analysis_query q WHERE q.id=v.job_id AND q.website_id=$1::uuid
       AND v.job_id=$2::uuid AND v.actor_id=$3::uuid AND v.viewer_id=$4::uuid`,
      websiteId,
      jobId,
      actor.id,
      viewer,
    );
    // Lock selection and demand recheck use separate Read Committed statement snapshots.
    const idle = await tx.$queryRawUnsafe<{ id: string }[]>(
      "SELECT id FROM liekan_analysis_query WHERE id=$1::uuid AND website_id=$2::uuid AND status='queued' FOR UPDATE SKIP LOCKED",
      jobId,
      websiteId,
    );
    // An in-flight join or renewal retains its shared job lock; the idle pump can retry later.
    if (idle.length)
      await tx.$executeRawUnsafe(
        `UPDATE liekan_analysis_query q SET status='failed',error_code='analysis-idle',updated_at=clock_timestamp()
       WHERE q.id=$1::uuid AND q.website_id=$2::uuid AND q.status='queued'
       AND EXISTS(SELECT 1 FROM liekan_analysis_query_viewer v WHERE v.job_id=q.id)
       AND NOT ${analysisJobDemandSql()}`,
        jobId,
        websiteId,
      );
    return { released: true as const };
  });
}
