// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/isolated';
});
vi.mock('./server', () => ({ humanTotals: vi.fn(), query: vi.fn(), LiekanError: Error }));
vi.mock('@/queries/sql', () => ({ getFunnel: vi.fn() }));
vi.mock('./logs', () => ({ getLogFacts: vi.fn(), staticRequestExtensionPattern: '' }));
vi.mock('./warehouse-report-snapshot', () => ({
  warehouseReportStream: vi.fn(),
  warehouseReportQuery: vi.fn(),
  warehouseReportMetadata: vi.fn(),
  warehouseReportSignal: vi.fn(),
}));
vi.mock('./warehouse-browser-queries', () => ({
  warehouseBrowserParameters: vi.fn(),
  warehouseVisitsSQL: vi.fn(),
}));

import { parseReportQuery } from '../contracts/query';
import { addReportAiPage, compareReportAiPages } from '../report-log-tables';
import * as analytics from './analytics';
import { sourceFacts } from './analytics';
import { getLogFacts } from './logs';
import { humanPathFromEncoded } from './paths';
import {
  buildWarehouseBrowserPages,
  buildWarehouseBrowserSources,
  prepareWarehouseBrowserPageReport,
} from './warehouse-browser-page-report';
import { WarehouseEvidenceSpool } from './warehouse-evidence-spool';
import { warehouseReportQuery, warehouseReportStream } from './warehouse-report-snapshot';

const params = (extra = {}) =>
  parseReportQuery({
    resource: 'human/sources',
    startAt: 1000,
    endAt: 2000,
    timezone: 'UTC',
    ...extra,
  }).data!;
const producer = (rows: any[]) => async (emit: (row: any) => Promise<void>) => {
  for (const row of rows) await emit(row);
};
const none = producer([]);
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'warehouse-browser-page-'));
  vi.stubEnv('LIEKAN_EXPORT_DIRECTORY', directory);
  vi.stubEnv('LIEKAN_EXPORT_MIN_FREE_BYTES', '0');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it.each([0, 1])('reuses evidence only for a proved empty overview visit window (%s)', async n => {
  const p = params({ resource: 'overview' });
  vi.spyOn(analytics, 'getHumanFacts').mockResolvedValue({
    totals: {
      population: {
        resourceId: 'site',
        identity: { eligibleEvents: n, status: n ? 'complete' : 'empty' },
        range: { startAt: p.startAt, endAt: p.endAt, timezone: p.timezone },
      },
    },
  } as Awaited<ReturnType<typeof analytics.getHumanFacts>>);
  vi.mocked(getLogFacts).mockResolvedValue({
    summary: {},
    bots: [],
  } as Awaited<ReturnType<typeof getLogFacts>>);
  vi.mocked(warehouseReportQuery).mockResolvedValue([]);
  vi.mocked(warehouseReportStream).mockClear();
  const prepared = await prepareWarehouseBrowserPageReport('site', p);
  try {
    expect(warehouseReportStream).toHaveBeenCalledTimes(n ? 2 : 0);
    expect(prepared.logs.summary.requests).toBe(0);
    expect(prepared.human.pages).toEqual([]);
  } finally {
    await prepared.dispose();
  }
});

