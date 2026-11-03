import type { AnalysisTx } from './analysis-rollups-model';

const generationTables = [
  'liekan_analysis_log',
  'liekan_analysis_path',
  'liekan_analysis_visit',
  'liekan_analysis_browser_detail',
  'liekan_analysis_browser_visit',
  'liekan_analysis_browser_path',
] as const;

// Failed and capacity-limited builds retain their checkpoint when retried.
export const unreferencedGenerationSql = `NOT EXISTS(
  SELECT 1 FROM liekan_analysis_manifest m WHERE m.website_id=g.website_id
  AND (m.generation=g.generation OR m.previous_generation=g.generation))
 AND NOT EXISTS(
  SELECT 1 FROM liekan_analysis_build b WHERE b.website_id=g.website_id
  AND b.checkpoint->>'generation'=g.generation::text
  AND b.status IN('queued','running','paused','failed','capacity_limited'))`;

const candidateSql = (parameter: number) => `($${parameter}::uuid IS NULL OR EXISTS(
 SELECT 1 FROM liekan_storage_candidate c WHERE c.run_id=$${parameter}::uuid
 AND c.kind='generation' AND c.queue_name='' AND c.record_id=g.generation))`;

const emptySql = generationTables
  .map(
    table => `NOT EXISTS(SELECT 1 FROM ${table} f
     WHERE f.website_id=g.website_id AND f.generation=g.generation)`,
  )
  .join(' AND ');

export async function previewGenerations(tx: AnalysisTx, websiteId: string, cutoff: Date) {
  const [row] = await tx.$queryRawUnsafe<
    { candidate_count: bigint; protected_count: bigint; estimated_bytes: string }[]
  >(
    `WITH generations AS (
     SELECT g.estimated_bytes,${unreferencedGenerationSql} AS eligible
     FROM liekan_analysis_generation g WHERE g.website_id=$1::uuid AND g.updated_at<$2::timestamptz
    ) SELECT count(*) FILTER(WHERE eligible)::bigint AS candidate_count,
     count(*) FILTER(WHERE NOT eligible)::bigint AS protected_count,
     coalesce(sum(estimated_bytes) FILTER(WHERE eligible),0)::text AS estimated_bytes FROM generations`,
    websiteId,
    cutoff,
  );
  return {
    candidateCount: Number(row.candidate_count),
    protectedCount: Number(row.protected_count),
    estimatedBytes: row.estimated_bytes,
  };
}

