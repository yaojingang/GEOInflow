// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import {
  WarehouseBackgroundBudget,
  WarehouseBackgroundDeferred,
} from './warehouse-background-budget';

afterEach(() => vi.useRealTimers());

const healthy = { oldestMs: 500, publishedP95Ms: 2000, samples: 12 };
const behind = { oldestMs: 6500, publishedP95Ms: null, samples: 0 };
const signal = new AbortController().signal;

it('runs the SQL in an admitted segment without probing or waiting between queries', async () => {
  vi.useFakeTimers();
  const pressure = vi.fn(async () => behind);
  const observe = vi.fn();
  const budget = new WarehouseBackgroundBudget(pressure, observe);
  const now = Date.now();
  const query = vi.fn(async () => 42);
  await expect(budget.run(query, signal, now + 75000)).resolves.toBe(42);
  await expect(budget.run(query, signal, now + 75000)).resolves.toBe(42);
  expect(query).toHaveBeenCalledTimes(2);
  expect(pressure).not.toHaveBeenCalled();
  expect(Date.now()).toBe(now);
  expect(observe).toHaveBeenCalledWith('query-execution', expect.any(Number));
});

it('defers at a checkpoint, persists the retry, and resumes after queue-head age recovers', async () => {
  vi.useFakeTimers();
  const pressure = vi.fn(async () => healthy);
  const budget = new WarehouseBackgroundBudget(pressure);
  const deferUntil = vi.fn(async (_next: number) => {});
  const now = Date.now();

  await budget.checkpoint(signal, deferUntil);
  expect(deferUntil).not.toHaveBeenCalled();
  pressure.mockResolvedValue(behind);
  await expect(budget.checkpoint(signal, deferUntil)).rejects.toMatchObject({
    retryAt: now + 1000,
  });
  expect(deferUntil).toHaveBeenCalledExactlyOnceWith(now + 1000);
  expect(Date.now()).toBe(now);
  pressure.mockResolvedValue({ ...behind, oldestMs: 4000 });
  expect(await budget.claimAfter()).toBe(now + 1000);
  pressure.mockResolvedValue({ ...behind, oldestMs: 3000, publishedP95Ms: 9000 });
  expect(await budget.claimAfter()).toBeUndefined();
  pressure.mockResolvedValue({ ...behind, oldestMs: 4000 });
  await budget.checkpoint(signal, deferUntil);
  expect(deferUntil).toHaveBeenCalledTimes(1);
});

it('uses live backlog rather than a stale publication sample when the queue is empty', async () => {
  const budget = new WarehouseBackgroundBudget(async () => ({
    oldestMs: 0,
    publishedP95Ms: 9000,
    samples: 20,
  }));
  expect(await budget.claimAfter()).toBeUndefined();
});

it('honors the same deadline both before and after query admission', async () => {
  vi.useFakeTimers();
  const budget = new WarehouseBackgroundBudget(async () => healthy);
  const query = vi.fn();
  await expect(budget.run(query, signal, Date.now() + 1000)).rejects.toBeInstanceOf(
    WarehouseBackgroundDeferred,
  );
  await expect(
    budget.run(query, signal, Date.now() + 2000, async execute => {
      vi.setSystemTime(Date.now() + 1500);
      return execute();
    }),
  ).rejects.toBeInstanceOf(WarehouseBackgroundDeferred);
  expect(query).not.toHaveBeenCalled();
});

it('serializes simultaneous SQL and keeps a cancelled waiter from unblocking its successor', async () => {
  const budget = new WarehouseBackgroundBudget(async () => healthy);
  let release: () => void;
  const first = budget.run(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
    signal,
  );
  const cancelled = new AbortController();
  const skipped = vi.fn();
  const rejected = expect(budget.run(skipped, cancelled.signal)).rejects.toThrow();
  const last = vi.fn(async () => 42);
  const next = budget.run(last, signal);
  await Promise.resolve();
  cancelled.abort();
  expect(last).not.toHaveBeenCalled();
  release();
  await first;
  await rejected;
  expect(await next).toBe(42);
  expect(skipped).not.toHaveBeenCalled();
});

it('reserves serial opportunities during sustained backlog without admitting maintenance or unrelated work', async () => {
  vi.useFakeTimers();
  const budget = new WarehouseBackgroundBudget(async () => ({ ...behind, oldestMs: 14000 }));
  for (let round = 0; round < 2; round++) {
    expect(await budget.claimAfter(true)).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(13999);
    expect(await budget.claimAfter(true)).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(1);
    expect(await budget.claimAfter(true)).toBeUndefined();
    expect(await budget.claimAfter()).toBeGreaterThan(Date.now());
    await budget.withClaim(async () => {
      await budget.checkpoint(signal);
      await budget.checkpoint(signal);
      expect(await budget.claimAfter()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(await budget.claimAfter()).toBeGreaterThan(Date.now());
  }
});

it('keeps the pressure allowance local to a claim and releases it after failure', async () => {
  vi.useFakeTimers();
  const budget = new WarehouseBackgroundBudget(async () => behind);
  await budget.claimAfter(true);
  await vi.advanceTimersByTimeAsync(10000);
  let finish: () => void;
  const resume = new Promise<void>(resolve => {
    finish = resolve;
  });
  const running = budget.withClaim(async () => {
    await resume;
    await budget.checkpoint(signal);
    throw new Error('report failed');
  });
  await expect(budget.checkpoint(signal)).rejects.toBeInstanceOf(WarehouseBackgroundDeferred);
  finish();
  await expect(running).rejects.toThrow('report failed');
  expect(await budget.claimAfter(true)).toBeGreaterThan(Date.now());
});
