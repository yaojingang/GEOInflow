import { expect, test } from 'vitest';
import { sanitizeCollectionUrl } from './privacy';

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
