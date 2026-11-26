// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { memoRoundMetric, releaseRoundMetrics, withRoundMetrics } from './warehouse-round-metrics';

it('reuses exact aggregate conditions only within the fixed round and isolates caller mutation', async () => {
  const load = vi.fn(async () => ({ pv: 3 }));
  await withRoundMetrics('round-a', async () => {
    (await memoRoundMetric('today-site-a', load)).pv = 9;
    expect(await memoRoundMetric('today-site-a', load)).toEqual({ pv: 3 });
    expect(load).toHaveBeenCalledTimes(1);
    await memoRoundMetric('7days-site-a', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
  await withRoundMetrics('round-b', () => memoRoundMetric('today-site-a', load));
  await memoRoundMetric('today-site-a', load);
  expect(load).toHaveBeenCalledTimes(4);
  releaseRoundMetrics('round-a');
  await withRoundMetrics('round-a', () => memoRoundMetric('today-site-a', load));
  expect(load).toHaveBeenCalledTimes(5);
});
it('does not cache failures or large results and never refuses a query at the cache bound', async () => {
  const large = vi.fn(async () => 'x'.repeat(40 * 1024));
  await withRoundMetrics('round-c', async () => {
    await expect(
      memoRoundMetric('bad', async () => {
        throw Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(await memoRoundMetric('bad', async () => 1)).toBe(1);
    await memoRoundMetric('large', large);
    await memoRoundMetric('large', large);
    expect(large).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 300; i++) expect(await memoRoundMetric(`key-${i}`, async () => i)).toBe(i);
  });
});

it('recovers bounded successful metrics from the durable round and keeps failed writes retryable', async () => {
  const values: Record<string, unknown> = {};
  const store = {
    values,
    save: vi.fn(async (key: string, value: unknown) => {
      values[key] = structuredClone(value);
    }),
  };
  const load = vi.fn(async () => ({ count: 42 }));
  await withRoundMetrics('durable', () => memoRoundMetric('window', load), store);
  releaseRoundMetrics('durable');
  expect(await withRoundMetrics('durable', () => memoRoundMetric('window', load), store)).toEqual({
    count: 42,
  });
  expect(load).toHaveBeenCalledTimes(1);
  releaseRoundMetrics('durable');
  const failing = {
    values: {},
    save: async () => {
      throw Error('write-lost');
    },
  };
  await expect(
    withRoundMetrics('failed', () => memoRoundMetric('window', load), failing),
  ).rejects.toThrow('write-lost');
  expect(await withRoundMetrics('failed', () => memoRoundMetric('window', load), store)).toEqual({
    count: 42,
  });
  releaseRoundMetrics('failed');
});
