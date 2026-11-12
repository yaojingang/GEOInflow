import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authorize: vi.fn(),
  entries: vi.fn(),
  count: vi.fn(),
  summary: vi.fn(),
  async: vi.fn(),
}));
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

it('checks current permission again before publishing an independently loaded part', async () => {
  mocks.authorize.mockImplementation(async request => {
    bindCacheRequest(request, { user: { id: 'actor' } }, {}, async () => false);
    return { website: { id }, canManage: false };
  });
  expect((await logReadResponse(request('entries'), id, 'entries')).status).toBe(403);
});
