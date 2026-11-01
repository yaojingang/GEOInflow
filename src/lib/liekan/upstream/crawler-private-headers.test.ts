import { afterEach, expect, it, vi } from 'vitest';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';

vi.mock('next-intl/plugin', () => ({ default: () => (config: unknown) => config }));
afterEach(() => vi.unstubAllEnvs());

async function effectiveHeaders(path: string, prefix = '') {
  vi.stubEnv('API_URL', prefix);
  vi.resetModules();
  const config = (await import('../../../../next.config')).default;
  const headers: Record<string, string> = {};
  for (const rule of await config.headers())
    if (getPathMatch(rule.source)(path))
      for (const header of rule.headers) headers[header.key.toLowerCase()] = header.value;
  return headers;
}

it.each(['', '/private-api'])(
  'preserves private crawler response policy under API prefix %s',
  async prefix => {
    const api = prefix || '/api';
    for (const endpoint of [
      '/liekan/crawler-handoffs',
      '/liekan/history-repair',
      '/liekan/cache-manifest',
      '/liekan/admin/crawler-sources',
      '/liekan/crawler-handoffs/reconcile',
      ...[
        'control-connections',
        'crawler-analysis',
        'crawler-recognition',
        'crawler-candidates',
        'crawler-context',
        'traffic-quality/observations',
        'traffic-quality/reconciliation',
        'traffic-quality/export-evidence',
        'crawler-checks',
        'crawler-deployments',
        'crawler-domain-verification',
        'crawler-exports',
        'crawler-findings',
        'crawler-policies',
        'history-repair',
        'geo-weight',
      ].flatMap(resource => [
        `/liekan/websites/site/${resource}`,
        `/liekan/websites/site/${resource}/id/reconcile`,
      ]),
    ]) {
      const headers = await effectiveHeaders(api + endpoint, prefix);
      expect(headers['cache-control'], endpoint).toBe('private, no-store');
      expect(headers.vary, endpoint).toBe('Authorization');
      expect(headers['access-control-allow-methods'], endpoint).toContain('PATCH');
    }
  },
);

it('keeps collector and AI policies independent of crawler paths', async () => {
  expect((await effectiveHeaders('/api/send'))['cache-control']).toBe('no-cache');
  expect((await effectiveHeaders('/api/liekan/ai/catalog'))['cache-control']).toBe(
    'private, no-store',
  );
});

it.each(['', '/private-api'])(
  'keeps robots drafts, publication evidence and pairing responses private under prefix %s',
  async prefix => {
    const api = prefix || '/api';
    for (const path of [
      '/liekan/websites/site/robots',
      '/liekan/robots-agent',
    ]) {
      const headers = await effectiveHeaders(api + path, prefix);
      expect(headers['cache-control'], path).toBe('private, no-store');
      expect(headers.vary, path).toBe('Authorization');
    }
  },
);
