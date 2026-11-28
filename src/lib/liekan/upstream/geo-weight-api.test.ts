// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
  recalculate: vi.fn(),
  export: vi.fn(),
  access: vi.fn(),
  query: vi.fn(),
  body: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ checkAuth: h.auth }));
vi.mock('@/lib/db', () => ({ isRelationalOnly: () => true }));
vi.mock('./ai-access', () => ({ authorizeAiWebsite: h.access }));
vi.mock('./ai-db', () => ({
  aiTransaction: (work: any) => work({ query: h.query, execute: vi.fn() }),
}));
vi.mock('./geo-weight-snapshots', () => ({
  readGeoWeightSnapshot: h.read,
  recalculateGeoWeight: h.recalculate,
  readLegacyGeoWeight: h.read,
  readGeoWeightForExport: h.export,
}));
vi.mock('@/lib/liekan/http', () => ({
  readBody: (request: Request) => request.json(),
  requestApi: async (_request: any, work: any) => {
    try {
      return Response.json(await work());
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: error.status || 500 });
    }
  },
}));
import { GET } from '@/app/api/liekan/websites/[websiteId]/geo-weight/snapshot/route';
import { POST } from '@/app/api/liekan/websites/[websiteId]/geo-weight/recalculate/route';
import { POST as EXPORT } from '@/app/api/liekan/websites/[websiteId]/geo-weight/export/route';
import { LiekanError } from './errors';
import {
  geoWeightExportSchema,
  geoWeightSnapshotQuerySchema,
  geoWeightRecalculateSchema,
} from '../contracts/geo-weight';
const actor = { id: randomUUID(), role: 'admin' },
  site = randomUUID(),
  snapshotId = randomUUID();
const base = `https://liekan.test/api/liekan/websites/${site}/geo-weight`;
const context = { params: Promise.resolve({ websiteId: site }) };
const envelope = () => ({
  format: 'geo-snapshot-v1',
  taskId: randomUUID(),
  taskStatus: 'ready',
  result: {
    readCatalogVersion: randomUUID(),
    timezone: 'UTC',
    calculatedAt: new Date().toISOString(),
    current: { state: 'missing', level: null },
  },
  snapshotId,
  requestedAsOf: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
  servedAsOf: '2026-10-20',
  stale: false,
  nextRetryAt: null,
  errorCode: null,
  canRecalculate: true,
  strongVersion: 'strong',
});
const get = (params = {}, headers = {}) =>
  GET(
    new Request(base + '/snapshot?' + new URLSearchParams({ timezone: 'UTC', ...params }), {
      headers,
    }),
    context,
  );
