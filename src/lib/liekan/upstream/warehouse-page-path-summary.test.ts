// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WarehouseEvidenceSpool } from './warehouse-evidence-spool';
import { summarizeWarehousePagePaths } from './warehouse-page-path-summary';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'warehouse-page-summary-'));
  vi.stubEnv('LIEKAN_EXPORT_DIRECTORY', directory);
  vi.stubEnv('LIEKAN_EXPORT_MIN_FREE_BYTES', '0');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it('keeps full-population cards, directory tie order, nullable depths and original catalog order', async () => {
  const spool = await WarehouseEvidenceSpool.create();
  try {
    const pages = await spool.write<any>(async emit => {
      for (const row of [
        { path: '/a/1', requests: 30, catalog: { linkDepth: 0 } },
        { path: '/a/2', requests: 30, catalog: { linkDepth: 4 } },
        { path: '/b/1', requests: 60, catalog: { linkDepth: null } },
        { path: '/c/1', requests: 60 },
      ])
        await emit(row);
    });
    const summary = await summarizeWarehousePagePaths(spool, pages, async emit => {
      for (const path of ['/z', '/a/2', '/missing', '/a/1']) await emit({ path });
    });
    expect(summary).toMatchObject({
      pageCount: 4,
      repeated: 2,
      maximum: 60,
      catalogCount: 4,
      covered: 2,
      depthCount: 2,
      depthTotal: 4,
    });
    expect(summary.topDirectories).toEqual([
      { name: '/b/', count: 60 },
      { name: '/c/', count: 60 },
      { name: '/a/', count: 60 },
    ]);
    expect((await summary.blind.page(0, 20)).map(row => row.path)).toEqual(['/z', '/missing']);
  } finally {
    await spool.dispose();
  }
  expect(await readdir(directory)).toEqual([]);
});

it('handles more than 100000 paths without truncating cards or the final blind page', async () => {
  const spool = await WarehouseEvidenceSpool.create();
  try {
    const pages = await spool.write<any>(async emit => {
      for (let n = 0; n < 100005; n++)
        await emit({
          path: `/seen/${String(n).padStart(6, '0')}`,
          requests: 50,
          catalog: n % 2 ? { linkDepth: 2 } : undefined,
        });
    });
    const summary = await summarizeWarehousePagePaths(spool, pages, async emit => {
      for (let n = 0; n < 100005; n++) await emit({ path: `/blind/${String(n).padStart(6, '0')}` });
      await emit({ path: '/seen/000000' });
    });
    expect(summary).toMatchObject({
      pageCount: 100005,
      repeated: 100005,
      catalogCount: 100006,
      covered: 1,
      depthCount: 50002,
      depthTotal: 100004,
    });
    expect(summary.topDirectories).toEqual([{ name: '/seen/', count: 5000250 }]);
    expect(await summary.blind.count()).toBe(100005);
    expect((await summary.blind.page(100000, 20)).map(row => row.path)).toEqual([
      '/blind/100000',
      '/blind/100001',
      '/blind/100002',
      '/blind/100003',
      '/blind/100004',
    ]);
  } finally {
    await spool.dispose();
  }
  expect(await readdir(directory)).toEqual([]);
}, 120000);
