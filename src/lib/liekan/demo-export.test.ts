// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportOfficialDemo } from '../../../scripts/liekan-export-demo.mjs';

const faults = vi.hoisted(() => ({ manifest: false }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: (path: any, options: any) => {
      // Protect the real checked-in fixture while exercising the unfixed exporter.
      if (String(path).includes('/scripts/liekan-demo-data/'))
        throw new Error('Exporter attempted to overwrite the bundled demo');
      return actual.createWriteStream(path, options);
    },
  };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      if (faults.manifest && String(args[0]).endsWith('/manifest.json'))
        throw new Error('Injected manifest write failure');
      return actual.writeFile(...args);
    },
  };
});

let root: string;
beforeEach(async () => {
  faults.manifest = false;
  root = await mkdtemp(join(tmpdir(), 'liekan-demo-export-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function emptySyntheticClient() {
  return {
    query: vi.fn(async (sql: string) => ({
      rows: sql.startsWith('SELECT w.name')
        ? [{ name: '猎看官网（示例数据）', domain: 'www.liekan.com', is_demo: true, rules: {} }]
        : sql.startsWith('SELECT greatest')
          ? [{ anchor: '2026-10-24T00:00:00Z' }]
          : sql.startsWith('SELECT count(*) FILTER')
            ? [{ pageviews: 0, conversionEvents: 0, performanceEvents: 0 }]
            : sql.startsWith('SELECT count(*)')
              ? [{ count: 0 }]
              : [],
    })),
  };
}

it('exports a separate candidate bundle with a matching fixture checksum', async () => {
  const result = await exportOfficialDemo(emptySyntheticClient(), {
    schema: 'public',
    outputRoot: pathToFileURL(root + '/'),
  });
  expect(result.directory.startsWith(root + '/')).toBe(true);
  const manifest = JSON.parse(await readFile(join(result.directory, 'manifest.json'), 'utf8'));
  const fixture = await readFile(join(result.directory, manifest.file));
  expect(createHash('sha256').update(fixture).digest('hex')).toBe(manifest.sha256);
  const catalog = await readFile(join(result.directory, manifest.catalog.file));
  expect(createHash('sha256').update(catalog).digest('hex')).toBe(manifest.catalog.sha256);
});

it('removes an incomplete private candidate when the manifest write fails', async () => {
  faults.manifest = true;
  await expect(
    exportOfficialDemo(emptySyntheticClient(), {
      schema: 'public',
      outputRoot: pathToFileURL(root + '/'),
    }),
  ).rejects.toThrow('Injected manifest write failure');
  expect(await readdir(root)).toEqual([]);
});
