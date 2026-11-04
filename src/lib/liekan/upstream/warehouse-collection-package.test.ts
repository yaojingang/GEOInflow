// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { validateBrowserPackage } from '../warehouse/browser-planner';
import { decimalInput } from '../warehouse/fact-input';
import type { InputEnvelope } from '../warehouse/routing';
import type { CollectionIdentity } from './collection-identity';
import { WarehouseCollectionPackage } from './warehouse-collection-package';

const site = '11111111-1111-1111-1111-111111111111',
  session = '22222222-2222-2222-2222-222222222222',
  visit = '33333333-3333-3333-3333-333333333333';
const received = new Date('2026-11-03T00:12:00Z');
const identity: CollectionIdentity = {
  scope: 'browser_unresolved',
  available: false,
  version: 'cookieless-trusted-input-v3',
  sessionId: session,
  browser: 'chrome',
  os: 'Windows',
  device: 'desktop',
  screen: '1920x1080',
  language: 'zh-CN',
  originHostname: null,
  distinctId: null,
  hostname: 'example.test',
  classification: 'unknown',
};
async function packet(identify = false) {
  const builder = new WarehouseCollectionPackage(
    {
      websiteId: site,
      eventId: identify ? undefined : '44444444-4444-4444-4444-444444444444',
      fingerprint: 'a'.repeat(64),
      identify,
      identity,
      quality: {
        classification: 'unknown',
        source: 'browser',
        reasons: ['missing-input'],
        ruleVersion: 'traffic-quality-v4',
        rangeVersion: null,
        rangeStatus: 'missing',
        hostname: 'example.test',
      },
    },
    received,
  );
  await builder.createSession({
    id: session,
    websiteId: site,
    browser: 'chrome',
    createdAt: received,
  });
  await builder.identity(site, identity);
  return builder;
}
function envelope(p: WarehouseCollectionPackage): InputEnvelope {
  return {
    version: 1,
    routingVersion: 1,
    topicId: '1'.repeat(32),
    inputId: '55555555-5555-5555-5555-555555555555',
    eventId: p.eventId,
    visitId: visit,
    websiteId: site,
    sessionId: session,
    clientEventId: p.input.eventId,
    epoch: '0',
    policyRevision: '0',
    kind: p.input.identify ? 'identify' : 'browser',
    fingerprint: p.input.fingerprint,
    collectionSource: 'browser',
    collectionScope: 'browser_unresolved',
    receivedAt: received.toISOString(),
    data: p.seal(),
  };
}

describe('warehouse real collection package', () => {
  it('preserves event, decimal property, revenue and unknown identity as one validated package', async () => {
    const p = await packet();
    await p.saveEvent({
      websiteId: site,
      sessionId: session,
      visitId: visit,
      eventType: 2,
      eventName: 'purchase',
      urlPath: '/中文',
      hostname: 'example.test',
      eventData: { revenue: 1.23445, currency: 'CNY', nested: { flag: true } },
      createdAt: received,
    });
    const facts = validateBrowserPackage(envelope(p));
    expect(facts.find(f => f.family === 'revenue')?.row.revenue).toBe('1.2345');
    expect(facts.find(f => f.family === 'liekan_event_environment')?.row.identity_available).toBe(
      false,
    );
    expect(facts.filter(f => f.family === 'event_data')).toHaveLength(3);
    const bad = envelope(p);
    bad.data = { ...bad.data, facts: facts.filter(f => f.family !== 'liekan_event_quality') };
    expect(() => validateBrowserPackage(bad)).toThrow('warehouse-browser-package-incomplete');
    const crossed = structuredClone(envelope(p));
    (crossed.data.facts as typeof facts)[0].row.website_id = session;
    expect(() => validateBrowserPackage(crossed)).toThrow('warehouse-browser-identity-mismatch');
  });
  it('identification retains explicit null properties with linked source evidence', async () => {
    const p = await packet(true);
    await p.saveSessionData({
      websiteId: site,
      sessionId: session,
      sessionData: { nullable: null, score: 0 },
      createdAt: received,
    });
    await p.saveSessionLink({
      websiteId: site,
      sessionId: session,
      distinctId: 'user-1',
      createdAt: received,
    });
    await p.updateSession({ websiteId: site, sessionId: session, distinctId: 'user-1' });
    const facts = validateBrowserPackage(envelope(p));
    expect(facts.filter(f => f.family === 'session_data')).toHaveLength(2);
    expect(facts.filter(f => f.family === 'liekan_session_data_source')).toHaveLength(2);
    expect(facts.find(f => f.family === 'session')?.row.distinct_id).toBe('user-1');
    expect(facts.some(f => f.family === 'website_event')).toBe(false);
  });
  it('matches decimal half-away rounding without binary floating-point tie loss', () => {
    expect(decimalInput(1.23445, 4)).toBe('1.2345');
    expect(decimalInput(-1.23445, 4)).toBe('-1.2345');
    expect(decimalInput(1e-7, 4)).toBe('0.0000');
    expect(decimalInput(0.00005, 4)).toBe('0.0001');
    expect(decimalInput('999999999999999.12345', 4)).toBe('999999999999999.1235');
  });
});
