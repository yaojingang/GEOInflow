// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  query: vi.fn(),
  insert: vi.fn(),
  metadata: vi.fn(),
}));
vi.mock('../warehouse/reader-runtime', () => ({ warehouseReader: () => ({ ch: io }) }));
vi.mock('./warehouse-report-snapshot', () => ({
  warehouseReportQuery: io.query,
  warehouseReportMetadata: io.metadata,
  warehouseReportSignal: () => undefined,
}));
import { readWarehouseAiHourDistribution, readWarehouseLogTrend } from './warehouse-log-trend';
import { withDashboardClock } from './dashboard-clock';

const start = new Date('2026-11-01T00:30:00Z');
const end = new Date('2026-11-01T03:15:00Z');
const h1 = Date.parse('2026-11-01T01:00:00Z') / 1000;
const h2 = h1 + 3600;
const metrics = { crawlerIdentityScope: 'all', crawlerMetricsVersion: 1 } as const;
const count = { bot: 'Fixture', type: '搜索', count: 2, aiRequests: 1 };
const edge = { ...count, day: '2026-11-01' };
const metadata = (publication: string, deletionRevision = '0') => ({
  boundary: { publication, deletionRevision, epoch: '0' },
  controlRevision: '0',
  intervals: [],
  repairRunId: null,
  repairGeneration: null,
});

beforeEach(() => {
  vi.resetAllMocks();
  io.metadata.mockResolvedValue(metadata('5'));
});

it('reuses exact hours and reads partial endpoints at the current publication', async () => {
  const load = {
    hours: vi.fn(async (hours: number[]) => hours.map(hour => ({ hour, ...count }))),
    edge: vi.fn(async () => [edge]),
  };
  io.query.mockResolvedValueOnce([]);
  expect(await readWarehouseLogTrend('site', start, end, 'UTC', false, metrics, load)).toEqual([
    { ...edge, count: 8, aiRequests: 4 },
  ]);
  expect(load.hours).toHaveBeenCalledWith([h1, h2]);
  expect(load.edge.mock.calls).toEqual([
    [start, new Date(h1 * 1000), true],
    [new Date((h2 + 3600) * 1000), end, true],
  ]);
  expect(io.insert.mock.calls.map(([arg]) => arg.values.map(row => row.hour))).toEqual([
    [h1, h2],
    [0],
  ]);

  io.query
    .mockResolvedValueOnce(io.insert.mock.calls[1][0].values)
    .mockResolvedValueOnce(io.insert.mock.calls[0][0].values);
  await readWarehouseLogTrend('site', start, end, 'UTC', false, metrics, load);
  expect(load.hours).toHaveBeenCalledTimes(1);
  expect(io.insert).toHaveBeenCalledTimes(2);
});

it('rebuilds only the old hour affected by late accepted evidence', async () => {
  io.metadata.mockResolvedValue(metadata('6'));
  io.query
    .mockResolvedValueOnce([
      {
        publication: '5',
        payload: JSON.stringify([
          [h1, 'old'],
          [h2, 'old'],
        ]),
      },
    ])
    .mockResolvedValueOnce([{ families: ['liekan_crawler_evidence'] }])
    .mockResolvedValueOnce([{ hour: h1 }])
    .mockResolvedValueOnce([{ hour: h2, payload: JSON.stringify([count]) }]);
  const load = {
    hours: vi.fn(async () => [{ hour: h1, ...count, aiRequests: 0 }]),
    edge: vi.fn(async () => []),
  };
  expect(await readWarehouseLogTrend('site', start, end, 'UTC', false, metrics, load)).toEqual([
    { ...edge, count: 4, aiRequests: 1 },
  ]);
  expect(io.query.mock.calls[2][1]).toContain(
    'SELECT log_id FROM warehouse_liekan_crawler_evidence',
  );
  expect(load.hours).toHaveBeenCalledWith([h1]);
  expect(JSON.parse(io.insert.mock.calls[1][0].values[0].payload)).toEqual([
    [h2, 'old'],
    [h1, io.insert.mock.calls[0][0].values[0].build],
  ]);
});

it('does not commit incomplete artifacts and changes the scope on deletion', async () => {
  io.query.mockResolvedValue([]);
  io.insert.mockRejectedValueOnce(new Error('insert failed'));
  const load = { hours: vi.fn(async () => []), edge: vi.fn(async () => []) };
  await expect(
    readWarehouseLogTrend('site', start, end, 'UTC', false, metrics, load),
  ).rejects.toThrow('insert failed');
  expect(io.insert).toHaveBeenCalledTimes(1);
  io.metadata.mockResolvedValue(metadata('5', '1'));
  await readWarehouseLogTrend('site', start, end, 'UTC', false, metrics, load);
  expect(io.query.mock.calls[0][2].trendControl).not.toBe(io.query.mock.calls[1][2].trendControl);
  expect(io.insert.mock.calls[1][0].values.map(row => JSON.parse(row.payload))).toEqual([[], []]);
});

it('uses the original query when a UTC bucket straddles a local trend hour', async () => {
  const load = { hours: vi.fn(), edge: vi.fn() };
  expect(
    await readWarehouseLogTrend('site', start, end, 'Asia/Kolkata', true, metrics, load),
  ).toBeUndefined();
  expect(io.metadata).not.toHaveBeenCalled();
});

