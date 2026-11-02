// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { formatInTimeZone } from 'date-fns-tz';
const m = vi.hoisted(() => ({
  active: true,
  cache: new Map<string, unknown>(),
  series: vi.fn(),
  clickhouseSeries: vi.fn(),
  query: vi.fn(),
}));
vi.mock('./report-fragments', () => ({
  reportFragmentsActive: () => m.active,
  readReportFragment: async (
    kind: string,
    start: Date,
    end: Date,
    parameters: unknown,
    load: () => Promise<unknown>,
  ) => {
    const key = JSON.stringify([kind, +start, +end, parameters]);
    if (!m.cache.has(key)) m.cache.set(key, await load());
    return m.cache.get(key);
  },
}));
vi.mock('./analysis-rollups', () => ({
  readAnalysisLogSeries: m.series,
  readAnalysisLogRollup: vi.fn(),
  readAnalysisLogToday: vi.fn(),
}));
vi.mock('./analytics-engine-read', () => ({
  readClickHouseLogSeries: m.clickhouseSeries,
  readClickHouseLogRollup: async () => null,
}));
vi.mock('./server', async () => ({ ...(await import('./errors')), query: m.query }));
vi.mock('./ai-log-read-priority', () => ({
  withLogStatisticsRead: (work: () => Promise<unknown>) => work(),
}));
import { getMonthlyAiShare, getPlotLogs } from './logs';

const site = 'b880cb21-0000-4000-8000-000000000000';
const observations = [
  ['2026-05-03T01:00Z', 2],
  ['2026-06-03T01:00Z', 3],
  ['2026-09-03T01:00Z', 5],
  ['2026-10-01T20:00Z', 7],
  ['2026-10-02T01:00Z', 11],
  ['2026-10-02T01:01Z', 13],
] as const;
async function aggregateObservations(input: any) {
  const rows = new Map<
    string,
    { day: string; bot: string; type: string; count: number; aiRequests: number }
  >();
  for (const [at, count] of observations) {
    if (+new Date(at) < +input.startDate || +new Date(at) >= +input.endDate) continue;
    const day = formatInTimeZone(
      at,
      input.timezone || 'UTC',
      input.grain === 'month'
        ? 'yyyy-MM'
        : input.grain === 'hour'
          ? 'yyyy-MM-dd HH:00'
          : 'yyyy-MM-dd',
    );
    const before = rows.get(day)?.count || 0;
    rows.set(day, {
      day,
      bot: 'SyntheticBot',
      type: '搜索',
      count: before + count,
      aiRequests: before + count,
    });
  }
  return [...rows.values()];
}
beforeEach(() => {
  m.cache.clear();
  m.active = true;
  m.query.mockReset();
  m.series.mockReset().mockImplementation(aggregateObservations);
  m.clickhouseSeries.mockReset().mockResolvedValue(null);
});

it('reuses five closed months while updating the current month with identical totals', async () => {
  const first = await getMonthlyAiShare(site, new Date('2026-10-02T01:00:30Z'), 'Asia/Shanghai', {
    crawlerIdentityScope: 'all' as const,
    crawlerMetricsVersion: 1,
  });
  expect(first.map(row => row.total)).toEqual([2, 3, 0, 0, 5, 18]);
  expect(m.series).toHaveBeenCalledTimes(6);
  const next = await getMonthlyAiShare(site, new Date('2026-10-02T01:01:30Z'), 'Asia/Shanghai', {
    crawlerIdentityScope: 'all' as const,
    crawlerMetricsVersion: 1,
  });
  expect(next.map(row => row.total)).toEqual([2, 3, 0, 0, 5, 31]);
  expect(m.series).toHaveBeenCalledTimes(7);
  expect(m.series.mock.calls.at(-1)[0].startDate.toISOString()).toBe('2026-09-30T16:00:00.000Z');
});
it('keeps partial edges exact and reuses the closed historical trend', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T01:00:30Z'));
  try {
    const start = new Date('2026-10-01T20:00Z'),
      end = new Date('2026-10-02T01:00:30Z');
    const metrics = { crawlerIdentityScope: 'all' as const, crawlerMetricsVersion: 1 as const };
    const first = await getPlotLogs(site, start, end, 'UTC', false, metrics);
    expect(first.map(row => row.count)).toEqual([7, 11]);
    expect(m.series).toHaveBeenCalledTimes(2);
    const second = await getPlotLogs(
      site,
      start,
      new Date('2026-10-02T01:01:30Z'),
      'UTC',
      false,
      metrics,
    );
    expect(second.map(row => row.count)).toEqual([7, 24]);
    expect(m.series).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});