/** Caller holds website then analysis_site FOR UPDATE throughout this short transaction. */
export async function collectGenerationBatch(
  tx: AnalysisTx,
  websiteId: string,
  cutoff: Date,
  limit = 2000,
  runId?: string,
  maxGenerations = 20,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000)
    throw new Error('storage-generation-batch-limit-invalid');
  if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 1 || maxGenerations > 20)
    throw new Error('storage-generation-count-limit-invalid');
  const generations = await tx.$queryRawUnsafe<{ generation: string }[]>(
    runId
      ? `WITH candidates AS MATERIALIZED(
       SELECT selected.generation FROM liekan_storage_candidate c
       CROSS JOIN LATERAL(
        SELECT g.generation FROM liekan_analysis_generation g
        WHERE g.website_id=$1::uuid AND g.generation=c.record_id AND g.updated_at<$2::timestamptz
         AND ${unreferencedGenerationSql} LIMIT 1 FOR UPDATE OF g
       ) selected
       WHERE c.run_id=$3::uuid AND c.kind='generation' AND c.queue_name=''
       ORDER BY c.record_id LIMIT $4::int
      ), marked AS (
       UPDATE liekan_analysis_generation g SET gc_started_at=coalesce(g.gc_started_at,clock_timestamp())
       WHERE g.website_id=$1::uuid AND g.generation IN(SELECT generation FROM candidates)
        AND g.updated_at<$2::timestamptz AND ${candidateSql(3)} AND ${unreferencedGenerationSql}
       RETURNING g.generation
      ) SELECT generation FROM marked ORDER BY generation`
      : `WITH active AS MATERIALIZED(
      SELECT g.generation FROM liekan_analysis_generation g
      WHERE g.website_id=$1::uuid AND g.updated_at<$2::timestamptz AND g.gc_started_at IS NOT NULL
       AND ${candidateSql(3)} AND ${unreferencedGenerationSql}
      ORDER BY g.updated_at,g.generation LIMIT $4::int FOR UPDATE OF g
     ), fresh AS MATERIALIZED(
      SELECT g.generation FROM liekan_analysis_generation g
      WHERE g.website_id=$1::uuid AND g.updated_at<$2::timestamptz AND g.gc_started_at IS NULL
       AND ${candidateSql(3)} AND ${unreferencedGenerationSql}
      ORDER BY g.updated_at,g.generation LIMIT ($4::int-(SELECT count(*) FROM active)) FOR UPDATE OF g
     ), marked AS (
      UPDATE liekan_analysis_generation g SET gc_started_at=coalesce(g.gc_started_at,clock_timestamp())
      WHERE g.website_id=$1::uuid AND g.generation IN(SELECT generation FROM active UNION ALL SELECT generation FROM fresh)
       AND g.updated_at<$2::timestamptz AND ${candidateSql(3)} AND ${unreferencedGenerationSql}
      RETURNING g.generation,g.updated_at
     ) SELECT m.generation FROM marked m
     ORDER BY (NOT EXISTS(SELECT 1 FROM active a WHERE a.generation=m.generation)),m.updated_at,m.generation`,
    websiteId,
    cutoff,
    runId || null,
    maxGenerations,
  );
  if (!generations.length)
    return { rowsDeleted: 0, generationsDeleted: 0, releasedBytes: '0', more: false };

  const generationIds = generations.map(row => row.generation);
  let rowsDeleted = 0;
  for (const table of generationTables) {
    if (rowsDeleted === limit) break;
    rowsDeleted += await tx.$executeRawUnsafe(
      `DELETE FROM ${table} f WHERE (f.tableoid,f.ctid) IN(
       SELECT f.tableoid,f.ctid FROM ${table} f
       WHERE f.website_id=$1::uuid AND f.generation=ANY($2::uuid[]) LIMIT $3)`,
      websiteId,
      generationIds,
      limit - rowsDeleted,
    );
  }
  // The browser fact foreign keys cascade. Prove every family empty before removing each ledger.
  // Ledger removal and the corresponding capacity release commit exactly once together.
  const remainingSql = runId
    ? `EXISTS(SELECT 1 FROM liekan_storage_candidate c
       CROSS JOIN LATERAL(
        SELECT 1 FROM liekan_analysis_generation g
        WHERE g.website_id=$1::uuid AND g.generation=c.record_id AND g.updated_at<$3::timestamptz
         AND ${unreferencedGenerationSql} LIMIT 1
       ) eligible
       WHERE c.run_id=$4::uuid AND c.kind='generation' AND c.queue_name=''
        AND NOT EXISTS(SELECT 1 FROM removed r WHERE r.generation=c.record_id)
       LIMIT 1)`
    : `EXISTS(SELECT 1 FROM liekan_analysis_generation g
       WHERE g.website_id=$1::uuid AND g.updated_at<$3::timestamptz
        AND ${unreferencedGenerationSql}
        AND NOT EXISTS(SELECT 1 FROM removed r WHERE r.generation=g.generation)
       LIMIT 1)`;
  const [released] = await tx.$queryRawUnsafe<
    { generations_deleted: number; released_bytes: string; more: boolean }[]
  >(
    `WITH removed AS (
     DELETE FROM liekan_analysis_generation g
     WHERE g.website_id=$1::uuid AND g.generation=ANY($2::uuid[]) AND g.gc_started_at IS NOT NULL
      AND g.updated_at<$3::timestamptz AND ${candidateSql(4)} AND ${unreferencedGenerationSql} AND ${emptySql}
     RETURNING g.generation,g.estimated_bytes
    ), released AS (
     UPDATE liekan_analysis_site SET derived_bytes=derived_bytes-(SELECT sum(estimated_bytes) FROM removed)
     WHERE website_id=$1::uuid AND EXISTS(SELECT 1 FROM removed) RETURNING website_id
    ), unlinked AS (
     DELETE FROM liekan_storage_candidate c USING removed r
     WHERE c.run_id=$4::uuid AND c.kind='generation' AND c.queue_name='' AND c.record_id=r.generation
     RETURNING c.record_id
    ) SELECT count(*)::int AS generations_deleted,
     coalesce(sum(estimated_bytes),0)::text AS released_bytes,
     ${remainingSql} AS more FROM removed`,
    websiteId,
    generationIds,
    cutoff,
    runId || null,
  );
  return {
    rowsDeleted,
    generationsDeleted: released.generations_deleted,
    releasedBytes: released.released_bytes,
    more: released.more,
  };
}
