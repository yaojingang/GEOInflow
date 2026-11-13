// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { selectRows } from '@/components/liekan/data';
import { parseReportQuery } from '../contracts/query';
import { pageUrl } from '../contracts/page-url';
import { reportEvidenceViewPayload } from '../contracts/report-evidence-view';
import { CRAWLER_METRIC_VERSION } from '../contracts/crawler-metrics';
import { getPublishedCatalog } from '../crawlers/published';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
const fixtures = vi.hoisted(() => ({
  rows: [] as any[],
  logs: vi.fn(),
  spool: vi.fn(),
  catalog: [{ path: '/页面2', updatedAt: new Date('2026-10-01T00:00:00Z') }],
  policy: { mode: 'standard', revision: '3', allowed_hostnames: ['example.test'] },
  repair: { generation: null, revision: '4' },
}));
vi.mock('./server', () => ({
  query: async (sql: string) =>
    sql.includes('FROM liekan_catalog')
      ? fixtures.catalog
      : sql.includes('FROM liekan_collection_policy')
        ? [fixtures.policy]
        : sql.includes('FROM liekan_log_state')
          ? [{ epoch: 2 }]
          : [fixtures.repair],
}));
vi.mock('./warehouse-report-snapshot', () => ({ withinWarehouseReport: (work: any) => work() }));
vi.mock('./warehouse-evidence-queries', () => ({ warehouseEvidenceSignal: () => undefined }));
vi.mock('./warehouse-log-queries', () => ({
  warehouseLogFacts: (...args: any[]) => fixtures.logs(...args),
}));
vi.mock('./warehouse-report-evidence', () => ({
  warehouseReportEvidence: (...args: any[]) => fixtures.spool(...args),
}));
import { attachReportEvidenceView } from './report-evidence-view';
import { warehouseReportPageComparison } from './warehouse-report-page-comparison';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const neutral = { filter: '全部', sort: { label: '', direction: 1 }, search: '' };
const base = {
  startAt: 0,
  endAt: 86400000,
  timezone: 'UTC',
  crawlerMetricsVersion: 1,
  crawlerIdentityScope: 'all',
};
const tableFor = { 'ai/pages': 'apBody', 'ai/bots': 'botBody', logs: 'logBody' };
const source = (rows: any[]) => ({
  count: async () => rows.length,
  page: async (offset: number, limit: number) => rows.slice(offset, offset + limit),
  stream: async (consume: any) => {
    for (let index = 0; index < rows.length; index += 3)
      await consume(rows.slice(index, index + 3));
  },
  fingerprint: async () => hash(rows),
});
const evidence = () =>
  ({
    access: { domain: 'example.test' },
    baseline: {
      catalog: hash(fixtures.catalog),
      registryVersion: getPublishedCatalog()?.version ?? null,
      populationVersion: TRAFFIC_POLICY_VERSION,
      policy: fixtures.policy,
      epoch: 2,
      metricVersion: CRAWLER_METRIC_VERSION,
      warehouse: 'must-not-enter-legacy-policy-hash',
      historyRepair: fixtures.repair,
    },
  }) as any;
