// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ value: null as any }));
vi.mock('@/lib/auth', () => ({
  checkAuth: async () => auth.value,
  hasPermission: async (role: string) => role === 'admin',
}));
const rows = Number(process.env.LIEKAN_ANALYTICS_COUNTS_BENCHMARK_ROWS || 0);
const start = new Date('2025-10-01T00:00:00Z'),
  end = new Date('2026-10-01T00:00:00Z');
const quantiles = (values: number[]) => {
  const v = [...values].sort((a, b) => a - b);
  return {
    n: v.length,
    p50: v[Math.ceil(v.length * 0.5) - 1],
    p95: v[Math.ceil(v.length * 0.95) - 1],
    p99: v[Math.ceil(v.length * 0.99) - 1],
  };
};
it.skipIf(!rows)(
  'measures exact hourly counts against the PostgreSQL source on owned scale data',
  async () => {
    let api: typeof import('./analytics-engine'),
      worker: typeof import('./analytics-engine-worker'),
      ch: typeof import('./analytics-engine-clickhouse'),
      counts: typeof import('./analytics-engine-counts'),
      rollups: typeof import('./analysis-rollups');
    const url = new URL(process.env.DATABASE_URL!),
      schema = url.searchParams.get('schema');
    url.searchParams.delete('schema');
    if (!/^engine_[a-f0-9]{32}$/.test(schema || ''))
      throw new Error('Owned benchmark schema required');
    const pg = new Client({ connectionString: url.toString() });
    await pg.connect();
    try {
      await pg.query(`SET search_path TO "${schema}"`);
      const {
        rows: [writer],
      } = await pg.query('SELECT pg_try_advisory_lock(hashtextextended($1::text,74218)) AS owned', [
        schema,
      ]);
      if (!writer.owned) throw new Error('Owned fixture already has an active benchmark writer');
      let admin = randomUUID(),
        site = randomUUID(),
        imported = randomUUID();
      const resume = process.env.LIEKAN_ANALYTICS_ENGINE_BENCHMARK_RESUME === '1';
      const report: any = resume
        ? JSON.parse(
            await readFile(
              `${process.env.LIEKAN_ANALYTICS_ENGINE_OUTPUT}/counts-benchmark.json`,
              'utf8',
            ),
          )
        : {
            rows,
            source: 'explicit synthetic fixture',
            distributionDays: 365,
            rawPaths: Math.min(rows, 1000000),
            samplesPerRound: 200,
            rounds: 3,
            ranges: [],
            startedAt: new Date().toISOString(),
          };
      if (resume) {
        expect(report.rows).toBe(rows);
        const {
          rows: [existing],
        } = await pg.query(
          "SELECT w.website_id,w.user_id,i.id FROM website w JOIN liekan_import i USING(website_id) WHERE w.domain='counts.example.invalid' AND w.name='Exact count synthetic benchmark'",
        );
        expect(existing).toBeTruthy();
        site = existing.website_id;
        admin = existing.user_id;
        imported = existing.id;
        report.resumedAt = new Date().toISOString();
        report.previousReadRun = report.ranges.map(({ samples, ...value }: any) => value);
        report.ranges = [];
      }
      auth.value = { authType: 'session', user: { id: admin, role: 'admin' } };
      const save = () =>
        writeFile(
          `${process.env.LIEKAN_ANALYTICS_ENGINE_OUTPUT}/counts-benchmark.json`,
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
      if (!resume) {
        await pg.query('INSERT INTO "user"(user_id,username,password,role) VALUES($1,$2,$3,$4)', [
          admin,
          'counts-' + admin,
          'isolated-fixture',
          'admin',
        ]);
        await pg.query(
          "INSERT INTO website(website_id,name,domain,user_id) VALUES($1,'Exact count synthetic benchmark','counts.example.invalid',$2)",
          [site, admin],
        );
        await pg.query(
          'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1,$2,$3,$4,0)',
          [imported, site, randomUUID(), rows],
        );
        auth.value = { authType: 'session', user: { id: admin, role: 'admin' } };
      }
      const {
        rows: [existingFacts],
      } = await pg.query('SELECT count(*)::text AS n FROM liekan_log WHERE website_id=$1::uuid', [
        site,
      ]);
      const seededRows = Number(existingFacts.n);
      expect(seededRows).toBeLessThanOrEqual(rows);
      if (seededRows < rows) {
        report.seedPrefixRows = seededRows;
        report.seedTiming = seededRows
          ? 'remaining generation after controlled restart'
          : 'full generation';
        const seeded = performance.now();
        for (let offset = seededRows; offset < rows; offset += 250000) {
          await pg.query(
            `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
        SELECT md5('counts-'||g),$1::uuid,$2::uuid,$3::timestamptz+((g-1)%365)*interval '1 day'+interval '12 hours'+(g%3600)*interval '1 second',
        '/synthetic/'||(g%1000000),'GET',CASE WHEN g%17=0 THEN 404 ELSE 200 END,0,'','',CASE WHEN g%97=0 THEN 'Liekan-Crawler-Check/synthetic' ELSE 'Synthetic-count-benchmark/1' END,'',
        CASE WHEN g%4=3 THEN '其他' ELSE 'SyntheticBot' END,'Synthetic',CASE WHEN g%4=3 THEN '未知' ELSE '训练' END,
        CASE WHEN g%3=0 THEN 'verified_range' WHEN g%3=1 THEN 'verified_dns' ELSE 'unverified' END,
        CASE WHEN g%4=3 THEN NULL ELSE true END,CASE WHEN g%4=3 THEN 'unknown' ELSE 'recognized' END
        FROM generate_series($4::integer,$5::integer) g`,
            [site, imported, start, offset + 1, Math.min(rows, offset + 250000)],
          );
          if ((offset + 250000) % 1000000 === 0) {
            report.seededRows = Math.min(rows, offset + 250000);
            console.log(`ENGINE_BENCH counts_seed ${report.seededRows}`);
            await save();
          }
        }
        await pg.query('ANALYZE liekan_log');
        report.seedMs = performance.now() - seeded;
        await save();
      }
      report.sourceFiles = Object.fromEntries(
        await Promise.all(
          [
            'analytics-engine-counts.ts',
            'analytics-engine-clickhouse.ts',
            'analytics-engine-worker.ts',
            'analytics-engine.ts',
            'analysis-rollups-db.ts',
            'analysis-rollups.ts',
            'server.ts',
          ].map(async name => [
            name,
            createHash('sha256')
              .update(await readFile('src/lib/liekan/upstream/' + name))
              .digest('hex'),
          ]),
        ),
      );
      report.migrationRegister = createHash('sha256')
        .update(await readFile('config/liekan/migrations.json'))
        .digest('hex');
      api = await import('./analytics-engine');
      worker = await import('./analytics-engine-worker');
      ch = await import('./analytics-engine-clickhouse');
      counts = await import('./analytics-engine-counts');
      rollups = await import('./analysis-rollups');
      const { reportSnapshot } = await import('./server');
      const control = await api.engineStatus(admin);
      if (!control.workerAt) {
        await act('check');
        await act('prepare');
      } else await act('resume');
      const built = performance.now();
      for (let n = 0; n < 150000; n++) {
        if (n % 128 === 0) await worker.discoverEngineWork(true);
        if (!(await worker.runEngineBatch())) {
          const {
            rows: [state],
          } = await pg.query(
            `SELECT EXISTS(SELECT 1 FROM liekan_analytics_engine_site WHERE history_cursor<history_end) OR EXISTS(SELECT 1 FROM liekan_analytics_engine_unit WHERE generation IS NULL OR verified_at IS NULL OR counts_verified_at IS NULL OR counts_generation IS DISTINCT FROM generation OR candidate IS NOT NULL) AS pending,EXISTS(SELECT 1 FROM liekan_analytics_engine_unit WHERE attempts>=4) AS failed`,
          );
          expect(state.failed).toBe(false);
          if (!state.pending) break;
          await new Promise(r => setTimeout(r, 50));
        }
        if (n % 1000 === 0) {
          report.batches = n;
          await save();
          console.log(`ENGINE_BENCH counts_build ${n}`);
        }
        if (n === 149999) throw new Error('Scale backfill did not finish');
      }
      report.buildMs = performance.now() - built;
      report.buildTiming = resume
        ? 'remaining work after controlled test restart'
        : 'full backfill';
      await act('enable');
      await save();
      for (const days of [30, 365]) {
        const input = {
          websiteId: site,
          startDate: new Date(+end - days * 86400000),
          endDate: end,
          timezone: 'UTC',
          crawlerMetricsVersion: 1 as const,
          crawlerIdentityScope: 'all' as const,
          fields: ['counts'],
          allowRawOnly: true,
        };
        const expected = {
          requests: 0,
          ai: 0,
          abnormal: 0,
          legacyRequests: 0,
          unclassifiedRequests: 0,
          classifications: ['legacy'],
        };
        for (let g = 1; g <= rows; g++) {
          if ((g - 1) % 365 < 365 - days || g % 97 === 0) continue;
          expected.requests++;
          if (g % 4 !== 3) expected.ai++;
          else {
            expected.legacyRequests++;
            expected.unclassifiedRequests++;
          }
          if (g % 17 === 0) expected.abnormal++;
        }
        const snapshot = <T>(load: () => Promise<T>) => reportSnapshot(load, Date.now() + 60000);
        const probeAt = performance.now();
        let pgValue: any, probeError: string | undefined;
        try {
          pgValue = (await snapshot(() => rollups.readAnalysisLogRollup(input)))?.counts;
        } catch (error: any) {
          probeError = error.code || error.name;
        }
        const pgProbe = {
          ms: performance.now() - probeAt,
          status: pgValue ? 'completed' : 'unavailable',
          error: probeError,
        };
        if (pgValue) expect(pgValue).toEqual(expected);
        expect(await snapshot(() => counts.readClickHouseLogCounts(input))).toEqual(expected);
        // Very slow raw probes are recorded independently; they do not produce fabricated quantiles.
        const comparePg = !!pgValue && pgProbe.ms <= 1000;
        const samples: any[] = [];
        for (let round = 0; round < 3; round++)
          for (let sample = 0; sample < 200; sample++) {
            for (const engine of comparePg ? (sample % 2 ? ['ch', 'pg'] : ['pg', 'ch']) : ['ch']) {
              const at = performance.now(),
                value = await snapshot(async () =>
                  engine === 'ch'
                    ? counts.readClickHouseLogCounts(input)
                    : (await rollups.readAnalysisLogRollup(input))?.counts,
                );
              expect(value).toEqual(expected);
              samples.push({ round, sample, engine, ms: performance.now() - at });
            }
            if ((sample + 1) % 50 === 0) {
              report.progress = { days, round, sample: sample + 1 };
              await save();
              console.log(`ENGINE_BENCH counts_measure ${days}d ${round} ${sample + 1}`);
            }
          }
        report.ranges.push({
          days,
          expected,
          pgProbe,
          pg: comparePg ? quantiles(samples.filter(s => s.engine === 'pg').map(s => s.ms)) : null,
          ch: quantiles(samples.filter(s => s.engine === 'ch').map(s => s.ms)),
          samples,
        });
        await save();
      }
      report.storage = {
        pg: (await pg.query("SELECT pg_total_relation_size('liekan_log')::text AS bytes")).rows[0]
          .bytes,
        ch: await ch.engineQuery(
          'SELECT table,sum(rows) AS rows,sum(bytes_on_disk) AS bytes FROM system.parts WHERE database=currentDatabase() AND active GROUP BY table',
        ),
      };
      report.completedAt = new Date().toISOString();
      await save();
      console.log(
        'ENGINE_BENCH counts_complete ' +
          JSON.stringify(report.ranges.map(({ samples, ...r }: any) => r)),
      );
    } finally {
      await pg.end();
      await ch?.engineClient().close();
      if (api) await (await import('@/lib/prisma')).default.client.$disconnect();
    }
  },
  28800000,
);
