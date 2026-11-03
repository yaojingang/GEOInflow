import { createHash } from 'node:crypto';
import type { HistoryRepairEvidenceResult } from '../contracts/history-repair';
import { validateWireRow } from './codec';
import { type ControlSQL, WarehouseConflict } from './control-db';
import type { FactMutation } from './landing';
import { canonicalUUID } from './routing';

export type RepairInputResult = {
  kind: 'history-repair-input';
  runId: string;
  generation: string;
  actorId: string;
  revision: number;
  inputRevision: number;
  scopeRevision: string;
  authorityHash: string;
  actionId: string;
  payloadHash: string;
  uploadId: string;
  rulepack: string;
  source: string;
  createdAt: string;
  response: HistoryRepairEvidenceResult;
};
export function validateRepairInput(r: RepairInputResult, facts: FactMutation[], site: string) {
  if (
    [r.runId, r.generation, r.actorId, r.actionId, r.uploadId].some(
      id => canonicalUUID(id) !== id,
    ) ||
    [r.authorityHash, r.payloadHash, r.rulepack].some(h => !/^[a-f0-9]{64}$/.test(h)) ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 1 ||
    !Number.isSafeInteger(r.inputRevision) ||
    r.inputRevision < 0 ||
    !/^\d+$/.test(r.scopeRevision) ||
    !r.source ||
    r.source.length > 500 ||
    !Number.isFinite(Date.parse(r.createdAt)) ||
    !r.response ||
    r.response.uploadId !== r.uploadId ||
    r.response.revision !== r.revision + 1 ||
    r.response.finalized ||
    r.response.discarded ||
    !Array.isArray(r.response.errors) ||
    r.response.errors.length > 1000 ||
    facts.length !== 1 ||
    Buffer.byteLength(JSON.stringify(r)) > 256 * 1024
  )
    throw new Error('warehouse-invalid-repair-input');
  const f = facts[0];
  if (
    f.family !== 'liekan_history_repair_input' ||
    f.deleted !== undefined ||
    f.retainCreatedAt !== undefined ||
    f.sessionId !== undefined
  )
    throw new Error('warehouse-repair-input-family-mismatch');
  const row = validateWireRow(f.family, f.row);
  if (
    row.website_id !== site ||
    row.run_id !== r.runId ||
    row.generation !== r.generation ||
    row.upload_id !== r.uploadId ||
    row.actor_id !== r.actorId ||
    row.rulepack_hash !== r.rulepack ||
    row.source !== r.source ||
    row.state !== 'open' ||
    Number(row.sequence) !== r.response.sequence ||
    row.chunk_hash !== r.response.hash ||
    Number(row.accepted) !== r.response.accepted ||
    Number(row.rows) !== r.response.accepted + r.response.rejected ||
    JSON.stringify(JSON.parse(String(row.errors))) !== JSON.stringify(r.response.errors) ||
    JSON.parse(String(row.records)).length !== r.response.accepted
  )
    throw new Error('warehouse-repair-input-result-mismatch');
}
export async function applyRepairInput(tx: ControlSQL, site: string, r: RepairInputResult) {
  const changed = await tx.query(
    `UPDATE liekan_history_repair_run SET revision=revision+1,input_revision=input_revision+1,
    status='paused',preview=NULL,confirmed_at=NULL,approved_digest=NULL,error_code='evidence-changed',updated_at=clock_timestamp()
    WHERE id=$1 AND website_id=$2 AND generation=$3 AND revision=$4 AND input_revision=$5 AND scope_revision=$6 AND NOT scope_changed`,
    [r.runId, site, r.generation, r.revision, r.inputRevision, r.scopeRevision],
  );
  if (changed.rowCount !== 1) throw new WarehouseConflict('warehouse-repair-input-control-changed');
  const summary = r.response.errors
    .slice(0, 100)
    .map(e => ({ sequence: r.response.sequence, ...e }));
  const file = await tx.query(
    `INSERT INTO liekan_warehouse_repair_upload(run_id,website_id,upload_id,rulepack_hash,source,state,chunks,rows,accepted,errors,created_at)
    VALUES($1,$2,$3,$4,$5,'open',1,$6,$7,$8::jsonb,$9)
    ON CONFLICT(run_id,upload_id) DO UPDATE SET chunks=liekan_warehouse_repair_upload.chunks+1,rows=liekan_warehouse_repair_upload.rows+EXCLUDED.rows,
      accepted=liekan_warehouse_repair_upload.accepted+EXCLUDED.accepted,
      errors=(SELECT coalesce(jsonb_agg(e.value),'[]') FROM (SELECT value FROM jsonb_array_elements(liekan_warehouse_repair_upload.errors||EXCLUDED.errors) WITH ORDINALITY ORDER BY ordinality LIMIT 100) e),updated_at=clock_timestamp()
    WHERE liekan_warehouse_repair_upload.state='open' AND liekan_warehouse_repair_upload.chunks=$10
      AND liekan_warehouse_repair_upload.rulepack_hash=$4 AND liekan_warehouse_repair_upload.source=$5`,
    [
      r.runId,
      site,
      r.uploadId,
      r.rulepack,
      r.source,
      r.response.accepted + r.response.rejected,
      r.response.accepted,
      JSON.stringify(summary),
      r.createdAt,
      r.response.sequence,
    ],
  );
  if (file.rowCount !== 1) throw new WarehouseConflict('warehouse-repair-upload-changed');
  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ action: 'append', hash: r.payloadHash }))
    .digest('hex');
  await tx.query(
    `INSERT INTO liekan_history_repair_action(id,website_id,run_id,actor_id,generation,action,payload_hash,response,details)
    VALUES($1,$2,$3,$4,$5,'evidence-append',$6,$7::jsonb,$8::jsonb)`,
    [
      r.actionId,
      site,
      r.runId,
      r.actorId,
      r.generation,
      payloadHash,
      JSON.stringify(r.response),
      JSON.stringify({ uploadId: r.uploadId, engine: 'history-repair-v1.2' }),
    ],
  );
}
