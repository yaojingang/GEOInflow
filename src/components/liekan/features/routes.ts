import mapping from '@/lib/liekan/contracts/feature-pages.json';
import type { FeatureRoute } from '@/lib/liekan/contracts/features';
import {
  analysisSourcePage,
  geoPaths,
  navigationFor,
  needsWebsite,
  pageNavigation,
  trackingSourcePage,
} from '@/lib/liekan/contracts/navigation';

export const featurePages = [
  ...mapping.pages.map(page => ({
    ...page,
    title: pageNavigation[page.id]?.title || page.title,
  })),
  {
    id: 'help',
    title: '帮助中心',
    group: 'help',
    summary: '指标、配置与全球蜘蛛资料',
    route: '',
    kind: 'reference',
  },
];
const unscopedPages = new Set([
  'admin-analytics-engine',
  'history-repair',
  'analytics-acceleration',
  'crawlers-manage',
  'ai-chat',
  'ai-config',
  'help',
  'account',
  'security',
  'two-factor',
  'backup-codes',
  'api-keys',
  'preferences',
  'teams',
  'team-join',
  'admin-users',
  'admin-user',
  'admin-websites',
  'admin-teams',
  'admin-security',
  'login',
  'login-2fa',
  'sso',
  'share-preview',
]);
export function normalizeFeatureScope(route: FeatureRoute): FeatureRoute {
  if (['help', 'crawlers-manage', 'history-repair', 'analytics-acceleration'].includes(route.page))
    return { page: route.page };
  return {
    ...route,
    ...(['ai-chat', 'ai-config'].includes(route.page)
      ? { id: undefined, from: undefined, context: undefined }
      : {}),
    ...(!needsWebsite(route) ? { websiteId: undefined } : {}),
    ...(unscopedPages.has(route.page) || navigationFor(route).scope === 'admin'
      ? { teamId: undefined }
      : {}),
  };
}
const uuid = '[a-fA-F0-9-]{36}';
const aliases = mapping.routes.filter(
  r =>
    !r.target.startsWith('reference/') &&
    !['/', '/logout', '/login', '/login/two-factor', '/sso'].includes(r.route),
);
export function matchFeatureRoute(
  pathname: string,
  query: Record<string, string> = {},
): FeatureRoute | null {
  if (/^\/admin\/analytics-engine\/?$/.test(pathname)) return { page: 'admin-analytics-engine', context: 'admin' };
  if (/^\/settings\/analytics-acceleration\/?$/.test(pathname)) return { page: 'analytics-acceleration' };
  if (/^\/settings\/data-repair\/?$/.test(pathname)) return { page: 'history-repair' };
  if (/^\/crawlers\/manage\/?$/.test(pathname)) return { page: 'crawlers-manage' };
  if (query.legacy === '1') return null;
  if (/^\/liekan\/?$/.test(pathname)) return { page: 'websites' };
  let path = pathname;
  const team = path.match(new RegExp(`^/teams/(${uuid})(?=/)`));
  if (team && !path.match(new RegExp(`^/teams/${uuid}/?$`))) path = path.slice(team[0].length);
  if (path.startsWith('/liekan/')) {
    const page = path.slice(8).split('/')[0];
    if (featurePages.some(p => p.id === page))
      return normalizeFeatureScope({
        page,
        websiteId: query.websiteId,
        id: query.id,
        from: query.from,
        teamId: team?.[1] || query.teamId,
        context: query.context === 'website' && page === 'sharing' ? 'website' : undefined,
      });
    return { page: 'not-found' };
  }
  const teamDetail = path.match(new RegExp(`^/teams/(${uuid})/?$`));
  if (teamDetail) return { page: 'team-detail', id: teamDetail[1], teamId: teamDetail[1] };
  for (const route of aliases) {
    const names: string[] = [];
    const pattern = route.route.replace(/\[([^\]]+)\]/g, (_full, name) => {
      names.push(name);
      // The website segment accepts the short site number as well as the UUID.
      return name === 'websiteId' ? `(${uuid}|\\d{1,9})` : `(${uuid})`;
    });
    const match = path.match(new RegExp(`^${pattern}/?$`));
    if (!match) continue;
    const values = Object.fromEntries(names.map((name, i) => [name, match[i + 1]]));
    return normalizeFeatureScope({
      page: route.target.replace('.html', ''),
      websiteId: values.websiteId,
      id:
        values.sessionId ||
        values.replayId ||
        values.boardId ||
        values.linkId ||
        values.pixelId ||
        values.userId ||
        values.teamId,
      teamId: team?.[1] || values.teamId || query.teamId,
      context: pathname.startsWith('/admin/') ? 'admin' : undefined,
    });
  }
  return null;
}
export function featureHref(page: string, params: Record<string, any> = {}): string {
  if (page === 'admin-analytics-engine') return '/admin/analytics-engine';
  if (page === 'analytics-acceleration') {
    const search = new URLSearchParams();
    if (typeof params.websiteId === 'string' && /^[a-f0-9-]{36}$/i.test(params.websiteId)) search.set('websiteId',params.websiteId);
    return `/settings/analytics-acceleration${search.size?'?'+search.toString():''}`;
  }
  if (page === 'history-repair') {
    const search = new URLSearchParams();
    if (typeof params.websiteId === 'string' && /^[a-f0-9-]{36}$/i.test(params.websiteId))
      search.set('websiteId', params.websiteId);
    if (params.tab === 'history') search.set('tab', 'history');
    return `/settings/data-repair${search.size ? '?' + search.toString() : ''}`;
  }
  if (page === 'crawlers-manage') {
    const search = new URLSearchParams();
    if (typeof params.site === 'string' && /^[a-f0-9-]{36}$/i.test(params.site))
      search.set('site', params.site);
    if (['library', 'platforms', 'sources', 'changes'].includes(params.tab))
      search.set('tab', params.tab);
    return `/crawlers/manage${search.size ? '?' + search.toString() : ''}`;
  }
  if (['ai-chat', 'ai-config'].includes(page)) {
    const search = new URLSearchParams();
    for (const key of ['aiSite', 'aiConversation', 'aiRun', 'aiRequest']) {
      const value = params[key];
      const valid =
        typeof value === 'string' &&
        (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value) ||
          (key === 'aiSite' && /^\d{1,9}$/.test(value)));
      if (typeof value === 'string' && valid) search.set(key, value);
    }
    return `/liekan/${page}${search.size ? '?' + search.toString() : ''}`;
  }
  if (page === 'help') {
    const search = new URLSearchParams();
    for (const key of ['section', 'article', 'crawler']) {
      const value = params[key];
      if (typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value)) search.set(key, value);
    }
    return `/liekan/help${search.size ? '?' + search.toString() : ''}`;
  }
  const record = featurePages.find(p => p.id === page);
  const geo =
    page in geoPaths && params.websiteId
      ? `/websites/${params.websiteId}/geo${geoPaths[page]}`
      : '';
  if (!record && !geo) return '/websites';
  const base =
    (params.context === 'admin' && page === 'website-settings' && params.websiteId
      ? `/admin/websites/${params.websiteId}`
      : '') ||
    (params.context === 'admin' && page === 'team-detail' && params.id
      ? `/admin/teams/${params.id}`
      : '') ||
    geo ||
    (record.route &&
    !record.route.includes('[[...') &&
    mapping.routes.some(route => route.route === record.route)
      ? record.route
      : `/liekan/${page}`);
  let path = base.replace(/\[([^\]]+)\]/g, (_full, name) =>
    String(name === 'websiteId' ? params.websiteId || '' : params.id || ''),
  );
  if (path.includes('//') || (/\/$/.test(path) && base.endsWith(']'))) path = `/liekan/${page}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (
      value != null &&
      value !== '' &&
      (key !== 'teamId' || (!unscopedPages.has(page) && params.context !== 'admin')) &&
      (key !== 'websiteId' || needsWebsite({ page, context: params.context }) || !!geo) &&
      (key !== 'context' || (params.context === 'website' && page === 'sharing')) &&
      (!['websiteId', 'id'].includes(key) || path.startsWith('/liekan/'))
    )
      search.set(key, String(value));
  return `${path}${search.size ? '?' + search.toString() : ''}`;
}
const timeKeys = new Set(['date', 'unit', 'offset', 'compare', 'dateMode']);
const isTimeParameter = (key: string, value: string) =>
  timeKeys.has(key) && (key !== 'dateMode' || value === 'default');

export function featureWebsiteSwitchHref(
  route: FeatureRoute,
  websiteId: string,
  query: Record<string, string>,
) {
  const lists: Record<string, string> = {
    'session-detail': 'sessions',
    'replay-player': 'replays',
    'event-detail': 'events',
    'path-detail': 'journeys',
    'goal-editor': 'goals',
    'funnel-editor': 'funnels',
    'segment-editor': 'segments',
    'cohort-editor': 'cohorts',
  };
  const page = lists[route.page] || route.page;
  if (!needsWebsite(route)) return featureHref(page, { id: route.id, teamId: route.teamId });
  const time = Object.fromEntries(
    Object.entries(query).filter(([key, value]) => isTimeParameter(key, value)),
  );
  return featureHref(page, {
    ...time,
    ...(page === 'geo-logs' && query.live === '1' ? { live: '1' } : {}),
    ...(safeReturnHref(query.returnTo) ? { returnTo: safeReturnHref(query.returnTo) } : {}),
    websiteId,
    ...(page === route.page && route.id ? { id: route.id } : {}),
    ...(route.context === 'website' ? { context: route.context } : {}),
  });
}

const websiteFilter =
  /^(drill_|(?:path|referrer|channel|title|query|os|tag|hostname|distinctId|language|country|region|city|browser|device|event)\d*$|utm|crawlerIdentityScope$|sourceId$|botId$|botName$|botType$|botProductForm$|botCategory$|snapshot$|cursor$|seek$|segment$|cohort$|match$|excludeBounce$|spf\d|epf\d)/;
export function featureNavigationHref(
  route: FeatureRoute,
  query: Record<string, string>,
  page: string,
  params: Record<string, any> = {},
) {
  if (['help', 'crawlers-manage', 'history-repair', 'analytics-acceleration'].includes(page))
    return featureHref(page, params);
  if (route.context === 'admin' && page === 'teams') page = 'admin-teams';
  if (route.context === 'admin' && page === 'websites') page = 'admin-websites';
  const target = {
    page,
    context:
      params.context ||
      (route.context === 'admin' && ['website-settings', 'team-detail'].includes(page)
        ? 'admin'
        : undefined),
  } as FeatureRoute;
  const scoped = needsWebsite(target);
  const geo = page in geoPaths;
  const trackingSource = trackingSourcePage(route);
  const trackingSwitch =
    trackingSource && ['links', 'pixels'].includes(page) && trackingSource !== page;
  const analysisTools = new Set(['filters', 'annotations', 'exports']);
  const journeySource =
    ['journeys', 'path-detail'].includes(route.page) ||
    (analysisTools.has(route.page) && analysisSourcePage(route.from) === 'journeys');
  const journeyTarget =
    ['journeys', 'path-detail'].includes(page) ||
    (analysisTools.has(page) &&
      analysisSourcePage(params.from || route.from || route.page) === 'journeys');
  const inherited = Object.fromEntries(
    Object.entries(query).filter(
      ([key, value]) =>
        isTimeParameter(key, value) ||
        (key === 'returnTo' &&
          !trackingSwitch &&
          !!(scoped ? safeReturnHref(query[key]) : safeListReturnHref(query[key]))) ||
        (scoped && !geo && websiteFilter.test(key)) ||
        (journeySource && journeyTarget && /^(type|steps|startStep|endStep)$/.test(key)) ||
        (['sessions', 'session-detail'].includes(page) &&
          /^(retentionDate|retentionDay|attributionStep|attributionModel|attributionType|attributionSource)$/.test(
            key,
          )),
    ),
  );
  const result: Record<string, any> = {
    ...inherited,
    ...(scoped ? { websiteId: route.websiteId } : {}),
    ...(navigationFor(target).scope === 'global' && route.teamId ? { teamId: route.teamId } : {}),
    ...(target.context ? { context: target.context } : {}),
    ...params,
  };
  if (scoped && analysisTools.has(page))
    result.from = analysisSourcePage(params.from || route.from || route.page);
  if ('date' in params) {
    if (!('dateMode' in params)) delete result.dateMode;
    if (!('live' in params)) delete result.live;
  }
  if (geo && Object.keys(query).some(key => websiteFilter.test(key))) result.clearedFilters = '1';
  const returnTo = scoped ? safeReturnHref(query.returnTo) : safeListReturnHref(query.returnTo);
  if (returnTo && !trackingSwitch) {
    const targetUrl = new URL(returnTo, 'http://liekan.local');
    if (
      matchFeatureRoute(targetUrl.pathname, Object.fromEntries(targetUrl.searchParams))?.page ===
      page
    )
      return returnTo;
  }
  const lists = new Set([
    'websites',
    'boards',
    'sharing',
    'links',
    'pixels',
    'teams',
    'admin-users',
    'admin-websites',
    'admin-teams',
  ]);
  if (!trackingSwitch && lists.has(route.page) && route.page !== page) {
    const origin = featureHref(route.page, {
      ...(route.teamId ? { teamId: route.teamId } : {}),
      ...(route.id ? { id: route.id } : {}),
      ...Object.fromEntries(
        Object.entries(query).filter(
          ([key]) =>
            ['scope', 'search', 'page', 'sort', 'direction'].includes(key) || timeKeys.has(key),
        ),
      ),
    });
    if (!scoped || safeReturnHref(origin)) result.returnTo = origin;
  }
  return featureHref(page, result);
}
function safeListReturnHref(value: string) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f]/.test(value))
    return '';
  const url = new URL(value, 'http://liekan.local');
  return [
    '/websites',
    '/settings/websites',
    '/boards',
    '/links',
    '/pixels',
    '/teams',
    '/settings/teams',
    '/admin/users',
    '/admin/websites',
    '/admin/teams',
    '/liekan/sharing',
  ].includes(url.pathname)
    ? value
    : '';
}

export function safeReturnHref(value: string) {
  const safe = safeListReturnHref(value);
  return safe &&
    ['/websites', '/settings/websites', '/admin/websites'].includes(
      new URL(safe, 'http://liekan.local').pathname,
    )
    ? safe
    : '';
}
