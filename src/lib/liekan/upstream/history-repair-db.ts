import { warehouseEnabled } from '@/lib/liekan/warehouse/authority-routing';
import { assertTransitionMaintenance } from './warehouse-maintenance';
import { randomUUID } from 'node:crypto';
import { getSettings } from '../store';
import { getTrafficPolicy } from './traffic-quality';
import { getPublishedCatalog } from '../crawlers/published';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
import { primary, lockWritableWebsite, LiekanError, type WriteIdentity } from './server';
import { getQueue } from '../log-ingestion/queue';
import { fromPrisma } from 'pg-boss';
import {
  HISTORY_REPAIR_CAMPAIGN,
  HISTORY_REPAIR_ENGINE,
  type HistoryRepairCounts,
  type HistoryRepairRun,
  type HistoryRepairStatus,
  type HistoryRepairPreview,
  type HistoryRepairLogImpact,
} from '../contracts/history-repair';
import {
  emptyCounts,
  publicRepairCounts,
  publicRepairPreview,
  hash,
  progress,
  rulepack,
  type RepairRulepack,
  type PreviewPolicy,
} from '../history-repair/model';
import { sendRepairStep } from '../history-repair/queue';

/** The SQL aliases i and r denote an input chunk and its run. */
export const unreferencedRepairInputSql = `NOT EXISTS(SELECT 1 FROM liekan_history_repair_result p WHERE p.run_id=r.id AND p.generation IN(r.active_generation,r.previous_generation) AND p.proof->>'uploadId'=i.upload_id::text)
  AND NOT coalesce((coalesce(r.generation_archive->r.active_generation::text->'preview',CASE WHEN r.active_generation=r.generation THEN r.preview END)->'sourceUploads' ? i.upload_id::text),false)
  AND NOT coalesce((coalesce(r.generation_archive->r.previous_generation::text->'preview',CASE WHEN r.previous_generation=r.generation THEN r.preview END)->'sourceUploads' ? i.upload_id::text),false)`;

/** Scoped readers bind the run UUID at $1; resolve the input boundary once per query. */
export const currentRepairInputSql = `i.created_at>coalesce((SELECT (boundary.snapshot->>'inputNotBefore')::timestamptz FROM liekan_history_repair_run boundary WHERE boundary.id=$1::uuid),'-infinity'::timestamptz)`;

export interface RepairTx {
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>;
  $queryRawUnsafe<T = Record<string, unknown>[]>(sql: string, ...params: unknown[]): Promise<T>;
}
export interface RepairSnapshot {
  rulepack: RepairRulepack;
  policy: PreviewPolicy;
  trafficVersion: string;
  domain: string;
  ownerId: string | null;
  teamId: string | null;
  epoch: number;
  logPolicy: string;
  governanceRevision: string;
  timezone: string;
  authorityHash: string;
  inputNotBefore?: string;
  warehouseSource?: import('../warehouse/read').ReadBoundary;
  warehouseFreeze?: { epoch: string; version: string; deletionRevision: string };
}
export interface RepairCursor {
  time?: string;
  id?: string;
  membership?: string;
  daysAfter?: string;
  impactScope?: string;
  impactKey?: string;
  visitorsAfter?: string;
  visitorSession?: string;
}
export interface RunRow {
  id: string;
  website_id: string;
  campaign_id: string;
  actor_id: string;
  status: HistoryRepairStatus;
  phase: string;
  revision: number;
  input_revision: number;
  generation: string;
  active_generation: string | null;
  previous_generation: string | null;
  active_revision: number;
  frozen_at: Date;
  repair_scope_id: string;
  scope_finalized: boolean;
  scope_changed: boolean;
  scope_revision: bigint;
  membership_digest: string | null;
  excluded_batches: string[];
  snapshot: RepairSnapshot;
  cursor: RepairCursor;
  counts: HistoryRepairCounts;
  log_impact: HistoryRepairLogImpact;
  generation_archive: Record<
    string,
    {
      snapshot: RepairSnapshot;
      preview: HistoryRepairPreview | null;
      inputRevision: number;
      confirmedAt: string | null;
    }
  >;
  preview: HistoryRepairPreview | null;
  approved_digest: string | null;
  confirmed_at: Date | null;
  partial_confirmed: boolean;
  lease_token: string | null;
  lease_until: Date | null;
  queued_job_id: string | null;
  batch_size: number;
  attempts: number;
  next_attempt_at: Date;
  error_code: string | null;
  locale: 'zh-CN' | 'en-US';
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}
export const iso = (value: Date | string | null) =>
  value == null ? null : new Date(value).toISOString();
