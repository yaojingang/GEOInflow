import { randomUUID } from 'node:crypto';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { PgBoss } from 'pg-boss';
import {
  defaultStorageSettings,
  type StorageAction,
  type StorageRun,
  type StorageScope,
  type StorageSettings,
  type StorageState,
} from '../contracts/storage-retention';
import { aiExecutor } from './ai-db';
import { analysisCapacity, analysisTransaction } from './analysis-rollups-db';
import { analysisHash } from './analysis-rollups-model';
import { authorizeCrawler } from './crawler-access';
import { LiekanError, lockWritableWebsite, primary } from './server';
import { storagePressure, storageSitePressureSql } from './storage-capacity';
import {
  collectGenerationBatch,
  previewGenerations,
  unreferencedGenerationSql,
} from './storage-generation-gc';
import {
  collectCompletedJobBatch,
  completedQueueSql,
  freezeCompletedJobs,
  type QueueCutoffs,
  queueCutoffParameters,
} from './storage-queue-retention';

type Tx = Parameters<Parameters<typeof analysisTransaction>[0]>[0];
type Row = Record<string, any>;
type Conditions = QueueCutoffs & { generationCutoff: string; frozen?: boolean };
const key = (websiteId?: string) => websiteId || 'instance';
const iso = (value: any) => (value == null ? null : new Date(value).toISOString());
const number = (value: any) => Number(value || 0);
async function shortTransaction<T>(work: (tx: Tx) => Promise<T>, budgetMs = 1000): Promise<T> {
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new LiekanError('数据库设置无效', 500);
  return primary().$transaction(
    async (tx: Tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout TO '200ms'");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout TO '1s'");
      return work(tx);
    },
    { timeout: budgetMs, maxWait: 200 },
  );
}
const sameOwnership = (saved: Row, current: Row) =>
  saved?.user_id === current.user_id && saved?.team_id === current.team_id;
const cutoffs = (
  settings: Pick<StorageSettings, 'generationHours' | 'completedHours' | 'wakeHours'>,
  now = Date.now(),
): Conditions => ({
  generationCutoff: new Date(now - settings.generationHours * 3600000).toISOString(),
  completedCutoff: new Date(now - settings.completedHours * 3600000).toISOString(),
  wakeCutoff: new Date(now - settings.wakeHours * 3600000).toISOString(),
  shortCutoff: new Date(now - 3600000).toISOString(),
});
const dto = (row: Row): StorageRun => ({
  id: row.id,
  scope: row.website_id ? 'website' : 'instance',
  websiteId: row.website_id,
  kind: row.kind,
  status: row.status,
  createdAt: iso(row.created_at),
  expiresAt: iso(row.expires_at),
  startedAt: iso(row.started_at),
  completedAt: iso(row.completed_at),
  candidateCount: number(row.candidate_count),
  protectedCount: number(row.protected_count),
  estimatedBytes: String(row.estimated_bytes),
  rowsDeleted: String(row.rows_deleted),
  generationsDeleted: number(row.generations_deleted),
  jobsDeleted: number(row.jobs_deleted),
  releasedBytes: String(row.released_bytes),
  errorCode: row.error_code,
  physicalBytesBefore: row.physical_bytes_before == null ? null : String(row.physical_bytes_before),
  physicalBytesAfter: row.physical_bytes_after == null ? null : String(row.physical_bytes_after),
});

