import type { CrawlerCoverage } from '../contracts/crawler-quality';
import { factRelation } from '../warehouse/read';
import { effectiveLogRelation, type ReportingMetadata } from '../warehouse/reporting-relations';
import { warehouseTime } from '../warehouse/fact-input';
import { readReportingMetadata } from '../warehouse/reporting-context';
import {
  warehouseControlFingerprint,
  warehouseReportMetadata,
  warehouseReportQuery,
  withinWarehouseReport,
} from './warehouse-report-snapshot';

export type WarehouseCrawlerCoverage = {
  sourceId: string;
  epoch: number;
  proof: string;
  classificationVersion: string;
  metadata: ReportingMetadata;
  batches: { id: string; first_event: Date; last_event: Date }[];
  changed: boolean;
};

/** Prepare evidence without holding the collector's PG source/website locks. */
export async function prepareWarehouseCrawlerCoverage(
  site: string,
  sourceId: string,
  epoch: number,
  proof: CrawlerCoverage,
  classificationVersion: string,
): Promise<WarehouseCrawlerCoverage> {
  return withinWarehouseReport(async () => {
    const metadata = await warehouseReportMetadata(site);
    // Raw keys only narrow the accepted fact lookup. Unpublished/deleted retry
    // remnants cannot themselves prove any observed event boundary.
    const keys = await warehouseReportQuery<{ key: string }>(
      site,
      `SELECT DISTINCT _record_key AS key FROM warehouse_liekan_log
       WHERE _website_id={wh_site:UUID} AND _epoch={wh_epoch:UInt64}
         AND import_id IN {coverageBatches:Array(UUID)} LIMIT 2001`,
      { coverageBatches: [proof.fromBatchId, proof.toBatchId] },
      { timeoutSeconds: 5 },
    );
    // The server protocol admits at most 1000 records per batch. Fail closed if
    // a malformed legacy batch exceeds the bounded boundary lookup.
    if (keys.length > 2000) throw new Error('warehouse-coverage-batch-too-large');
    const batches = await warehouseReportQuery<{
      id: string;
      first_event: string;
      last_event: string;
    }>(
      site,
      `SELECT import_id AS id,min(created_at) AS first_event,max(created_at) AS last_event
       FROM ${factRelation('liekan_log', { columns: ['import_id', 'source_id', 'created_at'], recordKeysParameter: 'coverageKeys' })}
       WHERE source_id={coverageSource:UUID} AND import_id IN {coverageBatches:Array(UUID)} GROUP BY import_id`,
      {
        coverageKeys: keys.map(row => row.key),
        coverageSource: sourceId,
        coverageBatches: [proof.fromBatchId, proof.toBatchId],
      },
      { timeoutSeconds: 5 },
    );
    const window = { start: 'coverageStart', end: 'coverageEnd' };
    // Recheck the complete event-time interval, including late publications.
    // A prior complete row is not evidence for newly arrived historical input.
    const changed = await warehouseReportQuery(
      site,
      `SELECT 1 FROM ${effectiveLogRelation({ columns: ['id', 'website_id', 'source_id', 'created_at'], immutableTimeWindow: window })} l
       LEFT JOIN ${factRelation('liekan_crawler_evidence', { columns: ['website_id', 'log_id', 'classification_version'] })} e
         ON e.website_id=l.website_id AND e.log_id=l.id
       WHERE l.source_id={coverageSource:UUID} AND l.created_at>={coverageStart:DateTime64(6)}
         AND l.created_at<={coverageEnd:DateTime64(6)}
         AND (isNull(e.classification_version) OR e.classification_version!={coverageVersion:String}) LIMIT 1`,
      {
        coverageSource: sourceId,
        coverageStart: warehouseTime(new Date(proof.startsAt)),
        coverageEnd: warehouseTime(new Date(proof.endsAt)),
        coverageVersion: classificationVersion,
      },
      { timeoutSeconds: 5 },
    );
    return {
      sourceId,
      epoch,
      proof: JSON.stringify(proof),
      classificationVersion,
      metadata,
      batches: batches.map(row => ({
        id: row.id,
        first_event: new Date(row.first_event.replace(' ', 'T') + 'Z'),
        last_event: new Date(row.last_event.replace(' ', 'T') + 'Z'),
      })),
      changed: changed.length > 0,
    };
  });
}

/** Caller holds the authorized website/source locks; publication takes the
 * website lock too. A changed pointer must wait for a fresh heartbeat proof. */
export async function acceptWarehouseCrawlerCoverage(
  tx: { $queryRawUnsafe(sql: string, ...values: unknown[]): Promise<any[]> },
  prepared: WarehouseCrawlerCoverage,
  site: string,
  sourceId: string,
  epoch: number,
  proof: CrawlerCoverage,
  classificationVersion: string,
) {
  if (
    prepared.sourceId !== sourceId ||
    prepared.metadata.boundary.websiteId !== site ||
    prepared.epoch !== epoch ||
    prepared.proof !== JSON.stringify(proof) ||
    prepared.classificationVersion !== classificationVersion
  )
    return false;
  const current = await readReportingMetadata(
    { read: (sql, values = []) => tx.$queryRawUnsafe(sql, ...values) },
    site,
  );
  return (
    current.boundary.publication === prepared.metadata.boundary.publication &&
    warehouseControlFingerprint(current) === warehouseControlFingerprint(prepared.metadata)
  );
}
