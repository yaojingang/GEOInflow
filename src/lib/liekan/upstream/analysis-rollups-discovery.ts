import { analysisTransaction } from './analysis-rollups-db';
import {
  analysisPathCoverageSql,
  ANALYSIS_ROLLUP_VERSION,
  type AnalysisTx,
} from './analysis-rollups-model';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
import { CRAWLER_POPULATION_VERSION } from '../rules/population';
import { storageHistorySiteAllowedSql } from './storage-capacity';

const phases = ['finite-log', 'finite-visit', 'stale-log', 'stale-visit', 'hour-log'] as const;
type Phase = (typeof phases)[number];
type Site = {
  website_id: string;
  epoch: bigint;
  versions: Record<string, unknown>;
  path_expansion: boolean;
  visit_expansion: boolean;
  discovery_cursors: Partial<Record<Phase, string>>;
};
type RecoveryWriter = (
  tx: AnalysisTx,
  site: string,
  epoch: string,
  family: 'log' | 'visit',
  from: Date,
  until: Date,
  actorId: null,
  origin: string,
  originBuildId?: string | null,
  excludingBuildId?: string | null,
  requestedUnit?: 300 | 3600,
) => Promise<number>;
const active = (
  start: string,
  end: string,
  unit: string,
) => `EXISTS(SELECT 1 FROM liekan_analysis_build b WHERE b.website_id=p.site AND b.epoch=p.epoch AND b.actor_id IS NULL AND NOT b.automatic_history
 AND b.status IN('queued','running','paused') AND (b.family=p.family OR b.family='both') ${unit ? `AND (b.family='both' OR b.unit_seconds=${unit})` : ''} AND b.range_start<${end} AND b.range_end>${start})`;
// Published manifests are mutually exclusive. Seek the nearest predecessor before
// evaluating coverage, then prove each referenced generation once for all dirty leaves.
const coveringCtes = (
  leavesSql: string,
) => `dirty_leaves AS MATERIALIZED (${leavesSql}), mapped AS MATERIALIZED (
 SELECT d.family,d.bucket,covering.bucket AS manifest_bucket FROM dirty_leaves d CROSS JOIN args p
 LEFT JOIN LATERAL(SELECT m.bucket FROM liekan_analysis_manifest m WHERE m.website_id=p.site AND m.epoch=p.epoch AND m.family=d.family AND m.bucket<=d.bucket
  ORDER BY m.bucket DESC LIMIT 1) covering ON true
), referenced AS MATERIALIZED (SELECT DISTINCT family,manifest_bucket FROM mapped WHERE manifest_bucket IS NOT NULL), proofs AS MATERIALIZED (
 SELECT m.family,m.bucket,m.bucket_end,(m.versions=p.versions AND m.fingerprint=liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,m.bucket,m.bucket_end)) AS current
 FROM referenced r CROSS JOIN args p JOIN liekan_analysis_manifest m ON m.website_id=p.site AND m.epoch=p.epoch AND m.family=r.family AND m.bucket=r.manifest_bucket
), leaf_status AS (SELECT d.family,d.bucket,coalesce(proof.current AND proof.bucket_end>d.bucket,false) AS covered FROM mapped d
 LEFT JOIN proofs proof ON proof.family=d.family AND proof.bucket=d.manifest_bucket)`;

