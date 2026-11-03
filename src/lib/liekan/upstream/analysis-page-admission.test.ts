import { expect, it, vi } from 'vitest';
vi.mock('./analysis-rollups-db', () => ({ analysisVersions: vi.fn() }));
vi.mock('./server', () => ({ reportSnapshot: vi.fn(), query: vi.fn() }));
import { firstPageRange } from './analysis-page-admission';
const input = {
  resource: 'ai/pages',
  startAt: Date.parse('2026-10-22T16:00:00Z'),
  endAt: Date.parse('2026-10-29T16:00:00Z'),
  timezone: 'Asia/Shanghai',
  crawlerMetricsVersion: 1,
};
const now = Date.parse('2026-10-29T02:05:00Z');
it('uses the existing dashboard data-through clock for today', () => {
  const range = firstPageRange(input, now)!;
  expect(+range.end).toBeLessThanOrEqual(now);
  expect(+range.start).toBe(input.startAt);
});
it('includes bot comparison and the overview six-month dependency in the preflight', () => {
  const base = firstPageRange(input, now)!;
  expect(+firstPageRange({ ...input, resource: 'ai/bots' }, now)!.start).toBe(
    input.startAt - (+base.end - input.startAt),
  );
  expect(firstPageRange({ ...input, resource: 'ai/overview' }, now)!.start.toISOString()).toBe(
    '2026-04-30T16:00:00.000Z',
  );
});
it.each([
  { refresh: '1' },
  { resource: 'human/overview' },
  { crawlerMetricsVersion: 2 },
  { startAt: 0 },
  { endAt: input.startAt },
])('defers unsupported first-page input %j', extra =>
  expect(firstPageRange({ ...input, ...extra }, now)).toBeUndefined(),
);
