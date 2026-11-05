import {
  browserPopulationSchema,
  identityUsable,
  type BrowserPopulation,
} from '../contracts/browser-population';
import { checkAuth, hasPermission } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/constants';
import prisma, { getRawQueryClient } from '@/lib/prisma';
import type { Auth } from '@/lib/types';
import { canUpdateWebsite, canViewWebsite } from '@/permissions';
import { getWebsiteStats } from '@/queries/sql';
import { getQuerySnapshot, withinQuerySnapshot } from './query-snapshot';

import { LiekanError } from './errors';
import {
  bindCacheRequest,
  prepareAnalyticsVersions,
  runCacheAuthorization,
  cacheHeadersEnabled,
} from './cache-context';
import {
  primaryMetadataClient,
  analyticsQueryFailure,
  timedAnalyticsClient,
  analyticsRemaining,
} from './analytics-deadline';
import { withTrafficPolicy } from './traffic-query';
import { warehouseEnabled } from '../warehouse/runtime';
export { LiekanError } from './errors';
const WEBSITE_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SITE_NUMBER_PATTERN = /^\d{1,9}$/;
export async function authorize(request: Request, websiteId: string, write = false) {
  const byId = WEBSITE_ID_PATTERN.test(websiteId);
  if (!byId && !SITE_NUMBER_PATTERN.test(websiteId)) throw new LiekanError('站点 ID 无效');
  const auth = await runCacheAuthorization(() => checkAuth(request));
  if (!auth?.user || ('shareToken' in auth && auth.shareToken) || auth.user.deletedAt)
    throw new LiekanError('需要完整登录', 401);
  bindCacheRequest(request, auth);
  const website = await runCacheAuthorization<any>(() =>
    primary().website.findFirst({
      where: byId
        ? { id: websiteId, deletedAt: null }
        : { siteNumber: Number(websiteId), deletedAt: null },
      select: { id: true, name: true, domain: true, siteNumber: true },
    }),
  );
  if (!website) throw new LiekanError('站点不存在', 404);
  // Analytics cache tags and permission checks key on the UUID; the handle only selects the site.
  const id = website.id as string;
  await prepareAnalyticsVersions([`website:${id.toLowerCase()}`]);
  const allowed = write
    ? await canUpdateWebsite(auth as Auth, id)
    : await canViewWebsite(auth as Auth, id);
  if (!allowed) throw new LiekanError('无权访问该站点', 403);
  bindCacheRequest(
    request,
    auth,
    Object.fromEntries(new URL(request.url).searchParams),
    async () => {
      const fresh = await checkAuth(request);
      if (
        !fresh?.user ||
        fresh.user.deletedAt ||
        ('shareToken' in fresh && fresh.shareToken) ||
        fresh.user.id !== auth.user.id ||
        fresh.user.role !== auth.user.role
      )
        return false;
      const client = primaryMetadataClient() || primary();
      const current = await client.website.findFirst({
        where: { id, deletedAt: null },
        select: { userId: true, teamId: true },
      });
      if (!current) return false;
      if (await hasPermission(fresh.user.role, PERMISSIONS.all)) return true;
      if (current.userId) return current.userId === fresh.user.id;
      if (!current.teamId) return false;
      const member = await client.teamUser.findFirst({
        where: { teamId: current.teamId, userId: fresh.user.id, team: { deletedAt: null } },
        select: { role: true },
      });
      return !!member && (!write || (await hasPermission(member.role, PERMISSIONS.websiteUpdate)));
    },
  );
  return {
    website,
    auth,
    writeIdentity: { userId: auth.user.id },
    canManage: Boolean(await canUpdateWebsite(auth as Auth, id)),
  };
}
export type WriteIdentity = { userId: string };
export async function lockWritableWebsite(
  tx: any,
  id: string,
  identity?: WriteIdentity,
  lock: 'update' | 'share' = 'update',
) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT user_id,team_id FROM website WHERE website_id=$1::uuid AND deleted_at IS NULL FOR ${lock === 'share' ? 'SHARE' : 'UPDATE'}`,
    id,
  );
  if (!rows.length) throw new LiekanError('站点不存在', 404);
  if (!identity) return;
  const users = await tx.$queryRawUnsafe(
    'SELECT role FROM "user" WHERE user_id=$1::uuid AND deleted_at IS NULL FOR SHARE',
    identity.userId,
  );
  if (!users.length) throw new LiekanError('账户无效', 401);
  if (await hasPermission(users[0].role, PERMISSIONS.all)) return;
  if (rows[0].user_id === identity.userId) return;
  const members = rows[0].team_id
    ? await tx.$queryRawUnsafe(
        'SELECT tu.role FROM team_user tu JOIN team t ON t.team_id=tu.team_id WHERE tu.team_id=$1::uuid AND tu.user_id=$2::uuid AND t.deleted_at IS NULL FOR SHARE OF tu,t',
        rows[0].team_id,
        identity.userId,
      )
    : [];
  if (!members.length || !(await hasPermission(members[0].role, PERMISSIONS.websiteUpdate)))
    throw new LiekanError('站点管理权限已变更', 403);
}
const primary = (): any => getRawQueryClient(prisma.client, { write: true });
export { primary };
export async function query<T = any>(sql: string, ...params: unknown[]): Promise<T[]> {
  sql = withTrafficPolicy(sql);
  const snapshot = getQuerySnapshot() || primaryMetadataClient();
  if (snapshot) return snapshot.$queryRawUnsafe(sql, ...params) as Promise<T[]>;
  if (cacheHeadersEnabled())
    return runCacheAuthorization(() => primaryMetadataClient().$queryRawUnsafe(sql, ...params));
  return transaction(tx => tx.$queryRawUnsafe(sql, ...params));
}
export async function sourceWebsite(
  tx: any,
  id: string,
  identity: WriteIdentity,
  lock: 'update' | 'share' = 'update',
) {
  await lockWritableWebsite(tx, id, identity, lock);
  return (
    await tx.$queryRawUnsafe(
      'SELECT domain,user_id,team_id,reset_at FROM website WHERE website_id=$1::uuid',
      id,
    )
  )[0];
}
export async function reportSnapshot<T>(work: () => Promise<T>, deadline?: number): Promise<T> {
  if(warehouseEnabled())return (await import('./warehouse-report-snapshot')).withinWarehouseReport(work, { deadline });
  const snapshot = getQuerySnapshot();
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new LiekanError('数据库 schema 无效', 500);
  let computing = false;
  const compute = () => {
    computing = true;
    return work();
  };
  try {
    if (snapshot)
      return await (deadline === undefined
        ? compute()
        : withinQuerySnapshot(timedAnalyticsClient(snapshot, deadline, true), compute));
    return await primary().$transaction(
      async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        await tx.$executeRawUnsafe('SET LOCAL jit=off');
        return withinQuerySnapshot(
          deadline === undefined ? tx : timedAnalyticsClient(tx, deadline, true),
          compute,
        );
      },
      {
        isolationLevel: 'RepeatableRead',
        timeout: deadline === undefined ? 60000 : analyticsRemaining(deadline),
        maxWait: deadline === undefined ? 10000 : Math.min(10000, analyticsRemaining(deadline)),
      },
    );
  } catch (error) {
    if (deadline !== undefined) throw analyticsQueryFailure(error, deadline, computing);
    throw error;
  }
}
export async function transaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new LiekanError('数据库 schema 无效', 500);
  return (await primary().$transaction(
    async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      return work(tx);
    },
    { timeout: 60000, maxWait: 60000 },
  )) as T;
}
export async function humanTotals(
  websiteId: string,
  startDate: Date,
  endDate: Date,
  timezone = 'UTC',
) {
  const raw: unknown = warehouseEnabled()
    ? await (await import('./warehouse-browser-queries')).warehouseBrowserTotals(websiteId,startDate,endDate,timezone)
    : await getWebsiteStats(websiteId, { startDate, endDate, timezone });
  const incompatible = () => new LiekanError('统计数据契约不兼容', 500);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw incompatible();
  const totals = {} as {
    pageviews: number;
    visitors: number | null;
    visits: number | null;
    bounces: number | null;
    totaltime: number | null;
    population?: BrowserPopulation;
  };
  const population =
    'population' in raw ? browserPopulationSchema.parse(raw.population) : undefined;
  if (population) totals.population = population;
  for (const field of ['pageviews', 'visitors', 'visits', 'bounces', 'totaltime'] as const) {
    if (!Object.hasOwn(raw, field)) throw incompatible();
    let value = raw[field];
    if (value === null && field !== 'pageviews' && population && !identityUsable(population)) {
      totals[field] = null;
      continue;
    }
    // PostgreSQL aggregate counts are bigint. Normalize only exactly representable values.
    if (typeof value === 'bigint') {
      if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw incompatible();
      value = Number(value);
    }
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      (field !== 'totaltime' && !Number.isSafeInteger(value))
    )
      throw incompatible();
    totals[field] = value;
  }
  return totals;
}
