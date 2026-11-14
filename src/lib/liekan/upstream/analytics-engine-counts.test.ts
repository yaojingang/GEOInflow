// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  query: vi.fn(),
  insert: vi.fn(),
  command: vi.fn(),
  tx: { $queryRawUnsafe: vi.fn(), $executeRawUnsafe: vi.fn() },
}));
vi.mock('./analytics-engine-clickhouse', async () => ({
  ...(await vi.importActual('./analytics-engine-clickhouse')),
  engineConnection: () => ({ key: 'connection' }),
  engineQuery: m.query,
  engineClient: () => ({ insert: m.insert, command: m.command }),
}));
vi.mock('./analytics-engine', () => ({ engineVersions: async () => ({ version: 'source' }) }));
vi.mock('./analysis-rollups-db', () => ({ analysisTransaction: (load: any) => load(m.tx) }));
vi.mock('./query-snapshot', () => ({ getQuerySnapshot: () => undefined }));
import {
  countsDigest,
  countScopes,
  emptyCountRow,
  normalizeCounts,
  prepareCounts,
  readClickHouseLogCounts,
} from './analytics-engine-counts';
const rows = () =>
  countScopes.map(identity => ({
    ...emptyCountRow(identity),
    requests: '17',
    ai: '11',
    abnormal: '3',
    legacyRequests: '2',
    unclassifiedRequests: '1',
    classifications: ['b', 'a'],
  }));
const input = () => ({
  websiteId: 'site',
  startDate: new Date('2026-01-01T00:00:00Z'),
  endDate: new Date('2026-01-01T01:00:00Z'),
  crawlerMetricsVersion: 1 as const,
});
beforeEach(() => {
  vi.resetAllMocks();
  process.env.CLICKHOUSE_URL = '';
  m.tx.$queryRawUnsafe.mockImplementation(async (sql: string) =>
    sql.includes('SELECT enabled')
      ? [
          {
            enabled: true,
            healthy: true,
            connection_hash: 'connection',
            epoch: 1,
            installation_id: 'install',
          },
        ]
      : sql.includes('AS first')
        ? [{ first: input().startDate, last: input().startDate }]
        : [{ generation: 'generation', counts_checksum: countsDigest(rows()) }],
  );
  m.tx.$executeRawUnsafe.mockResolvedValue(0);
  m.query.mockResolvedValue(rows().map(row => ({ ...row, generation: 'generation' })));
});
it('normalizes numeric text and classification ordering without losing precision', () => {
  const value = rows();
  value[0].requests = '9007199254740993';
  expect(normalizeCounts(value)[0].requests).toBe('9007199254740993');
  expect(countsDigest(value)).toBe(countsDigest([...value].reverse()));
  value[0].classifications.push('c');
  expect(countsDigest(value)).not.toBe(countsDigest(rows()));
});
it.each(['missing', 'duplicate', 'unknown', 'negative'])(
  'rejects %s physical count records',
  kind => {
    const value = rows();
    if (kind === 'missing') value.pop();
    if (kind === 'duplicate') value.push(value[0]);
    if (kind === 'unknown') value[0].identity = 'foreign';
    if (kind === 'negative') value[0].requests = '-1';
    expect(() => countsDigest(value)).toThrow();
  },
);
it('reads verified compact records and preserves the exact classification union', async () => {
  expect(await readClickHouseLogCounts(input())).toEqual({
    requests: 17,
    ai: 11,
    abnormal: 3,
    legacyRequests: 2,
    unclassifiedRequests: 1,
    classifications: ['a', 'b'],
  });
  expect(m.query.mock.calls[0][0]).not.toContain('liekan_log_projection_v1');
});
it.each(['missing', 'duplicate', 'altered'])(
  'invalidates a %s compact generation before fallback',
  async kind => {
    const value = rows().map(row => ({ ...row, generation: 'generation' }));
    if (kind === 'missing') value.pop();
    if (kind === 'duplicate') value.push(value[0]);
    if (kind === 'altered') value[0].requests = '18';
    m.query.mockResolvedValue(value);
    expect(await readClickHouseLogCounts(input())).toBeNull();
    expect(m.tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("error_code='engine-counts-lost'"),
      'site',
      ['generation'],
    );
  },
);
it('rejects unverified coverage, legacy semantics, partial hours and filters', async () => {
  m.tx.$queryRawUnsafe.mockResolvedValueOnce([{ enabled: false }]);
  expect(await readClickHouseLogCounts(input())).toBeNull();
  for (const extra of [
    { crawlerMetricsVersion: undefined },
    { startDate: new Date(+input().startDate + 1) },
    { filters: { search: 'x' } },
  ])
    expect(await readClickHouseLogCounts({ ...input(), ...extra })).toBeNull();
  expect(m.query).not.toHaveBeenCalled();
});
it('keeps query failures local without publishing a zero or mutating source data', async () => {
  m.query.mockRejectedValue(new Error('connection unavailable'));
  expect(await readClickHouseLogCounts(input())).toBeNull();
  expect(m.tx.$executeRawUnsafe).not.toHaveBeenCalled();
});
it('does not round an unsafe exact result', async () => {
  const value = rows();
  value[0].requests = '9007199254740993';
  m.query.mockResolvedValue(value.map(row => ({ ...row, generation: 'generation' })));
  m.tx.$queryRawUnsafe.mockImplementation(async (sql: string) =>
    sql.includes('SELECT enabled')
      ? [
          {
            enabled: true,
            healthy: true,
            connection_hash: 'connection',
            epoch: 1,
            installation_id: 'install',
          },
        ]
      : sql.includes('AS first')
        ? [{ first: input().startDate, last: input().startDate }]
        : [{ generation: 'generation', counts_checksum: countsDigest(value) }],
  );
  expect(await readClickHouseLogCounts(input())).toBeNull();
});
it('recovers a committed insert whose response was lost without inserting twice', async () => {
  const aggregate = rows().map(row => ({ ...row, rawRows: '17' }));
  m.query
    .mockResolvedValueOnce(aggregate)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(aggregate)
    .mockResolvedValueOnce(rows());
  m.insert.mockRejectedValueOnce(new Error('response lost'));
  await expect(prepareCounts({}, '17')).rejects.toThrow('response lost');
  expect(await prepareCounts({}, '17')).toBe(countsDigest(rows()));
  expect(m.insert).toHaveBeenCalledTimes(1);
});