// Eligibility examines metadata. Empty and completely current sites consume no discovery slot.
const eligibleSite = `(
 EXISTS(WITH args AS(SELECT s.website_id AS site,s.epoch,v.versions), ${coveringCtes(`SELECT d.family,d.bucket FROM liekan_analysis_dirty d WHERE d.website_id=s.website_id AND d.epoch=s.epoch AND isfinite(d.bucket)
  AND (d.family<>'visit' OR s.visit_expansion)
  AND d.bucket+(CASE d.family WHEN 'log' THEN interval '5 minutes' ELSE interval '1 hour' END)<=clock_timestamp()-interval '30 seconds' GROUP BY d.family,d.bucket`)}
  SELECT 1 FROM leaf_status d,args p WHERE NOT d.covered
   AND NOT EXISTS(SELECT 1 FROM liekan_analysis_build b WHERE b.website_id=p.site AND b.epoch=p.epoch AND b.actor_id IS NULL AND NOT b.automatic_history
    AND b.status IN('queued','running','paused') AND (b.family=d.family OR b.family='both') AND (b.family='both' OR b.unit_seconds=CASE d.family WHEN 'log' THEN 300 ELSE 3600 END)
    AND b.range_start<=d.bucket AND b.range_end>d.bucket))
 OR EXISTS(SELECT 1 FROM liekan_analysis_manifest m WHERE m.website_id=s.website_id AND m.epoch=s.epoch AND isfinite(m.bucket) AND isfinite(m.bucket_end)
  AND (m.family<>'visit' OR s.visit_expansion)
  AND (m.versions IS DISTINCT FROM v.versions OR m.fingerprint<>liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,m.bucket,m.bucket_end))
  AND NOT EXISTS(SELECT 1 FROM liekan_analysis_build b WHERE b.website_id=s.website_id AND b.epoch=s.epoch AND b.actor_id IS NULL AND NOT b.automatic_history
   AND b.status IN('queued','running','paused') AND (b.family=m.family OR b.family='both') AND (b.family='both' OR b.unit_seconds=CASE m.family WHEN 'log' THEN 300 ELSE 3600 END)
   AND b.range_start<m.bucket_end AND b.range_end>m.bucket))
 OR (s.path_expansion AND EXISTS(SELECT 1 FROM liekan_analysis_manifest m WHERE m.website_id=s.website_id AND m.epoch=s.epoch AND m.family='log' AND m.row_count>0
  AND isfinite(m.bucket) AND NOT ${analysisPathCoverageSql('m')}
  AND date_bin(interval '1 hour',m.bucket,timestamptz '2000-01-01Z')+interval '1 hour'<=clock_timestamp()-interval '30 seconds'
  AND NOT EXISTS(SELECT 1 FROM liekan_analysis_build b WHERE b.website_id=s.website_id AND b.epoch=s.epoch AND b.actor_id IS NULL AND NOT b.automatic_history AND b.family IN('log','both')
   AND b.status IN('queued','running','paused') AND b.range_start<date_bin(interval '1 hour',m.bucket,timestamptz '2000-01-01Z')+interval '1 hour'
   AND b.range_end>date_bin(interval '1 hour',m.bucket,timestamptz '2000-01-01Z'))))
)`;

async function page<T extends { bucket: Date }>(
  tx: AnalysisTx,
  site: Site,
  phase: Phase,
  lane: 'head' | 'backlog',
  body: string,
) {
  const family = phase.endsWith('visit') ? 'visit' : 'log',
    unit = family === 'visit' ? 3600 : 300;
  const query = (cursor: string | null) =>
    tx.$queryRawUnsafe<T[]>(
      `WITH args AS (SELECT $1::uuid AS site,$2::bigint AS epoch,$3::text AS family,$4::timestamptz AS before_at,$5::jsonb AS versions,$6::int AS unit) ${body}`,
      site.website_id,
      String(site.epoch),
      family,
      cursor,
      JSON.stringify(site.versions),
      unit,
    );
  let rows = await query(lane === 'head' ? null : site.discovery_cursors[phase] || null);
  if (lane === 'backlog' && !rows.length && site.discovery_cursors[phase]) rows = await query(null);
  return rows;
}
async function cursor(tx: AnalysisTx, site: Site, phase: Phase, value?: Date) {
  const iso = value?.toISOString();
  await tx.$executeRawUnsafe(
    `UPDATE liekan_analysis_site SET discovery_cursors=CASE WHEN $3::text IS NULL THEN discovery_cursors-$2
  ELSE jsonb_set(discovery_cursors,ARRAY[$2],to_jsonb($3::text),true) END WHERE website_id=$1::uuid AND epoch=$4::bigint`,
    site.website_id,
    phase,
    iso || null,
    String(site.epoch),
  );
  if (iso) site.discovery_cursors[phase] = iso;
  else delete site.discovery_cursors[phase];
}