async function authority(tx: Tx, websiteId?: string, actorId?: string, write = false) {
  if (websiteId && process.env.CLICKHOUSE_URL)
    throw new LiekanError('统计加速当前支持 PostgreSQL', 501, 'storage-unsupported');
  if (!websiteId) {
    if (!actorId) return null;
    const [actor] = await tx.$queryRawUnsafe<Row[]>(
      'SELECT role FROM "user" WHERE user_id=$1::uuid AND deleted_at IS NULL FOR SHARE',
      actorId,
    );
    if (actor?.role !== 'admin')
      throw new LiekanError('此操作需要平台管理员权限', 403, 'storage-admin-required');
    return null;
  }
  await lockWritableWebsite(
    tx,
    websiteId,
    actorId ? { userId: actorId } : undefined,
    write ? 'update' : 'share',
  );
  const [row] = await tx.$queryRawUnsafe<Row[]>(
    `SELECT s.epoch,w.user_id,w.team_id FROM liekan_analysis_site s JOIN website w USING(website_id)
     WHERE s.website_id=$1::uuid FOR ${write ? 'UPDATE' : 'SHARE'} OF s`,
    websiteId,
  );
  if (!row) throw new LiekanError('统计加速迁移未完成', 409, 'storage-site-missing');
  if (actorId) {
    const [actor] = await tx.$queryRawUnsafe<Row[]>(
      'SELECT role FROM "user" WHERE user_id=$1::uuid AND deleted_at IS NULL FOR SHARE',
      actorId,
    );
    if (!actor) throw new LiekanError('账户无效', 401, 'storage-authority-changed');
    await authorizeCrawler(aiExecutor(tx), { id: actorId, role: actor.role }, websiteId, 'control');
  }
  return row;
}
async function policy(tx: Tx, websiteId?: string, ensure = false) {
  if (ensure)
    await tx.$executeRawUnsafe(
      'INSERT INTO liekan_storage_policy(scope_key,website_id,revision,settings) VALUES($1,$2::uuid,0,$3::jsonb) ON CONFLICT DO NOTHING',
      key(websiteId),
      websiteId || null,
      JSON.stringify(defaultStorageSettings),
    );
  const [row] = await tx.$queryRawUnsafe<Row[]>(
    `SELECT * FROM liekan_storage_policy WHERE scope_key=$1 ${ensure ? 'FOR UPDATE' : ''}`,
    key(websiteId),
  );
  return (
    row || {
      scope_key: key(websiteId),
      website_id: websiteId || null,
      settings: defaultStorageSettings,
      revision: 0,
      actor_id: null,
    }
  );
}
async function queuePreview(tx: Tx, conditions: Conditions) {
  const [row] = await tx.$queryRawUnsafe<Row[]>(
    `SELECT count(*)::int AS count FROM liekan_jobs.job j WHERE $1::boolean AND ${completedQueueSql}`,
    true,
    ...queueCutoffParameters(conditions),
  );
  return number(row.count);
}
export async function readStorageState(scope: StorageScope): Promise<StorageState> {
  return analysisTransaction(async tx => {
    await authority(tx, scope.websiteId, scope.actorId);
    const p = await policy(tx, scope.websiteId);
    const c = cutoffs(p.settings);
    const preview = scope.websiteId
      ? await previewGenerations(tx, scope.websiteId, new Date(c.generationCutoff))
      : { candidateCount: 0, protectedCount: 0, estimatedBytes: '0' };
    const completedJobs = scope.websiteId ? 0 : await queuePreview(tx, c);
    const rows = await tx.$queryRawUnsafe<Row[]>(
      'SELECT * FROM liekan_storage_cleanup WHERE scope_key=$1 ORDER BY created_at DESC,id DESC LIMIT 20',
      key(scope.websiteId),
    );
    return {
      scope: scope.websiteId ? 'website' : 'instance',
      websiteId: scope.websiteId || null,
      canManageQueues: !scope.websiteId,
      policy: { ...p.settings, revision: number(p.revision) },
      capacity: scope.websiteId ? await analysisCapacity(tx, scope.websiteId) : null,
      preview: { ...preview, completedJobs },
      runs: rows.map(dto),
    };
  });
}

export async function readStorageRun(scope: StorageScope, id: string) {
  return analysisTransaction(async tx => {
    await authority(tx, scope.websiteId, scope.actorId);
    const [row] = await tx.$queryRawUnsafe<Row[]>(
      'SELECT * FROM liekan_storage_cleanup WHERE id=$1::uuid AND scope_key=$2',
      id,
      key(scope.websiteId),
    );
    if (!row) throw new LiekanError('清理操作不存在', 404, 'storage-run-missing');
    return dto(row);
  });
}

