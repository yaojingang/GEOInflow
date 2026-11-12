import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./server', () => ({ query: vi.fn(), LiekanError: class extends Error {} }));

import { waitForLogStatisticsReads } from './ai-log-read-priority';
import { getContentImpact, getLogFacts, getMonthlyAiShare, isStaticRequestPath } from './logs';
import { query } from './server';

beforeEach(() => vi.resetAllMocks());

it('uses a validated split-read scope without scanning classification or evaluating empty text search', async () => {
  vi.mocked(query).mockResolvedValue([]);
  await getLogFacts(
    'site',
    new Date(1),
    new Date(1000),
    'UTC',
    1,
    '',
    '',
    '',
    'after',
    ['recent'],
    { crawlerMetricsVersion: 1, crawlerIdentityScope: 'all' },
    false,
    undefined,
    { cursorScope: 'a'.repeat(64), limit: 101 },
  );
  const calls = vi.mocked(query).mock.calls;
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toContain('LIMIT 101');
  expect(calls[0][0]).not.toContain('concat_ws');
  await getLogFacts(
    'site',
    new Date(1),
    new Date(1000),
    'UTC',
    1,
    '',
    'needle',
    '',
    'after',
    ['recent'],
    { crawlerMetricsVersion: 1, crawlerIdentityScope: 'all' },
    false,
    undefined,
    { cursorScope: 'a'.repeat(64), limit: 101 },
  );
  expect(vi.mocked(query).mock.calls[1][0]).toContain('concat_ws');
  expect(vi.mocked(query).mock.calls[1][5]).toBe('needle');
});

it('resolves current-window report aggregates with one reporting-log scan', async () => {
  vi.mocked(query).mockResolvedValue([]);
  await getLogFacts(
    'site',
    new Date('2026-10-01'),
    new Date('2026-10-03'),
    'UTC',
    1,
    '',
    '',
    '',
    'after',
    ['summary', 'daily', 'bots', 'pages', 'statuses', 'hours'],
    { crawlerMetricsVersion: 1, crawlerIdentityScope: 'all', resource: 'ai/overview' },
  );
  const scans = vi
    .mocked(query)
    .mock.calls.filter(([sql]) => sql.includes('FROM liekan_reporting_log'));
  expect(scans).toHaveLength(1);
  expect(scans[0][0]).toContain('AS MATERIALIZED');
});

describe('today request content boundary', () => {
  it('excludes static assets while preserving document and extension boundaries', () => {
    for (const path of [
      '/app.js',
      '/app.MJS',
      '/app.css',
      '/app.js.map',
      '/cover.JPG',
      '/x.webp',
      '/icon.svg',
      '/font.woff2',
      '/clip.mp4',
      '/app.js?v=1',
    ])
      expect(isStaticRequestPath(path), path).toBe(true);
    for (const path of [
      '/article.html',
      '/report.pdf',
      '/data.json',
      '/sitemap.xml',
      '/feed.txt',
      '/app.js/guide',
      '/notjs',
      '/index.js-extra',
      '/',
    ])
      expect(isStaticRequestPath(path), path).toBe(false);
  });
});
describe('content impact path boundary', () => {
  it('binds decoded upstream paths while retaining imported paths for log evidence', async () => {
    const importedPath = '/%E6%96%87%E6%A1%A3/AI%20%E5%85%A5%E9%97%A8';
    vi.mocked(query).mockResolvedValueOnce([
      { path: importedPath, publishedAt: '2026-09-01T00:00:00Z' },
    ]);
    vi.mocked(query).mockResolvedValueOnce([{ path: importedPath, pv: 7, increment: 3 }]);
    expect(await getContentImpact('site', new Date('2026-09-01'), new Date('2026-09-30'))).toEqual([
      { path: importedPath, pv: 7, increment: 3 },
    ]);
    const targets = JSON.parse(vi.mocked(query).mock.calls[1][2] as string);
    expect(targets).toEqual([
      { path: importedPath, humanPath: '/文档/AI 入门', publishedAt: '2026-09-01T00:00:00Z' },
    ]);
  });
});
describe('monthly AI share calendar', () => {
  it('anchors a half-open month-end window to its last included month', async () => {
    vi.mocked(query).mockResolvedValue([]);
    const end = new Date('2026-10-31T16:00:00Z');
    const rows = await getMonthlyAiShare('site', end, 'Asia/Shanghai', {
      crawlerIdentityScope: 'all',
      crawlerMetricsVersion: 1,
    });
    expect(rows.map(row => row.month)).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ]);
    const [sql, , upperBound, , monthAnchor] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain('created_at<$2');
    expect(sql).toContain("date_trunc('month',$4::timestamptz");
    expect(upperBound).toEqual(end);
    expect(monthAnchor).toEqual(new Date(+end - 1));
  });
  it('returns six consecutive months across the year with unobserved gaps', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { month: '2025-09', total: 5, ai: 0 },
      { month: '2026-02', total: 2, ai: 1 },
    ]);
    expect(
      await getMonthlyAiShare('site', new Date('2026-02-15T00:00:00Z'), 'Asia/Shanghai'),
    ).toEqual([
      { month: '2025-09', total: 5, ai: 0 },
      { month: '2025-10', total: 0, ai: 0 },
      { month: '2025-11', total: 0, ai: 0 },
      { month: '2025-12', total: 0, ai: 0 },
      { month: '2026-01', total: 0, ai: 0 },
      { month: '2026-02', total: 2, ai: 1 },
    ]);
    vi.mocked(query).mockResolvedValueOnce([]);
    expect(
      (
        await getMonthlyAiShare('site', new Date('2026-01-01T04:00:00Z'), 'America/Los_Angeles')
      ).map(row => row.month),
    ).toEqual(['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12']);
  });
});

