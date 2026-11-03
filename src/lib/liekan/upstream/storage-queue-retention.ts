import { fromPrisma, type PgBoss } from 'pg-boss';
import type { AnalysisTx } from './analysis-rollups-model';

export const storageWakeQueues = [
  'liekan-crawler-control',
  'liekan-crawler-check',
  'liekan-crawler-analysis',
  'liekan-browser-risk',
];
export const storageShortQueues = ['liekan-analysis-query', 'liekan-analysis-build'];
export const storageOtherQueues = [
  'liekan-analytics-refresh',
  'liekan-geo-weight-snapshot',
  'liekan-range-refresh',
  'liekan-crawler-documents',
];
export const storageCompletedQueues = [
  ...storageWakeQueues,
  ...storageShortQueues,
  ...storageOtherQueues,
];
export type QueueCutoffs = {
  completedCutoff: string;
  wakeCutoff: string;
  shortCutoff: string;
  hourlyOnly?: boolean;
};
export const completedQueueSql = `j.state='completed' AND j.name=ANY($2::text[])
 AND j.completed_on<CASE WHEN j.name=ANY($3::text[]) THEN $4::timestamptz
 WHEN j.name=ANY($5::text[]) THEN $6::timestamptz ELSE $7::timestamptz END`;
export const queueCutoffParameters = (c: QueueCutoffs) => [
  c.hourlyOnly ? [...storageWakeQueues, ...storageShortQueues] : storageCompletedQueues,
  storageWakeQueues,
  c.wakeCutoff,
  storageShortQueues,
  c.shortCutoff,
  c.completedCutoff,
];

export async function freezeCompletedJobs(
  tx: AnalysisTx,
  runId: string,
  cutoffs: QueueCutoffs,
  limit?: number,
) {
  if (limit)
    return tx.$executeRawUnsafe(
      `INSERT INTO liekan_storage_candidate(run_id,kind,record_id,queue_name)
       SELECT $1::uuid,'job',j.id,j.name FROM liekan_jobs.job j WHERE ${completedQueueSql}
       ORDER BY j.name,j.id LIMIT 2000 ON CONFLICT DO NOTHING`,
      runId,
      ...queueCutoffParameters(cutoffs),
    );
  let total = 0;
  let cursor: { name: string; id: string } | undefined;
  for (;;) {
    // Keep each statement bounded while the caller's transaction freezes the complete set.
    // Queue name is part of the key because PgBoss UUIDs can repeat across queues.
    const [page] = await tx.$queryRawUnsafe<
      { inserted: number; selected: number; name: string | null; id: string | null }[]
    >(
      `WITH selected AS MATERIALIZED(
       SELECT j.id,j.name FROM liekan_jobs.job j WHERE ${completedQueueSql}
       ${cursor ? 'AND (j.name,j.id)>($8::text,$9::uuid)' : ''}
       ORDER BY j.name,j.id LIMIT 50000
      ), inserted AS(
       INSERT INTO liekan_storage_candidate(run_id,kind,record_id,queue_name)
       SELECT $1::uuid,'job',j.id,j.name FROM selected j ON CONFLICT DO NOTHING RETURNING 1
      ) SELECT (SELECT count(*)::int FROM inserted) AS inserted,
       (SELECT count(*)::int FROM selected) AS selected,
       (SELECT name FROM selected ORDER BY name DESC,id DESC LIMIT 1) AS name,
       (SELECT id FROM selected ORDER BY name DESC,id DESC LIMIT 1) AS id`,
      runId,
      ...queueCutoffParameters(cutoffs),
      ...(cursor ? [cursor.name, cursor.id] : []),
    );
    total += page.inserted;
    if (page.selected < 50000) return total;
    cursor = { name: page.name!, id: page.id! };
  }
}

export async function collectCompletedJobBatch(
  tx: AnalysisTx,
  runId: string,
  cutoffs: QueueCutoffs,
  boss: Pick<PgBoss, 'deleteJob'>,
) {
  await tx.$queryRawUnsafe("SELECT set_config('liekan.storage_cleanup_run',$1,true)", runId);
  const rows = await tx.$queryRawUnsafe<{ id: string; name: string }[]>(
    `WITH selected AS MATERIALIZED(
      SELECT c.record_id,c.queue_name FROM liekan_storage_candidate c
      WHERE c.run_id=$1::uuid AND c.kind='job' ORDER BY c.queue_name,c.record_id LIMIT 2000
     ) SELECT j.id,j.name FROM selected c CROSS JOIN LATERAL(
      SELECT j.id,j.name FROM liekan_jobs.job j WHERE j.id=c.record_id AND j.name=c.queue_name
      AND ${completedQueueSql} LIMIT 1 FOR UPDATE OF j SKIP LOCKED
     ) j`,
    runId,
    ...queueCutoffParameters(cutoffs),
  );
  let deleted = 0;
  for (const name of new Set(rows.map(row => row.name))) {
    const ids = rows.filter(row => row.name === name).map(row => row.id);
    await boss.deleteJob(name, ids, { db: fromPrisma(tx as any) });
    const [remaining] = await tx.$queryRawUnsafe<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1 AND id=ANY($2::uuid[])',
      name,
      ids,
    );
    if (remaining.count) throw new Error('storage-job-delete-incomplete');
    deleted += ids.length - remaining.count;
    await tx.$executeRawUnsafe(
      "DELETE FROM liekan_storage_candidate WHERE run_id=$1::uuid AND kind='job' AND queue_name=$2 AND record_id=ANY($3::uuid[])",
      runId,
      name,
      ids,
    );
  }
  // Native queue maintenance or a retry can make a frozen candidate ineligible.
  await tx.$executeRawUnsafe(
    `WITH selected AS MATERIALIZED(
      SELECT c.run_id,c.kind,c.queue_name,c.record_id FROM liekan_storage_candidate c
      WHERE c.run_id=$1::uuid AND c.kind='job' ORDER BY c.queue_name,c.record_id LIMIT 2000
     ) DELETE FROM liekan_storage_candidate c WHERE (c.run_id,c.kind,c.queue_name,c.record_id) IN(
      SELECT c.run_id,c.kind,c.queue_name,c.record_id FROM selected c WHERE NOT EXISTS(
       SELECT 1 FROM liekan_jobs.job j WHERE j.id=c.record_id AND j.name=c.queue_name AND ${completedQueueSql} LIMIT 1 OFFSET 0))`,
    runId,
    ...queueCutoffParameters(cutoffs),
  );
  const [remaining] = await tx.$queryRawUnsafe<{ more: boolean }[]>(
    `SELECT EXISTS(SELECT 1 FROM liekan_storage_candidate c
     WHERE c.run_id=$1::uuid AND c.kind='job') AS more`,
    runId,
  );
  return { jobsDeleted: deleted, more: remaining.more };
}
