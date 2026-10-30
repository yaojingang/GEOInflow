import { afterEach, expect, test, vi } from 'vitest';
import { getContentSecurityPolicy } from './csp';
afterEach(() => vi.unstubAllEnvs());
test('production blocks eval, plugins and foreign base URLs', () => {
  vi.stubEnv('NODE_ENV', 'production');
  const policy = getContentSecurityPolicy();
  expect(policy).not.toContain('unsafe-eval');
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("base-uri 'self'");
});
test('development retains the Next development runtime', () => {
  vi.stubEnv('NODE_ENV', 'development');
  expect(getContentSecurityPolicy()).toContain('unsafe-eval');
});