export function repairGeneration(row: RunRow, generation: string, explicit: boolean) {
  const archived = row.generation_archive[generation];
  if (generation === row.generation && !(explicit && archived?.confirmedAt))
    return { snapshot: row.snapshot, preview: row.preview };
  return archived;
}
export function dto(row: RunRow): HistoryRepairRun {
  const counts = { ...emptyCounts(), ...row.counts };
  return {
    id: row.id,
    websiteId: row.website_id,
    campaignId: row.campaign_id,
    status: row.status,
    revision: row.revision,
    inputRevision: row.input_revision,
    generation: row.generation,
    activeGeneration: row.active_generation,
    previousGeneration: row.previous_generation,
    progress: progress(row.status, counts),
    phase: row.phase,
    counts: publicRepairCounts({
      ...counts,
      beforeIdentityMissingPV: row.counts.beforeIdentityMissingPV,
      afterIdentityMissingPV: row.counts.afterIdentityMissingPV,
    }),
    frozenAt: iso(row.frozen_at),
    scopeId: row.repair_scope_id,
    scopeChanged: row.scope_changed,
    errorCode: row.error_code,
    updatedAt: iso(row.updated_at),
    completedAt: iso(row.completed_at),
    preview: publicRepairPreview(row.preview),
  };
}
export async function repairTransaction<T>(work: (tx: RepairTx) => Promise<T>) {
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new LiekanError('数据库设置无效', 500);
  return primary().$transaction(
    async (tx: RepairTx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout TO '5s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout TO '1s'");
      return work(tx);
    },
    { timeout: 30000, maxWait: 1000, isolationLevel: 'ReadCommitted' },
  ) as Promise<T>;
}
export async function runForSite(
  tx: RepairTx,
  websiteId: string,
  lock = true,
): Promise<RunRow | undefined> {
  const row = (
    await tx.$queryRawUnsafe<RunRow[]>(
      `SELECT r.*,
   (r.scope_changed OR EXISTS(SELECT 1 FROM liekan_history_repair_action a WHERE a.run_id=r.id AND a.generation=r.generation AND a.action='scope-gap')) AS scope_changed,
   CASE WHEN EXISTS(SELECT 1 FROM liekan_history_repair_action a WHERE a.run_id=r.id AND a.generation=r.generation AND a.action='scope-gap') THEN CASE WHEN r.active_generation IS NOT NULL THEN 'active-scope-gap' ELSE 'scope-changed' END ELSE r.error_code END AS error_code
   FROM liekan_history_repair_run r WHERE r.website_id=$1::uuid AND r.campaign_id=$2 ${lock ? 'FOR NO KEY UPDATE OF r' : ''}`,
      websiteId,
      HISTORY_REPAIR_CAMPAIGN,
    )
  )[0];
  if (lock && row && warehouseEnabled()) {
    const [pending] = await tx.$queryRawUnsafe(
      `SELECT 1 FROM liekan_warehouse_task WHERE website_id=$1::uuid AND kind IN('history-repair-batch','history-repair-input')
      AND scope_key=$2 AND status IN('pending','confirmed') LIMIT 1`,
      websiteId,
      row.id,
    );
    if (pending)
      throw new LiekanError(
        '修复分批结果正在发布，请稍后重试',
        409,
        'history-repair-publication-pending',
      );
  }
  return row;
}
export async function requireRun(tx: RepairTx, websiteId: string, identity: WriteIdentity) {
  await lockWritableWebsite(tx, websiteId, identity);
  const row = await runForSite(tx, websiteId);
  if (!row) throw new LiekanError('请先扫描历史数据', 409, 'history-repair-scan-required');
  return row;
}
export function expected(row: RunRow, revision: number, runId?: string) {
  if (runId && row.id !== runId)
    throw new LiekanError(
      '任务已因重置或重新扫描而变化，请刷新',
      409,
      'history-repair-run-conflict',
    );
  if (row.revision !== revision)
    throw new LiekanError('候选修订已更新，请刷新', 409, 'history-repair-revision-conflict');
}
export async function snapshot(
  tx: RepairTx,
  id: string,
  timezone: string,
): Promise<RepairSnapshot> {
  const [site] = await tx.$queryRawUnsafe<
    {
      domain: string;
      user_id: string | null;
      team_id: string | null;
      epoch: number;
      policy_revision: string;
      governance_revision: string;
    }[]
  >(
    `SELECT w.domain,w.user_id,w.team_id,coalesce(s.epoch,1) AS epoch,coalesce(s.policy_revision,0)::text AS policy_revision,coalesce(g.revision,0)::text AS governance_revision FROM website w LEFT JOIN liekan_log_state s USING(website_id) LEFT JOIN liekan_traffic_governance g USING(website_id) WHERE w.website_id=$1::uuid AND w.deleted_at IS NULL`,
    id,
  );
  if (!site) throw new LiekanError('站点不存在', 404);
  const settings = await getSettings(id, tx);
  const savedPolicy = await getTrafficPolicy(id, tx);
  const policy: PreviewPolicy = {
    mode: savedPolicy.mode,
    allowedHostnames: savedPolicy.allowedHostnames,
    revision: savedPolicy.revision,
  };
  const pack = rulepack({
    catalogVersion: getPublishedCatalog()?.version || '',
    rulesRevision: settings.rulesRevision,
    rules: settings.rules,
    configuration: settings.crawlerRules,
    botCheckDisabled: ['1', 'true'].includes(process.env.DISABLE_BOT_CHECK || ''),
  });
  const authority = {
    policy: {
      mode: policy.mode,
      allowedHostnames: policy.allowedHostnames,
      revision: policy.revision,
    },
    trafficVersion: TRAFFIC_POLICY_VERSION,
    domain: site.domain,
    ownerId: site.user_id,
    teamId: site.team_id,
    epoch: site.epoch,
    logPolicy: site.policy_revision,
    governanceRevision: site.governance_revision,
    timezone,
    rulesRevision: settings.rulesRevision,
    configuration: settings.crawlerRules,
    botCheckDisabled: pack.botCheckDisabled,
    engine: HISTORY_REPAIR_ENGINE,
  };
  const warehouse = warehouseEnabled()
    ? (
        await tx.$queryRawUnsafe<{ epoch: string; version: string; deletionRevision: string }[]>(
          'SELECT epoch::text,version::text,deletion_revision::text AS "deletionRevision" FROM liekan_warehouse_site WHERE website_id=$1::uuid AND state=\'active\'',
          id,
        )
      )[0]
    : undefined;
  return {
    ...authority,
    rulepack: pack,
    authorityHash: hash(authority),
    ...(warehouse ? { warehouseFreeze: warehouse } : {}),
  };
}
export async function assertSnapshot(tx: RepairTx, row: RunRow, includeCatalog = false) {
  if (row.scope_changed)
    throw new LiekanError(
      '冻结后的历史输入发生变化，请重新预览',
      409,
      'history-repair-scope-changed',
    );
  const current = await snapshot(tx, row.website_id, row.snapshot.timezone);
  if (
    current.authorityHash !== row.snapshot.authorityHash ||
    (includeCatalog && current.rulepack.hash !== row.snapshot.rulepack.hash)
  )
    throw new LiekanError(
      '规则、权限或统计策略已变化，请重新预览',
      409,
      'history-repair-snapshot-changed',
    );
}
export async function enqueueRepair(
  tx: RepairTx,
  row: Pick<RunRow, 'id'>,
  delay = 0,
  recordPointer = true,
) {
  const stepId = await sendRepairStep(await getQueue(), fromPrisma(tx), row.id, { delay });
  if (recordPointer)
    await tx.$executeRawUnsafe(
      'UPDATE liekan_history_repair_run SET queued_job_id=$2::uuid WHERE id=$1::uuid',
      row.id,
      stepId,
    );
  return stepId;
}
export async function replayAction<T>(
  tx: RepairTx,
  websiteId: string,
  identity: WriteIdentity,
  actionId: string,
  payload: unknown,
): Promise<T | undefined> {
  const [old] = await tx.$queryRawUnsafe<
    { website_id: string; actor_id: string; payload_hash: string; response: T }[]
  >(
    'SELECT website_id,actor_id,payload_hash,response FROM liekan_history_repair_action WHERE id=$1::uuid',
    actionId,
  );
  if (!old) {
    await assertTransitionMaintenance(tx, 'repair');
    return undefined;
  }
  if (
    old.website_id !== websiteId ||
    old.actor_id !== identity.userId ||
    old.payload_hash !== hash(payload)
  )
    throw new LiekanError('同一操作标识的载荷发生冲突', 409, 'history-repair-action-conflict');
  return old.response;
}
export async function audit<T>(
  tx: RepairTx,
  row: Pick<RunRow, 'id' | 'website_id' | 'generation'>,
  identity: WriteIdentity | null,
  action: string,
  payload: unknown,
  response: T,
  actionId: string = randomUUID(),
  details: Record<string, unknown> = {},
) {
  await tx.$executeRawUnsafe(
    `INSERT INTO liekan_history_repair_action(id,website_id,run_id,actor_id,generation,action,payload_hash,response,details) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb,$9::jsonb)`,
    actionId,
    row.website_id,
    row.id,
    identity?.userId || null,
    row.generation,
    action,
    hash(payload),
    JSON.stringify(response),
    JSON.stringify(details),
  );
  return response;
}
export async function saveRun(tx: RepairTx, row: RunRow) {
  await tx.$executeRawUnsafe(
    `UPDATE liekan_history_repair_run SET status=$2,phase=$3,cursor=$4::jsonb,counts=$5::jsonb,preview=$6::jsonb,error_code=$7,completed_at=$8,log_impact=$9::jsonb,updated_at=clock_timestamp() WHERE id=$1::uuid`,
    row.id,
    row.status,
    row.phase,
    JSON.stringify(row.cursor),
    JSON.stringify(row.counts),
    row.preview ? JSON.stringify(row.preview) : null,
    row.error_code,
    row.completed_at,
    JSON.stringify(row.log_impact),
  );
}
export async function eligibility(tx: RepairTx, websiteId: string) {
  const [value] = await tx.$queryRawUnsafe<{ eligible: boolean; has_data: boolean }[]>(
    `SELECT (w.website_id=ANY(c.eligible_websites) AND NOT coalesce(s.is_demo,false) AND c.state='active') AS eligible,
   ${warehouseEnabled() ? 'false' : '(EXISTS(SELECT 1 FROM website_event e WHERE e.website_id=w.website_id) OR EXISTS(SELECT 1 FROM liekan_log l WHERE l.website_id=w.website_id))'} AS has_data
   FROM website w CROSS JOIN liekan_history_repair_campaign c LEFT JOIN liekan_setting s ON s.website_id=w.website_id WHERE w.website_id=$1::uuid AND w.deleted_at IS NULL AND c.id=$2`,
    websiteId,
    HISTORY_REPAIR_CAMPAIGN,
  );
  return { eligible: !!value?.eligible, hasData: !!value?.has_data };
}

