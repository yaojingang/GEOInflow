import { boundedBrowserEventsSql } from './bounded-browser-events';
import { primary, LiekanError } from './server';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
import { CRAWLER_POPULATION_VERSION } from '../rules/population';
import { staticRequestExtensionPattern } from './log-content-boundary';
import { analyticsRemaining, timedAnalyticsClient } from './analytics-deadline';
import {
  ANALYSIS_ROLLUP_VERSION,
  ANALYSIS_GLOBAL_LIMIT,
  ANALYSIS_SITE_LIMIT,
  type AnalysisTx,
} from './analysis-rollups-model';

export async function analysisTransaction<T>(
  work: (tx: AnalysisTx) => Promise<T>,
  isolationLevel: 'ReadCommitted' | 'RepeatableRead' = 'ReadCommitted',
  deadline?: number,
): Promise<T> {
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new LiekanError('数据库设置无效', 500);
  const remaining = deadline === undefined ? 30000 : analyticsRemaining(deadline);
  return primary().$transaction(
    async (tx: AnalysisTx) => {
      if (deadline !== undefined) tx = timedAnalyticsClient(tx, deadline);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout TO '5s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout TO '2s'");
      return work(tx);
    },
    { timeout: Math.min(30000, remaining), maxWait: Math.min(1000, remaining), isolationLevel },
  ) as Promise<T>;
}

/** Optional readers retain native link/pixel handling when no website identity exists. */
export async function findAnalysisVersions(tx: AnalysisTx, websiteId: string) {
  const [row] = await tx.$queryRawUnsafe<{ versions: Record<string, unknown> }[]>(
    'SELECT liekan_analysis_versions($1::uuid,$2::text,$3::text,$4::text) AS versions',
    websiteId,
    ANALYSIS_ROLLUP_VERSION,
    TRAFFIC_POLICY_VERSION,
    CRAWLER_POPULATION_VERSION,
  );
  return row?.versions || null;
}

/** Workers and management require a website identity in the same query snapshot. */
export async function analysisVersions(tx: AnalysisTx, websiteId: string) {
  const versions = await findAnalysisVersions(tx, websiteId);
  if (!versions) throw new LiekanError('站点不存在', 404);
  return versions;
}

export const analysisTables = [
  'liekan_storage_policy',
  'liekan_storage_cleanup',
  'liekan_storage_candidate',
  'liekan_storage_operation',
  'liekan_analysis_site',
  'liekan_analysis_visit_guard',
  'liekan_analysis_log',
  'liekan_analysis_path',
  'liekan_analysis_visit',
  'liekan_analysis_manifest',
  'liekan_analysis_dirty',
  'liekan_analysis_meter',
  'liekan_analysis_build',
  'liekan_analysis_operation',
  'liekan_analysis_generation',
  'liekan_analysis_query',
  'liekan_analysis_query_consumer',
  'liekan_analysis_background_lease',
  'liekan_analysis_dashboard_lease',
  'liekan_analysis_read_lease',
  'liekan_analysis_query_viewer',
  'liekan_analysis_probe',
  'liekan_dashboard_snapshot',
  'liekan_report_fragment',
  'liekan_analytics_input_summary',
  'liekan_analytics_input_state',
  'liekan_dashboard_dirty',
  'liekan_analysis_browser_detail',
  'liekan_analysis_browser_visit',
  'liekan_analysis_browser_path',
] as const;
export async function analysisCapacity(tx: AnalysisTx, websiteId: string) {
  // Partition parents have no storage. Include every descendant exactly once.
  const [physical] = await tx.$queryRawUnsafe<{ bytes: bigint }[]>(
    `WITH RECURSIVE relations(oid) AS (
      SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])
      UNION SELECT i.inhrelid FROM pg_inherits i JOIN relations r ON r.oid=i.inhparent
     ) SELECT coalesce(sum(pg_total_relation_size(oid)),0)::bigint AS bytes FROM relations`,
    [...analysisTables],
  );
  const [site] = await tx.$queryRawUnsafe<{ bytes: bigint }[]>(
    `SELECT (derived_bytes+pg_column_size(s)*2+coalesce((SELECT sum(bytes) FROM liekan_analysis_meter m WHERE m.website_id=s.website_id),0)
       +coalesce((SELECT sum(result_bytes) FROM liekan_analysis_query q WHERE q.website_id=s.website_id),0)*2
       +coalesce((SELECT sum(result_bytes) FROM liekan_dashboard_snapshot d WHERE d.website_id=s.website_id),0)*2
       +coalesce((SELECT sum(result_bytes) FROM liekan_report_fragment f WHERE f.website_id=s.website_id),0)*2
       +(SELECT count(*)*512 FROM liekan_analytics_input_summary i WHERE i.website_id=s.website_id)
       +(SELECT count(*)*512 FROM liekan_analytics_input_state i WHERE i.website_id=s.website_id))::bigint AS bytes
     FROM liekan_analysis_site s WHERE website_id=$1::uuid`,
    websiteId,
  );
  // Reserve bounded control/marker/index overhead, including 32 visit guard rows per site,
  // in addition to charged generation tuples.
  const reserve = 16 * 1024 ** 2;
  return {
    siteBytes: String((site?.bytes || 0n) + BigInt(reserve)),
    globalBytes: String(physical.bytes),
    siteLimit: ANALYSIS_SITE_LIMIT,
    globalLimit: ANALYSIS_GLOBAL_LIMIT,
  };
}

