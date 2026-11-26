import { expect, test } from 'vitest';
import { sanitizeCollectionUrl, sanitizeTrackerUrl } from './privacy';

test.each([
  ['/activate/token/abc123', '/activate/token/[redacted]'],
  ['/reset/short-code', '/reset/[redacted]'],
  ['/password-reset/random-token', '/password-reset/[redacted]'],
  ['/reset-password/123456', '/reset-password/[redacted]'],
  ['/verify/123456', '/verify/[redacted]'],
  ['/share/short-id', '/share/[redacted]'],
  ['/s/ffffffff-ffff-ffff-ffff-ffffffffffff/e', '/s/[redacted]/e'],
  ['/API-KEY/a%2Fb%3Fc/next', '/API-KEY/[redacted]/next'],
  ['/%74oken/abc123', '/%74oken/[redacted]'],
  ['/token/abc%ZZ', '/token/[redacted]'],
  ['/token//abc123/', '/token//[redacted]/'],
  ['/token%2Fabc123/next', '/[redacted]/next'],
  ['/token%252Fabc123/next', '/[redacted]/next'],
  ['/#/reset/abc123', '/#/reset/[redacted]'],
  ['/#!/verify/123456', '/#!/verify/[redacted]'],
  ['/#/profile/private%40example.com', '/#/profile/[redacted]'],
])('redacts path secrets at both collection boundaries: %s', (value, expected) => {
  expect(sanitizeTrackerUrl(value)).toBe(expected);
  expect(sanitizeCollectionUrl(value, 'https://example.com')).toBe(
    `https://example.com${expected}`,
  );
  expect(sanitizeTrackerUrl(expected)).toBe(expected);
});

test.each([
  '/docs/getting-started',
  '/docs/code/examples',
  '/docs/code/reference',
  '/docs/email/delivery',
  '/docs/phone/format',
  '/docs/mobile/install',
  '/articles/11111111-1111-4111-8111-111111111111',
  '/articles/22222222-2222-4222-8222-222222222222',
  '/files/ABCDEF1234567890/download',
  '/files/ffffffff-ffff-ffff-ffff-ffffffffffff',
  '/files/%61bcdef1234567890',
  '/articles/deadbeef1234567890',
  '/articles/cafefeed1234567890',
  '/#/articles/11111111-1111-4111-8111-111111111111',
  '/users/12345/orders/98765',
  '/orders/12345678901234567890123456789012',
  '/archive/2026-11-03/v1.2.3',
  '/articles/a-long-ordinary-slug-with-many-letters-and-digits-12345',
  '/assets/abcdef123456789',
  '/docs/reset-password-guide/tokenization',
  '/caf%C3%A9/keep%2fcase/%invalid',
  '/docs//chapter-2/',
  '/docs/hello%20world',
  '/docs?category=safe&utm_source=google#/chapter-2',
])('preserves ordinary route bytes: %s', value => {
  expect(sanitizeTrackerUrl(value)).toBe(value);
  expect(sanitizeCollectionUrl(value, 'https://example.com')).toBe(`https://example.com${value}`);
});

test.each(['', '/', '//other.example/', 'https://other.example/'])(
  'preserves outbound URL resolution while redacting paths: %s',
  prefix => {
    expect(sanitizeTrackerUrl(`${prefix}reset/abc123?category=safe#details`)).toBe(
      `${prefix}reset/[redacted]?category=safe#details`,
    );
  },
);

test('redacts a combined path, hash route, credentials and parameters', () => {
  const output = sanitizeTrackerUrl(
    'https://user:password@example.com/reset/url-secret?token=query-secret&utm_source=google#/verify/hash-secret?code=fragment-secret&tab=done',
  );
  const url = new URL(output);
  expect(url.pathname).toBe('/reset/[redacted]');
  expect(url.hash).toBe('#/verify/[redacted]?code=%5Bredacted%5D&tab=done');
  expect(url.searchParams.get('token')).toBe('[redacted]');
  expect(url.searchParams.get('utm_source')).toBe('google');
  expect(output).not.toMatch(/user:password|url-secret|query-secret|hash-secret|fragment-secret/);
});

