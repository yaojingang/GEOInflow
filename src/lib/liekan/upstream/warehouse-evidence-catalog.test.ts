// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../warehouse/reader-runtime', () => ({
  warehouseReader: () => ({ db: { read: mocks.read } }),
}));
vi.mock('./warehouse-report-snapshot', () => ({
  warehouseReportMetadata: async () => ({ boundary: { epoch: '1' }, catalogRevision: '5' }),
}));

import { warehouseEvidenceCatalog } from './warehouse-evidence-catalog';

beforeEach(() => {
  mocks.read.mockReset();
});
it('hashes every ordered catalog row with the original JSON/date representation using bounded pages', async () => {
  const rows = Array.from({ length: 1005 }, (_, i) => ({
    path: '/path-' + String(i).padStart(4, '0'),
    updatedAt: new Date(1700000000000 + i),
  }));
  mocks.read.mockImplementation(async (sql: string, args: any[]) => {
    if (sql.includes('FROM liekan_warehouse_site'))
      return [{ epoch: '1', catalog_revision: '5', state: 'active' }];
    expect(sql).toContain('LIMIT 1000');
    return rows.filter(row => args[1] === null || row.path > args[1]).slice(0, 1000);
  });
  expect(await warehouseEvidenceCatalog('site')).toEqual({
    count: 1005,
    hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  });
  expect(mocks.read.mock.calls.filter(([sql]) => sql.includes('FROM liekan_catalog'))).toHaveLength(
    3,
  );
});
it('cancels before reading catalog pages and rejects a changed catalog revision', async () => {
  const signal = AbortSignal.abort();
  await expect(warehouseEvidenceCatalog('site', signal)).rejects.toMatchObject({ status: 499 });
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.read.mockResolvedValue([{ epoch: '1', catalog_revision: '6', state: 'active' }]);
  await expect(warehouseEvidenceCatalog('site')).rejects.toThrow('warehouse-catalog-changed');
});
