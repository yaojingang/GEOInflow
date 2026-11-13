import { beforeEach, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('./features-client', () => ({ featureApi: { get } }));

import { pageReportQuery } from './page-report-client';

beforeEach(() => get.mockReset());

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