async function createRun(
  tx: Tx,
  input: {
    websiteId?: string;
    actorId?: string;
    locale?: string;
    kind: StorageRun['kind'];
    settings: StorageSettings;
    hourlyOnly?: boolean;
    policy: Row;
    site?: Row;
    requestId: string;
    hash: string;
  },
) {
  const id = randomUUID(),
    conditions = {
      ...cutoffs(input.settings),
      frozen: input.kind === 'manual',
      hourlyOnly: input.hourlyOnly || false,
      retention: {
        generationHours: input.settings.generationHours,
        completedHours: input.settings.completedHours,
        wakeHours: input.settings.wakeHours,
      },
    };
  const websiteId = input.websiteId;
  await tx.$executeRawUnsafe(
    `INSERT INTO liekan_storage_cleanup(id,scope_key,website_id,actor_id,locale,kind,status,policy_revision,epoch,ownership,conditions,request_id,request_hash)
     VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7,$8::bigint,$9::bigint,$10::jsonb,$11::jsonb,$12::uuid,$13)`,
    id,
    key(websiteId),
    websiteId || null,
    input.actorId || null,
    input.locale || 'zh-CN',
    input.kind,
    input.kind === 'manual' ? 'preview' : 'queued',
    String(input.policy.revision),
    input.site ? String(input.site.epoch) : null,
    input.site
      ? JSON.stringify({ user_id: input.site.user_id, team_id: input.site.team_id })
      : null,
    JSON.stringify(conditions),
    input.requestId,
    input.hash,
  );
  await tx.$executeRawUnsafe(
    'UPDATE liekan_storage_cleanup SET physical_bytes_before=pg_database_size(current_database()) WHERE id=$1::uuid',
    id,
  );
  let count = 0,
    protectedCount = 0,
    estimatedBytes = '0';
  if (websiteId && conditions.frozen) {
    // Freeze exact membership. Later reference checks can only reduce this set.
    await tx.$executeRawUnsafe(
      `INSERT INTO liekan_storage_candidate(run_id,kind,record_id)
     SELECT $3::uuid,'generation',g.generation FROM liekan_analysis_generation g
     WHERE g.website_id=$1::uuid AND g.updated_at<$2::timestamptz AND ${unreferencedGenerationSql}`,
      websiteId,
      conditions.generationCutoff,
      id,
    );
    const [frozen] = await tx.$queryRawUnsafe<Row[]>(
      `SELECT count(*)::int AS count,coalesce(sum(g.estimated_bytes),0)::text AS bytes
     FROM liekan_storage_candidate c JOIN liekan_analysis_generation g ON g.generation=c.record_id AND g.website_id=$2::uuid
     WHERE c.run_id=$1::uuid AND c.kind='generation'`,
      id,
      websiteId,
    );
    const [protectedRow] = await tx.$queryRawUnsafe<Row[]>(
      `SELECT count(*)::int AS count FROM liekan_analysis_generation g
     WHERE g.website_id=$1::uuid AND g.updated_at<$2::timestamptz AND NOT (${unreferencedGenerationSql})`,
      websiteId,
      conditions.generationCutoff,
    );
    count = number(frozen.count);
    estimatedBytes = frozen.bytes;
    protectedCount = number(protectedRow.count);
  } else if (!websiteId && conditions.frozen) count = await freezeCompletedJobs(tx, id, conditions);
  const [row] = await tx.$queryRawUnsafe<Row[]>(
    'UPDATE liekan_storage_cleanup SET candidate_count=$2,protected_count=$3,estimated_bytes=$4::bigint WHERE id=$1::uuid RETURNING *',
    id,
    count,
    protectedCount,
    estimatedBytes,
  );
  return dto(row);
}

