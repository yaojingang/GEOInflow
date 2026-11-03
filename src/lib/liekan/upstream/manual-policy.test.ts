// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  assertManualReadPolicy,
  manualPageReads,
  manualRouteFeature,
  assertManualPageReads,
} from '../../../../scripts/liekan-manual-read-contract.mjs';

it('accepts the complete classified page inventory and closed ordinary read policy', () => {
  const inventory = assertManualReadPolicy();
  expect(inventory.features).toHaveLength(72);
  expect(inventory.routes).toHaveLength(62);
  expect(inventory.files).toHaveLength(78);
});

it.each(['refetchOnWindowFocus', 'refetchOnReconnect', 'refetchInterval', 'retry'])(
  'rejects a restored automatic option: %s',
  option => {
    const read = (path: string) =>
      readFileSync(path, 'utf8').replace(`${option}: false`, `${option}: true`);
    expect(() => assertManualReadPolicy(read)).toThrow(option);
  },
);

it('rejects a direct AI query bypass and navigation prefetch', () => {
  const read = (path: string) => readFileSync(path, 'utf8');
  expect(() =>
    assertManualReadPolicy(path =>
      path.endsWith('/AiShared.tsx')
        ? read(path).replace('contracts/manual-refresh', 'upstream/raw')
        : read(path),
    ),
  ).toThrow('AiShared');
  expect(() =>
    assertManualReadPolicy(path =>
      path.endsWith('/Navigation.tsx') ? read(path) + '\nprefetchQuery(' : read(path),
    ),
  ).toThrow('prefetch');
});

it('classifies every feature and requires its own successful data endpoint', () => {
  const inventory = assertManualReadPolicy();
  for (const feature of inventory.features) {
    const policy = manualPageReads(feature.id, { websiteId: 'site', id: 'record' });
    expect(() => assertManualPageReads(policy, policy.endpoints, feature.id)).not.toThrow();
    if (policy.endpoints.length)
      expect(() =>
        assertManualPageReads(policy, [{ path: '/api/me/websites' }], feature.id),
      ).toThrow('missing successful page read');
    else expect(policy.exception).toBeTruthy();
  }
  const policy = manualPageReads('sessions', { websiteId: 'site' });
  expect(() =>
    assertManualPageReads(
      policy,
      [{ path: '/api/liekan/websites/site/analytics', kind: 'events' }],
      'sessions',
    ),
  ).toThrow();
});

it.each(['tracking', 'install-check', 'website-settings'])(
  '%s requires original collection presence independently of filtered analytics',
  page => {
    const policy = manualPageReads(page, { websiteId: 'site' });
    const metadata = { path: '/api/websites/site' };
    const presence = { path: '/api/liekan/websites/site/installation' };
    expect(() => assertManualPageReads(policy, [metadata, presence], page)).not.toThrow();
    expect(() =>
      assertManualPageReads(
        policy,
        [metadata, { path: '/api/websites/site/stats' }, { path: '/api/websites/site/daterange' }],
        page,
      ),
    ).toThrow('installation');
    expect(() => assertManualPageReads(policy, [presence], page)).toThrow('/api/websites/site');
  },
);

it('requires the actual catalog and source reads for administrator crawler management', () => {
  const admin = manualPageReads('crawlers-manage', { websiteId: 'site', admin: true });
  expect(admin.endpoints).toEqual([
    { path: '/api/liekan/admin/crawler-registry' },
    { path: '/api/liekan/admin/crawler-sources' },
  ]);
  expect(() =>
    assertManualPageReads(admin, [{ path: '/api/liekan/crawler-registry' }], 'admin catalog'),
  ).toThrow();
  const ordinary = manualPageReads('crawlers-manage', { websiteId: 'site' });
  expect(ordinary.endpoints).toEqual([{ path: '/api/liekan/crawler-registry' }]);
});

it('classifies actual route aliases through the canonical feature inventory', () => {
  const inventory = assertManualReadPolicy();
  for (const route of [...inventory.routes, ...inventory.geo]) {
    if (route.route.includes('[[...path]]') || route.entry === '弹层拦截') continue;
    const id = manualRouteFeature(route, inventory.features);
    expect(
      () => manualPageReads(id, { websiteId: 'site', id: 'record', admin: true }),
      route.source,
    ).not.toThrow();
  }
  const catalog = inventory.routes.find(route => route.route === '/crawlers/manage');
  expect(manualRouteFeature(catalog, inventory.features)).toBe('crawlers-manage');
});

it('keeps positive reference reads for help while honoring its existing entry-only controls', () => {
  const policy = manualPageReads('help', { websiteId: 'site' });
  expect(policy.entryOnly).toBe(true);
  expect(policy.endpoints).toEqual([{ path: '/api/liekan/crawler-registry' }]);
  expect(() => assertManualPageReads(policy, [], 'help')).toThrow('missing successful page read');
});
