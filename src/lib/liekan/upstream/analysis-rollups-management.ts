import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lockWritableWebsite, LiekanError, type WriteIdentity } from './server';
import { bumpAnalyticsRevision } from './analytics-revision';
import { analysisCapacity, analysisTransaction, analysisVersions } from './analysis-rollups-db';
import { hasAnalysisBuildCapacity } from './storage-capacity';
import {
  analysisBuildDto,
  analysisHash,
  analysisSafeNumber,
  hourFloor,
  hourCeil,
  type AnalysisBuildInput,
  type AnalysisBuildRow,
  type AnalysisStatusDto,
  type AnalysisTx,
} from './analysis-rollups-model';

function support() {
  if (process.env.CLICKHOUSE_URL)
    throw new LiekanError('统计加速当前支持 PostgreSQL', 501, 'analysis-unsupported');
}
function uuid(value: string) {
  if (!z.uuid().safeParse(value).success)
    throw new LiekanError('请求标识无效', 400, 'analysis-invalid-input');
}
async function siteRow(tx: AnalysisTx, websiteId: string, lock = true) {
  await tx.$executeRawUnsafe('SELECT liekan_analysis_register($1::uuid)', websiteId);
  const [site] = await tx.$queryRawUnsafe<
    {
      epoch: bigint;
      revision: bigint;
      mode: 'live' | 'disabled';
      path_expansion: boolean;
      visit_expansion: boolean;
      capture_from: Date;
    }[]
  >(
    `SELECT * FROM liekan_analysis_site WHERE website_id=$1::uuid ${lock ? 'FOR UPDATE' : ''}`,
    websiteId,
  );
  if (!site) throw new LiekanError('站点加速状态缺失，请检查迁移', 409, 'analysis-site-missing');
  return site;
}
function expectRevision(actual: bigint | number, expected?: number) {
  if (expected !== undefined && String(actual) !== String(expected))
    throw new LiekanError('统计加速状态已变化，请刷新', 409, 'analysis-revision-conflict');
}

