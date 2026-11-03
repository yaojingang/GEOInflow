import { describe, expect, test, vi } from 'vitest';
import {
  analyticsHotCatalogVersion,
  analyticsRefreshJobSchema,
  parseAnalyticsHotParameters,
} from './analytics-hot-parameters';
import { readAnalyticsVersions } from './analytics-revision';

vi.mock('../crawlers/published', () => ({
  getPublishedCatalog: () => ({ version: '11111111-1111-4111-8111-111111111111' }),
}));

const range = { startAt: 1727740800000, endAt: 1727827199999, timezone: 'UTC' };

describe('normalized preheating parameters', () => {
  test('restores the accepted catalog from the actual current revision reader', async () => {
    const { strong } = await readAnalyticsVersions({ $queryRawUnsafe: async () => [] }, [
      'website:22222222-2222-4222-8222-222222222222',
    ]);
    expect(analyticsHotCatalogVersion(strong)).toBe('11111111-1111-4111-8111-111111111111');
    const stored = JSON.parse(strong);
    expect(analyticsHotCatalogVersion(JSON.stringify(stored.slice(0, 7)))).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(
      analyticsHotCatalogVersion(
        JSON.stringify([...stored.slice(0, 7), 'unknown-calendar-version']),
      ),
    ).toBeUndefined();
    expect(analyticsHotCatalogVersion(JSON.stringify([...stored.slice(0, 7), 'unknown-read-version', stored[8]]))).toBeUndefined();
    expect(analyticsHotCatalogVersion(JSON.stringify([...stored.slice(0, 8), 'unknown-calendar-version']))).toBeUndefined();
    expect(stored[1]).toBe('history-repair-v1.2');
    expect(
      analyticsHotCatalogVersion(
        JSON.stringify(
          stored.map((value: unknown, index: number) =>
            index === 1 ? 'history-repair-v1.1' : value,
          ),
        ),
      ),
    ).toBe('11111111-1111-4111-8111-111111111111');
    expect(analyticsHotCatalogVersion(JSON.stringify([...stored, 'extra']))).toBeUndefined();
    stored[1] = 'unrecognized-repair-version';
    expect(analyticsHotCatalogVersion(JSON.stringify(stored))).toBeUndefined();
  });
  test('restores the accepted catalog from the stored strong version and handles legacy jobs', () => {
    const version = '11111111-1111-4111-8111-111111111111';
    expect(analyticsHotCatalogVersion(JSON.stringify(['policy-v1', version, [], [], []]))).toBe(
      version,
    );
    for (const value of [
      'v1',
      '[]',
      JSON.stringify(['policy-v1', 'bundled', [], [], []]),
      JSON.stringify([version]),
    ])
      expect(analyticsHotCatalogVersion(value)).toBeUndefined();
  });
  test('accepts parsed ordered breakdown fields and funnel steps with their window', () => {
    const fields = ['country', 'browser'];
    expect(parseAnalyticsHotParameters('native:breakdown', { ...range, fields })).toMatchObject({
      fields,
    });
    const steps = [
      { type: 'path', value: '/start' },
      {
        type: 'event',
        value: 'paid',
        filters: [{ property: 'tier', operator: 'eq', value: 'pro' }],
      },
    ];
    expect(
      parseAnalyticsHotParameters('native:funnels/stats', { ...range, steps, window: 24 }),
    ).toMatchObject({ steps, window: 24 });
  });

  test('rejects malformed JSON fields, incomplete funnels and unsupported native metric columns', () => {
    expect(() =>
      parseAnalyticsHotParameters('native:breakdown', { ...range, fields: '[' }),
    ).toThrow();
    expect(() =>
      parseAnalyticsHotParameters('native:funnels/stats', { ...range, window: 24, steps: [] }),
    ).toThrow();
    expect(() =>
      parseAnalyticsHotParameters('native:revenue/metrics', {
        ...range,
        currency: 'USD',
        type: 'sql',
      }),
    ).toThrow();
  });

  test('restores feature query defaults and rejects unknown queue targets or identity combinations', () => {
    expect(
      parseAnalyticsHotParameters('feature:page-report', { ...range, resource: 'overview' }),
    ).toMatchObject({
      page: 1,
      cursor: '',
      seek: 'after',
      filter: '',
      search: '',
      chartPeriod: '30d',
    });
    const job = {
      websiteId: '11111111-1111-4111-8111-111111111111',
      target: 'native:stats',
      parameters: range,
      actorId: '22222222-2222-4222-8222-222222222222',
      fingerprint: 'a'.repeat(64),
      scopeHash: 'b'.repeat(64),
      expectedStrongVersion: '[]',
      scheduledAt: 1000,
    };
    expect(analyticsRefreshJobSchema.safeParse(job).success).toBe(true);
    expect(analyticsRefreshJobSchema.safeParse({ ...job, target: 'native:raw-sql' }).success).toBe(
      false,
    );
    expect(analyticsRefreshJobSchema.safeParse({ ...job, shareId: job.actorId }).success).toBe(
      false,
    );
    expect(analyticsRefreshJobSchema.safeParse({ ...job, password: 'hidden' }).success).toBe(false);
  });
});
