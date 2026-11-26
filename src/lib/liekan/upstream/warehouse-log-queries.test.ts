// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), read: vi.fn(), stream: vi.fn() }));
vi.mock('./logs', () => ({ staticRequestExtensionPattern: '\\.(js|css)$' }));
vi.mock('../warehouse/reader-runtime', () => ({
  warehouseReader: () => ({ db: { read: mocks.read } }),
}));
vi.mock('./warehouse-report-snapshot', () => ({
  withinWarehouseReport: (work: () => unknown) => work(),
  warehouseReportMetadata: async () => ({ boundary: { epoch: '1', deletionRevision: '0', publication: '5' } }),
  warehouseReportQuery: mocks.query,
  warehouseReportStream: mocks.stream,
}));
import {
  warehouseLogFacts,
  warehouseLogQuerySpec,
  warehouseMonthlyAiShare,
  warehouseOverviewLogWindow,
  warehousePlotLogs,
} from './warehouse-log-queries';
import { warehouseGeoWeightAggregate } from './warehouse-geo-weight';
import { decodeWarehouseLogCursor } from './warehouse-log-cursor';
import { factRelation } from '../warehouse/read';
import { type AnalysisRead, withAnalysisRead } from '../warehouse/analysis-context';
import { releaseRoundMetrics, withRoundMetrics } from './warehouse-round-metrics';

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

