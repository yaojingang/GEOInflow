// @vitest-environment node
import { randomUUID, randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { reportFixture } from '../../../../tests/liekan/report-plan-fixture';
import type { ReportQuery } from '../contracts/query';
import {
  currentAnalysisRead,
  withAnalysisRead,
  withoutAnalysisRead,
} from '../warehouse/analysis-context';
import { createWarehouseClient } from '../warehouse/client';
import { ReadAdmission } from '../warehouse/read-admission';
import { reportingLogRelation } from '../warehouse/reporting-relations';
import {
  journalDDL,
  factDDL,
  warehouseAnalysisDDL,
  warehouseDDL,
  warehouseLogTrendDDL,
  warehouseOverviewLogDDL,
  warehouseReportRankDDL,
} from '../warehouse/schema';
import {
  captureReportRankings,
  readReportRanking,
  rankingPageReady,
  recordReportRanking,
} from './report-ranking-artifact';

const harness = vi.hoisted(() => ({ reader: undefined as any, metadata: undefined as any }));
vi.mock('../warehouse/reader-runtime', () => ({ warehouseReader: () => harness.reader }));
vi.mock('../warehouse/reporting-context', () => ({
  readReportingMetadata: async () => structuredClone(harness.metadata),
}));
vi.mock('../warehouse/read-reference', () => ({
  WarehouseReadReferences: class {
    signal = new AbortController().signal;
    async pin() {}
    async verify() {}
    async close() {}
  },
}));

import { withDashboardClock } from './dashboard-clock';
import {
  prepareAnalysisModel,
  withAvailableAnalysisModel,
  withVerifiedAnalysisRead,
} from './warehouse-analysis-model';
import { warehouseBrowserPopulation } from './warehouse-browser-population';
import {
  warehouseBrowserFacts,
  warehouseBrowserParameters,
  warehouseBrowserTotals,
  warehouseVisitsSQL,
} from './warehouse-browser-queries';
import {
  warehouseLogFacts,
  warehouseLogQuerySpec,
  warehouseLogDetailColumns,
  warehouseLogDetailRow,
  warehousePlotLogs,
} from './warehouse-log-queries';
import { prepareWarehouseOverviewLogSegments } from './warehouse-overview-log-segments';
import { warehouseReportQuery, withinWarehouseReport } from './warehouse-report-snapshot';

const url = process.env.LIEKAN_REPORT_PLAN_CH_URL;
it.skipIf(!url)(
  'matches the 24 AI clock hours for today, 7d and 30d at one publication',
  async () => {
    expect(url).toBe('http://127.0.0.1:28169');
    const database = `report_clock_${randomUUID().replaceAll('-', '')}`;
    const admin = createWarehouseClient({ url });
    const ch = createWarehouseClient({
      url,
      database,
      clickhouse_settings: { max_threads: 1, max_memory_usage: '320000000', join_use_nulls: 1 },
    });
    const admission = new ReadAdmission(1);
    try {
      await admin.command({ query: `CREATE DATABASE ${database}` });
      for (const query of [
        ...journalDDL,
        ...['liekan_log', 'liekan_crawler_evidence', 'liekan_history_repair_result'].map(factDDL),
        warehouseLogTrendDDL,
      ])
        await ch.command({ query });
      const f = reportFixture(ch);
      harness.reader = { ch, db: {}, admission, verifyIdentity: async () => {} };
      harness.metadata = f.metadata;
      const log = (local: string, extra: Record<string, unknown> = {}) => ({
        created_at: local + '+08:00',
        id: randomBytes(32).toString('hex'),
        import_id: f.site,
        path: '/fixture',
        method: 'GET',
        status: 200,
        bytes: 0,
        ip_masked: '',
        ip_hash: '',
        location: '',
        user_agent: 'fixture',
        bot: 'Fixture',
        vendor: 'Fixture',
        bot_type: '搜索',
        verification: 'verified_range',
        ai_eligible: true,
        ...extra,
      });
      await f.put('liekan_log', [
        log('2026-10-19T23:59:59'),
        log('2026-10-20T23:22:00'),
        log('2026-11-12T00:00:00'),
        log('2026-11-13T11:12:00'),
        log('2026-11-19T00:00:00'),
        log('2026-11-19T00:22:00', { verification: 'unknown' }),
        log('2026-11-19T01:22:00', { user_agent: 'Liekan-Crawler-Check/fixture' }),
        log('2026-11-19T01:24:00', { ai_eligible: false }),
        log('2026-11-19T02:33:00', { verification: 'verified_dns' }),
        log('2026-11-19T11:32:59'),
        log('2026-11-19T11:33:00'),
      ]);
      const publication = f.metadata.boundary.publication;
      await f.put('liekan_log', [log('2026-11-19T00:20:00')], { accepted: false });
      const zone = 'Asia/Shanghai',
        cutoff = new Date('2026-11-19T11:33:00+08:00');
      const metrics = {
        resource: 'ai/overview',
        crawlerIdentityScope: 'all',
        crawlerMetricsVersion: 1,
      } as const;
      const midnight = (date: string) => new Date(date + 'T00:00:00+08:00');
      const today = midnight('2026-11-19');
      const read = (from: Date, scope: ReportQuery['crawlerIdentityScope'] = 'all') =>
        warehouseLogFacts(f.site, from, cutoff, zone, 1, '', '', '', 'after', ['hours'], {
          ...metrics,
          crawlerIdentityScope: scope,
        }).then(r => r.hours);
      const bins = (rows: { hour: number; count: unknown }[]) => {
        const values = Array<number>(24).fill(0);
        for (const r of rows) values[r.hour] = Number(r.count);
        return values;
      };
      const spy = vi.spyOn(ch, 'query');
      const factReads = () =>
        spy.mock.calls
          .map(([q]) => q)
          .filter(
            q =>
              q.query.includes('GROUP BY hour ORDER BY hour') ||
              q.query.includes('GROUP BY hour,bot,type'),
          );
      await withinWarehouseReport(async () => {
        // The legacy summary includes the self-check. A differently scoped v1
        // summary excludes the unverified event. Neither can supply the all/v1 chart.
        for (const other of [
          { crawlerIdentityScope: 'all' } as const,
          { crawlerIdentityScope: 'verified_range', crawlerMetricsVersion: 1 } as const,
        ])
          await withDashboardClock(
            +cutoff,
            () => warehousePlotLogs(f.site, today, cutoff, zone, true, other),
            'refresh',
          );

        const src = async (from: Date) => {
          const spec = await warehouseLogQuerySpec(
            from,
            cutoff,
            zone,
            metrics,
            '',
            '',
            false,
            f.site,
          );
          return bins(await warehouseReportQuery(f.site, spec.statements.hours, spec.params));
        };
        const todayBins = await src(today);
        expect(todayBins.filter(Boolean)).toEqual([2, 1, 1]);
        spy.mockClear();
        expect(bins(await read(today))).toEqual(todayBins);
        expect(spy.mock.calls.some(([q]) => q.query.includes('(hour,build) IN'))).toBe(false);
        expect(factReads()).toHaveLength(1);

        const hour = 3600000;
        await withDashboardClock(
          +cutoff,
          () =>
            warehousePlotLogs(
              f.site,
              new Date(+today + hour),
              new Date(+today + 3 * hour),
              zone,
              true,
              metrics,
            ),
          'refresh',
        );
        spy.mockClear();
        expect(bins(await withDashboardClock(+cutoff, () => read(today), 'first'))).toEqual(
          todayBins,
        );
        const partial = factReads();
        expect(partial).toHaveLength(1);
        expect(partial[0].query_params.logHours).toEqual(
          [0, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(h => +today / 1000 + h * 3600),
        );
        expect(bins(await read(today, 'verified_range')).filter(Boolean)).toEqual([1, 1]);

        for (const [date, total] of [
          ['2026-11-19', 4],
          ['2026-11-12', 6],
          ['2026-10-20', 7],
        ] as const) {
          const from = midnight(date);
          const expected = await src(from);
          expect(expected.reduce((a, b) => a + b, 0)).toBe(total);
          const handCount = Array<number>(24).fill(0);
          handCount[0] = date === '2026-11-19' ? 2 : 3;
          handCount[2] = 1;
          handCount[11] = date === '2026-11-19' ? 1 : 2;
          handCount[23] = date === '2026-10-20' ? 1 : 0;
          expect(expected).toEqual(handCount);
          expect(bins(await withDashboardClock(+cutoff, () => read(from), 'refresh'))).toEqual(
            expected,
          );
          spy.mockClear();
          expect(bins(await read(from))).toEqual(expected);
          const warm = factReads();
          expect(warm).toHaveLength(1);
          expect(warm[0].query_params.logHours).toEqual([+today / 1000 + 11 * 3600]);
          expect(warm[0].query_params.logStart).toBe('2026-11-19 03:00:00.000000');
          expect(warm[0].query_params.logEnd).toBe('2026-11-19 03:33:00.000000');
          expect(spy.mock.calls.every(([q]) => q.query_params.wh_publication === publication)).toBe(
            true,
          );
        }
      });

      // Late publication dirties only its hour. A read pinned to the old
      // publication must still use the old build, even after the new one exists.
      await f.put('liekan_log', [log('2026-11-19T02:40:00')]);
      const updated = bins(await withDashboardClock(+cutoff, () => read(today), 'refresh'));
      expect(updated[2]).toBe(2);
      const old = await withinWarehouseReport(() => read(today), {
        publication: { websiteId: f.site, publication },
      });
      expect(bins(old)[2]).toBe(1);
    } finally {
      admission.close();
      await ch.close();
      await admin.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await admin.close();
    }
  },
  45000,
);

it.skipIf(!url)(
  'shares cold exact log summaries and trends across overlapping verified windows',
  async () => {
    expect(url).toBe('http://127.0.0.1:28169');
    const database = `report_overlap_${randomUUID().replaceAll('-', '')}`;
    const admin = createWarehouseClient({ url });
    await admin.command({ query: `CREATE DATABASE ${database}` });
    const ch = createWarehouseClient({
      url,
      database,
      clickhouse_settings: { max_threads: 1, max_memory_usage: '1000000000', join_use_nulls: 1 },
    });
    harness.reader = {
      ch,
      db: {},
      admission: new ReadAdmission(1),
      verifyIdentity: async () => {},
    };
    try {
      for (const query of [
        ...warehouseDDL(),
        ...warehouseAnalysisDDL,
        ...warehouseOverviewLogDDL,
        warehouseLogTrendDDL,
      ])
        await ch.command({ query });
      const f = reportFixture(ch);
      harness.metadata = f.metadata;
      const from = new Date('2026-11-01T00:00:00Z');
      const later = new Date('2026-11-02T00:00:00Z');
      const cutoff = new Date('2026-11-03T02:30:00Z');
      await f.put(
        'liekan_log',
        [
          '2026-11-01T03:12:00Z',
          '2026-11-02T06:25:00Z',
          '2026-11-03T02:15:00Z',
          '2026-11-03T02:30:00Z',
        ].map((created_at, i) => ({
          id: randomBytes(32).toString('hex'),
          import_id: randomUUID(),
          created_at,
          path: i === 3 ? '/end-exclusive' : '/repeated-path',
          status: i === 1 ? 404 : 200,
          method: 'GET',
          bytes: 0,
          ip_masked: '',
          ip_hash: '',
          user_agent: 'fixture',
          location: '',
          bot: 'Fixture',
          vendor: 'Fixture',
          bot_type: '搜索',
          verification: '',
          ai_eligible: true,
        })),
      );
      const params = {
        resource: 'overview',
        chartPeriod: '30d',
        timezone: 'UTC',
        crawlerIdentityScope: 'all',
        crawlerMetricsVersion: 1,
      } as ReportQuery;
      const model = await withinWarehouseReport(() =>
        prepareAnalysisModel(f.site, from, cutoff, {
          kinds: ['log'],
          completeThrough: +cutoff,
        }),
      );
      const { warehouseLogToday } = await import('./warehouse-log-queries');
      harness.reader.db = { read: async () => [{ accepted: '9' }] };
      const reference = await withinWarehouseReport(() => warehouseLogToday(f.site, from, cutoff));
      expect(reference).toEqual({ requests: 4, abnormal: 1, accepted: 9 });
      const querySpy = vi.spyOn(ch, 'query');
      try {
        const observed = await withinWarehouseReport(() =>
          withVerifiedAnalysisRead(model, () => warehouseLogToday(f.site, from, cutoff)),
        );
        expect(observed).toEqual(reference);
        const reads = querySpy.mock.calls.map(([o]) => o).filter(o => o.query.includes(' AS requests,countIf(status>=400) AS abnormal'));
        expect(reads).toHaveLength(1);
        expect(reads[0].query_params?.logStart).toBe('2026-11-03 02:00:00.000000');
      } finally {
        querySpy.mockRestore();
      }
      const run = (start: Date, chartPeriod: '7d' | '30d') =>
        withinWarehouseReport(async () => {
          const metrics = { ...params, chartPeriod };
          const raw = await warehouseLogQuerySpec(
            start,
            cutoff,
            'UTC',
            metrics,
            'all',
            '',
            false,
            f.site,
            true,
          );
          const expected = await warehouseReportQuery(f.site, raw.overview, raw.params);
          const trend = await warehousePlotLogs(f.site, start, cutoff, 'UTC', false, metrics);
          return withVerifiedAnalysisRead(model, () =>
            withDashboardClock(
              +cutoff,
              async () => {
                const saved = await prepareWarehouseOverviewLogSegments(
                  f.site,
                  start,
                  cutoff,
                  metrics,
                );
                expect(saved).toBeDefined();
                expect(await warehouseReportQuery(f.site, saved.sql, saved.params)).toEqual(
                  expected,
                );
                expect(
                  await warehousePlotLogs(f.site, start, cutoff, 'UTC', false, metrics),
                ).toEqual(trend);
                return saved.params.overviewBuilds;
              },
              'first',
            ),
          );
        });
      const builds = await run(from, '30d');
      expect(await run(later, '7d')).toEqual([builds[1]]);
      const [summary] = await ch
        .query({
          query: `SELECT countIf(hour=0) AS manifests,countIf(hour!=0) AS hours FROM warehouse_log_hourly_trend`,
          format: 'JSONEachRow',
        })
        .then(result => result.json());
      expect(summary).toEqual({ manifests: '1', hours: '50' });
      const late = {
        id: randomBytes(32).toString('hex'), import_id: randomUUID(),
        created_at: '2026-11-01T03:59:00Z', path: '/bundle.JS?q=a', status: 500,
        method: 'GET', bytes: 0, ip_masked: '', ip_hash: '', user_agent: 'fixture',
        location: '', bot: '', vendor: '', bot_type: '', verification: '', ai_eligible: false,
      };
      async function compareCounts(requests: number, abnormal: number) {
        return withinWarehouseReport(async () => {
          const counts = () => warehouseLogToday(f.site, from, cutoff);
          const expected = await counts();
          expect(expected).toEqual({ requests, abnormal, accepted: 9 });
          const built = await prepareAnalysisModel(f.site, from, cutoff, {
            kinds: ['log'], completeThrough: +cutoff,
          });
          expect(await withVerifiedAnalysisRead(built, counts)).toEqual(expected);
          return new Map(built.log.map(([hour, build]) => [hour, build]));
        });
      }
      await f.put('liekan_log', [late]);
      const afterLate = await compareCounts(4, 2);
      await f.put('liekan_log', [late]);
      const replayed = await compareCounts(4, 2);
      const oldHour = Date.parse('2026-11-01T03:00:00Z') / 1000;
      expect([...afterLate].filter(([h,b]) => replayed.get(h) !== b).map(([h]) => h)).toEqual([oldHour]);
      // Replace the old event at its original time and publish the corrected
      // event on the next day. Both complete UTC hours must get new builds.
      await f.put('liekan_log', [late], { deleted: true });
      await f.put('liekan_log', [{
        ...late, created_at: '2026-11-02T06:10:00Z', path: '/corrected', status: 200,
      }]);
      const moved = await compareCounts(5, 1);
      expect([...replayed].filter(([h,b]) => moved.get(h) !== b).map(([h]) => h))
        .toEqual([oldHour, Date.parse('2026-11-02T06:00:00Z') / 1000]);
    } finally {
      await ch.close();
      await admin.command({ query: `DROP DATABASE ${database} SYNC` });
      await admin.close();
    }
  },
  60000,
);

it.skipIf(!url)(
  'keeps partial log fallback canonical with late evidence, deletion and filtered pagination',
  async () => {
    expect(url).toBe('http://127.0.0.1:28169');
    const database = `report_fallback_${randomUUID().replaceAll('-', '')}`;
    const admin = createWarehouseClient({ url });
    await admin.command({ query: `CREATE DATABASE ${database}` });
    const ch = createWarehouseClient({
      url,
      database,
      clickhouse_settings: { max_threads: 2, max_memory_usage: '1000000000', join_use_nulls: 1 },
    });
    harness.reader = {
      ch,
      db: {},
      admission: new ReadAdmission(1),
      verifyIdentity: async () => {},
    };
    try {
      for (const query of [
        ...warehouseDDL(),
        ...warehouseAnalysisDDL.filter(q => !q.startsWith('ALTER TABLE')),
      ])
        await ch.command({ query });
      // Upgrade an existing shared-watermark manifest without rebuilding facts.
      const legacySite = randomUUID();
      await ch.insert({
        table: 'warehouse_analysis_coverage_v1',
        format: 'JSONEachRow',
        values: [
          {
            website_id: legacySite,
            epoch: 0,
            control: 'legacy',
            publication: 9,
            checkpoint: randomUUID(),
            browser: '[]',
            log: '[]',
          },
        ],
      });
      for (const query of warehouseAnalysisDDL) await ch.command({ query });
      expect(
        await ch
          .query({
            query:
              'SELECT toString(browser_publication) AS browser,toString(log_publication) AS log FROM warehouse_analysis_coverage_v1 WHERE website_id={site:UUID}',
            query_params: { site: legacySite },
            format: 'JSONEachRow',
          })
          .then(r => r.json()),
      ).toEqual([{ browser: '9', log: '9' }]);
      const f = reportFixture(ch);
      harness.metadata = f.metadata;
      const ids = Array.from({ length: 1200 }, () => randomBytes(32).toString('hex'));
      const fields = ids.map((id, i) => ({
        id,
        created_at: `2026-11-01T0${i % 3}:10:00Z`,
        path: `/page/${i}`,
        status: 200,
        method: 'GET',
        ai_eligible: false,
        import_id: randomUUID(),
        bytes: 0,
        ip_masked: '',
        ip_hash: '',
        user_agent: 'fixture',
        location: '',
        bot: '',
        vendor: '',
        bot_type: '',
        verification: '',
      }));
      await f.put('liekan_log', fields);
      const partialHour = await withinWarehouseReport(() =>
        prepareAnalysisModel(
          f.site,
          new Date('2026-11-01T00:00:00Z'),
          new Date('2026-11-01T00:30:00Z'),
          {
            kinds: ['log'],
            completeThrough: Date.parse('2026-11-01T00:30:00Z'),
          },
        ),
      );
      expect(partialHour.log).toEqual([]);
      // A real CH insert can succeed even when its response is lost. Restart
      // from serialized stage state and verify that the immutable build is
      // reused, with no duplicate append or unverified coverage.
      let savedBuild: any = null,
        savedPrepared: any;
      const buildStore = {
        current: () => structuredClone(savedBuild),
        save: async (value: any) => {
          savedBuild = JSON.parse(JSON.stringify(value));
        },
        notBefore: () => 0,
        deferUntil: async () => {},
      };
      const command = ch.command.bind(ch);
      let lost = false,
        appends = 0;
      const authoritativeReads: string[] = [];
      const sourceQuery = ch.query.bind(ch);
      const sourceReads = vi.spyOn(ch, 'query').mockImplementation(options => {
        if (options.query.includes('{modelWindowHours:')) authoritativeReads.push('read');
        return sourceQuery(options);
      });
      const writesLogTarget = (options: {
        query: string;
        query_params?: Record<string, unknown>;
      }) =>
        options.query.startsWith('INSERT INTO warehouse_analysis_log_v1') &&
        options.query_params?.writeBuild !== options.query_params?.modelSourceBuild;
      const commandSpy = vi.spyOn(ch, 'command').mockImplementation(async options => {
        if (options.query.includes('{modelWindowHours:')) authoritativeReads.push('write');
        const reply = await command(options);
        if (writesLogTarget(options)) {
          appends++;
          if (!lost) {
            lost = true;
            throw new Error('fixture-response-lost');
          }
        }
        return reply;
      });
      const prepare = (background = false) =>
        withinWarehouseReport(
          () =>
            prepareAnalysisModel(
              f.site,
              new Date('2026-11-01T00:00:00Z'),
              new Date('2026-11-01T01:00:00Z'),
              {
                kinds: ['log'],
                buildStore,
                prepared: savedPrepared,
                onCheckpoint: async value => {
                  savedPrepared = JSON.parse(JSON.stringify(value));
                },
              },
            ),
          { background },
        );
      await expect(prepare()).rejects.toThrow('fixture-response-lost');
      expect(savedBuild.intent).toBe('facts');
      const buildId = savedBuild.id;
      const verify = vi.spyOn(ch, 'query');
      verify.mockClear();
      try {
        harness.reader.db = {
          read: async () => [{ oldestMs: 7000, publishedP95Ms: null, samples: 0 }],
        };
        await expect(prepare(true)).rejects.toThrow('warehouse-background-deferred');
        expect(savedBuild).toBeNull();
        expect(savedPrepared.log.some(bucket => bucket[1] === buildId)).toBe(true);
        await prepare();
        const targetReads = verify.mock.calls.filter(
          ([options]) =>
            options.query.includes('FROM warehouse_analysis_log_v1 WHERE') &&
            options.query.includes('_build={modelBuild:UUID}') &&
            options.query.includes(' AS checksum'),
        );
        expect(targetReads).toHaveLength(1);
      } finally {
        harness.reader.db = {};
        verify.mockRestore();
      }
      expect(savedBuild).toBeNull();
      expect(appends).toBe(1);
      expect(authoritativeReads).toHaveLength(1);
      sourceReads.mockRestore();
      const rows = await ch
        .query({
          query:
            'SELECT count() AS n,uniqExact(id) AS unique FROM warehouse_analysis_log_v1 WHERE _build={id:UUID}',
          query_params: { id: buildId },
          format: 'JSONEachRow',
        })
        .then(r => r.json<{ n: string; unique: string }>());
      expect(rows).toEqual([{ n: '400', unique: '400' }]);
      commandSpy.mockRestore();
      let partialBuild: string | undefined;
      const partial = vi.spyOn(ch, 'command').mockImplementation(async options => {
        if (!partialBuild && writesLogTarget(options)) {
          partialBuild = String(options.query_params.modelBuild);
          await command({ ...options, query: options.query + ' LIMIT 10' });
          throw new Error('fixture-partial-write');
        }
        return command(options);
      });
      const prepareSecond = () =>
        withinWarehouseReport(() =>
          prepareAnalysisModel(
            f.site,
            new Date('2026-11-01T01:00:00Z'),
            new Date('2026-11-01T02:00:00Z'),
            {
              kinds: ['log'],
              buildStore,
              prepared: savedPrepared,
              onCheckpoint: async value => {
                savedPrepared = JSON.parse(JSON.stringify(value));
              },
            },
          ),
        );
      await expect(prepareSecond()).rejects.toThrow('fixture-partial-write');
      await expect(prepareSecond()).rejects.toThrow('warehouse-analysis-build-unverified');
      expect(savedBuild).toBeNull();
      expect(savedPrepared.log.some(bucket => bucket[1] === partialBuild)).toBe(false);
      await prepareSecond();
      const repaired = savedPrepared.log.find(
        bucket => bucket[0] === +new Date('2026-11-01T01:00:00Z') / 1000,
      );
      expect(repaired[1]).not.toBe(partialBuild);
      expect(repaired[2]).toBe(400);
      partial.mockRestore();
      let interruptedSource = false;
      const partialSource = vi.spyOn(ch, 'command').mockImplementation(async options => {
        if (!interruptedSource && options.query.includes('{modelWindowHours:')) {
          interruptedSource = true;
          await command({ ...options, query: options.query + ' LIMIT 10' });
          throw new Error('fixture-source-response-lost');
        }
        return command(options);
      });
      const thirdHour = +new Date('2026-11-01T02:00:00Z') / 1000;
      const prepareThird = () =>
        withinWarehouseReport(() =>
          prepareAnalysisModel(
            f.site,
            new Date(thirdHour * 1000),
            new Date((thirdHour + 3600) * 1000),
            {
              kinds: ['log'],
              buildStore,
              prepared: savedPrepared,
              onCheckpoint: async value => {
                savedPrepared = JSON.parse(JSON.stringify(value));
              },
            },
          ),
        );
      try {
        await expect(prepareThird()).rejects.toThrow('fixture-source-response-lost');
        expect(savedBuild.intent).toBe('source-facts');
        const abandonedId = savedBuild.id;
        await expect(prepareThird()).rejects.toThrow('warehouse-analysis-build-unverified');
        expect(savedBuild).toBeNull();
        expect(savedPrepared.log.some(bucket => bucket[0] === thirdHour)).toBe(false);
        expect(partialSource.mock.calls.some(([options]) => writesLogTarget(options))).toBe(false);
        await prepareThird();
        const published = savedPrepared.log.find(bucket => bucket[0] === thirdHour);
        expect(published[1]).not.toBe(abandonedId);
        expect(published[2]).toBe(400);
      } finally {
        partialSource.mockRestore();
      }
      // Even with both manifest watermarks at the frozen publication, a log
      // check interrupted after browser readiness must still run on resume.
      let checked: typeof savedPrepared;
      let interruptLogCheck = true;
      const query = ch.query.bind(ch);
      const coverageCheck = vi.spyOn(ch, 'query').mockImplementation(options => {
        if (interruptLogCheck && options.query.includes('AS rows FROM warehouse_analysis_log_v1')) {
          interruptLogCheck = false;
          throw new Error('fixture-log-coverage-interrupted');
        }
        return query(options);
      });
      const checkBothFamilies = () =>
        withinWarehouseReport(() =>
          prepareAnalysisModel(
            f.site,
            new Date('2026-11-01T00:00:00Z'),
            new Date('2026-11-01T01:00:00Z'),
            {
              prepared: checked,
              onCheckpoint: async value => {
                checked = JSON.parse(JSON.stringify(value));
              },
            },
          ),
        );
      try {
        await expect(checkBothFamilies()).rejects.toThrow('fixture-log-coverage-interrupted');
        expect(checked.checkedFamilies).toEqual(['browser']);
        coverageCheck.mockClear();
        await checkBothFamilies();
        expect(checked.checkedFamilies).toEqual(['browser', 'log']);
        const resumedQueries = coverageCheck.mock.calls.map(([options]) => options.query);
        expect(
          resumedQueries.some(sql => sql.includes('FROM warehouse_analysis_coverage_v1 c')),
        ).toBe(false);
        expect(
          resumedQueries.some(sql => sql.includes('AS rows FROM warehouse_analysis_log_v1')),
        ).toBe(true);
      } finally {
        coverageCheck.mockRestore();
      }
      const read = (filter = '', offset = 0) =>
        warehouseReportQuery(
          f.site,
          `SELECT id,path,bot,reporting_crawler_id FROM ${reportingLogRelation(
            {
              immutableTimeWindow: { start: 'logStart', end: 'logEnd', endExclusive: true },
            },
            ['id', 'path', 'bot', 'reporting_crawler_id'],
          )} ${filter} ORDER BY id LIMIT 2000 OFFSET ${offset}`,
          { logStart: '2026-11-01 00:00:00', logEnd: '2026-11-01 03:00:00' },
        );
      await withinWarehouseReport(() =>
        prepareAnalysisModel(
          f.site,
          new Date('2026-11-01T00:00:00Z'),
          new Date('2026-11-01T01:00:00Z'),
        ),
      );
      const check = () =>
        withinWarehouseReport(async () => {
          const expected = await read();
          expect(await withAvailableAnalysisModel(f.site, read)).toEqual(expected);
          const filtered = await read("WHERE bot='reclassified'");
          expect(
            await withAvailableAnalysisModel(f.site, () => read("WHERE bot='reclassified'")),
          ).toEqual(filtered);
          expect(await withAvailableAnalysisModel(f.site, () => read('', 20))).toEqual(
            expected.slice(20),
          );
          // The split HTTP reader must equal the full canonical relation under
          // absent, partial, dirty and complete analysis coverage alike.
          for (const search of ['', 'reclassified', 'no-such-fixture']) {
            const begin = new Date('2026-11-01T00:00:00Z'),
              finish = new Date('2026-11-01T03:00:00Z');
            const metrics = {
              crawlerIdentityScope: 'all' as const,
              crawlerMetricsVersion: 1 as const,
            };
            const spec = await withoutAnalysisRead(() =>
              warehouseLogQuerySpec(begin, finish, 'UTC', metrics, '', search, false, f.site),
            );
            const full = (
              await warehouseReportQuery(
                f.site,
                `SELECT ${warehouseLogDetailColumns(spec.ai)} ${spec.detailBase} ORDER BY created_at DESC,id DESC LIMIT 201`,
                spec.params,
              )
            ).map(warehouseLogDetailRow);
            const page = (number: number, cursor = '', seek: 'after' | 'before' = 'after') =>
              withAvailableAnalysisModel(f.site, () =>
                warehouseLogFacts(
                  f.site,
                  begin,
                  finish,
                  'UTC',
                  number,
                  '',
                  search,
                  cursor,
                  seek,
                  ['recent'],
                  metrics,
                  false,
                  undefined,
                  { cursorScope: 'c'.repeat(64), limit: 101 },
                ),
              );
            const first = await page(1);
            expect(first.recent).toEqual(full.slice(0, 101));
            if (full.length > 101) {
              const second = await page(2, first.nextCursor);
              expect(second.recent).toEqual(full.slice(100, 201));
              const previous = await page(1, second.previousCursor, 'before');
              expect(previous.recent.slice(-100)).toEqual(full.slice(0, 100));
            }
          }
          return expected;
        });
      expect((await check()).length).toBe(1200);
      // New accepted classification replaces the older version before filtering.
      await f.put('liekan_log', [{ ...fields[1], bot: 'reclassified' }]);
      await f.put('liekan_log', [{ ...fields[2], bot: 'reclassified' }], { accepted: false });
      // Evidence is received outside the log window, including a previously covered hour.
      for (const i of [0, 1])
        await f.put('liekan_crawler_evidence', [
          {
            log_id: ids[i],
            crawler_id: 'late-crawler',
            catalog_version: randomUUID(),
            classification_version: 'late-v1',
            identity_evidence: {},
            created_at: '2026-11-12T00:00:00Z',
          },
        ]);
      await f.put('liekan_log', [fields[4]], { deleted: true });
      const mixed = await check();
      expect(mixed).toHaveLength(1199);
      expect(mixed.find((r: any) => r.id === ids[0])).toMatchObject({
        reporting_crawler_id: 'late-crawler',
      });
      expect(mixed.find((r: any) => r.id === ids[1])).toMatchObject({
        bot: 'reclassified',
        reporting_crawler_id: 'late-crawler',
      });
      // Rebuild only hour 0: the remaining two hours must still be authoritative fallback.
      await withinWarehouseReport(() =>
        prepareAnalysisModel(
          f.site,
          new Date('2026-11-01T00:00:00Z'),
          new Date('2026-11-01T01:00:00Z'),
        ),
      );
      expect(await check()).toEqual(mixed);
      await withinWarehouseReport(() =>
        prepareAnalysisModel(
          f.site,
          new Date('2026-11-01T00:00:00Z'),
          new Date('2026-11-01T03:00:00Z'),
        ),
      );
      expect(await check()).toEqual(mixed);
      await withinWarehouseReport(() =>
        withAvailableAnalysisModel(f.site, async () => {
          expect(reportingLogRelation()).not.toContain('warehouse_liekan_crawler_evidence');
          expect(withoutAnalysisRead(() => reportingLogRelation())).toContain(
            'warehouse_liekan_crawler_evidence',
          );
        }),
      );
      // Even an unaccepted older physical candidate prevents the all-source
      // shortcut. It still must not become a visible canonical record.
      await f.put(
        'liekan_log',
        [{ ...fields[0], id: randomUUID(), created_at: '2020-01-01T00:00:00Z' }],
        { accepted: false },
      );
      await withinWarehouseReport(() =>
        withAvailableAnalysisModel(f.site, async () => {
          expect(reportingLogRelation()).toContain('warehouse_liekan_crawler_evidence');
          expect(await read()).toEqual(mixed);
        }),
      );
      const start = new Date('2026-11-01T00:00:00Z'),
        end = new Date('2026-11-01T03:00:00Z');
      const prepared = await withinWarehouseReport(() =>
        prepareAnalysisModel(f.site, start, end, { kinds: ['log'] }),
      );
      await f.put('liekan_log', [
        { ...fields[0], id: randomUUID(), created_at: '2026-11-01T03:50:00Z' },
      ]);
      const cutoff = Date.parse('2026-11-01T03:30:00Z');
      const delayed = await withinWarehouseReport(() =>
        prepareAnalysisModel(f.site, start, new Date(cutoff), {
          kinds: ['log'],
          completeThrough: cutoff,
        }),
      );
      expect(delayed.log).toEqual(prepared.log);
      expect(delayed.publication.log).toBe(f.metadata.boundary.publication);
      const oldLogPublication = prepared.publication.log;
      // Independent browser preparation must not advance the unexamined log family.
      await f.put('liekan_crawler_evidence', [
        {
          log_id: ids[1],
          crawler_id: 'latest-crawler',
          catalog_version: randomUUID(),
          classification_version: 'late-v2',
          identity_evidence: {},
          created_at: '2026-11-13T00:00:00Z',
        },
      ]);
      await f.event({ created_at: '2026-11-01T00:15:00Z' });
      const browserOnly = await withinWarehouseReport(() =>
        prepareAnalysisModel(f.site, start, end, { kinds: ['browser'], prepared }),
      );
      expect(browserOnly.publication.log).toBe(oldLogPublication);
      expect(browserOnly.publication.browser).toBe(f.metadata.boundary.publication);
      expect((await check()).find((r: any) => r.id === ids[1])).toMatchObject({
        reporting_crawler_id: 'latest-crawler',
      });
      await withinWarehouseReport(async () => {
        const querySpy = vi.spyOn(ch, 'query');
        const commandSpy = vi.spyOn(ch, 'command');
        await prepareAnalysisModel(f.site, start, end, { kinds: ['browser'] });
        expect(querySpy.mock.calls.length).toBeGreaterThan(0);
        querySpy.mockClear();
        commandSpy.mockClear();
        const reused = await prepareAnalysisModel(f.site, start, end, {
          kinds: ['browser'],
          prepared: browserOnly,
        });
        expect(reused).toEqual(browserOnly);
        await expect(
          prepareAnalysisModel(f.site, start, end, {
            kinds: ['browser'],
            prepared: {
              ...browserOnly,
              publication: { ...browserOnly.publication, log: '999999999' },
            },
          }),
        ).rejects.toThrow('warehouse-analysis-prepared-boundary');
        await expect(
          prepareAnalysisModel(f.site, start, end, {
            kinds: ['browser'],
            prepared: { ...browserOnly, browser: [[1, randomUUID(), 0, 0]] },
          }),
        ).rejects.toThrow('warehouse-analysis-coverage-invalid');
        expect(querySpy).not.toHaveBeenCalled();
        expect(commandSpy).not.toHaveBeenCalled();
        querySpy.mockRestore();
        commandSpy.mockRestore();
      });
    } finally {
      await ch.close();
      await admin.command({ query: `DROP DATABASE ${database} SYNC` });
      await admin.close();
    }
  },
  120000,
);
it.skipIf(!url)(
  'preserves cross-day visit attribution, qualification and exact metrics while removing unrelated geography',
  async () => {
    expect(url).toBe('http://127.0.0.1:28169');
    const database = `report_plan_${randomUUID().replaceAll('-', '')}`;
    const admin = createWarehouseClient({ url });
    await admin.command({ query: `CREATE DATABASE ${database}` });
    const ch = createWarehouseClient({
      url,
      database,
      clickhouse_settings: { max_threads: 2, max_memory_usage: '1000000000', join_use_nulls: 1 },
    });
    const admission = new ReadAdmission(1);
    harness.reader = { ch, db: {}, admission, verifyIdentity: async () => {} };
    try {
      for (const query of [...warehouseDDL(), ...warehouseAnalysisDDL, warehouseReportRankDDL])
        await ch.command({ query });
      const f = reportFixture(ch);
      harness.metadata = f.metadata;
      await f.put('session', [
        {
          session_id: f.session,
          created_at: '2026-10-31T23:50:00Z',
          country: 'CN',
          region: 'BJ',
          city: 'Beijing',
        },
      ]);
      await f.event({ created_at: '2026-10-31T23:59:50Z', referrer_domain: 'entry.test' });
      const firstPV = await f.event({
        created_at: '2026-11-01T00:00:10Z',
        referrer_domain: 'later.test',
      });
      await f.event({ created_at: '2026-11-01T00:01:10Z', event_type: 2, event_name: 'signup' });
      await f.event({ created_at: '2026-11-01T00:02:10Z' });
      await f.event({ created_at: '2026-11-01T00:03:00Z', visit_id: randomUUID() }, false);
      const start = new Date('2026-11-01T00:00:00Z'),
        end = new Date('2026-11-02T00:00:00Z');
      await withinWarehouseReport(async () => {
        const params = await warehouseBrowserParameters(f.site, start, end, 'UTC');
        const select =
          ' SELECT session_id,visit_id,pv,custom,duration,referrer FROM visits ORDER BY session_id,visit_id';
        const reference = await warehouseReportQuery(
          f.site,
          warehouseVisitsSQL(true, true) + select,
          params,
        );
        const lean = await warehouseReportQuery(
          f.site,
          warehouseVisitsSQL(true, false) + select,
          params,
        );
        expect(lean).toEqual(reference);
        expect(lean).toEqual([
          {
            session_id: f.session,
            visit_id: f.visit,
            pv: '2',
            custom: '1',
            duration: '120',
            referrer: 'entry.test',
          },
        ]);
        const population = await warehouseBrowserPopulation(f.site, start, end, 'UTC', true);
        expect(population).toMatchObject({
          identity: {
            eligibleEvents: 4,
            eligiblePV: 3,
            qualifiedPV: 2,
            qualifiedVisitors: 1,
            status: 'partial',
          },
        });
        const facts = await warehouseBrowserFacts(
          f.site,
          start,
          end,
          'UTC',
          ['daily', 'geo', 'sources', 'environment', 'pages', 'heatmap'],
          { halfOpen: true },
        );
        expect(facts.sources[0]).toMatchObject({
          referrer: 'entry.test',
          pv: 2,
          sessions: 1,
          bounces: 0,
        });
        expect(facts.geo[0]).toMatchObject({ country: 'CN', sessions: 1 });
        await prepareAnalysisModel(f.site, new Date('2026-10-31T23:00:00Z'), end);
        await withAvailableAnalysisModel(
          f.site,
          async () => {
            expect(currentAnalysisRead().log).toEqual([]);
            expect(currentAnalysisRead().browser.every(b => b[0] * 1000 >= +start)).toBe(true);
            expect(currentAnalysisRead().browser.length).toBeGreaterThan(0);
            // A covered query window alone cannot discard the prior-day entry.
            expect(warehouseVisitsSQL()).toContain('warehouse_liekan_event_environment');
            const scoped = warehouseVisitsSQL(true, true, { start: +start, end: +end });
            expect(scoped).not.toContain('warehouse_liekan_event_environment');
            expect(scoped).not.toContain('warehouse_website_event');
            expect(await warehouseReportQuery(f.site, scoped + select, params)).toEqual(reference);
            expect(
              (await warehouseBrowserFacts(f.site, start, end, 'UTC', ['geo'], { halfOpen: true }))
                .geo,
            ).toEqual(facts.geo);
          },
          { kinds: ['browser'], start: +start, end: +end },
        );
        const modelQuery = vi.spyOn(harness.reader.ch, 'query');
        const oldEnabled = process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS;
        process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS = '0';
        await prepareAnalysisModel(f.site, start, end);
        expect(modelQuery).not.toHaveBeenCalled();
        if (oldEnabled === undefined) delete process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS;
        else process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS = oldEnabled;
        modelQuery.mockRestore();
        const rawTotals = await warehouseBrowserTotals(f.site, start, end, 'UTC');
        const fromModel = await withAvailableAnalysisModel(f.site, () => {
          // All physical event hours, including the prior-day entry, are covered.
          // The accepted model must avoid initializing the empty raw joins.
          expect(warehouseVisitsSQL()).not.toContain('warehouse_liekan_event_environment');
          expect(warehouseVisitsSQL(true, true)).not.toContain('warehouse_liekan_event_geography');
          expect(withoutAnalysisRead(() => warehouseVisitsSQL())).toContain(
            'warehouse_liekan_event_environment',
          );
          // A copied/persisted manifest cannot carry the runtime proof into another scope.
          expect(
            withAnalysisRead(structuredClone(currentAnalysisRead()), () => warehouseVisitsSQL()),
          ).toContain('warehouse_liekan_event_environment');
          return warehouseBrowserFacts(
            f.site,
            start,
            end,
            'UTC',
            ['daily', 'geo', 'sources', 'environment', 'pages', 'heatmap'],
            { halfOpen: true },
          );
        });
        expect(fromModel).toEqual(facts);
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserTotals(f.site, start, end, 'UTC'),
          ),
        ).toEqual(rawTotals);
        const counts = await warehouseReportQuery<{ count: string }>(
          f.site,
          'SELECT count() AS count FROM warehouse_analysis_coverage_v1',
        );
        await prepareAnalysisModel(f.site, new Date('2026-10-31T23:00:00Z'), end);
        expect(
          await warehouseReportQuery(
            f.site,
            'SELECT count() AS count FROM warehouse_analysis_coverage_v1',
          ),
        ).toEqual(counts);
      });
      const laterPV = await f.event({ created_at: '2026-11-01T01:01:00Z' });
      await withinWarehouseReport(async () => {
        const expected = await warehouseBrowserTotals(f.site, start, end, 'UTC');
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserTotals(f.site, start, end, 'UTC'),
          ),
        ).toEqual(expected);
        await prepareAnalysisModel(f.site, new Date('2026-10-31T23:00:00Z'), end);
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserTotals(f.site, start, end, 'UTC'),
          ),
        ).toEqual(expected);
        expect(expected).toMatchObject({
          pageviews: 3,
          visitors: 1,
          visits: 1,
          bounces: 0,
          totaltime: 3650,
        });
      });
      // A classification update invalidates every hour of the affected visit.
      await f.put('liekan_event_environment', [
        {
          event_id: firstPV,
          scope: 'browser_unresolved',
          identity_available: false,
          identity_version: 'fixture',
          created_at: '2026-11-01T00:00:10Z',
        },
      ]);
      await withinWarehouseReport(async () => {
        const expected = await warehouseBrowserTotals(f.site, start, end, 'UTC');
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserTotals(f.site, start, end, 'UTC'),
          ),
        ).toEqual(expected);
        await prepareAnalysisModel(f.site, new Date('2026-10-31T23:00:00Z'), end);
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserTotals(f.site, start, end, 'UTC'),
          ),
        ).toEqual(expected);
        for (const [a, b, tz] of [
          ['2026-11-01T00:00:30Z', '2026-11-01T01:01:00Z', 'Asia/Shanghai'],
          ['2026-11-01T00:00:00Z', '2026-11-01T00:59:59.999Z', 'America/New_York'],
        ]) {
          const x = new Date(a),
            y = new Date(b);
          expect(
            await withAvailableAnalysisModel(f.site, () =>
              warehouseBrowserTotals(f.site, x, y, tz),
            ),
          ).toEqual(await warehouseBrowserTotals(f.site, x, y, tz));
        }
        const snapshot = randomUUID();
        const original = Array.from({ length: 103 }, (_, i) => ({
          path: `/page/${i}`,
          pv: 103 - i,
        }));
        const captured = await captureReportRankings(f.site, snapshot, async () => {
          await recordReportRanking({ meta: {} } as any, 'topBody', original);
          return 'done';
        });
        expect(
          (await readReportRanking(f.site, snapshot, captured.rankings, 'topBody', 4, 20, 103))
            .rows,
        ).toEqual(original.slice(60, 80));
        expect(
          (await readReportRanking(f.site, snapshot, captured.rankings, 'topBody', 7, 20, 103))
            .rows,
        ).toEqual([]);
        await expect(
          readReportRanking(f.site, randomUUID(), captured.rankings, 'topBody', 1, 20, 103),
        ).rejects.toMatchObject({ status: 409, code: 'overview-version-invalidated' });
        const large = Array.from({ length: 1503 }, (_, i) => ({
          path: `/rank/${i}`,
          pv: 1503 - i,
        }));
        const rankId = randomUUID(),
          roundId = randomUUID();
        const produce = async () => {
          await recordReportRanking({ meta: {} } as any, 'topBody', large);
          return { cards: [{ value: 1503 }] };
        };
        let progress = await captureReportRankings(f.site, rankId, produce, {
          round: roundId,
          byteBudget: 1024,
        });
        expect(progress.value.cards[0].value).toBe(1503);
        expect(progress.rankings).toMatchObject({
          pending: true,
          counts: { topBody: 500 },
          totals: { topBody: 1503 },
        });
        expect(rankingPageReady(progress.rankings, 'topBody', 1, 20, 1503)).toBe(true);
        expect(rankingPageReady(progress.rankings, 'topBody', 30, 20, 1503)).toBe(false);
        const command = ch.command.bind(ch);
        let once = false;
        const interruptedRank = vi.spyOn(ch, 'command').mockImplementation(async args => {
          const result = await command(args);
          if (!once && args.query.startsWith('INSERT INTO warehouse_report_rank_v1')) {
            once = true;
            throw Error('rank-response-lost');
          }
          return result;
        });
        await expect(
          captureReportRankings(f.site, rankId, produce, {
            round: roundId,
            previous: progress.rankings,
            byteBudget: 1024,
          }),
        ).rejects.toThrow('rank-response-lost');
        interruptedRank.mockRestore();
        for (let i = 0; i < 3; i++)
          progress = await captureReportRankings(f.site, rankId, produce, {
            round: roundId,
            previous: progress.rankings,
            byteBudget: 1024,
          });
        expect(progress.rankings.pending).toBe(false);
        const pausedRank = randomUUID();
        const pause = await captureReportRankings(f.site, pausedRank, produce, {
          round: roundId,
          shouldPause: async () => true,
        });
        expect(pause.rankings).toMatchObject({ pending: true, counts: { topBody: 0 } });
        const resumed = await captureReportRankings(f.site, pausedRank, produce, {
          round: roundId,
          previous: pause.rankings,
          shouldPause: async () => false,
        });
        expect(resumed.rankings).toMatchObject({ pending: false, build: pause.rankings.build });
        expect(
          (await readReportRanking(f.site, pausedRank, resumed.rankings, 'topBody', 30, 20, 1503))
            .rows,
        ).toEqual(large.slice(580, 600));
        expect(
          (await readReportRanking(f.site, rankId, progress.rankings, 'topBody', 30, 20, 1503))
            .rows,
        ).toEqual(large.slice(580, 600));
        await expect(
          captureReportRankings(f.site, rankId, produce, {
            round: randomUUID(),
            previous: progress.rankings,
          }),
        ).rejects.toThrow('warehouse-ranking-resume-boundary');
      });
      const ids = [randomUUID(), randomUUID()];
      await f.put(
        'liekan_log',
        ids.map((id, i) => ({
          id,
          created_at: `2026-11-01T0${i}:10:00Z`,
          path: `/log/${i}`,
          status: 200,
          method: 'GET',
          ai_eligible: false,
          import_id: randomUUID(),
          bytes: 0,
          ip_masked: '',
          ip_hash: '',
          user_agent: 'fixture',
          location: '',
          bot: '',
          vendor: '',
          bot_type: '',
          verification: '',
        })),
      );
      await withinWarehouseReport(async () => {
        await prepareAnalysisModel(f.site, new Date('2026-10-31T23:00:00Z'), end);
        const read = () =>
          warehouseReportQuery(
            f.site,
            `SELECT id,path FROM ${reportingLogRelation({ immutableTimeWindow: { start: 'logStart', end: 'logEnd', endExclusive: true, hours: 'logHours' } }, ['id', 'path'])} ORDER BY id`,
            {
              logStart: '2026-11-01 00:00:00',
              logEnd: '2026-11-01 01:00:00',
              logHours: [1793491200],
            },
          );
        const expected = await read();
        expect(expected).toEqual([{ id: ids[0], path: '/log/0' }]);
        expect(await withAvailableAnalysisModel(f.site, read)).toEqual(expected);
      });
      // Only accepted attempts affect facts; an interrupted model publication is retryable.
      await f.event({ created_at: '2026-11-01T01:20:00Z' });
      const realCommand = ch.command.bind(ch);
      let interrupted = false;
      const fail = vi.spyOn(ch, 'command').mockImplementation(async args => {
        if (!interrupted && args.query.startsWith('INSERT INTO warehouse_analysis_coverage_v1')) {
          interrupted = true;
          throw new Error('fixture-interrupted-publication');
        }
        return realCommand(args);
      });
      await expect(
        withinWarehouseReport(() => prepareAnalysisModel(f.site, start, end)),
      ).rejects.toThrow('fixture-interrupted-publication');
      fail.mockRestore();
      await withinWarehouseReport(async () => {
        const raw = await warehouseBrowserTotals(f.site, start, end, 'UTC');
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserTotals(f.site, start, end, 'UTC'),
          ),
        ).toEqual(raw);
        await prepareAnalysisModel(f.site, start, end);
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserTotals(f.site, start, end, 'UTC'),
          ),
        ).toEqual(raw);
      });
      const accepted = f.metadata.boundary.publication;
      await f.put(
        'website_event',
        [
          {
            event_id: randomUUID(),
            session_id: f.session,
            visit_id: f.visit,
            event_type: 1,
            url_path: '/fixture',
            created_at: '2026-11-01T00:15:00Z',
          },
        ],
        { accepted: false },
      );
      expect(f.metadata.boundary.publication).toBe(accepted);
      await f.put('session', [
        {
          session_id: f.session,
          created_at: '2026-10-31T23:50:00Z',
          country: 'US',
          region: 'CA',
          city: 'San Francisco',
        },
      ]);
      await withinWarehouseReport(async () => {
        const fields = ['geo', 'sources', 'environment'] as const;
        const raw = await warehouseBrowserFacts(f.site, start, end, 'UTC', fields);
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserFacts(f.site, start, end, 'UTC', fields),
          ),
        ).toEqual(raw);
        await prepareAnalysisModel(f.site, start, end);
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserFacts(f.site, start, end, 'UTC', fields),
          ),
        ).toEqual(raw);
      });
      // Repair results are inert until their generation is activated. Activation
      // and exclusion changes invalidate a model even without new event facts.
      const repairRun = randomUUID(),
        repairGeneration = randomUUID();
      const coverageCount = () =>
        withinWarehouseReport(() =>
          warehouseReportQuery(f.site, 'SELECT count() AS n FROM warehouse_analysis_coverage_v1'),
        );
      const coverageBeforeRepair = await coverageCount();
      await f.put('liekan_history_repair_result', [
        {
          run_id: repairRun,
          generation: repairGeneration,
          kind: 'event',
          record_id: laterPV,
          before_value: { classification: 'browser' },
          after_value: { classification: 'automated', reasons: [], ruleVersion: 'fixture-v2' },
          proof: {},
          issue: null,
          created_at: '2026-11-01T02:00:00Z',
        },
      ]);
      const beforeRepair = await withinWarehouseReport(() =>
        warehouseBrowserTotals(f.site, start, end, 'UTC'),
      );
      await withinWarehouseReport(async () => {
        await prepareAnalysisModel(f.site, start, end);
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserTotals(f.site, start, end, 'UTC'),
          ),
        ).toEqual(beforeRepair);
      });
      expect(await coverageCount()).toEqual(coverageBeforeRepair);
      f.metadata.repairRunId = repairRun;
      f.metadata.repairGeneration = repairGeneration;
      const afterRepair = await withinWarehouseReport(() =>
        warehouseBrowserTotals(f.site, start, end, 'UTC'),
      );
      expect(afterRepair).toHaveProperty('pageviews', (beforeRepair as any).pageviews - 1);
      await withinWarehouseReport(async () => {
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserTotals(f.site, start, end, 'UTC'),
          ),
        ).toEqual(afterRepair);
        await prepareAnalysisModel(f.site, start, end);
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserTotals(f.site, start, end, 'UTC'),
          ),
        ).toEqual(afterRepair);
      });
      const excludedId = await f.event({
        created_at: '2026-11-01T02:01:00Z',
        visit_id: randomUUID(),
      });
      const collection = randomUUID();
      await f.put('liekan_traffic_exclusion_member', [
        { collection_id: collection, event_id: excludedId },
      ]);
      const beforeExclusion = await withinWarehouseReport(() =>
        warehouseBrowserTotals(f.site, start, end, 'UTC'),
      );
      f.metadata.exclusions = [collection];
      await withinWarehouseReport(async () => {
        const expected = await warehouseBrowserTotals(f.site, start, end, 'UTC');
        expect(expected).toHaveProperty('pageviews', (beforeExclusion as any).pageviews - 1);
        await prepareAnalysisModel(f.site, start, end);
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserTotals(f.site, start, end, 'UTC'),
          ),
        ).toEqual(expected);
      });
      // A tombstone is a new accepted version, not an additive aggregate update.
      await f.put(
        'website_event',
        [
          {
            event_id: firstPV,
            session_id: f.session,
            visit_id: f.visit,
            event_type: 1,
            url_path: '/fixture',
            created_at: '2026-11-01T00:00:10Z',
          },
        ],
        { deleted: true },
      );
      await withinWarehouseReport(async () => {
        const raw = await warehouseBrowserTotals(f.site, start, end, 'UTC');
        await prepareAnalysisModel(f.site, start, end);
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserTotals(f.site, start, end, 'UTC'),
          ),
        ).toEqual(raw);
      });
      // Separate contexts force the old independent dimension queries; compare
      // grouping sets against them including null dimensions and tied counts.
      for (const referrer of [null, '', 'z.test', 'a.test']) {
        const event = await f.event({
          created_at: '2026-11-01T03:01:00Z',
          visit_id: randomUUID(),
          referrer_domain: referrer,
        });
        if (!referrer)
          await f.put('liekan_event_environment', [
            {
              event_id: event,
              scope: 'browser',
              identity_available: true,
              identity_version: 'fixture',
              browser: null,
              os: null,
              device: null,
              created_at: '2026-11-01T03:01:00Z',
            },
          ]);
      }
      const groupedFields = ['sources', 'geo', 'environment', 'heatmap'];
      const separate = Object.assign(
        {},
        ...(await Promise.all(
          groupedFields.map(field =>
            withinWarehouseReport(() => warehouseBrowserFacts(f.site, start, end, 'UTC', [field])),
          ),
        )),
      );
      await withinWarehouseReport(async () => {
        expect(await warehouseBrowserFacts(f.site, start, end, 'UTC', groupedFields)).toEqual(
          separate,
        );
        await prepareAnalysisModel(f.site, start, end);
        expect(
          await withAvailableAnalysisModel(f.site, () =>
            warehouseBrowserFacts(f.site, start, end, 'UTC', groupedFields),
          ),
        ).toEqual(separate);
      });
      // Unrelated retained history must not force a complete-window query back
      // through raw joins, or alter current-window entry/quality/counts.
      await f.event({
        created_at: '2026-08-01T01:00:00Z',
        visit_id: randomUUID(),
        session_id: randomUUID(),
      });
      await withinWarehouseReport(async () => {
        await prepareAnalysisModel(f.site, start, end);
        await withAvailableAnalysisModel(
          f.site,
          async () => {
            expect(warehouseVisitsSQL()).toContain('warehouse_website_event');
            expect(warehouseVisitsSQL(true, false, { start: +start, end: +end })).not.toContain(
              'warehouse_website_event',
            );
            expect(await warehouseBrowserFacts(f.site, start, end, 'UTC', groupedFields)).toEqual(
              separate,
            );
          },
          { kinds: ['browser'], start: +start, end: +end },
        );
      });
      // A null timestamp has no covered hour. Never infer completeness merely
      // from the non-null min/max or the requested window's coverage.
      await f.put(
        'website_event',
        [
          {
            event_id: randomUUID(),
            session_id: f.session,
            visit_id: f.visit,
            event_type: 1,
            url_path: '/unknown-time',
            created_at: null,
          },
        ],
        { accepted: false },
      );
      await withinWarehouseReport(() =>
        withAvailableAnalysisModel(f.site, async () => {
          expect(warehouseVisitsSQL()).toContain('warehouse_liekan_event_environment');
          expect(await warehouseBrowserFacts(f.site, start, end, 'UTC', groupedFields)).toEqual(
            separate,
          );
        }),
      );
      f.metadata.boundary.epoch = '1';
      await withinWarehouseReport(async () => {
        const cleared = await withAvailableAnalysisModel(f.site, () =>
          warehouseBrowserTotals(f.site, start, end, 'UTC'),
        );
        expect((cleared as any).pageviews).toBe(0);
      });
    } finally {
      admission.close();
      await ch.close();
      await admin.command({ query: `DROP DATABASE ${database} SYNC` });
      await admin.close();
    }
  },
  90000,
);
