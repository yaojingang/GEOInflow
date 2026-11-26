import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  stats: vi.fn(),
  dates: vi.fn(),
  warehouse: vi.fn(),
}));
vi.mock('./server', () => ({ query: mocks.query }));
vi.mock('@/queries/sql', () => ({
  getWebsiteStats: mocks.stats,
  getWebsiteDateRange: mocks.dates,
}));
vi.mock('./warehouse-presence', () => ({ warehouseCollectionPresence: mocks.warehouse }));
import { collectionPresence } from './collection-presence';
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CLICKHOUSE_URL', '');
  vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'postgresql');
});
it('verifies raw collection in the installed warehouse without reading stale PG facts', async () => {
  vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'clickhouse');
  const presence = {
    pageviews: 7,
    firstAt: '2026-11-03T00:00:00.000Z',
    lastAt: '2026-11-03T01:00:00.000Z',
  };
  mocks.warehouse.mockResolvedValue(presence);
  expect(await collectionPresence('fixture')).toEqual(presence);
  expect(mocks.warehouse).toHaveBeenCalledWith('fixture');
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.stats).not.toHaveBeenCalled();
});
it('reads raw PostgreSQL collection presence independently of the active policy', async () => {
  mocks.query.mockResolvedValue([
    { pageviews: 3, firstAt: new Date(1000), lastAt: new Date(2000) },
  ]);
  expect(await collectionPresence('fixture')).toEqual({
    pageviews: 3,
    firstAt: new Date(1000).toISOString(),
    lastAt: new Date(2000).toISOString(),
  });
  expect(mocks.query.mock.calls[0][0]).toContain('FROM liekan_raw_website_event');
});
it('preserves the original ClickHouse native verification path', async () => {
  vi.stubEnv('CLICKHOUSE_URL', 'http://clickhouse.fixture');
  mocks.query.mockResolvedValue([{ created_at: new Date(1000) }]);
  mocks.stats.mockResolvedValue({ pageviews: 4 });
  mocks.dates.mockResolvedValue({ startDate: new Date(1100), endDate: new Date(2200) });
  expect(await collectionPresence('fixture')).toEqual({
    pageviews: 4,
    firstAt: new Date(1100).toISOString(),
    lastAt: new Date(2200).toISOString(),
  });
  expect(mocks.stats).toHaveBeenCalledWith(
    'fixture',
    expect.objectContaining({ startDate: new Date(1000) }),
  );
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes('liekan_raw_website_event'))).toBe(
    false,
  );
});
