import { warehouseEnabled } from '../warehouse/authority-routing';
import { getPostgresCountrySQL, getClickHouseCountrySQL } from '@/lib/country';
import { checkAuth } from '@/lib/auth';
import prisma from '@/lib/prisma';
import clickhouse from '@/lib/clickhouse';
import { getQueryFilters } from '@/lib/request';
import { canViewLink } from '@/permissions';
import { loadShareEntity } from './live-share';
import { ENTITY_TYPE } from '@/lib/constants';
import { resourceSourcesQuery } from '../contracts/resource-sources';
import { LiekanError } from './server';
import { bindCacheRequest } from './cache-context';
export async function linkSources(request: Request, id: string, input: unknown) {
  const parsed = resourceSourcesQuery.safeParse(input);
  if (
    !parsed.success ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)
  )
    throw new LiekanError('来源查询参数无效');
  const auth = await checkAuth(request);
  if (!auth?.user || ('shareToken' in auth && auth.shareToken) || auth.user.deletedAt)
    throw new LiekanError('需要完整登录', 401);
  if (!(await loadShareEntity(ENTITY_TYPE.link, id))) throw new LiekanError('链接不存在', 404);
  if (!(await canViewLink(auth, id))) throw new LiekanError('无权访问该链接', 403);
  bindCacheRequest(request, auth, parsed.data, async () => {
    const fresh = await checkAuth(request);
    return !!fresh?.user && fresh.user.id === auth.user.id && fresh.user.role === auth.user.role &&
      !!(await loadShareEntity(ENTITY_TYPE.link, id)) && !!(await canViewLink(fresh,id));
  });
  const p = parsed.data;
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: p.timezone }).format();
  } catch {
    throw new LiekanError('时区无效');
  }
  const filters = await getQueryFilters({ ...p, eventType: 3 }, id);
  const db = process.env.CLICKHOUSE_URL || warehouseEnabled() ? clickhouse : prisma;
  const ctx: any = db.parseFilters({ ...filters, websiteId: id }, { joinSession: true });
  const pg = !process.env.CLICKHOUSE_URL && !warehouseEnabled();
  const selected = `SELECT website_event.referrer_domain AS source,${pg ? getPostgresCountrySQL('session.country') : getClickHouseCountrySQL('website_event.country')} AS country,COUNT(*) AS clicks FROM website_event ${ctx.cohortQuery} ${ctx.excludeBounceQuery} ${pg ? ctx.joinSessionQuery : ''} WHERE website_event.website_id=${pg ? '{{websiteId::uuid}}' : '{websiteId:UUID}'} AND website_event.event_type=3 AND website_event.created_at BETWEEN ${pg ? '{{startDate}} AND {{endDate}}' : '{startDate:DateTime64} AND {endDate:DateTime64}'} ${ctx.filterQuery} GROUP BY 1,2`;
  const params = { ...ctx.queryParams, offset: (p.page - 1) * 25 };
  const [total, rows] = await Promise.all([
    db.rawQuery(`SELECT COUNT(*) AS count FROM (${selected}) t`, params, 'liekanLinkSourcesCount'),
    db.rawQuery(
      `${selected} ORDER BY clicks DESC,source,country LIMIT 25 OFFSET ${pg ? '{{offset}}' : '{offset:UInt32}'}`,
      params,
      'liekanLinkSourcesRows',
    ),
  ]);
  return {
    rows: rows.map((r: any) => ({ ...r, clicks: Number(r.clicks) })),
    count: Number(total[0].count),
    page: p.page,
    pageSize: 25,
  };
}