/** Restore recent interrupted work independently of the historical discovery cursor. */
async function resumeCapacity(tx: AnalysisTx, site: Site) {
  let resumed = 0;
  for (const family of ['log', 'visit']) {
    if (family === 'visit' && !site.visit_expansion) continue;
    const [candidate] = await tx.$queryRawUnsafe<{ id: string }[]>(
      `WITH checked AS MATERIALIZED(
        SELECT m.* FROM liekan_analysis_manifest m WHERE m.website_id=$1::uuid AND m.epoch=$2::bigint
         AND m.family=$3 AND m.versions=$4::jsonb
         AND m.fingerprint=liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,m.bucket,m.bucket_end)
       ), coverage AS(
        SELECT range_agg(tstzrange(m.bucket,m.bucket_end,'[)')) AS low,
         range_agg(tstzrange(m.bucket,m.bucket_end,'[)')) FILTER(WHERE ${analysisPathCoverageSql('m')}) AS paths FROM checked m
       ) SELECT b.id FROM liekan_analysis_build b JOIN liekan_analysis_site s USING(website_id) CROSS JOIN coverage
       WHERE b.website_id=$1::uuid AND b.epoch=$2::bigint AND s.epoch=b.epoch AND s.mode='live'
       AND b.actor_id IS NULL AND NOT b.automatic_history AND b.family=$3
       AND b.status='capacity_limited' AND b.error_code='analysis-capacity-limited'
       AND b.next_attempt_at<=clock_timestamp() AND ${storageHistorySiteAllowedSql}
       AND (b.checkpoint->>'generation' IS NULL OR EXISTS(SELECT 1 FROM liekan_analysis_generation g
         WHERE g.website_id=b.website_id AND g.generation::text=b.checkpoint->>'generation' AND g.gc_started_at IS NULL))
       AND NOT EXISTS(SELECT 1 FROM liekan_analysis_build active WHERE active.website_id=b.website_id AND active.epoch=b.epoch
         AND active.actor_id IS NULL AND NOT active.automatic_history AND active.family IN(b.family,'both')
         AND active.status IN('queued','running','paused') AND active.range_start<b.range_end AND active.range_end>b.range_start)
       AND NOT (tstzmultirange(tstzrange(greatest(b.range_start,coalesce((b.checkpoint->>'hour')::timestamptz,b.range_start)),b.range_end,'[)'))
         <@ coalesce(CASE WHEN b.family='log' AND b.unit_seconds=3600 AND s.path_expansion THEN coverage.paths ELSE coverage.low END, '{}'::tstzmultirange))
       ORDER BY b.range_end DESC,b.updated_at,b.id LIMIT 1 FOR UPDATE OF b SKIP LOCKED`,
      site.website_id,
      String(site.epoch),
      family,
      JSON.stringify(site.versions),
    );
    if (!candidate) continue;
    resumed += await tx.$executeRawUnsafe(
      `UPDATE liekan_analysis_build SET status='queued',attempts=0,error_code=NULL,lease_token=NULL,lease_until=NULL,
       next_attempt_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1::uuid AND status='capacity_limited'`,
      candidate.id,
    );
  }
  return resumed;
}
async function leaves(
  tx: AnalysisTx,
  site: Site,
  phase: 'finite-log' | 'finite-visit',
  queue: RecoveryWriter,
  lane: 'head' | 'backlog',
) {
  const rows = await page<{ bucket: Date; active: boolean; covered: boolean }>(
    tx,
    site,
    phase,
    lane,
    `, ${coveringCtes(`SELECT d.family,d.bucket FROM liekan_analysis_dirty d,args p WHERE d.website_id=p.site AND d.epoch=p.epoch AND d.family=p.family AND isfinite(d.bucket)
   AND d.bucket+p.unit*interval '1 second'<=clock_timestamp()-interval '30 seconds' AND (p.before_at IS NULL OR d.bucket<p.before_at)
  GROUP BY d.family,d.bucket ORDER BY d.bucket DESC LIMIT 32`)}
  SELECT c.bucket,${active('c.bucket', "c.bucket+p.unit*interval '1 second'", 'p.unit')} AS active,c.covered FROM leaf_status c,args p ORDER BY c.bucket DESC`,
  );
  let inspected: Date | undefined,
    queued = 0;
  for (const row of rows) {
    inspected = row.bucket;
    if (row.active || row.covered) continue;
    const family = phase === 'finite-log' ? 'log' : 'visit',
      unit = family === 'log' ? 300 : 3600;
    queued = await queue(
      tx,
      site.website_id,
      String(site.epoch),
      family,
      row.bucket,
      new Date(+row.bucket + unit * 1000),
      null,
      'live',
      null,
      null,
      unit,
    );
    break;
  }
  if (lane === 'backlog') await cursor(tx, site, phase, inspected);
  return queued;
}
async function stale(
  tx: AnalysisTx,
  site: Site,
  phase: 'stale-log' | 'stale-visit',
  queue: RecoveryWriter,
  lane: 'head' | 'backlog',
) {
  const rows = await page<{
    bucket: Date;
    bucket_end: Date;
    build_id: string | null;
    needed: boolean;
    active: boolean;
  }>(
    tx,
    site,
    phase,
    lane,
    `
  SELECT m.bucket,m.bucket_end,m.build_id,(m.versions IS DISTINCT FROM p.versions OR m.fingerprint<>liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,m.bucket,m.bucket_end)) AS needed,
   ${active('m.bucket', 'm.bucket_end', 'p.unit')} AS active
  FROM liekan_analysis_manifest m,args p WHERE m.website_id=p.site AND m.epoch=p.epoch AND m.family=p.family AND isfinite(m.bucket) AND isfinite(m.bucket_end)
   AND (p.before_at IS NULL OR m.bucket<p.before_at) ORDER BY m.bucket DESC LIMIT 32`,
  );
  let inspected: Date | undefined,
    queued = 0;
  for (const row of rows) {
    inspected = row.bucket;
    if (!row.needed || row.active) continue;
    const family = phase === 'stale-log' ? 'log' : 'visit';
    queued = await queue(
      tx,
      site.website_id,
      String(site.epoch),
      family,
      row.bucket,
      row.bucket_end,
      null,
      'manifest-recovery',
      row.build_id,
      null,
      family === 'log' ? 300 : 3600,
    );
    break;
  }
  if (lane === 'backlog') await cursor(tx, site, phase, inspected);
  return queued;
}
async function hours(tx: AnalysisTx, site: Site, queue: RecoveryWriter, lane: 'head' | 'backlog') {
  const rows = await page<{ bucket: Date; hour: Date; eligible: boolean; active: boolean }>(
    tx,
    site,
    'hour-log',
    lane,
    `
  SELECT m.bucket,date_bin(interval '1 hour',m.bucket,timestamptz '2000-01-01Z') AS hour,
   (m.row_count>0 AND NOT ${analysisPathCoverageSql('m')} AND date_bin(interval '1 hour',m.bucket,timestamptz '2000-01-01Z')+interval '1 hour'<=clock_timestamp()-interval '30 seconds') AS eligible,
   ${active("date_bin(interval '1 hour',m.bucket,timestamptz '2000-01-01Z')", "date_bin(interval '1 hour',m.bucket,timestamptz '2000-01-01Z')+interval '1 hour'", '')} AS active
  FROM liekan_analysis_manifest m,args p WHERE m.website_id=p.site AND m.epoch=p.epoch AND m.family=p.family AND isfinite(m.bucket)
   AND (p.before_at IS NULL OR m.bucket<p.before_at) ORDER BY m.bucket DESC LIMIT 32`,
  );
  let inspected: Date | undefined,
    queued = 0;
  for (const row of rows) {
    inspected = row.bucket;
    if (!row.eligible || row.active) continue;
    const end = new Date(+row.hour + 3600000);
    const gaps = await tx.$queryRawUnsafe<{ starts: Date; ends: Date; build_id: string | null }[]>(
      `WITH current_hour AS MATERIALIZED (
    SELECT * FROM liekan_analysis_manifest m WHERE m.website_id=$1::uuid AND m.epoch=$2::bigint AND m.family='log' AND m.bucket<$4 AND m.bucket_end>$3
   ), covered AS (SELECT range_agg(tstzrange(greatest(bucket,$3::timestamptz),least(bucket_end,$4::timestamptz),'[)')) AS spans FROM current_hour m
    WHERE m.versions=$5::jsonb AND m.fingerprint=liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,m.bucket,m.bucket_end)),
   gaps AS (SELECT lower(gap) AS starts,upper(gap) AS ends FROM covered,unnest(tstzmultirange(tstzrange($3::timestamptz,$4::timestamptz,'[)'))-coalesce(spans,'{}'::tstzmultirange)) AS gap)
   SELECT starts,ends,(SELECT min(build_id::text)::uuid FROM current_hour) AS build_id FROM gaps ORDER BY starts LIMIT 1`,
      site.website_id,
      String(site.epoch),
      row.hour,
      end,
      JSON.stringify(site.versions),
    );
    const [origin] = await tx.$queryRawUnsafe<{ build_id: string | null }[]>(
      `SELECT min(build_id::text)::uuid AS build_id FROM liekan_analysis_manifest WHERE website_id=$1::uuid AND epoch=$2::bigint AND family='log' AND bucket<$4 AND bucket_end>$3`,
      site.website_id,
      String(site.epoch),
      row.hour,
      end,
    );
    if (gaps.length)
      queued = await queue(
        tx,
        site.website_id,
        String(site.epoch),
        'log',
        gaps[0].starts,
        gaps[0].ends,
        null,
        'hour-low-gap',
        gaps[0].build_id,
        null,
        300,
      );
    else
      queued = await queue(
        tx,
        site.website_id,
        String(site.epoch),
        'log',
        row.hour,
        end,
        null,
        'hour-consolidation',
        origin.build_id,
        null,
        3600,
      );
    break;
  }
  if (lane === 'backlog') await cursor(tx, site, 'hour-log', inspected);
  return queued;
}

