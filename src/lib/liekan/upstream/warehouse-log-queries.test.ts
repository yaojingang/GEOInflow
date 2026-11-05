// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), read: vi.fn() }));
vi.mock('./logs', () => ({ staticRequestExtensionPattern: '\\.(js|css)$' }));
vi.mock('../warehouse/reader-runtime', () => ({
  warehouseReader: () => ({ db: { read: mocks.read } }),
}));
vi.mock('./warehouse-report-snapshot', () => ({
  withinWarehouseReport: (work: () => unknown) => work(),
  warehouseReportMetadata: async () => ({ boundary: { epoch: '1', deletionRevision: '0' } }),
  warehouseReportQuery: mocks.query,
}));
import { warehouseLogFacts, warehouseLogQuerySpec } from './warehouse-log-queries';

const start = new Date('2026-11-01T00:00:00Z');
const end = new Date('2026-11-02T00:00:00Z');
const summary = {
  requests: '5',
  ai: '2',
  pages: '2',
  abnormal: '1',
  classificationVersions: '2',
  legacyRequests: '1',
  unclassifiedRequests: '3',
};
const bot = {
  name: 'Crawler',
  vendor: 'Fixture',
  type: '搜索',
  botId: null,
  requests: '2',
  aiRequests: '2',
  pages: '2',
  lastVisit: '2026-11-01 12:00:00',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([]);
  mocks.read.mockResolvedValue([]);
});

it('keeps exact aggregates sequential and reads only ranking fields', async () => {
  mocks.query.mockResolvedValueOnce([summary]).mockResolvedValueOnce([bot]);
  const result = await warehouseLogFacts('site', start, end, 'UTC', 1, '', '', '', 'after', [
    'summary',
    'bots',
  ]);
  expect(mocks.query).toHaveBeenCalledTimes(2);
  for (const [, sql] of mocks.query.mock.calls) expect(sql).not.toContain('GROUPING SETS');
  expect(mocks.query.mock.calls[1][1]).not.toContain('identity_evidence');
  expect(result.summary).toEqual(
    Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, Number(value)])),
  );
  expect(result.bots).toEqual([
    { ...bot, requests: 2, aiRequests: 2, pages: 2, lastVisit: new Date('2026-11-01T12:00:00Z') },
  ]);
});

it('reads only the requested aggregate when a caller does not need both', async () => {
  mocks.query.mockResolvedValue([summary]);
  const result = await warehouseLogFacts('site', start, end, 'UTC', 1, '', '', '', 'after', [
    'summary',
  ]);
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(mocks.query.mock.calls[0][1]).not.toContain('GROUPING SETS');
  expect(result.bots).toEqual([]);
});

it('retains product-form filtering and metric boundaries in separate aggregate queries', async () => {
  const spec = await warehouseLogQuerySpec(
    start,
    end,
    'UTC',
    {
      crawlerIdentityScope: 'verified_range',
      crawlerMetricsVersion: 1,
      resource: 'ai/pages',
      botId: 'fixture',
      botProductForm: 'workbench',
    },
    '',
    '',
    false,
    'site',
  );
  expect(spec.statements.bots).toContain('{productForm:Nullable(String)}');
  expect(spec.statements.pages).toContain('{botId:Nullable(String)}');
  for (const sql of [spec.statements.bots, spec.statements.pages]) {
    expect(sql).toContain("_record_time < {logEnd:DateTime64(6,'UTC')}");
    expect(sql).toContain("l.user_agent NOT LIKE 'Liekan-Crawler-Check/%'");
    expect(sql).toContain('verification');
    expect(sql).not.toContain('identity_evidence');
  }
});