it('computes the same monthly source window once per frozen reporting round', async () => {
  mocks.query.mockResolvedValue([{ month: '2026-11', total: '3', ai: '2' }]);
  const run = () => warehouseMonthlyAiShare('site', end, 'UTC');
  try {
    const expected = await withRoundMetrics('monthly-fixture', run);
    expect(expected.at(-1)).toEqual({ month: '2026-11', total: 3, ai: 2 });
    expect(await withRoundMetrics('monthly-fixture', run)).toEqual(expected);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    await withRoundMetrics('next-monthly-fixture', run);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  } finally {
    releaseRoundMetrics('monthly-fixture');
    releaseRoundMetrics('next-monthly-fixture');
  }
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

it('folds full spider groups across types on a 25-hour local day', async () => {
  const from = new Date('2026-11-01T04:00:00Z');
  const until = new Date('2026-11-02T05:00:00Z');
  mocks.query.mockResolvedValue([
    bot,
    { ...bot, type: '训练', requests: '3', aiRequests: '1' },
    { ...bot, vendor: 'Second', requests: '1', aiRequests: '0' },
    { ...bot, botId: 'official' },
  ]);
  const result = await warehouseLogFacts(
    'site', from, until, 'America/New_York', 1, '', '', '', 'after',
    ['daily', 'bots'],
    { resource: 'ai/overview', crawlerMetricsVersion: 1, crawlerIdentityScope: 'all' },
  );
  expect(result.bots).toHaveLength(4);
  const identity = { day: '2026-11-01', bot: bot.name, vendor: bot.vendor, botId: null };
  expect(result.daily).toEqual([
    { ...identity, count: 5, aiRequests: 3 },
    { ...identity, vendor: 'Second', count: 1, aiRequests: 0 },
    { ...identity, botId: 'official', count: 2, aiRequests: 2 },
  ]);
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(mocks.query.mock.calls[0][1]).toContain('GROUP BY name,vendor,type,botId');
});

it.each([
  ['inclusive midnight', 'ai/overview', undefined, end, ['daily', 'bots']],
  ['across midnight', 'ai/overview', 1, new Date(+end + 1), ['daily', 'bots']],
  ['daily only', 'ai/overview', 1, end, ['daily']],
  ['filtered spider page', 'ai/bots', 1, end, ['daily', 'bots']],
] as const)('keeps the independent daily query for %s', async (_, resource, version, until, fields) => {
  await warehouseLogFacts('site', start, until, 'UTC', 1, '', '', '', 'after', fields, {
    resource,
    crawlerIdentityScope: 'all',
    crawlerMetricsVersion: version,
  });
  const statements = mocks.query.mock.calls.map(([, sql]) => sql);
  expect(statements.filter(sql => sql.includes('GROUP BY day,bot,vendor,botId'))).toHaveLength(1);
  expect(statements.filter(sql => sql.includes('GROUP BY name,vendor,type,botId'))).toHaveLength(
    fields.some(field => field === 'bots') ? 1 : 0,
  );
});

it('preserves an empty single-day result and rejects an inexact merged count', async () => {
  const load = () =>
    warehouseLogFacts('site', start, end, 'UTC', 1, '', '', '', 'after', ['daily', 'bots'], {
      resource: 'ai/overview',
      crawlerIdentityScope: 'all',
      crawlerMetricsVersion: 1,
    });
  expect((await load()).daily).toEqual([]);
  mocks.query.mockResolvedValue([{ ...bot, requests: String(Number.MAX_SAFE_INTEGER) }, bot]);
  await expect(load()).rejects.toThrow('warehouse-counter-out-of-range');
});

it('reuses bounded log aggregates only in the same round and analysis buckets', async () => {
  mocks.query.mockResolvedValue([bot]);
  const read = () => warehouseLogFacts('site', start, end, 'UTC', 1, '', '', '', 'after', ['bots']);
  const store = { values: {}, save: vi.fn(async () => {}) };
  const coverage = (build: string): AnalysisRead => ({
    site: 'site',
    control: 'control',
    browser: [],
    log: [[+start / 1000, build, 1, 0]],
  });
  const load = (round: string, build: string) =>
    withRoundMetrics(round, () => withAnalysisRead(coverage(build), read), store);
  try {
    const first = await load('log-test', 'build-a');
    expect(await load('log-test', 'build-a')).toEqual(first);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    await load('log-test', 'build-b');
    await load('log-test-next', 'build-a');
    await read();
    expect(mocks.query).toHaveBeenCalledTimes(4);
  } finally {
    releaseRoundMetrics('log-test');
    releaseRoundMetrics('log-test-next');
  }
});

it.each(['/registered', `/${'x'.repeat(70 * 1024)}`])(
  'retains only exact catalog path matches for preference while keeping site totals',
  async path => {
    mocks.read.mockResolvedValue([{ path }]);
    mocks.query.mockResolvedValueOnce([summary]).mockResolvedValueOnce([bot]);
    mocks.stream.mockImplementation(async (_id, _sql, _params, consume) => {
      await consume([{ path: '/unregistered', requests: '900' }]);
      await consume([{ path, bot: 'Crawler', botId: null, requests: '2' }]);
    });
    const result = await warehouseLogFacts(
      'site',
      start,
      end,
      'UTC',
      1,
      '',
      '',
      '',
      'after',
      ['catalog', 'summary', 'bots', 'pages'],
      { resource: 'ai/preference', crawlerIdentityScope: 'all' },
    );
    expect(result.summary.requests).toBe(5);
    expect(result.bots[0].requests).toBe(2);
    expect(result.pages).toEqual([
      { path, bot: 'Crawler', botId: null, requests: 2, lastCrawled: null },
    ]);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    const [, sql, params] = mocks.stream.mock.calls[0];
    expect(sql.includes('l.path IN {catalogPaths:Array(String)}')).toBe(path.length < 64 * 1024);
    expect(params.catalogPaths).toEqual(path.length < 64 * 1024 ? [path] : undefined);
  },
);

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
  mocks.query
    .mockResolvedValueOnce([{ firstHour: '1793491200', lastHour: '1793491200' }])
    .mockResolvedValueOnce(rows);
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
  expect(mocks.query).toHaveBeenCalledTimes(2);
  expect(mocks.query.mock.calls[1][1]).toContain('LIMIT 101');
  expect(value.recent).toHaveLength(101);
  expect(decodeWarehouseLogCursor(value.nextCursor, scope)).toEqual([
    rows[99].cursorTime,
    rows[99].recordId,
  ]);
});

