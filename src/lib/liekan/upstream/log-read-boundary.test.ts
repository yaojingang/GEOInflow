import { beforeEach, expect, it, vi } from 'vitest';

const versions = vi.hoisted(() => vi.fn());
vi.mock('./analytics-revision', () => ({ readAnalyticsVersions: versions }));

import { logReadBoundary, parseLogRead } from './log-read-boundary';

const id = '11111111-1111-4111-8111-111111111111';
const input = { startAt: 1000, endAt: 2000, timezone: 'UTC', crawlerMetricsVersion: 1 };
let row: any;
const tx = { $queryRawUnsafe: vi.fn(async () => [row]) };
beforeEach(() => {
  row = { mode: 'live', epoch: '1', log_epoch: '1', coarse: 'history', fine: 'tail' };
  versions.mockResolvedValue({ strong: 'policy-1', data: 'data-1' });
});

it('shares one input identity across list pages and independent parts', async () => {
  const a = await logReadBoundary(tx, id, parseLogRead(input));
  expect(
    await logReadBoundary(
      tx,
      id,
      parseLogRead({ ...input, cursor: 'next', page: 4, seek: 'before', readBoundary: a }),
    ),
  ).toBe(a);
});

it.each(['coarse', 'fine', 'epoch', 'log_epoch'])(
  'rejects an old boundary after %s changes',
  async field => {
    const a = await logReadBoundary(tx, id, parseLogRead(input));
    row[field] = 'changed';
    await expect(
      logReadBoundary(tx, id, parseLogRead({ ...input, readBoundary: a })),
    ).rejects.toMatchObject({ status: 409, code: 'log-read-boundary-conflict' });
  },
);

it('binds site, filters, time and policy but permits unrelated live source revisions', async () => {
  const a = await logReadBoundary(tx, id, parseLogRead(input));
  versions.mockResolvedValue({ strong: 'policy-1', data: 'new-outside-range' });
  expect(await logReadBoundary(tx, id, parseLogRead({ ...input, readBoundary: a }))).toBe(a);
  for (const p of [
    { ...input, filter: 'ai' },
    { ...input, search: 'changed' },
    { ...input, endAt: 3000 },
  ])
    await expect(
      logReadBoundary(tx, id, parseLogRead({ ...p, readBoundary: a })),
    ).rejects.toMatchObject({ status: 409 });
  await expect(
    logReadBoundary(
      tx,
      '22222222-2222-4222-8222-222222222222',
      parseLogRead({ ...input, readBoundary: a }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  versions.mockResolvedValue({ strong: 'policy-2', data: 'data-1' });
  await expect(
    logReadBoundary(tx, id, parseLogRead({ ...input, readBoundary: a })),
  ).rejects.toMatchObject({ status: 409 });
});

it('keeps a source revision fence when incremental capture is disabled', async () => {
  row.mode = 'disabled';
  const a = await logReadBoundary(tx, id, parseLogRead(input));
  versions.mockResolvedValue({ strong: 'policy-1', data: 'data-2' });
  await expect(
    logReadBoundary(tx, id, parseLogRead({ ...input, readBoundary: a })),
  ).rejects.toMatchObject({ status: 409 });
});