it('reuses empty historical months without abandoning covered recent statistics', async () => {
  const firstManifest = Date.parse('2026-10-01T00:00Z');
  m.series.mockImplementation(async (input: any) => {
    const covered = +input.startDate <= firstManifest && +input.endDate > firstManifest;
    if (!covered && !input.allowRawOnly) return null;
    return (await aggregateObservations(input)).filter(row => row.day >= '2026-10');
  });
  m.query.mockResolvedValue([{ month: '2026-10', total: 18, ai: 18 }]);
  const metrics = { crawlerIdentityScope: 'all' as const, crawlerMetricsVersion: 1 as const };
  const first = await getMonthlyAiShare(site, new Date('2026-10-02T01:00:30Z'), 'UTC', metrics);
  expect(first.map(row => row.total)).toEqual([0, 0, 0, 0, 0, 18]);
  expect(m.query).not.toHaveBeenCalled();
  expect(m.series).toHaveBeenCalledTimes(6);
  const next = await getMonthlyAiShare(site, new Date('2026-10-02T01:01:30Z'), 'UTC', metrics);
  expect(next.map(row => row.total)).toEqual([0, 0, 0, 0, 0, 31]);
  expect(m.series).toHaveBeenCalledTimes(7);
});
it('reads an uncovered current-day tail while reusing the covered historical trend', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T01:00:30Z'));
  try {
    const today = Date.parse('2026-10-02T00:00Z');
    m.series.mockImplementation(async (input: any) => {
      if (+input.startDate >= today && !input.allowRawOnly) return null;
      return aggregateObservations(input);
    });
    m.query.mockImplementation(async (_sql, _id, startDate, endDate, timezone) =>
      aggregateObservations({ startDate, endDate, timezone, grain: 'day' }),
    );
    const start = new Date('2026-10-01T20:00Z');
    const metrics = { crawlerIdentityScope: 'all' as const, crawlerMetricsVersion: 1 as const };
    const first = await getPlotLogs(
      site,
      start,
      new Date('2026-10-02T01:00:30Z'),
      'UTC',
      false,
      metrics,
    );
    expect(first.map(row => row.count)).toEqual([7, 11]);
    expect(m.query).not.toHaveBeenCalled();
    expect(m.series).toHaveBeenCalledTimes(2);
    const next = await getPlotLogs(
      site,
      start,
      new Date('2026-10-02T01:01:30Z'),
      'UTC',
      false,
      metrics,
    );
    expect(next.map(row => row.count)).toEqual([7, 24]);
    expect(m.series).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});
it('keeps verified ClickHouse reads ahead of PostgreSQL for every fragment', async () => {
  m.clickhouseSeries.mockImplementation(async (input: any) => {
    expect(input).not.toHaveProperty('allowRawOnly');
    return aggregateObservations(input);
  });
  const result = await getMonthlyAiShare(site, new Date('2026-10-02T01:00:30Z'), 'UTC', {
    crawlerIdentityScope: 'all',
    crawlerMetricsVersion: 1,
  });
  expect(result.map(row => row.total)).toEqual([2, 3, 0, 0, 5, 18]);
  expect(m.clickhouseSeries).toHaveBeenCalledTimes(6);
  expect(m.series).not.toHaveBeenCalled();
  expect(m.query).not.toHaveBeenCalled();
});
it('retains the original single read for compatibility and unscoped calls', async () => {
  await getMonthlyAiShare(site, new Date('2026-10-02T01:00:30Z'), 'UTC');
  expect(m.series).toHaveBeenCalledTimes(1);
  m.active = false;
  await getMonthlyAiShare(site, new Date('2026-10-02T01:00:30Z'), 'UTC', {
    crawlerIdentityScope: 'all' as const,
    crawlerMetricsVersion: 1,
  });
  expect(m.series).toHaveBeenCalledTimes(2);
  expect(m.series.mock.calls.every(([input]) => input.allowRawOnly === undefined)).toBe(true);
  expect(m.clickhouseSeries).toHaveBeenCalledTimes(2);
  expect(m.clickhouseSeries.mock.calls.every(([input]) => input.allowRawOnly === undefined)).toBe(
    true,
  );
});
