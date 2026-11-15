// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { WarehouseConsumer } from './consumer';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture() {
  const handlers = new Map<string, (event: any) => void>();
  const events = {
    GROUP_JOIN: 'join',
    REBALANCING: 'rebalance',
    DISCONNECT: 'disconnect',
    STOP: 'stop',
    CRASH: 'crash',
  };
  const consumer = {
    events,
    on: vi.fn((event: string, handler: (event: any) => void) => handlers.set(event, handler)),
    connect: vi.fn(),
    subscribe: vi.fn(),
    run: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
  };
  const queue = {
    installation: { topicName: 'test', topicId: 'topic', partitions: 8 },
    maxMessageBytes: 1024,
    kafka: { consumer: () => consumer },
    assertIdentity: vi.fn(),
  };
  const worker = new WarehouseConsumer({ db: {} } as any, {} as any, queue as any, async () => [], {
    groupId: 'test',
    concurrency: 2,
  }) as any;
  worker.assigned = new Set([0, 1, 2, 3]);
  worker.drain = vi.fn();
  worker.emit = (event: string, payload = {}) => handlers.get(event)?.({ payload });
  return worker;
}
it('dispatches durable work immediately and uses freed capacity without waiting for the next tick', async () => {
  vi.useFakeTimers();
  const w = fixture();
  let finish: any;
  w.drain.mockImplementation((p: number) =>
    p === 0 ? new Promise(r => (finish = r)) : Promise.resolve(false),
  );
  await w.start();
  w.wake(0);
  w.wake(1);
  w.wake(2);
  expect(w.drain.mock.calls.map((c: any) => c[0])).toEqual([0, 1]);
  await vi.advanceTimersByTimeAsync(0);
  expect(w.drain.mock.calls.map((c: any) => c[0])).toContain(2);
  expect(w.running.size).toBeLessThanOrEqual(2);
  finish(false);
  await vi.advanceTimersByTimeAsync(0);
  await w.close();
});
it('does not lose a notification received during a drain and never runs a partition twice', async () => {
  vi.useFakeTimers();
  const w = fixture();
  let finish: any;
  w.drain.mockImplementationOnce(() => new Promise(r => (finish = r))).mockResolvedValue(false);
  await w.start();
  w.wake(0);
  w.wake(0);
  expect(w.drain).toHaveBeenCalledTimes(1);
  finish(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(w.drain.mock.calls.map((c: any) => c[0])).toEqual([0, 0]);
  await w.close();
});
it('retains periodic recovery when notifications are absent and stops dispatching on shutdown', async () => {
  vi.useFakeTimers();
  const w = fixture();
  w.drain.mockResolvedValue(false);
  await w.start();
  await vi.advanceTimersByTimeAsync(1100);
  expect(new Set(w.drain.mock.calls.map((c: any) => c[0]))).toEqual(new Set([0, 1, 2, 3]));
  const calls = w.drain.mock.calls.length;
  await w.close();
  w.wake(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(w.drain.mock.calls.length).toBe(calls);
});
it('gives waiting partitions a turn before requeueing a hot partition', async () => {
  vi.useFakeTimers();
  const w = fixture();
  const finishes: any[] = [];
  w.drain.mockImplementation((p: number) => new Promise(r => finishes.push({ p, r })));
  await w.start();
  w.wake(0);
  w.wake(1);
  w.wake(2);
  finishes[0].r(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(w.drain.mock.calls.map((c: any) => c[0])).toEqual([0, 1, 2]);
  w.stopping = true;
  for (const f of finishes) f.r(false);
  await vi.advanceTimersByTimeAsync(0);
  await w.close();
});
it('backs off after an unavailable drain but recovers through the periodic probe', async () => {
  vi.useFakeTimers();
  const w = fixture();
  w.assigned = new Set([0]);
  w.drain.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(false);
  await w.start();
  w.wake(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(w.running.size).toBe(0);
  expect(w.drain).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(900);
  expect(w.drain).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(200);
  expect(w.drain).toHaveBeenCalledTimes(2);
  await w.close();
});
it('drops revoked dispatch hints and resumes only the newly assigned partitions', async () => {
  vi.useFakeTimers();
  const w = fixture();
  let finish: any;
  w.options.concurrency = 1;
  w.drain.mockImplementationOnce(() => new Promise(r => (finish = r))).mockResolvedValue(false);
  await w.start();
  w.wake(0);
  w.wake(1);
  w.emit('rebalance');
  finish(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(w.drain.mock.calls.map((c: any) => c[0])).toEqual([0]);
  w.emit('join', { memberAssignment: { test: [3] } });
  await vi.advanceTimersByTimeAsync(0);
  expect(w.drain.mock.calls.map((c: any) => c[0])).toEqual([0, 3]);
  expect(w.scheduled.size).toBe(0);
  await w.close();
});
