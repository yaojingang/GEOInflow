// @vitest-environment node
// All containers and synthetic inputs belong to the labelled disposable runner.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { writeFile, appendFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { hashSync } from 'bcryptjs';
import { Client } from 'pg';
import { it } from 'vitest';
import { calendarDayRange } from '../contracts/calendar';
import { pageReportSchema } from '../contracts/page-report';
import { seedBenchmarkBrowserEvidence } from '../../../../scripts/liekan-benchmark-fixtures';

const enabled = process.env.LIEKAN_ANALYSIS_FIRST_LOAD_BENCHMARK === '1';
const exec = promisify(execFile);
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    minMs: sorted[0] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
};
const statistical = (body: any) => {
  const { generatedAt, expiresAt, snapshot, canManage, keywordReadAt, ...meta } = body.meta || {};
  if (meta.crawlerEvidenceView) {
    // Proof serialization has its own cross-browser contract regression; compare its statistical inputs.
    const { snapshot: proof, ...view } = meta.crawlerEvidenceView;
    meta.crawlerEvidenceView = view;
  }
  return { ...body, meta };
};
const digest = (value: any) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map(key => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest('hex');
it.skipIf(!enabled)(
  'compares production first loads on the same owned 30-day spider population',
  async () => {
    const url = new URL(process.env.DATABASE_URL!);
    assert(
      url.hostname === '127.0.0.1' &&
        url.port === '15462' &&
        url.pathname === '/liekan_analysis_rollups_test' &&
        /^analysis_[a-f0-9]+$/.test(url.searchParams.get('schema') || ''),
    );
    const folder = process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT!;
    const owner = process.env.LIEKAN_ANALYSIS_ROLLUPS_OWNER!;
    const database = process.env.LIEKAN_ANALYSIS_ROLLUPS_CONTAINER!;
    const app = process.env.LIEKAN_ANALYSIS_DASHBOARD_APP!;
    const worker = process.env.LIEKAN_ANALYSIS_ROLLUPS_WORKER!;
    const workerEnv = process.env.LIEKAN_ANALYSIS_ROLLUPS_WORKER_ENV!;
    const images = {
      baseline: process.env.LIEKAN_ANALYSIS_DASHBOARD_BASELINE_ID!,
      candidate: process.env.LIEKAN_ANALYSIS_ROLLUPS_CANDIDATE_ID!,
    };
    assert(Object.values(images).every(v => /^sha256:[a-f0-9]{64}$/.test(v)));
    const label = 'io.liekan.analysis-rollups-test';
    const docker = async (args: string[]) =>
      (await exec('docker', args, { maxBuffer: 16 * 1024 * 1024, timeout: 120000 })).stdout.trim();
    const own = async (name: string) =>
      assert.equal(
        await docker(['inspect', '--format', `{{index .Config.Labels "${label}"}}`, name]),
        owner,
      );
    await own(database);
    const nativeUrl = new URL(url);
    nativeUrl.searchParams.delete('schema');
    const db = new Client({ connectionString: nativeUrl.toString() });
    await db.connect();
    await db.query(`SET search_path TO "${url.searchParams.get('schema')}"`);
    const actor = randomUUID(),
      site = randomUUID(),
      imported = randomUUID(),
      password = randomBytes(20).toString('hex'),
      username = `synthetic-first-load-${owner}`;
    const logRows = Number(process.env.LIEKAN_ANALYSIS_FIRST_LOAD_LOG_ROWS),
      browserRows = Number(process.env.LIEKAN_ANALYSIS_FIRST_LOAD_BROWSER_ROWS);
    const smoke = logRows === 30000,
      samples = smoke ? 1 : 3;
    const resources = ['ai/overview', 'ai/bots', 'ai/pages', 'ai/preference'];
    const selectedResources = process.env.LIEKAN_ANALYSIS_FIRST_LOAD_RESOURCES?.split(',');
    assert(
      !selectedResources ||
        (selectedResources.length > 0 &&
          selectedResources.every(value => resources.includes(value))),
    );
    const measuredResources = selectedResources || (smoke ? ['ai/overview'] : resources);
    const burstResource = measuredResources.includes('ai/pages')
      ? 'ai/pages'
      : measuredResources[0];
    const sessions = browserRows / 30;
    assert(Number.isInteger(sessions) && sessions >= 30);
    assert(Number.isInteger(logRows) && logRows >= 30000 && logRows % 30 === 0);
    const today = calendarDayRange(Date.now(), 'Asia/Shanghai').startAt;
    const frozenEnd = Math.floor((Date.now() - 60000) / 30000) * 30000 - 1;
    assert(frozenEnd > today + 3600000, 'Needs a closed first hour inside today');
    const start = today - 29 * 86400000;
    const report: any = {
      schemaVersion: 1,
      synthetic: true,
      images,
      logRows,
      browserRows,
      days: 30,
      logsPerDay: logRows / 30,
      timezone: 'Asia/Shanghai',
      todayStart: today,
      endAt: frozenEnd,
      samplesPerCombination: samples,
      resources: measuredResources,
      smoke,
      cacheCondition:
        'Every cold sample restarts both application and worker and deletes only this fixture’s result tables; Redis is unset. PostgreSQL and OS buffers remain warm.',
      distribution:
        `Every day has the same input count, 120 paths, static and status variants; events are concentrated in the first closed hour. The fixture has ${logRows / 30} logs/day.`,
      measurements: [],
      passed: false,
    };
    const save = () =>
      writeFile(`${folder}/first-load-benchmark.json`, JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
    const progress = async (stage: string) => {
      await appendFile(
        `${folder}/first-load-progress.jsonl`,
        JSON.stringify({ at: new Date().toISOString(), stage }) + '\n',
        { mode: 0o600 },
      );
      await save();
    };
    let running = false;
    const stop = async () => {
      if (!running) return;
      for (const name of [worker, app]) {
        await own(name);
        await docker(['stop', '--time', '1', name]);
        await writeFile(
          `${folder}/${name.endsWith('worker') ? 'worker' : 'app'}-last.private.log`,
          await docker(['logs', name]),
          { mode: 0o600 },
        );
        await docker(['rm', '--volumes', name]);
      }
      running = false;
    };
    let endpoint = '',
      token = '';
    const startRuntime = async (image: string) => {
      for (const [name, isWorker] of [
        [app, false],
        [worker, true],
      ] as const) {
        await docker([
          'run',
          '--detach',
          '--name',
          name,
          '--label',
          `${label}=${owner}`,
          '--network',
          `container:${database}`,
          '--cpus',
          isWorker ? '1' : '2',
          '--memory',
          isWorker ? '512m' : '1536m',
          '--env-file',
          workerEnv,
          '--env',
          'PORT=3000',
          '--entrypoint',
          'node',
          image,
          isWorker ? 'dist/liekan-analytics-worker.mjs' : 'server.js',
        ]);
      }
      running = true;
      endpoint = `http://127.0.0.1:${(await docker(['port', database, '3000/tcp'])).split(':').at(-1)}`;
      for (let i = 0; ; i++) {
        try {
          if ((await fetch(`${endpoint}/api/heartbeat`, { signal: AbortSignal.timeout(1000) })).ok)
            break;
        } catch {}
        assert(i < 60, 'Application did not start');
        await pause(250);
      }
      const login = await fetch(`${endpoint}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(login.status, 200);
      token = (await login.json()).token;
    };
    const clear = async () => {
      await db.query('DELETE FROM liekan_report_fragment WHERE website_id=$1::uuid', [site]);
      await db.query('DELETE FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid', [site]);
      await db.query('DELETE FROM liekan_analysis_query WHERE website_id=$1::uuid', [site]);
      // Both owned runtimes have stopped; reset abandoned control leases before an independent trial.
      for (const table of [
        'liekan_analysis_background_lease',
        'liekan_analysis_dashboard_lease',
        'liekan_analysis_read_lease',
      ])
        await db.query(`UPDATE ${table} SET token=NULL,lease_until=NULL`);
    };
    const measure = async (parameters: any, view = randomUUID(), auth = token) => {
      const headers = {
        Authorization: `Bearer ${auth}`,
        Prefer: 'respond-async',
        'X-Liekan-View': view,
        'Accept-Language': 'zh-CN',
      };
      const then = performance.now();
      let response = await fetch(
        `${endpoint}/api/liekan/websites/${site}/page-report?${new URLSearchParams(Object.entries(parameters).map(([k, v]) => [k, String(v)]))}`,
        { headers, signal: AbortSignal.timeout(70000) },
      );
      const submitMs = performance.now() - then,
        firstStatus = response.status,
        path = response.headers.get('X-Liekan-Read-Path');
      let body = await response.json(),
        id = body.analysisJob?.id,
        statusReads = 0;
      while (response.status === 202 && performance.now() - then < 70000) {
        await pause(Math.max(1000, Math.min(10000, body.analysisJob.retryAfterMs || 1000)));
        response = await fetch(`${endpoint}/api/liekan/websites/${site}/analytics-jobs/${id}`, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        body = await response.json();
        statusReads++;
        if (body.analysisJob?.status === 'ready') {
          response = await fetch(
            `${endpoint}/api/liekan/websites/${site}/analytics-jobs/${id}/result`,
            { headers, signal: AbortSignal.timeout(10000) },
          );
          body = await response.json();
          break;
        }
        if (['failed', 'invalidated', 'expired'].includes(body.analysisJob?.status)) break;
        if (response.status === 200 && body.analysisJob)
          response = new Response(null, { status: 202 });
      }
      const completeMs = performance.now() - then;
      const task = (
        await db.query(
          `SELECT id,status,attempts,error_code,fast_attempted_at,extract(epoch FROM(started_at-queued_at))*1000 AS queue_ms,extract(epoch FROM(completed_at-started_at))*1000 AS compute_publish_ms FROM liekan_analysis_query WHERE website_id=$1::uuid AND parameters @> $2::jsonb AND ($3::uuid IS NULL OR id=$3::uuid) ORDER BY sequence DESC LIMIT 1`,
          [site, JSON.stringify(parameters), id ?? null],
        )
      ).rows[0];
      const valid = pageReportSchema.safeParse(body).success;
      if (id && images.candidate)
        await fetch(`${endpoint}/api/liekan/websites/${site}/analytics-jobs/${id}`, {
          method: 'DELETE',
          headers,
        }).catch(() => {});
      return {
        firstStatus,
        finalStatus: response.status,
        path,
        submitMs,
        completeMs,
        statusReads,
        task,
        valid,
        hash: valid ? digest(statistical(body)) : null,
        errorCode: body?.error?.code || body?.analysisJob?.errorCode || null,
        body,
      };
    };
    try {
      await progress('seed');
      await db.query(
        'INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$2,$3,\'admin\')',
        [actor, username, hashSync(password, 8)],
      );
      await db.query(
        "INSERT INTO website(website_id,user_id,name,domain) VALUES($1::uuid,$2::uuid,'Synthetic first-load fixture','first-load.invalid')",
        [site, actor],
      );
      await db.query('INSERT INTO liekan_setting(website_id,is_demo) VALUES($1::uuid,true)', [
        site,
      ]);
      await db.query(
        'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$1,$3,0)',
        [imported, site, logRows],
      );
      await db.query(
        'CREATE TEMP TABLE benchmark_sessions AS SELECT i,gen_random_uuid() AS session_id,$1::uuid AS website_id FROM generate_series(1,$2::int) i',
        [site, sessions],
      );
      await db.query("SET session_replication_role='replica'");
      try {
        for (let day = 0; day < 30; day++) {
          await db.query(
            `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
     SELECT md5($1||'-'||g),$2::uuid,$3::uuid,to_timestamp(($4::bigint+1800000+(g%120000))/1000.0),CASE WHEN g%7=0 THEN '/synthetic/style.CSS?x=1' ELSE '/synthetic/'||(g%120) END,'GET',CASE WHEN g%11=0 THEN 404 ELSE 200 END,0,'','','SyntheticBenchmarkBot','','GPTBot','OpenAI','训练','unverified',true,'recognized' FROM generate_series(1,$5::int) g`,
            [`${owner}-${day}`, site, imported, start + day * 86400000, logRows / 30],
          );
        }
        await db.query(
          `INSERT INTO session(session_id,website_id,created_at,browser,os,device,country,screen,language) SELECT session_id,website_id,to_timestamp($1::bigint/1000.0),'Chrome','Mac OS','desktop','CN','1920x1080','zh-CN' FROM benchmark_sessions`,
          [start],
        );
        await db.query(
          `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type,hostname,referrer_domain)
    SELECT gen_random_uuid(),s.website_id,s.session_id,s.session_id,to_timestamp(($1::bigint+((e.i-1)/$3::int)*86400000::bigint+1800000+e.i%1000)/1000.0),'/synthetic/'||(e.i%120),1,'first-load.invalid','chatgpt.com' FROM generate_series(1,$2::int)e(i) JOIN benchmark_sessions s ON s.i=1+(e.i-1)%$3::int`,
          [start, browserRows, sessions],
        );
        await seedBenchmarkBrowserEvidence(db, [site]);
      } finally {
        await db.query("SET session_replication_role='origin'");
      }
      for (const table of [
        'liekan_log',
        'website_event',
        'session',
        'liekan_event_quality',
        'liekan_event_environment',
        'liekan_session_source',
      ])
        await db.query(`ANALYZE ${table}`);
      const counts = (
        await db.query(
          `SELECT (SELECT count(*)::int FROM liekan_log WHERE website_id=$1::uuid) AS logs,(SELECT count(*)::int FROM website_event WHERE website_id=$1::uuid) AS events,(SELECT count(*)::int FROM liekan_log WHERE website_id=$1::uuid AND created_at>=to_timestamp($2/1000.0)) AS today_logs`,
          [site, today],
        )
      ).rows[0];
      assert.equal(counts.logs, logRows);
      assert.equal(counts.events, browserRows);
      assert.equal(counts.today_logs, logRows / 30);
      report.actualCounts = counts;
      await db.query("UPDATE liekan_analysis_site SET mode='live' WHERE website_id=$1::uuid", [
        site,
      ]);
      await progress('build-existing-rollups');
      const { withPublishedRegistry } = await import('./crawler-registry-context');
      const { createAnalysisBuild, runOneAnalysisWorkUnit } = await import('./analysis-rollups');
      const builtAt = performance.now();
      const build = await withPublishedRegistry(() =>
        createAnalysisBuild(
          site,
          { userId: actor },
          {
            startDate: new Date(start),
            endDate: new Date(Math.floor(frozenEnd / 3600000) * 3600000),
            timezone: 'Asia/Shanghai',
            locale: 'zh-CN',
            requestId: randomUUID(),
          },
        ),
      );
      for (let i = 0; ; i++) {
        const row = (
          await db.query(
            'SELECT status,error_code,work_done,work_total FROM liekan_analysis_build WHERE id=$1::uuid',
            [build.id],
          )
        ).rows[0];
        if (row.status === 'completed') {
          report.build = { ...row, elapsedMs: performance.now() - builtAt };
          break;
        }
        assert(
          !['failed', 'invalidated', 'capacity_limited'].includes(row.status),
          JSON.stringify(row),
        );
        assert(i < 30000, 'Build did not finish');
        await withPublishedRegistry(() => runOneAnalysisWorkUnit(build.id));
        if (i % 100 === 0) await progress(`build:${row.work_done}/${row.work_total}`);
      }
      report.coverage = (
        await db.query(
          'SELECT family,count(*)::int AS manifests,sum(row_count)::text AS source_rows FROM liekan_analysis_manifest WHERE website_id=$1::uuid GROUP BY family',
          [site],
        )
      ).rows;
      for (let pass = 0; pass < 1000; pass++) {
        const ready = (
          await db.query(
            'SELECT ready FROM liekan_analytics_input_state WHERE website_id=$1::uuid AND epoch=1',
            [site],
          )
        ).rows[0]?.ready;
        if (ready) break;
        assert(pass < 999, 'Input summary preparation did not finish');
        await db.query('SELECT liekan_analytics_input_backfill($1::uuid)', [site]);
      }
      const ranges = [
        { name: 'today', startAt: today, endAt: frozenEnd, chartPeriod: 'today' },
        { name: '7d', startAt: today - 6 * 86400000, endAt: frozenEnd, chartPeriod: '7d' },
        { name: '30d', startAt: start, endAt: frozenEnd, chartPeriod: '30d' },
        {
          name: 'custom',
          startAt: today - 22 * 86400000 + 1234567,
          endAt: today - 3 * 86400000 + 6543210,
          chartPeriod: '30d',
        },
      ];
      const expected = new Map<string, string>();
      const otherUsers = Array.from({ length: 4 }, () => ({
        id: randomUUID(),
        username: `synthetic-burst-${randomUUID()}`,
      }));
      for (const user of otherUsers)
        await db.query(
          'INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$2,$3,\'admin\')',
          [user.id, user.username, hashSync(password, 8)],
        );
      report.bursts = [];
      for (const [version, image] of Object.entries(images)) {
        for (const resource of measuredResources)
          for (const range of ranges) {
            const { name, ...window } = range;
            const parameters = {
              ...window,
              resource,
              timezone: 'Asia/Shanghai',
              crawlerMetricsVersion: 1,
            };
            const result: any = { version, resource, range: name, parameters, cold: [], warm: [] };
            report.measurements.push(result);
            for (let sample = 0; sample < samples; sample++) {
              await stop();
              await clear();
              await startRuntime(image);
              await progress(`${version}:${resource}:${name}:${sample}`);
              const observation = await measure(parameters);
              const { body, ...timing } = observation;
              result.cold.push(timing);
              const key = JSON.stringify(parameters);
              if (observation.valid) {
                if (!expected.has(key)) expected.set(key, observation.hash!);
                assert.equal(observation.hash, expected.get(key), 'Statistical DTO changed');
              }
              if (!observation.valid) {
                await save();
                break;
              }
              for (let warm = 0; warm < 3; warm++) {
                const again = await measure(parameters);
                const { body, ...timing } = again;
                result.warm.push(timing);
                assert.equal(again.hash, expected.get(key), 'Warm statistics changed');
              }
              await save();
            }
            result.firstLoad = summary(result.cold.map((v: any) => v.completeMs));
            result.published = summary(result.warm.map((v: any) => v.completeMs));
            result.failures = result.cold.filter(
              (v: any) => !v.valid || v.finalStatus !== 200,
            ).length;
            await save();
          }
        if (!smoke)
          for (const range of ranges) {
            const { name, ...window } = range,
              parameters = {
                ...window,
                resource: burstResource,
                timezone: 'Asia/Shanghai',
                crawlerMetricsVersion: 1,
              };
            await stop();
            await clear();
            await startRuntime(image);
            const tokens = [token];
            for (const user of otherUsers) {
              const login = await fetch(`${endpoint}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: user.username, password }),
              });
              assert.equal(login.status, 200);
              tokens.push((await login.json()).token);
            }
            await progress(`${version}:five-viewers:${name}`);
            const observations = await Promise.all(
              tokens.map(auth => measure(parameters, randomUUID(), auth)),
            );
            for (const observation of observations)
              if (observation.valid)
                assert.equal(
                  observation.hash,
                  expected.get(JSON.stringify(parameters)),
                  'Concurrent statistics changed',
                );
            report.bursts.push({
              version,
              resource: burstResource,
              range: name,
              users: 5,
              producers: (
                await db.query(
                  'SELECT count(*)::int AS n FROM liekan_analysis_query WHERE website_id=$1::uuid AND parameters @> $2::jsonb',
                  [site, JSON.stringify(parameters)],
                )
              ).rows[0].n,
              latency: summary(observations.map(v => v.completeMs)),
              failures: observations.filter(v => !v.valid || v.finalStatus !== 200).length,
              samples: observations.map(({ body, ...timing }) => timing),
            });
            await save();
          }
      }
      report.passed =
        report.measurements.length === measuredResources.length * 8 &&
        report.measurements.every((v: any) => v.failures === 0) &&
        report.bursts.every((v: any) => v.failures === 0);
      report.candidatePassed =
        report.measurements.filter((v: any) => v.version === 'candidate').length ===
          measuredResources.length * 4 &&
        report.measurements
          .filter((v: any) => v.version === 'candidate')
          .every((v: any) => v.failures === 0) &&
        report.bursts
          .filter((v: any) => v.version === 'candidate')
          .every((v: any) => v.failures === 0 && v.producers === 1);
      report.completed = true;
      assert(report.candidatePassed, 'Candidate first-load or output equality failed');
      await progress('complete');
    } finally {
      await stop();
      await save();
      await db.end();
      const { default: prisma } = await import('@/lib/prisma');
      await prisma.client.$disconnect();
    }
  },
  7200000,
);
