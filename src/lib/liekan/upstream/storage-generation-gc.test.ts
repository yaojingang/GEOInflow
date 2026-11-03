// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisTx } from './analysis-rollups-model';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  capacity: { siteBytes: '0', globalBytes: '0', siteLimit: 1024 ** 3, globalLimit: 8 * 1024 ** 3 },
}));
vi.mock('./server', () => ({
  primary: vi.fn(),
  LiekanError: class extends Error {},
  lockWritableWebsite: vi.fn(),
}));
vi.mock('./analysis-rollups-db', async importOriginal => ({
  ...(await importOriginal<typeof import('./analysis-rollups-db')>()),
  analysisTransaction: async (work: (tx: AnalysisTx) => Promise<unknown>) =>
    work({ $queryRawUnsafe: h.query, $executeRawUnsafe: h.execute }),
  analysisVersions: async () => ({ engine: 'test-v1' }),
  analysisCapacity: async () => h.capacity,
}));
vi.mock('./analysis-rollups-discovery', () => ({ discoverAnalysisRollups: vi.fn() }));
vi.mock('./browser-detail-facts', () => ({ buildBrowserDetailChunk: vi.fn() }));

import { assertAnalysisGenerationWritable, chargeAnalysisGeneration } from './analysis-rollups-db';
import { runOneAnalysisWorkUnit } from './analysis-rollups-worker';
import { collectGenerationBatch } from './storage-generation-gc';

const site = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
const cutoff = new Date('2026-02-01T00:00:00Z');
const tx: AnalysisTx = { $queryRawUnsafe: h.query, $executeRawUnsafe: h.execute };

