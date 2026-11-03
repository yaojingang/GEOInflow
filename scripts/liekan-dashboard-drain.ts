import type { Client } from 'pg';
import { analysisForegroundDemandSql } from '../src/lib/liekan/upstream/dashboard-demand';

export type BenchmarkCohort = { queries: string[]; builds: string[] };

/** Observe a finite benchmark cohort while normal maintenance continues. */
export async function readBenchmarkDemand(
  client: Pick<Client, 'query'>,
  consumers: string[],
  sites: string[],
  includeBuilds: boolean,
  cohort?: BenchmarkCohort,
) {
  return (
    await client.query(
      `WITH RECURSIVE descendants(id) AS(
        SELECT id FROM liekan_analysis_build WHERE id=ANY($5::uuid[])
        UNION SELECT b.id FROM liekan_analysis_build b JOIN descendants p ON b.origin_build_id=p.id
       ) SELECT q.id,q.website_id,q.status,q.target,q.parameters->>'resource' AS resource,q.attempts,q.next_attempt_at
       FROM liekan_analysis_query q WHERE q.status IN('queued','running') AND q.retention_until>clock_timestamp()
        AND (q.website_id=ANY($2::uuid[]) OR EXISTS(SELECT 1 FROM liekan_analysis_query_consumer c WHERE c.job_id=q.id AND c.actor_id=ANY($1::uuid[])))
        AND ($4::uuid[] IS NULL OR q.id=ANY($4::uuid[]) OR ${analysisForegroundDemandSql})
       UNION ALL SELECT b.id,b.website_id,b.status,'build',b.family,b.attempts,b.next_attempt_at FROM liekan_analysis_build b
        WHERE $3::boolean AND b.website_id=ANY($2::uuid[]) AND b.status IN('queued','running')
         AND ($5::uuid[] IS NULL OR b.id IN(SELECT id FROM descendants))`,
      [consumers, sites, includeBuilds, cohort?.queries ?? null, cohort?.builds ?? null],
    )
  ).rows;
}
