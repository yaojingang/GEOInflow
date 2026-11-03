// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';
import { expectedEngineBenchmark } from './analytics-engine-benchmark-fixture';

const session = vi.hoisted(() => ({ value: null as any }));
vi.mock('@/lib/auth', () => ({
  checkAuth: async () => session.value,
  hasPermission: async (role: string) => role === 'admin',
}));
const rows = Number(process.env.LIEKAN_ANALYTICS_ENGINE_BENCHMARK_ROWS || 0);
const start = new Date('2025-10-01T00:00:00Z'),
  end = new Date('2026-10-01T00:00:00Z');
const normalize = (v: any): any =>
  v && typeof v === 'object'
    ? Array.isArray(v)
      ? v.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : Object.fromEntries(
          Object.keys(v)
            .filter(k => k !== 'coverage')
            .sort()
            .map(k => [k, normalize(v[k])]),
        )
    : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)
      ? new Date(v).toISOString()
      : v;
const quantiles = (values: number[]) => {
  const v = [...values].sort((a, b) => a - b);
  return {
    samples: v.length,
    p50: v[Math.ceil(v.length * 0.5) - 1],
    p95: v[Math.ceil(v.length * 0.95) - 1],
    p99: v[Math.ceil(v.length * 0.99) - 1],
  };
};
it.skipIf(!rows)(
  'scale benchmark compares real PostgreSQL rollups with verified ClickHouse reads',
  async () => {
    let admin = randomUUID(),
      site = randomUUID(),
      imported = randomUUID();
    const db = await import('./analysis-rollups-db'),
      api = await import('./analytics-engine'),
      ch = await import('./analytics-engine-clickhouse'),
      worker = await import('./analytics-engine-worker'),
      rollups = await import('./analysis-rollups'),
      reader = await import('./analytics-engine-read');
    const q = (sql: string, ...params: any[]) =>
      db.analysisTransaction(tx => tx.$queryRawUnsafe<any[]>(sql, ...params));
    const exec = (sql: string, ...params: any[]) =>
      db.analysisTransaction(tx => tx.$executeRawUnsafe(sql, ...params));
    const nativeUrl = new URL(process.env.DATABASE_URL);
    const schema = nativeUrl.searchParams.get('schema');
    nativeUrl.searchParams.delete('schema');
    if (!/^engine_[a-f0-9]{32}$/.test(schema))
      throw new Error('Benchmark requires its owned database schema');
    const pg = new Client({ connectionString: nativeUrl.toString() });
    await pg.connect();
    await pg.query(`SET search_path TO "${schema}"`);
    const resume = process.env.LIEKAN_ANALYTICS_ENGINE_BENCHMARK_RESUME === '1';
    const report: any = resume
      ? JSON.parse(
          await readFile(`${process.env.LIEKAN_ANALYTICS_ENGINE_OUTPUT}/benchmark.json`, 'utf8'),
        )
      : {
          rows,
          querySettings: {
            snapshot: 'production reportSnapshot',
            jit: 'off',
            applicationResultCache: false,
          },
          source: 'owned synthetic benchmark',
          ranges: [],
          startedAt: new Date().toISOString(),
        };
    if (resume) {
      expect(report.rows).toBe(rows);
      const {
        rows: [existing],
      } = await pg.query(
        "SELECT w.website_id,w.user_id,i.id AS import_id FROM website w JOIN liekan_import i USING(website_id) WHERE w.domain='benchmark.example.invalid' AND w.name='ClickHouse synthetic benchmark'",
      );
      expect(existing).toBeTruthy();
      admin = existing.user_id;
      site = existing.website_id;
      imported = existing.import_id;
      report.resumedAt = new Date().toISOString();
    }
    session.value = { authType: 'session', user: { id: admin, role: 'admin' } };
    const { reportSnapshot } = await import('./server');
    const snapshot = <T>(load: () => Promise<T>) => reportSnapshot(load, Date.now() + 60000);
    const save = () =>
      writeFile(
        `${process.env.LIEKAN_ANALYTICS_ENGINE_OUTPUT}/benchmark.json`,
        JSON.stringify(report, null, 2),
        { mode: 0o600 },
      );
    const act = async (action: string) =>
      api.changeAnalyticsEngine(
        new Request('http://localhost/api/liekan/admin/analytics-engine', { method: 'POST' }),
        {
          action,
          requestId: randomUUID(),
          expectedRevision: (await api.engineStatus(admin)).revision,
          locale: 'zh-CN',
        },
      );
    try {
      if (!resume) {
        await exec(
          "INSERT INTO \"user\"(user_id,username,password,role) VALUES($1::uuid,$2,'benchmark-fixture','admin')",
          admin,
          `benchmark-${admin}`,
        );
        await exec(
          "INSERT INTO website(website_id,name,domain,user_id) VALUES($1::uuid,'ClickHouse synthetic benchmark','benchmark.example.invalid',$2::uuid)",
          site,
          admin,
        );
        await exec(
          'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$3,$4,0)',
          imported,
          site,
          randomUUID(),
          rows,
        );
        const seedAt = performance.now();
        await pg.query(
          `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
   SELECT md5('engine-benchmark-'||g),$1::uuid,$2::uuid,$3::timestamptz+((g-1)%365)*interval '1 day'+interval '12 hours'+(g%3600)*interval '1 second',
   '/synthetic/'||(g%50000),'GET',CASE WHEN g%17=0 THEN 404 ELSE 200 END,0,'','','Synthetic-Benchmark/1.0','',
   CASE g%4 WHEN 0 THEN 'GPTBot' WHEN 1 THEN 'ClaudeBot' WHEN 2 THEN 'PerplexityBot' ELSE '其他' END,'Synthetic fixture',
   CASE WHEN g%4=3 THEN '未知' ELSE '训练' END,'verified_range',CASE WHEN g%4=3 THEN NULL ELSE true END,
   CASE WHEN g%4=3 THEN 'unknown' ELSE 'recognized' END FROM generate_series(1,$4::integer) g`,
          [site, imported, start, rows],
        );
        await pg.query('ANALYZE liekan_log');
        report.seedMs = performance.now() - seedAt;
        await save();
        console.log(`ENGINE_BENCH seeded ${rows}`);
        const build = await rollups.createAnalysisBuild(
          site,
          { userId: admin },
          {
            startDate: start,
            endDate: end,
            timezone: 'UTC',
            locale: 'zh-CN',
            requestId: randomUUID(),
          },
        );
        const pgBuildAt = performance.now();
        for (let i = 0; i < 100000; i++) {
          if (i % 100 === 0) {
            const [state] = await q(
              'SELECT status,work_done::text,work_total::text FROM liekan_analysis_build WHERE id=$1::uuid',
              build.id,
            );
            report.pgBuild = state;
            await save();
            if (['completed', 'capacity_limited', 'failed', 'invalidated'].includes(state.status))
              break;
          }
          await rollups.runOneAnalysisWorkUnit(build.id);
          if (i % 1000 === 0) console.log(`ENGINE_BENCH pg_units ${i}`);
        }
        report.pgBuildMs = performance.now() - pgBuildAt;
        await save();
        await act('check');
        await act('prepare');
      }
      expect(
        ['completed', 'capacity_limited'],
        'A failed PostgreSQL build cannot establish a performance baseline',
      ).toContain(report.pgBuild?.status);
      const chBuildAt = performance.now();
      for (let i = 0; i < 100000; i++) {
        if (i % 128 === 0) await worker.discoverEngineWork(true);
        const worked = await worker.runEngineBatch();
        if (!worked) {
          const [pending] = await q(
            `SELECT EXISTS(SELECT 1 FROM liekan_analytics_engine_site WHERE website_id=$2::uuid AND history_cursor<least(history_end,$1))
             OR EXISTS(SELECT 1 FROM liekan_analytics_engine_unit WHERE website_id=$2::uuid AND bucket<$1 AND (candidate IS NOT NULL OR generation IS NULL OR verified_at IS NULL)) AS pending,
             EXISTS(SELECT 1 FROM liekan_analytics_engine_unit WHERE website_id=$2::uuid AND attempts>=4) AS failed`,
            end,
            site,
          );
          expect(pending.failed, 'Backfill must not exhaust its retry budget').toBe(false);
          if (!pending.pending) break;
          await new Promise(resolve => setTimeout(resolve, 250));
          await worker.discoverEngineWork(true);
        }
        if (i % 500 === 0) {
          console.log(`ENGINE_BENCH ch_batches ${i}`);
          report.chBatches = i;
          await save();
        }
      }
      report.chBuildMs = performance.now() - chBuildAt;
      await act('enable');
      for (const days of [30, 90, 365]) {
        const input = {
          websiteId: site,
          startDate: new Date(+end - days * 86400000),
          endDate: end,
          timezone: 'UTC',
          crawlerMetricsVersion: 1 as const,
          crawlerIdentityScope: 'all' as const,
          fields: ['summary', 'bots', 'daily', 'statuses', 'hours'],
        };
        const expected = expectedEngineBenchmark(rows, days);
        const limited = report.pgBuild.status === 'capacity_limited';
        let baseline: Awaited<ReturnType<typeof rollups.readAnalysisLogRollup>>;
        let pgProbe: Record<string, unknown>;
        const probeAt = performance.now();
        try {
          baseline = await snapshot(() =>
            rollups.readAnalysisLogRollup({ ...input, allowRawOnly: true }),
          );
          pgProbe = {
            status: baseline ? 'completed' : 'unavailable',
            ms: performance.now() - probeAt,
            coverage: baseline?.coverage,
          };
        } catch (error: any) {
          if (!limited || error.status !== 503) throw error;
          pgProbe = { status: 'timeout', ms: performance.now() - probeAt, budgetMs: 60000 };
        }
        if (baseline) expect(normalize(baseline)).toEqual(normalize(expected));
        const actual = await snapshot(() => reader.readClickHouseLogRollup(input));
        expect(actual, 'A scale query must actually use ClickHouse').not.toBeNull();
        expect(normalize(actual)).toEqual(normalize(expected));
        const pgTimes: number[] = [],
          chTimes: number[] = [];
        for (let i = 0; i < 200; i++) {
          for (const engine of limited ? ['ch'] : i % 2 ? ['ch', 'pg'] : ['pg', 'ch']) {
            const at = performance.now();
            const value =
              engine === 'pg'
                ? await snapshot(() =>
                    rollups.readAnalysisLogRollup({ ...input, allowRawOnly: true }),
                  )
                : await snapshot(() => reader.readClickHouseLogRollup(input));
            const elapsed = performance.now() - at;
            expect(value).not.toBeNull();
            expect(normalize(value)).toEqual(normalize(expected));
            (engine === 'pg' ? pgTimes : chTimes).push(elapsed);
          }
          if (i % 50 === 0) {
            report.measurement = { days, completedSamples: i + 1 };
            await save();
            console.log(`ENGINE_BENCH measure ${days}d ${i}`);
          }
        }
        report.ranges.push({
          days,
          pg: limited ? { samples: 0, probe: pgProbe, capacityLimited: true } : quantiles(pgTimes),
          clickhouse: quantiles(chTimes),
          baselineCoverage: baseline?.coverage,
          comparable: !limited,
        });
        await save();
      }
      const writeMeasurements: Record<string, any> = {};
      const writeSql = `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
        SELECT md5($1||g),$2::uuid,$3::uuid,$5::timestamptz,'/synthetic-write','GET',200,0,'','','Synthetic-Benchmark/1.0','','GPTBot','Synthetic fixture','训练','verified_range',true,'recognized' FROM generate_series(1,$4::integer) g`;
      for (const capture of [false, true]) {
        await exec('UPDATE liekan_analytics_engine SET capture=$1', capture);
        if (capture)
          await pg.query(writeSql, [randomUUID(), site, imported, 20000, '2026-10-01T00:15:00Z']);
        const [before] = await q(
          'SELECT coalesce(sum(copied),0)::text AS copied FROM liekan_analytics_engine_unit WHERE website_id=$1::uuid AND bucket>=$2',
          site,
          end,
        );
        let running = capture;
        let completedBatches = 0;
        let backgroundError: unknown;
        const background = capture
          ? (async () => {
              while (running) {
                try {
                  await worker.discoverEngineWork(true);
                  if (await worker.runEngineBatch()) completedBatches++;
                } catch (error) {
                  backgroundError = error;
                  running = false;
                }
                await new Promise(resolve => setTimeout(resolve, 5));
              }
            })()
          : Promise.resolve();
        const times: number[] = [];
        try {
          for (let i = 0; i < 420; i++) {
            const at = performance.now();
            await pg.query(writeSql, [randomUUID(), site, imported, 1, '2026-10-02T12:15:00Z']);
            if (i >= 20) times.push(performance.now() - at);
          }
          const began = performance.now();
          for (let i = 0; i < 100; i++)
            await pg.query(writeSql, [randomUUID(), site, imported, 100, '2026-10-02T12:15:00Z']);
          writeMeasurements[capture ? 'captureAndConcurrentBackfill' : 'captureOff'] = {
            singleCommit: quantiles(times),
            batchRowsPerSecond: 10000 / ((performance.now() - began) / 1000),
          };
        } finally {
          running = false;
          await background;
        }
        if (backgroundError) throw backgroundError;
        const [after] = await q(
          'SELECT coalesce(sum(copied),0)::text AS copied FROM liekan_analytics_engine_unit WHERE website_id=$1::uuid AND bucket>=$2',
          site,
          end,
        );
        const progress = {
          completedBatches,
          sourceRowsCopied: Number(after.copied) - Number(before.copied),
        };
        writeMeasurements[
          capture ? 'captureAndConcurrentBackfill' : 'captureOff'
        ].backfillProgress = progress;
        if (capture)
          expect(
            progress.sourceRowsCopied,
            'Concurrent measurement must copy nonempty source rows',
          ).toBeGreaterThan(0);
      }
      report.ingestion = writeMeasurements;
      report.ingestion.p95IncreaseMs =
        writeMeasurements.captureAndConcurrentBackfill.singleCommit.p95 -
        writeMeasurements.captureOff.singleCommit.p95;
      report.ingestion.throughputRatio =
        writeMeasurements.captureAndConcurrentBackfill.batchRowsPerSecond /
        writeMeasurements.captureOff.batchRowsPerSecond;
      report.ingestion.gates = {
        p95IncreaseAtMost30ms: report.ingestion.p95IncreaseMs <= 30,
        throughputAtLeast90Percent: report.ingestion.throughputRatio >= 0.9,
      };
      await save();
      const [pgSize] = await q(
        "SELECT pg_total_relation_size('liekan_log')::text AS raw_log_bytes,pg_database_size(current_database())::text AS total_bytes",
      );
      const [chSize] = await ch.engineQuery(
        `SELECT sum(bytes_on_disk) AS projection_bytes FROM system.parts WHERE database=currentDatabase() AND table={table:String} AND active`,
        { table: ch.ENGINE_TABLE },
      );
      report.storage = { ...pgSize, ...chSize };
      report.resources = execFileSync(
        'docker',
        [
          'stats',
          '--no-stream',
          '--format',
          '{{json .}}',
          process.env.LIEKAN_ENGINE_PG_CONTAINER,
          process.env.LIEKAN_ENGINE_CH_CONTAINER,
        ],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
      report.finishedAt = new Date().toISOString();
      report.correct = true;
      await save();
      console.log(`ENGINE_BENCH complete ${rows}`);
    } finally {
      await pg.end();
      await ch.engineClient().close();
      await (await import('@/lib/prisma')).default.client.$disconnect();
    }
  },
  7200000,
);