const post = (body: any, headers = {}) =>
  POST(
    new Request(base + '/recalculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    context,
  );
const exp = (body: any, headers = {}) =>
  EXPORT(
    new Request(base + '/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    context,
  );
beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ authType: 'session', user: actor });
  h.read.mockResolvedValue(envelope());
  h.recalculate.mockResolvedValue({ ...envelope(), taskStatus: 'queued' });
  h.access.mockResolvedValue({ canUse: true });
  h.query.mockResolvedValue([]);
  h.export.mockResolvedValue(null);
});
describe('private durable GEO snapshot API', () => {
  it.each(['partial', 'api-key', 'share', undefined])(
    'rejects %s authentication before reading private snapshots',
    async authType => {
      h.auth.mockResolvedValue({ authType, user: actor });
      expect((await get()).status).toBe(401);
      expect((await post({})).status).toBe(401);
      expect((await exp({})).status).toBe(401);
      expect(h.read).not.toHaveBeenCalled();
      expect(h.recalculate).not.toHaveBeenCalled();
    },
  );
  it('rejects share context and revoked sessions without exposing result fields', async () => {
    h.auth.mockResolvedValueOnce({ authType: 'session', user: actor, shareToken: {} });
    expect((await get()).status).toBe(401);
    h.auth.mockResolvedValueOnce({ authType: 'session', user: actor }).mockResolvedValueOnce(null);
    const response = await get();
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty('result');
  });
  it('delegates current and exact historical reads without current-catalog middleware overriding archived metadata', async () => {
    const response = await get(
      { mode: 'historical', asOf: '2026-10-20', snapshotId, refresh: '1' },
      { 'X-Liekan-Catalog-Version': randomUUID() },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-liekan-catalog-version')).toBe(
      (await response.clone().json()).result.readCatalogVersion,
    );
    expect(h.read).toHaveBeenCalledWith(
      actor,
      site,
      { mode: 'historical', asOf: '2026-10-20', timezone: 'UTC', snapshotId },
      { signal: expect.any(AbortSignal), fresh: true },
    );
  });
  it('returns server-clock freshness through the next local day for saved results', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    const serverTime = Number(response.headers.get('X-Liekan-Server-Time'));
    const generatedAt = Number(response.headers.get('X-Liekan-Generated-At'));
    const expiresAt = Number(response.headers.get('X-Liekan-Expires-At'));
    expect(serverTime).toBeGreaterThan(0);
    expect(generatedAt).toBeGreaterThan(0);
    expect(expiresAt).toBe(
      new Date(new Date(serverTime).toISOString().slice(0, 10) + 'T00:00:00Z').getTime() + 86400000,
    );
    h.read.mockResolvedValueOnce({
      ...envelope(),
      result: null,
      snapshotId: null,
      taskStatus: 'queued',
    });
    const pending = await get();
    expect(pending.headers.get('X-Liekan-Generated-At')).toBeNull();
    expect(pending.headers.get('X-Liekan-Expires-At')).toBeNull();
  });
  it('delegates a pinned current-mode task status read with its original date', async () => {
    const taskId = randomUUID();
    const response = await get({ mode: 'current', asOf: '2026-10-20', taskId });
    expect(response.status).toBe(200);
    expect(h.read).toHaveBeenCalledWith(
      actor,
      site,
      { mode: 'current', asOf: '2026-10-20', timezone: 'UTC', taskId },
      { signal: expect.any(AbortSignal), fresh: false },
    );
    expect(
      geoWeightSnapshotQuerySchema.safeParse({ timezone: 'UTC', taskId, snapshotId }).success,
    ).toBe(false);
  });
  it('accepts a durable explicit recalculation and enforces request origin', async () => {
    const body = { mode: 'current', timezone: 'UTC', requestId: randomUUID() };
    expect((await post(body)).status).toBe(202);
    expect(h.recalculate).toHaveBeenCalledWith(actor, site, body);
    expect((await post(body, { Origin: 'https://other.test' })).status).toBe(403);
  });
  it('returns readable bounded retry information for cooldown, queue failure and storage capacity', async () => {
    h.recalculate.mockRejectedValueOnce(new LiekanError('GEO 权重重算间隔为 5 分钟', 429));
    let response = await post({});
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('300');
    h.read.mockRejectedValueOnce(new LiekanError('GEO 后台队列未就绪，请稍后重新读取', 503));
    response = await get();
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    h.read.mockResolvedValueOnce({ ...envelope(), taskStatus: 'capacity_blocked' });
    expect((await get()).status).toBe(200);
    h.recalculate.mockResolvedValueOnce({ ...envelope(), taskStatus: 'capacity_blocked' });
    response = await post({});
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe('geo-capacity');
  });
  it('distinguishes evicted snapshots and strong-boundary conflicts', async () => {
    h.read.mockRejectedValueOnce(new LiekanError('gone', 410));
    expect((await get({ snapshotId })).status).toBe(410);
    h.read.mockRejectedValueOnce(new LiekanError('changed', 409));
    expect((await get({ snapshotId })).status).toBe(409);
  });
  it('rejects invalid input shapes at the shared schema boundary', () => {
    expect(
      geoWeightSnapshotQuerySchema.safeParse({ mode: 'historical', timezone: 'UTC' }).success,
    ).toBe(false);
    expect(
      geoWeightRecalculateSchema.safeParse({ mode: 'current', timezone: 'UTC', requestId: 'bad' })
        .success,
    ).toBe(false);
    expect(geoWeightExportSchema.safeParse({ snapshotId, locale: 'en-US' }).success).toBe(true);
    expect(
      geoWeightExportSchema.safeParse({ snapshotId, locale: 'en-US', timezone: 'UTC' }).success,
    ).toBe(false);
  });
});