export async function storageAction(scope: StorageScope, input: StorageAction) {
  return analysisTransaction(async tx => {
    // Preview is an explicit bounded operation; it can freeze a large existing backlog.
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout TO '15s'");
    const site = await authority(tx, scope.websiteId, scope.actorId, input.action !== 'preview');
    const p = await policy(tx, scope.websiteId, true);
    const hash = analysisHash({ scope: key(scope.websiteId), actor: scope.actorId, input });
    const [receipt] = await tx.$queryRawUnsafe<Row[]>(
      'SELECT * FROM liekan_storage_operation WHERE request_id=$1::uuid',
      input.requestId,
    );
    if (receipt) {
      if (
        receipt.request_hash !== hash ||
        receipt.actor_id !== scope.actorId ||
        receipt.scope_key !== key(scope.websiteId)
      )
        throw new LiekanError('请求标识已用于其他操作', 409, 'storage-request-conflict');
      return receipt.response;
    }
    let response: unknown;
    if (input.action === 'policy') {
      if (number(p.revision) !== input.expectedRevision)
        throw new LiekanError('清理策略已变化，请重新读取', 409, 'storage-policy-changed');
      await tx.$executeRawUnsafe(
        `UPDATE liekan_storage_policy SET settings=$2::jsonb,actor_id=$3::uuid,revision=revision+1,
       next_check_at=clock_timestamp(),updated_at=clock_timestamp() WHERE scope_key=$1`,
        key(scope.websiteId),
        JSON.stringify(input.settings),
        scope.actorId,
      );
      response = { ...input.settings, revision: number(p.revision) + 1 };
    } else if (input.action === 'preview') {
      const [active] = await tx.$queryRawUnsafe<Row[]>(
        "SELECT id FROM liekan_storage_cleanup WHERE scope_key=$1 AND status IN('queued','running')",
        key(scope.websiteId),
      );
      if (active) throw new LiekanError('已有清理任务正在处理', 409, 'storage-run-active');
      const [previous] = await tx.$queryRawUnsafe<Row[]>(
        "SELECT * FROM liekan_storage_cleanup WHERE scope_key=$1 AND status='preview' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",
        key(scope.websiteId),
      );
      const retention = previous?.conditions?.retention;
      const reusable =
        previous &&
        previous.actor_id === scope.actorId &&
        +new Date(previous.expires_at) > Date.now() &&
        String(previous.policy_revision) === String(p.revision) &&
        (!site ||
          (String(previous.epoch) === String(site.epoch) &&
            sameOwnership(previous.ownership, site))) &&
        retention?.generationHours === input.generationHours &&
        retention?.completedHours === input.completedHours &&
        retention?.wakeHours === input.wakeHours;
      if (reusable) response = dto(previous);
      else {
        await tx.$executeRawUnsafe(
          "UPDATE liekan_storage_cleanup SET status='stopped',error_code='storage-preview-replaced',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE scope_key=$1 AND status='preview'",
          key(scope.websiteId),
        );
        // Explicit preview work has a 15-second statement budget. Recycle metadata before
        // freezing its replacement so repeated previews retain one candidate set per scope.
        await tx.$executeRawUnsafe(
          "DELETE FROM liekan_storage_candidate c USING liekan_storage_cleanup r WHERE r.id=c.run_id AND r.scope_key=$1 AND r.status IN('completed','stopped','failed')",
          key(scope.websiteId),
        );
        response = await createRun(tx, {
          ...scope,
          kind: 'manual',
          policy: p,
          site,
          settings: {
            ...p.settings,
            generationHours: input.generationHours,
            completedHours: input.completedHours,
            wakeHours: input.wakeHours,
          },
          requestId: input.requestId,
          hash,
        });
      }
    } else {
      const [run] = await tx.$queryRawUnsafe<Row[]>(
        'SELECT * FROM liekan_storage_cleanup WHERE id=$1::uuid AND scope_key=$2 FOR UPDATE',
        input.id,
        key(scope.websiteId),
      );
      if (!run) throw new LiekanError('清理操作不存在', 404, 'storage-run-missing');
      if (input.action === 'confirm') {
        if (run.actor_id !== scope.actorId)
          throw new LiekanError('请确认本人生成的清理预览', 403, 'storage-preview-owner');
        if (run.status === 'preview') {
          if (+new Date(run.expires_at) <= Date.now())
            throw new LiekanError('清理预览已过期，请重新预览', 410, 'storage-preview-expired');
          if (String(run.policy_revision) !== String(p.revision))
            throw new LiekanError('清理策略已变化，请重新预览', 409, 'storage-policy-changed');
          if (
            site &&
            (String(site.epoch) !== String(run.epoch) || !sameOwnership(run.ownership, site))
          )
            throw new LiekanError('网站范围已变化，请重新预览', 409, 'storage-scope-changed');
          const [active] = await tx.$queryRawUnsafe<Row[]>(
            "SELECT id FROM liekan_storage_cleanup WHERE scope_key=$1 AND status IN('queued','running')",
            key(scope.websiteId),
          );
          if (active) throw new LiekanError('已有清理任务正在处理', 409, 'storage-run-active');
          await tx.$executeRawUnsafe(
            "UPDATE liekan_storage_cleanup SET status='queued',updated_at=clock_timestamp() WHERE id=$1::uuid",
            run.id,
          );
        } else if (!['queued', 'running', 'completed'].includes(run.status))
          throw new LiekanError('请重新生成清理预览', 409, 'storage-run-terminal');
      } else if (['preview', 'queued', 'running'].includes(run.status)) {
        await tx.$executeRawUnsafe(
          "UPDATE liekan_storage_cleanup SET status='stopped',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1::uuid",
          run.id,
        );
      }
      const [updated] = await tx.$queryRawUnsafe<Row[]>(
        'SELECT * FROM liekan_storage_cleanup WHERE id=$1::uuid',
        run.id,
      );
      response = dto(updated);
    }
    await tx.$executeRawUnsafe(
      'INSERT INTO liekan_storage_operation(request_id,scope_key,actor_id,action,request_hash,response) VALUES($1::uuid,$2,$3::uuid,$4,$5,$6::jsonb)',
      input.requestId,
      key(scope.websiteId),
      scope.actorId,
      input.action,
      hash,
      JSON.stringify(response),
    );
    return response;
  });
}

