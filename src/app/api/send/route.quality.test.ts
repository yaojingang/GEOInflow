import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveEvent: vi.fn(),
  createSession: vi.fn(),
  fetchWebsite: vi.fn(),
  parseToken: vi.fn(),
  write: vi.fn(),
  classify: vi.fn(),
  authenticated: vi.fn(),
  token: vi.fn(),
  warehouse: false,
  enqueue: vi.fn(),
  readReceipt: vi.fn(),
  pgQuery: vi.fn(),
}));
vi.mock('@/lib/liekan/warehouse/runtime', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/liekan/warehouse/runtime')>()),
  warehouseIntakeEnabled: () => mocks.warehouse,
}));
vi.mock('@/lib/liekan/warehouse-v2/runtime', () => ({
  warehouseV2Runtime: () => ({
    ensureReady: async () => {},
    pg: { connect: async () => ({ query: mocks.pgQuery, release: vi.fn() }) },
    ch: { query: async () => ({ json: mocks.readReceipt }) },
    browserBatcher: { enqueue: mocks.enqueue },
  }),
}));
vi.mock('@/lib/liekan/upstream/collection-admission', () => ({
  collectionAdmission: async () => ({ revision: '0', mode: 'standard', allowedHostnames: [] }),
  normalizeCollectionOrigin: () => null,
  conflictsWithCollectionHosts: () => false,
}));
vi.mock('@/lib/liekan/upstream/crawler-registry-context', () => ({
  withPublishedRegistry: (work: () => unknown) => work(),
}));
vi.mock('@/queries/prisma', () => ({
  getLink: async (id: string) => (id === '22222222-2222-4222-8222-222222222222' ? { id } : null),
  getPixel: async (id: string) => (id === '33333333-3333-4333-8333-333333333333' ? { id } : null),
}));
vi.mock('@/lib/clickhouse', () => ({ default: { enabled: false } }));
vi.mock('@/lib/crypto', () => ({
  getSalt: () => 'salt',
  hash: () => 'hash',
  secret: () => 'fixture-secret',
  uuid: () => 'd13978f8-b685-4a57-940c-3a54c1c85879',
}));
vi.mock('@/lib/detect', () => ({
  getClientInfo: async (_request: Request, payload: any) => ({
    ip: payload.ip || '192.0.2.1',
    userAgent: payload.userAgent || 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36',
    browser: 'chrome',
  }),
  hasBlockedIp: () => false,
}));
vi.mock('@/lib/load', () => ({ fetchWebsite: mocks.fetchWebsite }));
vi.mock('@/lib/jwt', () => ({ createToken: mocks.token, parseToken: mocks.parseToken }));
vi.mock('@/lib/request', () => ({
  parseRequest: async (request: Request, schema: any) => {
    const parsed = schema.safeParse(await request.json());
    return parsed.success
      ? { body: parsed.data }
      : { error: () => Response.json({ error: 'invalid' }, { status: 400 }) };
  },
}));
vi.mock('@/queries/sql', () => ({
  saveEvent: mocks.saveEvent,
  createSession: mocks.createSession,
  saveSessionData: vi.fn(),
  saveSessionLink: vi.fn(),
  updateSession: vi.fn(),
}));
vi.mock('@/lib/liekan/upstream/collection-snapshots', () => ({
  collectionSnapshots: async () => ({}),
}));
vi.mock('@/lib/liekan/upstream/collection-quality', () => ({ classifyCollection: mocks.classify }));
vi.mock('@/lib/liekan/upstream/collection-auth', () => ({
  isAuthenticatedCollection: mocks.authenticated,
}));
vi.mock('@/lib/liekan/upstream/collection-write', () => ({
  CollectionConflictError: class extends Error {},
  recordCollectionIdentity: vi.fn(),
  withCollectionWrite: mocks.write,
}));

import { CACHE_TOKEN_TYPE } from '@/lib/constants';
import { POST } from './route';

const website = '89be6d70-22a5-4433-8bfe-f5b9bd4f08f1';
const eventId = 'd614f956-5fda-40c9-a378-0e8a07d93e54';
const call = (payload: any = {}, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://localhost/api/send', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'event',
        payload: { website, url: '/', hostname: 'example.com', ...payload },
      }),
    }),
  );