test.each([
  ['/token/discarded/../retained', '/token/[redacted]/../[redacted]'],
  ['/token/./retained', '/token/./[redacted]'],
  ['/docs/token/../public', '/docs/token/../public'],
  ['/to\tken/secret-value', '/to\tken/[redacted]'],
  [
    String.raw`https:\\example.com\reset\secret-value`,
    String.raw`https:\\example.com\reset\[redacted]`,
  ],
  ['https://abcdef1234567890.example/docs', 'https://abcdef1234567890.example/docs'],
])('handles browser path normalization without leaking values: %s', (value, expected) => {
  expect(sanitizeTrackerUrl(value)).toBe(expected);
  expect(sanitizeCollectionUrl(value, 'https://example.com')).toBe(
    new URL(expected, 'https://example.com').href,
  );
});

test.each(['https://[invalid/reset/private-token', 'http://%invalid/token/private-token'])(
  'does not send an unparseable address unchanged: %s',
  value => {
    expect(sanitizeTrackerUrl(value)).toBe('');
  },
);

test('invalid collector URLs do not retain the supplied value on the thrown error', () => {
  const value = 'https://[invalid/reset/synthetic-private-value';
  let failure: unknown;
  try {
    sanitizeCollectionUrl(value);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('Invalid collection URL');
  expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(
    'synthetic-private-value',
  );
});

test.each(['a'.repeat(64000), `${'a'.repeat(32000)}@${'b'.repeat(32000)}`])(
  'long non-secret paths have bounded processing time',
  value => {
    const before = performance.now();
    expect(sanitizeTrackerUrl(`/${value}`)).toBe(`/${value}`);
    expect(performance.now() - before).toBeLessThan(1000);
  },
);

test.each([
  'alice@example.com',
  'prefix alice@example.com suffix',
  'a@b@c.example',
  '/a@b.example',
])('keeps email privacy at candidate boundaries: %s', value => {
  expect(sanitizeCollectionUrl(`https://example.com/?q=${encodeURIComponent(value)}`)).toContain(
    'redacted',
  );
});

test('redacts credentials and sensitive duplicate query values while preserving campaigns', () => {
  const url = new URL(
    sanitizeCollectionUrl(
      'https://user:password@example.com/?token=first&token=second&utm_source=google&page=2&email=a%40example.com',
    ),
  );
  expect(url.username).toBe('');
  expect(url.password).toBe('');
  expect(url.searchParams.getAll('token')).toEqual(['[redacted]', '[redacted]']);
  expect(url.searchParams.get('email')).toBe('[redacted]');
  expect(url.searchParams.get('utm_source')).toBe('google');
  expect(url.searchParams.get('page')).toBe('2');
});

test.each([
  '#access_token=oauth-secret&state=safe',
  '#/callback?code=oauth-secret',
  '?%74oken=oauth-secret',
])('redacts sensitive fragments and encoded parameter names: %s', suffix => {
  const output = sanitizeCollectionUrl(`https://example.com/${suffix}`);
  expect(output).not.toContain('oauth-secret');
});

test('preserves hash routing, ordinary search and relative referrers', () => {
  const path = '/articles?q=analytics&utm_campaign=autumn#/chapter-2';
  expect(sanitizeCollectionUrl(path, 'https://example.com')).toBe(`https://example.com${path}`);
});

test.each([
  'virtual?category=safe#details',
  '/virtual?category=safe#details',
  '//other.example/virtual?category=safe#details',
  'https://other.example/virtual?category=safe#details',
])('preserves the explicit outbound URL shape: %s', value => {
  expect(sanitizeTrackerUrl(value)).toBe(value);
});

test.each([
  'https://user:password@other.example/virtual?token=private-value',
  '//user:password@other.example/virtual?token=private-value',
  ' https://user:password@other.example/virtual?token=private-value',
  '\thttps://user:password@other.example/virtual?token=private-value',
  String.raw`https:\\user:password@other.example/virtual?token=private-value`,
])('redacts explicit authority credentials: %s', value => {
  const result = sanitizeTrackerUrl(value);
  expect(result).not.toMatch(/user:password|private-value/);
  expect(result).toContain('other.example/virtual?token=');
  expect(result).toContain('redacted');
});
