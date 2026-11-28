// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { selectRows } from '@/components/liekan/data';
import { pageUrl } from '../contracts/page-url';
const fixtures = vi.hoisted(() => ({
  bots: [] as any[],
  previous: [] as any[],
  pages: [] as any[],
  logs: [] as any[],
  catalog: [] as any[],
}));
vi.mock('./warehouse-evidence-queries', () => ({ warehouseEvidenceSignal: () => undefined }));
vi.mock('../warehouse/reader-runtime', () => ({
  warehouseReader: () => ({
    db: {
      read: async (_sql: string, [_site, paths]: any[]) =>
        fixtures.catalog.filter(row => paths.includes(row.path)),
    },
  }),
}));
vi.mock('./warehouse-report-snapshot', () => ({
  warehouseReportStream: async (_site: string, sql: string, params: any, consume: any) => {
    const values = sql.startsWith('bots')
      ? params.logStart === 'previous'
        ? fixtures.previous
        : fixtures.bots
      : sql === 'pages'
        ? fixtures.pages
        : fixtures.logs;
    for (let offset = 0; offset < values.length; offset += 2)
      await consume(values.slice(offset, offset + 2));
  },
}));
vi.mock('./warehouse-log-queries', async original => ({
  ...(await original<typeof import('./warehouse-log-queries')>()),
  warehouseLogQuerySpec: async () => ({
    params: { logStart: 'current' },
    previousParams: { logStart: 'previous' },
    ai: 'true',
    detailBase: 'details',
    botQuery: 'bots',
    statements: { pages: 'pages' },
  }),
}));
import { warehouseReportEvidence } from './warehouse-report-evidence';
import { withWarehouseEvidenceResources } from './warehouse-evidence-table';
let directory: string;
const base = {
  startAt: +new Date('2026-10-01T00:00:00Z'),
  endAt: +new Date('2026-10-03T00:00:00Z'),
  timezone: 'UTC',
  crawlerMetricsVersion: 1,
  crawlerIdentityScope: 'all',
};
const display = { filter: '全部', sort: { label: '', direction: 1 }, search: '' };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'report-evidence-'));
  vi.stubEnv('LIEKAN_EXPORT_DIRECTORY', directory);
  vi.stubEnv('LIEKAN_EXPORT_MIN_FREE_BYTES', '0');
  for (const key of Object.keys(fixtures)) fixtures[key] = [];
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function read(resource: string, options = display) {
  return withWarehouseEvidenceResources(async () => {
    const { source, table } = await warehouseReportEvidence(
      {} as any,
      'site',
      { ...base, resource },
      options,
      'example.test',
    );
    const rows: any[] = [];
    await source.stream(async batch => {
      rows.push(...batch);
    });
    expect(await source.count()).toBe(rows.length);
    expect(await source.page(0, 20)).toEqual(rows.slice(0, 20));
    return { table, rows };
  });
}
it('keeps page leaders, catalog fields, heat and display numeric locale ordering', async () => {
  fixtures.pages = [
    {
      path: '/页面10',
      bot: 'GPTBot',
      botId: 'gptbot',
      requests: '4',
      lastCrawled: '2026-10-02 01:00:00',
    },
    {
      path: '/页面2',
      bot: 'Alpha2',
      botId: null,
      requests: '2',
      lastCrawled: '2026-10-01 01:00:00',
    },
    {
      path: '/页面2',
      bot: 'Alpha10',
      botId: null,
      requests: '2',
      lastCrawled: '2026-10-02 01:00:00',
    },
  ];
  fixtures.catalog = [
    { path: '/页面10', title: '  标题十  ', type: 'article', updatedAt: '2026-10-01T00:00:00Z' },
  ];
  const normal = await read('ai/pages');
  expect(normal.rows.map(row => row.path)).toEqual(['/页面10', '/页面2']);
  expect(normal.rows[0]).toMatchObject({
    title: '标题十',
    requests: 4,
    bots: 1,
    heat: 100,
    freshness: '2 天',
    bot: 'GPTBot',
    botId: 'gptbot',
    bot2: null,
  });
  expect(normal.rows[1]).toMatchObject({
    title: null,
    requests: 4,
    bots: 2,
    heat: 100,
    freshness: null,
    bot: 'Alpha10',
    botId: null,
    bot2: 'Alpha2',
    bot2Id: null,
    lastCrawled: '2026-10-02T01:00:00.000Z',
  });
  const sorted = await read('ai/pages', { ...display, sort: { label: '页面', direction: 1 } });
  expect(sorted.rows).toEqual(
    selectRows(normal.rows, '全部', { label: '页面', direction: 1 }, 'apBody'),
  );
  expect(sorted.rows[0].path).toBe('/页面2');
  expect((await read('ai/pages', { ...display, search: 'example.test/页面2' })).rows).toEqual(
    selectRows(normal.rows, '全部', display.sort, 'apBody', 'example.test/页面2', value =>
      pageUrl(value, 'example.test'),
    ),
  );
  expect(await readdir(directory)).toEqual([]);
});
it('merge joins previous totals and preferences across shared bot names and vendors', async () => {
  fixtures.bots = [
    {
      name: 'Shared',
      botId: null,
      vendor: 'v1',
      type: '训练',
      requests: '6',
      aiRequests: '6',
      pages: '2',
      lastVisit: '2026-10-02 01:00:00',
    },
    {
      name: 'Shared',
      botId: null,
      vendor: 'v2',
      type: '搜索',
      requests: '4',
      aiRequests: '4',
      pages: '2',
      lastVisit: '2026-10-02 02:00:00',
    },
    {
      name: 'GPTBot',
      botId: 'gptbot',
      vendor: 'OpenAI',
      type: '训练',
      requests: '3',
      aiRequests: '3',
      pages: '1',
      lastVisit: '2026-10-02 03:00:00',
    },
  ];
  fixtures.previous = [{ name: 'Shared', botId: null, vendor: 'v1', type: '训练', requests: '3' }];
  fixtures.pages = [
    { path: '/article', bot: 'Shared', botId: null, requests: '6' },
    { path: '/guide', bot: 'Shared', botId: null, requests: '4' },
  ];
  fixtures.catalog = [
    { path: '/article', type: 'article' },
    { path: '/guide', type: 'guide' },
  ];
  const normal = await read('ai/bots');
  expect(normal.rows.map(row => row.vendor)).toEqual(['v1', 'v2', 'OpenAI']);
  expect(normal.rows[0]).toMatchObject({
    requests: 6,
    dailyAverage: 3,
    trend: 100,
    preference: 'article（60% 抓取集中）',
  });
  expect(normal.rows[1]).toMatchObject({
    requests: 4,
    dailyAverage: 2,
    trend: null,
    preference: 'article（60% 抓取集中）',
  });
  expect(normal.rows[2]).toMatchObject({ trend: null, preference: null });
  for (const filter of ['AI 训练', 'AI 搜索', '按抓取量']) {
    const selection = { ...display, filter, sort: { label: '蜘蛛 / 厂商', direction: -1 } };
    expect((await read('ai/bots', selection)).rows).toEqual(
      selectRows(normal.rows, filter, selection.sort, 'botBody'),
    );
  }
});
it('keeps raw log identity evidence, classification and stable custom sorting', async () => {
  fixtures.logs = [
    {
      recordId: '1',
      cursorTime: 'unused',
      time: '2026-10-02 03:00:00',
      path: '/page10',
      method: 'GET',
      status: 200,
      userAgent: 'Synthetic',
      bot: 'GPTBot',
      botId: 'gptbot',
      verification: 'verified_range',
      identityEvidence: '{"method":"range"}',
      verificationObservedAt: null,
      aiEligible: true,
    },
    {
      recordId: '2',
      cursorTime: 'unused',
      time: '2026-10-02 02:00:00',
      path: '/page2',
      method: 'GET',
      status: 403,
      userAgent: 'Synthetic',
      bot: '其他',
      botId: null,
      recognitionState: 'unknown',
      identityEvidence: null,
      verificationObservedAt: null,
      aiEligible: false,
    },
  ];
  const normal = await read('logs');
  expect(normal.rows[0]).toMatchObject({
    recordId: '1',
    identityEvidence: '{"method":"range"}',
    classification: 'GPTBot · 官方 IP 范围匹配',
    time: '2026-10-02T03:00:00.000Z',
  });
  expect(normal.rows[1].classification).toBe('自动化特征 · 身份未核验');
  expect(normal.rows[0]).not.toHaveProperty('cursorTime');
  for (const filter of ['仅 AI 蜘蛛', '仅异常', '未知／未分类']) {
    expect((await read('logs', { ...display, filter })).rows).toEqual(
      selectRows(normal.rows, filter, display.sort, 'logBody'),
    );
  }
});
