import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parseRequest } from '@/lib/request';
import { OPTIONS, POST } from './route';

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
