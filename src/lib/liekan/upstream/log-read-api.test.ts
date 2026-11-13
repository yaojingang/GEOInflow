import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authorize: vi.fn(),
  entries: vi.fn(),
  count: vi.fn(),
  summary: vi.fn(),
  async: vi.fn(),
  published: vi.fn(),
  probeMiss: true,
}));
vi.mock('./report-fragments', () => {
  class ReportFragmentMiss extends Error {}
  return {
    ReportFragmentMiss,
    withReportFragments: async (_site: string, work: () => Promise<unknown>, options: any) => {
      if (options?.readOnly && mocks.probeMiss) throw new ReportFragmentMiss();
      return work();
    },
  };
});
vi.mock('./crawler-registry-context', () => ({ withPublishedRegistry: (work: any) => work() }));
vi.mock('./crawler-maintenance', () => ({ authenticateCrawlerMaintenance: mocks.authenticate }));
vi.mock('./server', async () => ({
  authorize: mocks.authorize,
  reportSnapshot: (work: any) => work(),
  LiekanError: (await import('./errors')).LiekanError,
}));
vi.mock('./log-read', () => ({
  readLogEntries: mocks.entries,
  readLogCount: mocks.count,
  readLogSummary: mocks.summary,
}));
vi.mock('./log-read-boundary', async () => ({
  ...(await vi.importActual('./log-read-boundary')),
  logReadBoundary: async () => 'a'.repeat(64),
}));
vi.mock('./query-snapshot', () => ({ getQuerySnapshot: () => ({}) }));
vi.mock('./analysis-query-api', () => ({
  analysisAsyncRequested: (r: Request) => r.headers.get('prefer') === 'respond-async',
  privateAnalysisResponse: mocks.async,
  publishedLogCountResponse: mocks.published,
}));

import { bindCacheRequest } from './cache-context';
import { LiekanError } from './errors';
import { logReadResponse } from './log-read-api';

const id = '11111111-1111-4111-8111-111111111111';
const request = (part: string, headers = {}) =>
  new Request(
    `http://localhost/api/liekan/websites/${id}/log-${part}?startAt=1&endAt=1000&timezone=UTC&readBoundary=${'a'.repeat(64)}`,
    { headers },
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.probeMiss = true;
  mocks.published.mockResolvedValue(undefined);
  mocks.authenticate.mockResolvedValue({ id: 'actor', role: 'admin' });
  mocks.authorize.mockResolvedValue({ website: { id, name: 'Current' }, canManage: false });
  mocks.entries.mockResolvedValue({ tables: { logBody: [] } });
  mocks.count.mockResolvedValue({ total: 0, readBoundary: 'a'.repeat(64) });
  mocks.summary.mockResolvedValue({ cards: [] });
  mocks.async.mockImplementation(() =>
    Response.json({ analysisJob: { id: 'job' } }, { status: 202 }),
  );
});

it.each(['entries', 'count', 'summary'] as const)(
  'reauthorizes %s and returns private timing headers',
  async part => {
    const r = await logReadResponse(request(part), id, part);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('server-timing')).toContain(`log-${part};dur=`);
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
  },
);

it.each(['entries', 'count', 'summary'] as const)(
  'rejects incomplete or public identities before any %s read',
  async part => {
    mocks.authenticate.mockRejectedValue(new LiekanError('需要完整登录', 401));
    expect((await logReadResponse(request(part), id, part)).status).toBe(401);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.entries).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.summary).not.toHaveBeenCalled();
  },
);

it.each([403, 404])('does not read logs or enqueue a job after access failure %i', async status => {
  mocks.authorize.mockRejectedValue(new LiekanError('无法访问', status));
  expect(
    (await logReadResponse(request('count', { prefer: 'respond-async' }), id, 'count')).status,
  ).toBe(status);
  expect(mocks.async).not.toHaveBeenCalled();
  expect(mocks.count).not.toHaveBeenCalled();
});

