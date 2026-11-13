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
import {
  warehouseLogFacts,
  warehouseLogQuerySpec,
  warehouseOverviewLogWindow,
  warehousePlotLogs,
} from './warehouse-log-queries';
import { warehouseGeoWeightAggregate } from './warehouse-geo-weight';
import { decodeWarehouseLogCursor } from './warehouse-log-cursor';
import { factRelation } from '../warehouse/read';

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

it('limits ordered version reads to event-time-bounded logs', () => {
  expect(() =>
    factRelation('liekan_crawler_evidence', {
      orderedLogVersions: true,
      immutableTimeWindow: { start: 'start', end: 'end' },
    }),
  ).toThrow('Invalid warehouse ordered log read');
  expect(() => factRelation('liekan_log', { orderedLogVersions: true })).toThrow(
    'Invalid warehouse ordered log read',
  );
  expect(
    factRelation('liekan_log', {
      orderedLogVersions: true,
      immutableTimeWindow: { start: 'start', end: 'end', hours: 'hours' },
    }),
  ).toContain('SELECT _attempt_id FROM "warehouse_liekan_log"');
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([]);
  mocks.read.mockResolvedValue([]);
});

it('skips the evidence join for an empty log chart window with the exact endpoint rule', async () => {
  expect(
    await warehousePlotLogs('site', start, end, 'UTC', true, {
      crawlerIdentityScope: 'all',
      crawlerMetricsVersion: 1,
    }),
  ).toEqual([]);
  expect(mocks.query).toHaveBeenCalledTimes(1);
  const [, sql] = mocks.query.mock.calls[0];
  expect(sql).toContain('SELECT 1 AS present FROM warehouse_liekan_log');
  expect(sql).toContain('toDate32(_record_time) BETWEEN');
  expect(sql).toContain("_record_time < {logEnd:DateTime64(6,'UTC')}");
  expect(sql).not.toContain('warehouse_liekan_crawler_evidence');
});

it('keeps publication and crawler filtering for a log chart with raw input', async () => {
  const sample = { day: '2026-11-01', bot: 'fixture', type: '搜索', count: 2, aiRequests: 1 };
  mocks.query.mockResolvedValueOnce([{ present: 1 }]).mockResolvedValueOnce([sample]);
  expect(await warehousePlotLogs('site', start, end, 'UTC')).toEqual([sample]);
  expect(mocks.query).toHaveBeenCalledTimes(2);
  expect(mocks.query.mock.calls[0][1]).toContain("_record_time <= {logEnd:DateTime64(6,'UTC')}");
  expect(mocks.query.mock.calls[1][1]).toContain('warehouse_publication');
  expect(mocks.query.mock.calls[1][1]).toContain('GROUP BY day,bot,type');
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

it('streams all overview groups from one accepted relation without retaining raw logs', async () => {
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
  expect(spec.overview).toContain('ARRAY JOIN arrayFilter');
  expect(spec.overview).toContain('GROUP BY section,name,vendor,type,botId,path');
  expect(spec.overview).toContain('countIf(l._present) AS requests');
  expect(spec.overview).toContain('0 AS _present');
  expect(spec.overview).toContain('GROUP BY toDate32(_record_time),_record_key');
  expect(spec.overview).toContain('optimize_aggregation_in_order=1');
  expect(spec.overview).not.toContain('AS MATERIALIZED');
  expect(spec.overview.match(/FROM "warehouse_liekan_log" AS fact/g)).toHaveLength(1);
  expect(spec.overview).toContain('SELECT _attempt_id FROM "warehouse_liekan_log"');
  expect(spec.overview).toContain('SELECT attempt_id, argMax(candidate_id, publication)');
  for (const key of ['summary', 'bots', 'pages']) {
    expect(spec.overview).toContain(`'${key}'`);
    expect(spec.statements[key]).toContain('FROM "warehouse_liekan_log" AS fact');
  }
  expect(spec.overview).toContain("l.user_agent NOT LIKE 'Liekan-Crawler-Check/%'");
  expect(spec.overview).toContain("_record_time < {logEnd:DateTime64(6,'UTC')}");
  expect(spec.overview).not.toContain('GROUPING SETS');
  expect(spec.overview).not.toContain('identity_evidence');
});

it('bounds the short-window evidence key set and uses the log timestamps', async () => {
  const to = new Date(+start + 3600000);
  mocks.query
    .mockResolvedValueOnce([{ count: '100001' }])
    .mockResolvedValueOnce([{ count: '100000' }]);
  await expect(warehouseOverviewLogWindow('site', start, to, true)).resolves.toEqual({
    hasFacts: true,
    restrictEvidenceToWindow: false,
  });
  await expect(warehouseOverviewLogWindow('site', start, to, true)).resolves.toEqual({
    hasFacts: true,
    restrictEvidenceToWindow: true,
  });
  expect(mocks.query.mock.calls[0][1]).toContain('LIMIT 100001');
  const spec = await warehouseLogQuerySpec(
    start,
    to,
    'UTC',
    { resource: 'overview', crawlerIdentityScope: 'all', crawlerMetricsVersion: 1 },
    '',
    '',
    false,
    'site',
    true,
    true,
  );
  const keySet = spec.overview.slice(spec.overview.indexOf('AND "log_id" IN'));
  expect(spec.overview).not.toContain('SELECT _attempt_id FROM "warehouse_liekan_log"');
  expect(spec.overview).toContain(
    `AND "run_id"={wh_repair_run:UUID} AND "generation"={wh_repair_generation:UUID} AND "kind"='log'`,
  );
  expect(keySet).toContain('SELECT id FROM warehouse_liekan_log');
  expect(keySet).toContain("_record_time < {logEnd:DateTime64(6,'UTC')}");
  expect(keySet).toContain("family = 'liekan_log' AND publication <= {wh_publication:UInt64}");
});

it('evaluates GEO classification once before expanding its overlapping windows', async () => {
  mocks.query
    .mockResolvedValueOnce([{ catalogs: [], verifications: [] }])
    .mockResolvedValueOnce([]);
  await warehouseGeoWeightAggregate(
    { query: async () => [], execute: async () => 0 },
    'site',
    'fixture.invalid',
    'UTC',
    [
      { asOf: '2026-11-02', startAt: +start, endAt: +end },
      { asOf: '2026-11-01', startAt: +start - 86400000, endAt: +end - 86400000 },
    ],
  );
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

it('preserves microseconds and uses only visible rows for split log page cursors', async () => {
  const scope = 'a'.repeat(64);
  const rows = Array.from({ length: 101 }, (_, i) => ({
    cursorTime: `2026-11-01 00:00:00.${String(i).padStart(6, '0')}`,
    time: '2026-11-01 00:00:00.000000',
    recordId: i.toString(16).padStart(64, '0'),
  }));
  mocks.query.mockResolvedValueOnce(rows);
  const value = await warehouseLogFacts(
    'site',
    start,
    end,
    'UTC',
    1,
    '',
    '',
    '',
    'after',
    ['recent'],
    { crawlerIdentityScope: 'all', crawlerMetricsVersion: 1 },
    false,
    undefined,
    { cursorScope: scope, limit: 101 },
  );
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(mocks.query.mock.calls[0][1]).toContain('LIMIT 101');
  expect(value.recent).toHaveLength(101);
  expect(decodeWarehouseLogCursor(value.nextCursor, scope)).toEqual([
    rows[99].cursorTime,
    rows[99].recordId,
  ]);
});
