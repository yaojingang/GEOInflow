// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { QueueReplayReader } from './replay-reader';

afterEach(() => vi.useRealTimers());

function fixture(failure: 'connect' | 'join' | 'request-crash' | null = null) {
  const consumers: ReturnType<typeof makeConsumer>[] = [];
  function makeConsumer(index: number) {
    const listeners = new Map<string, Set<(event: any) => void>>();
    let eachBatch: (input: any) => Promise<void>;
    let dead = false;
    let offset = '0';
    const consumer = {
      events: { GROUP_JOIN: 'join', CRASH: 'crash' },
      emit: (name: string, event: any = {}) => {
        if (name === 'crash') dead = true;
        for (const callback of listeners.get(name) ?? []) callback(event);
      },
      on: (name: string, callback: (event: any) => void) => {
        const callbacks = listeners.get(name) ?? new Set();
        callbacks.add(callback);
        listeners.set(name, callbacks);
        return () => callbacks.delete(callback);
      },
      connect: vi.fn(async () => {
        if (index === 0 && failure === 'connect') throw new Error('broker-unavailable');
      }),
      subscribe: vi.fn(async () => {}),
      run: vi.fn(async (options: any) => {
        eachBatch = options.eachBatch;
        if (index !== 0 || failure !== 'join') consumer.emit('join');
      }),
      seek: vi.fn((value: { offset: string }) => {
        offset = value.offset;
      }),
      resume: vi.fn(() => {
        if (dead) return;
        if (index === 0 && failure === 'request-crash') {
          consumer.emit('crash', { payload: { restart: false } });
          return;
        }
        void eachBatch({
          batch: {
            topic: 'input',
            partition: 0,
            messages: [{ offset, value: Buffer.from('data') }],
          },
          isStale: () => false,
          heartbeat: async () => {},
          pause: () => {},
        });
      }),
      pause: vi.fn(),
      disconnect: vi.fn(async () => {
        dead = true;
      }),
      listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    };
    return consumer;
  }
  const queue = {
    installation: { topicName: 'input' },
    maxMessageBytes: 1024,
    assertIdentity: vi.fn(async () => {}),
    kafka: {
      consumer: () => {
        const consumer = makeConsumer(consumers.length);
        consumers.push(consumer);
        return consumer;
      },
    },
  };
  return { consumers, reader: new QueueReplayReader(queue as any) };
}

test('replay reconnects after its first startup fails', async () => {
  const { reader, consumers } = fixture('connect');
  try {
    await expect(reader.fetch(0, ['7'])).rejects.toThrow('broker-unavailable');
    const rows = await reader.fetch(0, ['7']);
    expect(rows.get('7')?.value?.toString()).toBe('data');
    expect(consumers).toHaveLength(2);
    expect(consumers[0].disconnect).toHaveBeenCalledTimes(1);
  } finally {
    await reader.close();
  }
});

test('assignment timeout clears its listener and the next replay can join a new consumer', async () => {
  vi.useFakeTimers();
  const { reader, consumers } = fixture('join');
  try {
    const rejected = expect(reader.fetch(0, ['8'])).rejects.toThrow(
      'warehouse-replay-assignment-timeout',
    );
    await vi.advanceTimersByTimeAsync(20001);
    await rejected;
    const rows = await reader.fetch(0, ['8']);
    expect(rows.has('8')).toBe(true);
    expect(consumers).toHaveLength(2);
    expect(consumers[0].listenerCount('join')).toBe(0);
  } finally {
    await reader.close();
  }
});

test('a non-restarting replay crash is recovered on the following fetch', async () => {
  vi.useFakeTimers();
  const { reader, consumers } = fixture();
  try {
    expect((await reader.fetch(0, ['9'])).has('9')).toBe(true);
    consumers[0].emit('crash', { payload: { restart: false } });
    const next = reader.fetch(0, ['10']).then(
      rows => ({ found: rows.has('10') }),
      error => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(20001);
    expect(await next).toEqual({ found: true });
    expect(consumers).toHaveLength(2);
    expect(consumers[0].disconnect).toHaveBeenCalledTimes(1);
  } finally {
    await reader.close();
  }
});

test('a crash rejects in-flight replay and the serialized successor recovers', async () => {
  const { reader, consumers } = fixture('request-crash');
  try {
    const first = expect(reader.fetch(0, ['11'])).rejects.toThrow('warehouse-replay-unavailable');
    const second = reader.fetch(0, ['12']);
    await first;
    expect((await second).has('12')).toBe(true);
    expect(consumers).toHaveLength(2);
  } finally {
    await reader.close();
  }
});

test('successful requests reuse the connected replay consumer', async () => {
  const { reader, consumers } = fixture();
  try {
    expect((await reader.fetch(0, ['13'])).has('13')).toBe(true);
    expect((await reader.fetch(0, ['14'])).has('14')).toBe(true);
    expect(consumers).toHaveLength(1);
    expect(consumers[0].connect).toHaveBeenCalledTimes(1);
  } finally {
    await reader.close();
  }
});
