import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiekanError } from '../upstream/errors';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  open: vi.fn(),
}));
vi.mock('../upstream/server', async () => ({
  ...(await vi.importActual('../upstream/errors')),
  query: vi.fn(),
  transaction: mocks.transaction,
  sourceWebsite: vi.fn().mockResolvedValue({ domain: 'example.com' }),
}));
vi.mock('./service', () => ({
  createSource: vi.fn(),
  ensureState: vi.fn().mockResolvedValue({ epoch: 1 }),
  publicUrl: () => 'https://stats.example.com',
  uuid: (value: string) => value,
  activateSource: vi.fn(),
  validateSource: vi.fn(),
}));
vi.mock('./secrets', () => ({
  newToken: () => 'a'.repeat(43),
  tokenHash: (value: string) => value,
  sealPlatformSecret: () => 'encrypted-fixture',
  openPlatformSecret: mocks.open,
}));
vi.mock('./capabilities', () => ({
  getLogCapabilities: vi.fn().mockResolvedValue({ cloudflare: { available: true } }),
}));
vi.mock('./queue', () => ({ enqueue: vi.fn(), PROVIDER_QUEUE: 'test-provider' }));

import { acceptCloudflareCallback, beginCloudflare, cloudflareApi } from './cloudflare';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubEnv('CLOUDFLARE_OAUTH_CLIENT_ID', 'fixture-client');
  vi.stubEnv('CLOUDFLARE_OAUTH_CLIENT_SECRET', 'fixture-client-secret');
  vi.stubEnv('CLOUDFLARE_OAUTH_SCOPES', '');
  mocks.query.mockResolvedValue([{ n: 0 }]);
  mocks.execute.mockResolvedValue(1);
  mocks.transaction.mockImplementation(fn =>
    fn({
      $queryRawUnsafe: mocks.query,
      $executeRawUnsafe: mocks.execute,
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('requests explicit Zone and Logpush scopes while preserving PKCE and browser binding', async () => {
  const result = await beginCloudflare('site', { userId: 'owner' });
  const url = new URL(result.authorizationUrl);
  expect(url.searchParams.get('scope')).toBe('zone.read logs.read logs.write');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('state')).toHaveLength(43);
  expect(result.cookie).toContain('HttpOnly; Secure; SameSite=Lax');
});
it('normalizes an explicit scope override', async () => {
  vi.stubEnv('CLOUDFLARE_OAUTH_SCOPES', ' zone.read  logs.read logs.read account-logs.read ');
  const result = await beginCloudflare('site', { userId: 'owner' });
  expect(new URL(result.authorizationUrl).searchParams.get('scope')).toBe(
    'zone.read logs.read account-logs.read',
  );
});
it('rejects invalid configured scopes before creating an authorization grant', async () => {
  vi.stubEnv('CLOUDFLARE_OAUTH_SCOPES', 'zone.read&redirect_uri=other');
  await expect(beginCloudflare('site', { userId: 'owner' })).rejects.toMatchObject({ status: 503 });
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it.each([
  [403, 1004, 'logpush is not enabled for this account', 'provider-not-entitled', 403],
  [403, 10000, 'Authentication error', 'reauthorization-required', 401],
  [401, 0, 'Unauthorized', 'reauthorization-required', 401],
  [403, 9109, 'Insufficient permissions', 'provider-permission-denied', 403],
  [429, 0, 'Rate limited', 'provider-unavailable', 503],
  [500, 0, 'Internal error', 'provider-unavailable', 503],
  [503, 10000, 'Provider outage with an authentication-shaped error', 'provider-unavailable', 503],
] as const)(
  'classifies provider HTTP %s code %s without exposing response text',
  async (status, code, message, errorCode, exposedStatus) => {
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code, message: `${message}; fixture-response-secret` }],
        }),
        { status },
      ),
    );
    await expect(
      cloudflareApi('fixture-access-token', '/zones/zone/logpush/jobs'),
    ).rejects.toMatchObject({ status: exposedStatus, code: errorCode });
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logs).not.toMatch(/fixture-access-token|fixture-response-secret|fixture-client-secret/);
  },
);
it('does not treat another API product code 1004 as a Logpush entitlement error', async () => {
  mocks.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 1004, message: 'An unrelated product failure' }],
      }),
      { status: 403 },
    ),
  );
  await expect(cloudflareApi('fixture-access-token', '/zones/zone/settings')).rejects.toMatchObject(
    { code: 'provider-permission-denied' },
  );
});
it('returns successful provider results unchanged', async () => {
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify({ success: true, result: [{ id: 'job' }] })),
  );
  expect(await cloudflareApi('fixture-access-token', '/zones/zone/logpush/jobs')).toEqual([
    { id: 'job' },
  ]);
  expect(console.error).not.toHaveBeenCalled();
});

it.each(['ENOTFOUND', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'ECONNRESET'])(
  'records a safe %s diagnostic and preserves only sanitized cause metadata',
  async code => {
    mocks.fetch.mockRejectedValue(
      new TypeError('fixture-secret https://user:password@private/', {
        cause: Object.assign(new Error('fixture-cause-secret'), { code }),
      }),
    );
    let failure: LiekanError | undefined;
    try {
      await cloudflareApi('fixture-access-token', '/zones/zone/logpush/jobs');
    } catch (error) {
      failure = error as LiekanError;
    }
    expect(failure).toMatchObject({ status: 503, cause: { code } });
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logs).toContain(code);
    expect(logs).toContain('api');
    expect(logs).not.toMatch(
      /fixture-secret|fixture-cause-secret|fixture-access-token|user:password|private/,
    );
  },
);
it('records timeout and redirect causes without logging arbitrary error messages', async () => {
  mocks.fetch.mockRejectedValueOnce(new DOMException('fixture-timeout-secret', 'TimeoutError'));
  await expect(
    cloudflareApi('fixture-access-token', '/zones/zone/logpush/jobs'),
  ).rejects.toMatchObject({ status: 503 });
  mocks.fetch.mockRejectedValueOnce(
    new TypeError('fetch failed', { cause: new Error('unexpected redirect fixture-secret') }),
  );
  await expect(
    cloudflareApi('fixture-access-token', '/zones/zone/logpush/jobs'),
  ).rejects.toMatchObject({ status: 503 });
  const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
  expect(logs).toContain('TimeoutError');
  expect(logs).toContain('redirect-not-allowed');
  expect(logs).not.toMatch(/fixture-timeout-secret|fixture-secret/);
});

it.each([429, 500])(
  'reports token exchange HTTP %s as temporary provider failure instead of expired authorization',
  async status => {
    mocks.query.mockResolvedValue([
      {
        id: 'flow',
        browser_hash: 'browser',
        expires_at: new Date(Date.now() + 60000),
        payload: 'encrypted',
      },
    ]);
    mocks.open.mockReturnValue(JSON.stringify({ phase: 'pending', verifier: 'fixture-verifier' }));
    mocks.fetch.mockResolvedValue(new Response('{}', { status }));
    const url = `https://stats.example.com/callback?state=${'a'.repeat(43)}&code=fixture-code`;
    await expect(
      acceptCloudflareCallback(
        new Request(url, { headers: { cookie: 'liekan_oauth_flow=browser' } }),
      ),
    ).rejects.toMatchObject({ status: 503, code: 'provider-unavailable' });
    const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logs).not.toMatch(/fixture-code|fixture-verifier|fixture-client-secret/);
  },
);