const parse = (extra: any) => {
  const result = parseReportQuery({ ...base, ...extra });
  if (!result.success) throw new Error('fixture');
  return result.data;
};
async function expected(p: any, rows: any[], display: any, meta: any = {}, endAt = p.endAt) {
  const report = await attachReportEvidenceView(
    {
      website: { id: 'site', domain: 'example.test' },
      range: { startAt: p.startAt, endAt, timezone: p.timezone },
      tables: { [tableFor[p.resource]]: rows },
      meta,
    } as any,
    p,
  );
  return createHash('sha256').update(reportEvidenceViewPayload(report, display)).digest('hex');
}
beforeEach(() => {
  fixtures.logs.mockReset();
  fixtures.spool.mockReset();
  fixtures.rows = Array.from({ length: 45 }, (_, index) => ({
    path: `/页面${index}`,
    title: index % 2 ? '匹配' : null,
    requests: 45 - index,
    bot: 'GPTBot',
    botId: 'gptbot',
    lastCrawled: '1970-01-01T01:00:00.000Z',
  }));
  fixtures.spool.mockImplementation(async (_tx, _site, p, display, domain) => ({
    source: source(
      selectRows(
        fixtures.rows,
        display.filter,
        display.sort,
        tableFor[p.resource],
        display.search,
        value => pageUrl(value, domain),
      ),
    ),
  }));
});
it('hashes page rows after original pagination, before display selection, with the exact legacy policy JSON', async () => {
  const p = parse({ resource: 'ai/pages', tp_apBody: 2, refresh: '1' });
  const display = { filter: '全部', sort: { label: '页面', direction: -1 }, search: '匹配' };
  const selectedWhole = source(
    selectRows(fixtures.rows, display.filter, display.sort, 'apBody', display.search),
  );
  const actual = await warehouseReportPageComparison(
    {} as any,
    'site',
    p,
    evidence(),
    display,
    undefined,
    selectedWhole,
  );
  expect(actual).toBe(
    await expected(p, fixtures.rows.slice(20, 40), display, {
      tablePages: { apBody: { page: 2, pageSize: 20, total: 45 } },
    }),
  );
  expect(fixtures.spool.mock.calls[0][3]).toEqual(neutral);
  const wrong = await expected(p, fixtures.rows.slice(0, 20), display, {
    tablePages: { apBody: { page: 2, pageSize: 20, total: 45 } },
  });
  expect(actual).not.toBe(wrong);
});
it('reuses a neutral complete table and retains an empty out-of-range rendered page', async () => {
  const p = parse({ resource: 'ai/pages', tp_apBody: 4 });
  expect(
    await warehouseReportPageComparison(
      {} as any,
      'site',
      p,
      evidence(),
      neutral,
      undefined,
      source(fixtures.rows),
    ),
  ).toBe(
    await expected(p, [], neutral, {
      tablePages: { apBody: { page: 4, pageSize: 20, total: 45 } },
    }),
  );
  expect(fixtures.spool).not.toHaveBeenCalled();
});
it('streams every selected bot row in original JSON order rather than inventing a bot page', async () => {
  const p = parse({ resource: 'ai/bots' });
  fixtures.rows = Array.from({ length: 55 }, (_, index) => ({
    name: `Bot${index}`,
    requests: index,
    preference: index % 2 ? 'article（50% 抓取集中）' : null,
    trend: null,
  }));
  const display = { filter: '全部', sort: { label: '蜘蛛 / 厂商', direction: -1 }, search: '' };
  const selected = selectRows(fixtures.rows, display.filter, display.sort, 'botBody');
  const complete = source(selected);
  expect(
    await warehouseReportPageComparison(
      {} as any,
      'site',
      p,
      evidence(),
      display,
      undefined,
      complete,
    ),
  ).toBe(await expected(p, fixtures.rows, display));
  expect(fixtures.spool).not.toHaveBeenCalled();
  selected[54].requests = Number(selected[54].requests) + 1;
  expect(
    await warehouseReportPageComparison(
      {} as any,
      'site',
      p,
      evidence(),
      display,
      undefined,
      complete,
    ),
  ).not.toBe(await expected(p, fixtures.rows.slice(0, 20), display));
});
it.each(['after', 'before'])(
  'delegates the original 100-row cursor/%s comparison boundary and totalLogs before display filtering',
  async seek => {
    const p = parse({ resource: 'logs', page: 2, cursor: 'opaque-cursor', seek });
    const boundary: [Date, string] = [new Date(12345), 'a'.repeat(64)];
    const recent = [
      {
        recordId: 'record',
        path: '/page2',
        time: new Date(10000),
        userAgent: 'SyntheticBot',
        bot: 'GPTBot',
        verification: 'verified_range',
        identityEvidence: { proof: 'test' },
      },
    ];
    fixtures.logs.mockResolvedValue({ recent, totalLogs: 137 });
    const display = { filter: '全部', sort: { label: '', direction: 1 }, search: 'no-match' };
    const actual = await warehouseReportPageComparison(
      {} as any,
      'site',
      p,
      evidence(),
      display,
      boundary,
    );
    expect(actual).toBe(await expected(p, [], display, { totalLogs: 137 }));
    expect(fixtures.logs.mock.calls[0].slice(4)).toEqual([
      2,
      '',
      '',
      'opaque-cursor',
      seek,
      ['recent', 'count'],
      p,
      false,
      boundary,
    ]);
  },
);

it('pins an AI current-day cutoff and does not reuse an earlier full-table read with another cutoff', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(86400000);
  try {
    const p = parse({ resource: 'ai/pages', endAt: 2 * 86400000 });
    const actual = await warehouseReportPageComparison(
      {} as any,
      'site',
      p,
      evidence(),
      neutral,
      undefined,
      source([]),
    );
    expect(actual).toBe(
      await expected(
        p,
        fixtures.rows.slice(0, 20),
        neutral,
        { tablePages: { apBody: { page: 1, pageSize: 20, total: 45 } } },
        86400000,
      ),
    );
    expect(fixtures.spool.mock.calls[0][2].endAt).toBe(86400000);
  } finally {
    now.mockRestore();
  }
});
it('keeps nonempty rendered log identity and timestamp bytes in its comparison hash', async () => {
  const p = parse({ resource: 'logs' });
  const row = {
    recordId: 'id',
    path: '/page',
    time: new Date(10000),
    bot: 'GPTBot',
    verification: 'verified_edge',
    userAgent: 'Synthetic',
    identityEvidence: { proof: 'edge' },
  };
  fixtures.logs.mockResolvedValue({ recent: [row], totalLogs: 103 });
  const actual = await warehouseReportPageComparison({} as any, 'site', p, evidence(), neutral);
  expect(actual).toBe(
    await expected(
      p,
      [
        {
          ...row,
          time: new Date(10000).toISOString(),
          identityEvidence: JSON.stringify(row.identityEvidence),
          classification: 'GPTBot · 可信边缘身份核验',
        },
      ],
      neutral,
      { totalLogs: 103 },
    ),
  );
});
