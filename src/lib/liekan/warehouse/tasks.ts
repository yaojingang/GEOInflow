import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ClickHouseClient } from '@clickhouse/client';
import { validateWireRow } from './codec';
import type { DecisionPlanner } from './consumer';
import type { Attempt, SiteState } from './control';
import type { ControlDatabase, ControlSQL } from './control-db';
import { WarehouseConflict } from './control-db';
import { warehouseTime } from './fact-input';
import type { FactMutation, LandedDecision } from './landing';
import { applyRepairBatch, type RepairBatchResult, validateRepairBatch } from './repair-task';
import { applyRepairInput, type RepairInputResult, validateRepairInput } from './repair-input-task';
import type { InputEnvelope } from './routing';
import { canonicalUUID } from './routing';
import type { WarehouseRuntime } from './runtime';

export type RiskResult = {
  kind: 'browser-risk';
  windowEnd: string;
  logEpoch: string;
  ruleVersion: string;
  coverage: 'observed' | 'partial';
  events: number;
  visits: number;
  insufficient: number;
  flagged: number;
  nextBefore: string;
  nextAfter: string;
};
export type GovernanceResult = {
  kind: 'traffic-exclusion';
  collectionId: string;
  actorId: string;
  windowEnd: string;
  digest: string;
  events: number;
};
export type TaskResult = RiskResult | GovernanceResult | RepairBatchResult | RepairInputResult;
export type AuthorizedTaskResult = Exclude<TaskResult, RiskResult>;
type TaskData = { format: 'task-v1'; taskId: string; result: TaskResult; facts: FactMutation[] };
export type TaskAuthority = (
  tx: ControlSQL,
  site: string,
  result: AuthorizedTaskResult,
) => Promise<boolean>;
type Task = {
  task_id: string;
  website_id: string;
  epoch: string;
  deletion_revision: string;
  policy_revision: string;
  payload_hash: string;
  kind: string;
  result: TaskResult;
  status: string;
  attempt_id: string | null;
};
const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const ordered = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(ordered)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, ordered(x)]),
        )
      : v;
