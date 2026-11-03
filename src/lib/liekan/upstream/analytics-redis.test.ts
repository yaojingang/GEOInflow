import { afterEach, expect, it, vi } from 'vitest';
import { currentCacheContext, withQueryCacheHeaders } from './cache-context';
const factory = vi.hoisted(() => vi.fn());
vi.mock('redis', () => ({ createClient: factory }));
import { AnalyticsRedis } from './analytics-redis';
afterEach(() => {
  vi.useRealTimers();
  factory.mockReset();
});

it('destroys a connected socket that accepts a command and never replies, then opens a ten second circuit', async () => {
  vi.useFakeTimers();
  const client = {
    isReady: true,
    on: vi.fn(),
    destroy: vi.fn(),
    sendCommand: vi.fn(() => new Promise(() => {})),
  };
  factory.mockReturnValue(client);
  const redis = new AnalyticsRedis('redis://cache');
  const pending = redis.command(['PING']);
  await vi.advanceTimersByTimeAsync(150);
  expect(await pending).toBeNull();
  expect(client.destroy).toHaveBeenCalledOnce();
  expect(await redis.command(['PING'])).toBeNull();
  expect(factory).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10000);
  client.sendCommand.mockImplementation(async () => 'PONG');
  expect(await redis.command(['PING'])).toBe('PONG');
  expect(factory).toHaveBeenCalledTimes(2);
});
it('shares a total 150ms network budget across a request and includes connection establishment', async () => {
  vi.useFakeTimers();
  const client = {
    isReady: false,
    on: vi.fn(),
    destroy: vi.fn(),
    connect: vi.fn(
      () =>
        new Promise<void>(resolve =>
          setTimeout(() => {
            client.isReady = true;
            resolve();
          }, 100),
        ),
    ),
    sendCommand: vi.fn(() => new Promise(resolve => setTimeout(() => resolve('PONG'), 40))),
  };
  factory.mockReturnValue(client);
  const redis = new AnalyticsRedis('redis://cache');
  const response = withQueryCacheHeaders(async () => {
    expect(await redis.command(['PING'])).toBe('PONG');
    expect(await redis.command(['PING'])).toBeNull();
    expect(await redis.command(['PING'])).toBeNull();
    return Response.json({});
  });
  await vi.advanceTimersByTimeAsync(150);
  expect((await response).ok).toBe(true);
  expect(client.sendCommand).toHaveBeenCalledTimes(2);
  expect(client.destroy).toHaveBeenCalledOnce();
});

it('counts shared connection and overlapping replies once within the request network budget', async () => {
  vi.useFakeTimers();
  const client = {
    isReady: false,
    on: vi.fn(),
    destroy: vi.fn(),
    connect: vi.fn(
      () =>
        new Promise<void>(resolve =>
          setTimeout(() => {
            client.isReady = true;
            resolve();
          }, 80),
        ),
    ),
    sendCommand: vi.fn(() => new Promise(resolve => setTimeout(() => resolve('PONG'), 5))),
  };
  factory.mockReturnValue(client);
  const redis = new AnalyticsRedis('redis://cache');
  const response = withQueryCacheHeaders(async () => {
    expect(await Promise.all([redis.command(['PING']), redis.command(['PING'])])).toEqual([
      'PONG',
      'PONG',
    ]);
    expect(await redis.command(['PING'])).toBe('PONG');
    return Response.json({});
  });
  const completion = response.then(
    value => ({ value }),
    error => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(90);
  expect(await completion).toHaveProperty('value.ok', true);
  expect(client.connect).toHaveBeenCalledOnce();
  expect(client.sendCommand).toHaveBeenCalledTimes(3);
  expect(client.destroy).not.toHaveBeenCalled();
});

it('limits a later overlapping command to the remaining request wait', async () => {
  vi.useFakeTimers();
  const client = {
    isReady: true,
    on: vi.fn(),
    destroy: vi.fn(),
    sendCommand: vi.fn(() => new Promise(() => {})),
  };
  factory.mockReturnValue(client);
  const redis = new AnalyticsRedis('redis://cache');
  const response = withQueryCacheHeaders(async () => {
    const first = redis.command(['PING']);
    await new Promise(resolve => setTimeout(resolve, 100));
    const second = redis.command(['PING']);
    expect(await Promise.all([first, second])).toEqual([null, null]);
    return Response.json({});
  });
  const completion = response.then(
    value => ({ value }),
    error => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(150);
  expect(await completion).toHaveProperty('value.ok', true);
  expect(client.sendCommand).toHaveBeenCalledTimes(2);
  expect(client.destroy).toHaveBeenCalled();
});

it('releases an owned lease after the compute deadline so worker fallback can claim immediately', async () => {
  vi.useFakeTimers();
  let owner: string | undefined;
  const client = {
    isReady: true,
    on: vi.fn(),
    destroy: vi.fn(),
    sendCommand: vi.fn(async (args: string[]) => {
      const token = args[4];
      if (args[1].includes('EXISTS')) {
        if (owner) return 0;
        owner = token;
        return 1;
      }
      if (owner === token) {
        owner = undefined;
        return 1;
      }
      return 0;
    }),
  };
  factory.mockReturnValue(client);
  const redis = new AnalyticsRedis('redis://cache');
  let first: string;
  const response = withQueryCacheHeaders(async () => {
    currentCacheContext().deadline = Date.now() + 750;
    first = (await redis.claim('fast-attempt', true, true)) as string;
    expect(typeof first).toBe('string');
    await vi.advanceTimersByTimeAsync(751);
    await redis.release('fast-attempt', first);
    return Response.json({});
  });
  expect((await response).ok).toBe(true);
  expect(owner).toBeUndefined();
  expect(typeof (await redis.claim('fast-attempt', true, true))).toBe('string');
});
it('bounds cleanup reply waiting after deadline exhaustion', async () => {
  vi.useFakeTimers();
  const client = {
    isReady: true,
    on: vi.fn(),
    destroy: vi.fn(),
    sendCommand: vi.fn(() => new Promise(() => {})),
  };
  factory.mockReturnValue(client);
  const redis = new AnalyticsRedis('redis://cache');
  const response = withQueryCacheHeaders(async () => {
    currentCacheContext().deadline = Date.now() - 1;
    await redis.release('expired-attempt', 'owned-token');
    return Response.json({});
  });
  await vi.advanceTimersByTimeAsync(150);
  expect((await response).ok).toBe(true);
  expect(client.sendCommand).toHaveBeenCalledOnce();
  expect(client.destroy).toHaveBeenCalledOnce();
});