function nextCheck(settings: StorageSettings, now: Date) {
  const local = formatInTimeZone(now, settings.timezone, 'yyyy-MM-dd');
  const daily = fromZonedTime(
    `${local}T${String(settings.hour).padStart(2, '0')}:00:00`,
    settings.timezone,
  );
  return new Date(Math.min(+now + 3600000, +daily > +now ? +daily : +now + 3600000));
}
async function scheduleStorageRuns(deadline: number) {
  const instanceOnly = !!process.env.CLICKHOUSE_URL;
  await shortTransaction(async tx => {
    if (!instanceOnly)
      await tx.$executeRawUnsafe(
        `INSERT INTO liekan_storage_policy(scope_key,website_id,revision,settings)
     SELECT w.website_id::text,w.website_id,0,$1::jsonb FROM website w JOIN liekan_analysis_site s USING(website_id)
     WHERE w.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM liekan_storage_policy p WHERE p.website_id=w.website_id)
     ORDER BY w.website_id LIMIT 100 ON CONFLICT DO NOTHING`,
        JSON.stringify(defaultStorageSettings),
      );
    await policy(tx, undefined, true);
  });
  const global = instanceOnly ? null : await shortTransaction(tx => analysisCapacity(tx, null));
  const globalPressure =
    !!global && BigInt(global.globalBytes) * 100n >= BigInt(global.globalLimit) * 80n;
  const candidates = await shortTransaction(tx =>
    tx.$queryRawUnsafe<Row[]>(
      `SELECT p.* FROM liekan_storage_policy p ${instanceOnly ? '' : 'LEFT JOIN liekan_analysis_site s USING(website_id)'}
     WHERE (p.settings->>'enabled')::boolean AND ${
       instanceOnly
         ? 'p.website_id IS NULL AND p.next_check_at<=clock_timestamp()'
         : `(p.next_check_at<=clock_timestamp()
      OR ((p.settings->>'pressureEnabled')::boolean AND s.website_id IS NOT NULL AND (${storageSitePressureSql} OR $1::boolean)))`
}
     AND NOT EXISTS(SELECT 1 FROM liekan_storage_cleanup r WHERE r.scope_key=p.scope_key AND
      (r.status IN('queued','running') OR (r.kind='pressure' AND r.created_at>clock_timestamp()-interval '5 minutes')))
     ORDER BY p.next_check_at,p.scope_key LIMIT 8`,
      ...(instanceOnly ? [] : [globalPressure]),
    ),
  );
  for (const candidate of candidates) {
    if (Date.now() >= deadline - 1250) break;
    try {
      await shortTransaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout TO '1s'");
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout TO '200ms'");
        const site = await authority(
          tx,
          candidate.website_id || undefined,
          candidate.actor_id || undefined,
          true,
        );
        const p = await policy(tx, candidate.website_id || undefined, true);
        if (!p.settings.enabled) return;
        const [active] = await tx.$queryRawUnsafe<Row[]>(
          "SELECT id FROM liekan_storage_cleanup WHERE scope_key=$1 AND status IN('queued','running')",
          p.scope_key,
        );
        if (active) return;
        const capacity = site ? await analysisCapacity(tx, candidate.website_id) : null;
        const pressure = capacity && p.settings.pressureEnabled && storagePressure(capacity);
        if (!pressure && +new Date(p.next_check_at) > Date.now()) return;
        const now = new Date(),
          day = formatInTimeZone(now, p.settings.timezone, 'yyyy-MM-dd');
        const daily =
          p.last_daily !== day &&
          Number(formatInTimeZone(now, p.settings.timezone, 'H')) >= p.settings.hour;
        if (site && !pressure && !daily) {
          await tx.$executeRawUnsafe(
            'UPDATE liekan_storage_policy SET next_check_at=$2 WHERE scope_key=$1',
            p.scope_key,
            nextCheck(p.settings, now),
          );
          return;
        }
        const settings = {
          ...p.settings,
          generationHours: pressure ? 1 : p.settings.generationHours,
        };
        await createRun(tx, {
          websiteId: p.website_id || undefined,
          actorId: p.actor_id || undefined,
          kind: pressure ? 'pressure' : 'scheduled',
          policy: p,
          site,
          settings,
          hourlyOnly: !site && !daily,
          requestId: randomUUID(),
          hash: analysisHash([p.scope_key, p.revision, Date.now()]),
        });
        await tx.$executeRawUnsafe(
          'UPDATE liekan_storage_policy SET next_check_at=$2,last_daily=CASE WHEN $4 THEN $3 ELSE last_daily END WHERE scope_key=$1',
          p.scope_key,
          nextCheck(p.settings, new Date()),
          day,
          daily,
        );
      });
    } catch (error) {
      if (
        error instanceof LiekanError &&
        [401, 403, 404].includes(error.status) &&
        Date.now() < deadline - 1250
      ) {
        await shortTransaction(tx =>
          tx.$executeRawUnsafe(
            `UPDATE liekan_storage_policy SET settings=jsonb_set(settings,'{enabled}','false'::jsonb),
             revision=revision+1,updated_at=clock_timestamp()
             WHERE scope_key=$1 AND revision=$2::bigint AND actor_id IS NOT DISTINCT FROM $3::uuid`,
            candidate.scope_key,
            String(candidate.revision),
            candidate.actor_id || null,
          ),
        );
      }
      // Fixed diagnostics keep permission and database details out of service logs.
      console.info(
        JSON.stringify({
          event: 'storage-cleanup-schedule',
          outcome: 'deferred',
          code: error instanceof LiekanError ? error.code : 'storage-busy',
        }),
      );
    }
  }
}