describe('compatible collection quality intake', () => {
  it('passes browser automation evidence through validation into the quality verdict', async () => {
    const response = await call({ webdriver: true });
    expect(response.status).toBe(200);
    expect(mocks.classify.mock.calls[0][0].payload.webdriver).toBe(true);
  });

  it.each(['true', 1, {}])('rejects malformed automation evidence %j', async webdriver => {
    expect((await call({ webdriver })).status).toBe(400);
    expect(mocks.saveEvent).not.toHaveBeenCalled();
  });

  it('passes original timestamp zero separately from the trusted receipt time', async () => {
    const before = Date.now() / 1000;
    await call({ timestamp: 0 });
    expect(mocks.classify.mock.calls[0][0].payload.timestamp).toBe(0);
    const accepted = +mocks.classify.mock.calls[0][0].receivedAt / 1000;
    expect(accepted).toBeGreaterThanOrEqual(before);
    expect(accepted).toBeLessThanOrEqual(Date.now() / 1000);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWebsite.mockResolvedValue({ id: website });
    mocks.parseToken.mockResolvedValue(null);
    mocks.token.mockReturnValue('fixture-cache');
    mocks.classify.mockReturnValue({
      classification: 'browser',
      source: 'browser',
      reasons: [],
      ruleVersion: 'traffic-quality-v1',
      rangeVersion: null,
      rangeStatus: 'missing',
      hostname: 'example.com',
    });
    mocks.authenticated.mockReturnValue(false);
    mocks.write.mockImplementation(async (_input: any, work: () => Promise<any>) => ({
      status: 'written',
      value: await work(),
    }));
    delete process.env.DISABLE_BOT_CHECK;
    mocks.warehouse = false;
    mocks.enqueue.mockResolvedValue(undefined);
    mocks.readReceipt.mockResolvedValue([]);
    mocks.pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes(' AS active,'))
        return { rows: [{ active: true, epoch: '1', policy_revision: 0 }] };
      if (sql.includes('FOR SHARE')) return { rowCount: 1 };
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock'))
        return { rows: [] };
      throw new Error('unexpected collection statement');
    });
  });
  it('old scripts collect without an ID and preserve the exact Umami response shape', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json()).sort()).toEqual(['cache', 'sessionId', 'visitId']);
    expect(mocks.write.mock.calls[0][0].eventId).toBeUndefined();
    expect(mocks.saveEvent).toHaveBeenCalledTimes(1);
  });
  it('keeps identify on its upstream path without creating an event receipt', async () => {
    const response = await POST(
      new Request('http://localhost/api/send', {
        method: 'POST',
        body: JSON.stringify({
          type: 'identify',
          payload: { website, eventId, id: 'visitor', data: { plan: 'pro' } },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json()).sort()).toEqual(['cache', 'sessionId', 'visitId']);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.write.mock.calls[0][0].eventId).toBeUndefined();
    expect(mocks.saveEvent).not.toHaveBeenCalled();
  });
  it('carries one valid logical event ID and rejects malformed IDs', async () => {
    expect((await call({ eventId })).status).toBe(200);
    expect(mocks.write.mock.calls[0][0].eventId).toBe(eventId);
    expect((await call({ eventId: 'not-a-uuid' })).status).toBe(400);
    expect(mocks.saveEvent).toHaveBeenCalledTimes(1);
  });
  it('returns a compatible acknowledgement for an exact duplicate without another event', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const visitId = '22222222-2222-4222-8222-222222222222';
    mocks.write.mockResolvedValue({ status: 'duplicate', sessionId, visitId });
    mocks.parseToken.mockResolvedValue({
      type: CACHE_TOKEN_TYPE,
      websiteId: website,
      sessionId: 'different-session',
      visitId: 'different-visit',
      sessionLinkId: 'different-identity-link',
    });
    const before = Math.floor(Date.now() / 1000);
    const response = await call({ eventId, timestamp: 1 }, { 'x-umami-cache': 'stale-cache' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cache: 'fixture-cache', sessionId, visitId });
    expect(mocks.token.mock.calls[0][0]).toMatchObject({ websiteId: website, sessionId, visitId });
    expect(mocks.token.mock.calls[0][0].iat).toBeGreaterThanOrEqual(before);
    expect(mocks.token.mock.calls[0][0].sessionLinkId).toBeUndefined();
    expect(mocks.saveEvent).not.toHaveBeenCalled();
  });
  it('retains bot verdict evidence before the read policy excludes its event', async () => {
    mocks.classify.mockReturnValue({
      classification: 'automated',
      source: 'browser',
      hostname: 'example.com',
    });
    expect((await call({ userAgent: 'GPTBot/1.0' })).status).toBe(200);
    expect(mocks.write.mock.calls[0][0].quality.classification).toBe('automated');
    expect(mocks.saveEvent).toHaveBeenCalledTimes(1);
  });
  it('rejects a cache from another website as proof of the requested site', async () => {
    mocks.parseToken.mockResolvedValue({
      type: CACHE_TOKEN_TYPE,
      websiteId: '443b0081-8236-449d-82a8-695aa0477dcd',
      sessionId: 'other-session',
      visitId: 'other-visit',
    });
    mocks.fetchWebsite.mockResolvedValue(null);
    expect((await call({}, { 'x-umami-cache': 'wrong-site-cache' })).status).toBe(400);
    expect(mocks.fetchWebsite).toHaveBeenCalledWith(website);
    expect(mocks.saveEvent).not.toHaveBeenCalled();
  });
  it('keeps legacy producer overrides and records their provenance', async () => {
    await call({ ip: '192.0.2.40', userAgent: 'Producer/1.0' });
    expect(mocks.classify.mock.calls[0][0]).toMatchObject({
      authenticated: false,
      ip: '192.0.2.40',
      userAgent: 'Producer/1.0',
    });
  });
  it('routes the real browser package to the warehouse and preserves the public response', async () => {
    mocks.warehouse = true;
    const response = await call({
      eventId,
      name: 'purchase',
      data: { revenue: 2.12345, currency: 'CNY' },
    });
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json()).sort()).toEqual(['cache', 'sessionId', 'visitId']);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.saveEvent).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    const [rows, writeKey] = mocks.enqueue.mock.calls[0];
    expect(writeKey).toBe(`${website}:${eventId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      client_event_id: eventId,
      website_id: website,
      event_name: 'purchase',
      receipt_hash: expect.any(String),
      classification: 'browser',
      rule_version: 'traffic-quality-v1',
      identity_scope: 'browser_unresolved',
      identity_available: false,
      event_revenue: [[expect.any(String), 'CNY', '2.1235']],
      event_properties: expect.arrayContaining([
        expect.arrayContaining(['revenue']),
        expect.arrayContaining(['currency']),
      ]),
    });
    expect(JSON.stringify(rows)).not.toContain('192.0.2.1');
    expect(JSON.stringify(rows)).not.toContain('Mozilla/5.0');
  });
  it('returns a retryable unknown result when v2 cannot confirm the write', async () => {
    mocks.warehouse = true;
    mocks.enqueue.mockRejectedValue(new Error('isolated transport outage'));
    const response = await call({ eventId });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect(mocks.pgQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('redacts direct-submitted URL and referrer secrets before writing the v2 row', async () => {
    mocks.warehouse = true;
    const response = await call({
      eventId,
      url: '/landing?token=private-token&utm_source=newsletter#access_token=private-fragment',
      referrer: 'https://referrer.test/from?email=visitor%40example.com&utm_medium=email',
    });
    expect(response.status).toBe(200);
    const serialized = JSON.stringify(mocks.enqueue.mock.calls[0][0]);
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('private-fragment');
    expect(serialized).not.toContain('visitor%40example.com');
    expect(serialized).not.toContain('visitor@example.com');
    expect(serialized).toContain('utm_source=newsletter');
    expect(serialized).toContain('utm_medium=email');
    expect(mocks.saveEvent).not.toHaveBeenCalled();
  });
  it('keeps the original session/visit response for warehouse duplicates and 409 for conflicts', async () => {
    mocks.warehouse = true;
    const payload = { eventId, url: '/original' };
    expect((await call(payload)).status).toBe(200);
    const [[stored]] = mocks.enqueue.mock.calls[0];
    mocks.readReceipt.mockResolvedValue([{ ...stored, session_id: website, visit_id: eventId }]);
    expect(await (await call(payload)).json()).toEqual({
      cache: 'fixture-cache',
      sessionId: website,
      visitId: eventId,
    });
    expect((await call({ ...payload, url: '/different' })).status).toBe(409);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });
});
