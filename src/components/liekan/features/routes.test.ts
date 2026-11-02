import { describe, expect, it } from 'vitest';
import { needsWebsite } from '@/lib/liekan/contracts/navigation';
import {
  featureHref,
  featurePages,
  featureWebsiteSwitchHref,
  featureNavigationHref,
  matchFeatureRoute,
} from './routes';

const uuid = '11111111-1111-4111-8111-111111111111';
describe('approved scene routing', () => {
  it('registers every approved supplemental scene without duplicate IDs', () => {
    expect(featurePages).toHaveLength(73);
    expect(new Set(featurePages.map(p => p.id)).size).toBe(73);
    for (const p of featurePages)
      expect(matchFeatureRoute(`/liekan/${p.id}`, { websiteId: uuid, id: uuid })).toMatchObject(
        ['help', 'crawlers-manage', 'history-repair', 'analytics-acceleration'].includes(p.id)
          ? { page: p.id }
          : {
              page: p.id,
              websiteId: needsWebsite({ page: p.id }) ? uuid : undefined,
              id: ['ai-chat', 'ai-config', 'help'].includes(p.id) ? undefined : uuid,
            },
      );
  });
  it('preserves route opt-out, team context and safe query values', () => {
    expect(matchFeatureRoute('/websites', { legacy: '1' })).toBeNull();
    expect(matchFeatureRoute('/liekan')).toMatchObject({ page: 'websites' });
    expect(matchFeatureRoute(`/teams/${uuid}/websites`)).toMatchObject({
      page: 'websites',
      teamId: uuid,
    });
    const href = featureHref('session-detail', {
      websiteId: uuid,
      id: uuid,
      drill_event: 'eq.a&b',
      date: 'range:0:100:day',
    });
    expect(new URL(href, 'http://localhost').searchParams.get('drill_event')).toBe('eq.a&b');
  });
  it('matches and emits the short numeric site number for website routes', () => {
    expect(featureHref('overview', { websiteId: '101' })).toBe('/websites/101/geo');
    expect(featureHref('geo-geography', { websiteId: '101' })).toBe('/websites/101/geo/human/geo');
    expect(featureHref('session-detail', { websiteId: '101', id: uuid })).toBe(
      `/websites/101/sessions/${uuid}`,
    );
    // GEO 页面是真实 Next 页面，不进 FeatureApp 别名表（UUID 同样返回 null）。
    expect(matchFeatureRoute(`/websites/101/geo/human/geo`)).toBeNull();
    expect(matchFeatureRoute(`/websites/${uuid}/geo/human/geo`)).toBeNull();
    expect(matchFeatureRoute(`/websites/101/sessions/${uuid}`)).toMatchObject({
      page: 'session-detail',
      websiteId: '101',
      id: uuid,
    });
    expect(matchFeatureRoute('/websites/101x')).toBeNull();
  });
  it('keeps non-website placeholders UUID-only and emits the numeric settings alias', () => {
    expect(matchFeatureRoute(`/websites/101/sessions/101`)).toBeNull();
    expect(featureHref('website-settings', { websiteId: '101', context: 'admin' })).toBe(
      '/admin/websites/101',
    );
  });
  it('routes every private scene through an implemented page and preserves the GEO overview', () => {
    for (const page of featurePages.filter(p => !['login', 'login-2fa', 'sso'].includes(p.id))) {
      const url = new URL(featureHref(page.id, { websiteId: uuid, id: uuid }), 'http://localhost');
      expect(
        matchFeatureRoute(url.pathname, Object.fromEntries(url.searchParams)),
        page.id,
      ).toMatchObject({ page: page.id });
    }
    expect(featureHref('annotations', { websiteId: uuid })).toBe(
      `/liekan/annotations?websiteId=${uuid}`,
    );
    expect(featureHref('overview', { websiteId: uuid })).toBe(`/websites/${uuid}/geo`);
  });
  it('keeps unscoped pages free of team scope when opened from a team workspace', () => {
    for (const page of ['teams', 'help']) {
      const url = new URL(featureHref(page, { teamId: uuid }), 'http://localhost');
      expect(url.searchParams.has('teamId')).toBe(false);
      expect(matchFeatureRoute(url.pathname, { teamId: uuid })?.teamId).toBeUndefined();
      expect(matchFeatureRoute(`/liekan/${page}`, { teamId: uuid })?.teamId).toBeUndefined();
    }
    expect(matchFeatureRoute('/boards', { teamId: uuid })?.teamId).toBe(uuid);
  });
  it('clears website-owned records and filters while keeping only the time selection', () => {
    const websiteId = '22222222-2222-4222-8222-222222222222';
    const query = {
      date: 'range:0:100:day',
      unit: 'day',
      offset: '2',
      compare: 'prev',
      segment: uuid,
      cohort: uuid,
      retentionDate: '2026-10-01',
      retentionDay: '1',
      attributionStep: 'purchase',
      attributionModel: 'first-click',
      attributionType: 'event',
      attributionSource: 'old-source',
      event: 'eq.old',
      drill_country: 'eq.CN',
      spf0: '1.eq.plan.old',
    };
    for (const [page, list] of [
      ['session-detail', 'sessions'],
      ['replay-player', 'replays'],
      ['event-detail', 'events'],
      ['path-detail', 'journeys'],
      ['goal-editor', 'goals'],
      ['funnel-editor', 'funnels'],
      ['segment-editor', 'segments'],
      ['cohort-editor', 'cohorts'],
    ]) {
      const url = new URL(
        featureWebsiteSwitchHref({ page, id: uuid, teamId: uuid }, websiteId, query),
        'http://localhost',
      );
      expect(matchFeatureRoute(url.pathname, Object.fromEntries(url.searchParams))).toMatchObject({
        page: list,
        websiteId,
        teamId: undefined,
      });
      expect(Object.fromEntries(url.searchParams)).toEqual({
        date: query.date,
        unit: 'day',
        offset: '2',
        compare: 'prev',
      });
    }
  });
  it('preserves independent link, pixel and board records on a website switch', () => {
    for (const page of [
      'link-editor',
      'link-detail',
      'pixel-editor',
      'pixel-detail',
      'board-editor',
      'board-design',
      'board-view',
    ]) {
      const url = new URL(
        featureWebsiteSwitchHref({ page, id: uuid, teamId: uuid }, uuid, { event: 'eq.old' }),
        'http://localhost',
      );
      expect(matchFeatureRoute(url.pathname, Object.fromEntries(url.searchParams))).toMatchObject({
        page,
        id: uuid,
        teamId: uuid,
      });
      expect(url.searchParams.has('event')).toBe(false);
    }
  });
});

describe('upgrade history repair navigation', () => {
  it('keeps the global repair route independent of the current analytics scope', () => {
    const websiteId = 'eacafcba-1d41-4e5c-9ea5-054f07ac6ded';
    expect(matchFeatureRoute('/settings/data-repair', { websiteId })).toEqual({
      page: 'history-repair',
    });
    expect(
      featureNavigationHref(
        { page: 'spiders', websiteId },
        { event: 'eq.old', date: '30day', teamId: websiteId },
        'history-repair',
        { websiteId, tab: 'history' },
      ),
    ).toBe(`/settings/data-repair?websiteId=${websiteId}&tab=history`);
    expect(featureHref('history-repair', { websiteId: 'invalid', event: 'eq.old' })).toBe(
      '/settings/data-repair',
    );
  });
});
