// @vitest-environment node
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WarehouseEvidenceSpool } from './warehouse-evidence-spool';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'warehouse-spool-test-'));
  vi.stubEnv('LIEKAN_EXPORT_DIRECTORY', directory);
  vi.stubEnv('LIEKAN_EXPORT_MIN_FREE_BYTES', '0');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('bounded evidence external sort', () => {
  it('retains stable order across more than 16 runs and carry levels', async () => {
    const spool = await WarehouseEvidenceSpool.create();
    try {
      const count = 2048 * 18 + 1;
      const rows = await spool.sort<{ ordinal: number }>(
        async emit => {
          for (let ordinal = 0; ordinal < count; ordinal++) await emit({ ordinal });
        },
        () => 0,
      );
      let ordinal = 0;
      for await (const row of rows.iterate()) expect(row.ordinal).toBe(ordinal++);
      expect(ordinal).toBe(count);
      expect(await rows.page(count - 2, 20)).toEqual([
        { ordinal: count - 2 },
        { ordinal: count - 1 },
      ]);
      expect((await stat(spool.directory)).mode & 0o777).toBe(0o700);
    } finally {
      await spool.dispose();
    }
    expect(await readdir(directory)).toEqual([]);
  }, 120000);

  it('propagates cancellation and removes all partially built runs', async () => {
    const abort = new AbortController();
    const spool = await WarehouseEvidenceSpool.create(abort.signal);
    try {
      await expect(
        spool.sort(
          async emit => {
            for (let n = 0; n < 4096; n++) await emit({ n });
            abort.abort();
            for (let n = 4096; n < 8192; n++) await emit({ n });
          },
          (a: any, b: any) => b.n - a.n,
        ),
      ).rejects.toThrow('统计读取已取消');
    } finally {
      await spool.dispose();
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it('surfaces a missing intermediate file instead of returning a truncated page', async () => {
    const spool = await WarehouseEvidenceSpool.create();
    try {
      const rows = await spool.write(async emit => {
        await emit({ n: 1 });
      });
      await rm(rows.path);
      await expect(rows.page(0, 20)).rejects.toThrow('ENOENT');
    } finally {
      await spool.dispose();
    }
  });

  it('fingerprints complete ordered output independently of paging and changes with a later row', async () => {
    const spool = await WarehouseEvidenceSpool.create();
    try {
      const rows = await spool.write(async emit => {
        for (let n = 0; n < 45; n++) await emit({ n });
      });
      const expected = createHash('sha256');
      for (let n = 0; n < 45; n++) expected.update(JSON.stringify({ n }) + '\n');
      await rows.page(0, 20);
      expect(await rows.fingerprint()).toBe(expected.digest('hex'));
      const changed = await spool.write(async emit => {
        for (let n = 0; n < 45; n++) await emit({ n: n === 44 ? 99 : n });
      });
      expect(await changed.fingerprint()).not.toBe(await rows.fingerprint());
    } finally {
      await spool.dispose();
    }
  });
});