export async function requireCompatibleRepairWorker(tx: RepairTx) {
  await assertTransitionMaintenance(tx, 'repair');
  try {
    const [ready] = await tx.$queryRawUnsafe<{ worker: boolean; queue: boolean }[]>(
      `SELECT EXISTS(SELECT 1 FROM liekan_worker_state WHERE version=$1 AND heartbeat_at>clock_timestamp()-interval '120 seconds') AS worker,EXISTS(SELECT 1 FROM liekan_queue_installation WHERE id='liekan_jobs' AND package_version='12.36.0') AS queue`,
      HISTORY_REPAIR_ENGINE,
    );
    if (!ready?.queue)
      throw new LiekanError('历史修复队列尚未初始化', 503, 'history-repair-queue-unavailable');
    if (!ready.worker)
      throw new LiekanError(
        '兼容的历史修复工作进程暂未就绪',
        503,
        'history-repair-worker-unavailable',
      );
    const [queue] = await tx.$queryRawUnsafe<{ ready: boolean }[]>(
      "SELECT EXISTS(SELECT 1 FROM liekan_jobs.queue WHERE name='liekan-history-repair') AS ready",
    );
    if (!queue?.ready)
      throw new LiekanError('历史修复队列尚未初始化', 503, 'history-repair-queue-unavailable');
  } catch (error) {
    if (error instanceof LiekanError) throw error;
    throw new LiekanError('历史修复服务状态暂不可读', 503, 'history-repair-worker-unavailable');
  }
}
export async function archiveGeneration(tx: RepairTx, row: RunRow) {
  await tx.$executeRawUnsafe(
    `UPDATE liekan_history_repair_run SET generation_archive=jsonb_set(generation_archive,ARRAY[generation::text],jsonb_build_object('snapshot',snapshot,'preview',preview,'inputRevision',input_revision,'confirmedAt',confirmed_at,'archivedAt',clock_timestamp())) WHERE id=$1::uuid AND (generation_archive->generation::text IS NULL OR generation_archive->generation::text->>'confirmedAt' IS NULL)`,
    row.id,
  );
}
