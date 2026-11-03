import { describe, expect, it } from 'vitest';
import { uuid } from '@/lib/crypto';
import { collectionIdentity } from './collection-identity';
import { classifyCollection, type CollectionQuality } from './collection-quality';

const input = {
  websiteId: '2c2cc355-5c67-4aa8-8705-9ab3acfb1533',
  ip: '192.0.2.1',
  userAgent: 'browser-identity-fixture',
  salt: 'fixed-test-salt',
  ipEvidence: { trusted: true, source: 'trusted_ingress' as const },
  quality: {
    source: 'browser',
    classification: 'browser',
    reasons: [],
    ruleVersion: 'traffic-quality-v4',
    rangeVersion: null,
    rangeStatus: 'missing',
    hostname: 'human.invalid',
  } as CollectionQuality,
};
describe('collection identity qualification', () => {
  it('uses a versioned tuple encoding for a qualified cookieless browser', () => {
    expect(collectionIdentity(input)).toMatchObject({
      available: true,
      scope: 'browser',
      sessionId: uuid(
        'liekan-collection-v4:',
        JSON.stringify(['browser', input.websiteId, input.ip, input.userAgent, input.salt, '']),
      ),
    });
  });
  it.each(['unknown', 'suspected', 'automated'] as const)(
    'withholds a browser identity for classification %s even with trusted network input',
    classification => {
      expect(
        collectionIdentity({ ...input, quality: { ...input.quality, classification } }).available,
      ).toBe(false);
    },
  );
  it.each(['unverified', 'legacy_override', 'missing'] as const)(
    'keeps %s input outside qualified identities',
    source => {
      const identity = collectionIdentity({ ...input, ipEvidence: { source, trusted: false } });
      expect(identity).toMatchObject({ scope: 'browser_unresolved', available: false });
      expect(identity.sessionId).not.toBe(collectionIdentity(input).sessionId);
    },
  );
  it('keeps server and legacy namespaces separate from the browser', () => {
    for (const source of ['authenticated_server', 'legacy_override'] as const) {
      const identity = collectionIdentity({ ...input, quality: { ...input.quality, source } });
      expect(identity).toMatchObject({ scope: source, available: false });
      expect(identity.sessionId).not.toBe(collectionIdentity(input).sessionId);
    }
  });
});

it('keeps distinct trusted IP and UA tuples separate despite identical legacy concatenation', () => {
  const browser =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const identities = [
    ['203.0.113.1', '1' + browser],
    ['203.0.113.11', browser],
  ].map(([ip, userAgent]) => {
    const request = new Request('https://collector.invalid/api/send', {
      headers: { 'user-agent': userAgent },
    });
    const quality = classifyCollection({
      request,
      payload: { url: 'https://human.invalid/' },
      authenticated: false,
      ip,
      userAgent,
      snapshots: {},
    });
    return collectionIdentity({ ...input, ip, userAgent, quality });
  });
  expect(identities.map(identity => identity.classification)).toEqual(['browser', 'browser']);
  expect(identities.every(identity => identity.available)).toBe(true);
  expect(identities[0].sessionId).not.toBe(identities[1].sessionId);
});

it('retains deterministic identities within a version and leaves native UUID encoding unchanged', () => {
  const identity = collectionIdentity(input);
  expect(identity.version).toBe('cookieless-trusted-input-v4');
  expect(identity.sessionId).toBe(collectionIdentity(input).sessionId);
  expect(identity.sessionId).not.toBe(
    uuid(input.websiteId, input.ip, input.userAgent, input.salt, ''),
  );
  expect(uuid('a', 'bc')).toBe(uuid('ab', 'c'));
});
