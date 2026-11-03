import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import { afterEach, expect, it, vi } from 'vitest';
import { analyticsRefreshJobSchema } from './analytics-hot-parameters';

vi.mock('next-intl/plugin', () => ({ default: () => (config: unknown) => config }));
afterEach(() => vi.unstubAllEnvs());

async function responseFor(path: string, prefix: string, prefer?: string, basePath = '') {
  vi.stubEnv('API_URL', prefix);
  vi.resetModules();
  const nextConfig = (await import('../../../../next.config')).default;
  return unstable_getResponseFromNextConfig({
    url: `https://example.com${basePath}${prefix || '/api'}${path}`,
    nextConfig: { ...nextConfig, basePath },
    headers: prefer ? { prefer } : {},
  });
}

it.each(['', '/private-api'])(
  'preserves private analysis headers through Next routing under %s',
  async prefix => {
    for (const path of [
      '/liekan/storage',
      '/liekan/storage?runId=preview',
      '/liekan/websites/site/storage',
      '/liekan/websites/site/storage?runId=preview',
      '/liekan/analytics-acceleration',
      '/liekan/websites/site/analytics-acceleration',
      '/liekan/websites/site/analytics-acceleration/build',
      '/liekan/websites/site/analytics-acceleration/action',
      '/liekan/websites/site/analytics-jobs/job',
      '/liekan/websites/site/analytics-jobs/job/result',
      '/liekan/websites/site/page-report',
      '/liekan/websites/site/analytics',
      '/liekan/websites/site/journeys',
    ]) {
      const response = await responseFor(path, prefix);
      expect(response.headers.get('cache-control'), path).toBe('private, no-store');
      expect(response.headers.get('vary'), path).toContain('Authorization');
    }
  },
);

it.each(['', '/private-api'])(
  'preserves async native response headers without changing ordinary requests under %s',
  async prefix => {
    for (const target of analyticsRefreshJobSchema.shape.target.options.filter(value =>
      value.startsWith('native:'),
    )) {
      const path = `/websites/site/${target.slice(7)}`;
      for (const prefer of ['respond-async', 'wait=2, respond-async']) {
        const response = await responseFor(path, prefix, prefer);
        expect(response.headers.get('cache-control'), `${path} ${prefer}`).toBe(
          'private, no-store',
        );
        expect(response.headers.get('vary'), path).toContain('Prefer');
      }
      const ordinary = await responseFor(path, prefix);
      expect(ordinary.headers.get('cache-control'), path).toBe('no-cache');
    }
    const collector = await responseFor('/send', prefix, 'respond-async');
    expect(collector.headers.get('cache-control')).toBe('no-cache');
    const share = await responseFor('/liekan/websites/site/shared-report', prefix, 'respond-async');
    expect(share.headers.get('cache-control')).toBe('no-cache');
  },
);

it.each([
  '/liekan/websites/site/analytics-jobs/job/result',
  '/liekan/storage',
  '/liekan/websites/site/storage',
])('preserves analysis privacy under a configured base path for %s', async path => {
  const response = await responseFor(path, '', undefined, '/stats');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});
