import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withoutQueryCache } from '../../src/lib/liekan/upstream/cache-context';
import { featureAnalytics } from '../../src/lib/liekan/upstream/feature-analytics';
export async function verifyWarehouseRealtime({ site, put }: any) {
  const session = randomUUID();
  await put('session', {
    website_id: site,
    session_id: session,
    created_at: '2026-11-02T19:59:00Z',
    browser: 'Chrome',
  });
  for (const referrer of ['chatgpt.com', 'perplexity.ai', 'news.test', 'chatgpt.com', null]) {
    const id = randomUUID(),
      created = '2026-11-02T20:00:00Z';
    await put('website_event', {
      website_id: site,
      event_id: id,
      session_id: session,
      visit_id: randomUUID(),
      event_type: 1,
      created_at: created,
      url_path: '/realtime-isolated',
      hostname: 'fixture.invalid',
      referrer_domain: referrer,
    });
    await put('liekan_event_quality', {
      website_id: site,
      event_id: id,
      classification: 'browser',
      source: 'browser',
      reasons: [],
      rule_version: 'fixture',
      range_status: 'missing',
      hostname: 'fixture.invalid',
      created_at: created,
    });
    await put('liekan_event_environment', {
      website_id: site,
      event_id: id,
      scope: 'browser',
      identity_version: 'fixture',
      identity_available: true,
      browser: 'Chrome',
      origin_hostname: 'fixture.invalid',
      created_at: created,
    });
  }
  const input = {
    kind: 'realtime',
    startAt: +new Date('2026-11-02T19:59:00Z'),
    endAt: +new Date('2026-11-02T20:04:00Z'),
    timezone: 'UTC',
    page: 1,
  };
  process.env.LIEKAN_ANALYTICS_BACKEND = 'postgresql';
  const expected: any = await withoutQueryCache(() => featureAnalytics(site, input));
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  const actual: any = await withoutQueryCache(() => featureAnalytics(site, input));
  assert.equal(expected.totals.active, 1);
  assert.equal(expected.totals.ai, 1);
  assert.equal(expected.totals.views, 5);
  // The old SELECT DISTINCT has no row order for equal-count sources. Compare
  // every group and count; preserve the descending-count invariant separately.
  const normalized = (v: any) =>
    JSON.parse(
      JSON.stringify({
        ...v,
        sources: [...v.sources].sort(
          (a, b) =>
            b.value - a.value ||
            a.name.localeCompare(b.name) ||
            String(a.sourceLabel).localeCompare(String(b.sourceLabel)),
        ),
      }),
    );
  assert.deepEqual(normalized(actual), normalized(expected));
  assert.equal(actual.sources.length, 4);
  assert.ok(actual.sources.every((r: any) => r.value === 1));
  for (let i = 1; i < actual.sources.length; i++)
    assert.ok(actual.sources[i - 1].value >= actual.sources[i].value);
}
