// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import {
  WarehouseBackgroundBudget,
  WarehouseBackgroundDeferred,
} from './warehouse-background-budget';

afterEach(() => vi.useRealTimers());

it('yields while ingestion is pending and resumes full speed after sustained idle', async () => {
  vi.useFakeTimers();
  const pending = vi.fn(async () => true),
    budget = new WarehouseBackgroundBudget(pending);
  const signal = new AbortController().signal;
  await budget.run(async () => {
    vi.setSystemTime(Date.now() + 100);
  }, signal);
  const query = vi.fn(async () => 1);
  const next = budget.run(query, signal);
  await vi.advanceTimersByTimeAsync(499);
  expect(query).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await next).toBe(1);
  await budget.run(async () => {
    vi.setSystemTime(Date.now() + 100);
  }, signal);
  pending.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await budget.run(query, signal)).toBe(1);
});

it('does not spend the recovery interval when a continuous stream briefly has no pending work', async () => {
  vi.useFakeTimers();
  const pending = vi.fn(async () => true),
    budget = new WarehouseBackgroundBudget(pending);
  const signal = new AbortController().signal;
  await budget.run(async () => {
    vi.setSystemTime(Date.now() + 200);
  }, signal);
  pending.mockResolvedValue(false);
  const query = vi.fn(async () => 1),
    next = budget.run(query, signal);
  await vi.advanceTimersByTimeAsync(999);
  expect(query).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await next).toBe(1);
});

it('does not throttle a cold build when ingestion has never been pending', async () => {
  vi.useFakeTimers();
  const budget = new WarehouseBackgroundBudget(async () => false);
  const signal = new AbortController().signal;
  await budget.run(async () => {
    vi.setSystemTime(Date.now() + 1000);
  }, signal);
  const query = vi.fn(async () => 1);
  expect(await budget.run(query, signal)).toBe(1);
});

it('defers without dispatching when the recovery interval would consume the report deadline', async () => {
  vi.useFakeTimers();
  const budget = new WarehouseBackgroundBudget(async () => true),
    signal = new AbortController().signal;
  await budget.run(async () => {
    vi.setSystemTime(Date.now() + 1000);
  }, signal);
  const query = vi.fn();
  await expect(budget.run(query, signal, Date.now() + 1000)).rejects.toBeInstanceOf(
    WarehouseBackgroundDeferred,
  );
  expect(query).not.toHaveBeenCalled();
});

it('cancels waiting without dispatching a query or holding a permit', async () => {
  vi.useFakeTimers();
  const budget = new WarehouseBackgroundBudget(async () => true),
    controller = new AbortController();
  await budget.run(async () => {
    vi.setSystemTime(Date.now() + 1000);
  }, controller.signal);
  const query = vi.fn(),
    waiting = budget.run(query, controller.signal);
  const rejected = expect(waiting).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10);
  controller.abort();
  await rejected;
  expect(query).not.toHaveBeenCalled();
});

it('serializes simultaneous background dispatch and does not let a cancelled waiter release its successor early', async () => {
  vi.useFakeTimers();
  const budget = new WarehouseBackgroundBudget(async () => true);
  let release: () => void;
  const first = budget.run(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
    new AbortController().signal,
  );
  const cancelled = new AbortController();
  const skipped = vi.fn();
  const rejected = expect(budget.run(skipped, cancelled.signal)).rejects.toThrow();
  const last = vi.fn(async () => 42);
  const next = budget.run(last, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(100);
  cancelled.abort();
  expect(last).not.toHaveBeenCalled();
  release();
  await first;
  await rejected;
  await vi.advanceTimersByTimeAsync(499);
  expect(last).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await next).toBe(42);
  expect(skipped).not.toHaveBeenCalled();
});
