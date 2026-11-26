import { beforeEach, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('./features-client', () => ({ featureApi: { get } }));

import { canReuseReportPlaceholder, pageReportQuery } from './page-report-client';

beforeEach(() => get.mockReset());

it('uses the boundary returned by the first log page and preserves filter and range identity', () => {
  const boundary = 'a'.repeat(64);
  const input = {
    resource: 'logs' as const,
    startAt: 1,
    endAt: 1000,
    timezone: 'UTC',
    crawlerIdentityScope: 'verified_range' as const,
  };
  const first = pageReportQuery('owner', 'site', input).queryKey;
  const second = pageReportQuery('owner', 'site', {
    ...input,
    page: 2,
    cursor: 'cursor',
    seek: 'after',
    readBoundary: boundary,
  }).queryKey;
  const back = pageReportQuery('owner', 'site', {
    ...input,
    cursor: 'back',
    seek: 'before',
    readBoundary: boundary,
  }).queryKey;
  expect(first).toHaveLength(second.length);
  expect(canReuseReportPlaceholder(second, first, boundary, boundary)).toBe(true);
  expect(canReuseReportPlaceholder(back, second, boundary, boundary)).toBe(true);
  expect(canReuseReportPlaceholder(second, first, 'b'.repeat(64), boundary)).toBe(false);
  expect(canReuseReportPlaceholder(first, second, boundary, undefined)).toBe(false);
  for (const changed of [
    { ...input, crawlerIdentityScope: 'all' as const },
    { ...input, endAt: 1001 },
    { ...input, filter: 'ai' },
  ]) {
    const key = pageReportQuery('owner', 'site', { ...changed, readBoundary: boundary }).queryKey;
    expect(canReuseReportPlaceholder(key, first, boundary, boundary)).toBe(false);
  }
});

it('delivers log entries while the exact count and summary remain unfinished', async () => {
  const entries = {
    tables: { logBody: [{ path: '/first-visible' }] },
    meta: { logReadBoundary: 'a'.repeat(64) },
  };
  let release!: (value: unknown) => void;
  const unfinished = new Promise(resolve => {
    release = resolve;
  });
  get.mockImplementation((path: string) =>
    typeof path === 'string' && path.endsWith('/log-entries')
      ? Promise.resolve(entries)
      : unfinished,
  );
  const controller = new AbortController();
  const query = pageReportQuery('actor', '11111111-1111-4111-8111-111111111111', {
    resource: 'logs',
    startAt: 1,
    endAt: 1000,
    timezone: 'UTC',
  });
  const pending = query.queryFn({ signal: controller.signal });
  try {
    await vi.waitFor(() => expect(get.mock.calls[0]?.[0]).toMatch(/\/log-entries$/), {
      timeout: 100,
    });
    expect(await pending).toBe(entries);
    expect(get).toHaveBeenCalledTimes(1);
  } finally {
    release(entries);
    controller.abort();
    await pending.catch(() => {});
  }
});