/** Eight sites × five phases × two lanes, plus two interrupted receipts per site. */
export async function discoverAnalysisRollups(queue: RecoveryWriter, recoverCapacity = false) {
  const visited: string[] = [];
  let queued = 0;
  for (let count = 0; count < 8; count++) {
    const result = await analysisTransaction(async tx => {
      const [site] = await tx.$queryRawUnsafe<Site[]>(
        `SELECT s.*,v.versions FROM liekan_analysis_site s
    JOIN website w ON w.website_id=s.website_id AND w.deleted_at IS NULL
    CROSS JOIN LATERAL(SELECT liekan_analysis_versions(s.website_id,$2,$3,$4) AS versions OFFSET 0) v
    WHERE s.mode='live' AND NOT(s.website_id=ANY($1::uuid[])) AND ${eligibleSite}
    ORDER BY s.discovery_checked_at NULLS FIRST,s.website_id LIMIT 1 FOR NO KEY UPDATE OF s SKIP LOCKED`,
        visited,
        ANALYSIS_ROLLUP_VERSION,
        TRAFFIC_POLICY_VERSION,
        CRAWLER_POPULATION_VERSION,
      );
      if (!site) return null;
      let found = recoverCapacity ? await resumeCapacity(tx, site) : 0;
      // Each phase probes the newest 32 rows and independently advances 32 backlog rows.
      // A terminal head conflict cannot suppress the persistent backlog lane.
      for (const lane of ['head', 'backlog'] as const) {
        found += await leaves(tx, site, 'finite-log', queue, lane);
        if (site.visit_expansion) found += await leaves(tx, site, 'finite-visit', queue, lane);
      }
      if (!site.visit_expansion) await cursor(tx, site, 'finite-visit');
      for (const lane of ['head', 'backlog'] as const) {
        found += await stale(tx, site, 'stale-log', queue, lane);
        if (site.visit_expansion) found += await stale(tx, site, 'stale-visit', queue, lane);
      }
      if (!site.visit_expansion) await cursor(tx, site, 'stale-visit');
      if (site.path_expansion)
        for (const lane of ['head', 'backlog'] as const)
          found += await hours(tx, site, queue, lane);
      else await cursor(tx, site, 'hour-log');
      await tx.$executeRawUnsafe(
        'UPDATE liekan_analysis_site SET discovery_checked_at=clock_timestamp() WHERE website_id=$1::uuid AND epoch=$2::bigint',
        site.website_id,
        String(site.epoch),
      );
      return { websiteId: site.website_id, queued: found };
    });
    if (!result) break;
    visited.push(result.websiteId);
    queued += result.queued;
  }
  return { queued };
}
