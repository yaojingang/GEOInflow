// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  stream: vi.fn(),
  pin: vi.fn(),
  population: vi.fn(),
  note: vi.fn(),
  selection: vi.fn(),
  relations: vi.fn(),
  analysis: false,
}));
vi.mock('./warehouse-analysis-model', () => ({
  withAvailableAnalysisModel: async (_site: string, work: () => unknown, selection: unknown) => {
    mocks.selection(selection);
    const previous = mocks.analysis;
    mocks.analysis = true;
    try {
      return await work();
    } finally {
      mocks.analysis = previous;
    }
  },
}));
vi.mock('../warehouse/reader-runtime', () => ({
  warehouseReader: () => ({
    admission: { run: (work: () => unknown) => work() },
    ch: { query: mocks.query },
  }),
}));
vi.mock('../warehouse/reporting-relations', () => ({
  reportingParameters: () => ({ wh_site: 'trusted-site', wh_epoch: '7' }),
}));
vi.mock('./warehouse-native-relations', () => ({
  nativeRelations: (...args: unknown[]) => {
    mocks.relations(...args);
    return [
      'website_event AS (SELECT * FROM accepted_events)',
      'session_data AS (SELECT * FROM accepted_properties)',
    ];
  },
}));
vi.mock('./warehouse-report-snapshot', () => ({
  withinWarehouseReport: (work: () => unknown) => work(),
  warehouseReportMetadata: mocks.pin,
  frozenCountKey: async () => 'fixture-count',
  readFrozenCount: () => undefined,
  saveFrozenCount: () => {},
  warehouseReportResponse: async (
    _site: string,
    query: string,
    params: Record<string, unknown>,
    format: string,
  ) =>
    (
      await mocks.query({
        query,
        query_params: { ...params, wh_site: 'trusted-site', wh_epoch: '7' },
        format,
      })
    ).json(),
  warehouseReportStream: mocks.stream,
}));
vi.mock('./geography-query', () => ({
  withClickHouseGeographySQL: (query: string) => query,
  geographyQueryParams: () => ({ geo_country: 'Geo', unused: 'skip' }),
}));
vi.mock('./browser-population', () => ({
  readBrowserPopulation: mocks.population,
  applyNativePopulation: (rows: unknown) => rows,
}));
vi.mock('./cache-context', () => ({ noteBrowserPopulation: mocks.note }));
import {
  warehouseNativePage,
  warehouseNativeQuery,
  warehouseNativeStringStream,
} from './warehouse-native-query';
import { warehouseTime } from '../warehouse/fact-input';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.analysis = false;
  mocks.query.mockResolvedValue({
    json: async () => ({
      meta: [
        { name: 'count', type: 'UInt64' },
        { name: 'id', type: 'UUID' },
      ],
      data: [{ count: '2', id: 'identity' }],
    }),
  });
  mocks.pin.mockResolvedValue({});
  mocks.population.mockResolvedValue({ identity: { status: 'complete' } });
  mocks.stream.mockImplementation(async (_site, _sql, _params, consume) => {
    await consume([{ id: 'identity', referrer: null }]);
  });
});

it('keeps pagination population checks inside the same verified analysis context', async () => {
  mocks.population.mockImplementation(async () => {
    expect(mocks.analysis).toBe(true);
    return { identity: { status: 'complete' } };
  });
  mocks.query.mockResolvedValue({
    json: async () => ({
      meta: [
        { name: '_liekan_page_count', type: 'UInt64' },
        { name: 'id', type: 'String' },
      ],
      data: [{ _liekan_page_count: '1', id: 'one' }],
    }),
  });
  const result = await warehouseNativePage(
    'SELECT id FROM website_event',
    {
      websiteId: 'site',
      startDate: new Date('2026-11-01T00:00:00Z'),
      endDate: new Date('2026-11-02T00:00:00Z'),
    },
    { page: 1, pageSize: 20 },
    'getWebsiteSessions',
  );
  expect(result.count).toBe(1);
  expect(mocks.analysis).toBe(false);
  expect(mocks.population).toHaveBeenCalledTimes(2);
});

it('shares versioned native relation and parameter preparation without altering ordinary numeric results', async () => {
  const startDate = new Date('2026-11-03T00:00:00Z');
  const params = { websiteId: 'site', startDate, wh_site: 'untrusted', unusedInput: 'kept' };
  const sql =
    'WITH selected AS (SELECT * FROM website_event) SELECT uniq(session_id),{geo_country:String} FROM session_data FINAL';
  expect(await warehouseNativeQuery(sql, params, 'fixture')).toEqual([
    { count: 2, id: 'identity' },
  ]);
  const native = mocks.query.mock.calls[0][0];
  expect(native.query).toContain(
    'WITH website_event AS (SELECT * FROM accepted_events),session_data AS (SELECT * FROM accepted_properties), selected',
  );
  expect(native.query).toContain('uniqExact(session_id)');
  expect(native.query).not.toContain('FINAL');
  expect(native.query_params).toMatchObject({
    websiteId: 'site',
    startDate: warehouseTime(startDate),
    wh_site: 'trusted-site',
    wh_epoch: '7',
    geo_country: 'Geo',
  });
  expect(native.query_params.unused).toBeUndefined();
  expect(mocks.note).toHaveBeenCalledWith('site', { identity: { status: 'complete' } });

  const consume = vi.fn(async (_rows: unknown) => {}),
    signal = new AbortController().signal;
  await warehouseNativeStringStream(sql, params, consume, signal);
  expect(mocks.stream).toHaveBeenCalledWith(
    'site',
    `${native.query} SETTINGS group_by_use_nulls=1`,
    expect.objectContaining({ startDate: warehouseTime(startDate), geo_country: 'Geo' }),
    consume,
    signal,
  );
  expect(consume).toHaveBeenCalledWith([{ id: 'identity', referrer: null }]);
});

it('rejects a streaming query without an explicit website before invoking the reader', async () => {
  await expect(
    warehouseNativeStringStream('SELECT id FROM website_event', {}, async () => {}),
  ).rejects.toThrow('warehouse-native-site-required');
  expect(mocks.stream).not.toHaveBeenCalled();
});

it('bounds audited totals and model selection to both report and disjoint cohort windows', async () => {
  const params = {
    websiteId: 'trusted-site',
    startDate: new Date('2026-11-13T00:00:00Z'),
    endDate: new Date('2026-11-14T00:00:00Z'),
    cohort_startDate: new Date('2026-11-01T00:00:00Z'),
    cohort_endDate: new Date('2026-11-02T00:00:00Z'),
  };
  await warehouseNativeQuery('select count(*) from website_event', params, 'getWebsiteStats');
  const window = { start: +params.cohort_startDate, end: +params.endDate };
  expect(mocks.relations.mock.calls[0][1]).toEqual(window);
  expect(mocks.selection).toHaveBeenCalledWith({ kinds: ['browser'], ...window });
  mocks.relations.mockClear();
  await warehouseNativeQuery('select count(*) from website_event', params, 'identity-history');
  expect(mocks.relations.mock.calls[0][1]).toBeUndefined();
});
