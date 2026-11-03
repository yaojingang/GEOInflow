import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { parseToken } from '@/lib/jwt';
import { restoreReplayEventFragments } from '@/lib/replay';
import { parseRequest } from '@/lib/request';
import { getWebsite } from '@/queries/prisma';
import { saveRecording } from '@/queries/sql';
import { saveHeatmapEvents } from '@/queries/sql/heatmap/saveHeatmapEvents';
import { OPTIONS, POST } from './route';

vi.mock('isbot', () => ({ isbot: () => false }));

vi.mock('@/lib/detect', () => ({
  getClientInfo: vi.fn(),
  hasBlockedIp: vi.fn(),
}));

vi.mock('@/lib/jwt', () => ({
  parseToken: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

vi.mock('@/queries/prisma', () => ({
  getWebsite: vi.fn(),
}));

vi.mock('@/queries/sql', () => ({
  saveRecording: vi.fn(),
}));

vi.mock('@/queries/sql/heatmap/saveHeatmapEvents', () => ({
  saveHeatmapEvents: vi.fn(),
}));

// These route cases do not execute collection transactions. Keep the error
// boundary local so importing the route cannot select a real database.
vi.mock('@/lib/liekan/upstream/collection-write', () => ({
  CollectionConflictError: class CollectionConflictError extends Error {},
}));

afterEach(() => vi.unstubAllEnvs());
const parseRequestMock = vi.mocked(parseRequest);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseToken).mockResolvedValue({ sessionId: 'session', visitId: 'visit' });
  vi.mocked(getWebsite).mockResolvedValue({
    recorderEnabled: true,
    replayConfig: { replayEnabled: true, heatmapEnabled: true },
  } as any);
  vi.mocked(getClientInfo).mockResolvedValue({
    ip: '203.0.113.1',
    userAgent: 'Mozilla/5.0',
  } as any);
  vi.mocked(hasBlockedIp).mockReturnValue(false);
});

async function collect(type: 'record' | 'heatmap', events: any[]) {
  parseRequestMock.mockResolvedValue({
    body: {
      type,
      payload: {
        website: '11111111-1111-4111-8111-111111111111',
        events,
        timestamp: 1000,
      },
    },
    error: undefined,
  });
  return POST(
    new Request('http://localhost/api/record', {
      method: 'POST',
      headers: { 'x-umami-cache': 'fixture-session' },
    }),
  );
}

test('collector redacts complete replay URL fields before persistence', async () => {
  const events = [
    {
      type: 4,
      timestamp: 1000,
      data: { href: 'https://example.com/reset/meta-secret', width: 1200, height: 800 },
    },
    {
      type: 5,
      timestamp: 1001,
      data: { tag: 'url-change', payload: { url: '/verify/custom-secret' } },
    },
    {
      type: 3,
      timestamp: 1002,
      data: {
        source: 0,
        attributes: [{ id: 42, attributes: { href: '/token/dom-secret', class: 'normal' } }],
      },
    },
  ];
  expect((await collect('record', events)).status).toBe(200);
  const saved = vi.mocked(saveRecording).mock.calls[0][0];
  expect(saved.eventCount).toBe(3);
  expect(saved.events[0].data).toEqual({
    href: 'https://example.com/reset/[redacted]',
    width: 1200,
    height: 800,
  });
  expect(saved.events[1].data.payload.url).toBe('/verify/[redacted]');
  expect(saved.events[2].data.attributes[0]).toEqual({
    id: 42,
    attributes: { href: '/token/[redacted]', class: 'normal' },
  });
  expect(JSON.stringify(saved)).not.toMatch(/meta-secret|custom-secret|dom-secret/);
  expect(events[0].data.href).toContain('meta-secret');
});

