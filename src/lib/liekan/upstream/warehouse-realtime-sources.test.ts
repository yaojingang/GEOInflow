// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { warehouseRealtimeSources } from './warehouse-realtime-sources';
import { classifyEntrySourceForDisplay } from '../contracts/sources';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'warehouse-realtime-'));
  vi.stubEnv('LIEKAN_EXPORT_DIRECTORY', directory);
  vi.stubEnv('LIEKAN_EXPORT_MIN_FREE_BYTES', '0');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function legacy(rows: { id: string; referrer: string | null }[]) {
  const ai = new Set<string>(),
    groups = new Map<string, { name: string; sourceLabel?: 'direct'; ids: Set<string> }>();
  for (const row of rows) {
    const label = classifyEntrySourceForDisplay({ referrer: row.referrer });
    if (label.channel === 'AI 搜索引荐') ai.add(row.id);
    const key = JSON.stringify([label.source, label.sourceLabel ?? null]);
    if (!groups.has(key))
      groups.set(key, {
        name: label.source,
        ...(label.sourceLabel ? { sourceLabel: label.sourceLabel } : {}),
        ids: new Set(),
      });
    groups.get(key).ids.add(row.id);
  }
  return {
    ai: ai.size,
    sources: [...groups.values()]
      .map(({ ids, ...row }) => ({ ...row, value: ids.size }))
      .sort((a, b) => b.value - a.value),
  };
}

it('counts a session across multiple AI sources once and preserves source ties and direct-label identity', async () => {
  const input = [
    { id: 'shared', referrer: 'chatgpt.com' },
    { id: 'shared', referrer: 'perplexity.ai' },
    { id: 'second', referrer: 'chatgpt.com' },
    { id: 'shared', referrer: 'chatgpt.com' },
    { id: 'direct', referrer: null },
    { id: 'literal', referrer: '直接访问' },
    { id: 'direct', referrer: '' },
    { id: 'third', referrer: 'example.test' },
  ];
  const result = await warehouseRealtimeSources(async emit => {
    for (const row of input) await emit(row);
  });
  expect(result).toEqual(legacy(input));
  expect(result.ai).toBe(2);
  expect(result.sources.filter(row => row.name === '直接访问')).toEqual([
    { name: '直接访问', sourceLabel: 'direct', value: 1 },
    { name: '直接访问', value: 1 },
  ]);
  expect(await readdir(directory)).toEqual([]);
});

it('counts 100005 streamed identities in one source with no identity array or Set retained', async () => {
  const result = await warehouseRealtimeSources(async emit => {
    for (let n = 100004; n >= 0; n--) {
      await emit({ id: `session-${n}`, referrer: 'chatgpt.com' });
      if (n % 1000 === 0) await emit({ id: `session-${n}`, referrer: 'chatgpt.com' });
    }
  });
  expect(result).toEqual({ ai: 100005, sources: [{ name: 'chatgpt.com', value: 100005 }] });
  expect(await readdir(directory)).toEqual([]);
}, 120000);

it('cleans request-owned files after a streaming failure or cancellation', async () => {
  await expect(
    warehouseRealtimeSources(async emit => {
      await emit({ id: 'one', referrer: 'chatgpt.com' });
      throw new Error('stream failed');
    }),
  ).rejects.toThrow('stream failed');
  const controller = new AbortController();
  await expect(
    warehouseRealtimeSources(async emit => {
      controller.abort();
      await emit({ id: 'one', referrer: null });
    }, controller.signal),
  ).rejects.toThrow('统计读取已取消');
  expect(await readdir(directory)).toEqual([]);
});
