import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  getUserByUsername: vi.fn(),
  checkPassword: vi.fn(),
  findTwoFactorAuth: vi.fn(),
  createSecureToken: vi.fn(),
  secret: vi.fn(),
  hash: vi.fn(),
  getAllUserTeams: vi.fn(),
  saveAuth: vi.fn(),
  isTwoFactorConfigured: vi.fn(),
  acquireLoginAttempt: vi.fn(),
  releaseAttempt: vi.fn(),
}));

vi.mock('@/lib/liekan/upstream/login-attempts', () => ({
  acquireLoginAttempt: mocks.acquireLoginAttempt,
}));

vi.mock('@/lib/request', () => ({
  parseRequest: mocks.parseRequest,
}));

vi.mock('@/queries/prisma', () => ({
  getAllUserTeams: mocks.getAllUserTeams,
  getUserByUsername: mocks.getUserByUsername,
}));

vi.mock('@/lib/password', () => ({
  checkPassword: mocks.checkPassword,
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      twoFactorAuth: {
        findUnique: mocks.findTwoFactorAuth,
      },
    },
  },
}));

vi.mock('@/lib/jwt', () => ({
  createSecureToken: mocks.createSecureToken,
}));

vi.mock('@/lib/crypto', () => ({
  hash: mocks.hash,
  secret: mocks.secret,
}));

vi.mock('@/lib/auth', () => ({
  saveAuth: mocks.saveAuth,
}));

vi.mock('@/lib/redis', () => ({
  default: {
    enabled: false,
  },
}));

vi.mock('@/lib/two-factor/crypto', () => ({
  getTwoFactorConfigurationError: () => ({
    code: 'two-factor-error-not-configured',
    message: 'TWO_FACTOR_ENCRYPTION_KEY is missing or invalid',
  }),
  isTwoFactorConfigured: mocks.isTwoFactorConfigured,
}));

import { POST } from './route';
import redis from '@/lib/redis';
import { ShareAttemptError } from '@/lib/liekan/upstream/share-attempts';

test.each([429, 503] as const)(
  'rejects login before user lookup when admission returns %s',
  async status => {
    mocks.acquireLoginAttempt.mockRejectedValue(new ShareAttemptError(status, 7));
    const response = await POST(new Request('http://localhost/api/auth/login', { method: 'POST' }));
    expect(response.status).toBe(status);
    expect(response.headers.get('Retry-After')).toBe('7');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.getUserByUsername).not.toHaveBeenCalled();
    expect(mocks.createSecureToken).not.toHaveBeenCalled();
  },
);

test('releases admission after invalid credentials and database errors', async () => {
  mocks.getUserByUsername.mockResolvedValue(null);
  expect(
    (await POST(new Request('http://localhost/api/auth/login', { method: 'POST' }))).status,
  ).toBe(401);
  mocks.getUserByUsername.mockRejectedValue(new Error('database unavailable'));
  await expect(
    POST(new Request('http://localhost/api/auth/login', { method: 'POST' })),
  ).rejects.toThrow('database unavailable');
  expect(mocks.releaseAttempt).toHaveBeenCalledTimes(2);
});

beforeEach(() => {
  mocks.acquireLoginAttempt.mockReset().mockResolvedValue(mocks.releaseAttempt);
  mocks.releaseAttempt.mockReset();
  redis.enabled = false;
  mocks.parseRequest.mockReset();
  mocks.getUserByUsername.mockReset();
  mocks.checkPassword.mockReset();
  mocks.findTwoFactorAuth.mockReset();
  mocks.createSecureToken.mockReset();
  mocks.secret.mockReset();
  mocks.hash.mockReset();
  mocks.getAllUserTeams.mockReset();
  mocks.saveAuth.mockReset();
  mocks.isTwoFactorConfigured.mockReset();

  mocks.parseRequest.mockResolvedValue({
    body: { username: 'alice', password: 'secret' },
    error: undefined,
  });
  mocks.getUserByUsername.mockResolvedValue({
    id: 'user-1',
    username: 'alice',
    password: 'hashed-password',
    role: 'admin',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  mocks.checkPassword.mockReturnValue(true);
  mocks.findTwoFactorAuth.mockResolvedValue({ userId: 'user-1', isEnabled: true });
  mocks.isTwoFactorConfigured.mockReturnValue(true);
});

test('password login issues a full session for exactly 90 days', async () => {
  mocks.findTwoFactorAuth.mockResolvedValue(null);
  mocks.secret.mockReturnValue('app-secret');
  mocks.hash.mockReturnValue('pwd-fingerprint');
  mocks.createSecureToken.mockReturnValue('full-token');
  mocks.getAllUserTeams.mockResolvedValue([]);
  const response = await POST(new Request('http://localhost/api/auth/login', { method: 'POST' }));
  expect(response.status).toBe(200);
  expect(mocks.releaseAttempt).toHaveBeenCalledTimes(1);
  expect(mocks.createSecureToken).toHaveBeenCalledWith(
    { userId: 'user-1', role: 'admin', pwd: 'pwd-fingerprint' },
    'app-secret',
    { expiresIn: 7776000 },
  );
});

test('Redis password login uses the same 90-day session lifetime', async () => {
  redis.enabled = true;
  mocks.findTwoFactorAuth.mockResolvedValue(null);
  mocks.hash.mockReturnValue('pwd-fingerprint');
  mocks.saveAuth.mockResolvedValue('redis-token');
  mocks.getAllUserTeams.mockResolvedValue([]);
  const response = await POST(new Request('http://localhost/api/auth/login', { method: 'POST' }));
  expect(response.status).toBe(200);
  expect(mocks.saveAuth).toHaveBeenCalledWith(
    { userId: 'user-1', role: 'admin', pwd: 'pwd-fingerprint' },
    7776000,
  );
});

test('the pending 2FA challenge remains valid for only five minutes', async () => {
  mocks.secret.mockReturnValue('app-secret');
  mocks.createSecureToken.mockReturnValue('partial-token');
  const response = await POST(new Request('http://localhost/api/auth/login', { method: 'POST' }));
  expect(await response.json()).toMatchObject({
    requiresTwoFactor: true,
    partialToken: 'partial-token',
  });
  expect(mocks.createSecureToken).toHaveBeenCalledWith(
    { userId: 'user-1', type: 'partial-auth' },
    'app-secret',
    { expiresIn: '5m' },
  );
  expect(mocks.saveAuth).not.toHaveBeenCalled();
});

test('POST returns a configuration error instead of partial auth when 2FA is enabled but unavailable', async () => {
  mocks.isTwoFactorConfigured.mockReturnValue(false);

  const response = await POST(new Request('http://localhost/api/auth/login', { method: 'POST' }));

  expect(mocks.createSecureToken).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    error: {
      code: 'two-factor-error-not-configured',
    },
  });
  expect(response.status).toBe(503);
});
