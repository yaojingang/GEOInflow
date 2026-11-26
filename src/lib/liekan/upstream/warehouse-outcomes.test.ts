// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/isolated';
  return { population: {} as any };
});
vi.mock('../warehouse/authority-routing', () => ({ warehouseEnabled: () => false }));
vi.mock('./browser-population', () => ({
  readTransactionBrowserPopulation: async () => fixture.population,
}));
import { readOutcomes } from '../crawlers/outcomes-read';
import { buildWarehouseOutcomeRows, outcomeReferralSQL } from './warehouse-outcomes';
import { withWarehouseEvidenceResources } from './warehouse-evidence-table';

let directory: string;
const p = {
  startAt: 1,
  endAt: 2,
  timezone: 'UTC',
  sourceId: 'manual',
  page: 1,
  sort: 'requests',
  direction: 'desc',
} as any;
const input = {
  access: { domain: 'example.com' },
  sources: [],
  catalog: [{ path: '/a%20b' }, { path: '/a b' }, { path: '/%2F' }],
  baseline: { epoch: 1 },
  quality: { state: 'complete', sourceVersion: 'v1' },
  measurement: {
    requests: 9,
    intervals: 1,
    interval: 'v1',
    intervalSamples: 9,
    versions: 1,
    samples: 9,
  },
} as any;
const population = { identity: { status: 'complete' } } as any;
const context = {
  hostname: 'example.com',
  goalsConfigured: true,
  connected: true,
  browserPopulation: population,
};
const log = (path: string, extra = {}) => ({
  crawler_id: 'gptbot',
  bot: 'GPTBot',
  path,
  requests: 2,
  get2xx: 1,
  unsampled: true,
  hostObserved: true,
  hosts: 1,
  host: 'https://WWW.EXAMPLE.com.:443/',
  configs: 1,
  ...extra,
});
const referral = (path: string, extra = {}) => ({
  path,
  referrer: 'chatgpt.com',
  hostname: 'example.com',
  visits: 3,
  conversions: 1,
  goalEvents: 2,
  ...extra,
});
const producer = (rows: any[]) => async (emit: (row: any) => Promise<void>) => {
  for (const row of rows) await emit(row);
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'warehouse-outcomes-test-'));
  vi.stubEnv('LIEKAN_EXPORT_DIRECTORY', directory);
  vi.stubEnv('LIEKAN_EXPORT_MIN_FREE_BYTES', '0');
  fixture.population = population;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('warehouse outcomes', () => {
  it.each(['complete', 'partial', 'unavailable'])(
    'matches PG reader semantics for %s identity, decode collisions and unknown hosts',
    async status => {
      fixture.population = {
        identity: { status, qualifiedPV: 1 },
        metricScope: 'qualified-browser',
      };
      const logs = [
        log('/a%20b'),
        log('/a b'),
        log('/%2F'),
        log('/%ZZ'),
        log('/x', { crawler_id: 'custom', bot: 'CustomBot', unsampled: null }),
        log('/unknown'),
      ];
      const referrals = [
        referral('/a b'),
        referral('/%2F'),
        referral('/%ZZ'),
        referral('/unknown', { hostname: null }),
        referral('/unknown'),
        referral('/other', { hostname: 'other.example' }),
        referral('/ignored', { utmSource: 'chatgpt', utmMedium: 'email' }),
        referral('/utm', { referrer: '', utmSource: 'CHATGPT' }),
      ];
      const tx = {
        execute: vi.fn(),
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT e.crawler_id')) return logs;
          if (sql.includes('WITH first_in_window')) return referrals;
          if (sql.includes("type='goal'")) return [{ configured: true }];
          if (sql.includes('liekan_raw_website_event')) return [{ connected: true }];
          throw new Error(`Unexpected PG query: ${sql.slice(0, 60)}`);
        }),
      } as any;
      const expected = await readOutcomes(tx, '00000000-0000-4000-8000-000000000001', p, input);
      await withWarehouseEvidenceResources(async () => {
        const actual = await buildWarehouseOutcomeRows(
          p,
          { ...input, catalog: [] },
          { ...context, browserPopulation: fixture.population },
          producer(logs),
          producer(referrals),
          undefined,
          async emit => {
            for (const row of input.catalog) await emit(row.path);
          },
        );
        const rows: any[] = [];
        await actual.table.stream(async batch => {
          rows.push(...batch);
        });
        const sort = (rows: any[]) =>
          rows.sort(
            (a, b) => a.platformId.localeCompare(b.platformId) || a.path.localeCompare(b.path),
          );
        expect(sort(rows)).toEqual(sort(expected.rows));
        const reasons: any[] = [];
        await actual.reasonTable.stream(async batch => {
          reasons.push(...batch);
        });
        expect(reasons).toEqual(expected.reasons);
        expect(actual.totals).toEqual(expected.totals);
        expect(await actual.table.count()).toBe(expected.rows.length);
      });
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it('streams and paginates over 100000 paths and 50 MiB without truncation or a full result array', async () => {
    const count = 100013;
    const suffix = 'x'.repeat(550);
    await withWarehouseEvidenceResources(async () => {
      const result = await buildWarehouseOutcomeRows(
        { ...p, sort: 'path', direction: 'asc' },
        { ...input, catalog: [] },
        context,
        async emit => {
          for (let i = count - 1; i >= 0; i--)
            await emit(
              log(`/p${String(i).padStart(6, '0')}/${suffix}`, {
                crawler_id: 'custom',
                bot: `Custom-${i}`,
              }),
            );
        },
        async () => {},
      );
      expect(await result.table.count()).toBe(count);
      expect(await result.reasonTable.count()).toBe(count);
      expect(await result.reasonTable.page(0, 20)).toHaveLength(20);
      expect((await result.reasonTable.page(count - 2, 20)).map(row => row.platformId)).toEqual([
        'custom:Custom-1',
        'custom:Custom-0',
      ]);
      expect(result.totals).toEqual({ requests: count * 2, get2xx: count, visits: 0 });
      const page = await result.table.page(count - 2, 20);
      expect(page.map(row => row.path.slice(0, 8))).toEqual(['/p100011', '/p100012']);
      let rows = 0,
        bytes = 0,
        maxBatch = 0;
      await result.table.stream(async batch => {
        maxBatch = Math.max(maxBatch, batch.length);
        for (const row of batch) {
          rows++;
          bytes += Buffer.byteLength(JSON.stringify(row));
        }
      });
      expect(rows).toBe(count);
      expect(bytes).toBeGreaterThan(50 * 1024 * 1024);
      expect(maxBatch).toBeLessThanOrEqual(256);
      let platforms = 0;
      await result.reasonTable.stream(async batch => {
        platforms += batch.length;
        expect(batch.length).toBeLessThanOrEqual(256);
      });
      expect(platforms).toBe(count);
    });
    expect(await readdir(directory)).toEqual([]);
  }, 180000);

  it('uses accepted CH events and exact visit/goal aggregation without a 100001 limit', () => {
    const sql = outcomeReferralSQL();
    expect(sql).toContain('warehouse_website_event');
    expect(sql).toContain('warehouse_session');
    expect(sql).toContain('argMin(tuple(url_path,referrer_domain');
    expect(sql).toContain('uniqExactIf(event_id');
    expect(sql).toContain('SELECT DISTINCT ev.session_id AS session_id,ev.visit_id AS visit_id');
    expect(sql).not.toContain('100001');
  });
});
