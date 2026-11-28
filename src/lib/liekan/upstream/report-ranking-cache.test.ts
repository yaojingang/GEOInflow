import { beforeEach, describe, expect, it, vi } from 'vitest';
const redis = vi.hoisted(() => ({ enabled: true, command: vi.fn() }));
const artifact = vi.hoisted(() => ({ query: vi.fn(), control: 'a' }));
vi.mock('./analytics-redis', () => ({ analyticsRedis: redis }));
vi.mock('./query-cache', async () => ({
  analyticsInfrastructureKey: (n: string, v: unknown) => JSON.stringify([n, v]),
}));
vi.mock('./warehouse-report-snapshot', () => ({
  warehouseReportMetadata: async () => ({
    boundary: { websiteId: 'a', epoch: '1', publication: '2' },
  }),
  warehouseControlFingerprint: () => artifact.control,
  warehouseReportQuery: artifact.query,
}));
import { rankingCacheKey, readRankingCache, saveRankingCache } from './report-ranking-cache';
import { prefillReportRankings, readReportRanking } from './report-ranking-artifact';

const scope = {
  boundary: { websiteId: 'a', epoch: '1', publication: '2', deletionRevision: '0' },
  control: 'policy-1',
  snapshot: 'snapshot',
  build: 'build',
  table: 'topBody',
  total: 2,
};
const slice = { rows: [{ page: '/a' }, { page: '/b' }], geography: [null, null] };
describe('versioned ranking blocks', () => {
  beforeEach(() => {
    redis.command.mockReset();
  });
  it('round trips a verified bounded block and rejects corruption', async () => {
    await saveRankingCache(scope, 1, 20, slice);
    const command = redis.command.mock.calls[0][0];
    expect(command.slice(0, 2)).toEqual(['SET', rankingCacheKey(scope, 1, 20)]);
    redis.command.mockResolvedValue(command[2]);
    expect(await readRankingCache(scope, 1, 20)).toEqual(slice);
    redis.command.mockResolvedValue(command[2].replace('/a', '/c'));
    expect(await readRankingCache(scope, 1, 20)).toBeUndefined();
  });
  it('separates builds, controls, deletion fences, epochs, pages and totals', () => {
    const key = rankingCacheKey(scope, 1, 20);
    for (const change of [
      { build: 'late-old-build' },
      { control: 'policy-2' },
      { total: 3 },
      { boundary: { ...scope.boundary, deletionRevision: '1' } },
      { boundary: { ...scope.boundary, epoch: '2' } },
    ])
      expect(rankingCacheKey({ ...scope, ...change }, 1, 20)).not.toBe(key);
    expect(rankingCacheKey(scope, 2, 20)).not.toBe(key);
    expect(rankingCacheKey(scope, 1, 10)).not.toBe(key);
  });
  it('treats Redis failure, incomplete blocks and other version payloads as misses', async () => {
    redis.command.mockResolvedValue(null);
    expect(await readRankingCache(scope, 1, 20)).toBeUndefined();
    await saveRankingCache(scope, 1, 20, { rows: [], geography: [] });
    redis.command.mockResolvedValue(redis.command.mock.calls.at(-1)[0][2]);
    expect(await readRankingCache(scope, 1, 20)).toBeUndefined();
    await saveRankingCache(scope, 1, 20, slice);
    redis.command.mockResolvedValue(redis.command.mock.calls.at(-1)[0][2]);
    expect(await readRankingCache({ ...scope, control: 'new' }, 1, 20)).toBeUndefined();
  });
  it('bounds memory and keys without limiting deep pagination', async () => {
    await saveRankingCache(scope, 4, 20, slice);
    await saveRankingCache(scope, 1, 20, {
      rows: [{ page: 'x'.repeat(300000) }],
      geography: [null],
    });
    expect(redis.command).not.toHaveBeenCalled();
  });
  it('verifies three pages in one CH read, serves the block, and misses after control change', async () => {
    const data = new Map<string, string>();
    redis.command.mockImplementation(async ([op, key, value]) => {
      if (op === 'SET') {
        data.set(key, value);
        return 'OK';
      }
      return data.get(key) ?? null;
    });
    artifact.query.mockReset();
    artifact.control = 'a';
    artifact.query.mockImplementation(async (_site, _sql, params) =>
      Array.from(
        { length: Math.min(65, Number(params.rankEnd)) - Number(params.rankOffset) },
        (_, i) => ({
          ordinal: Number(params.rankOffset) + i,
          row: JSON.stringify({ page: String(Number(params.rankOffset) + i) }),
          geography: null,
          variants: 1,
        }),
      ),
    );
    const ranks = { build: 'b', counts: { topBody: 65 } };
    await prefillReportRankings('a', 's', ranks, { topBody: { total: 65, pageSize: 20, page: 1 } });
    expect(artifact.query).toHaveBeenCalledTimes(1);
    const page = await readReportRanking('a', 's', ranks, 'topBody', 2, 20, 65);
    expect(page.rows[0]).toEqual({ page: '20' });
    expect(artifact.query).toHaveBeenCalledTimes(1);
    artifact.control = 'b';
    await readReportRanking('a', 's', ranks, 'topBody', 2, 20, 65);
    expect(artifact.query).toHaveBeenCalledTimes(2);
    await readReportRanking('a', 's', ranks, 'topBody', 4, 20, 65);
    expect(artifact.query).toHaveBeenCalledTimes(3);
  });
  it('never prepopulates incomplete or conflicting artifacts', async () => {
    redis.command.mockResolvedValue(null);
    artifact.query.mockResolvedValue([{ ordinal: 0, row: '{}', geography: null, variants: 2 }]);
    await expect(
      prefillReportRankings(
        'a',
        's',
        { build: 'b', counts: { topBody: 1 } },
        { topBody: { total: 1, pageSize: 20, page: 1 } },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(redis.command).not.toHaveBeenCalled();
  });
});
