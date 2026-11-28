import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), stream: vi.fn() }));
vi.mock('./warehouse-report-snapshot', () => ({
  warehouseReportQuery: mocks.query,
  warehouseReportStream: mocks.stream,
}));

import { evidenceQuerySchema } from '../contracts/traffic-evidence';
import {
  registerWarehouseEvidenceRows,
  warehouseEvidenceTable,
  withWarehouseEvidenceResources,
} from './warehouse-evidence-table';

it('counts and pages a complete large result without fetching preceding rows into JS', async () => {
  mocks.query.mockResolvedValueOnce([{ total: '100005' }]).mockResolvedValueOnce([{ id: 'last' }]);
  const table = warehouseEvidenceTable('site', 'SELECT id FROM facts', {}, 'id');
  expect(await table.count()).toBe(100005);
  expect(await table.page(100000, 20)).toEqual([{ id: 'last' }]);
  expect(mocks.query.mock.calls.at(-1)[1]).toContain(
    'LIMIT {evidenceLimit:UInt64} OFFSET {evidenceOffset:UInt64}',
  );
  expect(mocks.query.mock.calls.at(-1)[2]).toMatchObject({
    evidenceLimit: 20,
    evidenceOffset: 100000,
  });
  expect(evidenceQuerySchema.parse({ startAt: 1, endAt: 2, page: 5001 }).page).toBe(5001);
});
it('keeps the complete source alive through nested export work and cleans it on error', async () => {
  const dispose = vi.fn();
  await expect(
    withWarehouseEvidenceResources(async () => {
      await withWarehouseEvidenceResources(async () => {
        registerWarehouseEvidenceRows({
          count: async () => 1,
          fingerprint: async () => 'hash',
          page: async () => [],
          stream: async () => {},
          dispose,
        });
      });
      expect(dispose).not.toHaveBeenCalled();
      throw new Error('after export');
    }),
  ).rejects.toThrow('after export');
  expect(dispose).toHaveBeenCalledOnce();
});
it('streams the unbounded query through the export admission path', async () => {
  const controller = new AbortController(),
    consume = vi.fn();
  const table = warehouseEvidenceTable('site', 'SELECT id FROM facts', {}, 'id');
  await table.stream(consume, controller.signal);
  expect(mocks.stream.mock.calls.at(-1)).toEqual([
    'site',
    'SELECT id FROM facts ORDER BY id',
    {},
    expect.any(Function),
    controller.signal,
    true,
  ]);
});
it('includes external row-mapping gates in the fingerprint without changing SQL counts', async () => {
  mocks.query.mockResolvedValue([{ total: '1', rowHash: '123' }]);
  const one = warehouseEvidenceTable('site', 'SELECT id FROM facts', {}, 'id', row => row, {
    coverage: 'partial',
  });
  const two = warehouseEvidenceTable('site', 'SELECT id FROM facts', {}, 'id', row => row, {
    coverage: 'complete',
  });
  expect(await one.count()).toBe(1);
  expect(await two.count()).toBe(1);
  expect(await one.fingerprint()).not.toBe(await two.fingerprint());
});
