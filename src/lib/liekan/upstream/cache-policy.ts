import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { CacheResource } from '../contracts/cache-manifest';

export const browserCacheLimits = Object.freeze({
  format: 'liekan-browser-v2',
  maxAge: 7 * 86400000,
  entries: 200,
  bytes: 10 * 1024 * 1024,
  resultBytes: 256 * 1024,
});

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function uniqueCacheResources(resources: CacheResource[]): CacheResource[] {
  return [
    ...new Map(
      resources
        .filter(
          value =>
            value &&
            uuid.test(value.id) &&
            ['website', 'link', 'pixel', 'board'].includes(value.type),
        )
        .map(value => [`${value.type}:${value.id}`, { ...value, id: value.id.toLowerCase() }]),
    ).values(),
  ].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
}

/** Only agreed transport objects leave the business identity. Nested filters stay exact. */
export function stableBusinessKey(key: readonly unknown[], persistent = false) {
  const values = [...key];
  while (values.length) {
    const last = values.at(-1);
    if (!last || typeof last !== 'object' || Array.isArray(last)) break;
    const names = Object.keys(last);
    const nativeProtocol = persistent && names.length === 1 && names[0] === 'nativeIdentity';
    const cacheProtocol =
      (last as any).cacheFormat === browserCacheLimits.format &&
      ['cacheNamespace', 'cacheUser', 'cacheScope', 'cacheLocale'].every(name => name in last);
    if (!nativeProtocol && !cacheProtocol) break;
    if (
      !names.length ||
      !names.every(name =>
        [
          'manualPage',
          'manualRound',
          'nativeIdentity',
          'cacheNamespace',
          'cacheFormat',
          'cacheUser',
          'cacheScope',
          'cacheLocale',
        ].includes(name),
      )
    )
      break;
    values.pop();
  }
  return values;
}

/** Request proof is required in addition to this query allowlist before writing a projection. */
export function browserQueryPolicy(key: readonly unknown[], meta: Record<string, any> = {}) {
  const base = stableBusinessKey(key) as any[];
  if (
    meta.cacheDirect ||
    meta.readPurpose === 'authorization' ||
    /^(?:liekan-public|liekan-shared)/.test(String(base[0]))
  )
    return null;
  if (meta.cacheAggregate === false) return null;
  let resources: CacheResource[] = [];
  if (base[0] === 'liekan' && base.length >= 15 && base[3] !== 'logs')
    resources = [{ type: 'website', id: base[1] }];
  else if (base[0] === 'liekan-feature') {
    if (base[2] === 'geo-weight-snapshot' && meta.cacheAggregate === true) {
      resources = [{ type: 'website', id: base[3] }];
    } else if (['resource-analytics', 'board-widget'].includes(base[1])) {
      const type = base[1] === 'resource-analytics' ? base[4] : undefined;
      const component = base[1] === 'board-widget' ? base[4] : undefined;
      resources = [{ type: type || component?.entityType || 'website', id: base[3] }];
    } else {
      const labels = base.filter(value => typeof value === 'string');
      if (
        labels.some(value =>
          /^(?:api-keys|2fa-status|account-profile|session|sessions|session-detail|session-record|session-props|session-timeline|replay|replays|event-detail|event-data|revenue-records|logs|history-repair|ai-run)/.test(
            value,
          ),
        )
      )
        return null;
      const range = base.find(
        value =>
          value &&
          typeof value === 'object' &&
          Number.isFinite(value.startAt) &&
          Number.isFinite(value.endAt),
      );
      if (!range && !meta.cacheAggregate) return null;
      if (uuid.test(String(base[2]))) resources.push({ type: 'website', id: base[2] });
      if (labels.some(value => /^website-management-(?:stats|today)$/.test(value)))
        for (const ids of base.filter(Array.isArray))
          resources.push(...ids.map(id => ({ type: 'website' as const, id })));
      for (const type of ['link', 'pixel'] as const) {
        const list = base.indexOf(`${type}s-list-stats`);
        if (list >= 0 && Array.isArray(base[list + 1]))
          resources.push(...base[list + 1].map(id => ({ type, id })));
      }
      const detail = base.indexOf('resource-detail-stats');
      if (detail >= 0 && ['link', 'pixel'].includes(base[detail + 1]))
        resources.push({ type: base[detail + 1], id: base[detail + 2] });
      const sources = base.indexOf('link-joint-sources');
      if (sources >= 0) resources.push({ type: 'link', id: base[sources + 1] });
    }
  } else {
    const label = String(base[0]);
    const parameters =
      base.find(value => value && typeof value === 'object' && !Array.isArray(value)) || {};
    const path = label.endsWith(':list:charts')
      ? `/${label.split(':')[0]}/charts`
      : label.startsWith('websites:')
        ? `/websites/${parameters.websiteId}/${label.slice(9).replaceAll(':', '/')}`
        : '';
    if (!isAggregateRequest(path, parameters)) return null;
    resources = aggregateRequestResources(path, parameters);
  }
  resources = uniqueCacheResources(meta.cacheResources?.length ? meta.cacheResources : resources);
  return resources.length ? { resources } : null;
}

