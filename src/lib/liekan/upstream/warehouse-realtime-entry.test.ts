// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ activity: vi.fn(), combined: vi.fn(), snapshot: vi.fn() }));
vi.mock('./native-snapshot', () => ({
  nativeSnapshot: (work: () => unknown) => {
    m.snapshot();
    return work();
  },
}));
vi.mock('./warehouse-report-snapshot', () => ({
  withinWarehouseReport: (work: () => unknown) => work(),
}));
vi.mock('./warehouse-realtime', async () => ({
  warehouseRealtimeEnabled: (await import('../warehouse/authority-routing')).warehouseEnabled,
  warehouseRealtimeStats: m.combined,
}));
vi.mock('@/queries/sql/getRealtimeActivity', async () => ({
  getRealtimeActivity: () =>
    import('@/lib/db').then(({ runQuery }) =>
      runQuery({ clickhouse: m.activity, prisma: m.activity }),
    ),
}));
vi.mock('@/queries/sql/pageviews/getPageviewStats', () => ({
  getPageviewStats: async () => [
    { x: 'a', y: 3 },
    { x: 'b', y: 4 },
  ],
}));
vi.mock('@/queries/sql/sessions/getSessionStats', () => ({
  getSessionStats: async () => [
    { x: 'a', y: 2 },
    { x: 'b', y: 2 },
  ],
}));
vi.mock('@/queries/sql/getWebsiteStats', () => ({
  getWebsiteStats: async () => ({ visitors: 3 }),
}));
import { getRealtimeData } from '@/queries/sql/getRealtimeData';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'clickhouse');
  vi.stubEnv('LIEKAN_WAREHOUSE_TRANSITION', 'false');
  vi.stubEnv('CLICKHOUSE_URL', '');
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture.invalid/unused');
  m.activity.mockResolvedValue([]);
  m.combined.mockResolvedValue({
    pageviews: [
      { x: 'a', y: 3 },
      { x: 'b', y: 4 },
    ],
    sessions: [
      { x: 'a', y: 2 },
      { x: 'b', y: 2 },
    ],
    totals: {
      visitors: 3,
      population: { capability: 'supported', identity: { status: 'complete' } },
    },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('realtime entry backend selection', () => {
  it('returns exact window UV when the same visitor belongs to both buckets', async () => {
    const result = await getRealtimeData('site', {});
    expect(result.totals.visitors).toBe(3);
    expect(result.series.visitors.map(v => v.y)).toEqual([2, 2]);
    expect(m.combined).toHaveBeenCalledOnce();
    expect(m.snapshot).toHaveBeenCalledOnce();
  });
  it('does not turn unknown identities into zero visitors at the entry', async () => {
    m.combined.mockResolvedValue({
      pageviews: [{ x: 'a', y: 1 }],
      sessions: [{ x: 'a', y: null }],
      totals: {
        visitors: null,
        population: { capability: 'supported', identity: { status: 'unavailable' } },
      },
    });
    expect((await getRealtimeData('site', {})).totals.visitors).toBeNull();
  });
  it('rejects conflicting upstream CH configuration before returning any combined result', async () => {
    vi.stubEnv('CLICKHOUSE_URL', 'http://fixture.invalid:8123');
    await expect(getRealtimeData('site', {})).rejects.toThrow(
      'warehouse-upstream-configuration-conflict',
    );
    expect(m.activity).not.toHaveBeenCalled();
  });
  it('keeps PostgreSQL window totals independent of bucket UV', async () => {
    vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'postgres');
    expect((await getRealtimeData('site', {})).totals.visitors).toBe(3);
    expect(m.combined).not.toHaveBeenCalled();
    expect(m.activity).toHaveBeenCalledOnce();
  });
  it('preserves the separate upstream CH compatibility behavior', async () => {
    vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'postgres');
    vi.stubEnv('CLICKHOUSE_URL', 'http://fixture.invalid:8123');
    expect((await getRealtimeData('site', {})).totals.visitors).toBe(4);
    expect(m.combined).not.toHaveBeenCalled();
    expect(m.activity).toHaveBeenCalledOnce();
    expect(m.snapshot).not.toHaveBeenCalled();
  });
});
