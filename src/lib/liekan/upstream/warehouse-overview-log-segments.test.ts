// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReportQuery } from '../contracts/query';
import { withDashboardClock } from './dashboard-clock';
import { prepareWarehouseOverviewLogSegments } from './warehouse-overview-log-segments';

const io = vi.hoisted(() => ({
  query: vi.fn(),
  command: vi.fn(),
  metadata: vi.fn(),
  fingerprint: vi.fn(),
  window: vi.fn(async () => ({ hasFacts: true, restrictEvidenceToWindow: true })),
}));
vi.mock('./warehouse-report-snapshot', () => ({
  warehouseReportQuery: io.query,
  warehouseReportCommand: io.command,
  warehouseReportMetadata: io.metadata,
  warehouseControlFingerprint: io.fingerprint,
  warehouseReportSignal: () => undefined,
}));
vi.mock('./warehouse-log-queries', () => ({
  warehouseOverviewLogWindow: io.window,
  warehouseOverviewAggregateStates: vi.fn(() => ({ sql: 'SELECT states', params: {} })),
  renderWarehouseOverviewAggregate: (sql: string) => sql,
}));

const metrics = {
  resource: 'overview',
  chartPeriod: '7d',
  timezone: 'America/New_York',
  crawlerIdentityScope: 'all',
} as ReportQuery;
const start = new Date('2026-11-01T04:00:00Z'); // A 25-hour local day.
const end = new Date('2026-11-03T17:00:00Z');
const retained = '00000000-0000-0000-0000-000000000001';
const compute = () =>
  withDashboardClock(
    +end,
    () => prepareWarehouseOverviewLogSegments('site', start, end, metrics),
    'refresh',
  );

beforeEach(() => {
  vi.resetAllMocks();
  io.metadata.mockResolvedValue({ boundary: { publication: '8' } });
  io.fingerprint.mockReturnValue('control');
  io.query.mockResolvedValue([]);
});

it('publishes only completed days and keeps the cutoff day in the raw merge', async () => {
  const result = await compute();
  const [_, write, build] = io.command.mock.calls[0];
  expect(write).toContain('INSERT INTO warehouse_overview_log_days');
  const checkpoint = io.command.mock.calls[1][2];
  expect(JSON.parse(checkpoint.overviewCoverage)).toEqual([
    ['2026-11-01', build.overviewBuild],
    ['2026-11-02', build.overviewBuild],
  ]);
  expect(result.params.overviewDays).toEqual(['2026-11-01', '2026-11-02']);
  expect(result.sql).toContain('uniqExactMerge(pages)');
  expect(result.sql).toContain('UNION ALL SELECT states');
});

it('merges covered days with a zero summary when the raw edge is empty', async () => {
  io.query.mockResolvedValueOnce([
    {
      publication: '8',
      payload: JSON.stringify([
        ['2026-11-01', retained],
        ['2026-11-02', retained],
      ]),
    },
  ]);
  io.window.mockResolvedValueOnce({ hasFacts: false, restrictEvidenceToWindow: false });
  const result = await compute();
  expect(io.window).toHaveBeenCalledExactlyOnceWith(
    'site',
    new Date('2026-11-03T05:00:00Z'),
    end,
    false,
  );
  expect(io.command).not.toHaveBeenCalled();
  expect(result.params.overviewBuilds).toEqual([retained, retained]);
  expect(result.sql).toContain("UNION ALL SELECT 'summary'");
  expect(result.sql).not.toContain('SELECT states');
});

it('invalidates one affected day after evidence publication and reuses the other day', async () => {
  io.query
    .mockResolvedValueOnce([
      {
        publication: '7',
        payload: JSON.stringify([
          ['2026-11-01', retained],
          ['2026-11-02', retained],
        ]),
      },
    ])
    .mockResolvedValueOnce([{ families: ['liekan_crawler_evidence'] }])
    .mockResolvedValueOnce([{ day: '2026-11-01' }]);
  const result = await compute();
  expect(io.query.mock.calls[2][1]).toContain(
    'SELECT log_id FROM warehouse_liekan_crawler_evidence',
  );
  expect(result.params.overviewBuilds).toEqual([
    io.command.mock.calls[0][2].overviewBuild,
    retained,
  ]);
});

it('rebuilds covered days after a repair result changes at the same control version', async () => {
  io.query
    .mockResolvedValueOnce([
      {
        publication: '7',
        payload: JSON.stringify([
          ['2026-11-01', retained],
          ['2026-11-02', retained],
        ]),
      },
    ])
    .mockResolvedValueOnce([{ families: ['liekan_history_repair_result'] }]);
  const result = await compute();
  const build = io.command.mock.calls[0][2].overviewBuild;
  expect(result.params.overviewBuilds).toEqual([build, build]);
  expect(build).not.toBe(retained);
});

it('leaves a failed build unreachable, retries with a new build, and scopes deletions out', async () => {
  io.command.mockRejectedValueOnce(new Error('insert failed'));
  expect(await compute()).toBeUndefined();
  expect(io.command).toHaveBeenCalledTimes(1);
  const failed = io.command.mock.calls[0][2].overviewBuild;
  const retry = await compute();
  expect(retry.params.overviewBuilds[0]).not.toBe(failed);
  io.fingerprint.mockReturnValue('new-deletion-revision');
  await compute();
  expect(io.query.mock.calls[2][2].overviewControl).not.toBe(
    io.query.mock.calls[1][2].overviewControl,
  );
});

it('keeps a large initial build out of the report deadline and advances one background batch', async () => {
  const begin = new Date('2026-10-20T04:00:00Z');
  const computeLong = (backfill: boolean) =>
    withDashboardClock(
      +end,
      () => prepareWarehouseOverviewLogSegments('site', begin, end, metrics, backfill),
      'refresh',
    );
  expect(await computeLong(false)).toBeUndefined();
  expect(io.command).not.toHaveBeenCalled();
  expect(await computeLong(true)).toBeUndefined();
  expect(io.command).toHaveBeenCalledTimes(2);
  expect(JSON.parse(io.command.mock.calls[1][2].overviewCoverage).map(([day]) => day)).toEqual([
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
    '2026-10-24',
  ]);
});

it('lets a cold report read facts while multiple daily segments are missing', async () => {
  expect(
    await withDashboardClock(
      +end,
      () => prepareWarehouseOverviewLogSegments('site', start, end, metrics),
      'first',
    ),
  ).toBeUndefined();
  expect(io.command).not.toHaveBeenCalled();
});