export function aggregateRequestResources(
  path: string,
  parameters: Record<string, any> = {},
): CacheResource[] {
  const match = path.match(/^\/(?:liekan\/)?(websites|links|pixels)\/([^/]+)/);
  const type =
    match?.[1] === 'links'
      ? 'link'
      : match?.[1] === 'pixels'
        ? 'pixel'
        : parameters.eventType === 3
          ? 'link'
          : parameters.eventType === 4
            ? 'pixel'
            : 'website';
  if (match && match[2] !== 'summary' && match[2] !== 'charts')
    return uniqueCacheResources([{ type, id: match[2] }]);
  const ids = Array.isArray(parameters.ids)
    ? parameters.ids
    : String(parameters.ids || '').split(',');
  return uniqueCacheResources(
    ids.map(id => ({
      type: match?.[1] === 'links' ? 'link' : match?.[1] === 'pixels' ? 'pixel' : 'website',
      id,
    })),
  );
}

export function statisticsCacheTtl(end: number | Date, timezone = 'UTC', now = Date.now()) {
  const today = +fromZonedTime(
    `${formatInTimeZone(now, timezone, 'yyyy-MM-dd')}T00:00:00`,
    timezone,
  );
  return +end < today ? analyticsCacheLimits.historicalTtl : analyticsCacheLimits.currentTtl;
}

export function isAggregateRequest(path: string, params?: Record<string, any>) {
  if (params?.resource === 'logs') return false;
  if (
    path.endsWith('/analytics') &&
    [
      'realtime',
      'session',
      'sessions',
      'session-properties',
      'events',
      'replays',
      'revenue',
    ].includes(params?.kind)
  )
    return false;
  return (
    /^\/liekan\/websites\/(?:summary$|[^/]+\/(?:page-report|shared-report|crawler-analysis|geo-weight|analytics|goals\/[^/]+\/analytics)$)/.test(
      path,
    ) ||
    /^\/(?:liekan\/)?websites\/[^/]+\/(?:stats|pageviews|metrics(?:\/expanded)?|events\/(?:series|stats)|utm\/metrics|goals\/(?:stats|[^/]+\/(?:stats|savedstats))|funnels\/(?:stats|[^/]+\/(?:stats|savedstats))|retention|journeys|attribution|breakdown|heatmaps(?:\/[^/]+)?|(?:performance|revenue)\/(?:stats|chart|metrics))$/.test(
      path,
    ) ||
    /^\/(?:websites|links|pixels)\/charts$/.test(path) ||
    /^\/liekan\/links\/[^/]+\/sources$/.test(path)
  );
}

export const analyticsCacheLimits = Object.freeze({
  entries: 128,
  bytes: 32 * 1024 * 1024,
  resultBytes: 2 * 1024 * 1024,
  currentTtl: 30000,
  historicalTtl: 300000,
});
export const analyticsPreheatTargets = {
  native: new Set([
    'stats',
    'pageviews',
    'metrics',
    'events/stats',
    'events/series',
    'goals/stats',
    'funnels/stats',
    'retention',
    'journeys',
    'breakdown',
    'attribution',
    'heatmap',
    'heatmaps',
    'performance/stats',
    'performance/chart',
    'performance/metrics',
    'revenue/stats',
    'revenue/chart',
    'revenue/metrics',
    'utm/metrics',
  ]),
  feature: new Set(['page-report', 'shared-report', 'analytics', 'journeys']),
};

