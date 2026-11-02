import { expect, test } from 'vitest';
import { sanitizeCollectionUrl, sanitizeTrackerUrl } from './privacy';

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
