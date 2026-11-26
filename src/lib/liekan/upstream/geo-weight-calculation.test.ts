// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  access: vi.fn(),
  query: vi.fn(),
  aggregate: vi.fn(),
  quality: vi.fn(),
  cache: vi.fn(),
  catalog: undefined as any,
  revision: '1',
  epoch: 1,
  policyRevision: '1',
  feature: true,
  warehouse: false,
  report: vi.fn(),
}));
vi.mock('../warehouse/runtime', () => ({ warehouseEnabled: () => h.warehouse }));
vi.mock('./warehouse-report-snapshot', () => ({ withinWarehouseReport: h.report }));
vi.mock('@/lib/auth', () => ({ checkAuth: h.auth }));
vi.mock('@/lib/db', () => ({ isRelationalOnly: () => true }));
vi.mock('./ai-access', () => ({ authorizeAiWebsite: h.access }));
vi.mock('./ai-db', () => ({
  aiTransaction: (work: any) => work({ query: h.query, execute: vi.fn() }),
}));
vi.mock('./geo-weight-sql', async importOriginal => ({
  ...(await importOriginal<typeof import('./geo-weight-sql')>()),
  geoWeightAggregate: h.aggregate,
}));
vi.mock('../crawlers/analysis', () => ({ crawlerWindowQuality: h.quality }));
vi.mock('./crawler-registry-context', () => ({
  withPublishedRegistry: (work: any) => work(h.catalog),
}));
vi.mock('./query-cancellation', () => ({
  cancellableEvidence: (_tx: any, _signal: any, work: any) => work(),
}));
vi.mock('./evidence-cache', () => ({ evidenceCache: { read: h.cache } }));
vi.mock('./analytics-budget', () => ({
  analyticsGate: { run: (work: any) => work() },
  AnalyticsUnavailable: class extends Error {
    status = 503;
  },
}));
vi.mock('@/lib/liekan/http', () => ({
  requestApi: async (_request: Request, work: () => any) => {
    try {
      return Response.json(await work());
    } catch (error: any) {
      return Response.json({ error: error.message }, { status: error.status || 500 });
    }
  },
  readBody: (request: Request) => request.json(),
}));
import { getBundledPublishedCatalog } from '../crawlers/catalog-seed';
import { calculateGeoWeight as readGeoWeight, parseGeoWeightQuery } from './geo-weight';
import { geoWeightCsv } from './geo-weight-export';
import { geoWeightResponseSchema } from '../contracts/geo-weight';
import { LiekanError } from './errors';
import { withQueryCacheHeaders } from './cache-context';
const actor = { id: randomUUID(), role: 'admin' },
  site = randomUUID();
const input = { asOf: '2026-10-19', timezone: 'Asia/Shanghai', view: 'detail' };
const url = `https://liekan.test/api/liekan/websites/${site}/geo-weight`;
const context = { params: Promise.resolve({ websiteId: site }) };
beforeEach(() => {
  vi.clearAllMocks();
  h.revision = '1';
  h.epoch = 1;
  h.policyRevision = '1';
  h.feature = true;
  h.warehouse = false;
  h.catalog = getBundledPublishedCatalog();
  h.auth.mockResolvedValue({ authType: 'session', user: actor });
  h.access.mockResolvedValue({ domain: 'www.example.com', role: 'admin', canUse: true });
  h.query.mockImplementation(async (sql: string) => {
    if (sql.includes('ai_crawler_enabled')) return [{ ai_crawler_enabled: h.feature }];
    if (sql.includes('data_revision'))
      return [{ epoch: h.epoch, data_revision: h.revision, policy_revision: h.policyRevision }];
    if (sql.includes('max(recorded_at)')) return [{ latest: null, count: 0 }];
    if (sql.includes('AS valid')) return [{ valid: false }];
    return [];
  });
  h.quality.mockResolvedValue({
    state: 'unknown',
    classificationVersion: 'class-1',
    sourceVersion: 'manual',
  });
  h.aggregate.mockImplementation(async (_tx, _site, _host, _tz, windows) =>
    windows.map(w => ({
      asOf: w.asOf,
      stats: {
        requests: 1,
        accepted: 1,
        firstEvidenceDay: '2026-08-01',
        classificationVersions: ['class-1'],
        sources: ['manual'],
      },
      factors: [{ purpose: 'search', paths: 1, units: 1, days: 1, operators: 0 }],
    })),
  );
  h.cache.mockImplementation((_key, _tags, compute, signal) => compute(signal));
});
describe('GEO background calculator boundaries', () => {
  it('returns all detail points in one aggregate, schema-valid states and a deterministic snapshot', async () => {
    const a = await readGeoWeight(actor, site, input),
      b = await readGeoWeight(actor, site, input);
    expect(a.snapshot).toBe(b.snapshot);
    expect(a.observations).toHaveLength(5);
    expect(h.aggregate.mock.calls[0][4]).toHaveLength(6);
    expect(geoWeightResponseSchema.safeParse(a).success).toBe(true);
    expect(a.current.state).toBe('reference');
    expect(a.comparison.delta).toBeNull();
    await readGeoWeight(actor, site, { ...input, view: 'summary' });
    expect(h.aggregate.mock.lastCall[4]).toHaveLength(1);
  });
  it('cancels aborted reads and protects CSV metadata against row injection', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readGeoWeight(actor, site, input, { fresh: true, signal: controller.signal }),
    ).rejects.toMatchObject({ status: 499 });
    const result = await readGeoWeight(actor, site, input);
    result.hostname = '=HYPERLINK("https://example.org")\r\n@evil';
    const csv = geoWeightCsv(result, 'en-US');
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv).not.toContain('\r\n@evil');
    expect(csv).not.toMatch(/ip_masked|user_agent/);
  });
});

it('bounds the CH report by the same GEO deadline and forwards lease cancellation', async () => {
  h.warehouse = true;
  h.report.mockResolvedValueOnce({ isolated: true });
  const abort = new AbortController(), deadline = Date.now() + 1000;
  await readGeoWeight(actor, site, input, { deadline, signal: abort.signal, fresh: true });
  expect(h.report.mock.calls[0][1]).toEqual({ deadline, signal: abort.signal });
  const started = Date.now();
  h.report.mockResolvedValueOnce({ isolated: true });
  await readGeoWeight(actor, site, input);
  const defaultDeadline = h.report.mock.calls[1][1].deadline;
  expect(defaultDeadline).toBeGreaterThanOrEqual(started + 60000);
  expect(defaultDeadline).toBeLessThanOrEqual(Date.now() + 60000);
});
