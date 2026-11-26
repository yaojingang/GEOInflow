import type { HistoryRepairDetail } from '../contracts/history-repair';
import type { ControlSQL } from '../warehouse/control-db';
import { warehouseReader } from '../warehouse/reader-runtime';
import type { RepairTx, RunRow } from './history-repair-db';
import { LiekanError } from './server';

export const warehouseCurrentInputSql = `i.created_at>coalesce((SELECT (boundary.snapshot->>'inputNotBefore')::timestamptz FROM liekan_history_repair_run boundary WHERE boundary.id=$1::uuid),'-infinity'::timestamptz)`;
export type RepairUpload = {
  upload_id: string;
  rulepack_hash: string;
  source: string;
  state: string;
  chunks: number;
  rows: string;
  accepted: string;
  errors: { sequence: number; row: number; code: string }[];
  created_at: Date;
};
export async function repairUploadControls(row: RunRow) {
  const files = await warehouseReader().db.read<RepairUpload>(
    `SELECT * FROM liekan_warehouse_repair_upload i
    WHERE run_id=$1 AND rulepack_hash=$2 AND state<>'discarded' AND ${warehouseCurrentInputSql}
    ORDER BY upload_id LIMIT 101`,
    [row.id, row.snapshot.rulepack.hash],
  );
  if (files.length > 100)
    throw new LiekanError(
      '证据文件控制记录超出范围，请检查迁移校验',
      409,
      'history-repair-upload-control-conflict',
    );
  return files;
}
export async function repairUploadList(
  tx: RepairTx,
  row: RunRow,
): Promise<HistoryRepairDetail['uploads']> {
  return tx.$queryRawUnsafe(
    `SELECT upload_id::text AS id,source,state='finalized' AS finalized,state='discarded' AS discarded,
    rows::text,accepted::text,(rows-accepted)::text AS rejected,chunks,errors,(rows-accepted)>100 AS "moreErrors"
    FROM liekan_warehouse_repair_upload i WHERE run_id=$1::uuid AND rulepack_hash=$2 AND ${warehouseCurrentInputSql}
    ORDER BY (state='discarded'),created_at DESC,upload_id LIMIT 100`,
    row.id,
    row.snapshot.rulepack.hash,
  );
}
// Run only while the legacy input boundary is frozen. This copies file controls,
// not evidence records, and is an idempotent prerequisite of migration cutover.
export async function initializeRepairUploadControls(tx: ControlSQL, site: string) {
  await tx.query(
    `INSERT INTO liekan_warehouse_repair_upload(run_id,website_id,upload_id,rulepack_hash,source,state,chunks,rows,accepted,errors,manifest_hash,created_at)
    SELECT i.run_id,i.website_id,i.upload_id,min(i.rulepack_hash),min(i.source),
      CASE WHEN bool_and(i.state='discarded') THEN 'discarded' WHEN bool_and(i.state='finalized') THEN 'finalized' ELSE 'open' END,
      count(*)::int,sum(i.rows),sum(i.accepted),
      coalesce((SELECT jsonb_agg(e.value ORDER BY e.sequence,e.ordinality) FROM (
        SELECT jsonb_build_object('sequence',x.sequence,'row',a.value->'row','code',a.value->'code') AS value,x.sequence,a.ordinality
        FROM liekan_history_repair_input x CROSS JOIN LATERAL jsonb_array_elements(x.errors) WITH ORDINALITY a(value,ordinality)
        WHERE x.run_id=i.run_id AND x.upload_id=i.upload_id ORDER BY x.sequence,a.ordinality LIMIT 100) e),'[]'),
      min(i.manifest_hash),min(i.created_at)
    FROM liekan_history_repair_input i WHERE i.website_id=$1 GROUP BY i.run_id,i.website_id,i.upload_id
    ON CONFLICT(run_id,upload_id) DO NOTHING`,
    [site],
  );
}
