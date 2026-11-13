import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  facts: vi.fn(),
  today: vi.fn(),
  settings: vi.fn(),
  query: vi.fn(),
  statistics: vi.fn(),
  warehouse: vi.fn(),
}));
vi.mock('../warehouse/authority-routing', () => ({ warehouseEnabled: mocks.warehouse }));
vi.mock('./crawler-registry-context', () => ({ withPublishedRegistry: (work: any) => work() }));
vi.mock('./log-statistics', () => ({ readLogStatistics: mocks.statistics }));
vi.mock('./logs', () => ({ getLogFacts: mocks.facts, getLogToday: mocks.today }));
vi.mock('../store', () => ({ getSettings: mocks.settings }));
vi.mock('./server', () => ({ reportSnapshot: (work: any) => work(), query: mocks.query }));
vi.mock('./query-snapshot', () => ({ getQuerySnapshot: () => ({}) }));
vi.mock('./log-read-boundary', async () => ({
  ...(await vi.importActual('./log-read-boundary')),
  logReadBoundary: async (_tx: any, _id: string, input: any) =>
    input.readBoundary || 'a'.repeat(64),
}));
vi.mock('./report-evidence-view', () => ({ reportEvidencePolicy: async () => 'b'.repeat(64) }));

import { readLogCount, readLogEntries, readLogSummary } from './log-read';
import { mergeLogReportParts } from './log-report-client';

