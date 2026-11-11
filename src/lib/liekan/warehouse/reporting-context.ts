import type { ControlDatabase } from './control-db';
import { WarehouseConflict } from './control-db';
import type { ReportingMetadata } from './reporting-relations';

// One PG statement observes a coherent control snapshot. Only control metadata
// crosses this boundary; event/log membership and joins remain inside CH.
export async function readReportingMetadata(
  db: Pick<ControlDatabase, 'read'>,
  websiteId: string,
): Promise<ReportingMetadata> {
  const [metadata] = await readReportingMetadataForSites(db, [websiteId]);
  if (!metadata) throw new WarehouseConflict('warehouse-report-boundary-unavailable');
  return metadata;
}

export async function readReportingMetadataForSites(
  db: Pick<ControlDatabase, 'read'>,
  websiteIds: string[],
): Promise<ReportingMetadata[]> {
  const rows = await db.read<{
    website_id: string;
    epoch: string;
    publication: string;
    deletion_revision: string;
    resource_type: ReportingMetadata['resourceKind'];
    control_revision: string;
    catalog_revision: string;
    bookmark_revision: string;
    population: Record<string, unknown>;
    reports: ReportingMetadata['reports'];
    mode: string;
    allowed_hostnames: string[];
    hostnames: ReportingMetadata['hostnames'];
    intervals: ReportingMetadata['intervals'];
    repair_run_id: string | null;
    repair_generation: string | null;
    exclusions: string[];
  }>(
    `SELECT s.website_id,s.epoch::text,s.publication::text,s.deletion_revision::text,s.resource_type,s.catalog_revision::text,coalesce(to_jsonb(s)->>'bookmark_revision','0') AS bookmark_revision,
    concat_ws(':',coalesce(p.revision,0),coalesce(ls.policy_revision,0),coalesce(r.active_revision,0),coalesce((SELECT revision FROM liekan_traffic_governance g WHERE g.website_id=s.website_id),0)) AS control_revision,
    jsonb_build_object('resourceKind',s.resource_type,'policyRevision',coalesce(p.revision,0)::text,'epoch',coalesce(ls.epoch,1)::text,
      'historyActiveGeneration',r.active_generation,'historyRevision',coalesce(r.active_revision,0)::text,
      'governanceRevision',coalesce((SELECT revision FROM liekan_traffic_governance g WHERE g.website_id=s.website_id),0)::text,
      'governanceWatermark',(SELECT max(received_cutoff) FROM liekan_traffic_exclusion x WHERE x.website_id=s.website_id AND x.state='active' AND x.epoch=coalesce(ls.epoch,1)),
      'governanceProcessing',(SELECT jsonb_build_object('computedAt',b.computed_at,'nextWindow',b.next_window,'errorCode',b.error_code) FROM liekan_browser_risk_state b WHERE b.website_id=s.website_id AND b.epoch=coalesce(ls.epoch,1))) AS population,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.report_id,'name',d.name,'type',d.type,'parameters',d.parameters) ORDER BY d.created_at,d.report_id),'[]'::jsonb) FROM report d WHERE d.website_id=s.website_id AND d.type IN('goal','funnel')) AS reports,
    coalesce(p.mode,'standard') AS mode,coalesce(p.allowed_hostnames,ARRAY[]::text[]) AS allowed_hostnames,
    '[]'::jsonb AS hostnames,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('source_id',i.source_id,'starts_us',(extract(epoch FROM i.starts_at)*1000000)::bigint::text,'ends_us',(extract(epoch FROM i.ends_at)*1000000)::bigint::text) ORDER BY i.id),'[]'::jsonb) FROM liekan_log_interval i WHERE i.website_id=s.website_id) AS intervals,
    r.id AS repair_run_id,r.active_generation AS repair_generation,
    (SELECT coalesce(array_agg(x.id ORDER BY x.id),ARRAY[]::uuid[]) FROM liekan_traffic_exclusion x WHERE x.website_id=s.website_id AND x.state='active' AND x.epoch=coalesce(ls.epoch,1)) AS exclusions
    FROM liekan_warehouse_site s LEFT JOIN liekan_collection_policy p ON p.website_id=s.website_id
    LEFT JOIN liekan_log_state ls ON ls.website_id=s.website_id
    LEFT JOIN liekan_history_repair_run r ON r.website_id=s.website_id AND r.campaign_id='traffic-quality-repair-20261022-v1'
    WHERE s.website_id=ANY($1::uuid[]) AND s.state='active' AND (
      (s.resource_type='website' AND EXISTS(SELECT 1 FROM website WHERE website_id=s.website_id AND deleted_at IS NULL)) OR
      (s.resource_type='link' AND EXISTS(SELECT 1 FROM link WHERE link_id=s.website_id AND deleted_at IS NULL)) OR
      (s.resource_type='pixel' AND EXISTS(SELECT 1 FROM pixel WHERE pixel_id=s.website_id AND deleted_at IS NULL)))`,
    [websiteIds],
  );
  return rows.map(row => ({
    boundary: {
      websiteId: row.website_id,
      epoch: row.epoch,
      publication: row.publication,
      deletionRevision: row.deletion_revision,
    },
    resourceKind: row.resource_type,
    controlRevision: row.control_revision,
    catalogRevision: row.catalog_revision,
    bookmarkRevision: row.bookmark_revision,
    population: row.population,
    reports: row.reports,
    policyMode: row.mode,
    allowedHostnames: row.allowed_hostnames,
    hostnames: row.hostnames,
    intervals: row.intervals,
    repairRunId: row.repair_run_id,
    repairGeneration: row.repair_generation,
    exclusions: row.exclusions,
  }));
}
