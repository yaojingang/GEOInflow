// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { reportFixture } from '../../../../tests/liekan/report-plan-fixture';
import { createWarehouseClient } from '../warehouse/client';
import { ControlDatabase } from '../warehouse/control-db';
import { ReadAdmission } from '../warehouse/read-admission';
import {
  warehouseAnalysisDDL,
  warehouseDDL,
  warehouseLogTrendDDL,
  warehouseOverviewLogDDL,
  warehouseReportRankDDL,
} from '../warehouse/schema';

const harness = vi.hoisted(() => ({ reader: undefined as any }));
vi.mock('../warehouse/reader-runtime', () => ({ warehouseReader: () => harness.reader }));
const enabled = process.env.LIEKAN_REPORT_PLAN_PAGES === '1';
it.skipIf(!enabled)(
  'compares aggregate pages, full ranking artifacts and native retention on a fresh small PG/CH fixture',
  async () => {
    const run = `report_pages_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client('postgresql://postgres@127.0.0.1:25489/postgres');
    await admin.connect();
    await admin.query(`CREATE DATABASE ${run}`);
    const url = `postgresql://postgres@127.0.0.1:25489/${run}`;
    const db = new ControlDatabase(url);
    const chAdmin = createWarehouseClient({ url: 'http://127.0.0.1:28169' });
    await chAdmin.command({ query: `CREATE DATABASE ${run}` });
    const ch = createWarehouseClient({
      url: 'http://127.0.0.1:28169',
      database: run,
      clickhouse_settings: { max_threads: 2, max_memory_usage: '1000000000', join_use_nulls: 1 },
    });
    const admission = new ReadAdmission(1);
    harness.reader = {
      db,
      ch,
      exportCH: ch,
      admission,
      exportAdmission: admission,
      verifyIdentity: async () => {},
    };
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('DATABASE_REPLICA_URL', '');
    vi.stubEnv('CLICKHOUSE_URL', '');
    vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'clickhouse');
    vi.stubEnv('LIEKAN_WAREHOUSE_TRANSITION', 'false');
    let prisma: any;
    await mkdir('.local/report-plan-validation', { recursive: true });
    const record = async (value: unknown) =>
      appendFile(
        '.local/report-plan-validation/pages.jsonl',
        JSON.stringify({ run, ...(value as any) }) + '\n',
        { mode: 0o600 },
      );
    try {
      for (const name of (await readdir('prisma/migrations')).filter(n => /^\d/.test(n)).sort())
        await db.read(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'));
      await db.read(
        'CREATE TABLE liekan_migration(name text PRIMARY KEY,checksum varchar(64) NOT NULL,applied_at timestamptz DEFAULT now())',
      );
      for (const name of (await readdir('db/liekan/migrations'))
        .filter(n => /^\d.*\.sql$/.test(n))
        .sort()) {
        const sql = await readFile(`db/liekan/migrations/${name}`, 'utf8');
        await db.read(sql);
        await db.read('INSERT INTO liekan_migration(name,checksum) VALUES($1,$2)', [
          name,
          createHash('sha256').update(sql).digest('hex'),
        ]);
      }
      for (const query of [
        ...warehouseDDL(),
        ...warehouseAnalysisDDL,
        warehouseReportRankDDL,
        warehouseLogTrendDDL,
        ...warehouseOverviewLogDDL,
      ])
        await ch.command({ query });
      const f = reportFixture(ch);
      await db.read(
        "INSERT INTO website(website_id,name,domain) VALUES($1,'Small report fixture','fixture.test')",
        [f.site],
      );
      await db.read('INSERT INTO liekan_warehouse_site(website_id) VALUES($1)', [f.site]);
      await db.read('INSERT INTO liekan_setting(website_id,ai_crawler_enabled) VALUES($1,true)', [
        f.site,
      ]);
      await db.read(
        "INSERT INTO liekan_collection_policy(website_id,allowed_hostnames) VALUES($1,ARRAY['fixture.test'])",
        [f.site],
      );
      await f.put('session', [
        {
          session_id: f.session,
          created_at: '2026-11-13T23:59:00Z',
          country: 'CN',
          region: 'BJ',
          city: 'Beijing',
          browser: 'Chrome',
        },
      ]);
      // An unrelated old visit must not force short-window native totals back
      // to canonical all-history joins after the 64-day model window has moved.
      const oldSession = randomUUID();
      await f.put('session', [{ session_id: oldSession, created_at: '2026-08-01T00:00:00Z' }]);
      await f.event({
        session_id: oldSession,
        visit_id: randomUUID(),
        created_at: '2026-08-01T00:00:00Z',
      });
      // More than three pages, encoded aliases, repeat visitors and unknown identity.
      for (let i = 0; i < 65; i++)
        await f.event(
          {
            created_at: `2026-11-14T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
            hostname: 'fixture.test',
            url_path: i === 0 ? '/encoded/%E4%B8%AD' : `/page/${i}`,
            visit_id: randomUUID(),
            referrer_domain: i % 2 ? 'chatgpt.com' : 'source.test',
          },
          i !== 64,
        );
      await f.event({
        created_at: '2026-11-13T23:59:30Z',
        hostname: 'fixture.test',
        referrer_domain: 'entry.test',
      });
      await f.event({
        created_at: '2026-11-14T00:05:30Z',
        hostname: 'fixture.test',
        event_type: 2,
        event_name: 'signup',
      });
      const batch = randomUUID();
      await db.read(
        'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1,$2,$3,65,0)',
        [batch, f.site, '0'.repeat(64)],
      );
      await f.put(
        'liekan_log',
        Array.from({ length: 65 }, (_, i) => ({
          id: randomUUID(),
          import_id: batch,
          created_at: '2026-11-14T00:10:00Z',
          path: `/page/${i}`,
          method: 'GET',
          status: 200,
          bytes: 1,
          ip_masked: 'synthetic',
          ip_hash: '8'.repeat(64),
          user_agent: 'SyntheticAiPage',
          location: 'unknown',
          bot: 'GPTBot',
          vendor: 'OpenAI',
          bot_type: '训练',
          verification: 'verified_range',
          source_id: null,
          ai_eligible: true,
          recognition_state: 'recognized',
        })),
      );
      await db.read('UPDATE liekan_warehouse_site SET publication=$2 WHERE website_id=$1', [
        f.site,
        f.metadata.boundary.publication,
      ]);
      prisma = (await import('@/lib/prisma')).default;
      const { initializeCrawlerRegistry, withPublishedRegistry } = await import(
        './crawler-registry-context'
      );
      await initializeCrawlerRegistry();
      const { parseReportQuery } = await import('../contracts/query');
      const { buildReport } = await import('../report');
      const { prepareWarehousePageReport } = await import('./warehouse-page-report');
      const { withinWarehouseReport } = await import('./warehouse-report-snapshot');
      const { withoutQueryCache } = await import('./cache-context');
      const { prepareAnalysisModel, withAvailableAnalysisModel } = await import(
        './warehouse-analysis-model'
      );
      const { captureReportRankings, readReportRanking } = await import(
        './report-ranking-artifact'
      );
      const { scheduledReportResources } = await import('../contracts/scheduled-reports');
      const website = { id: f.site, name: 'Small report fixture', domain: 'fixture.test' };
      const start = +new Date('2026-10-15T00:00:00Z'),
        end = +new Date('2026-11-14T01:00:00Z');
      const work = <T>(fn: () => Promise<T>) =>
        withoutQueryCache(() => withPublishedRegistry(() => withinWarehouseReport(fn)));
      const normalize = (v: any) =>
        JSON.parse(
          JSON.stringify(v, (key, value) =>
            ['generatedAt', 'expiresAt'].includes(key) ? undefined : value,
          ),
        );
      // A registered path participates in preference; an uncatalogued path still
      // contributes to the site-wide summary and bot totals.
      await db.read(
        `INSERT INTO liekan_catalog(website_id,path,title,content_type,word_count,structure_score)
         VALUES($1,'/page/0','Registered page','article',400,75),
               ($1,'/unseen','Unseen page','interactive',600,50)`,
        [f.site],
      );
      const preference = parseReportQuery({
        resource: 'ai/preference',
        startAt: start,
        endAt: end,
        timezone: 'UTC',
        chartPeriod: '30d',
        crawlerMetricsVersion: 1,
      });
      if (!preference.success) throw new Error('fixture-preference-parameters');
      await work(async () => {
        const regular = await buildReport(website, false, preference.data, true);
        const unbounded = await buildReport(website, false, preference.data, true, true);
        expect(regular.cards).toEqual(unbounded.cards);
        expect(regular.charts).toEqual(unbounded.charts);
        expect(regular.insights).toEqual(unbounded.insights);
        expect(regular.tables.prefList).toEqual(unbounded.tables.prefList);
        expect(regular.tables.pathList).toEqual(unbounded.tables.pathList);
        expect(regular.charts.pf2.rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: '/page/0', requests: 1 }),
            expect.objectContaining({ path: '/unseen', requests: 0 }),
          ]),
        );
      });
      await db.read('DELETE FROM liekan_catalog WHERE website_id=$1', [f.site]);
      await work(() => prepareAnalysisModel(f.site, new Date(start), new Date(end)));
      for (const days of process.env.LIEKAN_REPORT_PLAN_ONLY_DETAILS === '1' ? [] : [1, 7, 30, 3])
        for (const resource of scheduledReportResources) {
          const windowStart = end - days * 86400000;
          const p = parseReportQuery({
            resource,
            startAt: windowStart,
            endAt: end,
            timezone: 'UTC',
            chartPeriod: '30d',
            ...(resource.startsWith('ai/') ? { crawlerMetricsVersion: 1 } : {}),
          });
          expect(p.success).toBe(true);
          if (!p.success) throw new Error('fixture-parameters');
          await work(async () => {
            const before = performance.now();
            const raw = await buildReport(website, false, p.data, true);
            const rawMs = performance.now() - before,
              snapshot = randomUUID(),
              started = performance.now();
            const captured = await withAvailableAnalysisModel(f.site, () =>
              captureReportRankings(f.site, snapshot, async () => {
                const prepared = await prepareWarehousePageReport(website, p.data, false);
                try {
                  return await buildReport(
                    website,
                    false,
                    p.data,
                    true,
                    false,
                    undefined,
                    prepared,
                  );
                } finally {
                  await prepared?.dispose?.();
                }
              }),
            );
            const modelMs = performance.now() - started;
            expect(normalize(captured.value)).toEqual(normalize(raw));
            for (const [table, paging] of Object.entries(captured.value.meta.tablePages ?? {})) {
              if (paging.total <= paging.pageSize) continue;
              const page = 4;
              const readAt = performance.now();
              const slice = await readReportRanking(
                f.site,
                snapshot,
                captured.rankings,
                table,
                page,
                paging.pageSize,
                paging.total,
              );
              const readMs = Math.round(performance.now() - readAt);
              const full = await buildReport(
                website,
                false,
                { ...p.data, tablePages: { [table]: page } },
                true,
              );
              expect(slice.rows).toEqual(full.tables[table]);
              await record({ days, resource, table, page, readMs, rows: slice.rows.length });
            }
            await record({
              days,
              resource,
              rawMs: Math.round(rawMs),
              modelMs: Math.round(modelMs),
              events: 67,
              logs: 65,
            });
          });
        }
      const { getRetention, getWebsiteSessions, getRealtimeData, getWebsiteStats } = await import(
        '@/queries/sql'
      );
      const filters = {
        startDate: new Date(end - 86400000),
        endDate: new Date(end - 1),
        timezone: 'UTC',
      };
      const { warehouseRealtimeStats } = await import('./warehouse-realtime');
      const { getPageviewStats } = await import('@/queries/sql/pageviews/getPageviewStats');
      const { getSessionStats } = await import('@/queries/sql/sessions/getSessionStats');
      for (const extra of [
        { unit: 'minute', timezone: 'UTC' },
        { unit: 'hour', timezone: 'Asia/Shanghai' },
        { unit: 'minute', browser: 'eq.Chrome' },
        { unit: 'minute', url: 'eq./page/1' },
        { unit: 'minute', excludeBounce: true },
      ])
        await work(async () => {
          const input = { ...filters, ...extra } as any;
          const [pageviews, sessions, totals] = await Promise.all([
            getPageviewStats(f.site, input),
            getSessionStats(f.site, input),
            getWebsiteStats(f.site, input),
          ]);
          const combined = await warehouseRealtimeStats(f.site, input);
          expect(combined.pageviews).toEqual(pageviews);
          expect(combined.sessions).toEqual(sessions);
          expect(combined.totals).toEqual({
            visitors: totals.visitors,
            population: totals.population,
          });
        });
      for (const [name, read] of [
        ['retention', () => getRetention(f.site, filters, filters)],
        ['sessions', () => getWebsiteSessions(f.site, { ...filters, page: 1, pageSize: 20 })],
        ['realtime', () => getRealtimeData(f.site, filters)],
        ['native-totals', () => getWebsiteStats(f.site, filters)],
      ] as const)
        await work(async () => {
          process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS = '0';
          const raw = await read();
          delete process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS;
          const at = performance.now();
          const queries: string[] = [];
          const originalQuery = ch.query.bind(ch);
          const querySpy = vi.spyOn(ch, 'query').mockImplementation(args => {
            queries.push(args.query);
            return originalQuery(args);
          });
          let actual;
          try {
            actual = await read();
          } finally {
            querySpy.mockRestore();
          }
          if (name === 'native-totals') {
            const totals = queries.find(q => q.includes('sum(t.c)'));
            expect(totals).toBeDefined();
            // Native vocabulary also declares unused property/revenue CTEs.
            // Check the event relation consumed by totals, not unused SQL text.
            const events = totals.slice(0, totals.indexOf(',heatmap_event AS'));
            expect(events).toContain('warehouse_analysis_browser_v1');
            expect(events).not.toContain('warehouse_website_event');
          }
          if (name === 'realtime') {
            expect(typeof (actual as any).timestamp).toBe('number');
            delete (actual as any).timestamp;
            delete (raw as any).timestamp;
          }
          expect(normalize(actual)).toEqual(normalize(raw));
          await record({ resource: name, modelMs: Math.round(performance.now() - at) });
        });
      // A window may extend into an unbuilt hour with no physical facts. Prove
      // that gap at the pinned boundary instead of expanding all-history joins.
      const { nativeRelations } = await import('./warehouse-native-relations');
      const gapWindow = { start: +filters.startDate, end: end + 7200000 };
      const gapFilters = { ...filters, endDate: new Date(gapWindow.end), page: 1, pageSize: 20 };
      let gapExpected: unknown;
      await work(async () => {
        process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS = '0';
        try {
          gapExpected = await getWebsiteSessions(f.site, gapFilters);
        } finally {
          delete process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS;
        }
        await withAvailableAnalysisModel(
          f.site,
          async () => {
            expect(nativeRelations(true, gapWindow)[0]).not.toContain('warehouse_website_event');
            expect(normalize(await getWebsiteSessions(f.site, gapFilters))).toEqual(
              normalize(gapExpected),
            );
          },
          { kinds: ['browser'], ...gapWindow },
        );
      });
      // Even an unaccepted candidate in the gap forbids the shortcut. It remains
      // invisible to analytics; the fallback must still produce the same answer.
      await f.put(
        'website_event',
        [
          {
            event_id: randomUUID(),
            session_id: f.session,
            visit_id: randomUUID(),
            event_type: 1,
            created_at: new Date(end + 3600000).toISOString(),
            url_path: '/unaccepted-gap',
            hostname: 'fixture.test',
          },
        ],
        { accepted: false },
      );
      await work(() =>
        withAvailableAnalysisModel(
          f.site,
          async () => {
            expect(nativeRelations(true, gapWindow)[0]).toContain('warehouse_website_event');
            expect(normalize(await getWebsiteSessions(f.site, gapFilters))).toEqual(
              normalize(gapExpected),
            );
          },
          { kinds: ['browser'], ...gapWindow },
        ),
      );
      await record({
        resource: 'sessions-empty-hour',
        exact: true,
        unacceptedCandidateFallback: true,
      });
      const { readLogEntries, readLogCount, readLogSummary } = await import('./log-read');
      const { warehouseFeatureAnalytics } = await import('./warehouse-feature-analytics');
      await work(async () => {
        const p = {
          kind: 'sessions',
          startAt: +filters.startDate,
          endAt: +filters.endDate,
          timezone: 'UTC',
          page: 1,
        };
        const first = await warehouseFeatureAnalytics(f.site, p, filters);
        expect(first.count).toBe(1);
        expect(first.rows).toHaveLength(1);
        expect(first.rows[0]).not.toHaveProperty('_page_count');
        const empty = await warehouseFeatureAnalytics(f.site, { ...p, page: 2 }, filters);
        expect(empty).toMatchObject({ count: 1, rows: [], page: 2 });
        const nativeEmpty = await getWebsiteSessions(f.site, { ...filters, page: 2, pageSize: 20 });
        expect(nativeEmpty).toMatchObject({ count: 1, data: [], page: 2 });
        const realtime = { ...p, kind: 'realtime', endAt: +new Date('2026-11-14T00:04:00Z') };
        const recent = { ...filters, endDate: new Date(realtime.endAt) };
        process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS = '0';
        const raw = await warehouseFeatureAnalytics(f.site, realtime, recent);
        delete process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS;
        expect(raw.totals.active).toBe(1);
        expect(await warehouseFeatureAnalytics(f.site, realtime, recent)).toEqual(raw);
      });
      const { warehouseNativeStringStream } = await import('./warehouse-native-query');
      await work(async () => {
        const readExport = async () => {
          const rows: Record<string, string | null>[] = [];
          await warehouseNativeStringStream(
            'SELECT toString(event_id) AS eventId,url_path AS path FROM website_event WHERE website_id={websiteId:UUID} AND created_at>={startDate:DateTime64(6)} AND created_at<={endDate:DateTime64(6)} ORDER BY event_id',
            { websiteId: f.site, ...filters },
            async batch => {
              rows.push(...batch);
            },
          );
          return rows;
        };
        process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS = '0';
        const raw = await readExport();
        delete process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS;
        expect(raw.length).toBeGreaterThan(0);
        expect(await readExport()).toEqual(raw);
        await record({ resource: 'native-export', exact: true, rows: raw.length });
      });
      const logParams = { startAt: start, endAt: end, timezone: 'UTC' };
      const entries = await readLogEntries(website, logParams, false);
      expect(entries.tables.logBody.length).toBe(65);
      const readBoundary = entries.meta.logReadBoundary;
      const [count, summary] = await Promise.all([
        readLogCount(f.site, { ...logParams, readBoundary }),
        readLogSummary(f.site, { ...logParams, readBoundary }),
      ]);
      expect(count.total).toBe(65);
      expect(summary.readBoundary).toBe(readBoundary);
      // Advancing accepted facts cannot move a multi-part log read.
      await f.put('liekan_log', [
        {
          id: randomUUID(),
          import_id: batch,
          created_at: '2026-11-14T00:15:00Z',
          path: '/new',
          method: 'GET',
          status: 200,
          bytes: 1,
          ip_masked: 'synthetic',
          ip_hash: '8'.repeat(64),
          user_agent: 'SyntheticAiPage',
          location: 'unknown',
          bot: 'GPTBot',
          vendor: 'OpenAI',
          bot_type: '训练',
          verification: 'verified_range',
          ai_eligible: true,
        },
      ]);
      await db.read('UPDATE liekan_warehouse_site SET publication=$2 WHERE website_id=$1', [
        f.site,
        f.metadata.boundary.publication,
      ]);
      expect((await readLogCount(f.site, { ...logParams, readBoundary })).total).toBe(65);
      await record({ resource: 'logs', boundaryStable: true, count: 65 });
      if (process.env.LIEKAN_REPORT_PLAN_SCHEDULE === '1') {
        const {
          drainWarehouseOverview,
          requestWarehouseOverview,
          readPublishedWebsiteSummaries,
          requestWarehouseRetention,
          readWarehouseOverviewJob,
        } = await import('./warehouse-overview-snapshots');
        const continuous = process.env.LIEKAN_REPORT_PLAN_CONTINUOUS === '1';
        const runRound = async () => {
          const at = performance.now();
          const builds = new Map<string, number>();
          const realCommand = ch.command.bind(ch);
          const commandSpy = vi.spyOn(ch, 'command').mockImplementation(async args => {
            const kind = args.query.match(/^INSERT INTO warehouse_analysis_(browser|log)_v1/)?.[1];
            if (kind && args.query_params?.writeBuild === args.query_params?.modelSourceBuild)
              for (const h of (args.query_params?.modelHours ?? []) as number[]) {
                const key = `${kind}:${h}`;
                builds.set(key, (builds.get(key) ?? 0) + 1);
              }
            return realCommand(args);
          });
          let writing: Promise<void> | undefined,
            writeFailure: unknown,
            appended = 0;
          const timer = continuous
            ? setInterval(() => {
                if (writing || writeFailure) return;
                writing = (async () => {
                  await f.put('liekan_log', [
                    {
                      id: randomUUID(),
                      import_id: randomUUID(),
                      created_at: new Date().toISOString(),
                      method: 'GET',
                      path: '/synthetic-round-append',
                      status: 200,
                      bytes: 1,
                      ip_masked: '',
                      ip_hash: '',
                      user_agent: 'SyntheticRound',
                      location: '',
                      bot: '',
                      vendor: '',
                      bot_type: '',
                      verification: '',
                      ai_eligible: false,
                    },
                  ]);
                  await db.read(
                    'UPDATE liekan_warehouse_site SET publication=$2 WHERE website_id=$1',
                    [f.site, f.metadata.boundary.publication],
                  );
                  appended++;
                })()
                  .catch(e => {
                    writeFailure = e;
                  })
                  .finally(() => {
                    writing = undefined;
                  });
              }, 750)
            : undefined;
          try {
            await drainWarehouseOverview(new AbortController().signal);
          } finally {
            clearInterval(timer);
            await writing;
            commandSpy.mockRestore();
          }
          if (writeFailure) throw writeFailure;
          if (continuous) expect(appended).toBeGreaterThan(0);
          expect(Math.max(0, ...builds.values())).toBeLessThanOrEqual(1);
          return {
            buildMs: Math.round(performance.now() - at),
            appended,
            constructedHours: builds.size,
            maximumBuildsPerHour: Math.max(0, ...builds.values()),
          };
        };
        const firstRound = await runRound();
        const snapshots = await db.read<any>(
          'SELECT id,parameters,generated_at,error_code,publication FROM liekan_warehouse_overview_snapshot WHERE preset',
        );
        expect(snapshots.filter(row => !row.parameters.siteSummary)).toHaveLength(34);
        expect(snapshots.filter(row => row.parameters.siteSummary)).toHaveLength(1);
        expect(snapshots.filter(row => row.parameters.nativeRetention)).toHaveLength(1);
        expect(new Set(snapshots.map(s => s.publication)).size).toBe(1);
        expect(
          snapshots
            .filter(s => !s.generated_at || s.error_code)
            .map(s => ({
              resource: s.parameters.resource,
              period: s.parameters.chartPeriod,
              error: s.error_code,
            })),
        ).toEqual([]);
        const readTimes: number[] = [];
        for (const row of snapshots) {
          const started = performance.now();
          if (row.parameters.siteSummary) {
            const [summary] = await work(() =>
              readPublishedWebsiteSummaries([website.id], row.parameters),
            );
            expect(summary.snapshot?.state).toBe('ready');
            continue;
          }
          const response = await work(() =>
            row.parameters.nativeRetention
              ? requestWarehouseRetention({ website, canManage: false } as any, {
                  startAt: row.parameters.startAt,
                  endAt: row.parameters.endAt,
                  timezone: row.parameters.timezone,
                  ...row.parameters.nativeRetention,
                })
              : requestWarehouseOverview({ website, canManage: false } as any, row.parameters),
          );
          expect(response.status).toBe(200);
          readTimes.push(performance.now() - started);
          if (row.parameters.nativeRetention) {
            const version = response.headers.get('X-Liekan-Report-Version');
            expect(version).toMatch(/^[a-f0-9]{64}$/);
            const access = { website, canManage: false } as any;
            const retained = await work(() =>
              readWarehouseOverviewJob(
                access,
                row.id,
                true,
                new URLSearchParams({ reportVersion: version }),
              ),
            );
            expect(retained.status).toBe(200);
            await expect(
              work(() =>
                readWarehouseOverviewJob(
                  access,
                  row.id,
                  true,
                  new URLSearchParams({ reportVersion: '0'.repeat(64) }),
                ),
              ),
            ).rejects.toMatchObject({ status: 409 });
          }
        }
        await record({
          stage: 'scheduled',
          jobs: snapshots.length,
          ...firstRound,
          readMaxMs: Math.round(Math.max(...readTimes)),
          readP95Ms: Math.round(
            readTimes.sort((a, b) => a - b)[Math.ceil(readTimes.length * 0.95) - 1],
          ),
        });
        if (continuous) {
          // Same fixture and resources, a second scheduled cycle while accepted
          // publications continue. This is not a replay of the first result.
          await db.read(
            'UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now() WHERE preset',
          );
          const refreshed = await runRound();
          const next = await db.read<any>(
            'SELECT generated_at,error_code,publication FROM liekan_warehouse_overview_snapshot WHERE preset',
          );
          expect(next).toHaveLength(snapshots.length);
          expect(next.every(s => s.generated_at && !s.error_code)).toBe(true);
          expect(new Set(next.map(s => s.publication)).size).toBe(1);
          expect(BigInt(next[0].publication)).toBeGreaterThan(BigInt(snapshots[0].publication));
          expect(
            next.every(s => +s.generated_at > Math.max(...snapshots.map(old => +old.generated_at))),
          ).toBe(true);
          expect(await db.read('SELECT id FROM liekan_warehouse_report_round')).toEqual([]);
          await record({ stage: 'scheduled-refresh', jobs: next.length, ...refreshed });
          const { computeWarehouseOverview } = await import('./page-report');
          const { withDashboardClock } = await import('./dashboard-clock');
          const samples =
            await db.read<any>(`SELECT parameters,result,publication FROM liekan_warehouse_overview_snapshot
            WHERE preset AND parameters->>'chartPeriod'='today' AND NOT (parameters ?| ARRAY['nativeRetention','siteSummary'])
              AND parameters->>'resource' IN ('overview','human/overview','ai/overview')`);
          expect(samples).toHaveLength(3);
          const previousReads = process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS;
          process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS = '0';
          try {
            for (const sample of samples) {
              const raw = await withPublishedRegistry(() =>
                withinWarehouseReport(
                  () =>
                    withDashboardClock(sample.result.meta.snapshot.dataThrough, () =>
                      computeWarehouseOverview(website, sample.parameters),
                    ),
                  { publication: { websiteId: f.site, publication: String(sample.publication) } },
                ),
              );
              for (const part of ['cards', 'charts', 'tables'] as const)
                expect(normalize(sample.result[part])).toEqual(normalize(raw[part]));
            }
          } finally {
            if (previousReads === undefined) delete process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS;
            else process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS = previousReads;
          }
          await record({ stage: 'refresh-raw-comparison', reports: samples.length, exact: true });
        }
      }
      // GC is scoped to this fixture, honors live readers and preserves published artifacts.
      const orphan = randomUUID(),
        kept = randomUUID(),
        snapshot = randomUUID();
      await ch.insert({
        table: 'warehouse_report_rank_v1',
        format: 'JSONEachRow',
        values: [orphan, kept].map(build => ({
          website_id: f.site,
          epoch: 0,
          snapshot,
          build,
          table_name: 'topBody',
          ordinal: 0,
          row: '{}',
          geography: null,
          recorded_at: '2026-01-01 00:00:00',
        })),
      });
      await db.read(
        `INSERT INTO liekan_warehouse_overview_snapshot(id,website_id,query_key,parameters,catalog_version,format_version,preset,control_version,result) VALUES($1,$2,$3,'{}',$1,2,false,'fixture',$4)`,
        [snapshot, f.site, 'gc-fixture', { rankings: { build: kept, counts: { topBody: 1 } } }],
      );
      const { collectAnalysisArtifacts } = await import('./warehouse-analysis-gc');
      const clock = vi.spyOn(Date, 'now');
      const now = Date.now();
      const collect = async () => {
        try {
          await collectAnalysisArtifacts(new AbortController().signal);
        } catch (error) {
          // Match the production maintenance deferral for a bounded CH timeout.
          // Do not widen the 5-second limit or hide non-timeout failures.
          if (String((error as { code?: unknown }).code) !== '159') throw error;
          await record({ stage: 'gc-deferred', code: 159 });
        }
      };
      const countRanks = async () =>
        +(
          await ch
            .query({
              query:
                'SELECT count() AS n FROM warehouse_report_rank_v1 WHERE build IN {builds:Array(UUID)}',
              query_params: { builds: [orphan, kept] },
              format: 'JSONEachRow',
            })
            .then(r => r.json<{ n: string }>())
        )[0].n;
      for (let i = 0; i < 12; i++) {
        clock.mockReturnValue(now + i * 61000);
        await collect();
      }
      expect(await countRanks()).toBe(2);
      await db.read('DELETE FROM liekan_warehouse_reference');
      for (let i = 12; i < 48 && (await countRanks()) !== 1; i++) {
        clock.mockReturnValue(now + i * 61000);
        await collect();
      }
      expect(await countRanks()).toBe(1);
      clock.mockRestore();
      await record({ gc: 'reader-protected-and-published-build-retained' });
    } finally {
      await prisma?.client?.$disconnect();
      admission.close();
      await db.close();
      await ch.close();
      await admin.query(`DROP DATABASE ${run} WITH (FORCE)`);
      await admin.end();
      await chAdmin.command({ query: `DROP DATABASE ${run} SYNC` });
      await chAdmin.close();
      vi.unstubAllEnvs();
    }
  },
  600000,
);
