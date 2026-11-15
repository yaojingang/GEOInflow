// @vitest-environment node
import { randomUUID, randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { reportFixture } from '../../../../tests/liekan/report-plan-fixture';
import {
  currentAnalysisRead,
  withAnalysisRead,
  withoutAnalysisRead,
} from '../warehouse/analysis-context';
import { createWarehouseClient } from '../warehouse/client';
import { ReadAdmission } from '../warehouse/read-admission';
import { reportingLogRelation } from '../warehouse/reporting-relations';
import { warehouseAnalysisDDL, warehouseDDL, warehouseReportRankDDL } from '../warehouse/schema';
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

import { prepareAnalysisModel, withAvailableAnalysisModel } from './warehouse-analysis-model';
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
} from './warehouse-log-queries';
import { warehouseReportQuery, withinWarehouseReport } from './warehouse-report-snapshot';

const url = process.env.LIEKAN_REPORT_PLAN_CH_URL;
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
