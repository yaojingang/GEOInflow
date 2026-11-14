// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./analytics-engine-counts', () => ({ readClickHouseLogCounts: m.counts }));
const m = vi.hoisted(() => ({
  read: vi.fn(),
  counts: vi.fn(),
  fragments: new Map<string, unknown>(),
}));
vi.mock('./analysis-rollups', () => ({
  readAnalysisLogRollup: m.read,
  analysisSafeNumber: (v: string) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new RangeError();
    return n;
  },
}));
vi.mock('./server', () => ({
  query: () => {
    throw new Error('unexpected raw fallback');
  },
}));
vi.mock('./report-fragments', () => ({
  primeReportFragments: async () => {},
  readReportFragment: async (
    kind: string,
    start: Date,
    end: Date,
    parameters: unknown,
    load: () => Promise<unknown>,
  ) => {
    const key = JSON.stringify([kind, +start, +end, parameters]);
    if (!m.fragments.has(key)) m.fragments.set(key, await load());
    return m.fragments.get(key);
  },
}));
import { logStatisticsRanges, readLogStatistics } from './log-statistics';
const at = (s: string) => Date.parse(s);
beforeEach(() => {
  m.fragments.clear();
  m.read.mockReset();
  m.counts.mockReset().mockResolvedValue(null);
});
it.each([
  ['UTC', '2026-01-01T00:00Z', '2027-01-01T00:00Z'],
  ['Asia/Shanghai', '2026-01-01T00:00Z', '2029-01-01T00:00Z'],
  ['America/New_York', '2026-03-08T05:00Z', '2026-03-10T04:00Z'],
  ['America/New_York', '2026-11-01T04:00Z', '2026-11-03T05:00Z'],
])(
  'covers exact disjoint %s boundaries within the durable per-site limit',
  (timezone, start, end) => {
    const ranges = logStatisticsRanges(at(start), at(end), timezone, at('2030-01-01T00:00Z'));
    expect(ranges.length).toBeLessThan(100);
    expect(ranges[0].start).toBe(at(start));
    expect(ranges.at(-1).end).toBe(at(end));
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].start).toBe(ranges[i - 1].end);
    expect(ranges.reduce((sum, r) => sum + r.end - r.start, 0)).toBe(at(end) - at(start));
  },
);
it('keeps only the current five-minute tail outside published fragments', () => {
  const ranges = logStatisticsRanges(
    at('2026-11-12T16:00Z'),
    at('2026-11-13T00:03:12Z'),
    'Asia/Shanghai',
    at('2026-11-13T00:04Z'),
  );
  expect(ranges).toEqual([
    { start: at('2026-11-12T16:00Z'), end: at('2026-11-13T00:00Z'), tail: false },
    { start: at('2026-11-13T00:00Z'), end: at('2026-11-13T00:03:12Z'), tail: true },
  ]);
});
it('unions classification identities while summing exact additive populations', async () => {
  m.read.mockImplementation(async (input: any) => ({
    counts: {
      requests: 4,
      ai: 2,
      abnormal: 1,
      legacyRequests: 1,
      unclassifiedRequests: 1,
      classifications:
        +input.startDate === at('2026-01-01T00:00Z') ? ['legacy', 'v1'] : ['v1', 'v2'],
    },
  }));
  const p: any = {
    startAt: at('2026-01-01T00:00Z'),
    endAt: at('2026-01-03T00:00Z'),
    timezone: 'UTC',
    crawlerMetricsVersion: 1,
    crawlerIdentityScope: 'all',
  };
  expect(await readLogStatistics('site', p)).toEqual({
    requests: 8,
    ai: 4,
    abnormal: 2,
    legacyRequests: 2,
    unclassifiedRequests: 2,
    classifications: ['legacy', 'v1', 'v2'],
  });
  await readLogStatistics('site', { ...p, filter: 'ai', search: 'irrelevant' });
  expect(m.read).toHaveBeenCalledTimes(2);
});
it('does not sum per-day distinct path or visitor counts', async () => {
  m.read.mockResolvedValue({
    counts: {
      requests: 1,
      ai: 1,
      abnormal: 0,
      legacyRequests: 0,
      unclassifiedRequests: 0,
      classifications: ['v1'],
    },
    summary: { pages: 1000 },
  });
  const result = await readLogStatistics('site', {
    startAt: 0,
    endAt: 1,
    timezone: 'UTC',
    crawlerIdentityScope: 'all',
  } as any);
  expect(result).not.toHaveProperty('pages');
  expect(result).not.toHaveProperty('visitors');
});

it('uses the compact source before PG while retaining durable fragment reuse', async () => {
  const value = {
    requests: 9,
    ai: 4,
    abnormal: 1,
    legacyRequests: 2,
    unclassifiedRequests: 1,
    classifications: ['v1'],
  };
  m.counts.mockResolvedValue(value);
  const p: any = {
    startAt: at('2026-01-01T00:00Z'),
    endAt: at('2026-02-01T00:00Z'),
    timezone: 'UTC',
    crawlerMetricsVersion: 1,
    crawlerIdentityScope: 'all',
  };
  expect(await readLogStatistics('site', p)).toEqual(value);
  expect(await readLogStatistics('site', p)).toEqual(value);
  expect(m.counts).toHaveBeenCalledTimes(1);
  expect(m.read).not.toHaveBeenCalled();
});