it('keeps the exact end instant for inclusive reports at an hour boundary', async () => {
  io.query.mockResolvedValueOnce([]);
  const load = { hours: vi.fn(async () => []), edge: vi.fn(async () => [edge]) };
  const from = new Date(h1 * 1000);
  const to = new Date(h2 * 1000);
  await readWarehouseLogTrend(
    'site',
    from,
    to,
    'UTC',
    false,
    { crawlerIdentityScope: 'all' },
    load,
  );
  expect(load.hours).toHaveBeenCalledWith([h1]);
  expect(load.edge).toHaveBeenCalledExactlyOnceWith(to, to, false);
});

it('leaves missing hourly history out of the first overview snapshot', async () => {
  io.query.mockResolvedValueOnce([]);
  const load = { hours: vi.fn(), edge: vi.fn() };
  expect(
    await withDashboardClock(
      +end,
      () => readWarehouseLogTrend('site', start, end, 'UTC', false, metrics, load),
      'first',
    ),
  ).toBeUndefined();
  expect(load.hours).not.toHaveBeenCalled();
  expect(io.insert).not.toHaveBeenCalled();
});

it('shares verified whole hours across overlapping cold reporting windows', async () => {
  const load = {
    hours: vi.fn(async (hours: number[]) => hours.map(hour => ({ hour, ...count }))),
    edge: vi.fn(async () => []),
    coveredHours: vi.fn(() => true),
  };
  io.query.mockResolvedValueOnce([]);
  const run = (from: Date) =>
    withDashboardClock(
      +end,
      () => readWarehouseLogTrend('site', from, end, 'UTC', false, metrics, load),
      'first',
    );
  expect(await run(start)).toEqual([{ ...edge, count: 4, aiRequests: 2 }]);
  io.query
    .mockResolvedValueOnce(io.insert.mock.calls[1][0].values)
    .mockResolvedValueOnce(io.insert.mock.calls[0][0].values.filter(row => row.hour === h2));
  expect(await run(new Date(h2 * 1000))).toEqual([edge]);
  expect(load.hours).toHaveBeenCalledExactlyOnceWith([h1, h2]);
  expect(io.insert).toHaveBeenCalledTimes(2);
});

it('combines both UTC hours of a repeated local hour and keeps the next hour separate', async () => {
  io.query.mockResolvedValue([]);
  const from = new Date('2026-11-01T05:00:00Z');
  const to = new Date('2026-11-01T08:00:00Z');
  const load = {
    hours: vi.fn(async (hours: number[]) => hours.map(hour => ({ hour, ...count }))),
    edge: vi.fn(async () => []),
  };
  expect(
    await readWarehouseLogTrend('site', from, to, 'America/New_York', true, metrics, load),
  ).toEqual([
    { ...count, day: '2026-11-01 01:00', count: 4, aiRequests: 2 },
    { ...count, day: '2026-11-01 02:00' },
  ]);
});

it('uses exact source edges if a UTC hour straddles local midnight', async () => {
  const from = new Date('2026-11-01T17:00:00Z');
  const to = new Date('2026-11-01T20:00:00Z');
  expect(
    await readWarehouseLogTrend('site', from, to, 'Asia/Kathmandu', false, metrics, {
      hours: vi.fn(),
      edge: vi.fn(),
    }),
  ).toBeUndefined();
  expect(io.metadata).not.toHaveBeenCalled();
});

it('merges both occurrences of a repeated clock hour and passes both partial edges to SQL', async () => {
  const from = new Date('2026-11-01T04:30:00Z');
  const to = new Date('2026-11-01T07:20:00Z');
  const first = Date.parse('2026-11-01T05:00:00Z') / 1000;
  const remainder = vi.fn(async () => [{ hour: 2, count: 3 }]);
  const payload = JSON.stringify([count]);
  io.query
    .mockResolvedValueOnce([
      {
        publication: '5',
        payload: JSON.stringify([
          [first, 'a'],
          [first + 3600, 'b'],
        ]),
      },
    ])
    .mockResolvedValueOnce([
      { hour: first, payload },
      { hour: first + 3600, payload },
    ]);
  expect(
    await readWarehouseAiHourDistribution(
      'site',
      from,
      to,
      'America/New_York',
      metrics,
      undefined,
      remainder,
    ),
  ).toEqual([
    { hour: 1, count: 2 },
    { hour: 2, count: 3 },
  ]);
  expect(remainder).toHaveBeenCalledExactlyOnceWith([first - 3600, first + 7200]);
  expect(io.insert).not.toHaveBeenCalled();
});

it('leaves fractional-offset clock hours and sub-hour ranges to the original histogram', async () => {
  for (const [zone, to] of [
    ['Asia/Kathmandu', end],
    ['UTC', new Date(+start + 1000)],
  ] as const)
    expect(
      await readWarehouseAiHourDistribution('site', start, to, zone, metrics, undefined, vi.fn()),
    ).toBeUndefined();
  expect(io.query).not.toHaveBeenCalled();
});

it('distinguishes a verified empty hour from a missing payload and includes the legacy endpoint', async () => {
  io.query
    .mockResolvedValueOnce([
      {
        publication: '5',
        payload: JSON.stringify([
          [h1, 'a'],
          [h2, 'b'],
        ]),
      },
    ])
    .mockResolvedValueOnce([{ hour: h1, payload: '[]' }]);
  const remainder = vi.fn(async () => [{ hour: 3, count: 1 }]);
  const result = await readWarehouseAiHourDistribution(
    'site',
    new Date(h1 * 1000),
    new Date((h2 + 3600) * 1000),
    'UTC',
    { crawlerIdentityScope: 'all' },
    undefined,
    remainder,
  );
  expect(result).toEqual([{ hour: 3, count: 1 }]);
  expect(remainder).toHaveBeenCalledExactlyOnceWith([h2, h2 + 3600]);
});
