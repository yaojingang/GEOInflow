import { CRAWLER_POPULATION_VERSION } from '../rules/population';
import { geographyVersion, type GeographyDisplay } from '../contracts/geography';
import type { LiekanReport } from '../contracts/report';
import { checkAuth } from '@/lib/auth';
import { ENTITY_TYPE } from '@/lib/constants';
import { canViewWebsiteSection } from '@/permissions/share';
import {
  sharedReportParts,
  sharedReportQuery,
  sharedReportSchema,
  sharedTimezone,
  type SharedReport,
} from '../contracts/shared-report';
import { buildReport } from '../report';
import { bindCacheRequest, noteCacheResult, withoutQueryCache } from './cache-context';
import { loadShareEntity } from './live-share';
import { analyticsCache, analyticsCacheKey, websiteCacheTag } from './query-cache';
import { authorize, LiekanError, query, reportSnapshot } from './server';

export async function readSharedReport(request: Request, websiteId: string): Promise<SharedReport> {
  const auth = await checkAuth(request);
  if (!auth) throw new LiekanError('需要有效分享凭据', 401);
  let website: { id: string; name: string; domain: string };
  let goals = true;
  if ('shareToken' in auth && auth.shareToken) {
    if (
      auth.user ||
      auth.shareToken.shareType !== ENTITY_TYPE.website ||
      auth.shareToken.websiteId !== websiteId ||
      !(await canViewWebsiteSection(auth, websiteId, 'overview'))
    )
      throw new LiekanError('此分享未开放网站总览', 403);
    const entity = await loadShareEntity(ENTITY_TYPE.website, websiteId);
    if (!entity) throw new LiekanError('分享网站不存在', 404);
    website = { id: entity.id, name: entity.name, domain: entity.domain };
    goals = await canViewWebsiteSection(auth, websiteId, 'goals');
  } else {
    // The shared payload keeps the minimal website block for every viewer; the
    // authorize row may also carry the short site number, which share pages never use.
    const authorized = (await authorize(request, websiteId)).website;
    website = { id: authorized.id, name: authorized.name, domain: authorized.domain };
  }
  bindCacheRequest(
    request,
    auth,
    Object.fromEntries(new URL(request.url).searchParams),
    async () => {
      const fresh = await checkAuth(request);
      return (
        !!fresh &&
        JSON.stringify(
          ('shareToken' in fresh && fresh.shareToken) || {
            id: fresh.user?.id,
            role: fresh.user?.role,
          },
        ) ===
          JSON.stringify(
            ('shareToken' in auth && auth.shareToken) || {
              id: auth.user?.id,
              role: auth.user?.role,
            },
          )
      );
    },
  );
  const input = sharedReportQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!input.success) throw new LiekanError('分享统计参数无效');
  return warmSharedReport(website, input.data, auth);
}

export async function warmSharedReport(
  website: { id: string; name: string; domain: string },
  parameters: unknown,
  auth: any,
): Promise<SharedReport> {
  const input = sharedReportQuery.safeParse(parameters);
  if (!input.success) throw new LiekanError('分享统计参数无效');
  const { refresh, ...parametersForReport } = input.data;
  if (auth.shareToken) parametersForReport.timezone = sharedTimezone(auth.shareToken.parameters);
  const goals = auth.shareToken ? await canViewWebsiteSection(auth, website.id, 'goals') : true;
  const revision = analyticsCache.isRuntimeConfigured
    ? undefined
    : (
        await query(
          `SELECT coalesce((SELECT data_revision::text FROM liekan_log_state WHERE website_id=$1::uuid),'0') AS data,coalesce((SELECT policy_revision::text FROM liekan_log_state WHERE website_id=$1::uuid),'0') AS policy,coalesce((SELECT revision::text FROM liekan_analytics_revision WHERE resource_type='website' AND resource_id=$1::uuid),'0') AS geography`,
          website.id,
        )
      )[0] || { data: '0', policy: '0' };
  const cached = await analyticsCache.read(
    analyticsCacheKey(`shared-report-v5-${geographyVersion}-${CRAWLER_POPULATION_VERSION}`, [
      process.env.DATABASE_URL,
      website.id,
      parametersForReport,
      revision,
      goals,
      ('shareToken' in auth && auth.shareToken)?.shareId,
      ('shareToken' in auth && auth.shareToken)?.parameters,
    ]),
    30000,
    [websiteCacheTag(website.id)],
    () =>
      reportSnapshot(() =>
        withoutQueryCache(async () =>
          projectSharedReport(
            await buildReport(
              website,
              false,
              { ...parametersForReport, resource: 'overview' },
              'share',
            ),
            website,
            goals,
          ),
        ),
      ),
    refresh === '1',
  );
  noteCacheResult(cached);
  cached.value.website = website;
  return cached.value;
}

