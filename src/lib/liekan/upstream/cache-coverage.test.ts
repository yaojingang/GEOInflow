import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pages from '../contracts/feature-pages.json';
import { pageNavigation } from '../contracts/navigation';
import {
  analyticsPreheatTargets,
  isAggregateRequest,
  pageCacheModules,
  statisticsResourcePolicy,
} from './cache-policy';

it('requires a module strategy for every product, compatibility and public navigation page', () => {
  const all = new Set([...pages.pages.map(page => page.id), ...Object.keys(pageNavigation)]);
  expect([...all].filter(page => !(page in pageCacheModules))).toEqual([]);
  expect(Object.keys(pageCacheModules).filter(page => !all.has(page))).toEqual([]);
  expect(pageCacheModules['share-preview']).toMatchObject({
    authorization: 'direct',
    statistics: 'aggregate',
  });
  expect(pageCacheModules.security.securityStatus).toBe('direct');
  expect(pageCacheModules['admin-security'].securityStatus).toBe('direct');
  expect(pageCacheModules['admin-analytics-engine']).toEqual({ status: 'direct', tasks: 'direct' });
  expect(pageCacheModules.revenue).toMatchObject({ statistics: 'aggregate', records: 'direct' });
  expect(pageCacheModules['ai-chat']).toMatchObject({ conversations: 'direct', answers: 'direct' });
  expect(pageCacheModules['ai-config']).toMatchObject({ connections: 'direct', connectionTests: 'direct' });
});

it('requires a request cache boundary for every native preheat endpoint', () => {
  const targets = new Set(
    [...analyticsPreheatTargets.native].map(target => (target === 'heatmap' ? 'heatmaps' : target)),
  );
  for (const target of targets) {
    const source = readFileSync(
      resolve(`src/app/api/websites/[websiteId]/${target}/route.ts`),
      'utf8',
    );
    expect(source, target).toMatch(/return\s+withQueryCacheHeaders\s*\(/);
  }
});
it('covers aggregate adapters while preserving details and complex preheat exclusions', () => {
  for (const path of [
    '/websites/charts',
    '/links/charts',
    '/pixels/charts',
    '/websites/site/events/stats',
    '/websites/site/attribution',
    '/websites/site/goals/stats',
    '/websites/site/funnels/stats',
    '/websites/site/revenue/stats',
    '/liekan/websites/site/shared-report',
    '/liekan/websites/site/page-report',
  ])
    expect(isAggregateRequest(path)).toBe(true);
  for (const path of [
    '/websites/site/active',
    '/websites/site/sessions/stats',
    '/websites/site/revenue/sessions',
    '/websites/site/replays',
    '/liekan/ai/catalog',
    '/liekan/ai/connections',
    '/liekan/ai/conversations/conversation/messages',
    '/liekan/ai/runs/run',
  ])
    expect(isAggregateRequest(path)).toBe(false);
  expect(isAggregateRequest('/liekan/websites/site/page-report', { resource: 'logs' })).toBe(false);
  expect(statisticsResourcePolicy('/websites/site/stats', { endAt: Date.now() }).preheat).toBe(
    true,
  );
  expect(
    statisticsResourcePolicy('/websites/site/stats', { endAt: Date.now(), filter: 'country=CN' })
      .preheat,
  ).toBe(false);
});
