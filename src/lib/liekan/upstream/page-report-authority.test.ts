// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  warehouse: vi.fn(),
  fragments: vi.fn(),
  prepare: vi.fn(),
  dispose: vi.fn(),
  build: vi.fn(),
}));
vi.mock('../warehouse/runtime', () => ({ warehouseEnabled: m.warehouse }));
vi.mock('./report-fragments', () => ({ withReportFragments: m.fragments }));
vi.mock('./warehouse-page-report', () => ({ prepareWarehousePageReport: m.prepare }));
vi.mock('../report', () => ({ buildReport: m.build }));
vi.mock('./keywords', () => ({ readKeywordPage: vi.fn() }));
vi.mock('./crawler-registry-context', () => ({
  withPublishedRegistry: (load: () => unknown) => load(),
}));
vi.mock('./server', () => ({
  query: vi.fn(),
  reportSnapshot: (load: () => unknown) => load(),
}));
vi.mock('./report-evidence-view', () => ({
  attachReportEvidenceView: (report: unknown) => report,
}));

import { computeWarehouseOverview, readPageReport } from './page-report';

const website = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Fixture',
  domain: 'example.test',
};
const input = { resource: 'logs', startAt: 0, endAt: 1000, timezone: 'UTC' };

beforeEach(() => {
  vi.resetAllMocks();
  m.fragments.mockImplementation((_site, load) => load());
  m.prepare.mockResolvedValue({ dispose: m.dispose });
  m.build.mockResolvedValue({
    contractVersion: 2,
    website,
    range: { startAt: 0, endAt: 1000, timezone: 'UTC' },
    states: { human: 'empty', logs: 'empty', catalog: 'not_connected', goals: 'not_connected' },
    cards: [],
    charts: {},
    tables: { logBody: [{ path: '/fixture', count: 3 }] },
    insights: [],
    meta: {
      demo: false,
      canManage: false,
      latestImportAt: null,
      ruleCount: 0,
      snapshot: { dataThrough: 1000, state: 'ready', intervalMs: 300000, updateError: true },
    },
  });
});

it.each([true, false])(
  'selects the report preparation and fragment owner for warehouse=%s',
  async warehouse => {
    m.warehouse.mockReturnValue(warehouse);
    const result = await readPageReport(website, input);
    expect(result.value.tables.logBody).toEqual([{ path: '/fixture', count: 3 }]);
    expect(result.value.meta.snapshot.updateError).toBe(true);
    if (warehouse) {
      expect(m.fragments).not.toHaveBeenCalled();
      expect(m.prepare).toHaveBeenCalledWith(website, expect.objectContaining(input), false);
      expect(m.build.mock.calls[0][6]).toEqual({ dispose: m.dispose });
      expect(m.dispose).toHaveBeenCalledOnce();
    } else {
      expect(m.fragments).toHaveBeenCalledWith(website.id, expect.any(Function));
      expect(m.prepare).not.toHaveBeenCalled();
      expect(m.build.mock.calls[0][6]).toBeUndefined();
      expect(m.dispose).not.toHaveBeenCalled();
    }
  },
);

it('releases the ClickHouse page materialization when report assembly fails', async () => {
  m.warehouse.mockReturnValue(true);
  m.build.mockRejectedValue(new Error('report assembly failed'));
  await expect(readPageReport(website, input)).rejects.toThrow('report assembly failed');
  expect(m.dispose).toHaveBeenCalledOnce();
  expect(m.fragments).not.toHaveBeenCalled();
});

it('stores later ranking rows separately from the first page of the report', async () => {
  m.warehouse.mockReturnValue(true);
  const report = await m.build();
  const rows = Array.from({ length: 60 }, (_, i) => ({ path: `/rank-${i + 1}` }));
  m.build.mockResolvedValue({
    ...report,
    tables: { topBody: rows },
    meta: { ...report.meta, tablePages: { topBody: { page: 1, pageSize: 20, total: 75 } } },
  });
  const overview = { ...input, resource: 'overview' };
  const result = await computeWarehouseOverview(website, overview);
  expect(m.prepare).toHaveBeenCalledWith(website, expect.objectContaining(overview), true);
  expect(result.tables.topBody).toEqual(rows.slice(0, 20));
  expect(result.overviewRanking).toEqual({ table: 'topBody', rows: rows.slice(20) });
});
