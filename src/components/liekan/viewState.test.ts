import { describe, expect, it } from 'vitest';
import {
  clearTablePages,
  defaultDateRange,
  isLiveLogView,
  previousWeekRange,
  readViewState,
  readReportPage,
  resetViewParams,
} from './viewState';
import { parseReportQuery, tablePageMax, reportPageMax } from '@/lib/liekan/contracts/query';

describe('shareable GEO view conditions', () => {
  it('restores old other-known links using the residual category and resets its owned condition', () => {
    expect(readViewState({ filter: '其他已知' }, 'ai/bots').filter).toBe('其他爬虫');
    expect(readViewState({ filter: '其他爬虫' }, 'ai/bots').filter).toBe('其他爬虫');
    expect(Object.keys(resetViewParams)).toContain('botCategory');
  });
  it('restores the full geography selection from its URL', () => {
    expect(
      readViewState(
        { search: 'Xian', sort: '平均时长', direction: 'asc', tp_cityBody: '3' },
        'human/geo',
      ),
    ).toMatchObject({
      search: 'Xian',
      sort: { label: '平均时长', direction: 1 },
      tablePages: { cityBody: 3 },
    });
  });
  it('restores log filter, query, page, and sort directly from URL values', () => {
    const params = {
      filter: '仅 AI 蜘蛛',
      search: '/actual',
      page: '3',
      sort: '状态',
      direction: 'asc',
      cursor: 'opaque-log-cursor',
      seek: 'after',
    };
    expect(readViewState(params, 'logs')).toMatchObject({
      filter: '仅 AI 蜘蛛',
      search: '/actual',
      logPage: 3,
      sort: { label: '状态', direction: 1 },
      cursor: 'opaque-log-cursor',
      seek: 'after',
    });
    expect(readViewState({ ...params, page: '100001' }, 'logs').logPage).toBe(100001);
    expect(readViewState({ ...params, cursor: 'x'.repeat(513) }, 'logs').cursor).toBe('');
    expect(readViewState({ ...params, seek: 'invalid' }, 'logs').seek).toBe('');
    expect(readViewState({ ...params, seek: 'before' }, 'logs').seek).toBe('before');
  });
  it('restores trend period and rejects conditions from another resource', () => {
    expect(readViewState({ chartPeriod: '7d' }, 'overview').chartPeriod).toBe('7d');
    expect(
      readViewState(
        { filter: 'AI 训练', search: 'GPTBot', page: '2', chartPeriod: '7d', sort: '状态' },
        'content',
      ),
    ).toMatchObject({
      filter: '',
      search: '',
      logPage: 1,
      chartPeriod: 'today',
      sort: { label: '' },
    });
    expect(Object.keys(resetViewParams)).toContain('chartPeriod');
    expect(Object.keys(resetViewParams)).toContain('cursor');
    expect(Object.keys(resetViewParams)).toContain('seek');
    expect(Object.values(resetViewParams).every(value => value === undefined)).toBe(true);
  });
  it('compares the selected window shifted exactly seven days, including a 30-day selection', () => {
    const startAt = Date.parse('2026-09-01T00:00:00+08:00');
    const endAt = Date.parse('2026-09-30T23:59:59+08:00');
    const previous = previousWeekRange(startAt, endAt);
    expect(startAt - previous.startAt).toBe(7 * 86400000);
    expect(endAt - previous.endAt).toBe(7 * 86400000);
    expect(previous.endAt - previous.startAt).toBe(endAt - startAt);
  });
  it('keeps automatic log windows live while preserving explicitly selected history', () => {
    const date = 'range:1751328000000:1754006399999';
    expect(isLiveLogView({}, 'logs')).toBe(false);
    expect(isLiveLogView({ date, dateMode: 'default' }, 'logs')).toBe(false);
    expect(isLiveLogView({ date, live: '1' }, 'logs')).toBe(true);
    expect(isLiveLogView({ date }, 'logs')).toBe(false);
    expect(isLiveLogView({ live: '1' }, 'overview')).toBe(false);
    expect(Object.keys(resetViewParams)).toContain('live');
  });
  it('ends the automatic statistics range at Shanghai day end', () => {
    const range = defaultDateRange(Date.parse('2026-10-02T12:00:00+08:00'));
    expect(range.endAt).toBe(Date.parse('2026-10-02T23:59:59.999+08:00'));
    expect(range.startAt).toBe(Date.parse('2026-10-02T00:00:00+08:00'));
  });
  it('uses today calendar boundaries in the selected timezone, including daylight saving changes', () => {
    const utc = defaultDateRange(Date.parse('2026-10-03T04:00:00Z'), 'UTC');
    expect(utc.startAt).toBe(Date.parse('2026-10-03T00:00:00Z'));
    expect(utc.endAt).toBe(Date.parse('2026-10-03T23:59:59.999Z'));
    const newYork = defaultDateRange(Date.parse('2026-03-20T16:00:00Z'), 'America/New_York');
    expect(newYork.startAt).toBe(Date.parse('2026-03-20T04:00:00Z'));
    expect(newYork.endAt).toBe(Date.parse('2026-03-21T03:59:59.999Z'));
  });
});

