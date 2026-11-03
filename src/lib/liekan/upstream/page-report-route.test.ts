vi.mock('@/lib/liekan/upstream/crawler-registry-context', () => ({
  withPublishedRegistry: (work: () => unknown) => work(),
}));
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn() }));
vi.mock('./server', async () => ({
  authorize: mocks.authorize,
  LiekanError: (await import('./errors')).LiekanError,
}));
vi.mock('./page-report', () => ({ readPageReport: mocks.read }));
import { GET } from '@/app/api/liekan/websites/[websiteId]/page-report/route';
import { LiekanError } from './errors';
import { bindCacheRequest } from './cache-context';
import { timeReportQuery } from './analysis-diagnostics';
const id = '11111111-1111-4111-8111-111111111111';
const request = () =>
  new Request(
    `http://localhost/api/liekan/websites/${id}/page-report?resource=overview&startAt=0&endAt=1000`,
  );
const params = { params: Promise.resolve({ websiteId: id }) };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue({
    website: { id, name: 'Current name', domain: 'example.test' },
    canManage: false,
  });
  mocks.read.mockResolvedValue({
    value: { website: { id, name: 'Cached name' }, meta: { canManage: true } },
    generatedAt: 1,
    expiresAt: 30001,
    status: 'hit',
  });
});
it('rechecks access before a warm read and applies current metadata and management permissions', async () => {
  const response = await GET(request(), params);
  expect(response.status).toBe(200);
  const value = await response.json();
  expect(value.website.name).toBe('Current name');
  expect(value.meta.canManage).toBe(false);
  expect(response.headers.get('X-Liekan-Expires-At')).toBe('30001');
  mocks.authorize.mockRejectedValueOnce(new LiekanError('权限已撤销', 403));
  expect((await GET(request(), params)).status).toBe(403);
  expect(mocks.read).toHaveBeenCalledTimes(1);
});
it.each([401, 404])(
  'does not read derived statistics after an access failure (%i)',
  async status => {
    mocks.authorize.mockRejectedValue(new LiekanError('无法访问', status));
    const response = await GET(request(), params);
    expect(response.status).toBe(status);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(response.headers.has('X-Liekan-Expires-At')).toBe(false);
  },
);

it('records the shared cache source for page response freshness', async () => {
  mocks.read.mockResolvedValueOnce({
    value: { meta: {} },
    generatedAt: 1,
    expiresAt: 30001,
    status: 'hit',
    tier: 'redis',
  });
  const response = await GET(request(), params);
  expect(response.headers.get('X-Liekan-Cache-Tier')).toBe('redis');
  expect(response.headers.get('X-Liekan-Cache-Source')).toBe('redis');
});

it.each(['hit', 'miss', 'coalesced'])('reports the page cache status %s', async status => {
  mocks.read.mockResolvedValueOnce({
    value: { meta: {} },
    generatedAt: 1,
    expiresAt: 30001,
    status,
  });
  const response = await GET(request(), params);
  expect(response.headers.get('X-Liekan-Cache')).toBe(status);
});

it('checks final page authorization after reading a cached result', async () => {
  const authorizeAgain = vi.fn(async () => false);
  mocks.authorize.mockImplementation(async request => {
    bindCacheRequest(request, { user: { id: 'actor' } }, {}, authorizeAgain);
    return { website: { id, name: 'Current name', domain: 'example.test' }, canManage: false };
  });
  const response = await GET(request(), params);
  expect(response.status).toBe(403);
  expect(authorizeAgain).toHaveBeenCalledTimes(1);
});

it('keeps search engine reports behind the same private authorization gate', async () => {
  const request = new Request(
    `http://localhost/api/liekan/websites/${id}/page-report?resource=human/search-engines&startAt=0&endAt=1000`,
  );
  mocks.authorize.mockRejectedValueOnce(new LiekanError('无法访问', 401));
  expect((await GET(request, params)).status).toBe(401);
  expect(mocks.read).not.toHaveBeenCalled();
  expect((await GET(request, params)).status).toBe(200);
  expect(mocks.read.mock.calls[0][1].resource).toBe('human/search-engines');
});

it('keeps current HTTP timings alongside cache timings and excludes prior background timings', async () => {
  mocks.read.mockImplementationOnce(() =>
    timeReportQuery('human', async () => ({
      value: { meta: { workerComputeWallMs: 999999 } },
      generatedAt: 1,
      expiresAt: 30001,
      status: 'miss',
    })),
  );
  const response = await GET(request(), params);
  const timing = response.headers.get('Server-Timing');
  expect(timing).toContain('analytics;dur=');
  expect(timing).toMatch(/auth;dur=\d+\.\d;desc="wall-clock"/);
  expect(timing).toMatch(/report-human;dur=\d+\.\d;desc="wall-clock"/);
  expect(timing).not.toMatch(/999999|worker|queue/);
  const warm = await GET(request(), params);
  expect(warm.headers.get('Server-Timing')).not.toContain('report-human');
});

it('reports only current request and authorization time on access failures', async () => {
  mocks.authorize.mockRejectedValueOnce(new LiekanError('无法访问', 403));
  const response = await GET(request(), params);
  expect(response.headers.get('Server-Timing')).toContain('request;dur=');
  expect(response.headers.get('Server-Timing')).toContain('auth;dur=');
  expect(response.headers.get('Server-Timing')).not.toContain('report;dur=');
});