it('bounds split log pages by physical timestamps, then filters canonical rows before LIMIT', async () => {
  mocks.query
    .mockResolvedValueOnce([{ firstHour: '1793491200', lastHour: '1793574000' }])
    .mockResolvedValueOnce(
      Array.from({ length: 101 }, (_, i) => ({
        cursorTime: '2026-11-01 23:01:00.123456',
        time: '2026-11-01 23:01:00.123456',
        recordId: i.toString(16).padStart(64, '0'),
      })),
    );
  await warehouseLogFacts(
    'site',
    start,
    end,
    'UTC',
    1,
    'ai',
    'needle',
    '',
    'after',
    ['recent'],
    { crawlerIdentityScope: 'all', crawlerMetricsVersion: 1 },
    false,
    undefined,
    { cursorScope: 'b'.repeat(64), limit: 101 },
  );
  expect(mocks.query).toHaveBeenCalledTimes(2);
  expect(mocks.query.mock.calls[0][1]).toContain('minOrNull');
  const [, sql, params] = mocks.query.mock.calls[1];
  expect(params.logStart).toBe('2026-11-01 23:00:00.000000');
  expect(params.logEnd).toBe('2026-11-02 00:00:00.000000');
  expect(sql).toContain('warehouse_publication');
  expect(sql).toContain('warehouse_deletion');
  expect(sql).toContain('positionCaseInsensitiveUTF8');
  expect(sql).toContain('LIMIT 101');
});

it('does not build a wide string search predicate for an empty search', async () => {
  const empty = await warehouseLogQuerySpec(
    start,
    end,
    'UTC',
    { crawlerIdentityScope: 'all' },
    '',
    '',
    false,
    'site',
  );
  const searched = await warehouseLogQuerySpec(
    start,
    end,
    'UTC',
    { crawlerIdentityScope: 'all' },
    '',
    'needle',
    false,
    'site',
  );
  expect(empty.detailBase).not.toContain('positionCaseInsensitiveUTF8');
  expect(searched.detailBase).toContain('positionCaseInsensitiveUTF8');
});

it('shares a finished hourly trend only inside the frozen round and exact chart scope', async () => {
  const { withDashboardClock } = await import('./dashboard-clock');
  vi.stubEnv('LIEKAN_WAREHOUSE_V2', '1');
  const row = { day: '2026-11-01', bot: 'Fixture', type: '搜索', count: 2, aiRequests: 1 };
  mocks.query.mockImplementation(async (_site, sql) => {
    if (sql.includes('SELECT 1 AS present')) return [{ present: 1 }];
    if (sql.includes('GROUP BY day,bot,type')) return [row];
    throw Error('unexpected source query');
  });
  const persisted = {
    values: {},
    async save(key: string, value: unknown) {
      this.values[key] = structuredClone(value);
    },
  };
  const run = (round: string, zone = 'UTC', scope: 'all' | 'verified_identity' = 'all') =>
    withRoundMetrics(round, () =>
      withDashboardClock(
        +end,
        () =>
          warehousePlotLogs('site', start, end, zone, false, {
            crawlerIdentityScope: scope,
            crawlerMetricsVersion: 1,
          }),
        'refresh',
      ),
      round === 'trend-round' ? persisted : undefined,
    );
  try {
    const expected = [{ ...row }];
    mocks.query.mockRejectedValueOnce(new Error('trend read failed'));
    await expect(run('trend-round')).rejects.toThrow('trend read failed');
    expect(Object.keys(persisted.values)).toHaveLength(0);
    mocks.query.mockClear();
    const first = await run('trend-round');
    expect(first).toEqual(expected);
    first[0].count = 999;
    // Simulate worker replacement after the finished metric was saved.
    releaseRoundMetrics('trend-round');
    expect(await run('trend-round')).toEqual(expected);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    await run('trend-round', 'Asia/Shanghai');
    await run('trend-round', 'UTC', 'verified_identity');
    await run('trend-next');
    const queries = mocks.query.mock.calls.map(([, sql]) => sql);
    expect(queries.filter(sql => sql.includes('GROUP BY day,bot,type'))).toHaveLength(4);
    expect(queries.filter(sql => sql.includes('SELECT 1 AS present'))).toHaveLength(2);
  } finally {
    releaseRoundMetrics('trend-round');
    releaseRoundMetrics('trend-next');
    vi.unstubAllEnvs();
  }
});
