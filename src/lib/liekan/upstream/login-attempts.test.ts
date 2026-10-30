import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const state = vi.hoisted(() => ({ enabled: false, connect: vi.fn(), eval: vi.fn() }));
vi.mock('@/lib/redis', () => ({
  default: {
    get enabled() {
      return state.enabled;
    },
    client: { connect: state.connect, client: { eval: state.eval } },
  },
}));
vi.mock('@/lib/crypto', () => ({ secret: () => 'login-attempt-fixture' }));
import { createLoginAttemptGuard, LOGIN_LIMITS } from './login-attempts';
const request = (ip = '192.0.2.1') =>
  new Request('https://example.com/api/auth/login', { headers: { 'x-real-ip': ip } });
beforeEach(() => {
  state.enabled = false;
  state.connect.mockReset().mockResolvedValue(undefined);
  state.eval.mockReset().mockResolvedValue([1, 0]);
  vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
});
afterEach(() => vi.unstubAllEnvs());

test('limits an account across clients and username case variants, with fixed expiry', async () => {
  let time = 0;
  const guard = createLoginAttemptGuard({ now: () => time });
  for (let i = 0; i < LOGIN_LIMITS.share; i++)
    (await guard(request(`192.0.2.${i + 1}`), i % 2 ? 'Alice' : 'alice'))();
  await expect(guard(request('198.51.100.1'), 'ALICE')).rejects.toMatchObject({
    status: 429,
    retryAfter: 60,
  });
  time = 60000;
  (await guard(request(), 'alice'))();
});

test('limits password spraying from one client across different accounts', async () => {
  const guard = createLoginAttemptGuard();
  for (let i = 0; i < LOGIN_LIMITS.client; i++) (await guard(request(), `account-${i}`))();
  await expect(guard(request(), 'another-account')).rejects.toMatchObject({ status: 429 });
});

test('unconfigured forwarding headers cannot bypass client limits', async () => {
  vi.stubEnv('CLIENT_IP_HEADER', '');
  const guard = createLoginAttemptGuard();
  for (let i = 0; i < LOGIN_LIMITS.client; i++)
    (await guard(request(`192.0.2.${i + 1}`), `account-${i}`))();
  await expect(guard(request('198.51.100.1'), 'another')).rejects.toMatchObject({ status: 429 });
});

test('uses opaque shared counters and fails closed when Redis is unavailable', async () => {
  state.enabled = true;
  (await createLoginAttemptGuard()(request(), 'Alice'))();
  const { keys, arguments: args } = state.eval.mock.calls[0][1];
  expect(args).toEqual(['60000', '120', '10', '30']);
  expect(keys.join()).toContain('liekan:login-password:v1:');
  expect(keys.join()).not.toMatch(/Alice|alice|192\.0\.2\.1/);
  (await createLoginAttemptGuard()(request(), 'alice'))();
  expect(state.eval.mock.calls[1][1].keys).toEqual(keys);
  state.eval.mockRejectedValue(new Error('offline'));
  await expect(createLoginAttemptGuard()(request(), 'alice')).rejects.toMatchObject({
    status: 503,
  });
});