describe('foreground log read priority', () => {
  it('finishes the foreground response before waking queued AI work', async () => {
    let release!: (value: any[]) => void;
    const pending = new Promise<any[]>(resolve => {
      release = resolve;
    });
    vi.mocked(query).mockReturnValue(pending);
    const events: string[] = [];
    const report = getLogFacts(
      'site',
      new Date('2026-10-01'),
      new Date('2026-10-03'),
      'UTC',
      1,
      '',
      '',
      '',
      'after',
      ['summary'],
    ).then(() => {
      events.push('foreground');
    });
    const waiting = waitForLogStatisticsReads(new AbortController().signal, Date.now() + 1000).then(
      () => {
        events.push('ai');
      },
    );
    release([{ summary: [{ requests: 0, ai: 0, pages: 0, abnormal: 0 }] }]);
    await Promise.all([report, waiting]);
    expect(events).toEqual(['foreground', 'ai']);
  });

  it('retains unfinished queries when a sibling has already failed', async () => {
    let release!: (value: any[]) => void;
    const pending = new Promise<any[]>(resolve => {
      release = resolve;
    });
    const error = new Error('test query failure');
    vi.mocked(query)
      .mockResolvedValue([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(error)
      .mockReturnValueOnce(pending);
    const report = getLogFacts('site', new Date('2026-10-01'), new Date('2026-10-03'), 'UTC');
    await expect(report).rejects.toBe(error);
    let released = false;
    const waiting = waitForLogStatisticsReads(new AbortController().signal, Date.now() + 1000).then(
      () => {
        released = true;
      },
    );
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(released).toBe(false);
    } finally {
      release([]);
      await waiting;
    }
    expect(released).toBe(true);
  });

  it('retains priority until previous-period bots have settled', async () => {
    let release!: (value: any[]) => void;
    const pending = new Promise<any[]>(resolve => {
      release = resolve;
    });
    vi.mocked(query).mockImplementation(async sql => {
      if (sql.startsWith('SELECT bot AS name')) return pending;
      if (sql.startsWith('SELECT count(*)::int AS count')) return [{ count: 0 }];
      return [];
    });
    const report = getLogFacts('site', new Date('2026-10-01'), new Date('2026-10-03'), 'UTC');
    await vi.waitFor(() =>
      expect(
        vi.mocked(query).mock.calls.some(([sql]) => sql.startsWith('SELECT bot AS name')),
      ).toBe(true),
    );
    let released = false;
    const waiting = waitForLogStatisticsReads(new AbortController().signal, Date.now() + 1000).then(
      () => {
        released = true;
      },
    );
    try {
      await Promise.resolve();
      expect(released).toBe(false);
    } finally {
      release([]);
      await Promise.all([report, waiting]);
    }
    expect(released).toBe(true);
  });
});