it.each([100001, tablePageMax])(
  'round-trips table page %s through URL, view state and report schema',
  page => {
    const url = new URL('https://example.test/report');
    url.searchParams.set('tp_blindList', String(page));
    url.searchParams.set('tp_apBody', '2');
    const input = Object.fromEntries(url.searchParams);
    const view = readViewState(input, 'ai/pages');
    expect(view.tablePages).toEqual({ blindList: page, apBody: 2 });
    const parsed = parseReportQuery({
      ...input,
      resource: 'ai/pages',
      startAt: 0,
      endAt: 1000,
      timezone: 'UTC',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.tablePages).toEqual(view.tablePages);
    expect(Number.isSafeInteger((page - 1) * 20 + 20)).toBe(true);
  },
);

it.each([tablePageMax + 1, Number.MAX_SAFE_INTEGER + 1, 1.5])(
  'rejects unsafe or out-of-range table page %s',
  page => {
    const input = { tp_blindList: String(page), resource: 'ai/pages', startAt: 0, endAt: 1000 };
    expect(parseReportQuery(input).success).toBe(false);
    expect(readViewState({ tp_blindList: String(page) }, 'ai/pages').tablePages).toEqual({});
  },
);

it.each([100001, reportPageMax])(
  'round-trips shared log/keyword page %s without the old fixed cap',
  page => {
    const query = Object.fromEntries(new URLSearchParams({ page: String(page) }));
    expect(readReportPage(query.page)).toBe(page);
    expect(readViewState(query, 'logs').logPage).toBe(page);
    for (const resource of ['logs', 'human/keywords']) {
      const parsed = parseReportQuery({
        ...query,
        resource,
        startAt: 0,
        endAt: 1000,
        timezone: 'UTC',
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.page).toBe(page);
    }
    expect(Number.isSafeInteger((page - 1) * 100 + 100)).toBe(true);
  },
);

it.each([reportPageMax + 1, Number.MAX_SAFE_INTEGER + 1, 1.5, 0])(
  'rejects shared log/keyword page %s beyond the safe range',
  page => {
    expect(readReportPage(String(page))).toBe(1);
    expect(readViewState({ page: String(page) }, 'logs').logPage).toBe(1);
    for (const resource of ['logs', 'human/keywords'])
      expect(parseReportQuery({ page, resource, startAt: 0, endAt: 1000 }).success).toBe(false);
  },
);

it('restores pagable table pages only for whitelisted tables and pages above 1', () => {
  const state = readViewState(
    { tp_topBody: '3', tp_pgBody: '2', tp_apBody: '1', tp_goalBody: '2', tp_srcBody: 'x' },
    'content',
  );
  expect(state.tablePages).toEqual({ topBody: 3, pgBody: 2 });
  expect(readViewState({ tp_blindList: '5001', tp_apBody: '2' }, 'ai/pages').tablePages).toEqual({
    blindList: 5001,
    apBody: 2,
  });
  expect(clearTablePages({ blindList: 5001, apBody: 2 })).toEqual({
    tp_blindList: undefined,
    tp_apBody: undefined,
  });
  // 日志资源不消费表分页参数，避免与日志批分页混淆。
  expect(readViewState({ tp_topBody: '3' }, 'logs').tablePages).toEqual({});
  expect(
    Object.values(clearTablePages({ topBody: 3, srcBody: 2 })).every(value => value === undefined),
  ).toBe(true);
});
it('restores visitor overview sorting and applies it to the exported rows', async () => {
  const { tableCsv, selectRows } = await import('./data');
  const rows = [
    { path: '/large', pv: 20, uv: 4 },
    { path: '/small', pv: 1, uv: 9 },
  ];
  const ascending = readViewState({ sort: '浏览量 PV', direction: 'asc' }, 'overview');
  expect(selectRows(rows, '', ascending.sort, 'visitorTopBody')[0].path).toBe('/small');
  const descending = readViewState({ sort: '访客数 UV', direction: 'desc' }, 'overview');
  expect(selectRows(rows, '', descending.sort, 'visitorTopBody')[0].path).toBe('/small');
  const csv = tableCsv('visitorTopBody', rows, '', ascending.sort);
  expect(csv.indexOf('/small')).toBeLessThan(csv.indexOf('/large'));
});
it.each([
  ['人类 PV', '浏览 PV', 'asc', '/small', '/large'],
  ['人类 PV', '浏览 PV', 'desc', '/large', '/small'],
  ['AI/人 比值', 'AI/浏览 比值', 'asc', '/large', '/small'],
  ['AI/人 比值', 'AI/浏览 比值', 'desc', '/small', '/large'],
])(
  'preserves bookmarked overview sort %s (%s, %s) in rows and CSV',
  async (previousLabel, label, direction, first, last) => {
    const { tableCsv, selectRows } = await import('./data');
    const { translateText } = await import('@/lib/liekan/i18n/text');
    const rows = [
      { path: '/large', humanPv: 20, ratio: 1 },
      { path: '/small', humanPv: 1, ratio: 4 },
    ];
    const state = readViewState({ sort: previousLabel, direction }, 'overview');
    expect(state.sort).toEqual({ label, direction: direction === 'asc' ? 1 : -1 });
    expect(state.sort).toEqual(readViewState({ sort: label, direction }, 'overview').sort);
    expect(selectRows(rows, state.filter, state.sort, 'topBody').map(row => row.path)).toEqual([
      first,
      last,
    ]);
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const csv = tableCsv(
        'topBody',
        rows,
        state.filter,
        state.sort,
        '',
        undefined,
        locale,
        source => translateText(source, locale),
      );
      expect(csv.split('\r\n')[1]).toContain(first);
      expect(csv.split('\r\n')[2]).toContain(last);
    }
  },
);
it('keeps renamed overview sort aliases within the overview whitelist', () => {
  for (const sort of ['人类 PV', 'AI/人 比值', '浏览 PV', 'AI/浏览 比值']) {
    for (const resource of ['human/overview', 'content', 'logs', 'ai/pages'] as const) {
      expect(readViewState({ sort, direction: 'asc' }, resource).sort.label).toBe('');
    }
  }
  expect(readViewState({ sort: 'unknown' }, 'overview').sort.label).toBe('');
});
