import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ parseRequest: vi.fn(), getAllUserTeams: vi.fn() }));
vi.mock('@/lib/request', () => ({ parseRequest: mocks.parseRequest }));
vi.mock('@/queries/prisma', () => ({ getAllUserTeams: mocks.getAllUserTeams }));
import { POST } from './route';

beforeEach(() => {
  mocks.parseRequest.mockReset().mockResolvedValue({
    auth: { token: 'new-session', user: { id: 'new-user' } },
    error: undefined,
  });
  mocks.getAllUserTeams.mockReset().mockResolvedValue([]);
});

test('SSO verification expires a previous identity export cookie and preserves the verified response', async () => {
  const response = await POST(
    new Request('https://example.com/geo/api/auth/verify', {
      method: 'POST',
      headers: {
        authorization: 'Bearer new-session',
        cookie: 'liekan_export_session=old-session; liekan.locale=en-US',
      },
    }),
  );
  expect(await response.json()).toEqual({ id: 'new-user', teams: [] });
  expect(response.headers.get('set-cookie')).toBe(
    'liekan_export_session=; Path=/geo/api; HttpOnly; SameSite=Strict; Max-Age=0; Secure',
  );
  expect(response.headers.get('clear-site-data')).toBeNull();
});

test('same-session verification retains the export cookie for an in-progress download', async () => {
  const response = await POST(
    new Request('http://localhost/api/auth/verify', {
      method: 'POST',
      headers: { authorization: 'Bearer new-session', cookie: 'liekan_export_session=new-session' },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBeNull();
});

test('failed verification clears a remembered export identity without changing the error', async () => {
  mocks.parseRequest.mockResolvedValue({
    auth: null,
    error: () => new Response(null, { status: 401 }),
  });
  const response = await POST(new Request('http://localhost/api/auth/verify', { method: 'POST' }));
  expect(response.status).toBe(401);
  expect(response.headers.get('set-cookie')).toContain(
    'liekan_export_session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0',
  );
  expect(mocks.getAllUserTeams).not.toHaveBeenCalled();
});