it('matches complete sourceFacts grouping, weighted duration, evidence union, stable ties and selected previous groups', async () => {
  const raw = [
    {
      referrer: 'google.com',
      sessions: 5,
      duration: 10,
      bounces: 2,
      conversions: 1,
      utmCampaign: 'b',
    },
    {
      referrer: 'google.com',
      sessions: 2,
      duration: null,
      bounces: 1,
      conversions: 2,
      utmCampaign: 'a',
    },
    { referrer: null, sessions: 7 },
    { referrer: '直接访问', sessions: 7 },
    { referrer: 'chatgpt.com', sessions: 3, conversions: 2 },
    { referrer: null, utmSource: 'chatgpt', utmCampaign: 'z', sessions: 4, conversions: 1 },
    { utmSource: 'chatgpt', utmMedium: 'email', sessions: 7 },
    { utmSource: 'peer.test', utmMedium: 'organic', sessions: 7 },
  ];
  const previous = raw.map(row => ({ ...row, sessions: 3, conversions: 2 }));
  const dayRows = raw.flatMap(row =>
    ['2026-01-01', '2026-01-02'].map(day => ({ ...row, day, count: 1, sessions: undefined })),
  );
  const expected = sourceFacts(raw),
    expectedPrevious = sourceFacts(previous),
    expectedDaily = sourceFacts(dayRows);
  const spool = await WarehouseEvidenceSpool.create();
  try {
    const actual = await buildWarehouseBrowserSources(
      spool,
      params(),
      producer(raw),
      producer(previous),
      producer(dayRows),
    );
    expect(actual.rows).toEqual(expected);
    expect(actual.total).toBe(expected.length);
    expect(actual.previous).toEqual(
      expected.map(row => {
        const old = expectedPrevious.find(
          p =>
            p.source === row.source &&
            p.channel === row.channel &&
            p.sourceLabel === row.sourceLabel,
        )!;
        return {
          source: old.source,
          channel: old.channel,
          ...(old.sourceLabel ? { sourceLabel: old.sourceLabel } : {}),
          sessions: old.sessions,
          conversions: old.conversions,
        };
      }),
    );
    for (const row of actual.daily)
      expect(row.count).toBe(
        expectedDaily
          .filter(d => d.day === row.day && d.channel === row.channel)
          .reduce((n, d) => n + d.count, 0),
      );
    const channels = new Map<string, number>();
    for (const row of expected)
      channels.set(row.channel, (channels.get(row.channel) ?? 0) + row.sessions);
    expect(actual.channels).toEqual([...channels].map(([name, count]) => ({ name, count })));
    expect(actual.aiSources).toEqual(
      expected
        .filter(row => row.channel === 'AI 搜索引荐')
        .map(row => ({ source: row.source, sessions: row.sessions, conversions: row.conversions })),
    );
  } finally {
    await spool.dispose();
  }
});
it('keeps full path count/cards and encoded-log collision/leader semantics while retaining only requested human rows', async () => {
  const human = Array.from({ length: 65 }, (_, i) => ({
    path: i === 25 ? '/a b' : `/page${i}`,
    pv: 100 - i,
    uv: 1,
    entries: i === 60 ? 1000 : 1,
    duration: i % 2 ? null : i,
    samples: i % 2 ? 0 : 2,
    bounces: 1,
  }));
  const logs = [
    { path: '/a%20b', bot: 'ZBot', botId: 'z', requests: 3, lastCrawled: '2026-01-01' },
    { path: '/a%20b', bot: 'ABot', botId: 'a', requests: 9, lastCrawled: '2026-01-02' },
    { path: '/a b', bot: 'BBot', botId: 'b', requests: 10, lastCrawled: '2026-01-03' },
    { path: '/ignored', bot: 'Other', requests: 999999, lastCrawled: '2026-01-03' },
  ];
  const encoded = new Map<string, any>();
  for (const row of logs) encoded.set(row.path, addReportAiPage(encoded.get(row.path), row));
  const all = [...encoded.values()].sort(compareReportAiPages);
  const expectedAI = new Map<string, any>();
  for (const row of all) {
    const path = humanPathFromEncoded(row.path),
      old = expectedAI.get(path) ?? { requests: 0, bot: row.bot, botId: row.botId, main: 0 };
    old.requests += row.requests;
    if (row.requests > old.main) {
      old.bot = row.bot;
      old.botId = row.botId;
      old.main = row.requests;
    }
    expectedAI.set(path, old);
  }
  const spool = await WarehouseEvidenceSpool.create();
  try {
    const actual = await buildWarehouseBrowserPages(
      spool,
      params({ resource: 'content', tp_pgBody: 2, tp_visitorPgBody: 3 }),
      producer(human),
      producer(logs),
    );
    expect(actual.rows.pgBody).toEqual(human.slice(20, 40));
    expect(actual.rows.visitorPgBody).toEqual(human.slice(40, 60));
    expect(actual.total).toBe(human.length);
    expect(actual.entryPath).toBe('/page60');
    const measured = human.filter(row => row.duration !== null);
    expect(actual.duration).toBe(
      measured.reduce((n, row) => n + row.duration * row.samples, 0) /
        measured.reduce((n, row) => n + row.samples, 0),
    );
    expect(actual.ai.get('/a b')).toMatchObject({
      requests: expectedAI.get('/a b').requests,
      bot: expectedAI.get('/a b').bot,
      botId: expectedAI.get('/a b').botId,
    });
    expect(actual.ai.has('/ignored')).toBe(false);
  } finally {
    await spool.dispose();
  }
});
it('processes 100013 source and path groups while preserving only selected rows, global counts and bounded daily channels', async () => {
  const count = 100013,
    spool = await WarehouseEvidenceSpool.create();
  const source = (i: number) => '来源'.repeat(100) + String(i).padStart(6, '0');
  try {
    const result = await buildWarehouseBrowserSources(
      spool,
      params({ tp_srcBody: 5001 }),
      async emit => {
        for (let i = 0; i < count; i++)
          await emit({
            utmSource: source(i),
            sessions: 1,
            duration: 5,
            conversions: 0,
            bounces: 1,
          });
      },
      none,
      async emit => {
        for (let i = 0; i < count; i++)
          await emit({ utmSource: source(i), day: '2026-01-01', count: 1 });
      },
    );
    expect(result.total).toBe(count);
    expect(result.rows).toHaveLength(13);
    expect(result.rows.at(-1).source).toBe(source(count - 1));
    expect(result.channels).toEqual([{ name: '其他引荐', count }]);
    expect(result.daily).toEqual([{ day: '2026-01-01', channel: '其他引荐', count }]);
    expect(result.aiSources).toEqual([]);
    const pages = await buildWarehouseBrowserPages(
      spool,
      params({ resource: 'overview', tp_topBody: 5001, tp_visitorTopBody: 5001 }),
      async emit => {
        for (let i = 0; i < count; i++)
          await emit({ path: `/page/${i}`, pv: 1, entries: 1, duration: i, samples: 1 });
      },
      none,
    );
    expect(pages.total).toBe(count);
    expect(pages.rows.topBody).toHaveLength(13);
    expect(pages.rows.visitorTopBody).toHaveLength(13);
    expect(pages.duration).toBe((count - 1) / 2);
  } finally {
    await spool.dispose();
  }
  expect(await readdir(directory)).toEqual([]);
}, 180000);
