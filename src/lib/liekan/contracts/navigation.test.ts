import { describe, expect, it } from 'vitest';
import { conditionsToQuery } from './analysis';
import {
  featureHref,
  featureNavigationHref,
  featurePages,
  featureWebsiteSwitchHref,
  matchFeatureRoute,
  safeReturnHref,
} from '@/components/liekan/features/routes';
import {
  activeNavigationPage,
  geoPageFromPath,
  geoPaths,
  globalNavigation,
  navigationFor,
  pageNavigation,
  trackingSourcePage,
  websiteNavigation,
} from './navigation';

const site = '11111111-1111-4111-8111-111111111111';
const team = '22222222-2222-4222-8222-222222222222';
describe('navigation task boundaries', () => {
  it.each([
    ['links', 'links'],
    ['link-editor', 'links'],
    ['link-detail', 'links'],
    ['pixels', 'pixels'],
    ['pixel-editor', 'pixels'],
    ['pixel-detail', 'pixels'],
  ])('keeps the native %s resource under the shared tracking entry', (page, source) => {
    const route = { page };
    expect(navigationFor(route)).toMatchObject({ scope: 'global', section: 'tracking' });
    expect(activeNavigationPage(route)).toBe('links');
    expect(trackingSourcePage(route)).toBe(source);
    expect(featureHref(source)).toBe(`/${source}`);
  });
  it.each([
    ['session-detail', 'sessions'],
    ['replay-player', 'replays'],
    ['path-detail', 'journeys'],
    ['event-detail', 'events'],
    ['goal-editor', 'goals'],
    ['funnel-editor', 'funnels'],
  ])('returns analysis tools opened from %s to the reachable %s list', (detail, list) => {
    for (const tool of ['filters', 'annotations', 'exports']) {
      const href = featureNavigationHref(
        { page: detail, websiteId: site, id: team },
        { date: '7day', drill_country: 'eq.CN' },
        tool,
        { from: detail },
      );
      const url = new URL(href, 'http://liekan.local');
      const route = matchFeatureRoute(url.pathname, Object.fromEntries(url.searchParams));
      expect(route.from).toBe(list);
      expect(navigationFor(route).parent).toBe(list);
      // Previously saved tool addresses can still name a detail that needs a record ID.
      expect(navigationFor({ ...route, from: detail }).parent).toBe(list);
      const backUrl = new URL(
        featureNavigationHref(
          route,
          Object.fromEntries(url.searchParams),
          navigationFor(route).parent,
        ),
        'http://liekan.local',
      );
      expect(
        matchFeatureRoute(backUrl.pathname, Object.fromEntries(backUrl.searchParams)),
      ).toMatchObject({
        page: list,
        websiteId: site,
        id: undefined,
      });
      expect(backUrl.searchParams.get('date')).toBe('7day');
      expect(backUrl.searchParams.get('drill_country')).toBe('eq.CN');
    }
  });
  it('keeps automatic GEO date semantics and an active log window across navigation', () => {
    const query = { date: 'range:1000000000000:1000086400000', dateMode: 'default' };
    const logs = new URL(
      featureNavigationHref({ page: 'overview', websiteId: site }, query, 'geo-logs'),
      'http://liekan.local',
    );
    expect(logs.searchParams.get('dateMode')).toBe('default');
    const switched = new URL(
      featureWebsiteSwitchHref({ page: 'geo-logs', websiteId: site }, team, {
        ...query,
        live: '1',
        cursor: 'old-cursor',
        search: 'old-site',
      }),
      'http://liekan.local',
    );
    expect(switched.searchParams.get('dateMode')).toBe('default');
    expect(switched.searchParams.get('live')).toBe('1');
    expect(switched.searchParams.has('cursor')).toBe(false);
    expect(switched.searchParams.has('search')).toBe(false);
    const history = new URL(
      featureNavigationHref(
        { page: 'overview', websiteId: site },
        { date: query.date },
        'geo-logs',
      ),
      'http://liekan.local',
    );
    expect(history.searchParams.has('dateMode')).toBe(false);
    expect(history.searchParams.has('live')).toBe(false);
  });
  it('keeps the originating website list after a cross-site navigation and rejects external returns', () => {
    const returnTo = '/websites?scope=all&search=%E5%A2%9E%E9%95%BF&page=2';
    const switched = new URL(
      featureWebsiteSwitchHref({ page: 'sessions', websiteId: site }, team, {
        returnTo,
        date: '7day',
        segment: site,
      }),
      'http://liekan.local',
    );
    expect(switched.searchParams.get('returnTo')).toBe(returnTo);
    expect(switched.searchParams.has('segment')).toBe(false);
    const unsafe = new URL(
      featureWebsiteSwitchHref({ page: 'sessions', websiteId: site }, team, {
        returnTo: '//external.test/websites',
        date: '7day',
      }),
      'http://liekan.local',
    );
    expect(unsafe.searchParams.has('returnTo')).toBe(false);
  });
  it('keeps journey settings on both list-return paths and clears the selected sequence', () => {
    const query = {
      date: '7day',
      type: 'events',
      steps: '5',
      startStep: 'register',
      endStep: 'purchase',
      sequence: 'selected-path',
    };
    const url = new URL(
      featureNavigationHref({ page: 'path-detail', websiteId: site }, query, 'journeys'),
      'http://liekan.local',
    );
    for (const key of ['type', 'steps', 'startStep', 'endStep'])
      expect(url.searchParams.get(key)).toBe(query[key]);
    expect(url.searchParams.has('sequence')).toBe(false);
    const explicit = new URL(
      featureNavigationHref(
        { page: 'geo-logs', websiteId: site },
        { date: '7day', dateMode: 'default', live: '1' },
        'sessions',
        { date: 'range:1000:2000:day' },
      ),
      'http://liekan.local',
    );
    expect(explicit.searchParams.get('date')).toBe('range:1000:2000:day');
    expect(explicit.searchParams.has('dateMode')).toBe(false);
    expect(explicit.searchParams.has('live')).toBe(false);
  });
  it('preserves journey conditions through successive analysis tools and clears them across sites', () => {
    const query = {
      date: '7day',
      type: 'events',
      steps: '5',
      startStep: 'register',
      endStep: 'purchase',
      sequence: 'selected-path',
    };
    let route: any = { page: 'path-detail', websiteId: site };
    let current: Record<string, string> = query;
    for (const page of ['filters', 'annotations', 'exports', 'journeys']) {
      const url = new URL(featureNavigationHref(route, current, page), 'http://liekan.local');
      for (const key of ['type', 'steps', 'startStep', 'endStep'])
        expect(url.searchParams.get(key)).toBe(query[key]);
      expect(url.searchParams.has('sequence')).toBe(false);
      current = Object.fromEntries(url.searchParams);
      route = matchFeatureRoute(url.pathname, current);
    }
    const unrelated = new URL(
      featureNavigationHref(route, current, 'sessions'),
      'http://liekan.local',
    );
    expect(unrelated.searchParams.has('steps')).toBe(false);
    const switched = new URL(featureWebsiteSwitchHref(route, team, current), 'http://liekan.local');
    for (const key of ['type', 'steps', 'startStep', 'endStep'])
      expect(switched.searchParams.has(key)).toBe(false);
  });
  it.each(Object.entries(geoPaths))('resolves the complete %s website path', (page, suffix) => {
    for (const prefix of ['', `/teams/${team}`]) {
      const pathname = `${prefix}/websites/${site}/geo${suffix}`;
      expect(geoPageFromPath(pathname)).toBe(page);
      expect(geoPageFromPath(`${pathname}/`)).toBe(page);
    }
  });
  it('restores global resource list state and the admin detail parent', () => {
    for (const [list, detail] of [
      ['links', 'link-detail'],
      ['pixels', 'pixel-editor'],
      ['boards', 'board-view'],
    ]) {
      const href = featureNavigationHref(
        { page: list },
        {
          page: '2',
          search: '研究',
          sort: '名称',
          direction: 'desc',
          date: '30day',
          offset: '-1',
          compare: 'yoy',
        },
        detail,
        { id: site },
      );
      const url = new URL(href, 'http://liekan.local');
      const route = matchFeatureRoute(url.pathname, Object.fromEntries(url.searchParams));
      const back = new URL(
        featureNavigationHref(route, Object.fromEntries(url.searchParams), list),
        'http://liekan.local',
      );
      expect(back.searchParams.get('search')).toBe('研究');
      expect(back.searchParams.get('page')).toBe('2');
      expect(back.searchParams.get('direction')).toBe('desc');
      expect(back.searchParams.get('offset')).toBe('-1');
      expect(back.searchParams.get('compare')).toBe('yoy');
    }
    expect(
      featureNavigationHref({ page: 'team-detail', id: team, context: 'admin' }, {}, 'teams'),
    ).toBe('/admin/teams');
  });
  it('preserves repeated conditions produced by the condition editor across analysis and export', () => {
    const filters = conditionsToQuery(
      [
        { name: 'country', operator: 'eq', value: 'CN' },
        { name: 'country', operator: 'eq', value: 'US' },
        { name: 'event', operator: 'eq', value: 'purchase' },
        { name: 'event', operator: 'eq', value: 'subscribe' },
      ],
      'any',
    );
    for (const page of ['events', 'exports']) {
      const url = new URL(
        featureNavigationHref({ page: 'sessions', websiteId: site }, filters, page),
        'http://liekan.local',
      );
      expect(url.searchParams.get('country1')).toBe('eq.US');
      expect(url.searchParams.get('event1')).toBe('eq.subscribe');
      expect(url.searchParams.get('match')).toBe('any');
    }
  });
  it('assigns every supplemental and GEO page to a scope and an accessible parent', () => {
    expect(featurePages).toHaveLength(73);
    expect(navigationFor({ page: 'admin-analytics-engine' })).toMatchObject({
      scope: 'admin',
    });
    expect(Object.keys(geoPaths)).toHaveLength(13);
    for (const page of [...featurePages.map(page => page.id), ...Object.keys(geoPaths)]) {
      expect(pageNavigation[page], page).toBeDefined();
      const parent = pageNavigation[page].parent;
      if (parent) expect(pageNavigation[parent], page).toBeDefined();
      expect(activeNavigationPage({ page })).toBeTruthy();
    }
    expect(globalNavigation.map(group => group.label)).toEqual([
      '快速发起',
      '数据管理',
      '协作管理',
      '帮助中心',
      'AI配置器',
    ]);
    const globalItems = globalNavigation.flatMap(group => group.children || [group]);
    expect(globalItems.map(item => item.label)).toEqual([
      '快速发起',
      '网站管理',
      '数据看板',
      '追踪管理',
      '爬虫管理',
      '分享管理',
      '团队管理',
      '帮助中心',
      'AI配置器',
    ]);
    expect(globalItems.map(item => item.icon)).toEqual([
      'plus',
      'globe',
      'bars',
      'target',
      'bot',
      'copy',
      'users',
      'book',
      'box',
    ]);
    expect(websiteNavigation.map(group => group.label)).toEqual([
      '流量总览',
      'AI 抓取分析',
      '访客与来源',
      '内容与转化',
      '实时监测',
    ]);
  });
  it('keeps account and global resource URLs free of accidental website association', () => {
    for (const page of [
      'account',
      'security',
      'api-keys',
      'preferences',
      'boards',
      'links',
      'pixels',
      'sharing',
    ]) {
      const href = featureNavigationHref(
        { page: 'sessions', websiteId: site },
        { date: 'range:1:2:day', event: 'eq.purchase' },
        page,
      );
      const url = new URL(href, 'http://liekan.local');
      expect(url.searchParams.has('websiteId'), page).toBe(false);
      expect(url.searchParams.has('event'), page).toBe(false);
    }
  });
  it('binds website sharing explicitly and retains the website settings selection', () => {
    const href = featureNavigationHref({ page: 'overview', websiteId: site }, {}, 'sharing', {
      context: 'website',
    });
    const url = new URL(href, 'http://liekan.local');
    const route = matchFeatureRoute(url.pathname, Object.fromEntries(url.searchParams));
    expect(route).toMatchObject({ page: 'sharing', websiteId: site, context: 'website' });
    expect(navigationFor(route).scope).toBe('website');
    expect(activeNavigationPage(route)).toBe('website-settings');
    expect(matchFeatureRoute('/liekan/sharing', { websiteId: site })).toMatchObject({
      websiteId: undefined,
    });
  });
  it('keeps system resource details in system management and team resources independently scoped', () => {
    const url = new URL(
      featureHref('website-settings', { websiteId: site, context: 'admin', teamId: team }),
      'http://liekan.local',
    );
    const route = matchFeatureRoute(url.pathname, Object.fromEntries(url.searchParams));
    expect(route).toMatchObject({ page: 'website-settings', context: 'admin', teamId: undefined });
    expect(activeNavigationPage(route)).toBe('admin-websites');
    expect(matchFeatureRoute(`/teams/${team}`)).toMatchObject({
      page: 'team-detail',
      id: team,
      teamId: team,
    });
    expect(
      new URL(featureHref('links', { teamId: team }), 'http://liekan.local').searchParams.get(
        'teamId',
      ),
    ).toBe(team);
  });
  it('returns to the original website list while blocking foreign return destinations', () => {
    const listQuery = {
      scope: 'all',
      search: '研究 & AI',
      page: '2',
      sort: '网站',
      direction: 'desc',
    };
    const next = new URL(
      featureNavigationHref({ page: 'websites' }, listQuery, 'overview', { websiteId: site }),
      'http://liekan.local',
    );
    const returnTo = next.searchParams.get('returnTo');
    expect(new URL(returnTo, 'http://liekan.local').searchParams.get('search')).toBe('研究 & AI');
    expect(
      featureNavigationHref({ page: 'geo-human', websiteId: site }, { returnTo }, 'websites'),
    ).toBe(returnTo);
    for (const value of ['//foreign.example', '/login', '/websites/secret', '/\\foreign.example'])
      expect(safeReturnHref(value)).toBe('');
  });
  it('retains supported filters and clearly signals unsupported GEO filter clearing', () => {
    const route = { page: 'sessions', websiteId: site };
    const query = { date: 'range:1:2:day', drill_country: 'eq.CN' };
    const supported = new URL(featureNavigationHref(route, query, 'events'), 'http://liekan.local');
    expect(supported.searchParams.get('drill_country')).toBe('eq.CN');
    const geo = new URL(featureNavigationHref(route, query, 'geo-human'), 'http://liekan.local');
    expect(geo.searchParams.has('drill_country')).toBe(false);
    expect(geo.searchParams.get('clearedFilters')).toBe('1');
    expect(navigationFor({ page: 'exports', from: 'geo-ai-pages' })).toMatchObject({
      section: 'ai',
      parent: 'geo-ai-pages',
    });
  });
});

it('keeps AI pages global and drops inherited website filters', () => {
  for (const page of ['ai-chat', 'ai-config']) {
    expect(navigationFor({ page, websiteId: site, teamId: team })).toMatchObject({
      scope: 'global',
    });
    const href = featureNavigationHref(
      { page: 'geo-ai', websiteId: site },
      { date: '7day', drill_country: 'eq.CN', aiConversation: team },
      page,
    );
    expect(href).toBe(`/liekan/${page}`);
    expect(matchFeatureRoute(href, { websiteId: site, teamId: team, id: site })).toMatchObject({
      page,
      websiteId: undefined,
      teamId: undefined,
      id: undefined,
    });
  }
});
