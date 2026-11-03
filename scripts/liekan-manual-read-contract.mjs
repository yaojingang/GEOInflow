import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

export function livePageReadAllowed(read, now = Date.now()) {
  if (read.path === '/api/liekan/admin/analytics-engine') return true;
  if (/^\/api\/(?:realtime\/[^/]+|websites\/[^/]+\/active)$/.test(read.path)) return true;
  if (/^\/api\/liekan\/websites\/[^/]+\/analytics$/.test(read.path) && read.kind === 'realtime') return true;
  if (/^\/api\/liekan\/websites\/[^/]+\/analytics-jobs\/[^/]+(?:\/result)?$/.test(read.path)) return true;
  const report = /^\/api\/liekan\/websites\/[^/]+\/page-report$/.test(read.path);
  if (report && ['overview', 'conversions'].includes(read.resource)) return true;
  if ((report && ['logs', 'human/keywords'].includes(read.resource)) ||
    (!report && !/^\/api\/websites\/[^/]+\/(?:stats|pageviews|metrics)$/.test(read.path))) return false;
  try {
    const timezone = read.timezone || 'UTC';
    const today = +fromZonedTime(`${formatInTimeZone(now, timezone, 'yyyy-MM-dd')}T00:00:00`, timezone);
    return Number(read.startAt) <= now && (Number(read.endAt) > today || (read.crawlerMetricsVersion !== '1' && Number(read.endAt) === today));
  } catch { return false; }
}

export function manualReadKind(method, path) {
  if (method !== 'GET' || !path.startsWith('/api/')) return 'ignored';
  // Public licensing links reload when a share authorization boundary remounts.
  if (path === '/api/liekan/geography/attribution') return 'metadata';
  if (
    [
      '/api/auth/verify',
      '/api/2fa/status',
      '/api/auth/subscription',
      '/api/liekan/history-repair',
    ].includes(path) ||
    /^\/api\/admin\/users\/[^/]+\/2fa$/.test(path) ||
    /^\/api\/share\/[^/]+$/.test(path)
  ) return 'ignored';
  return 'ordinary';
}

export function manualReadInventory() {
  const contract = JSON.parse(readFileSync('src/lib/liekan/contracts/feature-pages.json', 'utf8'));
  const visit = directory =>
    readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? visit(join(directory, entry.name)) : [join(directory, entry.name)],
    );
  const files = visit('src/app')
    .filter(file => file.endsWith('/page.tsx'))
    .sort();
  const geo = files
    .filter(file => file.includes('/geo/'))
    .map(file => ({
      source: file,
      route: file.replace('src/app/(main)', '').replace('/page.tsx', ''),
    }));
  const special = {
    'src/app/(main)/liekan/[[...path]]/page.tsx': '功能入口及帮助中心由功能清单逐项覆盖',
    'src/app/(main)/dashboard/page.tsx': '历史入口跳转网站管理',
    'src/app/(main)/dashboard/edit/page.tsx': '历史入口跳转网站管理',
  };
  for (const file of files)
    assert(
      contract.routes.some(route => route.source === file) ||
        geo.some(route => route.source === file) ||
        special[file],
      `Unclassified page: ${file}`,
    );
  return { features: contract.pages, routes: contract.routes, files, geo, special };
}

export function assertManualReadPolicy(readSource = path => readFileSync(path, 'utf8')) {
  const inventory = manualReadInventory();
  const source = readSource('src/lib/liekan/upstream/manual-client.tsx');
  for (const option of ['refetchOnWindowFocus', 'refetchOnReconnect', 'refetchInterval', 'retry'])
    assert(source.includes(`${option}: false`), `Ordinary read option missing: ${option}`);
  assert(source.includes('staleTime: Infinity') && source.includes("networkMode: 'always'"));
  for (const file of ['AiChatPage', 'AiConfigPage', 'AiShared', 'FeatureApp'])
    assert(
      readSource(`src/components/liekan/features/${file}.tsx`).includes('contracts/manual-refresh'),
      `Ordinary direct query bypass: ${file}`,
    );
  for (const file of ['useRealtimeQuery.ts', '../../metrics/ActiveUsers.tsx']) {
    const path = file.startsWith('..')
      ? 'src/components/metrics/ActiveUsers.tsx'
      : `src/components/hooks/queries/${file}`;
    assert(
      readSource(path).includes('refetchInterval: false'),
      `Realtime polling returned: ${path}`,
    );
  }
  const navigation = readSource('src/components/liekan/Navigation.tsx');
  assert(!navigation.includes('prefetchQuery('), 'Navigation statistics prefetch returned');
  return inventory;
}