const website = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '合成测试',
  domain: 'example.invalid',
};
const input = {
  startAt: 1,
  endAt: 1000,
  timezone: 'UTC',
  crawlerMetricsVersion: 1,
  readBoundary: 'a'.repeat(64),
};
const rows = Array.from({ length: 101 }, (_, i) => ({
  time: new Date(1000000 - i * 1000).toISOString(),
  recordId: i.toString(16).padStart(64, '0'),
  path: `/entry/${i}`,
  bot: '其他',
  userAgent: 'fixture',
  identityEvidence: { verified: false },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.warehouse.mockReturnValue(false);
  mocks.statistics.mockResolvedValue({
    requests: 9876,
    ai: 50,
    abnormal: 40,
    legacyRequests: 4,
    unclassifiedRequests: 5,
    classifications: ['fixture'],
  });
  mocks.facts.mockResolvedValue({
    connected: true,
    latest: new Date(1),
    recent: rows,
    totalLogs: 9876,
    summary: {
      requests: 9876,
      classificationVersions: 1,
      legacyRequests: 4,
      unclassifiedRequests: 5,
    },
  });
  mocks.settings.mockResolvedValue({
    isDemo: true,
    aiCrawlerEnabled: true,
    logsConfigured: true,
    rules: [1, 2],
  });
  mocks.today.mockResolvedValue({ accepted: 11, abnormal: 3 });
  mocks.query.mockResolvedValue([{ count: 7 }]);
});

it('reads 101 ordered entries without invoking count, summary or today calculations', async () => {
  const value = await readLogEntries(website, input, false);
  expect(mocks.facts.mock.calls[0][9]).toEqual(['recent', 'latest']);
  expect(mocks.facts.mock.calls[0][13]).toEqual({ cursorScope: input.readBoundary, limit: 101 });
  expect(mocks.today).not.toHaveBeenCalled();
  expect(value.tables.logBody).toHaveLength(100);
  expect(value.tables.logBody[99].path).toBe('/entry/99');
  expect(value.meta.logHasMore).toBe(true);
  expect(value.meta.totalLogs).toBeUndefined();
  expect(value.cards).toEqual([]);
  expect(value.meta.logParts).toEqual({ count: 'pending', summary: 'pending' });
});

it('retains the closest 100 entries and their real cursor when reading backward', async () => {
  const value = await readLogEntries(
    website,
    { ...input, page: 2, cursor: 'fixture', seek: 'before' },
    false,
  );
  expect(value.tables.logBody[0].path).toBe('/entry/1');
  expect(JSON.parse(Buffer.from(value.meta.previousCursor, 'base64url').toString())[1]).toBe(
    rows[1].recordId,
  );
});

it('preserves exact count filters and never queries table rows for a count', async () => {
  expect(
    await readLogCount(website.id, { ...input, filter: 'abnormal', search: '/entry' }),
  ).toEqual({ readBoundary: input.readBoundary, total: 9876 });
  const args = mocks.facts.mock.calls[0];
  expect(args.slice(5, 10)).toEqual(['abnormal', '/entry', '', 'after', ['count']]);
});

it('keeps summary counters unfiltered and records the original displayed cursor for export comparison', async () => {
  const value = await readLogSummary(website.id, {
    ...input,
    page: 2,
    cursor: 'fixture',
    filter: 'abnormal',
    search: '/entry',
  });
  expect(mocks.facts.mock.calls[0].slice(5, 10)).toEqual(['', '', '', 'after', ['latest']]);
  expect(value.cards.find(c => c.label === '今日已解析').value).toBe(11);
  expect(value.cards.find(c => c.label === '异常请求（今日）').value).toBe(3);
  expect(value.tables.pipeList[2].detail).toBe('7 条目录记录');
  expect(value.evidence.query.cursor).toBe('fixture');
  expect(value.evidence.query.page).toBe(2);
});

it('reads independent ClickHouse log parts through the warehouse without PostgreSQL fact queries', async () => {
  mocks.warehouse.mockReturnValue(true);
  mocks.facts.mockResolvedValue({
    connected: true,
    latest: new Date(1),
    recent: rows,
    nextCursor: 'warehouse-next',
    previousCursor: 'warehouse-previous',
    totalLogs: 9876,
    summary: { requests: 9876, classificationVersions: 1 },
  });
  const entries = await readLogEntries(website, { ...input, page: 2 }, false);
  const count = await readLogCount(website.id, input);
  const summary = await readLogSummary(website.id, input);
  expect([entries.meta.nextCursor, entries.meta.previousCursor]).toEqual([
    'warehouse-next',
    'warehouse-previous',
  ]);
  expect(count.total).toBe(9876);
  expect(summary.states.logs).toBe('available');
  expect(mocks.statistics).not.toHaveBeenCalled();
  expect(mocks.facts.mock.calls.map(args => args[9])).toEqual([
    ['recent', 'latest'],
    ['count'],
    ['summary', 'latest'],
  ]);
});

describe('independent response assembly', () => {
  it('ignores a count or summary from another input boundary', async () => {
    const entries = await readLogEntries(website, input, false);
    const summary = await readLogSummary(website.id, input);
    const result = mergeLogReportParts(
      entries,
      { readBoundary: 'c'.repeat(64), total: 0 },
      { ...summary, readBoundary: 'c'.repeat(64) },
    );
    expect(result.meta.totalLogs).toBeUndefined();
    expect(result.cards).toEqual([]);
    expect(result.tables.logBody).toHaveLength(100);
  });
  it('preserves real zero counts, publishes export evidence only when both parts are ready, and keeps failures distinct', async () => {
    const entries = await readLogEntries(website, input, false);
    const summary = await readLogSummary(website.id, input);
    const pending = mergeLogReportParts(entries, undefined, summary);
    expect(pending.meta.crawlerEvidenceView).toBeUndefined();
    const complete = mergeLogReportParts(
      entries,
      { readBoundary: input.readBoundary, total: 0 },
      summary,
    );
    expect(complete.meta.totalLogs).toBe(0);
    expect(complete.meta.crawlerEvidenceView.snapshot).toMatch(/^[a-f0-9]{64}$/);
    const failed = mergeLogReportParts(entries, undefined, undefined, {
      count: true,
      summary: true,
    });
    expect(failed.meta.totalLogs).toBeUndefined();
    expect(failed.meta.logParts).toEqual({ count: 'failed', summary: 'failed' });
    expect(failed.cards.every(card => card.state === 'unavailable' && card.value === null)).toBe(
      true,
    );
  });
});
