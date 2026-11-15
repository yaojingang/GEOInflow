import { randomUUID } from 'node:crypto';
import { pageReportParts } from '../contracts/page-report';
import type { ReportQuery } from '../contracts/query';
import type { AnalysisKind, AnalysisRead } from '../warehouse/analysis-context';
import { type ControlSQL, WarehouseConflict } from '../warehouse/control-db';
import { warehouseReader } from '../warehouse/reader-runtime';
import type { ReportingMetadata } from '../warehouse/reporting-relations';
import { analysisModelVersion } from './warehouse-analysis-model';
import { releaseRoundMetrics } from './warehouse-round-metrics';

export type ReportRound = {
  id: string;
  website_id: string;
  control_version: string;
  model_version: string;
  catalog_version: string;
  format_version: number;
  epoch: string;
  publication: string;
  deletion_revision: string;
  cutoff_at: Date;
  reference_id: string;
  pending: string[];
  prepared: AnalysisRead | null;
  metrics: Record<string, unknown>;
};

/** Dependencies follow the actual report modules, including population reads
 * on AI pages and log summary reads on several browser pages. */
export function reportAnalysisKinds(
  p: ReportQuery & { nativeRetention?: unknown },
): AnalysisKind[] {
  return p.nativeRetention || !pageReportParts[p.resource].logs.length
    ? ['browser']
    : ['browser', 'log'];
}

export async function acquireReportRound(
  job: { id: string; website_id: string; catalog_version: string },
  metadata: ReportingMetadata,
  control: string,
  format: number,
  cutoff: number,
): Promise<ReportRound> {
  const db = warehouseReader().db;
  return db.transaction(async tx => {
    const b = metadata.boundary;
    const locked = await tx.query(
      `SELECT website_id FROM liekan_warehouse_site WHERE website_id=$1 AND epoch=$2
       AND publication>=$3 AND deletion_revision=$4 AND state='active' FOR UPDATE`,
      [job.website_id, b.epoch, b.publication, b.deletionRevision],
    );
    if (!locked.rowCount) throw new WarehouseConflict('warehouse-read-boundary-changed');
    const {
      rows: [old],
    } = await tx.query<ReportRound & { live: boolean }>(
      `SELECT r.*,(ref.expires_at>clock_timestamp() AND r.created_at>clock_timestamp()-interval '30 minutes') AS live FROM liekan_warehouse_report_round r
       JOIN liekan_warehouse_reference ref ON ref.reference_id=r.reference_id WHERE r.website_id=$1`,
      [job.website_id],
    );
    if (
      old?.live &&
      old.control_version === control &&
      old.model_version === analysisModelVersion &&
      old.catalog_version === job.catalog_version &&
      old.format_version === format &&
      String(old.epoch) === b.epoch &&
      String(old.deletion_revision) === b.deletionRevision &&
      BigInt(old.publication) <= BigInt(b.publication) &&
      old.pending.includes(job.id)
    ) {
      await tx.query(
        `UPDATE liekan_warehouse_reference SET expires_at=clock_timestamp()+interval '15 minutes'
        WHERE reference_id=$1 AND expires_at>clock_timestamp()`,
        [old.reference_id],
      );
      return old;
    }
    if (old) {
      releaseRoundMetrics(old.id);
      await tx.query('DELETE FROM liekan_warehouse_report_round WHERE id=$1', [old.id]);
      await tx.query(
        "DELETE FROM liekan_warehouse_reference WHERE reference_id=$1 AND kind='query' AND owner_id=$2",
        [old.reference_id, old.id],
      );
    }
    const id = randomUUID(),
      reference = randomUUID();
    await tx.query(
      `INSERT INTO liekan_warehouse_reference
      (reference_id,website_id,epoch,publication,kind,owner_id,expires_at)
      VALUES($1,$2,$3,$4,'query',$5,clock_timestamp()+interval '15 minutes')`,
      [reference, job.website_id, b.epoch, b.publication, id],
    );
    const {
      rows: [round],
    } = await tx.query<ReportRound>(
      `WITH members AS (
        SELECT array_agg(id) AS ids FROM liekan_warehouse_overview_snapshot
        WHERE website_id=$2 AND preset AND catalog_version=$5 AND format_version=$6
          AND (next_attempt_at<=now() OR id=$11) AND (parameters->>'endAt')::bigint>=$10
          AND coalesce(parameters->'tablePages','{}'::jsonb)='{}'::jsonb
      ) INSERT INTO liekan_warehouse_report_round
       (id,website_id,control_version,model_version,catalog_version,format_version,epoch,publication,
        deletion_revision,cutoff_at,reference_id,members,pending)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10::double precision/1000),$12,
        array_append(array_remove(coalesce(ids,'{}'::uuid[]),$11),$11),
        array_append(array_remove(coalesce(ids,'{}'::uuid[]),$11),$11) FROM members RETURNING *`,
      [
        id,
        job.website_id,
        control,
        analysisModelVersion,
        job.catalog_version,
        format,
        b.epoch,
        b.publication,
        b.deletionRevision,
        cutoff,
        job.id,
        reference,
      ],
    );
    return round;
  });
}

export async function saveRoundPreparation(round: ReportRound, prepared: AnalysisRead) {
  const rows = await warehouseReader().db.read(
    `UPDATE liekan_warehouse_report_round r SET prepared=$3
     WHERE r.id=$1 AND r.control_version=$2 AND EXISTS (
       SELECT 1 FROM liekan_warehouse_reference ref WHERE ref.reference_id=r.reference_id
         AND ref.expires_at>clock_timestamp()) RETURNING id`,
    [round.id, round.control_version, prepared],
  );
  if (!rows.length) throw new WarehouseConflict('warehouse-read-reference-lost');
  round.prepared = prepared;
}

export async function finishReportRound(
  round: ReportRound,
  jobId: string,
  transaction?: ControlSQL,
) {
  const db = warehouseReader().db;
  const finish = async (tx: ControlSQL) => {
    const {
      rows: [row],
    } = await tx.query<{ pending: string[]; reference_id: string }>(
      `UPDATE liekan_warehouse_report_round SET pending=array_remove(pending,$2)
       WHERE id=$1 RETURNING pending,reference_id`,
      [round.id, jobId],
    );
    if (row && !row.pending.length) {
      releaseRoundMetrics(round.id);
      await tx.query('DELETE FROM liekan_warehouse_report_round WHERE id=$1', [round.id]);
      await tx.query(
        "DELETE FROM liekan_warehouse_reference WHERE reference_id=$1 AND owner_id=$2 AND kind='query'",
        [row.reference_id, round.id],
      );
    }
  };
  if (transaction) await finish(transaction);
  else await db.transaction(finish);
}

/** CAS against the same protected round. Cache saturation simply skips reuse;
 * it never prevents building or publishing a report. No source rows are stored. */
export function reportRoundMetrics(round: ReportRound) {
  return {
    values: round.metrics ?? {},
    async save(key: string, value: unknown) {
      await warehouseReader().db.read(
        `UPDATE liekan_warehouse_report_round r SET metrics=metrics||jsonb_build_object($3::text,$4::jsonb)
         WHERE r.id=$1 AND r.control_version=$2 AND EXISTS (
           SELECT 1 FROM liekan_warehouse_reference ref WHERE ref.reference_id=r.reference_id
             AND ref.expires_at>clock_timestamp())
           AND octet_length((metrics||jsonb_build_object($3::text,$4::jsonb))::text)<=262144`,
        [round.id, round.control_version, key, JSON.stringify(value)],
      );
    },
  };
}
