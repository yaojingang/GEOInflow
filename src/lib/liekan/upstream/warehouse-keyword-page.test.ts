// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  candidates: [] as any[],
  population: {} as any,
  cache: vi.fn(),
  key: vi.fn(),
  facts: vi.fn(),
  exported: [] as any[],
  preamble: '',
}));
vi.mock('../warehouse/authority-routing', () => ({ warehouseEnabled: () => true }));
vi.mock('./analytics', () => ({ humanVisitsSql: '', visitMetrics: '', convertedJoin: '' }));
vi.mock('./query-snapshot', () => ({ getQuerySnapshot: () => undefined }));
vi.mock('./server', () => ({ query: mocks.facts, reportSnapshot: (fn: any) => fn() }));
vi.mock('../store', () => ({
  getSettings: async () => ({ isDemo: false, aiCrawlerEnabled: true }),
}));
vi.mock('./query-cache', () => ({
  analyticsCache: { read: mocks.cache },
  analyticsCacheKey: mocks.key,
  websiteCacheTag: (site: string) => site,
}));
vi.mock('./browser-population', () => ({ readBrowserPopulation: async () => mocks.population }));
vi.mock('./warehouse-browser-queries', () => ({
  warehouseBrowserParameters: async () => ({ goalIds: ['goal'] }),
  warehouseVisitsSQL: () => 'WITH visits AS fixture',
}));
vi.mock('./warehouse-report-snapshot', () => ({
  withinWarehouseReport: (fn: any) => fn(),
  warehouseReportStream: async (_site: any, _sql: any, _params: any, consume: any) =>
    consume(mocks.candidates),
}));
vi.mock('./feature-exports', () => ({ exportLabel: (s: string) => s }));
vi.mock('../crawlers/published', async importOriginal => ({
  ...(await importOriginal<typeof import('../crawlers/published')>()),
  getPublishedCatalog: () => null,
}));
vi.mock('./warehouse-export-artifact', () => ({
  warehouseExportResponse: (_site: string, signal: AbortSignal, _locale: string, build: any) =>
    build({
      signal,
      csv: async (_name: string, _fields: string[], produce: any, preamble: string) => {
        mocks.preamble = preamble;
        await produce(async (rows: any[]) => {
          expect(rows.length).toBeLessThanOrEqual(256);
          mocks.exported.push(...rows);
        });
      },
      complete: async (_format: string, manifest: any) => manifest,
    }),
}));

import { addKeywordCandidate, type KeywordRow } from '../contracts/keywords';
import { applyReportPopulation } from '../contracts/population-results';
import { parseReportQuery } from '../contracts/query';
import { keywordReport, readKeywordFacts, readKeywordPage } from './keywords';
import { warehouseSpecialExport } from './warehouse-special-exports';

const website = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Fixture',
  domain: 'fixture.invalid',
};
const p = (input = {}) =>
  parseReportQuery({
    resource: 'human/keywords',
    startAt: 0,
    endAt: 1000,
    timezone: 'UTC',
    keywordStatusVersion: '2',
    ...input,
  }).data!;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'warehouse-keyword-page-'));
  vi.stubEnv('LIEKAN_EXPORT_DIRECTORY', directory);
  vi.stubEnv('LIEKAN_EXPORT_MIN_FREE_BYTES', '0');
  mocks.candidates = Array.from({ length: 45 }, (_, i) => ({
    referrer: 'www.google.com',
    referrerPath: '/search',
    referrerQuery: '?q=word' + String(i).padStart(2, '0'),
    sessions: 1,
    bounces: 1,
    conversions: 0,
  }));
  mocks.population = { identity: { status: 'complete' } };
  mocks.key.mockImplementation((key, args) => JSON.stringify([key, args]));
  mocks.cache.mockImplementation(async (_key, _ttl, _tags, load) => ({
    value: await load(),
    status: 'miss',
    generatedAt: 1,
    expiresAt: 2,
  }));
  mocks.facts.mockClear();
  mocks.exported = [];
  mocks.preamble = '';
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
it.each(['complete', 'partial', 'unavailable'])(
  'keeps cards/population semantics and caches only requested page for %s',
  async status => {
    mocks.population = {
      identity: { status, qualifiedPV: status === 'unavailable' ? 0 : 1 },
      metricScope: 'qualified-browser',
    };
    const groups = new Map<string, KeywordRow>();
    for (const row of mocks.candidates) addKeywordCandidate(groups, row);
    const query = p({ page: 2, sort: 'keyword', direction: 'asc' });
    const actual = (await readKeywordPage(website, query, 1000, true)).value;
    const expected = applyReportPopulation(
      keywordReport(
        website,
        query,
        {
          rows: [...groups.values()],
          hasGoals: true,
          snapshot: actual.meta.keywordSnapshot as string,
          readAt: actual.meta.keywordReadAt as number,
        },
        { isDemo: false, aiCrawlerEnabled: true } as any,
      ),
      mocks.population,
    );
    expect(actual).toEqual(expected);
    expect(actual.tables.keywordBody).toHaveLength(20);
    expect(actual.meta.tablePages.keywordBody).toEqual({ page: 2, pageSize: 20, total: 45 });
    expect(mocks.cache.mock.calls.at(-1)[0]).toContain('"page":2');
    expect(mocks.facts).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
    await expect(readKeywordFacts(website.id, query)).rejects.toThrow(
      'warehouse-keyword-bounded-reader-required',
    );
  },
);
it('resets on changed full content and clamps filtered last pages', async () => {
  const first = (await readKeywordPage(website, p(), 1000, true)).value;
  const same = (
    await readKeywordPage(
      website,
      p({ page: 2, keywordSnapshot: first.meta.keywordSnapshot }),
      1000,
      true,
    )
  ).value;
  expect(same.meta.keywordReset).toBe(false);
  mocks.candidates[44].sessions = 2;
  const changed = (
    await readKeywordPage(
      website,
      p({ page: 2, keywordSnapshot: first.meta.keywordSnapshot }),
      1000,
      true,
    )
  ).value;
  expect(changed.meta.keywordReset).toBe(true);
  expect(changed.meta.tablePages.keywordBody.page).toBe(1);
  const filtered = (await readKeywordPage(website, p({ page: 8, search: 'word44' }), 1000, true))
    .value;
  expect(filtered.meta.tablePages.keywordBody).toEqual({ page: 1, pageSize: 20, total: 1 });
  expect(filtered.tables.keywordBody).toHaveLength(1);
  expect(filtered.cards[0].value).toBe(46);
});

it.each(['complete', 'unavailable'])(
  'exports every selected row with %s identity visibility and safe conditions',
  async status => {
    mocks.population = { identity: { status }, metricScope: 'qualified-browser' };
    const manifest: any = await warehouseSpecialExport(
      website,
      {
        ...p({ sort: 'keyword', direction: 'asc' }),
        kind: 'source-keywords',
        format: 'csv',
        locale: 'zh-CN',
      } as any,
      new AbortController().signal,
    );
    expect(manifest.rows).toBe(45);
    expect(mocks.exported).toHaveLength(45);
    expect(mocks.exported.at(-1)['关键词/状态']).toBe('word44');
    expect(mocks.exported[0]['会话数']).toBe(status === 'complete' ? 1 : null);
    expect(mocks.exported[0]['搜索渠道占比(%)']).toBe(status === 'complete' ? 2.22 : null);
    expect(mocks.preamble).toContain('统计读取时间');
    expect(mocks.facts).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  },
);