export async function processStorageRun(
  id: string,
  boss: Pick<PgBoss, 'deleteJob'>,
  budgetMs = 2000,
) {
  return shortTransaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout TO '200ms'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout TO '1s'");
    // Scope is immutable. Lock resource and policy before the run, matching publication order.
    const [candidate] = await tx.$queryRawUnsafe<Row[]>(
      "SELECT * FROM liekan_storage_cleanup WHERE id=$1::uuid AND status IN('queued','running')",
      id,
    );
    if (!candidate) return false;
    const site = await authority(
      tx,
      candidate.website_id || undefined,
      candidate.actor_id || undefined,
      true,
    );
    const p = await policy(tx, candidate.website_id || undefined, true);
    const [run] = await tx.$queryRawUnsafe<Row[]>(
      "SELECT * FROM liekan_storage_cleanup WHERE id=$1::uuid AND status IN('queued','running') FOR UPDATE SKIP LOCKED",
      id,
    );
    if (!run) return false;
    if (
      String(p.revision) !== String(run.policy_revision) ||
      (run.kind !== 'manual' && !p.settings.enabled) ||
      (site && (String(site.epoch) !== String(run.epoch) || !sameOwnership(run.ownership, site)))
    ) {
      await tx.$executeRawUnsafe(
        "UPDATE liekan_storage_cleanup SET status='stopped',error_code='storage-scope-changed',completed_at=clock_timestamp() WHERE id=$1::uuid",
        id,
      );
      return false;
    }
    const conditions = run.conditions as Conditions;
    if (!site && !conditions.frozen) await freezeCompletedJobs(tx, id, conditions, 2000);
    const gc = site
      ? await collectGenerationBatch(
          tx,
          run.website_id,
          new Date(conditions.generationCutoff),
          2000,
          conditions.frozen ? id : undefined,
          20,
        )
      : { rowsDeleted: 0, generationsDeleted: 0, releasedBytes: '0', more: false };
    const queues = site
      ? { jobsDeleted: 0, more: false }
      : await collectCompletedJobBatch(tx, id, conditions, boss);
    let more = gc.more || queues.more;
    if (!site && !conditions.frozen && !more) more = (await queuePreview(tx, conditions)) > 0;
    if (run.kind === 'pressure' && site) {
      const capacity = await analysisCapacity(tx, run.website_id);
      if (!storagePressure(capacity, 70)) more = false;
    }
    await tx.$executeRawUnsafe(
      `UPDATE liekan_storage_cleanup SET status=$2,started_at=coalesce(started_at,clock_timestamp()),
      rows_deleted=rows_deleted+$3::bigint,generations_deleted=generations_deleted+$4,jobs_deleted=jobs_deleted+$5,
      released_bytes=released_bytes+$6::bigint,completed_at=CASE WHEN $2='completed' THEN clock_timestamp() END,updated_at=clock_timestamp(),
      physical_bytes_after=CASE WHEN $2='completed' THEN pg_database_size(current_database()) ELSE physical_bytes_after END
      WHERE id=$1::uuid`,
      id,
      more ? 'running' : 'completed',
      gc.rowsDeleted,
      gc.generationsDeleted,
      queues.jobsDeleted,
      gc.releasedBytes,
    );
    return more;
  }, budgetMs);
}

