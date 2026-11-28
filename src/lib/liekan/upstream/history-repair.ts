import { warehouseEnabled } from '@/lib/liekan/warehouse/authority-routing';
import { emptyLogImpact } from '../history-repair/log-impact';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hasPermission } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/constants';
import {
  HISTORY_REPAIR_CAMPAIGN,
  HISTORY_REPAIR_ENGINE,
  historyRepairScanSchema,
  historyRepairPreviewSchema,
  historyRepairConfirmSchema,
  historyRepairActionSchema,
  historyRepairNoticeSchema,
  historyRepairQuerySchema,
  type HistoryRepairList,
  type HistoryRepairDetail,
  type HistoryRepairRun,
} from '../contracts/history-repair';
import { withPublishedRegistry } from './crawler-registry-context';
import { lockWritableWebsite, LiekanError, type WriteIdentity } from './server';
import { bumpAnalyticsRevision } from './analytics-revision';
import { invalidateWebsiteAnalytics } from './query-cache';
import {
  canonicalRepairTimezone,
  emptyCounts,
  publicRepairCounts,
  publicRepairPreview,
  hash,
  terminalStatuses,
  workingStatuses,
} from '../history-repair/model';
import {
  dto,
  iso,
  eligibility,
  repairTransaction,
  runForSite,
  requireRun,
  snapshot,
  expected,
  assertSnapshot,
  requireCompatibleRepairWorker,
  archiveGeneration,
  replayAction,
  audit,
  enqueueRepair,
  unreferencedRepairInputSql,
  currentRepairInputSql,
  repairGeneration,
  type RepairTx,
  type RunRow,
} from './history-repair-db';
import { repairDetailPresence, repairListPresence } from './warehouse-history-repair-presence';
import { repairUploadList, warehouseCurrentInputSql } from './warehouse-history-repair-inputs';
import { dayDto } from './history-repair-worker';
export {
  dispatchWarehouseRepairContinuations,
  processHistoryRepairJob,
  reconcileHistoryRepairs,
  historyRepairCapability,
} from './history-repair-worker';
export { ingestHistoryRepairEvidence } from './history-repair-evidence';
export { HISTORY_REPAIR_ENGINE };
function support() {
  if (process.env.CLICKHOUSE_URL)
    throw new LiekanError('历史升级修复当前支持 PostgreSQL', 501, 'history-repair-unsupported');
}
function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const output = schema.safeParse(input);
  if (!output.success)
    throw new LiekanError('历史修复请求格式无效', 400, 'history-repair-invalid-input');
  return output.data;
}
function timezone(value: string) {
  try {
    return canonicalRepairTimezone(value);
  } catch {
    throw new LiekanError(
      '请选择有效的 IANA 时区或 UTC，固定偏移格式不受支持',
      400,
      'history-repair-invalid-timezone',
    );
  }
}
function queryInput(value: URLSearchParams | Record<string, string>) {
  return parsed(
    historyRepairQuerySchema,
    value instanceof URLSearchParams ? Object.fromEntries(value) : value,
  );
}
const cursorEncode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function cursorDecode(
  value: string | undefined,
  scope: string,
): { after: string; id?: string } | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (
      decoded.scope !== scope ||
      typeof decoded.after !== 'string' ||
      (decoded.id && !z.uuid().safeParse(decoded.id).success)
    )
      throw new Error();
    return decoded;
  } catch {
    throw new LiekanError('分页游标无效或候选已变化', 409, 'history-repair-cursor-conflict');
  }
}
export async function listHistoryRepair(
  identity: WriteIdentity,
  parameters: URLSearchParams = new URLSearchParams(),
): Promise<HistoryRepairList & { nextCursor: string | null; hasEligibleData?: boolean }> {
  if (process.env.CLICKHOUSE_URL)
    return {
      campaignId: HISTORY_REPAIR_CAMPAIGN,
      engineVersion: HISTORY_REPAIR_ENGINE,
      supported: false,
      dismissed: false,
      unreadCompletion: false,
      websites: [],
      nextCursor: null,
    };
  const result: HistoryRepairList & {nextCursor:string|null} = await repairTransaction(async tx => {
    const [user] = await tx.$queryRawUnsafe<{ role: string }[]>(
      'SELECT role FROM "user" WHERE user_id=$1::uuid AND deleted_at IS NULL FOR SHARE',
      identity.userId,
    );
    if (!user) throw new LiekanError('账户无效', 401);
    const admin = await hasPermission(user.role, PERMISSIONS.all);
    const cursor = cursorDecode(parameters.get('cursor') || undefined, `list:${identity.userId}`);
    if (cursor && !z.uuid().safeParse(cursor.after).success)
      throw new LiekanError('分页游标无效或候选已变化', 409, 'history-repair-cursor-conflict');
    const sites = await tx.$queryRawUnsafe<{ id: string; name: string; domain: string }[]>(
      `SELECT w.website_id::text AS id,w.name,coalesce(w.domain,'') AS domain FROM website w WHERE w.deleted_at IS NULL AND ($2 OR w.user_id=$1::uuid OR EXISTS(SELECT 1 FROM team_user tu JOIN team t ON t.team_id=tu.team_id WHERE tu.user_id=$1::uuid AND tu.team_id=w.team_id AND t.deleted_at IS NULL AND tu.role IN('team-owner','team-manager','team-member'))) AND ($3::uuid IS NULL OR w.website_id>$3::uuid) ORDER BY w.website_id LIMIT 51`,
      identity.userId,
      admin,
      cursor?.after || null,
    );
    const websites: HistoryRepairList['websites'] = [];
    // Recheck the canonical permission implementation before returning any website metadata.
    for (const site of sites.slice(0, 50)) {
      try {
        await lockWritableWebsite(tx, site.id, identity, 'share');
      } catch (error) {
        if (error instanceof LiekanError && error.status === 403) continue;
        throw error;
      }
      const state = await eligibility(tx, site.id);
      const row = await runForSite(tx, site.id, false);
      websites.push({
        ...site,
        ...state,
        status: row?.status || 'unscanned',
        run: row ? dto(row) : null,
      });
    }
    const [noticeState] = await tx.$queryRawUnsafe<{ eligible_data: boolean; unread: boolean }[]>(
      `SELECT EXISTS(SELECT 1 FROM website w JOIN liekan_history_repair_campaign c ON c.id=$3 LEFT JOIN liekan_setting s USING(website_id) WHERE w.deleted_at IS NULL AND w.website_id=ANY(c.eligible_websites) AND NOT coalesce(s.is_demo,false) AND ($2 OR w.user_id=$1::uuid OR EXISTS(SELECT 1 FROM team_user tu JOIN team t ON t.team_id=tu.team_id WHERE tu.user_id=$1::uuid AND tu.team_id=w.team_id AND t.deleted_at IS NULL AND tu.role IN('team-owner','team-manager','team-member'))) AND ${warehouseEnabled() ? 'false' : '(EXISTS(SELECT 1 FROM website_event e WHERE e.website_id=w.website_id) OR EXISTS(SELECT 1 FROM liekan_log l WHERE l.website_id=w.website_id))'}) AS eligible_data,
  EXISTS(SELECT 1 FROM liekan_history_repair_run r JOIN website w ON w.website_id=r.website_id LEFT JOIN liekan_history_repair_notice n ON n.user_id=$1::uuid AND n.campaign_id=r.campaign_id WHERE r.campaign_id=$3 AND w.deleted_at IS NULL AND r.status IN('completed','completed_limited') AND r.active_generation IS NOT NULL AND r.completed_at IS NOT NULL AND (n.read_at IS NULL OR r.completed_at>n.read_at) AND ($2 OR w.user_id=$1::uuid OR EXISTS(SELECT 1 FROM team_user tu JOIN team t ON t.team_id=tu.team_id WHERE tu.user_id=$1::uuid AND tu.team_id=w.team_id AND t.deleted_at IS NULL AND tu.role IN('team-owner','team-manager','team-member')))) AS unread`,
      identity.userId,
      admin,
      HISTORY_REPAIR_CAMPAIGN,
    );
    const [notice] = await tx.$queryRawUnsafe<
      { dismissed_at: Date | null; read_at: Date | null }[]
    >(
      'SELECT dismissed_at,read_at FROM liekan_history_repair_notice WHERE user_id=$1::uuid AND campaign_id=$2',
      identity.userId,
      HISTORY_REPAIR_CAMPAIGN,
    );
    const unread = noticeState.unread;
    return {
      campaignId: HISTORY_REPAIR_CAMPAIGN,
      engineVersion: HISTORY_REPAIR_ENGINE,
      supported: true,
      dismissed: !!notice?.dismissed_at,
      unreadCompletion: unread,
      hasEligibleData: noticeState.eligible_data,
      websites,
      nextCursor:
        sites.length > 50
          ? cursorEncode({ scope: `list:${identity.userId}`, after: sites[49].id })
          : null,
    };
  });
  return warehouseEnabled()
    ? repairListPresence(identity, result)
    : result;
}
export async function getHistoryRepair(
  websiteId: string,
  parameters: URLSearchParams | Record<string, string>,
  identity: WriteIdentity,
): Promise<HistoryRepairDetail> {
  support();
  const query = queryInput(parameters);
  if (query.page > 1 && !query.cursor && ['days', 'actions'].includes(query.view))
    throw new LiekanError('翻页需要上一页返回的游标', 400, 'history-repair-cursor-required');
  const result = await repairTransaction(async tx => {
    await lockWritableWebsite(tx, websiteId, identity, 'share');
    const state = await eligibility(tx, websiteId),
      row = await runForSite(tx, websiteId, false);
    const response: HistoryRepairDetail = {
      campaignId: HISTORY_REPAIR_CAMPAIGN,
      ...state,
      run: row ? dto(row) : null,
    };
    if (!row) return response;
    response.uploads =
      warehouseEnabled()
        ? await repairUploadList(tx, row)
        : await tx.$queryRawUnsafe(
            `WITH uploads AS (
      SELECT upload_id,min(source) AS source,bool_and(state='finalized') AS finalized,bool_and(state='discarded') AS discarded,sum(rows)::text AS rows,sum(accepted)::text AS accepted,sum(rows-accepted)::text AS rejected,count(*)::int AS chunks,sum(jsonb_array_length(errors))>100 AS "moreErrors",min(created_at) AS created
      FROM liekan_history_repair_input i WHERE run_id=$1::uuid AND rulepack_hash=$2 AND ${currentRepairInputSql} GROUP BY upload_id
      ORDER BY bool_and(state='discarded'),min(created_at) DESC,upload_id LIMIT 100)
      SELECT u.upload_id::text AS id,u.source,u.finalized,u.discarded,u.rows,u.accepted,u.rejected,u.chunks,u."moreErrors",
      coalesce((SELECT jsonb_agg(jsonb_build_object('sequence',err.sequence,'row',err.row,'code',err.code)) FROM (
       SELECT i.sequence,(e.value->>'row')::integer AS row,e.value->>'code' AS code
       FROM liekan_history_repair_input i CROSS JOIN LATERAL jsonb_array_elements(i.errors) e(value)
       WHERE i.run_id=$1::uuid AND i.upload_id=u.upload_id ORDER BY i.sequence,(e.value->>'row')::integer LIMIT 100) err),'[]'::jsonb) AS errors
      FROM uploads u ORDER BY u.discarded,u.created DESC,u.upload_id`,
            row.id,
            row.snapshot.rulepack.hash,
          );
    const generation = query.generation || row.generation;
    // Only actual candidate/current/previous snapshots can be selected through public reads.
    if (
      ![row.generation, row.active_generation, row.previous_generation].includes(generation) &&
      !row.generation_archive[generation]
    )
      throw new LiekanError('候选代次不存在', 404, 'history-repair-generation-not-found');
    const selected = repairGeneration(row, generation, !!query.generation);
    if (selected)
      response.selectedGeneration = {
        id: generation,
        preview: publicRepairPreview(selected.preview),
        timezone: selected.snapshot.timezone,
        rulepackHash: selected.snapshot.rulepack.hash,
        catalogVersion: selected.snapshot.rulepack.catalogVersion,
      };
    if (query.view === 'days') {
      const scope = `days:${row.id}:${generation}`;
      const cursor = cursorDecode(query.cursor, scope);
      if (cursor && !/^\d{4}-\d\d-\d\d$/.test(cursor.after))
        throw new LiekanError('日期游标无效', 400);
      const items = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT day::text,before_pv::text,after_pv::text,before_uv::text,after_uv::text,before_identity_missing_pv::text,after_identity_missing_pv::text,event_rows::text,log_rows::text,changed_events::text,changed_logs::text,coverage FROM liekan_history_repair_day WHERE run_id=$1::uuid AND generation=$2::uuid AND ($3::date IS NULL OR day>$3::date) ORDER BY day LIMIT $4`,
        row.id,
        generation,
        cursor?.after || null,
        query.pageSize + 1,
      );
      const [total] = await tx.$queryRawUnsafe<{ count: string }[]>(
        'SELECT count(*)::text AS count FROM liekan_history_repair_day WHERE run_id=$1::uuid AND generation=$2::uuid',
        row.id,
        generation,
      );
      response.days = {
        items: items
          .slice(0, query.pageSize)
          .map(value => dayDto(value, selected?.preview?.metricScope)),
        page: query.page,
        pageSize: query.pageSize,
        total: total.count,
        nextCursor:
          items.length > query.pageSize
            ? cursorEncode({ scope, after: items[query.pageSize - 1].day })
            : null,
      };
    }
    if (query.view === 'actions') {
      const scope = `actions:${row.id}`;
      const cursor = cursorDecode(query.cursor, scope);
      if (cursor && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.after))
        throw new LiekanError('动作游标无效', 400);
      const items = await tx.$queryRawUnsafe<
        {
          id: string;
          action: string;
          actor_id: string | null;
          generation: string | null;
          created_at: Date;
          time: string;
          details: Record<string, unknown>;
        }[]
      >(
        `SELECT id::text,action,actor_id::text,generation::text,created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time,details FROM liekan_history_repair_action WHERE run_id=$1::uuid AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,
        row.id,
        cursor?.after || null,
        cursor?.id || null,
        query.pageSize + 1,
      );
      const [total] = await tx.$queryRawUnsafe<{ count: string }[]>(
        'SELECT count(*)::text AS count FROM liekan_history_repair_action WHERE run_id=$1::uuid',
        row.id,
      );
      response.actions = {
        items: items.slice(0, query.pageSize).map(item => ({
          id: item.id,
          action: item.action,
          actorId: item.actor_id,
          generation: item.generation,
          createdAt: iso(item.created_at),
          details: item.details,
        })),
        page: query.page,
        pageSize: query.pageSize,
        total: total.count,
        nextCursor:
          items.length > query.pageSize
            ? cursorEncode({
                scope,
                after: items[query.pageSize - 1].time,
                id: items[query.pageSize - 1].id,
              })
            : null,
      };
    }
    return response;
  });
  return warehouseEnabled()
    ? repairDetailPresence(websiteId, identity, result)
    : result;
}
async function freshCandidate(tx: RepairTx, row: RunRow, refresh: boolean, actorId: string) {
  await archiveGeneration(tx, row);
  const fixed = refresh ? await snapshot(tx, row.website_id, row.snapshot.timezone) : row.snapshot;
  if (row.snapshot.inputNotBefore) fixed.inputNotBefore = row.snapshot.inputNotBefore;
  // Any retained UA summaries from a different rulepack require source-file re-upload.
  if (fixed.rulepack.hash !== row.snapshot.rulepack.hash) {
    const [boundary] = await tx.$queryRawUnsafe<{ time: string }[]>(
      'SELECT clock_timestamp()::text AS time',
    );
    fixed.inputNotBefore = boundary.time;
    if (process.env.LIEKAN_ANALYTICS_BACKEND !== 'clickhouse')
      await tx.$executeRawUnsafe(
        `UPDATE liekan_history_repair_input i SET state='discarded',records='[]' WHERE i.ctid IN(SELECT i.ctid FROM liekan_history_repair_input i JOIN liekan_history_repair_run r ON r.id=i.run_id WHERE r.id=$1::uuid AND i.state<>'discarded' AND i.rulepack_hash<>$2 AND ${unreferencedRepairInputSql} LIMIT 100)`,
        row.id,
        fixed.rulepack.hash,
      );
  }
  await tx.$executeRawUnsafe(
    `UPDATE liekan_history_repair_run SET generation=$2::uuid,revision=revision+1,status='scanning',phase='boundary',scope_finalized=false,scope_changed=false,cursor='{}',counts=$3::jsonb,log_impact='{}',preview=NULL,approved_digest=NULL,confirmed_at=NULL,partial_confirmed=false,snapshot=$4::jsonb,actor_id=$5::uuid,lease_token=NULL,lease_until=NULL,attempts=0,error_code=NULL,completed_at=NULL,updated_at=clock_timestamp() WHERE id=$1::uuid`,
    row.id,
    randomUUID(),
    JSON.stringify(emptyCounts()),
    JSON.stringify(fixed),
    actorId,
  );
  return runForSite(tx, row.website_id);
}
export async function scanHistoryRepair(
  websiteId: string,
  input: unknown,
  identity: WriteIdentity,
): Promise<HistoryRepairRun> {
  support();
  const submitted = parsed(historyRepairScanSchema, input);
  const body = { ...submitted, timezone: timezone(submitted.timezone) };
  return withPublishedRegistry(() =>
    repairTransaction(async tx => {
      await lockWritableWebsite(tx, websiteId, identity);
      const replay = await replayAction<HistoryRepairRun>(
        tx,
        websiteId,
        identity,
        body.actionId,
        body,
      );
      if (replay)
        return {
          ...replay,
          counts: publicRepairCounts(replay.counts),
          preview: publicRepairPreview(replay.preview),
        };
      const state = await eligibility(tx, websiteId);
      if (!state.eligible)
        throw new LiekanError('该网站不在本次升级登记范围', 409, 'history-repair-ineligible');
      let row = await runForSite(tx, websiteId);
      if (row?.active_generation)
        throw new LiekanError(
          '已有修复代次生效，请先回退后修订',
          409,
          'history-repair-rollback-required',
        );
      await requireCompatibleRepairWorker(tx);
      if (row && workingStatuses.includes(row.status))
        return audit(tx, row, identity, 'scan', body, dto(row), body.actionId);
      if (row) {
        row.snapshot.timezone = body.timezone;
        row = await freshCandidate(tx, row, true, identity.userId);
      } else {
        const id = randomUUID(),
          generation = randomUUID(),
          scope = randomUUID(),
          fixed = await snapshot(tx, websiteId, body.timezone);
        await tx.$executeRawUnsafe(
          `INSERT INTO liekan_history_repair_run(id,website_id,campaign_id,actor_id,status,generation,repair_scope_id,snapshot,counts,locale) VALUES($1::uuid,$2::uuid,$3,$4::uuid,'scanning',$5::uuid,$6::uuid,$7::jsonb,$8::jsonb,$9)`,
          id,
          websiteId,
          HISTORY_REPAIR_CAMPAIGN,
          identity.userId,
          generation,
          scope,
          JSON.stringify(fixed),
          JSON.stringify(emptyCounts()),
          body.locale,
        );
        row = await runForSite(tx, websiteId);
      }
      await tx.$executeRawUnsafe(
        'UPDATE liekan_history_repair_run SET actor_id=$2::uuid,locale=$3 WHERE id=$1::uuid',
        row.id,
        identity.userId,
        body.locale,
      );
      await enqueueRepair(tx, row);
      return audit(tx, row, identity, 'scan', body, dto(row), body.actionId);
    }),
  );
}
export async function previewHistoryRepair(
  websiteId: string,
  input: unknown,
  identity: WriteIdentity,
): Promise<HistoryRepairRun> {
  support();
  const body = parsed(historyRepairPreviewSchema, input);
  return withPublishedRegistry(() =>
    repairTransaction(async tx => {
      let row = await requireRun(tx, websiteId, identity);
      const replay = await replayAction<HistoryRepairRun>(
        tx,
        websiteId,
        identity,
        body.actionId,
        body,
      );
      if (replay)
        return {
          ...replay,
          counts: publicRepairCounts(replay.counts),
          preview: publicRepairPreview(replay.preview),
        };
      expected(row, body.expectedRevision, body.runId);
      if (row.active_generation)
        throw new LiekanError(
          '已有修复代次生效，请先回退后修订',
          409,
          'history-repair-rollback-required',
        );
      await requireCompatibleRepairWorker(tx);
      if (row.confirmed_at && workingStatuses.includes(row.status))
        throw new LiekanError('已确认任务正在执行', 409, 'history-repair-not-editable');
      if (workingStatuses.includes(row.status))
        return audit(tx, row, identity, 'preview', body, dto(row), body.actionId);
      const nextRulepackHash =
        row.status === 'ready'
          ? row.snapshot.rulepack.hash
          : (await snapshot(tx, row.website_id, row.snapshot.timezone)).rulepack.hash;
      const incomplete = await tx.$queryRawUnsafe(
        warehouseEnabled()
          ? `SELECT 1 FROM liekan_warehouse_repair_upload i WHERE run_id=$1::uuid AND rulepack_hash=$2 AND state='open' AND ${warehouseCurrentInputSql} LIMIT 1`
          : `SELECT 1 FROM liekan_history_repair_input i WHERE run_id=$1::uuid AND state='open' AND rulepack_hash=$2 AND ${currentRepairInputSql} LIMIT 1`,
        row.id,
        nextRulepackHash,
      );
      if (incomplete.length)
        throw new LiekanError(
          '请完成或撤下未完成的证据文件',
          409,
          'history-repair-evidence-incomplete',
        );
      if (row.status === 'ready') {
        await assertSnapshot(tx, row, true);
        return audit(tx, row, identity, 'preview', body, dto(row), body.actionId);
      }
      row = await freshCandidate(tx, row, true, identity.userId);
      await enqueueRepair(tx, row);
      return audit(tx, row, identity, 'preview', body, dto(row), body.actionId);
    }),
  );
}
export async function confirmHistoryRepair(
  websiteId: string,
  input: unknown,
  identity: WriteIdentity,
): Promise<HistoryRepairRun> {
  support();
  const body = parsed(historyRepairConfirmSchema, input);
  return withPublishedRegistry(() =>
    repairTransaction(async tx => {
      const row = await requireRun(tx, websiteId, identity);
      const replay = await replayAction<HistoryRepairRun>(
        tx,
        websiteId,
        identity,
        body.actionId,
        body,
      );
      if (replay)
        return {
          ...replay,
          counts: publicRepairCounts(replay.counts),
          preview: publicRepairPreview(replay.preview),
        };
      expected(row, body.expectedRevision, body.runId);
      await requireCompatibleRepairWorker(tx);
      await assertSnapshot(tx, row, true);
      if (
        row.status !== 'ready' ||
        !row.preview?.complete ||
        row.generation !== body.generation ||
        row.preview.digest !== body.previewDigest
      )
        throw new LiekanError('请重新生成完整预览', 409, 'history-repair-preview-changed');
      if (row.preview.partial && !body.partialConfirmed)
        throw new LiekanError(
          '请明确确认本次修复的证据限制',
          409,
          'history-repair-partial-confirmation-required',
        );
      const inputs = await tx.$queryRawUnsafe(
        warehouseEnabled()
          ? `SELECT 1 FROM liekan_warehouse_repair_upload i WHERE run_id=$1::uuid AND rulepack_hash=$2 AND ${warehouseCurrentInputSql} AND (state='open' OR (state='finalized' AND accepted<rows)) LIMIT 1`
          : `SELECT 1 FROM liekan_history_repair_input i WHERE run_id=$1::uuid AND rulepack_hash=$2 AND ${currentRepairInputSql} AND (state='open' OR (state='finalized' AND jsonb_array_length(errors)>0)) LIMIT 1`,
        row.id,
        row.snapshot.rulepack.hash,
      );
      if (inputs.length)
        throw new LiekanError(
          '证据文件尚未通过完整校验',
          409,
          'history-repair-evidence-incomplete',
        );
      const changed = await tx.$executeRawUnsafe(
        `UPDATE liekan_history_repair_run SET status='queued',phase='activation',approved_digest=$3,confirmed_at=clock_timestamp(),partial_confirmed=$4,actor_id=$5::uuid,updated_at=clock_timestamp() WHERE id=$1::uuid AND revision=$2 AND status='ready'`,
        row.id,
        row.revision,
        body.previewDigest,
        body.partialConfirmed,
        identity.userId,
      );
      if (changed !== 1)
        throw new LiekanError('任务状态已变化', 409, 'history-repair-task-changed');
      row.status = 'queued';
      row.phase = 'activation';
      row.approved_digest = body.previewDigest;
      row.confirmed_at = new Date();
      await enqueueRepair(tx, row);
      return audit(tx, row, identity, 'confirm', body, dto(row), body.actionId, {
        partialConfirmed: body.partialConfirmed,
        digest: body.previewDigest,
      });
    }),
  );
}
export async function actHistoryRepair(
  websiteId: string,
  input: unknown,
  identity: WriteIdentity,
): Promise<HistoryRepairRun> {
  support();
  const body = parsed(historyRepairActionSchema, input);
  let invalidate = false;
  const result = await withPublishedRegistry(() =>
    repairTransaction(async tx => {
      let row = await requireRun(tx, websiteId, identity);
      const replay = await replayAction<HistoryRepairRun>(
        tx,
        websiteId,
        identity,
        body.actionId,
        body,
      );
      if (replay)
        return {
          ...replay,
          counts: publicRepairCounts(replay.counts),
          preview: publicRepairPreview(replay.preview),
        };
      expected(row, body.expectedRevision, body.runId);
      if (body.action === 'pause') {
        if (!workingStatuses.includes(row.status))
          throw new LiekanError('该任务当前无法暂停', 409, 'history-repair-invalid-transition');
        await tx.$executeRawUnsafe(
          `UPDATE liekan_history_repair_run SET status='paused',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          row.id,
        );
        row.status = 'paused';
      } else if (body.action === 'cancel') {
        if (
          row.active_generation === row.generation ||
          ['completed', 'completed_limited'].includes(row.status)
        )
          throw new LiekanError('任务已生效，请使用回退', 409, 'history-repair-rollback-required');
        if (
          ![
            'scanning',
            'preparing',
            'ready',
            'queued',
            'running',
            'validating',
            'paused',
            'failed',
          ].includes(row.status)
        )
          throw new LiekanError('该任务当前无法取消', 409, 'history-repair-invalid-transition');
        await tx.$executeRawUnsafe(
          `UPDATE liekan_history_repair_run SET status='cancelled',lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1::uuid`,
          row.id,
        );
        row.status = 'cancelled';
        row.completed_at = new Date();
      } else if (body.action === 'rollback') {
        if (!row.active_generation)
          throw new LiekanError('没有可回退的生效修复', 409, 'history-repair-no-active-generation');
        await tx.$executeRawUnsafe(
          `UPDATE liekan_history_repair_run SET active_generation=previous_generation,previous_generation=active_generation,active_revision=active_revision+1,status='rolled_back',phase='complete',lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1::uuid`,
          row.id,
        );
        const old = row.active_generation;
        row.active_generation = row.previous_generation;
        row.previous_generation = old;
        row.status = 'rolled_back';
        row.phase = 'complete';
        row.completed_at = new Date();
        await bumpAnalyticsRevision(tx, 'website', websiteId);
        invalidate = true;
      } else if (body.action === 'reactivate') {
        if (row.status !== 'rolled_back' || !row.previous_generation)
          throw new LiekanError(
            '没有可再次生效的已确认代次',
            409,
            'history-repair-invalid-transition',
          );
        await assertSnapshot(tx, row, false);
        if (!row.preview?.complete || row.preview.generation !== row.previous_generation)
          throw new LiekanError('请重新预览后确认', 409, 'history-repair-preview-changed');
        await tx.$executeRawUnsafe(
          `UPDATE liekan_history_repair_run SET generation=previous_generation,status='queued',approved_digest=$2,confirmed_at=clock_timestamp(),actor_id=$3::uuid,updated_at=clock_timestamp() WHERE id=$1::uuid`,
          row.id,
          row.preview.digest,
          identity.userId,
        );
        row.generation = row.previous_generation;
        row.status = 'queued';
        row.approved_digest = row.preview.digest;
        await enqueueRepair(tx, row);
      } else {
        if (row.error_code === 'evidence-changed')
          throw new LiekanError(
            '证据已变更，请重新生成完整预览',
            409,
            'history-repair-preview-required',
          );
        await requireCompatibleRepairWorker(tx);
        if (!['paused', 'failed'].includes(row.status))
          throw new LiekanError('该任务当前无法继续', 409, 'history-repair-invalid-transition');
        await assertSnapshot(tx, row, !row.confirmed_at);
        row.status = row.confirmed_at ? 'queued' : row.scope_finalized ? 'preparing' : 'scanning';
        await tx.$executeRawUnsafe(
          `UPDATE liekan_history_repair_run SET status=$2,actor_id=$3::uuid,attempts=0,error_code=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1::uuid`,
          row.id,
          row.status,
          identity.userId,
        );
        await enqueueRepair(tx, row);
      }
      row = await runForSite(tx, websiteId);
      return audit(tx, row, identity, body.action, body, dto(row), body.actionId);
    }),
  );
  if (invalidate) invalidateWebsiteAnalytics(websiteId);
  return result;
}
export async function dismissHistoryRepairNotice(input: unknown, identity: WriteIdentity) {
  support();
  const body = parsed(historyRepairNoticeSchema, input);
  return repairTransaction(async tx => {
    const [user] = await tx.$queryRawUnsafe(
      'SELECT 1 FROM "user" WHERE user_id=$1::uuid AND deleted_at IS NULL FOR SHARE',
      identity.userId,
    );
    if (!user) throw new LiekanError('账户无效', 401);
    await tx.$executeRawUnsafe(
      `INSERT INTO liekan_history_repair_notice(user_id,campaign_id,dismissed_at,read_at) VALUES($1::uuid,$2,CASE WHEN $3='dismiss' THEN clock_timestamp() END,CASE WHEN $3='read' THEN clock_timestamp() END) ON CONFLICT(user_id,campaign_id) DO UPDATE SET dismissed_at=CASE WHEN $3='dismiss' THEN clock_timestamp() ELSE liekan_history_repair_notice.dismissed_at END,read_at=CASE WHEN $3='read' THEN clock_timestamp() ELSE liekan_history_repair_notice.read_at END`,
      identity.userId,
      HISTORY_REPAIR_CAMPAIGN,
      body.action,
    );
    const [notice] = await tx.$queryRawUnsafe<{ dismissed: boolean; read: boolean }[]>(
      'SELECT dismissed_at IS NOT NULL AS dismissed,read_at IS NOT NULL AS read FROM liekan_history_repair_notice WHERE user_id=$1::uuid AND campaign_id=$2',
      identity.userId,
      HISTORY_REPAIR_CAMPAIGN,
    );
    return { campaignId: HISTORY_REPAIR_CAMPAIGN, ...notice };
  });
}
const csvCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
export async function exportHistoryRepair(
  websiteId: string,
  parameters: URLSearchParams | Record<string, string>,
  identity: WriteIdentity,
): Promise<{ csv: string; filename: string }> {
  support();
  const values =
    parameters instanceof URLSearchParams ? Object.fromEntries(parameters) : { ...parameters };
  const locale = values.locale || 'zh-CN';
  delete values.locale;
  if (!['zh-CN', 'en-US'].includes(locale)) throw new LiekanError('语言无效');
  const query = queryInput(values);
  return repairTransaction(async tx => {
    const row = await requireRun(tx, websiteId, identity);
    const generation = query.generation || row.generation;
    const saved = repairGeneration(row, generation, !!query.generation);
    if (!saved?.preview?.complete || saved.preview.generation !== generation)
      throw new LiekanError('只可导出完整的固定预览', 409, 'history-repair-preview-required');
    const data = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT day::text,before_pv::text,after_pv::text,before_uv::text,after_uv::text,before_identity_missing_pv::text,after_identity_missing_pv::text,event_rows::text,log_rows::text,changed_events::text,changed_logs::text,coverage FROM liekan_history_repair_day WHERE run_id=$1::uuid AND generation=$2::uuid ORDER BY day`,
      row.id,
      generation,
    );
    const labels =
      locale === 'en-US'
        ? [
            'Date',
            'Before PV',
            'After PV',
            'Before UV',
            'After UV',
            'Event rows',
            'Log rows',
            'Changed events',
            'Changed logs',
            'Coverage',
            'Before qualified UV',
            'After qualified UV',
            'Before missing identity PV',
            'After missing identity PV',
          ]
        : [
            '日期',
            '原纳入PV',
            '预计纳入PV',
            '原UV',
            '预计UV',
            '事件记录',
            '日志记录',
            '事件变化',
            '日志变化',
            '证据覆盖',
            '原已确认身份UV',
            '预计已确认身份UV',
            '原缺失身份PV',
            '预计缺失身份PV',
          ];
    const total = publicRepairCounts(saved.preview.counts, saved.preview.metricScope);
    const notes =
      locale === 'en-US'
        ? ['Campaign', 'Generation', 'Scope', 'Timezone', 'Limitations', 'Raw UA and IP excluded']
        : ['升级活动', '固定代次', '冻结范围', '时区', '证据限制', '不含原始UA和IP'];
    const translatedCoverage: Record<string, string> =
      locale === 'en-US'
        ? { complete: 'Complete', partial: 'Partial', missing: 'Missing input' }
        : { complete: '完整', partial: '部分覆盖', missing: '缺少输入' };
    const translatedLimitations: Record<string, string> =
      locale === 'en-US'
        ? {
            'identity-input-incomplete':
              'Missing identity evidence makes visitor totals unavailable; qualified visitor counts remain partial.',
            'browser-input-incomplete':
              'Some browser records have no evidence sufficient for reclassification.',
            'log-input-incomplete': 'Some retained logs have missing or truncated user agents.',
            'missing-quality-scan-time-only':
              'Missing original quality records are counted at scan time; their reception boundary cannot be reconstructed.',
            'evidence-conflicts-retained':
              'Conflicting identity evidence remains ambiguous and original proof is retained.',
            'excluded-old-batches':
              'Failed or cancelled historical intake batches are excluded from the frozen population.',
            'bot-check-disabled': 'Bot detection was explicitly disabled for the approved rules.',
            'undated-events':
              'Records with no event timestamp are audited separately and have no inferred calendar day.',
          }
        : {
            'identity-input-incomplete':
              '身份信息缺失，访客总数不可用；已确认身份的访客数为部分覆盖。',
            'browser-input-incomplete': '部分浏览记录缺少足以重新分类的原始证据。',
            'log-input-incomplete': '部分历史日志缺少完整的用户代理信息。',
            'missing-quality-scan-time-only':
              '缺少原始质量行的记录仅按扫描时数量审计，无法还原精确接收边界。',
            'evidence-conflicts-retained': '冲突身份继续保持歧义，原始核验证据已保留。',
            'excluded-old-batches': '冻结范围排除了失败或已取消的历史接收批次。',
            'bot-check-disabled': '批准的规则包中已明确关闭机器人检测。',
            'undated-events': '缺少事件时间的记录单列审计，不推测自然日归属。',
          };
    const lines = [
      labels.map(csvCell).join(','),
      ...data.map(value =>
        [
          value.day,
          value.before_pv,
          value.after_pv,
          dayDto(value, saved.preview.metricScope).beforeUV,
          dayDto(value, saved.preview.metricScope).afterUV,
          value.event_rows,
          value.log_rows,
          value.changed_events,
          value.changed_logs,
          translatedCoverage[String(value.coverage)],
          dayDto(value, saved.preview.metricScope).beforeQualifiedUV,
          dayDto(value, saved.preview.metricScope).afterQualifiedUV,
          dayDto(value, saved.preview.metricScope).beforeIdentityMissingPV,
          dayDto(value, saved.preview.metricScope).afterIdentityMissingPV,
        ]
          .map(csvCell)
          .join(','),
      ),
      [
        locale === 'en-US' ? 'All frozen history' : '全部冻结历史',
        total.beforePV,
        total.afterPV,
        total.beforeUV,
        total.afterUV,
        total.events,
        total.logs,
        total.changedEvents,
        total.changedLogs,
        translatedCoverage[saved.preview.partial ? 'partial' : 'complete'],
        total.beforeQualifiedUV,
        total.afterQualifiedUV,
        total.beforeIdentityMissingPV,
        total.afterIdentityMissingPV,
      ]
        .map(csvCell)
        .join(','),
      ...[
        [notes[0], HISTORY_REPAIR_CAMPAIGN],
        [notes[1], generation],
        [notes[2], row.repair_scope_id],
        [notes[3], saved.snapshot.timezone],
        [
          notes[4],
          saved.preview.limitations
            .map(
              code =>
                translatedLimitations[code] ||
                (locale === 'en-US' ? 'Unspecified evidence limitation.' : '存在其他证据限制。'),
            )
            .join(' '),
        ],
        [notes[5], ''],
      ].map(values => values.map(csvCell).join(',')),
    ];
    const impact = saved.preview.logImpact || emptyLogImpact();
    const categoryLabels: Record<string, string> =
      locale === 'en-US'
        ? {
            all: 'All requests',
            training: 'AI training',
            search: 'AI search',
            user: 'User initiated',
            traditional_search: 'Traditional search',
            workbench: 'AI workbench',
            personal_agent: 'Personal agent',
            other: 'Other recognized crawlers',
            unknown: 'Unknown or ambiguous',
          }
        : {
            all: '全部请求',
            training: 'AI训练',
            search: 'AI搜索',
            user: '用户触发',
            traditional_search: '传统搜索',
            workbench: 'AI工作台',
            personal_agent: '个人Agent',
            other: '其他已识别爬虫',
            unknown: '未知或歧义',
          };
    lines.push(
      [
        locale === 'en-US' ? 'Log classification' : '日志分类',
        locale === 'en-US' ? 'Before requests' : '原请求数',
        locale === 'en-US' ? 'After requests' : '修复后请求数',
      ]
        .map(csvCell)
        .join(','),
      ...impact.categories.map(value =>
        [categoryLabels[value.category], value.beforeRequests, value.afterRequests]
          .map(csvCell)
          .join(','),
      ),
      [
        locale === 'en-US' ? 'Distinct recognized identities' : '已识别身份数',
        impact.beforeIdentities,
        impact.afterIdentities,
      ]
        .map(csvCell)
        .join(','),
      [
        locale === 'en-US' ? 'Distinct AI pages' : 'AI页面覆盖数',
        impact.beforeAiPages,
        impact.afterAiPages,
      ]
        .map(csvCell)
        .join(','),
    );
    await audit(tx, row, identity, 'export', { generation, locale }, { generation, locale });
    return {
      csv: '\uFEFF' + lines.join('\r\n'),
      filename: `GEOInflow-history-repair-${generation}.csv`,
    };
  });
}
export { clearHistoryRepair, invalidateHistoryRepair } from './history-repair-lifecycle';
