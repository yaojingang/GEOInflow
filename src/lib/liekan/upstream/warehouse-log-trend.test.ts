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
import { readWarehouseLogTrend } from './warehouse-log-trend';
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