export function validateTask(e: InputEnvelope): TaskData {
  const p = e.data as unknown as TaskData,
    r = p.result;
  if (
    e.kind !== 'task' ||
    p.format !== 'task-v1' ||
    canonicalUUID(p.taskId) !== p.taskId ||
    e.sessionId !== p.taskId ||
    e.clientEventId !== p.taskId ||
    !r ||
    !['browser-risk', 'traffic-exclusion', 'history-repair-batch', 'history-repair-input'].includes(
      r.kind,
    ) ||
    ((r.kind === 'browser-risk' || r.kind === 'traffic-exclusion') &&
      !Number.isFinite(Date.parse(r.windowEnd))) ||
    !Array.isArray(p.facts) ||
    p.facts.length > 10000 ||
    digest(p) !== e.fingerprint
  )
    throw new Error('warehouse-invalid-task');
  if (r.kind === 'history-repair-input') {
    validateRepairInput(r, p.facts, e.websiteId);
    return p;
  }
  if (r.kind === 'history-repair-batch') {
    validateRepairBatch(r, p.facts, e.websiteId);
    return p;
  }
  if (r.kind === 'traffic-exclusion') {
    if (
      canonicalUUID(r.collectionId) !== r.collectionId ||
      canonicalUUID(r.actorId) !== r.actorId ||
      !/^[a-f0-9]{64}$/.test(r.digest) ||
      !Number.isSafeInteger(r.events) ||
      r.events < 1 ||
      r.events !== p.facts.length
    )
      throw new Error('warehouse-invalid-governance-task');
    const ids: string[] = [];
    for (const f of p.facts) {
      if (
        f.family !== 'liekan_traffic_exclusion_member' ||
        f.deleted !== undefined ||
        f.retainCreatedAt !== undefined ||
        typeof f.sessionId !== 'string' ||
        canonicalUUID(f.sessionId) !== f.sessionId
      )
        throw new Error('warehouse-task-family-mismatch');
      const row = validateWireRow(f.family, f.row);
      if (row.website_id !== e.websiteId || row.collection_id !== r.collectionId)
        throw new Error('warehouse-task-scope-mismatch');
      ids.push(String(row.event_id));
    }
    if (new Set(ids).size !== ids.length || digest(ids.sort()) !== r.digest)
      throw new Error('warehouse-task-membership-mismatch');
    return p;
  }
  if (
    !['observed', 'partial'].includes(r.coverage) ||
    !/^\d+$/.test(r.logEpoch) ||
    !r.ruleVersion ||
    r.ruleVersion.length > 100 ||
    [r.windowEnd, r.nextBefore, r.nextAfter].some(t => !Number.isFinite(Date.parse(t))) ||
    [r.events, r.visits, r.insufficient, r.flagged].some(
      n => !Number.isSafeInteger(n) || n < 0 || n > 10000,
    ) ||
    p.facts.length > 2000
  )
    throw new Error('warehouse-invalid-task');
  if (
    r.flagged !== p.facts.filter(f => !f.deleted).length ||
    r.insufficient + r.flagged > r.visits ||
    r.visits > r.events ||
    Date.parse(r.nextAfter) <= Date.parse(r.windowEnd)
  )
    throw new Error('warehouse-invalid-task-result');
  for (const f of p.facts) {
    if (
      f.family !== 'liekan_browser_risk' ||
      f.sessionId !== undefined ||
      f.retainCreatedAt !== undefined ||
      (f.deleted !== undefined && typeof f.deleted !== 'boolean')
    )
      throw new Error('warehouse-task-family-mismatch');
    const row = validateWireRow(f.family, f.row);
    if (
      row.website_id !== e.websiteId ||
      Date.parse(String(row.window_end).replace(' ', 'T') + 'Z') !== Date.parse(r.windowEnd)
    )
      throw new Error('warehouse-task-scope-mismatch');
  }
  return p;
}
export async function prepareWarehouseTask(
  runtime: WarehouseRuntime,
  site: SiteState,
  result: TaskResult,
  facts: FactMutation[],
  register?: (tx: ControlSQL, taskId: string) => Promise<void>,
) {
  const taskId = randomUUID(),
    data: TaskData = { format: 'task-v1', taskId, result, facts };
  const envelope = runtime.envelope(site, {
    websiteId: site.website_id,
    sessionId: taskId,
    visitId: taskId,
    eventId: taskId,
    clientEventId: taskId,
    kind: 'task',
    fingerprint: digest(data),
    collectionSource: 'internal',
    collectionScope: 'analysis',
    receivedAt: new Date().toISOString(),
    data,
  });
  validateTask(envelope);
  const serialized = JSON.stringify(envelope);
  await runtime.ch.insert({
    table: 'warehouse_control_projection',
    values: [
      {
        website_id: site.website_id,
        epoch: site.epoch,
        kind: 'task-outbox-v1',
        revision: '0',
        key: taskId,
        value: serialized,
        created_at: warehouseTime(envelope.receivedAt),
      },
    ],
    format: 'JSONEachRow',
  });
  const verified = await readTaskEnvelope(runtime.ch, site.website_id, site.epoch, taskId);
  if (JSON.stringify(verified) !== serialized)
    throw new WarehouseConflict('warehouse-task-outbox-mismatch');
  await runtime.db.transaction(async tx => {
    // Match confirmation/lifecycle: business resource first, warehouse state
    // second, then run/task rows. Register callbacks may take business locks.
    await tx.query('SELECT website_id FROM website WHERE website_id=$1 FOR UPDATE', [
      site.website_id,
    ]);
    await tx.query('SELECT id FROM liekan_warehouse_installation WHERE id=1 FOR SHARE');
    if (
      result.kind !== 'browser-risk' &&
      (await tx.query("SELECT 1 FROM liekan_warehouse_transition WHERE id=1 AND state<>'closed'"))
        .rowCount
    )
      throw new WarehouseConflict('warehouse-transition-maintenance-frozen');
    if (
      (
        await tx.query(
          "SELECT 1 FROM liekan_warehouse_barrier WHERE status IN('draining','frozen') LIMIT 1",
        )
      ).rowCount
    )
      throw new WarehouseConflict('warehouse-transition-control-frozen');
    const [current] = (
      await tx.query<SiteState>(
        'SELECT * FROM liekan_warehouse_site WHERE website_id=$1 FOR UPDATE',
        [site.website_id],
      )
    ).rows;
    if (
      !current ||
      current.state !== 'active' ||
      current.epoch !== site.epoch ||
      current.deletion_revision !== site.deletion_revision ||
      current.policy_revision !== site.policy_revision
    )
      throw new WarehouseConflict('warehouse-task-source-changed');
    if (register) await register(tx, taskId);
    await tx.query(
      `INSERT INTO liekan_warehouse_task(task_id,website_id,epoch,deletion_revision,policy_revision,kind,scope_key,payload_hash,result)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        taskId,
        site.website_id,
        site.epoch,
        site.deletion_revision,
        site.policy_revision,
        result.kind,
        result.kind === 'traffic-exclusion'
          ? result.collectionId
          : result.kind === 'history-repair-batch' || result.kind === 'history-repair-input'
            ? result.runId
            : result.windowEnd,
        envelope.fingerprint,
        JSON.stringify(result),
      ],
    );
  });
  await deliverWarehouseTask(runtime, taskId);
  return taskId;
}
async function readTaskEnvelope(ch: ClickHouseClient, site: string, epoch: string, taskId: string) {
  const rows = await ch
    .query({
      query: `SELECT DISTINCT value FROM warehouse_control_projection WHERE website_id={site:UUID} AND epoch={epoch:UInt64}
    AND kind='task-outbox-v1' AND key={task:String} AND revision=0 LIMIT 2`,
      query_params: { site, epoch, task: taskId },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ value: string }>());
  if (rows.length !== 1) throw new WarehouseConflict('warehouse-task-outbox-unavailable');
  return JSON.parse(rows[0].value) as InputEnvelope;
}
export async function deliverWarehouseTask(runtime: WarehouseRuntime, taskId: string) {
  const [task] = await runtime.db.read<Task>(
    'SELECT * FROM liekan_warehouse_task WHERE task_id=$1',
    [taskId],
  );
  if (!task || task.status !== 'pending') return;
  const e = await readTaskEnvelope(runtime.ch, task.website_id, task.epoch, taskId);
  validateTask(e);
  if (e.fingerprint !== task.payload_hash)
    throw new WarehouseConflict('warehouse-task-digest-mismatch');
  await runtime.queue.enqueue(e);
  await runtime.db.transaction(tx =>
    tx.query(
      "UPDATE liekan_warehouse_task SET next_enqueue_at=clock_timestamp()+interval '30 seconds' WHERE task_id=$1 AND status='pending'",
      [taskId],
    ),
  );
}
export function taskPlanner(db: ControlDatabase, authority?: TaskAuthority): DecisionPlanner {
  return async (inputs, state) => {
    const decisions: LandedDecision[] = [];
    for (const input of inputs) {
      const p = validateTask(input.envelope),
        [task] = await db.read<Task>('SELECT * FROM liekan_warehouse_task WHERE task_id=$1', [
          p.taskId,
        ]);
      if (
        !task ||
        task.website_id !== input.envelope.websiteId ||
        task.payload_hash !== input.envelope.fingerprint ||
        digest(ordered(task.result)) !== digest(ordered(p.result))
      ) {
        throw new WarehouseConflict('warehouse-task-unregistered');
      }
      const authorized =
        p.result.kind === 'browser-risk' ||
        (!!authority &&
          (await db.transaction(tx =>
            authority(tx, input.envelope.websiteId, p.result as AuthorizedTaskResult),
          )));
      const accepted =
        authorized &&
        task.epoch === state.epoch &&
        task.deletion_revision === state.deletion_revision &&
        task.policy_revision === state.policy_revision &&
        task.status === 'pending';
      const duplicate = ['confirmed', 'published'].includes(task.status);
      decisions.push({
        input,
        status: duplicate ? 'duplicate' : accepted ? 'new' : 'cancelled',
        sessionId: p.taskId,
        visitId: p.taskId,
        facts: accepted ? p.facts : [],
        effects: duplicate
          ? []
          : [{ kind: 'analysis-task', taskId: p.taskId, cancelled: !accepted }],
      });
    }
    return decisions;
  };
}
export async function confirmWarehouseTasks(
  tx: ControlSQL,
  attempt: Attempt,
  decisions: LandedDecision[],
  authority?: TaskAuthority,
) {
  for (const d of decisions.filter(x => x.input.envelope.kind === 'task' && x.status === 'new')) {
    const p = validateTask(d.input.envelope);
    if (
      p.result.kind !== 'browser-risk' &&
      (!authority || !(await authority(tx, attempt.website_id, p.result)))
    )
      throw new WarehouseConflict('warehouse-task-actor-authority-changed');
    const result = await tx.query(
      `UPDATE liekan_warehouse_task SET status='confirmed',attempt_id=$2,updated_at=clock_timestamp()
      WHERE task_id=$1 AND website_id=$3 AND epoch=$4 AND deletion_revision=$5 AND policy_revision=$6 AND payload_hash=$7 AND status='pending'`,
      [
        p.taskId,
        attempt.attempt_id,
        attempt.website_id,
        attempt.epoch,
        attempt.deletion_revision,
        attempt.policy_revision,
        d.input.envelope.fingerprint,
      ],
    );
    if (!result.rowCount) throw new WarehouseConflict('warehouse-task-authority-changed');
    // A task can contain multiple visits; all pending deletions fence its snapshot.
    if (
      (
        await tx.query(
          "SELECT 1 FROM liekan_warehouse_deletion WHERE website_id=$1 AND status NOT IN('active','reclaimed') LIMIT 1",
          [attempt.website_id],
        )
      ).rowCount
    )
      throw new WarehouseConflict('warehouse-task-delete-pending');
  }
}
export async function applyWarehouseTask(
  tx: ControlSQL,
  site: string,
  taskId: string,
  cancelled: boolean,
) {
  const [t] = (
    await tx.query<Task>(
      'SELECT * FROM liekan_warehouse_task WHERE task_id=$1 AND website_id=$2 FOR UPDATE',
      [taskId, site],
    )
  ).rows;
  if (!t || ['published', 'cancelled'].includes(t.status)) return;
  if (!cancelled && t.status !== 'confirmed')
    throw new WarehouseConflict('warehouse-task-unconfirmed');
  if (!cancelled && t.result.kind === 'history-repair-input')
    await applyRepairInput(tx, site, t.result);
  if (!cancelled && t.result.kind === 'history-repair-batch')
    await applyRepairBatch(tx, site, t.result);
  if (!cancelled && t.result.kind === 'browser-risk') {
    const r = t.result;
    await tx.query(
      `INSERT INTO liekan_browser_risk_window(website_id,window_end,epoch,rule_version,coverage,events,visits,insufficient,flagged)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 WHERE coalesce((SELECT epoch FROM liekan_log_state WHERE website_id=$1),1)=$3::bigint
      ON CONFLICT(website_id,window_end) DO UPDATE SET epoch=EXCLUDED.epoch,rule_version=EXCLUDED.rule_version,coverage=EXCLUDED.coverage,
      events=EXCLUDED.events,visits=EXCLUDED.visits,insufficient=EXCLUDED.insufficient,flagged=EXCLUDED.flagged,computed_at=clock_timestamp()`,
      [
        site,
        r.windowEnd,
        r.logEpoch,
        r.ruleVersion,
        r.coverage,
        r.events,
        r.visits,
        r.insufficient,
        r.flagged,
      ],
    );
    await tx.query(
      `UPDATE liekan_browser_risk_state SET next_window=$2,computed_at=clock_timestamp(),next_attempt_at=clock_timestamp(),error_code=NULL,rule_version=$3
      WHERE website_id=$1 AND epoch=$4 AND next_window=$5`,
      [site, r.nextAfter, r.ruleVersion, r.logEpoch, r.nextBefore],
    );
  }
  await tx.query(
    'UPDATE liekan_warehouse_task SET status=$2,updated_at=clock_timestamp() WHERE task_id=$1',
    [taskId, cancelled ? 'cancelled' : 'published'],
  );
}

export async function waitWarehouseTask(db: ControlDatabase, taskId: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const [t] = await db.read<{ status: string }>(
      'SELECT status FROM liekan_warehouse_task WHERE task_id=$1',
      [taskId],
    );
    if (t?.status === 'published') return;
    if (!t || t.status === 'cancelled') throw new WarehouseConflict('warehouse-task-cancelled');
    await delay(100);
  } while (Date.now() < deadline);
  throw new WarehouseConflict('warehouse-task-publication-pending');
}

export async function recoverWarehouseTasks(runtime: WarehouseRuntime) {
  // A producer can fail after registration and before enqueue. Multiple recovery
  // workers may resend the same sealed outbox; the accepted task ID deduplicates it.
  for (const task of await runtime.db.read<{ task_id: string }>(
    "SELECT task_id FROM liekan_warehouse_task WHERE status='pending' AND next_enqueue_at<=clock_timestamp() ORDER BY created_at LIMIT 10",
  ))
    await deliverWarehouseTask(runtime, task.task_id);
}
