// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { readLogPageWindows } from './warehouse-log-page';

const H = 3600000;
const range = { start: 0, end: 24 * H, endExclusive: true };
const candidates = { firstHour: 0, lastHour: 23 * 3600 };
it('stops as soon as the fully filtered page and sentinel are collected', async () => {
  const read = vi.fn().mockResolvedValueOnce([1, 2, 3]);
  expect(await readLogPageWindows(range, candidates, 3, false, undefined, read)).toEqual([1, 2, 3]);
  expect(read.mock.calls).toEqual([[{ start: 23 * H, end: 24 * H, endExclusive: true }, 3]]);
});
it('walks disjoint windows across sparse matches, preserving sort and the exact remainder', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([3])
    .mockResolvedValueOnce([2, 1]);
  expect(await readLogPageWindows(range, candidates, 3, false, undefined, read)).toEqual([3, 2, 1]);
  expect(read.mock.calls).toEqual([
    [{ start: 23 * H, end: 24 * H, endExclusive: true }, 3],
    [{ start: 21 * H, end: 23 * H, endExclusive: true }, 3],
    [{ start: 17 * H, end: 21 * H, endExclusive: true }, 2],
  ]);
});
it('handles inclusive endpoints, empty hours and a one-instant range without looping', async () => {
  const read = vi.fn().mockResolvedValue([]);
  await readLogPageWindows(
    { start: 3 * H, end: 3 * H },
    { firstHour: 10800, lastHour: 10800 },
    101,
    false,
    undefined,
    read,
  );
  expect(read.mock.calls).toEqual([[{ start: 3 * H, end: 3 * H, endExclusive: false }, 101]]);
  read.mockClear();
  await readLogPageWindows(range, undefined, 101, false, undefined, read);
  expect(read).not.toHaveBeenCalled();
});
it.each([false, true])(
  'matches full sorting for arbitrary timestamps and filters, ascending=%s',
  async ascending => {
    // Includes ties, boundary hours, sparse matching rows, no matches and partial endpoints.
    const data = Array.from({ length: 311 }, (_, i) => ({ t: (Math.floor(i / 3) * H) / 4, id: i }));
    for (const endExclusive of [false, true])
      for (const filter of [(r: any) => true, (r: any) => r.id % 19 === 0, (r: any) => false]) {
        const bounds = { start: H / 3, end: 23 * H, endExclusive };
        const eligible = data
          .filter(
            r =>
              r.t >= bounds.start &&
              (endExclusive ? r.t < bounds.end : r.t <= bounds.end) &&
              filter(r),
          )
          .sort((a, b) => (ascending ? 1 : -1) * (a.t - b.t || a.id - b.id));
        const windows: any[] = [];
        const actual = await readLogPageWindows(
          bounds,
          candidates,
          19,
          ascending,
          undefined,
          async (w, n) => {
            windows.push(w);
            return eligible
              .filter(r => r.t >= w.start && (w.endExclusive ? r.t < w.end : r.t <= w.end))
              .slice(0, n);
          },
        );
        expect(actual).toEqual(eligible.slice(0, 19));
        expect(windows.length).toBeLessThanOrEqual(5);
      }
  },
);
it.each([false, true])(
  'prunes only whole cursor hours without rounding the exact tuple, ascending=%s',
  async ascending => {
    const read = vi.fn().mockResolvedValue([1]);
    await readLogPageWindows(range, candidates, 1, ascending, '1970-01-01 12:00:00.000001', read);
    expect(read.mock.calls[0]).toEqual([{ start: 12 * H, end: 13 * H, endExclusive: true }, 1]);
  },
);
