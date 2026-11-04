// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  stream: vi.fn(),
  pin: vi.fn(),
  population: vi.fn(),
  note: vi.fn(),
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
  nativeRelations: () => [
    'website_event AS (SELECT * FROM accepted_events)',
    'session_data AS (SELECT * FROM accepted_properties)',
  ],
}));
vi.mock('./warehouse-report-snapshot', () => ({
  withinWarehouseReport: (work: () => unknown) => work(),
  warehouseReportMetadata: mocks.pin,
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
import { warehouseNativeQuery, warehouseNativeStringStream } from './warehouse-native-query';
import { warehouseTime } from '../warehouse/fact-input';

beforeEach(() => {
  vi.clearAllMocks();
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