it('registers an exact count task without executing its SQL in the foreground', async () => {
  expect(
    (await logReadResponse(request('count', { prefer: 'respond-async' }), id, 'count')).status,
  ).toBe(202);
  expect(mocks.async.mock.calls[0][3]).toBe('feature:log-count');
  expect(mocks.count).not.toHaveBeenCalled();
  expect(mocks.entries).not.toHaveBeenCalled();
});
it('delivers a proved complete count before probing its component fragments', async () => {
  mocks.published.mockResolvedValueOnce(Response.json({ readBoundary: 'a'.repeat(64), total: 7 }));
  const response = await logReadResponse(
    new Request(request('count').url + '&crawlerMetricsVersion=1', {
      headers: { prefer: 'respond-async' },
    }),
    id,
    'count',
  );
  expect(response.status).toBe(200);
  expect((await response.json()).total).toBe(7);
  expect(mocks.count).not.toHaveBeenCalled();
  expect(mocks.async).not.toHaveBeenCalled();
});

it.each(['summary', 'count'] as const)(
  'queues a missing modern %s without scanning its historical input',
  async part => {
    const r = new Request(
      request(part, { prefer: 'respond-async' }).url + '&crawlerMetricsVersion=1',
      { headers: { prefer: 'respond-async' } },
    );
    expect((await logReadResponse(r, id, part)).status).toBe(202);
    expect(mocks.async.mock.calls[0][3]).toBe(`feature:log-${part}`);
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.summary).not.toHaveBeenCalled();
  },
);
it.each(['summary', 'count'] as const)(
  'delivers a prepared modern %s and rechecks current authority',
  async part => {
    mocks.probeMiss = false;
    const r = new Request(
      request(part, { prefer: 'respond-async' }).url + '&crawlerMetricsVersion=1',
      { headers: { prefer: 'respond-async' } },
    );
    const response = await logReadResponse(r, id, part);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-liekan-read-path')).toBe('published');
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.async).not.toHaveBeenCalled();
  },
);
it('clears a prepared summary when authority is revoked during its tail read', async () => {
  mocks.probeMiss = false;
  mocks.authorize
    .mockResolvedValueOnce({ website: { id }, canManage: false })
    .mockRejectedValueOnce(new LiekanError('无权访问', 403));
  const r = new Request(
    request('summary', { prefer: 'respond-async' }).url + '&crawlerMetricsVersion=1',
    { headers: { prefer: 'respond-async' } },
  );
  expect((await logReadResponse(r, id, 'summary')).status).toBe(403);
  expect(mocks.async).not.toHaveBeenCalled();
});
it('bounds concurrent prepared tail reads with the shared foreground computation gate', async () => {
  mocks.probeMiss = false;
  let release: () => void,
    running = 0,
    maximum = 0;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  mocks.count.mockImplementation(async () => {
    running++;
    maximum = Math.max(maximum, running);
    await held;
    running--;
    return { readBoundary: 'a'.repeat(64), total: 0 };
  });
  const calls = Array.from({ length: 3 }, () =>
    logReadResponse(
      new Request(request('count').url + '&crawlerMetricsVersion=1', {
        headers: { prefer: 'respond-async' },
      }),
      id,
      'count',
    ),
  );
  try {
    await vi.waitFor(() => expect(mocks.count).toHaveBeenCalledTimes(2));
    expect(maximum).toBe(2);
  } finally {
    release();
    await Promise.all(calls);
  }
  expect(maximum).toBe(2);
});
it.each(['P2024', 'P2028'])(
  'defers a prepared probe when its short database budget fails with %s',
  async code => {
    mocks.probeMiss = false;
    mocks.summary.mockRejectedValueOnce(
      Object.assign(new Error('synthetic database budget failure'), { code }),
    );
    const r = new Request(request('summary').url + '&crawlerMetricsVersion=1', {
      headers: { prefer: 'respond-async' },
    });
    expect((await logReadResponse(r, id, 'summary')).status).toBe(202);
    expect(mocks.async).toHaveBeenCalledTimes(1);
  },
);

it('checks current permission again before publishing an independently loaded part', async () => {
  mocks.authorize.mockImplementation(async request => {
    bindCacheRequest(request, { user: { id: 'actor' } }, {}, async () => false);
    return { website: { id }, canManage: false };
  });
  expect((await logReadResponse(request('entries'), id, 'entries')).status).toBe(403);
});