// Resolve canonical route ownership from the same feature inventory used by the product.
export function manualRouteFeature(route, features) {
  if (route.route === '/boards/create') return 'boards';
  const source = readFileSync(route.source, 'utf8');
  const geoResource = /resource="([^"]+)"/.exec(source)?.[1];
  if (geoResource) return `geo:${geoResource}`;
  const feature = features.find(item => item.route === route.route);
  if (feature) return feature.id;
  return route.target === 'reference/index.html'
    ? 'geo:overview'
    : route.target.replace('.html', '');
}

// Positive entry evidence must include the page's own data, independently of navigation metadata.
export function manualPageReads(id, values) {
  const W = `/api/websites/${values.websiteId}`;
  const LW = `/api/liekan/websites/${values.websiteId}`;
  const endpoint = (path, fields = {}) => ({ path, ...fields });
  const native = suffix => endpoint(`${W}/${suffix}`);
  const analytics = kind => endpoint(`${LW}/analytics`, { kind });
  const excluded = {
    login: '登录提交读取身份，无普通页面数据',
    'login-2fa': '部分身份验证表单，无普通页面数据',
    sso: '单点身份入口，无普通页面数据',
    'backup-codes': '本地一次性恢复码，只在明确生成时读取',
    'two-factor': '身份设置表单，读取验证状态；提交与安全重试沿用表单操作',
    preferences: '本地偏好表单',
    filters: '条件编辑表单，预览由用户发起',
    'goal-editor': '创建目标表单，尚无目标标识',
    'funnel-editor': '创建漏斗表单，尚无漏斗标识',
    'segment-editor': '创建分群表单，尚无分群标识',
    'cohort-editor': '创建人群表单，尚无人群标识',
    'team-join': '加入团队表单，提交由用户发起',
    attribution: '尚未选择转化条件，统计等待明确输入',
    exports: '导出由用户发起',
    'access-denied': '权限状态入口',
    'session-expired': '身份到期状态入口',
    'not-found': '资源不存在状态入口',
  };
  if (
    ['goal-editor', 'funnel-editor', 'segment-editor', 'cohort-editor'].includes(id) &&
    values.id
  ) {
    const resource =
      id === 'goal-editor' ? 'goals' : id === 'funnel-editor' ? 'funnels' : 'segments';
    return { endpoints: [native(`${resource}/${values.id}`)], exception: null };
  }
  if (excluded[id]) return { endpoints: [], exception: excluded[id] };
  if (id === 'help')
    return {
      endpoints: [endpoint('/api/liekan/crawler-registry')],
      exception: '帮助文档和参考目录在进入时读取，界面没有统计刷新按钮',
      entryOnly: true,
    };
  const map = {
    'crawlers-manage': values.admin
      ? [
          endpoint('/api/liekan/admin/crawler-registry'),
          endpoint('/api/liekan/admin/crawler-sources'),
        ]
      : [endpoint('/api/liekan/crawler-registry')],
    'history-repair': [endpoint('/api/liekan/history-repair')],
    'analytics-acceleration': [endpoint('/api/liekan/analytics-acceleration')],
    websites: [endpoint('/api/me/websites'), endpoint('/api/liekan/websites/summary')],
    dashboard: [endpoint('/api/liekan/websites/summary')],
    'dashboard-edit': [endpoint('/api/liekan/websites/summary')],
    onboarding: [endpoint('/api/me/teams')],
    tracking: [endpoint(W), endpoint(`${LW}/installation`)],
    'install-check': [endpoint(W), endpoint(`${LW}/installation`)],
    'website-settings': [endpoint(W), endpoint(`${LW}/installation`)],
    'recorder-settings': [endpoint(W)],
    account: [endpoint('/api/me/teams'), endpoint('/api/me')],
    security: [endpoint('/api/2fa/status')],
    'api-keys': [endpoint('/api/me/api-keys')],
    goals: [
      native('goals'),
      ...(values.goalId ? [endpoint(`${LW}/goals/${values.goalId}/analytics`)] : []),
    ],
    funnels: [
      native('funnels'),
      ...(values.funnelId ? [native(`funnels/${values.funnelId}/stats`)] : []),
    ],
    realtime: [analytics('realtime'), endpoint(`/api/realtime/${values.websiteId}`)],
    events: [analytics('events'), native('events/series')],
    'event-detail': [
      endpoint(`${LW}/analytics`, {
        kind: 'events',
        ...(values.eventName ? { eventName: values.eventName } : {}),
      }),
    ],
    sessions: [analytics('sessions')],
    'session-detail': [
      endpoint(`${LW}/analytics`, { kind: 'session', sessionId: values.id }),
      native(`sessions/${values.id}`),
      native(`sessions/${values.id}/properties`),
      native(`sessions/${values.id}/replays`),
    ],
    segments: [endpoint(`${W}/segments`, { type: 'segment' }), native('stats')],
    cohorts: [endpoint(`${W}/segments`, { type: 'cohort' }), native('stats')],
    retention: [native('retention')],
    journeys: [endpoint(`${LW}/journeys`)],
    'path-detail': [endpoint(`${LW}/journeys/details`)],
    utm: [analytics('utm')],
    breakdown: [native('breakdown')],
    compare: [native('stats'), native('pageviews'), analytics('sources')],
    annotations: [native('annotations'), native('pageviews')],
    teams: [endpoint('/api/teams')],
    'team-detail': [endpoint(`/api/teams/${values.id}`), endpoint(`/api/teams/${values.id}/users`)],
    'admin-users': [endpoint('/api/admin/users')],
    'admin-analytics-engine': [endpoint('/api/liekan/admin/analytics-engine')],
    'admin-user': [
      endpoint(`/api/users/${values.id}`),
      endpoint(`/api/users/${values.id}/websites`),
      endpoint(`/api/users/${values.id}/teams`),
    ],
    'admin-websites': [endpoint('/api/admin/websites')],
    'admin-teams': [endpoint('/api/admin/teams')],
    'admin-security': [endpoint('/api/2fa/status')],
    boards: [endpoint('/api/boards')],
    'board-editor': [
      ...(values.id ? [endpoint(`/api/boards/${values.id}`)] : []),
      endpoint('/api/links'),
      endpoint('/api/pixels'),
      endpoint('/api/boards'),
    ],
    'board-design': [endpoint(`/api/boards/${values.id}`), native('pageviews')],
    'board-view': [endpoint(`/api/boards/${values.id}`), native('pageviews')],
    sharing: [native('shares')],
    'share-preview': [endpoint(`/api/share/id/${values.id}`), endpoint(`${LW}/shared-report`)],
    performance: [
      analytics('performance'),
      native('performance/stats'),
      native('performance/chart'),
      endpoint(`${W}/performance/metrics`, { type: 'path' }),
    ],
    revenue: [analytics('revenue'), native('revenue/stats'), native('revenue/chart')],
    heatmaps: [native('heatmaps'), native('recorder')],
    replays: [analytics('replays')],
    'replay-player': [native(`replays/${values.id}`)],
    links: [endpoint('/api/links')],
    'link-editor': [
      endpoint('/api/config'),
      ...(values.id ? [endpoint(`/api/links/${values.id}`)] : []),
    ],
    'link-detail': [
      endpoint(`/api/links/${values.id}`),
      endpoint('/api/config'),
      endpoint(`/api/websites/${values.id}/stats`),
      endpoint(`/api/websites/${values.id}/pageviews`),
      endpoint(`/api/liekan/links/${values.id}/sources`),
    ],
    pixels: [endpoint('/api/pixels')],
    'pixel-editor': [
      endpoint('/api/config'),
      ...(values.id ? [endpoint(`/api/pixels/${values.id}`)] : []),
    ],
    'pixel-detail': [
      endpoint(`/api/pixels/${values.id}`),
      endpoint('/api/config'),
      endpoint(`/api/websites/${values.id}/stats`),
      endpoint(`/api/websites/${values.id}/pageviews`),
    ],
    'ai-chat': [endpoint('/api/liekan/ai/catalog')],
    'ai-config': [endpoint('/api/liekan/ai/catalog'), endpoint('/api/liekan/ai/connections')],
    'public-share': [endpoint(`${LW}/shared-report`)],
    'legacy-public-share': [native('stats')],
  };
  if (id.startsWith('geo:'))
    return { endpoints: [endpoint(`${LW}/page-report`, { resource: id.slice(4) })] };
  assert(map[id], `Unclassified positive read: ${id}`);
  return { endpoints: map[id], exception: null };
}

export function assertManualPageReads(policy, evidence, label) {
  assert(policy.endpoints.length || policy.exception, `${label}: missing read classification`);
  for (const expected of policy.endpoints) {
    assert(
      evidence.some(read => Object.entries(expected).every(([key, value]) => read[key] === value)),
      `${label}: missing successful page read ${JSON.stringify(expected)}`,
    );
  }
}