export async function ensureAnalysisPartitions(tx: AnalysisTx, hour: string) {
  const date = new Date(hour);
  const starts = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const ends = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  const suffix = `${starts.getUTCFullYear()}_${String(starts.getUTCMonth() + 1).padStart(2, '0')}`;
  for (const table of [
    'liekan_analysis_log',
    'liekan_analysis_path',
    'liekan_analysis_visit',
    'liekan_analysis_browser_visit',
    'liekan_analysis_browser_path',
  ]) {
    const child = `${table}_${suffix}`;
    const [existing] = await tx.$queryRawUnsafe<{ found: boolean }[]>(
      'SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=$1) AS found',
      child,
    );
    if (!existing.found)
      await tx.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS ${child} PARTITION OF ${table} FOR VALUES FROM ('${starts.toISOString()}') TO ('${ends.toISOString()}')`,
      );
  }
}
export async function chargeAnalysisGeneration(
  tx: AnalysisTx,
  websiteId: string,
  generation: string,
  bytes: string,
) {
  const charged = await tx.$executeRawUnsafe(
    `INSERT INTO liekan_analysis_generation(website_id,generation,estimated_bytes)
    VALUES($1::uuid,$2::uuid,$3::bigint) ON CONFLICT(website_id,generation) DO UPDATE
    SET estimated_bytes=liekan_analysis_generation.estimated_bytes+EXCLUDED.estimated_bytes,updated_at=clock_timestamp()
    WHERE liekan_analysis_generation.gc_started_at IS NULL`,
    websiteId,
    generation,
    bytes,
  );
  if (charged !== 1) throw new Error('analysis-generation-collecting');
  await tx.$executeRawUnsafe(
    'UPDATE liekan_analysis_site SET derived_bytes=derived_bytes+$2::bigint WHERE website_id=$1::uuid',
    websiteId,
    bytes,
  );
}

export async function assertAnalysisGenerationWritable(
  tx: AnalysisTx,
  websiteId: string,
  generation: string,
) {
  const [row] = await tx.$queryRawUnsafe<{ generation: string }[]>(
    `SELECT generation FROM liekan_analysis_generation
     WHERE website_id=$1::uuid AND generation=$2::uuid AND gc_started_at IS NULL FOR SHARE`,
    websiteId,
    generation,
  );
  if (!row) throw new Error('analysis-generation-collecting');
}

export function analysisLogDimensionsSql(productFormSql: string) {
  return `jsonb_build_object(
 'bot',l.bot,'vendor',l.vendor,'type',l.bot_type,'crawlerId',l.reporting_crawler_id,
 'catalogVersion',l.reporting_catalog_version,'classificationVersion',l.reporting_classification_version,
 'aiEligible',l.ai_eligible,'recognitionState',l.recognition_state,'verification',l.verification,
 'selfCheck',l.user_agent LIKE 'Liekan-Crawler-Check/%','status',l.status,
 'staticResource',l.path ~* '${staticRequestExtensionPattern}',
 'productForm',${productFormSql})`;
}
/** Read each disjoint gap through the canonical reporting view with indexed time bounds. */
export function analysisLogRawRowsSql(gaps: 'reporting_gaps' | 'series_gaps' | 'expansion_gaps') {
  return `reporting_bounds AS MATERIALIZED(
   SELECT lower(span) AS starts,upper(span) AS ends
   FROM (SELECT unnest(range_agg(tstzrange(starts,ends,'[)'))) AS span FROM ${gaps}) merged
  ), reporting_raw AS MATERIALIZED(
   SELECT l.* FROM reporting_bounds b CROSS JOIN LATERAL(
    SELECT l.path,l.created_at,l.bot,l.vendor,l.bot_type,l.reporting_crawler_id,l.reporting_catalog_version,
     l.reporting_classification_version,l.ai_eligible,l.recognition_state,l.verification,l.user_agent,l.status
    FROM liekan_reporting_log l WHERE l.website_id=$1::uuid AND l.created_at>=b.starts AND l.created_at<b.ends OFFSET 0
   ) l
  )`;
}
export function analysisLogRawFactsSql(gaps: 'reporting_gaps' | 'series_gaps' | 'expansion_gaps') {
  return `${analysisLogRawRowsSql(gaps)}, reporting_catalogs AS MATERIALIZED(
   SELECT DISTINCT reporting_catalog_version FROM reporting_raw WHERE reporting_catalog_version IS NOT NULL
  ), reporting_forms AS MATERIALIZED(
   SELECT DISTINCT ON(v.version,item.identity->>'id') v.version,item.identity->>'id' AS crawler_id,
    item.identity->>'productForm' AS product_form
   FROM reporting_catalogs used JOIN liekan_crawler_registry_version v ON v.version=used.reporting_catalog_version
   CROSS JOIN LATERAL jsonb_array_elements(v.payload->'identities') WITH ORDINALITY item(identity,ordinal)
   ORDER BY v.version,item.identity->>'id',item.ordinal
  ), reporting_facts AS MATERIALIZED(
   SELECT l.path,l.created_at,${analysisLogDimensionsSql('f.product_form')} AS dimensions
   FROM reporting_raw l LEFT JOIN reporting_forms f ON f.version=l.reporting_catalog_version AND f.crawler_id=l.reporting_crawler_id
  )`;
}
function analysisVisitDimensionsSql(geography = true) {
  return `jsonb_build_object(
 'sessionPresent',s.session_id IS NOT NULL,'browser',e.liekan_browser,'os',e.liekan_os,'device',e.liekan_device,'screen',e.liekan_screen,'language',e.liekan_language,
 ${geography ? "'country',e.liekan_country,'region',e.liekan_region,'city',e.liekan_city," : ''}
 'identityAvailable',e.liekan_identity_available,'identityVersion',env.identity_version,
 'ruleVersion',q.rule_version,'catalogVersion',q.catalog_version::text)`;
}
export const visitDimensionsSql = analysisVisitDimensionsSql();
export const visitEvidenceJoinsSql = `LEFT JOIN session s ON s.session_id=e.session_id AND s.website_id=e.website_id
 LEFT JOIN liekan_event_environment env ON env.website_id=e.website_id AND env.event_id=e.event_id
 LEFT JOIN liekan_reporting_event_quality q ON q.website_id=e.website_id AND q.event_id=e.event_id`;

/** Persist observed identity coverage beside qualified facts; metric readers filter the verdict. */
export function analysisVisitRowsSql(
  condition: string,
  source?: string,
  geography = true,
  includeUnqualified = true,
) {
  const dimensions = analysisVisitDimensionsSql(geography);
  return `${source ? '' : `WITH ${boundedBrowserEventsSql(condition, { geography, environment: true })}`}
   SELECT e.event_id,e.created_at,e.session_id,e.visit_id,coalesce(e.hostname,'') AS hostname,e.event_type,${dimensions} AS dimensions
   FROM ${source || 'bounded_events'} e ${visitEvidenceJoinsSql} WHERE ${condition}${
     includeUnqualified
       ? `
   UNION ALL
   SELECT e.event_id,e.created_at,e.session_id,e.visit_id,coalesce(e.hostname,''),e.event_type,
    jsonb_build_object('identityAvailable',false,'identityVersion',env.identity_version,'ruleVersion',q.rule_version,'catalogVersion',q.catalog_version::text)
   FROM bounded_keys k CROSS JOIN LATERAL(SELECT e.* FROM liekan_observed_browser_event e
    WHERE e.website_id=$1::uuid AND e.event_id=k.event_id OFFSET 0) e
   LEFT JOIN liekan_event_environment env ON env.website_id=e.website_id AND env.event_id=e.event_id
   LEFT JOIN liekan_reporting_event_quality q ON q.website_id=e.website_id AND q.event_id=e.event_id
   WHERE ${condition} AND NOT EXISTS(SELECT 1 FROM liekan_browser_identity qualified
    JOIN session present ON present.session_id=e.session_id AND present.website_id=e.website_id
    WHERE qualified.website_id=e.website_id AND qualified.event_id=e.event_id)`
       : ''
}`;
}