function projectSharedReport(
  report: any,
  website: { id: string; name: string; domain: string },
  goals: boolean,
): SharedReport {
  // Publish only the aggregate fields consumed by the shared dashboard.
  const cards = report.cards.filter(
    card =>
      (sharedReportParts.cards as readonly string[]).includes(card.label) &&
      (report.meta.aiCrawlerEnabled !== false || card.label !== 'AI 蜘蛛请求'),
  );
  const geography = projectSharedGeography(report, cards);
  const result = sharedReportSchema.parse({
    ...report,
    website,
    cards,
    charts: Object.fromEntries(
      sharedReportParts.charts.map(id => {
        const { labels, series, state } = report.charts[id];
        return [
          id,
          {
            labels,
            series,
            state,
            ...(id === 'g1' && {
              rows: report.charts.g1.rows?.map(row => ({
                conversionRate: goals ? row.conversionRate : null,
              })),
            }),
          },
        ];
      }),
    ),
    tables: {
      envGrid: report.tables.envGrid,
      cityBody: report.tables.cityBody.slice(0, 12).map(row => ({
        ...row,
        conversionRate: goals ? row.conversionRate : null,
      })),
    },
    states: {
      ...report.states,
      ...(report.meta.aiCrawlerEnabled === false && {
        logs: 'unsupported',
        catalog: 'unsupported',
      }),
      goals: goals ? report.states.goals : 'unsupported',
    },
    insights: report.insights.map(text =>
      text.replace(
        '按 UA 分类，官方 IP 范围匹配结果见访问流。',
        '按 User-Agent 分类，抓取身份以官方 IP 范围核验为准。',
      ),
    ),
    meta: {
      population: report.meta.population,
      trendPopulation: report.meta.trendPopulation,
      geographyCoverage: report.meta.geographyCoverage,
      demo: report.meta.demo,
      ...(report.meta.aiCrawlerEnabled !== undefined && {
        aiCrawlerEnabled: report.meta.aiCrawlerEnabled,
      }),
      canManage: false,
      latestImportAt: null,
      ruleCount: 0,
      ...(geography && { geography }),
    },
    capabilities: { goals },
  });
  return result as SharedReport;
}

function projectSharedGeography(
  report: LiekanReport,
  cards: LiekanReport['cards'],
): LiekanReport['meta']['geography'] {
  const source = report.meta.geography;
  if (!source) return undefined;
  const place = (
    value: GeographyDisplay,
    scope: 'country' | 'region' | 'city',
  ): GeographyDisplay => ({
    country: value.country,
    region: scope === 'country' ? null : value.region,
    city: scope === 'city' ? value.city : null,
    cityId: scope === 'city' ? value.cityId : null,
  });
  const geography: NonNullable<LiekanReport['meta']['geography']> = {
    charts: {},
    tables: {},
    cards: {},
  };
  for (const [id, limit] of [
    ['g1', 10],
    ['g2', 8],
  ] as const) {
    const count = report.charts[id]?.labels.length;
    const locations = source.charts?.[id];
    if (count <= limit && locations && locations.length >= count)
      geography.charts[id] = locations
        .slice(0, count)
        .map(value => place(value, id === 'g1' ? 'region' : 'country'));
  }
  const count = Math.min(12, report.tables.cityBody.length);
  const locations = source.tables?.cityBody;
  if (locations && locations.length >= count)
    geography.tables.cityBody = locations.slice(0, count).map(value => place(value, 'city'));
  for (const card of cards) {
    if (card.label !== 'TOP1 城市' && card.label !== '海外 TOP1') continue;
    const value = source.cards?.[card.key];
    if (value)
      geography.cards[card.key] = place(value, card.label === '海外 TOP1' ? 'country' : 'city');
  }
  return Object.values(geography).some(entries => Object.keys(entries).length)
    ? geography
    : undefined;
}
