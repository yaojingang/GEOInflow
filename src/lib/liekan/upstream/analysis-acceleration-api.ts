import { warehouseEnabled } from '../warehouse/runtime';
import { z } from 'zod';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { analysisBuildInputSchema, analysisActionSchema } from '../contracts/analysis-acceleration';
import { authenticateCrawlerMaintenance } from './crawler-maintenance';
import { authorize } from './server';
import { authorizeCrawler } from './crawler-access';
import { aiExecutor } from './ai-db';
import { analysisTransaction } from './analysis-rollups-db';
import { createAnalysisBuild, getAnalysisStatus, actionAnalysisBuild } from './analysis-rollups';
import { LiekanError } from './errors';

export async function authorizeAnalysisManagement(request: Request, handle: string) {
  if (process.env.CLICKHOUSE_URL) throw new LiekanError('统计加速当前支持 PostgreSQL', 501);
  const actor = await authenticateCrawlerMaintenance(request);
  const access = await authorize(request, handle, true);
  await analysisTransaction(tx =>
    authorizeCrawler(aiExecutor(tx), actor, access.website.id, 'control'),
  );
  return { websiteId: access.website.id, identity: { userId: actor.id }, actor };
}
export async function listAnalysisWebsites(request: Request) {
  if (process.env.CLICKHOUSE_URL) throw new LiekanError('统计加速当前支持 PostgreSQL', 501);
  const actor = await authenticateCrawlerMaintenance(request);
  const cursor = new URL(request.url).searchParams.get('cursor');
  if (cursor && !z.uuid().safeParse(cursor).success) throw new LiekanError('分页游标无效', 400);
  return analysisTransaction(async tx => {
    const [user] = await tx.$queryRawUnsafe<{ role: string }[]>(
      'SELECT role FROM "user" WHERE user_id=$1::uuid AND deleted_at IS NULL FOR SHARE',
      actor.id,
    );
    if (!user) throw new LiekanError('当前登录已失效', 401);
    const rows = await tx.$queryRawUnsafe<
      { id: string; name: string; domain: string; mode: string }[]
    >(
      `SELECT w.website_id AS id,w.name,w.domain,s.mode FROM website w LEFT JOIN liekan_analysis_site s USING(website_id)
       WHERE w.deleted_at IS NULL AND ($2='admin' OR ($2<>'view-only' AND (w.user_id=$1::uuid OR EXISTS(
         SELECT 1 FROM team_user tu JOIN team t ON t.team_id=tu.team_id WHERE t.deleted_at IS NULL AND tu.team_id=w.team_id
         AND tu.user_id=$1::uuid AND tu.role IN('team-owner','team-manager')))))
       AND ($3::uuid IS NULL OR w.website_id>$3::uuid) ORDER BY w.website_id LIMIT 51`,
      actor.id,
      user.role,
      cursor || null,
    );
    return {
      supported: !warehouseEnabled(),
      backend: warehouseEnabled() ? 'clickhouse' : 'postgresql',
      websites: rows.slice(0, 50),
      nextCursor: rows.length > 50 ? rows[49].id : null,
    };
  });
}
/** Expand the real monthly dependency and comparison window in the selected timezone. */
export function analysisCommonRange(timezone: string, now = Date.now()) {
  let local: string;
  try {
    local = formatInTimeZone(now, timezone, 'yyyy-MM-dd');
  } catch {
    throw new LiekanError('时区无效', 400);
  }
  const cutoff = fromZonedTime(`${local}T00:00:00`, timezone);
  const [year, month] = formatInTimeZone(+cutoff - 1, timezone, 'yyyy-MM')
    .split('-')
    .map(Number);
  const first = new Date(Date.UTC(year, month - 6, 1)).toISOString().slice(0, 10);
  return {
    startDate: fromZonedTime(`${first}T00:00:00`, timezone),
    endDate: fromZonedTime(`${local}T00:00:00`, timezone),
  };
}
export async function analysisManagementState(request: Request, handle: string) {
  const { websiteId, identity } = await authorizeAnalysisManagement(request, handle);
  if (warehouseEnabled()) return { websiteId, supported: false, backend: 'clickhouse' };
  return getAnalysisStatus(websiteId, identity);
}
export async function analysisManagementBuild(request: Request, handle: string, input: unknown) {
  const parsed = analysisBuildInputSchema.safeParse(input);
  if (!parsed.success) throw new LiekanError('构建参数无效', 400);
  const { websiteId, identity } = await authorizeAnalysisManagement(request, handle);
  if (warehouseEnabled()) throw new LiekanError('ClickHouse 已直接提供统计，无需构建旧汇总', 410);
  const p = parsed.data;
  let range = analysisCommonRange(p.timezone);
  if (p.preset === 'custom') range = { startDate: new Date(p.startAt), endDate: new Date(p.endAt) };
  if (p.preset === 'retained') {
    const rows = await analysisTransaction(tx =>
      tx.$queryRawUnsafe<{ start: Date | null; end: Date | null }[]>(
        `SELECT min(first_at) AS start,max(last_at) AS end FROM (
       (SELECT created_at AS first_at,created_at AS last_at FROM liekan_log WHERE website_id=$1::uuid ORDER BY created_at LIMIT 1)
       UNION ALL (SELECT created_at,created_at FROM website_event WHERE website_id=$1::uuid ORDER BY created_at LIMIT 1)
       UNION ALL (SELECT created_at,created_at FROM liekan_log WHERE website_id=$1::uuid ORDER BY created_at DESC LIMIT 1)
       UNION ALL (SELECT created_at,created_at FROM website_event WHERE website_id=$1::uuid ORDER BY created_at DESC LIMIT 1)) boundaries`,
        websiteId,
      ),
    );
    if (!rows[0]?.start) throw new LiekanError('当前网站没有可构建的历史数据', 409);
    range = {
      startDate: rows[0].start,
      endDate: new Date(Math.min(+new Date(rows[0].end) + 1, Date.now())),
    };
  }
  return createAnalysisBuild(websiteId, identity, { ...p, ...range });
}
export async function analysisManagementAction(request: Request, handle: string, input: unknown) {
  const parsed = analysisActionSchema.safeParse(input);
  if (!parsed.success) throw new LiekanError('操作参数无效', 400);
  const { websiteId, identity } = await authorizeAnalysisManagement(request, handle);
  if (warehouseEnabled()) throw new LiekanError('ClickHouse 已直接提供统计，无需构建旧汇总', 410);
  return actionAnalysisBuild(websiteId, identity, parsed.data);
}