let pumping = false;
export async function pumpStorageRetention(
  boss: Pick<PgBoss, 'deleteJob'>,
  options: { schedule?: boolean; budgetMs?: number; manualOnly?: boolean } = {},
) {
  if (pumping) return;
  pumping = true;
  try {
    const deadline = Date.now() + (options.budgetMs ?? 5000);
    if (options.schedule !== false) await scheduleStorageRuns(deadline);
    while (Date.now() < deadline - 1250) {
      const rows = await shortTransaction(tx =>
        tx.$queryRawUnsafe<Row[]>(
          `SELECT id FROM liekan_storage_cleanup WHERE status IN('queued','running') ${options.manualOnly ? "AND kind='manual'" : ''} ${process.env.CLICKHOUSE_URL ? 'AND website_id IS NULL' : ''} ORDER BY updated_at,id LIMIT 8`,
        ),
      );
      if (!rows.length) break;
      let worked = false;
      for (const row of rows) {
        if (Date.now() >= deadline - 2250) break;
        try {
          await processStorageRun(row.id, boss, Math.min(2000, deadline - Date.now() - 250));
          worked = true;
        } catch (error) {
          if (error instanceof LiekanError && [401, 403, 404].includes(error.status)) {
            if (Date.now() < deadline - 1250)
              await shortTransaction(tx =>
                tx.$executeRawUnsafe(
                  "UPDATE liekan_storage_cleanup SET status='stopped',error_code='storage-authority-changed',completed_at=clock_timestamp() WHERE id=$1::uuid AND status IN('queued','running')",
                  row.id,
                ),
              );
          }
          console.info(
            JSON.stringify({
              event: 'storage-cleanup-batch',
              outcome: 'deferred',
              code: error instanceof LiekanError ? error.code : 'storage-busy',
            }),
          );
        }
      }
      if (!worked) break;
    }
    if (Date.now() >= deadline - 1250) return;
    await shortTransaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout TO '1s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout TO '200ms'");
      await tx.$executeRawUnsafe(`DELETE FROM liekan_storage_candidate WHERE (run_id,kind,queue_name,record_id) IN(
       SELECT c.run_id,c.kind,c.queue_name,c.record_id FROM liekan_storage_candidate c JOIN liekan_storage_cleanup r ON r.id=c.run_id
       WHERE r.status IN('completed','stopped','failed') OR (r.status='preview' AND r.expires_at<clock_timestamp()) LIMIT 2000 FOR UPDATE OF r SKIP LOCKED)`);
      await tx.$executeRawUnsafe(
        "DELETE FROM liekan_storage_operation WHERE request_id IN(SELECT request_id FROM liekan_storage_operation WHERE created_at<clock_timestamp()-interval '180 days' LIMIT 2000)",
      );
      await tx.$executeRawUnsafe(
        "DELETE FROM liekan_storage_cleanup WHERE id IN(SELECT r.id FROM liekan_storage_cleanup r WHERE r.status IN('completed','stopped','failed','preview') AND r.created_at<clock_timestamp()-interval '180 days' AND NOT EXISTS(SELECT 1 FROM liekan_storage_candidate c WHERE c.run_id=r.id) LIMIT 100)",
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM liekan_report_fragment WHERE (website_id,query_key) IN(
         SELECT website_id,query_key FROM liekan_report_fragment
         WHERE last_read_at<clock_timestamp()-interval '7 days'
         ORDER BY last_read_at LIMIT 200 FOR UPDATE SKIP LOCKED)`,
      );
    });
  } finally {
    pumping = false;
  }
}