test.each([
  ['https://example.com/reset/private-value?token=query-value#fragment', '/reset/[redacted]'],
  ['/s/ffffffff-ffff-ffff-ffff-ffffffffffff', '/s/[redacted]'],
  ['https://example.com/docs?category=safe#chapter', '/docs'],
  ['/orders/12345678901234567890', '/orders/12345678901234567890'],
  ['https://[invalid/token/private-value', '/'],
  ['virtual/path', '/'],
])('collector sanitizes heatmap paths without changing geometry: %s', async (url, urlPath) => {
  expect(
    (await collect('heatmap', [{ type: 'click', url, x: 12, y: 20, timestamp: 1000 }])).status,
  ).toBe(200);
  expect(vi.mocked(saveHeatmapEvents).mock.calls[0][0][0]).toMatchObject({ urlPath, x: 12, y: 20 });
});

test('collector sanitizes a complete legacy fragment group and preserves chunk counts', async () => {
  const original = JSON.stringify({
    type: 4,
    timestamp: 1000,
    data: { href: '/reset/fragment-secret' },
  });
  const fragments = [original.slice(0, 45), original.slice(45)].map((value, index) => ({
    type: 'umami:rrweb-event-fragment',
    timestamp: 1000,
    data: { id: 'group', index, total: 2, value },
  }));
  expect((await collect('record', fragments)).status).toBe(200);
  const saved = vi.mocked(saveRecording).mock.calls[0][0];
  expect(saved.eventCount).toBe(1);
  expect(saved.chunkIndex).toBe(1000);
  expect(saved.events).toHaveLength(2);
  expect(restoreReplayEventFragments(saved.events)).toEqual([
    { type: 4, timestamp: 1000, data: { href: '/reset/[redacted]' } },
  ]);
});

describe('record route CORS', () => {
  test('handles preflight requests', async () => {
    const response = OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('x-umami-cache');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  test('includes CORS headers on post responses', async () => {
    parseRequestMock.mockResolvedValue({
      body: {
        type: 'record',
        payload: {
          website: '11111111-1111-4111-8111-111111111111',
          events: [],
        },
      },
      error: undefined,
    });

    const response = await POST(
      new Request('http://localhost/api/record', {
        method: 'POST',
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

test('warehouse heatmap publication failure returns retryable status with CORS', async () => {
  vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'clickhouse');
  const { parseToken } = await import('@/lib/jwt');
  const { getWebsite } = await import('@/queries/prisma');
  const { getClientInfo, hasBlockedIp } = await import('@/lib/detect');
  const { saveHeatmapEvents } = await import('@/queries/sql/heatmap/saveHeatmapEvents');
  const { WarehouseUnavailable } = await import('@/lib/liekan/warehouse/completion');
  vi.mocked(parseToken).mockResolvedValue({
    sessionId: '22222222-2222-4222-8222-222222222222',
    visitId: '33333333-3333-4333-8333-333333333333',
  } as any);
  vi.mocked(getWebsite).mockResolvedValue({
    recorderEnabled: true,
    replayConfig: { heatmapEnabled: true },
  } as any);
  vi.mocked(getClientInfo).mockResolvedValue({
    ip: null,
    userAgent: 'Mozilla/5.0 Chrome/130.0 Safari/537.36',
  } as any);
  vi.mocked(hasBlockedIp).mockReturnValue(false);
  vi.mocked(saveHeatmapEvents).mockRejectedValue(new WarehouseUnavailable('warehouse-unavailable'));
  parseRequestMock.mockResolvedValue({
    body: {
      type: 'heatmap',
      payload: {
        website: '11111111-1111-4111-8111-111111111111',
        events: [{ type: 'click', url: '/test', x: 1, y: 1 }],
      },
    },
    error: undefined,
  });
  const result = await POST(
    new Request('http://localhost/api/record', {
      method: 'POST',
      headers: { 'x-umami-cache': 'fixture' },
    }),
  );
  expect(result.status).toBe(503);
  expect(result.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(await result.json()).toEqual({ error: 'collection_unavailable' });
});
