import type {
  HistoryRepairCounts,
  HistoryRepairLogImpact,
  HistoryRepairPreview,
  HistoryRepairStatus,
} from '../contracts/history-repair';
import { validateWireRow } from './codec';
import { type ControlSQL, WarehouseConflict } from './control-db';
import type { FactMutation } from './landing';
import { canonicalUUID } from './routing';

export type RepairDayDelta = {
  day: string;
  beforePV: number;
  afterPV: number;
  beforeIdentityMissingPV: number;
  afterIdentityMissingPV: number;
  events: number;
  logs: number;
  changedEvents: number;
  changedLogs: number;
  evidence: number;
  logEvidence: number;
};
export type RepairBatchResult = {
  kind: 'history-repair-batch';
  runId: string;
  generation: string;
  actorId: string;
  revision: number;
  inputRevision: number;
  scopeRevision: string;
  authorityHash: string;
  beforeStatus: HistoryRepairStatus;
  beforePhase: string;
  beforeCursor: Record<string, string>;
  next: {
    status: HistoryRepairStatus;
    phase: string;
    cursor: Record<string, string>;
    counts: HistoryRepairCounts;
    logImpact: HistoryRepairLogImpact;
    preview: HistoryRepairPreview | null;
    errorCode: string | null;
    completedAt: string | null;
    membershipDigest: string | null;
  };
  days: RepairDayDelta[];
  visitorDays: { day: string; before: number; after: number }[];
  coverageDays: string[];
};
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function validateRepairBatch(
  result: RepairBatchResult,
  facts: FactMutation[],
  site: string,
) {
  if (
    [result.runId, result.generation, result.actorId].some(id => canonicalUUID(id) !== id) ||
    !count(result.revision) ||
    !count(result.inputRevision) ||
    !/^\d+$/.test(result.scopeRevision) ||
    !/^[a-f0-9]{64}$/.test(result.authorityHash) ||
    !['scanning', 'preparing'].includes(result.beforeStatus) ||
    !result.next ||
    !result.beforeCursor ||
    !Array.isArray(result.days) ||
    result.days.length > 2000 ||
    !Array.isArray(result.visitorDays) ||
    result.visitorDays.length > 2000 ||
    !Array.isArray(result.coverageDays) ||
    result.coverageDays.length > 30 ||
    Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024
  )
    throw new Error('warehouse-invalid-repair-task');
  for (const day of result.days) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day.day) ||
      Object.entries(day).some(([k, v]) => k !== 'day' && !count(v))
    )
      throw new Error('warehouse-invalid-repair-day');
  }
  for (const day of result.visitorDays)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.day) || !count(day.before) || !count(day.after))
      throw new Error('warehouse-invalid-repair-day');
  if (result.coverageDays.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day)))
    throw new Error('warehouse-invalid-repair-day');
  for (const f of facts) {
    if (
      !['liekan_history_repair_result', 'liekan_history_repair_visitor'].includes(f.family) ||
      f.deleted !== undefined ||
      f.retainCreatedAt !== undefined ||
      f.sessionId !== undefined
    )
      throw new Error('warehouse-repair-task-family-mismatch');
    const r = validateWireRow(f.family, f.row);
    if (r.website_id !== site || r.run_id !== result.runId || r.generation !== result.generation)
      throw new Error('warehouse-repair-task-scope-mismatch');
  }
}
export async function applyRepairBatch(tx: ControlSQL, site: string, r: RepairBatchResult) {
  // All run-edit operations fence pending/confirmed tasks. Never publish partial
  // CH evidence if the corresponding PG work cursor cannot advance atomically.
  const changed = await tx.query(
    `UPDATE liekan_history_repair_run SET status=$10,phase=$11,cursor=$12::jsonb,counts=$13::jsonb,
    log_impact=$14::jsonb,preview=$15::jsonb,error_code=$16,completed_at=$17,membership_digest=$18,attempts=0,
    lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE id=$1 AND website_id=$2 AND generation=$3 AND actor_id=$4 AND revision=$5 AND input_revision=$6
      AND scope_revision=$7 AND NOT scope_changed AND status=$8 AND phase=$9 AND cursor=$19::jsonb`,
    [
      r.runId,
      site,
      r.generation,
      r.actorId,
      r.revision,
      r.inputRevision,
      r.scopeRevision,
      r.beforeStatus,
      r.beforePhase,
      r.next.status,
      r.next.phase,
      JSON.stringify(r.next.cursor),
      JSON.stringify(r.next.counts),
      JSON.stringify(r.next.logImpact),
      r.next.preview ? JSON.stringify(r.next.preview) : null,
      r.next.errorCode,
      r.next.completedAt,
      r.next.membershipDigest,
      JSON.stringify(r.beforeCursor),
    ],
  );
  if (changed.rowCount !== 1) throw new WarehouseConflict('warehouse-repair-control-changed');
  if (r.days.length)
    await tx.query(
      `INSERT INTO liekan_history_repair_day(run_id,website_id,generation,day,before_pv,after_pv,before_identity_missing_pv,after_identity_missing_pv,event_rows,log_rows,changed_events,changed_logs,evidence_rows,log_evidence_rows)
    SELECT $1,$2,$3,d.day::date,sum(d."beforePV"),sum(d."afterPV"),sum(d."beforeIdentityMissingPV"),sum(d."afterIdentityMissingPV"),sum(d.events),sum(d.logs),sum(d."changedEvents"),sum(d."changedLogs"),sum(d.evidence),sum(d."logEvidence")
    FROM jsonb_to_recordset($4::jsonb) d(day text,"beforePV" bigint,"afterPV" bigint,"beforeIdentityMissingPV" bigint,"afterIdentityMissingPV" bigint,events bigint,logs bigint,"changedEvents" bigint,"changedLogs" bigint,evidence bigint,"logEvidence" bigint) GROUP BY d.day
    ON CONFLICT(run_id,generation,day) DO UPDATE SET before_pv=liekan_history_repair_day.before_pv+EXCLUDED.before_pv,after_pv=liekan_history_repair_day.after_pv+EXCLUDED.after_pv,
    before_identity_missing_pv=coalesce(liekan_history_repair_day.before_identity_missing_pv,0)+EXCLUDED.before_identity_missing_pv,
    after_identity_missing_pv=coalesce(liekan_history_repair_day.after_identity_missing_pv,0)+EXCLUDED.after_identity_missing_pv,
    event_rows=liekan_history_repair_day.event_rows+EXCLUDED.event_rows,log_rows=liekan_history_repair_day.log_rows+EXCLUDED.log_rows,
    changed_events=liekan_history_repair_day.changed_events+EXCLUDED.changed_events,changed_logs=liekan_history_repair_day.changed_logs+EXCLUDED.changed_logs,
    evidence_rows=liekan_history_repair_day.evidence_rows+EXCLUDED.evidence_rows,log_evidence_rows=liekan_history_repair_day.log_evidence_rows+EXCLUDED.log_evidence_rows`,
      [r.runId, site, r.generation, JSON.stringify(r.days)],
    );
  if (r.visitorDays.length)
    await tx.query(
      `UPDATE liekan_history_repair_day d SET before_uv=d.before_uv+v.before_uv,after_uv=d.after_uv+v.after_uv
    FROM (SELECT a.day,sum(a.before) AS before_uv,sum(a.after) AS after_uv FROM jsonb_to_recordset($3::jsonb) a(day text,before bigint,after bigint) GROUP BY a.day) v
    WHERE d.run_id=$1 AND d.generation=$2 AND d.day=v.day::date`,
      [r.runId, r.generation, JSON.stringify(r.visitorDays)],
    );
  if (r.coverageDays.length)
    await tx.query(
      `UPDATE liekan_history_repair_day SET coverage=CASE WHEN evidence_rows+log_evidence_rows=0 THEN 'missing'
    WHEN evidence_rows+log_evidence_rows=event_rows+log_rows THEN 'complete' ELSE 'partial' END WHERE run_id=$1 AND generation=$2 AND day=ANY($3::date[])`,
      [r.runId, r.generation, r.coverageDays],
    );
}
