import { describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ query: vi.fn(), population: vi.fn(), analysis: false }));
vi.mock('@/lib/clickhouse', () => ({
  default: {
    getDateSQL: () => 'toStartOfMinute(created_at)',
    parseFilters: () => ({
      filterQuery: 'AND browser={browser:String}',
      cohortQuery: '',
      excludeBounceQuery: '',
      queryParams: { browser: 'Chrome' },
    }),
  },
}));
vi.mock('./warehouse-native-query', () => ({
  warehouseNativeQuery: mock.query,
  withWarehouseNativeRead: async (_params: unknown, _name: string, work: () => unknown) => {
    mock.analysis = true;
    try {
      return await work();
    } finally {
      mock.analysis = false;
    }
  },
}));
vi.mock('./browser-population', () => ({ readBrowserPopulation: mock.population }));
vi.mock('./warehouse-report-snapshot', () => ({
  withinWarehouseReport: (fn: () => unknown) => fn(),
}));
import { warehouseRealtimeStats } from './warehouse-realtime';
describe('combined warehouse realtime metrics', () => {
  it('keeps population lookup inside the same verified analysis read as the metrics', async () => {
    mock.query.mockResolvedValue([{ x: '', views: 0, visitors: 0, total: 1 }]);
    mock.population.mockImplementation(async () => {
      expect(mock.analysis, 'population must reuse the verified model, not re-read raw facts').toBe(
        true,
      );
      return { capability: 'supported', identity: { status: 'empty' } };
    });
    await warehouseRealtimeStats('site', { startDate: new Date(0), endDate: new Date(60000) });
  });
  it('uses a window deduplication independent of bucket UV and preserves filters', async () => {
    mock.query.mockResolvedValue([
      { x: 'a', views: 3, visitors: 2, total: 0 },
      { x: 'b', views: 4, visitors: 2, total: 0 },
      { x: '', views: 7, visitors: 3, total: 1 },
    ]);
    mock.population.mockResolvedValue({
      capability: 'supported',
      identity: { status: 'complete' },
    });
    const result = await warehouseRealtimeStats('site', {
      startDate: new Date(0),
      endDate: new Date(60000),
      unit: 'minute',
      timezone: 'UTC',
    });
    expect(result.pageviews.map(r => r.y)).toEqual([3, 4]);
    expect(result.sessions.map(r => r.y)).toEqual([2, 2]);
    expect(result.totals.visitors).toBe(3);
    expect(mock.query).toHaveBeenCalledWith(
      expect.stringContaining('GROUP BY GROUPING SETS ((x),())'),
      { browser: 'Chrome' },
      'getRealtimeStats',
    );
  });
  it('retains unknown identity instead of inventing zero UV', async () => {
    mock.query.mockResolvedValue([
      { x: 'a', views: 3, visitors: 2, total: 0 },
      { x: '', views: 3, visitors: 2, total: 1 },
    ]);
    mock.population.mockResolvedValue({
      capability: 'supported',
      identity: { status: 'unavailable' },
    });
    const result = await warehouseRealtimeStats('site', {
      startDate: new Date(0),
      endDate: new Date(60000),
    });
    expect(result.totals.visitors).toBeNull();
    expect(result.sessions.every(r => r.y === null)).toBe(true);
  });
});
