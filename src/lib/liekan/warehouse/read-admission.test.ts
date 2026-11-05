import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadAdmission } from './read-admission';

afterEach(() => vi.useRealTimers());
describe('warehouse live read admission', () => {
  it('holds capacity until the entire result is consumed, then releases it after failure', async () => {
    const gate = new ReadAdmission(1),
      order: string[] = [];
    let release: () => void;
    const first = gate.run(async () => {
      order.push('body');
      await new Promise<void>(r => {
        release = r;
      });
      throw new Error('parse failed');
    });
    const rejected = expect(first).rejects.toThrow('parse failed');
    const second = gate.run(async () => {
      order.push('next');
      return 2;
    });
    expect(order).toEqual(['body']);
    release();
    await rejected;
    expect(await second).toBe(2);
    expect(order).toEqual(['body', 'next']);
    gate.close();
  });
  it('removes expired waiters and bounds queued work without retaining a failed permit', async () => {
    vi.useFakeTimers();
    const gate = new ReadAdmission(1, 1, 20);
    let release: () => void;
    const first = gate.run(
      () =>
        new Promise<void>(r => {
          release = r;
        }),
    );
    const work = vi.fn();
    const waiting = expect(gate.run(work)).rejects.toThrow('warehouse-read-capacity-busy');
    await expect(gate.run(work)).rejects.toThrow('warehouse-read-capacity-busy');
    await vi.advanceTimersByTimeAsync(21);
    await waiting;
    release();
    await first;
    expect(work).not.toHaveBeenCalled();
    expect(await gate.run(async () => 3)).toBe(3);
    gate.close();
    await expect(gate.run(work)).rejects.toThrow('warehouse-read-capacity-busy');
  });
});

it('removes canceled waiters immediately and never runs their work or leaks capacity', async () => {
  const gate = new ReadAdmission(1, 1);
  let release!: () => void;
  const first = gate.run(
    () =>
      new Promise<void>(r => {
        release = r;
      }),
  );
  const abort = new AbortController(),
    work = vi.fn();
  const queued = gate.run(work, abort.signal);
  const rejected = expect(queued).rejects.toThrow('request canceled');
  abort.abort(new Error('request canceled'));
  await rejected;
  const next = gate.run(async () => 42);
  release();
  await first;
  expect(await next).toBe(42);
  expect(work).not.toHaveBeenCalled();
  await expect(gate.run(work, abort.signal)).rejects.toThrow('request canceled');
  expect(work).not.toHaveBeenCalled();
  expect(await gate.run(async () => 43)).toBe(43);
});
