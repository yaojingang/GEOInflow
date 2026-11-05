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
import { warehouseGeoWeightAggregate } from './warehouse-geo-weight';

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

it('computes all overview log groups from a single accepted, narrow relation without grouping sets', async () => {
  const spec = await warehouseLogQuerySpec(
    start,
    end,
    'UTC',
    { resource: 'overview', crawlerIdentityScope: 'verified_range', crawlerMetricsVersion: 1 },
    '',
    '',
    false,
    'site',
    true,
  );
  expect(spec.overview).toContain('overview_logs AS MATERIALIZED');
  expect(spec.overview).toContain('enable_materialized_cte=1');
  expect(spec.overview.match(/FROM "warehouse_liekan_log" AS fact/g)).toHaveLength(1);
  for (const key of ['summary', 'bots', 'pages']) {
    expect(spec.overview).toContain(`'${key}' AS section`);
    expect(spec.statements[key]).toContain('FROM overview_logs l');
  }
  expect(spec.overview).toContain("l.user_agent NOT LIKE 'Liekan-Crawler-Check/%'");
  expect(spec.overview).toContain("_record_time < {logEnd:DateTime64(6,'UTC')}");
  expect(spec.overview).not.toContain('GROUPING SETS');
  expect(spec.overview).not.toContain('identity_evidence');
});

it('evaluates GEO classification once before expanding its overlapping windows', async () => {
  mocks.query.mockResolvedValueOnce([{ catalogs: [], verifications: [] }]).mockResolvedValueOnce([]);
  await warehouseGeoWeightAggregate({ query: async () => [], execute: async () => 0 }, 'site', 'fixture.invalid', 'UTC', [
    { asOf: '2026-11-02', startAt: +start, endAt: +end },
    { asOf: '2026-11-01', startAt: +start - 86400000, endAt: +end - 86400000 },
  ]);
  expect(mocks.query).toHaveBeenCalledTimes(2);
  const sql = mocks.query.mock.calls[1][1];
  expect(sql).toContain('evaluated_logs AS MATERIALIZED');
  expect(sql).toContain('FROM evaluated_logs e');
  expect(sql).toContain('GROUP BY memberships,kind,key1,key2');
  expect(sql).toContain('FROM buckets ARRAY JOIN memberships AS asOf');
  expect(sql).toContain('uniqExactIfMerge(units_state)');
  expect(sql).toContain('enable_materialized_cte=1');
  expect(mocks.query.mock.calls[1][2].geoDates).toEqual(['2026-11-02', '2026-11-01']);
});
