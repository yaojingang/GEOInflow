import { afterEach, expect, it, vi } from 'vitest';
import { analyticsEngineActionSchema } from '../contracts/analytics-engine';
import {
  engineConnection,
  engineValueKey,
  engineWindow,
  projectionDigest,
  supportedLogInput,
} from './analytics-engine-clickhouse';

afterEach(() => vi.unstubAllEnvs());
it('uses a separate deployment connection and never exposes userinfo', () => {
  vi.stubEnv('CLICKHOUSE_URL', 'http://upstream:secret@legacy.invalid/db');
  vi.stubEnv('LIEKAN_ANALYTICS_CLICKHOUSE_URL', '');
  expect(engineConnection()).toBeNull();
  vi.stubEnv(
    'LIEKAN_ANALYTICS_CLICKHOUSE_URL',
    'https://analytics:private-secret@example.invalid:8443/analytics',
  );
  expect(engineConnection()?.label).toBe('https://example.invalid:8443/analytics');
  expect(JSON.stringify(engineConnection()?.label)).not.toContain('private-secret');
  for (const value of [
    'file:///tmp/db',
    'https://example.invalid/unsafe/path',
    'https://example.invalid/db?password=x',
  ]) {
    vi.stubEnv('LIEKAN_ANALYTICS_CLICKHOUSE_URL', value);
    expect(() => engineConnection()).toThrow();
  }
});
it('requires full historical coverage and preserves half-open versus inclusive hour edges', () => {
  const value = {
    startDate: new Date('2026-01-01T00:00Z'),
    endDate: new Date('2026-01-01T02:00Z'),
  };
  expect(engineWindow({ ...value, crawlerMetricsVersion: 1 })?.units).toBe(2);
  expect(engineWindow(value)?.units).toBe(3);
  expect(engineWindow({ ...value, endDate: new Date() })).toBeNull();
  expect(engineWindow({ ...value, endDate: new Date('invalid') })).toBeNull();
});
it('routes unsupported predicates back to PostgreSQL without weakening them', () => {
  expect(
    supportedLogInput({
      filters: { resource: 'ai/pages', botCategory: 'other', botId: 'crawler' },
    }),
  ).toBe(true);
  expect(supportedLogInput({ filters: { botCategory: 'unsupported' } })).toBe(false);
  expect(supportedLogInput({ filters: { path: '/unimplemented' } })).toBe(false);
  expect(supportedLogInput({ crawlerIdentityScope: 'untrusted' })).toBe(false);
});
it('keeps structured versions independent of JSON property order', () => {
  expect(engineValueKey({ a: { y: 2, x: 1 }, b: [1, null] })).toBe(
    engineValueKey({ b: [1, null], a: { x: 1, y: 2 } }),
  );
  expect(projectionDigest([])).toHaveLength(64);
});
it('requires versioned, idempotent actions and rejects extra connection input', () => {
  const input = { action: 'prepare', requestId: crypto.randomUUID(), expectedRevision: 0 };
  expect(analyticsEngineActionSchema.safeParse(input).success).toBe(true);
  expect(
    analyticsEngineActionSchema.safeParse({ ...input, url: 'http://arbitrary.invalid' }).success,
  ).toBe(false);
  expect(analyticsEngineActionSchema.safeParse({ ...input, expectedRevision: -1 }).success).toBe(
    false,
  );
});

it('returns unsupported aggregate fields to the PostgreSQL reader', () => {
  expect(supportedLogInput({ fields: ['summary', 'bots'] })).toBe(true);
  expect(supportedLogInput({ fields: ['classificationSet'] })).toBe(false);
  expect(supportedLogInput({ fields: ['summary', 'classificationSet'] })).toBe(false);
});