function canaryCheckpoint(start: Date, end: Date, timezone: string) {
  const eligibleEnd = new Date(Math.min(+end, Date.now()));
  const day = formatInTimeZone(eligibleEnd, timezone, 'yyyy-MM-dd');
  const until = fromZonedTime(`${day}T00:00:00`, timezone);
  const previousDay = new Date(Date.parse(`${day}T12:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
  const from = fromZonedTime(`${previousDay}T00:00:00`, timezone);
  const alignedFrom = hourFloor(from),
    alignedUntil = hourCeil(until);
  if (+alignedFrom >= +start && +alignedUntil <= +end && +alignedUntil <= Date.now())
    return {
      hour: alignedFrom.toISOString(),
      family: 'log',
      stage: 'canary',
      canaryFrom: alignedFrom.toISOString(),
      canaryUntil: alignedUntil.toISOString(),
    };
  return { hour: start.toISOString(), family: 'log', stage: 'history' };
}

export async function createAnalysisBuild(
  websiteId: string,
  identity: WriteIdentity,
  input: AnalysisBuildInput,
) {
  support();
  uuid(input.requestId);
  const requestedStart = new Date(input.startDate),
    requestedEnd = new Date(input.endDate);
  if (
    !Number.isFinite(+requestedStart) ||
    !Number.isFinite(+requestedEnd) ||
    +requestedEnd <= +requestedStart
  )
    throw new LiekanError('请选择有效的统计范围', 400, 'analysis-invalid-range');
  const start = hourFloor(requestedStart),
    end = hourCeil(requestedEnd);
  if (
    !Number.isFinite(+start) ||
    !Number.isFinite(+end) ||
    +end <= +start ||
    +end - +start > 5 * 366 * 86400000
  )
    throw new LiekanError('请选择有效的统计范围，单次最多五年', 400, 'analysis-invalid-range');
  if (!['zh-CN', 'en-US'].includes(input.locale))
    throw new LiekanError('界面语言无效', 400, 'analysis-invalid-input');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
  } catch {
    throw new LiekanError('请选择有效的 IANA 时区或 UTC', 400, 'analysis-invalid-timezone');
  }
  const hash = analysisHash({
    actor: identity.userId,
    start: start.toISOString(),
    end: end.toISOString(),
    timezone: input.timezone,
    locale: input.locale,
  });
  return analysisTransaction(async tx => {
    await lockWritableWebsite(tx, websiteId, identity);
    const site = await siteRow(tx, websiteId);
    const [replay] = await tx.$queryRawUnsafe<AnalysisBuildRow[]>(
      'SELECT * FROM liekan_analysis_build WHERE website_id=$1::uuid AND request_id=$2::uuid',
      websiteId,
      input.requestId,
    );
    if (replay) {
      if (replay.request_hash !== hash)
        throw new LiekanError('请求标识已用于其他操作', 409, 'analysis-request-conflict');
      return analysisBuildDto(replay);
    }
    expectRevision(site.revision, input.expectedRevision);
    if (site.mode !== 'live') throw new LiekanError('请先启用统计加速', 409, 'analysis-disabled');
    const capacity = await analysisCapacity(tx, websiteId);
    if (!hasAnalysisBuildCapacity(capacity))
      throw new LiekanError('统计加速存储已达到容量保护阈值', 409, 'analysis-capacity-limited');
    const [build] = await tx.$queryRawUnsafe<AnalysisBuildRow[]>(
      `INSERT INTO liekan_analysis_build(id,website_id,actor_id,epoch,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total,checkpoint)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5,$6,$7,$8,$9::uuid,$10,'queued',$11::bigint,$12::jsonb) RETURNING *`,
      randomUUID(),
      websiteId,
      identity.userId,
      String(site.epoch),
      start,
      end,
      input.timezone,
      input.locale,
      input.requestId,
      hash,
      Math.round((+end - +start) / 3600000) * 2,
      JSON.stringify(canaryCheckpoint(start, end, input.timezone)),
    );
    await tx.$executeRawUnsafe(
      'UPDATE liekan_analysis_site SET revision=revision+1,updated_at=clock_timestamp() WHERE website_id=$1::uuid',
      websiteId,
    );
    return analysisBuildDto(build);
  });
}
export async function listAnalysisBuilds(websiteId: string, identity: WriteIdentity) {
  support();
  return analysisTransaction(async tx => {
    await lockWritableWebsite(tx, websiteId, identity, 'share');
    const rows = await tx.$queryRawUnsafe<AnalysisBuildRow[]>(
      'SELECT * FROM liekan_analysis_build WHERE website_id=$1::uuid ORDER BY created_at DESC,id DESC LIMIT 50',
      websiteId,
    );
    return rows.map(analysisBuildDto);
  });
}
export async function getAnalysisStatus(
  websiteId: string,
  identity: WriteIdentity,
): Promise<AnalysisStatusDto> {
  support();
  return analysisTransaction(async tx => {
    await lockWritableWebsite(tx, websiteId, identity, 'share');
    const site = await siteRow(tx, websiteId, false);
    const versions = await analysisVersions(tx, websiteId);
    const rows = await tx.$queryRawUnsafe<AnalysisBuildRow[]>(
      'SELECT * FROM liekan_analysis_build WHERE website_id=$1::uuid ORDER BY created_at DESC,id DESC LIMIT 50',
      websiteId,
    );
    const coverage = await tx.$queryRawUnsafe<
      {
        family: 'log' | 'visit';
        rangeStart: Date;
        rangeEnd: Date;
        current: boolean;
        rowCount: string;
      }[]
    >(
      `SELECT family,bucket AS "rangeStart",bucket_end AS "rangeEnd",row_count::text AS "rowCount",
        (s.mode='live' AND m.versions=$2::jsonb AND m.fingerprint=liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,m.bucket,m.bucket_end)) AS current
       FROM liekan_analysis_manifest m JOIN liekan_analysis_site s USING(website_id,epoch)
       WHERE m.website_id=$1::uuid ORDER BY bucket DESC,family LIMIT 1000`,
      websiteId,
      JSON.stringify(versions),
    );
    return {
      websiteId,
      supported: true,
      mode: site.mode,
      expansion: { path: site.path_expansion, visit: site.visit_expansion },
      epoch: String(site.epoch),
      revision: analysisSafeNumber(site.revision),
      captureFrom: site.capture_from.toISOString(),
      builds: rows.map(analysisBuildDto),
      coverage: coverage.map(row => ({
        ...row,
        rangeStart: row.rangeStart.toISOString(),
        rangeEnd: row.rangeEnd.toISOString(),
      })),
      capacity: await analysisCapacity(tx, websiteId),
    };
  }, 'RepeatableRead');
}
export interface AnalysisActionInput {
  action: 'pause' | 'resume' | 'retry' | 'disable' | 'enable';
  buildId?: string;
  expectedRevision?: number;
  requestId: string;
}
export async function actionAnalysisBuild(
  websiteId: string,
  identity: WriteIdentity,
  input: AnalysisActionInput,
) {
  support();
  uuid(input.requestId);
  if (input.buildId) uuid(input.buildId);
  if (!['pause', 'resume', 'retry', 'disable', 'enable'].includes(input.action))
    throw new LiekanError('操作无效', 400, 'analysis-invalid-action');
  return analysisTransaction(async tx => {
    await lockWritableWebsite(tx, websiteId, identity);
    const site = await siteRow(tx, websiteId);
    const hash = analysisHash({ actor: identity.userId, ...input });
    const [receipt] = await tx.$queryRawUnsafe<
      { request_hash: string; response: { revision: number; mode: string } }[]
    >(
      'SELECT request_hash,response FROM liekan_analysis_operation WHERE website_id=$1::uuid AND request_id=$2::uuid',
      websiteId,
      input.requestId,
    );
    if (receipt) {
      if (receipt.request_hash !== hash)
        throw new LiekanError('请求标识已用于其他操作', 409, 'analysis-request-conflict');
      return receipt.response;
    }
    if (input.action === 'disable' || input.action === 'enable') {
      expectRevision(site.revision, input.expectedRevision);
      const mode = input.action === 'disable' ? 'disabled' : 'live';
      if (site.mode !== mode) {
        await tx.$executeRawUnsafe(
          'UPDATE liekan_analysis_site SET mode=$2,epoch=epoch+1,revision=revision+1,path_expansion=true,visit_expansion=true,capture_from=clock_timestamp(),updated_at=clock_timestamp() WHERE website_id=$1::uuid',
          websiteId,
          mode,
        );
        await tx.$executeRawUnsafe(
          `UPDATE liekan_analysis_build SET status='invalidated',lease_token=NULL,lease_until=NULL,error_code='analysis-mode-changed',revision=revision+1,updated_at=clock_timestamp() WHERE website_id=$1::uuid AND status IN('queued','running','paused','failed','capacity_limited')`,
          websiteId,
        );
        await bumpAnalyticsRevision(tx, 'website', websiteId);
      }
    } else {
      if (site.mode !== 'live') throw new LiekanError('请先启用统计加速', 409, 'analysis-disabled');
      const [build] = await tx.$queryRawUnsafe<AnalysisBuildRow[]>(
        'SELECT * FROM liekan_analysis_build WHERE website_id=$1::uuid AND id=$2::uuid FOR UPDATE',
        websiteId,
        input.buildId || null,
      );
      if (!build || String(build.epoch) !== String(site.epoch))
        throw new LiekanError('任务不存在或已失效', 404, 'analysis-build-missing');
      expectRevision(build.revision, input.expectedRevision);
      const allowed =
        input.action === 'pause'
          ? ['queued', 'running']
          : input.action === 'resume'
            ? ['paused']
            : ['failed', 'capacity_limited'];
      if (!allowed.includes(build.status))
        throw new LiekanError('当前任务状态不支持此操作', 409, 'analysis-state-conflict');
      await tx.$executeRawUnsafe(
        `UPDATE liekan_analysis_build SET status=$3,lease_token=NULL,lease_until=NULL,error_code=NULL,
        attempts=0,next_attempt_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE website_id=$1::uuid AND id=$2::uuid`,
        websiteId,
        build.id,
        input.action === 'pause' ? 'paused' : 'queued',
      );
      await tx.$executeRawUnsafe(
        'UPDATE liekan_analysis_site SET revision=revision+1,updated_at=clock_timestamp() WHERE website_id=$1::uuid',
        websiteId,
      );
    }
    const current = await siteRow(tx, websiteId);
    const response = { revision: analysisSafeNumber(current.revision), mode: current.mode };
    await tx.$executeRawUnsafe(
      'INSERT INTO liekan_analysis_operation(website_id,request_id,actor_id,request_hash,response) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb)',
      websiteId,
      input.requestId,
      identity.userId,
      hash,
      JSON.stringify(response),
    );
    return response;
  });
}
