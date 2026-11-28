// The first eligible observation can precede every scoring window.
import { pendingBeforeSql } from '../log-ingestion/pending';
import { warehouseTime } from '../warehouse/fact-input';
import { geoLogFingerprint, v2Tables } from '../warehouse-v2/schema';
import { warehouseReportQuery } from './warehouse-report-snapshot';
import type { AiTx } from './ai-db';

export async function geoLogHistory(site: string, end: number, signal?: AbortSignal) {
  const hour = Math.floor(end / 3600000) * 3600000;
  const scope = `FROM ${v2Tables.logs} WHERE website_id={wh_site:UUID}
    AND epoch={wh_epoch:UInt64} AND _deleted=0`;
  const counts = `count() AS rows, toString(${geoLogFingerprint}) AS fingerprint`;
  const rows = await warehouseReportQuery<{ segment: string; rows: string; fingerprint: string }>(
    site,
    `SELECT 'hours' AS segment, ${counts} ${scope} AND hour < {geoHour:DateTime('UTC')}
     ${
       hour === end
         ? ''
         : `UNION ALL SELECT 'edge' AS segment, ${counts} ${scope}
      AND hour={geoHour:DateTime('UTC')} AND created_at<{geoEnd:DateTime64(6,'UTC')}`
     }`,
    { geoHour: warehouseTime(new Date(hour)).slice(0, 19), geoEnd: warehouseTime(new Date(end)) },
    { signal },
  );
  if (rows.length !== (hour === end ? 1 : 2)) throw new Error('geo-history-incomplete');
  return rows.sort((a, b) => a.segment.localeCompare(b.segment));
}

// Keep one flag per scoring window: a newer pending batch cannot mask an older backfill.
export const geoPendingWindowsSql = `ARRAY(SELECT EXISTS(
    SELECT 1 FROM liekan_ingest_batch WHERE website_id=$1 AND ${pendingBeforeSql('cutoff')}
  ) FROM unnest($2::timestamptz[]) AS windows(cutoff) ORDER BY cutoff)`;

// Interval bounds are clipped at the historical cutoff. Progress after that cutoff
// cannot affect this score. Archived rule/registry/range payloads are immutable;
// include their PG row versions to also detect replacement or removal.
export async function geoControlHistory(tx: AiTx, site: string, start: number, end: number) {
  const [row] = await tx.query<{ revision: string }>(
    `SELECT md5(jsonb_build_array(
        (SELECT policy_revision FROM liekan_log_state WHERE website_id=$1),
        ARRAY(SELECT jsonb_build_array(source_id, greatest(starts_at,$2),least(ends_at,$3),state,
            evidence->>'basis',evidence->>'classificationVersion',evidence->>'sourceVersion') AS q
          FROM liekan_crawler_quality WHERE website_id=$1 AND starts_at<$3 AND ends_at>$2 ORDER BY q),
        ARRAY(SELECT jsonb_build_array(source_id,starts_at,least(ends_at,$3),ends_at IS NULL) AS i
          FROM liekan_log_interval WHERE website_id=$1 AND starts_at<$3 ORDER BY i),
        ARRAY(SELECT jsonb_build_array(id,domain) FROM liekan_log_source WHERE website_id=$1 ORDER BY id),
        ARRAY(SELECT jsonb_build_array(version,xmin::text) FROM liekan_crawler_rule_version WHERE website_id=$1 ORDER BY version),
        ARRAY(SELECT jsonb_build_array(version,xmin::text) FROM liekan_crawler_registry_version ORDER BY version),
        ARRAY(SELECT jsonb_build_array(version,xmin::text) AS r FROM liekan_crawler_range_snapshot ORDER BY r),
        (SELECT version FROM liekan_crawler_registry_current WHERE id=1)
      )::text) AS revision`,
    site,
    new Date(start),
    new Date(end),
  );
  return row.revision;
}
