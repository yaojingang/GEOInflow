import { beforeEach, expect, test, vi } from 'vitest';
import { LiekanError } from '@/lib/liekan/upstream/errors';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), download: vi.fn() }));
vi.mock('@/lib/liekan/upstream/server', () => ({ authorize: mocks.authorize }));
vi.mock('@/lib/liekan/upstream/warehouse-export-artifact', () => ({
  downloadWarehouseExport: mocks.download,
}));
vi.mock('@/lib/liekan/http', () => ({
  requestApi: async (_request: Request, work: () => Promise<Response>) => {
    try {
      return await work();
    } catch (error) {
      return Response.json({}, { status: (error as { status?: number }).status ?? 500 });
    }
  },
}));
import { GET } from './route';

const site = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const url = `http://localhost/api/liekan/websites/${site}/exports/${id}`;
const params = () => ({ params: Promise.resolve({ websiteId: site, exportId: id }) });
beforeEach(() => {
  mocks.authorize.mockReset().mockImplementation(async (request: Request) => {
    const credential = request.headers.get('authorization');
    if (
      !['Bearer old-session', 'Bearer new-session', 'Bearer partial-session'].includes(credential)
    )
      throw new LiekanError('需要完整登录', 401);
    return {
      website: { id: site },
      auth: {
        authType: credential === 'Bearer partial-session' ? 'partial' : 'session',
        user: { id: credential },
      },
    };
  });
  mocks.download.mockReset().mockImplementation(async (_site, owner) => new Response(owner));
});

test('old per-artifact cookies cannot authenticate after logout', async () => {
  const response = await GET(
    new Request(url, {
      headers: { cookie: `liekan_export_${id.replaceAll('-', '')}=old-session` },
    }),
    params(),
  );
  expect(response.status).toBe(401);
  expect(mocks.download).not.toHaveBeenCalled();
});

test('the known export session cookie can authenticate a browser download', async () => {
  const response = await GET(
    new Request(url, {
      headers: { cookie: 'liekan.locale=en-US; liekan_export_session=old-session' },
    }),
    params(),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('Bearer old-session');
});

test('an explicit new identity takes precedence over an old export cookie', async () => {
  const response = await GET(
    new Request(url, {
      headers: { authorization: 'Bearer new-session', cookie: 'liekan_export_session=old-session' },
    }),
    params(),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('Bearer new-session');
});

test('an invalid explicit identity cannot fall back to a valid export cookie', async () => {
  const response = await GET(
    new Request(url, {
      headers: { authorization: 'Bearer expired', cookie: 'liekan_export_session=old-session' },
    }),
    params(),
  );
  expect(response.status).toBe(401);
  expect(mocks.download).not.toHaveBeenCalled();
});

test('a partial identity cannot use the export download', async () => {
  const response = await GET(
    new Request(url, { headers: { cookie: 'liekan_export_session=partial-session' } }),
    params(),
  );
  expect(response.status).toBe(401);
  expect(mocks.download).not.toHaveBeenCalled();
});

test('stream reauthorization rejects an identity change', async () => {
  mocks.download.mockImplementation(async (_site, _owner, _id, _signal, reauthorize) => {
    mocks.authorize.mockResolvedValue({
      website: { id: site },
      auth: { authType: 'session', user: { id: 'different-user' } },
    });
    await reauthorize();
    return new Response('private data');
  });
  const response = await GET(
    new Request(url, { headers: { authorization: 'Bearer old-session' } }),
    params(),
  );
  expect(response.status).toBe(401);
});
