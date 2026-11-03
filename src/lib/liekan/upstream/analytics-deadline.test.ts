import { afterEach, expect, it, vi } from 'vitest';
import { timedAnalyticsClient } from './analytics-deadline';
afterEach(() => vi.useRealTimers());
it('recalculates the remaining SQL budget at execution time for concurrent statements', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const order: string[] = [];
  const tx = timedAnalyticsClient(
    {
      $executeRawUnsafe: async (sql: string) => {
        order.push(sql);
      },
      $queryRawUnsafe: (sql: string) =>
        new Promise(resolve =>
          setTimeout(() => {
            order.push(sql);
            resolve([]);
          }, 50),
        ),
    },
    Date.now() + 100,
  );
  const result = Promise.all([tx.$queryRawUnsafe('A'), tx.$queryRawUnsafe('B')]);
  await vi.advanceTimersByTimeAsync(100);
  await result;
  expect(order).toEqual([
    'SET LOCAL statement_timeout = 100',
    'A',
    'SET LOCAL statement_timeout = 50',
    'B',
  ]);
});
it('does not run queued statements after an active query has failed and settled', async () => {
  const error = new Error('cancelled by statement timeout');
  const query = vi.fn(async () => {
    throw error;
  });
  const tx = timedAnalyticsClient(
    { $executeRawUnsafe: async () => 0, $queryRawUnsafe: query },
    Date.now() + 1000,
  );
  const results = await Promise.allSettled([tx.$queryRawUnsafe('A'), tx.$queryRawUnsafe('B')]);
  expect(results.every(result => result.status === 'rejected')).toBe(true);
  expect(query).toHaveBeenCalledOnce();
});

it('attributes a failure to the statement that executed it', async () => {
  const error = new Error('synthetic SQL failure');
  const failed = vi.fn();
  const parent = timedAnalyticsClient(
    {
      $executeRawUnsafe: async () => 0,
      $queryRawUnsafe: async () => {
        throw error;
      },
    },
    Date.now() + 1000,
  );
  const child = timedAnalyticsClient(parent, Date.now() + 1000, false, failed);
  await expect(child.$queryRawUnsafe('cache')).rejects.toBe(error);
  expect(failed).toHaveBeenCalledExactlyOnceWith(error);
});

it('keeps a queued cache statement from claiming an earlier source failure', async () => {
  const error = new Error('synthetic source failure');
  const failed = vi.fn();
  const parent = timedAnalyticsClient(
    {
      $executeRawUnsafe: async () => 0,
      $queryRawUnsafe: async () => {
        throw error;
      },
    },
    Date.now() + 1000,
  );
  const child = timedAnalyticsClient(parent, Date.now() + 1000, false, failed);
  const results = await Promise.allSettled([
    parent.$queryRawUnsafe('source'),
    child.$queryRawUnsafe('cache'),
  ]);
  expect(results.every(result => result.status === 'rejected' && result.reason === error)).toBe(
    true,
  );
  expect(failed).not.toHaveBeenCalled();
});

it.each([
  [800, 5000],
  [5000, 800],
])('nested proxies share the executor and preserve both budgets (%s, %s)', async (outer, inner) => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const execute = vi.fn(async () => 0),
    query = vi.fn(async () => []);
  const parent = timedAnalyticsClient(
    { $executeRawUnsafe: execute, $queryRawUnsafe: query },
    Date.now() + outer,
  );
  const child = timedAnalyticsClient(parent, Date.now() + inner);
  await child.$queryRawUnsafe('nested');
  expect(execute).toHaveBeenCalledExactlyOnceWith('SET LOCAL statement_timeout = 800');
  expect(query).toHaveBeenCalledExactlyOnceWith('nested');
});

it('a nested query keeps serialization with parallel parent work', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const order: string[] = [];
  const parent = timedAnalyticsClient(
    {
      $executeRawUnsafe: async (sql: string) => {
        order.push(sql);
      },
      $queryRawUnsafe: (sql: string) =>
        new Promise(resolve =>
          setTimeout(() => {
            order.push(sql);
            resolve([]);
          }, 50),
        ),
    },
    Date.now() + 1000,
  );
  const child = timedAnalyticsClient(parent, Date.now() + 800);
  const result = Promise.all([parent.$queryRawUnsafe('parent'), child.$queryRawUnsafe('child')]);
  await vi.advanceTimersByTimeAsync(100);
  await result;
  expect(order).toEqual([
    'SET LOCAL statement_timeout = 1000',
    'parent',
    'SET LOCAL statement_timeout = 750',
    'child',
  ]);
});
