import { clearAiWebsiteInTransaction } from './ai-lifecycle';
import { clearHistoryRepair, invalidateHistoryRepair } from './history-repair-lifecycle';
import { lockWritableWebsite, type WriteIdentity } from './server';

// Head is first so publication is fenced before snapshot rows disappear.
export const LIEKAN_GEO_TABLES = [
  'liekan_geo_weight_head',
  'liekan_geo_weight_snapshot',
  'liekan_geo_weight_evidence_revision',
] as const;
export const LIEKAN_RESET_FACT_TABLES = [
  'liekan_geography_ingress',
  'liekan_collection_diagnostic',
  'liekan_collection_diagnostic_state',
  'liekan_browser_risk_window',
  'liekan_browser_risk_state',
  'liekan_collection_receipt',
  'liekan_event_observation',
  'liekan_observation_state',
  'liekan_event_quality',
  'liekan_collection_hostname',
  'liekan_crawler_finding_window',
  'liekan_crawler_finding',
  'liekan_crawler_quality',
  'liekan_crawler_catalog_snapshot',
  'liekan_crawler_analysis_state',
] as const;
export const LIEKAN_RESET_TAIL_TABLES = [
  'liekan_log',
  'liekan_import',
  'liekan_crawler_rule_version',
] as const;
export const LIEKAN_DELETE_FACT_TABLES = [
  'liekan_crawler_rule_version',
  'liekan_geography_ingress',
  'liekan_browser_risk_window',
  'liekan_browser_risk_state',
  'liekan_collection_diagnostic',
  'liekan_collection_diagnostic_state',
] as const;