export function statisticsResourcePolicy(path: string, parameters: Record<string, any> = {}) {
  const aggregate = isAggregateRequest(path, parameters);
  const target = path.replace(/^\/(?:liekan\/)?websites\/[^/]+\//, '');
  const feature = path.startsWith('/liekan/');
  const complex =
    ['filter', 'search', 'cursor'].some(key => Boolean(parameters[key])) ||
    Number(parameters.page || 1) !== 1;
  return {
    aggregate,
    maxResultBytes: analyticsCacheLimits.resultBytes,
    ttl: aggregate ? statisticsCacheTtl(parameters.endAt, parameters.timezone) : 0,
    preheat:
      aggregate &&
      !complex &&
      (feature ? analyticsPreheatTargets.feature : analyticsPreheatTargets.native).has(target),
  };
}

export type PageCacheMode = 'aggregate' | 'configuration' | 'direct';
// Every page's dynamic modules are explicit; adding a page requires a coverage decision.
export const pageCacheModules: Record<string, Record<string, PageCacheMode>> = {};
// AI reads retain their authenticated no-store API and conversation snapshot boundaries.
pageCacheModules['ai-chat'] = { catalog: 'direct', conversations: 'direct', answers: 'direct' };
pageCacheModules['crawlers-manage'] = { catalog: 'direct', drafts: 'direct' };
pageCacheModules['analytics-acceleration'] = { status: 'direct', tasks: 'direct' };
pageCacheModules['admin-analytics-engine'] = { status: 'direct', tasks: 'direct' };
pageCacheModules['history-repair'] = { tasks: 'direct', previews: 'direct', records: 'direct' };
pageCacheModules['ai-config'] = { connections: 'direct', connectionTests: 'direct' };
for (const page of [
  'overview',
  'geo-ai',
  'geo-bots',
  'geo-ai-pages',
  'geo-preference',
  'geo-human',
  'geo-geography',
  'geo-sources',
  'geo-search-engines',
  'geo-keywords',
  'geo-content',
  'geo-conversions',
  'utm',
  'attribution',
  'retention',
  'breakdown',
  'compare',
  'performance',
  'heatmaps',
  'link-detail',
  'pixel-detail',
])
  pageCacheModules[page] = { statistics: 'aggregate' };
for (const page of [
  'onboarding',
  'tracking',
  'website-settings',
  'recorder-settings',
  'account',
  'security',
  'api-keys',
  'preferences',
  'goal-editor',
  'funnel-editor',
  'filters',
  'segment-editor',
  'cohort-editor',
  'annotations',
  'teams',
  'team-detail',
  'team-join',
  'admin-users',
  'admin-user',
  'admin-websites',
  'admin-teams',
  'admin-security',
  'board-editor',
  'board-design',
  'sharing',
  'link-editor',
  'pixel-editor',
])
  pageCacheModules[page] = { configuration: 'configuration' };
for (const page of [
  'install-check',
  'login',
  'login-2fa',
  'sso',
  'two-factor',
  'backup-codes',
  'realtime',
  'geo-logs',
  'event-detail',
  'sessions',
  'session-detail',
  'path-detail',
  'replays',
  'replay-player',
  'exports',
])
  pageCacheModules[page] = { records: 'direct' };
for (const page of [
  'websites',
  'links',
  'pixels',
  'boards',
  'board-view',
  'goals',
  'funnels',
  'segments',
  'cohorts',
])
  pageCacheModules[page] = { configuration: 'configuration', statistics: 'aggregate' };
for (const page of ['events', 'journeys', 'revenue'])
  pageCacheModules[page] = { statistics: 'aggregate', records: 'direct' };
pageCacheModules['share-preview'] = {
  authorization: 'direct',
  layout: 'configuration',
  statistics: 'aggregate',
  records: 'direct',
};
for (const page of ['help', 'access-denied', 'session-expired', 'not-found'])
  pageCacheModules[page] = {};

for (const page of ['security', 'admin-security']) pageCacheModules[page].securityStatus = 'direct';