describe('generation GC orchestration and publication fencing', () => {
  beforeEach(() => {
    h.query.mockReset();
    h.execute.mockReset().mockResolvedValue(1);
    h.capacity = {
      siteBytes: '0',
      globalBytes: '0',
      siteLimit: 1024 ** 3,
      globalLimit: 8 * 1024 ** 3,
    };
  });
  it.each([0, -1, 1.5, 2001, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid row budget %s before querying',
    async limit => {
      await expect(collectGenerationBatch(tx, site, cutoff, limit)).rejects.toThrow(
        'storage-generation-batch-limit-invalid',
      );
      expect(h.query).not.toHaveBeenCalled();
      expect(h.execute).not.toHaveBeenCalled();
    },
  );
  it.each([0, -1, 1.5, 21, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid generation budget %s before querying',
    async maxGenerations => {
      await expect(
        collectGenerationBatch(tx, site, cutoff, 2000, undefined, maxGenerations),
      ).rejects.toThrow('storage-generation-count-limit-invalid');
      expect(h.query).not.toHaveBeenCalled();
      expect(h.execute).not.toHaveBeenCalled();
    },
  );
  it('binds the production generation budget to both candidate selection limits', async () => {
    h.query.mockResolvedValueOnce([]);
    await collectGenerationBatch(tx, site, cutoff, 2000, undefined, 4);
    expect(h.query.mock.calls[0]).toEqual([
      expect.stringContaining('LIMIT $4::int FOR UPDATE'),
      site,
      cutoff,
      null,
      4,
    ]);
    expect(h.query.mock.calls[0][0]).toContain('LIMIT ($4::int-(SELECT count(*) FROM active))');
  });
  it('shares the row budget across tables and checks all families before releasing ledger bytes', async () => {
    h.query
      .mockResolvedValueOnce([{ generation }])
      .mockResolvedValueOnce([{ generations_deleted: 0, released_bytes: '0', more: true }]);
    h.execute.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const run = '33333333-3333-4333-8333-333333333333';
    expect(await collectGenerationBatch(tx, site, cutoff, 3, run)).toEqual({
      rowsDeleted: 3,
      generationsDeleted: 0,
      releasedBytes: '0',
      more: true,
    });
    expect(h.execute.mock.calls).toHaveLength(2);
    expect(h.execute.mock.calls[0]).toEqual([
      expect.stringContaining('DELETE FROM liekan_analysis_log'),
      site,
      [generation],
      3,
    ]);
    expect(h.execute.mock.calls[1]).toEqual([
      expect.stringContaining('DELETE FROM liekan_analysis_path'),
      site,
      [generation],
      1,
    ]);
    for (const [sql] of h.execute.mock.calls) {
      expect(sql).toContain('(f.tableoid,f.ctid)');
      expect(sql).toContain('LIMIT $3');
    }
    const release = h.query.mock.calls[1][0];
    for (const table of ['log', 'path', 'visit', 'browser_detail', 'browser_visit', 'browser_path'])
      expect(release).toContain(`NOT EXISTS(SELECT 1 FROM liekan_analysis_${table}`);
    expect(release).toContain('RETURNING g.generation,g.estimated_bytes');
    expect(release).toContain('g.generation=ANY($2::uuid[])');
    expect(release).toContain('NOT EXISTS(SELECT 1 FROM removed r WHERE r.generation=c.record_id)');
    expect(release).toContain('DELETE FROM liekan_storage_candidate c USING removed r');
    expect(release).toContain("c.kind='generation' AND c.queue_name=''");
    expect(release).toContain(
      'derived_bytes=derived_bytes-(SELECT sum(estimated_bytes) FROM removed)',
    );
    expect(h.query.mock.calls[0][3]).toBe(run);
    expect(h.query.mock.calls[1][4]).toBe(run);
    expect(h.query).toHaveBeenCalledTimes(2);
  });
  it('uses eight database calls for a full batch of twenty generations', async () => {
    const generations = Array.from(
      { length: 20 },
      (_, n) => `${generation.slice(0, -2)}${String(n).padStart(2, '0')}`,
    );
    h.query
      .mockResolvedValueOnce(generations.map(generation => ({ generation })))
      .mockResolvedValueOnce([{ generations_deleted: 20, released_bytes: '2000', more: true }]);
    h.execute.mockResolvedValue(1);
    expect(await collectGenerationBatch(tx, site, cutoff)).toEqual({
      rowsDeleted: 6,
      generationsDeleted: 20,
      releasedBytes: '2000',
      more: true,
    });
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.execute).toHaveBeenCalledTimes(6);
    for (const [sql, websiteId, ids] of h.execute.mock.calls) {
      expect(sql).toContain('f.generation=ANY($2::uuid[])');
      expect(websiteId).toBe(site);
      expect(ids).toEqual(generations);
    }
    expect(h.query.mock.calls[1][2]).toEqual(generations);
  });
  it('streams frozen membership through the candidate primary key before checking each ledger', async () => {
    h.query.mockResolvedValueOnce([]);
    const run = '33333333-3333-4333-8333-333333333333';
    await collectGenerationBatch(tx, site, cutoff, 2000, run, 4);
    const sql = h.query.mock.calls[0][0];
    expect(sql).toContain('FROM liekan_storage_candidate c');
    expect(sql).toContain('CROSS JOIN LATERAL(');
    expect(sql).toContain('g.generation=c.record_id');
    expect(sql).toContain("c.run_id=$3::uuid AND c.kind='generation' AND c.queue_name=''");
    expect(sql).toContain('ORDER BY c.record_id LIMIT $4::int');
    expect(sql).not.toContain('ORDER BY g.updated_at');
    expect(h.query.mock.calls[0].slice(1)).toEqual([site, cutoff, run, 4]);
  });
  it('keeps the site charge unchanged when an in-progress collection rejects a write', async () => {
    h.execute.mockResolvedValueOnce(0);
    await expect(chargeAnalysisGeneration(tx, site, generation, '100')).rejects.toThrow(
      'analysis-generation-collecting',
    );
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0][0]).toContain(
      'WHERE liekan_analysis_generation.gc_started_at IS NULL',
    );
  });
  it('charges new or writable generations and requires an existing writable ledger to publish', async () => {
    await chargeAnalysisGeneration(tx, site, generation, '100');
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.execute.mock.calls[1]).toEqual([
      expect.stringContaining('derived_bytes=derived_bytes+$2'),
      site,
      '100',
    ]);
    h.query.mockResolvedValueOnce([{ generation }]).mockResolvedValueOnce([]);
    await assertAnalysisGenerationWritable(tx, site, generation);
    await expect(assertAnalysisGenerationWritable(tx, site, generation)).rejects.toThrow(
      'analysis-generation-collecting',
    );
    expect(h.query.mock.calls[0][0]).toContain('gc_started_at IS NULL FOR SHARE');
  });
  it.each(['collecting', 'site-reserve', 'global-reserve'])(
    'blocks worker publication before manifest writes for %s',
    async condition => {
      if (condition === 'site-reserve') h.capacity.siteBytes = String(1024 ** 3 - 32 * 1024 ** 2);
      if (condition === 'global-reserve')
        h.capacity.globalBytes = String(8 * 1024 ** 3 - 128 * 1024 ** 2);
      const build = {
        id: '44444444-4444-4444-8444-444444444444',
        website_id: site,
        epoch: 1n,
        actor_id: null,
        family: 'log',
        status: 'running',
        unit_seconds: 3600,
        attempts: 0,
        range_start: new Date('2026-01-01T00:00:00Z'),
        range_end: new Date('2026-01-01T01:00:00Z'),
        checkpoint: {
          generation,
          family: 'log',
          hour: '2026-01-01T00:00:00Z',
          spanEnd: '2026-01-01T01:00:00Z',
          afterId: '__publish__',
          fingerprint: 'proof',
          versions: { engine: 'test-v1' },
          rows: '7',
        },
      };
      h.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith('SELECT b.* FROM liekan_analysis_build')) return [build];
        if (sql.startsWith('SELECT epoch,mode')) return [{ epoch: 1n, mode: 'live' }];
        if (sql.startsWith('SELECT path_expansion'))
          return [{ path_expansion: true, visit_expansion: true }];
        if (sql.includes('AS fingerprint')) return [{ fingerprint: 'proof' }];
        if (sql.startsWith('SELECT * FROM liekan_analysis_build')) return [build];
        if (sql.startsWith('SELECT generation FROM liekan_analysis_generation'))
          return condition === 'collecting' ? [] : [{ generation }];
        throw new Error(`Unexpected worker query: ${sql}`);
      });
      expect(await runOneAnalysisWorkUnit(build.id)).toEqual({ worked: true, buildId: build.id });
      expect(
        h.query.mock.calls.some(([sql]) =>
          sql.startsWith('SELECT generation FROM liekan_analysis_generation'),
        ),
      ).toBe(true);
      expect(
        h.execute.mock.calls.some(([sql]) =>
          /(?:INSERT INTO|DELETE FROM) liekan_analysis_manifest/.test(sql),
        ),
      ).toBe(false);
      expect(
        h.execute.mock.calls.some(
          ([sql, , , status]) =>
            sql.includes('error_code=$4') &&
            status === (condition === 'collecting' ? 'queued' : 'capacity_limited'),
        ),
      ).toBe(true);
    },
  );
});