async function clearGeoSnapshots(tx: any, websiteId: string) {
  for (const table of LIEKAN_GEO_TABLES)
    await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE website_id=$1::uuid`, websiteId);
}
export async function resetLiekanStatistics(tx: any, websiteId: string, identity?: WriteIdentity) {
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid database schema');
  await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
  await lockWritableWebsite(tx, websiteId, identity);
  await tx.$queryRawUnsafe(
    'SELECT website_id FROM liekan_analysis_site WHERE website_id=$1::uuid FOR UPDATE',
    websiteId,
  );
  await clearAiWebsiteInTransaction(tx, websiteId);
  await clearHistoryRepair(tx, websiteId);
  await clearGeoSnapshots(tx, websiteId);
  await tx.$executeRawUnsafe(
    'DELETE FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
    websiteId,
  );
  for (const table of LIEKAN_RESET_FACT_TABLES)
    await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE website_id=$1::uuid`, websiteId);
  await tx.$executeRawUnsafe(
    "UPDATE liekan_crawler_check SET state='cancelled',result=NULL,completed_at=now() WHERE website_id=$1::uuid AND state IN('queued','running')",
    websiteId,
  );
  await tx.$executeRawUnsafe(
    "DELETE FROM liekan_crawler_check WHERE website_id=$1::uuid AND state NOT IN('queued','running')",
    websiteId,
  );
  await tx.$executeRawUnsafe(
    'INSERT INTO liekan_log_state(website_id,epoch,reset_at,data_revision,policy_revision) VALUES($1::uuid,2,clock_timestamp(),1,1) ON CONFLICT(website_id) DO UPDATE SET epoch=liekan_log_state.epoch+1,reset_at=clock_timestamp(),data_revision=liekan_log_state.data_revision+1,policy_revision=liekan_log_state.policy_revision+1',
    websiteId,
  );
  await tx.$executeRawUnsafe(
    "UPDATE liekan_ingest_batch SET state='cancelled',payload=NULL WHERE website_id=$1::uuid AND state='pending'",
    websiteId,
  );
  await tx.$executeRawUnsafe('DELETE FROM liekan_log_grant WHERE website_id=$1::uuid', websiteId);
  await tx.$executeRawUnsafe(
    'UPDATE liekan_oauth_cleanup SET expires_at=clock_timestamp() WHERE website_id=$1::uuid',
    websiteId,
  );
  await tx.$executeRawUnsafe(
    'DELETE FROM liekan_log_interval WHERE website_id=$1::uuid',
    websiteId,
  );
  await tx.$executeRawUnsafe(
    "INSERT INTO liekan_log_interval(id,website_id,source_id,starts_at) SELECT gen_random_uuid(),website_id,id,clock_timestamp() FROM liekan_log_source WHERE website_id=$1::uuid AND state='active'",
    websiteId,
  );
  for (const table of LIEKAN_RESET_TAIL_TABLES)
    await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE website_id=$1::uuid`, websiteId);
  await tx.$executeRawUnsafe(
    'DELETE FROM liekan_geo_weight_evidence_revision WHERE website_id=$1::uuid',
    websiteId,
  );
}
export async function stopWebsiteSources(tx: any, websiteId: string, deleted = false) {
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid database schema');
  await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
  await lockWritableWebsite(tx, websiteId);
  await tx.$queryRawUnsafe(
    'SELECT website_id FROM liekan_analysis_site WHERE website_id=$1::uuid FOR UPDATE',
    websiteId,
  );
  if (deleted) {
    await clearHistoryRepair(tx, websiteId, true);
    await clearGeoSnapshots(tx, websiteId);
    await tx.$executeRawUnsafe(
      'DELETE FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
      websiteId,
    );
  } else await invalidateHistoryRepair(tx, websiteId);
  await tx.$executeRawUnsafe(
    'UPDATE liekan_crawler_state SET generation=generation+1,deleted_at=CASE WHEN $2 THEN now() ELSE deleted_at END,updated_at=now() WHERE website_id=$1::uuid',
    websiteId,
    deleted,
  );
  await tx.$executeRawUnsafe(
    "UPDATE liekan_crawler_connection SET state='frozen',token_encrypted=NULL,updated_at=now() WHERE website_id=$1::uuid AND state IN('active','cleanup')",
    websiteId,
  );
  await tx.$executeRawUnsafe(
    "UPDATE liekan_crawler_deployment SET state='failed',error_code='website-changed',completed_at=now(),updated_at=now() WHERE website_id=$1::uuid AND state='queued'",
    websiteId,
  );
  await tx.$executeRawUnsafe(
    "UPDATE liekan_crawler_check SET state='cancelled',result=NULL,completed_at=now() WHERE website_id=$1::uuid AND state IN('queued','running')",
    websiteId,
  );
  await tx.$executeRawUnsafe(
    'DELETE FROM liekan_crawler_domain_verification WHERE website_id=$1::uuid',
    websiteId,
  );
  await tx.$queryRawUnsafe(
    `UPDATE liekan_log_source SET state=$2,credential_hash=NULL,error_code='website-changed' WHERE website_id=$1::uuid AND state!='disconnected' RETURNING id,kind,provider_job_id`,
    websiteId,
    deleted ? 'disconnected' : 'paused',
  );
  await tx.$executeRawUnsafe(
    'UPDATE liekan_log_interval SET ends_at=clock_timestamp() WHERE website_id=$1::uuid AND ends_at IS NULL',
    websiteId,
  );
  await tx.$executeRawUnsafe(
    "UPDATE liekan_ingest_batch SET state='cancelled',payload=NULL WHERE website_id=$1::uuid AND state='pending'",
    websiteId,
  );
  await tx.$executeRawUnsafe('DELETE FROM liekan_log_grant WHERE website_id=$1::uuid', websiteId);
  await tx.$executeRawUnsafe(
    'UPDATE liekan_oauth_cleanup SET expires_at=clock_timestamp() WHERE website_id=$1::uuid',
    websiteId,
  );
  await tx.$executeRawUnsafe(
    'UPDATE liekan_log_state SET policy_revision=policy_revision+1 WHERE website_id=$1::uuid',
    websiteId,
  );
  if (deleted) {
    for (const table of LIEKAN_DELETE_FACT_TABLES)
      await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE website_id=$1::uuid`, websiteId);
  }
  // Provider cleanup is reconciled from these durable source rows by the worker.
}
