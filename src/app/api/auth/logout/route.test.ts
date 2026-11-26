import { beforeEach, expect, test, vi } from 'vitest';
import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import { POST } from './route';

vi.mock('@/lib/redis', () => ({
  default: {
    enabled: true,
    client: {
      del: vi.fn(),
    },
  },
}));

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

vi.mock('@/lib/response', () => ({
  ok: () => new Response(null, { status: 200 }),
}));

const redisMock = redis as unknown as {
  enabled: boolean;
  client: {
    del: ReturnType<typeof vi.fn>;
  };
};
const parseRequestMock = vi.mocked(parseRequest);

beforeEach(() => {
  redisMock.enabled = true;
  redisMock.client.del.mockReset();
  parseRequestMock.mockReset();
});

test('POST deletes the authenticated Redis auth key', async () => {
  parseRequestMock.mockResolvedValue({
    auth: { authKey: 'auth:session-key' },
    error: undefined,
  });

  const response = await POST(
    new Request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secure-token',
      },
    }),
  );

  expect(redisMock.client.del).toHaveBeenCalledTimes(1);
  expect(redisMock.client.del).toHaveBeenCalledWith('auth:session-key');
  expect(redisMock.client.del).not.toHaveBeenCalledWith('secure-token');
  expect(response.status).toBe(200);
});

test('POST does not delete a key when auth fails', async () => {
  parseRequestMock.mockResolvedValue({
    auth: null,
    error: () => new Response(null, { status: 401 }),
  });

  const response = await POST(new Request('http://localhost/api/auth/logout', { method: 'POST' }));

  expect(redisMock.client.del).not.toHaveBeenCalled();
  expect(response.status).toBe(401);
});

test.each([true, false])(
  'logout expires the export credential with Redis enabled=%s',
  async enabled => {
    redisMock.enabled = enabled;
    parseRequestMock.mockResolvedValue({ auth: { authKey: 'auth:session-key' }, error: undefined });
    const response = await POST(
      new Request('https://example.com/geo/api/auth/logout', { method: 'POST' }),
    );
    expect(response.headers.get('set-cookie')).toBe(
      'liekan_export_session=; Path=/geo/api; HttpOnly; SameSite=Strict; Max-Age=0; Secure',
    );
    expect(response.headers.get('clear-site-data')).toBeNull();
  },
);

test('logout clears the export cookie even when the main credential is already missing', async () => {
  parseRequestMock.mockResolvedValue({
    auth: null,
    error: () => new Response(null, { status: 401 }),
  });
  const response = await POST(new Request('http://localhost/api/auth/logout', { method: 'POST' }));
  expect(response.headers.get('set-cookie')).toContain('liekan_export_session=; Path=/api;');
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
});
