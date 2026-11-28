import type { CrawlerCoverage } from '../contracts/crawler-quality';
import { crawlerClassificationVersion } from './crawler-evidence';
import type { BotRule } from '../rules/bots';
import type { CrawlerRuleConfiguration } from '../rules/configuration';
import { warehouseEnabled } from '../warehouse/authority-routing';
import {
  acceptWarehouseCrawlerCoverage,
  type WarehouseCrawlerCoverage,
} from '../upstream/warehouse-crawler-coverage';

// This attests to the collector's observed file range and processed batches.
// It cannot establish that the upstream web server logged every request.
export async function recordCrawlerCoverage(
  tx: any,
  source: { id: string; website_id: string; kind: string; state: string },
  epoch: number,
  health: { pending: number; gap: boolean; errorCode: string; coverage?: CrawlerCoverage },
  rules: BotRule[],
  now = Date.now(),
  configuration?: CrawlerRuleConfiguration,
  warehouseProof?: WarehouseCrawlerCoverage,
) {
  const proof = health.coverage;
  if (source.kind !== 'server' || source.state !== 'active') return;
  if (health.gap || health.errorCode === 'rotation-gap' || health.errorCode === 'format-error') {
    const [last] = await tx.$queryRawUnsafe(
      "SELECT max(ends_at) AS ending FROM liekan_crawler_quality WHERE website_id=$1::uuid AND source_id=$2::uuid AND state='complete'",
      source.website_id,
      source.id,
    );
    if (last?.ending && +new Date(last.ending) < now)
      await tx.$executeRawUnsafe(
        `INSERT INTO liekan_crawler_quality(website_id,source_id,starts_at,ends_at,state,evidence)
      VALUES($1::uuid,$2::uuid,$3,$4,'partial',$5::jsonb) ON CONFLICT(website_id,source_id,starts_at) DO UPDATE SET ends_at=GREATEST(liekan_crawler_quality.ends_at,EXCLUDED.ends_at),state='partial',evidence=EXCLUDED.evidence,recorded_at=now()`,
        source.website_id,
        source.id,
        new Date(last.ending),
        new Date(now),
        JSON.stringify({
          basis: 'ingestion_time',
          reason: health.errorCode,
          gap: health.gap,
          epoch,
        }),
      );
    return { gapRecorded: true };
  }
  if (
    !proof ||
    proof.epoch !== epoch ||
    health.pending ||
    health.errorCode !== 'none' ||
    proof.endsAt > now ||
    proof.cursors.some(cursor => cursor.confirmed !== cursor.read)
  )
    return;
  const classificationVersion = crawlerClassificationVersion(rules, configuration);
  const warehouse = warehouseEnabled();
  if (
    warehouse &&
    (!warehouseProof ||
      !(await acceptWarehouseCrawlerCoverage(
        tx,
        warehouseProof,
        source.website_id,
        source.id,
        epoch,
        proof,
        classificationVersion,
      )))
  )
    return;
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout TO '5000ms'");
  const batchRows = await tx.$queryRawUnsafe(
    warehouse
      ? `SELECT b.id,b.epoch,b.state,b.rejected,b.received_at FROM liekan_ingest_batch b
         WHERE b.website_id=$3::uuid AND b.source_id=$1::uuid AND b.id=ANY($2::uuid[])`
      : `SELECT b.id,b.epoch,b.state,b.rejected,b.received_at,min(l.created_at) AS first_event,max(l.created_at) AS last_event
    FROM liekan_ingest_batch b LEFT JOIN liekan_log l ON l.import_id=b.id AND l.website_id=b.website_id
    WHERE b.source_id=$1::uuid AND b.id=ANY($2::uuid[]) GROUP BY b.id`,
    source.id,
    [proof.fromBatchId, proof.toBatchId],
    ...(warehouse ? [source.website_id] : []),
  );
  const batches = warehouse
    ? batchRows.map((row: any) => ({
        ...row,
        ...warehouseProof.batches.find(b => b.id === row.id),
      }))
    : batchRows;
  const first = batches.find((row: any) => row.id === proof.fromBatchId),
    last = batches.find((row: any) => row.id === proof.toBatchId);
  if (
    !first ||
    !last ||
    batches.some(
      (row: any) => row.epoch !== epoch || row.state !== 'processed' || row.rejected > 0,
    ) ||
    !first.first_event ||
    !last.last_event ||
    proof.startsAt < +new Date(first.first_event) ||
    proof.endsAt > +new Date(last.last_event)
  )
    return;
  const [pending] = await tx.$queryRawUnsafe(
    `SELECT count(*)::int AS count FROM liekan_ingest_batch WHERE source_id=$1::uuid AND epoch=$2 AND received_at>=$3 AND (state!='processed' OR rejected>0)`,
    source.id,
    epoch,
    first.received_at,
  );
  const [interval] = await tx.$queryRawUnsafe(
    `SELECT id FROM liekan_log_interval WHERE source_id=$1::uuid AND starts_at<=$2 AND (ends_at IS NULL OR ends_at>=$3)`,
    source.id,
    new Date(proof.startsAt),
    new Date(proof.endsAt),
  );
  if (pending.count || !interval?.id) return;
  const [previous] = warehouse
    ? []
    : await tx.$queryRawUnsafe(
        "SELECT ends_at,recorded_at FROM liekan_crawler_quality WHERE website_id=$1::uuid AND source_id=$2::uuid AND starts_at=$3 AND state='complete' AND evidence->>'classificationVersion'=$4 AND evidence->>'epoch'=$5",
        source.website_id,
        source.id,
        new Date(proof.startsAt),
        classificationVersion,
        String(epoch),
      );
  // Source locking serializes this proof with ingestion. Recheck new imports for late events.
  const candidates = previous
    ? `SELECT l.* FROM liekan_effective_log l WHERE l.source_id=$1::uuid AND l.created_at>=$2 AND l.created_at<=$3
    UNION ALL SELECT l.* FROM liekan_import i JOIN liekan_effective_log l ON l.import_id=i.id WHERE i.source_id=$1::uuid AND i.imported_at>=$5 AND l.created_at>=$6 AND l.created_at<=$3`
    : 'SELECT l.* FROM liekan_effective_log l WHERE l.source_id=$1::uuid AND l.created_at>=$2 AND l.created_at<=$3';
  const changed = warehouse
    ? warehouseProof.changed
      ? [1]
      : []
    : await tx.$queryRawUnsafe(
        `SELECT 1 FROM (${candidates}) l LEFT JOIN liekan_crawler_evidence e ON e.website_id=l.website_id AND e.log_id=l.id WHERE e.classification_version IS DISTINCT FROM $4 LIMIT 1`,
        source.id,
        new Date(previous ? Math.max(proof.startsAt, +new Date(previous.ends_at)) : proof.startsAt),
        new Date(proof.endsAt),
        classificationVersion,
        ...(previous ? [previous.recorded_at, new Date(proof.startsAt)] : []),
      );
  if (changed.length) return;
  const evidence = {
    basis: 'event_time',
    declaration: 'collector_observed_file_range',
    classificationVersion,
    sourceVersion: source.id + ':' + interval.id,
    epoch,
    fromBatchId: proof.fromBatchId,
    toBatchId: proof.toBatchId,
    cursors: proof.cursors,
    rotationGap: false,
    truncationGap: false,
    parserRejected: 0,
    processed: true,
  };
  await tx.$executeRawUnsafe(
    `INSERT INTO liekan_crawler_quality(website_id,source_id,starts_at,ends_at,state,evidence) VALUES($1::uuid,$2::uuid,$3,$4,'complete',$5::jsonb)
    ON CONFLICT(website_id,source_id,starts_at) DO UPDATE SET ends_at=GREATEST(liekan_crawler_quality.ends_at,EXCLUDED.ends_at),evidence=EXCLUDED.evidence,recorded_at=now() WHERE liekan_crawler_quality.state='complete' AND liekan_crawler_quality.evidence->>'classificationVersion'=EXCLUDED.evidence->>'classificationVersion'`,
    source.website_id,
    source.id,
    new Date(proof.startsAt),
    new Date(proof.endsAt),
    JSON.stringify(evidence),
  );
}