it.each(['0', '18'])(
  'rejects a changed raw total of %s before writing statistics',
  async rawRows => {
    m.query.mockResolvedValue(rows().map(row => ({ ...row, rawRows })));
    await expect(prepareCounts({}, '17')).rejects.toThrow('engine-count-mismatch');
    expect(m.insert).not.toHaveBeenCalled();
  },
);

it.each(['0', '1'])('accepts zero eligible counts from %s raw rows', async rawRows => {
  const empty = countScopes.map(emptyCountRow);
  m.query
    .mockResolvedValueOnce(empty.map(row => ({ ...row, rawRows })))
    .mockResolvedValueOnce(empty);
  expect(await prepareCounts({}, rawRows)).toBe(countsDigest(empty));
  expect(m.insert).not.toHaveBeenCalled();
});

it('bounds all CH batches by one request deadline', async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  m.query.mockImplementation(async () => {
    clock.mockReturnValue(now + 4001);
    return rows().map(row => ({ ...row, generation: 'generation' }));
  });
  try {
    expect(await readClickHouseLogCounts(input())).toBeNull();
    expect(m.query.mock.calls[0][2]).toBe(now + 4000);
  } finally {
    clock.mockRestore();
  }
});

it('registers unknown-table loss for rebuild while preserving raw coverage', async () => {
  m.query.mockRejectedValue(Object.assign(new Error('missing table'), { code: '60' }));
  expect(await readClickHouseLogCounts(input())).toBeNull();
  expect(m.tx.$executeRawUnsafe).toHaveBeenCalledWith(
    expect.stringContaining("error_code='engine-counts-lost'"),
    'site',
    ['generation'],
  );
  expect(m.tx.$executeRawUnsafe.mock.calls[0][0]).not.toMatch(/(?:SET|,)\s*verified_at\s*=/i);
});
