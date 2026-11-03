// @vitest-environment node
import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { ANALYSIS_ROLLUP_VERSION } from './analysis-rollups-model';
import { COLLECTION_IDENTITY_VERSION, type CollectionIdentity } from './collection-identity';
import { summarizeClosedBucketLag } from '@/test/analysis-capture-statistics.mjs';

const enabled = process.env.LIEKAN_ANALYSIS_CAPTURE_BENCHMARK === '1';
const folder = process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT;
const baselineRows = Number(process.env.LIEKAN_ANALYSIS_ROLLUPS_BENCHMARK_ROWS);
const heartbeat = '/tmp/liekan-analytics-worker-heartbeat';
let prisma: typeof import('@/lib/prisma').default;
let db: typeof import('./analysis-rollups-db');
const q = <T = any[]>(sql: string, ...values: unknown[]) =>
  db.analysisTransaction(tx => tx.$queryRawUnsafe<T>(sql, ...values));
const sql = (statement: string, ...values: unknown[]) =>
  db.analysisTransaction(tx => tx.$executeRawUnsafe(statement, ...values));
const save = (name: string, value: unknown) =>
  writeFile(
    `${folder}/${name}`,
    JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v), 2),
    { mode: 0o600 },
  );
const progress = (stage: string, details: Record<string, unknown> = {}) =>
  appendFile(
    `${folder}/capture-progress.jsonl`,
    JSON.stringify({ at: new Date().toISOString(), stage, ...details }) + '\n',
    { mode: 0o600 },
  );
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)];
const counts = (values: number[]) => ({
  samples: values.length,
  p95Ms: values.length ? p95(values) : null,
  minimumMs: values.length ? Math.min(...values) : null,
  maximumMs: values.length ? Math.max(...values) : null,
});
const code = (error: unknown) =>
  String((error as any)?.code || (error as any)?.name || 'capture-failed');
afterAll(async () => {
  if (prisma) await prisma.client.$disconnect();
});

it.skipIf(!enabled)(
  'measures v2 capture overhead and actual analytics-worker closed-bucket lag in owned PostgreSQL',
  async () => {
    const url = new URL(process.env.DATABASE_URL || 'http://invalid');
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '15462' ||
      url.pathname !== '/liekan_analysis_rollups_test' ||
      !/^analysis_[a-f0-9]+$/.test(url.searchParams.get('schema') || '') ||
      !folder?.includes('/.local/analysis-rollups/')
    )
      throw new Error('capture-owned-schema-required');
    const owner = process.env.LIEKAN_ANALYSIS_ROLLUPS_OWNER,
      pgContainer = process.env.LIEKAN_ANALYSIS_ROLLUPS_CONTAINER,
      workerName = process.env.LIEKAN_ANALYSIS_ROLLUPS_WORKER,
      imageId = process.env.LIEKAN_ANALYSIS_ROLLUPS_CANDIDATE_ID,
      workerEnv = process.env.LIEKAN_ANALYSIS_ROLLUPS_WORKER_ENV,
      ownerLabel = 'io.liekan.analysis-rollups-test';
    if (
      !/^[a-f0-9-]{36}$/.test(owner || '') ||
      pgContainer !== `liekan-analysis-rollups-${owner}` ||
      workerName !== `${pgContainer}-worker` ||
      !/^sha256:[a-f0-9]{64}$/.test(imageId || '') ||
      workerEnv !== `${folder}/worker.env`
    )
      throw new Error('capture-owned-worker-required');
    const docker = (args: string[], optional = false, timeoutMs = 15000): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }),
          output: Buffer[] = [],
          errors: Buffer[] = [];
        child.stdout.on('data', chunk => output.push(chunk));
        child.stderr.on('data', chunk => errors.push(chunk));
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.on('error', () => {
          clearTimeout(timer);
          reject(new Error('capture-docker-unavailable'));
        });
        child.on('close', async status => {
          clearTimeout(timer);
          if (status !== 0 && !optional) {
            await writeFile(`${folder}/capture-worker-error.log`, Buffer.concat(errors), {
              mode: 0o600,
            });
            reject(new Error('capture-docker-command-failed'));
          } else
            resolve(
              status === 0
                ? Buffer.concat(args[0] === 'logs' ? [...output, ...errors] : output)
                    .toString()
                    .trim()
                : '',
            );
        });
      });
    const assertOwner = async (container: string) => {
      if (
        (await docker([
          'inspect',
          '--format',
          `{{ index .Config.Labels "${ownerLabel}" }}`,
          container,
        ])) !== owner
      )
        throw new Error('capture-container-ownership-changed');
    };
    await assertOwner(pgContainer);
    const preflightBudget = JSON.parse(
      await readFile(`${folder}/worker-preflight-budget.json`, 'utf8'),
    );
    if (preflightBudget.NanoCpus !== 1000000000 || preflightBudget.Memory !== 536870912)
      throw new Error('capture-worker-preflight-budget-mismatch');
    if (await docker(['inspect', '--format', '{{.Id}}', workerName], true))
      throw new Error('capture-worker-name-already-present');
    const workerAlive = async () => {
      await assertOwner(workerName);
      return (await docker(['inspect', '--format', '{{.State.Running}}', workerName])) === 'true';
    };
    const readHeartbeat = () => docker(['exec', workerName, 'cat', heartbeat], true);
    ({ default: prisma } = await import('@/lib/prisma'));
    db = await import('./analysis-rollups-db');
    const { withPublishedRegistry } = await import('./crawler-registry-context');
    const { withCollectionWrite, recordCollectionIdentity } = await import('./collection-write');
    const { saveEvent } = await import('@/queries/sql/events/saveEvent');
    const { observeCollection } = await import('./collection-observation');
    const { processBatch } = await import('../log-ingestion/service');
    const actor = { userId: randomUUID() };
    const triggers = await q<
      { table_name: string; trigger_name: string; enabled: string }[]
    >(`SELECT c.relname AS table_name,t.tgname AS trigger_name,t.tgenabled::text AS enabled
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
   WHERE n.nspname=current_schema() AND NOT t.tgisinternal AND p.proname LIKE 'liekan_analysis_%'
   AND c.relname IN('liekan_log','liekan_crawler_evidence','website_event','session','liekan_event_quality','liekan_event_geography','liekan_event_environment','liekan_log_state','liekan_log_source') ORDER BY 1,2`);
    if (triggers.length < 12) throw new Error('capture-trigger-inventory-incomplete');
    if (triggers.filter(t => t.table_name === 'liekan_event_environment').length !== 8)
      throw new Error('capture-environment-trigger-inventory-incomplete');
    const switchCapture = async (on: boolean) => {
      for (const t of triggers) {
        if (!/^[a-z_]+$/.test(t.table_name) || !/^[a-z_]+$/.test(t.trigger_name))
          throw new Error('capture-trigger-name-invalid');
        await sql(
          `ALTER TABLE ${t.table_name} ${on ? 'ENABLE' : 'DISABLE'} TRIGGER ${t.trigger_name}`,
        );
      }
    };
    const restore = async () => {
      for (const t of triggers)
        await sql(
          `ALTER TABLE ${t.table_name} ${t.enabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER ${t.trigger_name}`,
        );
    };
    let workerCreated = false,
      lastHeartbeat = '';
    const result: any = {
      schemaVersion: 1,
      synthetic: true,
      workerPreflightBudget: preflightBudget,
      scope: {
        baselineRows,
        additionalUnusedBaselineRows: baselineRows / 4,
        actualBaselineRows: (baselineRows / 4) * 5,
        armOrder: ['disabled', 'enabled', 'enabled', 'disabled'],
        onlineConcurrency: 32,
        batchConcurrency: 2,
        batchSize: 2000,
        batchesPerArm: 100,
        offeredWork:
          'Fixed paced arrivals chosen from a capture-disabled calibration. Online arrivals continue until every import completes, with bounded in-flight operations and an arm deadline. All admitted and rejected attempts are retained.',
        batchEventTimeSpanMs: 60000,
        measurement:
          'Committed service transactions; HTTP transport and authentication are outside scope.',
        captureSwitch:
          'Only the derived analytics writer triggers are disabled; original receipt, event, evidence and business triggers stay enabled.',
      },
      thresholds: {
        p95MaximumRatio: 1.1,
        minimumThroughputRatio: 0.95,
        maximumClosedBucketLagMs: 120000,
      },
      arms: [],
      lag: { status: 'not-started' },
    };
    const captureFiles = [
      'src/lib/liekan/upstream/collection-write.ts',
      'src/lib/liekan/upstream/collection-identity.ts',
      'src/queries/sql/events/saveEvent.ts',
      'src/lib/liekan/log-ingestion/service.ts',
      'src/lib/liekan/log-ingestion/crawler-evidence.ts',
      'src/lib/liekan/upstream/log-geography.ts',
      'src/lib/liekan/upstream/server.ts',
      'src/lib/liekan/upstream/analysis-rollups.ts',
      'src/lib/liekan/upstream/analysis-rollups-model.ts',
      'src/lib/liekan/upstream/analysis-rollups-db.ts',
      'src/lib/liekan/upstream/analysis-rollups-worker.ts',
      'src/lib/liekan/upstream/analysis-rollups-discovery.ts',
      'src/lib/liekan/upstream/analysis-background.ts',
      'src/lib/liekan/upstream/analysis-build-queue.ts',
      'src/liekan-worker/analytics.ts',
      'src/liekan-worker/analytics-main.ts',
      ...[
        '037_analytics_rollups.sql',
        '037_browser_population.sql',
        '038_analytics_visits.sql',
        '039_analytics_query_jobs.sql',
        '040_analytics_expansion_probes.sql',
        '041_analytics_capture_cost.sql',
        '042_analytics_epoch_fence.sql',
        '043_analytics_capture_plans.sql',
        '044_analytics_discovery_rotation.sql',
        '045_analytics_visit_guards.sql',
        '046_analytics_visit_guard_schema.sql',
        '047_analytics_browser_population.sql',
        '048_analytics_revenue_proof.sql',
      ].map(name => `db/liekan/migrations/${name}`),
      'src/lib/liekan/upstream/analysis-capture.benchmark.test.ts',
      'tests/liekan/analysis-rollups.integration.mjs',
      'src/test/analysis-capture-statistics.mjs',
    ];
    const sourceIdentity = async () =>
      Object.fromEntries(
        await Promise.all(
          captureFiles.map(async path => {
            const bytes = await readFile(path).catch(() => null);
            return [path, bytes ? createHash('sha256').update(bytes).digest('hex') : 'absent'];
          }),
        ),
      );
    result.sourceScope = {
      fullWorktreeFrozen: false,
      measuredSurfaces: await sourceIdentity(),
      identityScope:
        'Start/end hashes cover the listed capture, worker and harness surfaces. The pinned candidate image and revision identify the runtime; these hashes do not assert a full worktree freeze.',
    };
    result.runtime = (
      await q(
        `SELECT version() AS version,current_setting('shared_buffers') AS shared_buffers,current_setting('work_mem') AS work_mem,current_setting('maintenance_work_mem') AS maintenance_work_mem,current_setting('max_parallel_maintenance_workers') AS max_parallel_maintenance_workers`,
      )
    )[0];
    result.runtime.dockerShmBytes = 256 * 1024 * 1024;
    try {
      await withPublishedRegistry(async catalog => {
        await sql(
          "INSERT INTO \"user\"(user_id,username,password,role) VALUES($1::uuid,$1::text,'fixture','user')",
          actor.userId,
        );
        type Fixture = { website: string; source: string; imported: string };
        const createFixture = async (name: string, baselineAccepted: number): Promise<Fixture> => {
          const website = randomUUID(),
            source = randomUUID(),
            imported = randomUUID();
          await sql(
            "INSERT INTO website(website_id,name,domain,user_id) VALUES($1::uuid,$2,'capture.invalid',$3::uuid)",
            website,
            name,
            actor.userId,
          );
          await sql('INSERT INTO liekan_log_state(website_id) VALUES($1::uuid)', website);
          await sql(
            `INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by,owner_id,state)
            VALUES($1::uuid,$2::uuid,'server','capture.invalid',$3::uuid,$3::uuid,'active')`,
            source,
            website,
            actor.userId,
          );
          await sql(
            `INSERT INTO liekan_log_interval(id,website_id,source_id,starts_at) VALUES($1::uuid,$2::uuid,$3::uuid,clock_timestamp()-interval '2 days')`,
            randomUUID(),
            website,
            source,
          );
          await sql(
            'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$1::text,$3,0)',
            imported,
            website,
            baselineAccepted,
          );
          return { website, source, imported };
        };
        const fixtures: Fixture[] = [];
        for (let arm = 0; arm < 5; arm++)
          fixtures.push(await createFixture('Synthetic capture fixture', baselineRows / 4));
        result.scope.fixtures = fixtures.map((fixture, index) => ({
          websiteId: fixture.website,
          baselineRows: baselineRows / 4,
          role:
            index === 0
              ? 'unused-matched-setup-site'
              : index === 4
                ? 'first-disabled-arm-and-full-cycle-calibration'
                : index === 3
                  ? 'final-disabled-arm'
                  : 'enabled-arm',
        }));
        await switchCapture(false);
        for (const fixture of fixtures)
          for (let offset = 0; offset < baselineRows / 4; offset += 2000)
            await sql(
              `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification)
       SELECT gen_random_uuid()::text,$1::uuid,$2::uuid,timestamptz '2026-01-01Z'+n*interval '1 second','/synthetic','GET',200,0,'','','Synthetic','','其他','','其他','unverified' FROM generate_series($3::int,least($3::int+1999,$4::int-1)) n`,
              fixture.website,
              fixture.imported,
              offset,
              baselineRows / 4,
            );
        const online = async (website: string, at = new Date()) => {
          const sessionId = randomUUID(),
            eventId = randomUUID();
          const identity: CollectionIdentity = {
            scope: 'browser',
            available: true,
            version: COLLECTION_IDENTITY_VERSION,
            sessionId,
            browser: 'Synthetic',
            os: 'Synthetic',
            device: 'desktop',
            screen: '1920x1080',
            language: 'en-US',
            originHostname: 'capture.invalid',
            distinctId: null,
            hostname: 'capture.invalid',
            classification: 'browser',
          };
          const input = {
            websiteId: website,
            eventId,
            fingerprint: eventId,
            identity,
            quality: {
              classification: 'browser' as const,
              source: 'browser' as const,
              reasons: ['synthetic'],
              ruleVersion: 'synthetic-capture',
              catalogVersion: catalog.version,
              rangeVersion: null,
              rangeStatus: 'missing' as const,
              hostname: 'capture.invalid',
            },
            geography: {
              location: { country: 'CN', region: 'CN-11', city: '北京市' },
              source: 'synthetic',
              trust: 'unverified' as const,
              ipFamily: 'missing' as const,
              precision: 'city' as const,
              reason: 'synthetic',
              ruleVersion: 'synthetic',
              dataVersion: null,
              cityId: null,
              accuracyRadius: null,
              countryBasis: 'missing' as const,
              processedAt: new Date().toISOString(),
              shadow: null,
            },
            observation: observeCollection(new Request('https://capture.invalid')),
          };
          const saved = await withCollectionWrite(input, async () => {
            const { collectionWriteClient } = await import('./collection-write');
            await collectionWriteClient().$executeRawUnsafe(
              "INSERT INTO session(session_id,website_id,browser) VALUES($1::uuid,$2::uuid,'Synthetic')",
              sessionId,
              website,
            );
            await recordCollectionIdentity(website, identity);
            return saveEvent({
              websiteId: website,
              sessionId,
              visitId: sessionId,
              eventType: 1,
              createdAt: at,
              hostname: 'capture.invalid',
              urlPath: '/synthetic-online',
              eventData: { synthetic: 'capture' },
            });
          });
          if (saved.status !== 'written') throw new Error('capture-write-not-committed');
        };
        const batch = async (
          fixture: (typeof fixtures)[number],
          at = new Date(Date.now() - 3600000),
          size = 2000,
          eventTimeSpanMs = 60000,
        ) => {
          const id = randomUUID(),
            rows = Array.from({ length: size }, (_, n) => ({
              id: randomUUID(),
              eventDigest: randomUUID(),
              time: new Date(+at + (eventTimeSpanMs ? (n % 60) * 1000 : 0)).toISOString(),
              path: `/synthetic/${n % 32}`,
              method: 'GET',
              status: 200,
              bytes: 0,
              ipMasked: '',
              ipHash: '',
              userAgent: 'Synthetic',
              location: '',
              bot: 'GPTBot',
              vendor: 'OpenAI',
              type: '训练',
              verification: 'unverified',
              aiEligible: true,
              recognitionState: 'recognized',
              classificationVersion: 'synthetic',
              crawlerId: catalog.payload.identities[0].id,
              catalogVersion: catalog.version,
            }));
          await sql(
            `INSERT INTO liekan_ingest_batch(id,website_id,source_id,epoch,digest,payload,received,valid,rejected)
         VALUES($1::uuid,$2::uuid,$3::uuid,1,$1::text,$4::jsonb,$5,$5,0)`,
            id,
            fixture.website,
            fixture.source,
            JSON.stringify(rows),
            size,
          );
          await processBatch(id);
          const [status] = await q('SELECT state FROM liekan_ingest_batch WHERE id=$1::uuid', id);
          if (status.state !== 'processed') throw new Error('capture-batch-not-committed');
        };
        type Sample = {
          type: 'online' | 'batch';
          offeredMs: number;
          websiteId: string;
          eventAtMs: number;
          startedMs: number;
          finishedAtMs?: number;
          elapsedMs: number;
          success: boolean;
          overlap: boolean;
          error?: string;
        };
        const paced = async (
          fixture: (typeof fixtures)[number],
          onlineRate: number,
          batchRate: number,
          batchCount: number,
          label: string,
          options: {
            targets?: Fixture[];
            live?: boolean;
            control?: { stop: boolean; active: Set<Sample>; samples: Sample[] };
            timeoutMs?: number;
          } = {},
        ) => {
          const armStarted = performance.now(),
            samples: Sample[] = options.control?.samples || [],
            timings = { online: [] as number[], batch: [] as number[] },
            failures: Record<string, number> = {},
            active = { online: new Set<Sample>(), batch: new Set<Sample>() },
            pending = new Set<Promise<void>>();
          const deadlineMs = options.timeoutMs || (batchCount / batchRate) * 1000 + 60000;
          const nextTarget = { online: 0, batch: 0 };
          const stopped = () => deadlineExceeded || Boolean(options.control?.stop);
          let deadlineExceeded = false,
            schedulingDone = false,
            cancelError: string;
          const admit = (type: 'online' | 'batch', offeredMs: number) => {
            const other = type === 'online' ? 'batch' : 'online';
            const target =
              options.targets?.[nextTarget[type]++ % options.targets.length] || fixture;
            const sample: Sample = {
              type,
              offeredMs,
              websiteId: target.website,
              eventAtMs: Date.now() - (type === 'batch' && !options.live ? 3600000 : 0),
              startedMs: performance.now() - armStarted,
              elapsedMs: 0,
              success: false,
              overlap: active[other].size > 0,
            };
            samples.push(sample);
            if (active[type].size >= (type === 'online' ? 32 : 2)) {
              sample.error = 'offered-capacity-exceeded';
              failures[`${type}:${sample.error}`] = (failures[`${type}:${sample.error}`] || 0) + 1;
              return;
            }
            for (const item of active[other]) item.overlap = true;
            active[type].add(sample);
            options.control?.active.add(sample);
            const started = performance.now();
            const task = (async () => {
              try {
                await (type === 'online'
                  ? online(target.website, new Date(sample.eventAtMs))
                  : batch(target, new Date(sample.eventAtMs), 2000, options.live ? 0 : 60000));
                sample.success = true;
                timings[type].push(performance.now() - started);
              } catch (error) {
                sample.error = code(error);
                failures[`${type}:${sample.error}`] =
                  (failures[`${type}:${sample.error}`] || 0) + 1;
              } finally {
                sample.elapsedMs = performance.now() - started;
                active[type].delete(sample);
                sample.finishedAtMs = Date.now();
                options.control?.active.delete(sample);
              }
            })();
            pending.add(task);
            void task.finally(() => pending.delete(task));
          };
          const watchdog = setTimeout(async () => {
            deadlineExceeded = true;
            // The validated database belongs exclusively to this harness. Cancel blocked
            // original transactions so an overloaded fixture still has a bounded end.
            const connection = new URL(process.env.DATABASE_URL);
            connection.searchParams.delete('schema');
            const control = new Client({ connectionString: connection.toString() });
            try {
              await control.connect();
              await control.query(
                'SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
              );
            } catch (error) {
              cancelError = code(error);
            } finally {
              await control.end();
            }
          }, deadlineMs);
          try {
            await Promise.all([
              (async () => {
                for (
                  let index = 0;
                  (options.control || index < batchCount) && !stopped();
                  index++
                ) {
                  const at = (index * 1000) / batchRate;
                  await sleep(Math.max(0, armStarted + at - performance.now()));
                  if (!stopped()) admit('batch', at);
                }
                schedulingDone = true;
              })(),
              (async () => {
                for (
                  let index = 0;
                  !stopped() && (options.control || !schedulingDone || active.batch.size);
                  index++
                ) {
                  const at = (index * 1000) / onlineRate;
                  await sleep(Math.max(0, armStarted + at - performance.now()));
                  if (!stopped()) admit('online', at);
                }
              })(),
            ]);
            await Promise.all([...pending]);
          } finally {
            clearTimeout(watchdog);
          }
          const elapsedMs = performance.now() - armStarted;
          await progress('paced-complete', {
            label,
            elapsedMs,
            attempts: samples.length,
            failures,
            deadlineExceeded,
          });
          return {
            elapsedMs,
            timings,
            failures,
            samples,
            deadlineMs,
            deadlineExceeded,
            cancelError,
            onlineRate,
            batchRate,
            overlap: Object.fromEntries(
              ['online', 'batch'].map(type => {
                const all = samples.filter(sample => sample.type === type),
                  succeeded = all.filter(sample => sample.success);
                return [
                  type,
                  {
                    attempted: all.length,
                    committed: succeeded.length,
                    overlappingAttempts: all.filter(sample => sample.overlap).length,
                    overlappingCommitted: succeeded.filter(sample => sample.overlap).length,
                    committedFraction:
                      succeeded.filter(sample => sample.overlap).length / succeeded.length,
                  },
                ];
              }),
            ),
          };
        };
        await switchCapture(false);
        result.calibrations = [];
        let rates: { online: number; batch: number },
          firstMeasured: Awaited<ReturnType<typeof paced>>;
        for (let warm = 0; warm < 20; warm++) await online(fixtures[4].website);
        for (let warm = 0; warm < 3; warm++) await batch(fixtures[4]);
        await progress('arm-start', {
          arm: 0,
          capture: false,
          scope: fixtures[4].website,
          online: 10,
          batch: 1,
          calibration: true,
        });
        // The disabled baseline must sustain the same offered work used by all four arms.
        for (const candidate of [{ online: 10, batch: 1 }]) {
          const calibration = await paced(
            fixtures[4],
            candidate.online,
            candidate.batch,
            100,
            'full-cycle-disabled-calibration',
          );
          const sustainable =
            !calibration.deadlineExceeded &&
            !Object.keys(calibration.failures).length &&
            calibration.timings.batch.length === 100 &&
            p95(calibration.timings.batch) < 1000 / candidate.batch &&
            calibration.overlap.online.overlappingCommitted > 0 &&
            calibration.overlap.batch.overlappingCommitted > 0;
          result.calibrations.push({ ...calibration, sustainable });
          await save('capture-benchmark.json', result);
          if (sustainable) {
            rates = candidate;
            firstMeasured = calibration;
            break;
          }
        }
        if (!rates) throw new Error('capture-disabled-calibration-unsustainable');
        result.scope.calibrationReusedAsFirstDisabledArm = true;
        result.scope.onlineOfferedPerSecond = rates.online;
        result.scope.batchOfferedPerSecond = rates.batch;
        result.scope.scopeOfThreshold =
          'Only the recorded sustainable offered rates and tested synthetic population.';
        await progress('calibration-complete', rates);
        for (let arm = 0; arm < 4; arm++) {
          const on = arm === 1 || arm === 2,
            fixture = fixtures[arm === 0 ? 4 : arm];
          if (arm > 0) {
            await switchCapture(on);
            // Warm original paths before the measured fixed-rate concurrent workload.
            for (let warm = 0; warm < 20; warm++) await online(fixture.website);
            for (let warm = 0; warm < 3; warm++) await batch(fixture);
            await progress('arm-start', { arm, capture: on, scope: fixture.website, ...rates });
          }
          const measured =
            arm === 0
              ? firstMeasured
              : await paced(fixture, rates.online, rates.batch, 100, `arm-${arm}`);
          const { elapsedMs, timings, failures } = measured;
          const [atomic] = await q(
            `SELECT
         (SELECT count(*)::int FROM website_event WHERE website_id=$1::uuid) AS events,
         (SELECT count(*)::int FROM liekan_event_quality WHERE website_id=$1::uuid) AS quality,
         (SELECT count(*)::int FROM liekan_event_geography WHERE website_id=$1::uuid) AS geography,
         (SELECT count(*)::int FROM liekan_collection_receipt WHERE website_id=$1::uuid AND event_id IS NOT NULL) AS receipts,
         (SELECT count(*)::int FROM liekan_event_observation WHERE website_id=$1::uuid) AS observations,
         (SELECT count(*)::int FROM liekan_event_environment WHERE website_id=$1::uuid AND scope='browser' AND identity_available) AS environments,
         (SELECT count(*)::int FROM liekan_session_source WHERE website_id=$1::uuid AND source='browser' AND scope='browser' AND identity_available) AS sources,
         (SELECT count(*)::int FROM liekan_geographic_website_event WHERE website_id=$1::uuid) AS eligible,
         (SELECT count(*)::int FROM liekan_geographic_website_event WHERE website_id=$1::uuid AND liekan_identity_available) AS qualified`,
            fixture.website,
          );
          const atomicConsistent =
            atomic.events === timings.online.length + 20 &&
            [
              'quality',
              'geography',
              'receipts',
              'observations',
              'environments',
              'sources',
              'eligible',
              'qualified',
            ].every(field => atomic[field] === atomic.events);
          const attempts = Object.fromEntries(
            ['online', 'batch'].map(type => [
              type,
              timings[type].length +
                Object.entries(failures)
                  .filter(([key]) => key.startsWith(type + ':'))
                  .reduce((sum, [, n]) => sum + n, 0),
            ]),
          );
          const state = await q(
            `SELECT c.relname AS table_name,t.tgname,t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=current_schema() AND p.proname LIKE 'liekan_analysis_%' AND c.relname=ANY($1::text[])`,
            [...new Set(triggers.map(t => t.table_name))],
          );
          result.arms.push({
            arm,
            capture: on,
            website: fixture.website,
            elapsedMs,
            samples: measured.samples,
            overlap: measured.overlap,
            deadlineMs: measured.deadlineMs,
            deadlineExceeded: measured.deadlineExceeded,
            cancelError: measured.cancelError,
            successes: { online: timings.online.length, batch: timings.batch.length },
            failures,
            atomic,
            atomicConsistent,
            attempts,
            successRate: {
              online: timings.online.length / attempts.online,
              batch: timings.batch.length / attempts.batch,
            },
            inputPerSecond: {
              online: (attempts.online * 1000) / elapsedMs,
              batchRows: (attempts.batch * 2000 * 1000) / elapsedMs,
            },
            triggerState: state,
            online: {
              ...counts(timings.online),
              samplesMs: timings.online,
              perSecond: (timings.online.length * 1000) / elapsedMs,
            },
            batch: {
              ...counts(timings.batch),
              samplesMs: timings.batch,
              perSecond: (timings.batch.length * 1000) / elapsedMs,
              rowsPerSecond: (timings.batch.length * 2000 * 1000) / elapsedMs,
            },
          });
          await save('capture-benchmark.json', result);
          await progress('arm-complete', {
            arm,
            elapsedMs,
            online: timings.online.length,
            batch: timings.batch.length,
            failures,
          });
        }
        for (const type of ['online', 'batch']) {
          const disabled = result.arms.filter((arm: any) => !arm.capture),
            active = result.arms.filter((arm: any) => arm.capture);
          const aggregate = (arms: any[]) => ({
            p95Ms: p95(arms.flatMap(arm => arm[type].samplesMs)),
            perSecond:
              (arms.reduce((n, arm) => n + arm.successes[type], 0) * 1000) /
              arms.reduce((n, arm) => n + arm.elapsedMs, 0),
            samples: arms.reduce((n, arm) => n + arm.successes[type], 0),
          });
          const off = aggregate(disabled),
            on = aggregate(active),
            p95Ratio = on.p95Ms / off.p95Ms,
            throughputRatio = on.perSecond / off.perSecond;
          result[type] = {
            disabled: off,
            enabled: on,
            p95Ratio,
            throughputRatio,
            passed:
              p95Ratio <= 1.1 && throughputRatio >= 0.95 && off.samples >= 200 && on.samples >= 200,
          };
        }
        await restore();
        const fixture = fixtures[2],
          lagFixtures: Fixture[] = [];
        for (let site = 0; site < 20; site++)
          lagFixtures.push(await createFixture(`Synthetic natural-closure lag ${site + 1}`, 0));
        const [backlog] = await q(
          `SELECT
          (SELECT coalesce(sum(inserted),0)::text FROM liekan_ingest_batch WHERE website_id=ANY($1::uuid[])) AS capturedAutomaticRows,
          (SELECT count(*)::text FROM liekan_analysis_manifest) AS publishedManifests,
          (SELECT count(*)::text FROM liekan_analysis_build WHERE status IN('queued','running')) AS activeBuilds`,
          [fixtures[1].website, fixtures[2].website],
        );
        const [{ now: beforeWait }] = await q<{ now: Date }[]>('SELECT clock_timestamp() AS now');
        const naturalBucket = new Date((Math.floor(+beforeWait / 300000) + 1) * 300000),
          naturalEnd = new Date(+naturalBucket + 300000);
        result.lag = {
          status: 'waiting-natural-boundary',
          retainedBacklog: backlog,
          samplePopulation: {
            sites: 20,
            timeBuckets: 1,
            unit: 'distinct owned website and common naturally closing UTC five-minute bucket',
            correlation:
              'All sites share one closure time, PostgreSQL and the single production worker; these are not twenty independent time periods.',
            baselineRowsPerNewSite: 0,
            websites: lagFixtures.map(item => item.website),
          },
          expectedBucketStart: naturalBucket,
          expectedBucketEnd: naturalEnd,
          waitStartedAt: beforeWait,
        };
        await save('capture-benchmark.json', result);
        await progress('lag-wait-natural-boundary', {
          bucket: naturalBucket.toISOString(),
          end: naturalEnd.toISOString(),
          retainedBacklog: backlog,
        });
        for (;;) {
          const [{ now }] = await q<{ now: Date }[]>('SELECT clock_timestamp() AS now');
          if (+now >= +naturalBucket) break;
          await sleep(Math.min(1000, +naturalBucket - +now));
        }
        // No worker or manual build drains the retained backlog before the real boundary.
        // Sharing only the owned PG network namespace keeps worker /tmp private.
        await assertOwner(pgContainer);
        const start = Date.now();
        await docker([
          'run',
          '--detach',
          '--name',
          workerName,
          '--cpus=1',
          '--memory=512m',
          '--label',
          `${ownerLabel}=${owner}`,
          '--network',
          `container:${pgContainer}`,
          '--env-file',
          workerEnv,
          '--entrypoint',
          'node',
          imageId,
          'dist/liekan-analytics-worker.mjs',
        ]);
        workerCreated = true;
        await assertOwner(workerName);
        const workerHostConfig = JSON.parse(
          await docker(['inspect', '--format', '{{json .HostConfig}}', workerName]),
        );
        const workerBudget = {
          NanoCpus: workerHostConfig.NanoCpus,
          Memory: workerHostConfig.Memory,
          NetworkMode: workerHostConfig.NetworkMode,
        };
        result.workerBudget = workerBudget;
        await save('capture-worker-budget.json', workerBudget);
        if (workerBudget.NanoCpus !== 1000000000 || workerBudget.Memory !== 536870912)
          throw new Error('capture-worker-resource-budget-mismatch');
        for (;;) {
          lastHeartbeat = await readHeartbeat();
          if (Number(lastHeartbeat) >= start) break;
          if (!(await workerAlive()) || Date.now() - start > 30000)
            throw new Error('capture-worker-start-failed');
          await sleep(250);
        }
        result.lag = {
          ...result.lag,
          status: 'running',
          workerContainer: workerName,
          candidate: JSON.parse(await readFile(`${folder}/candidate.json`, 'utf8')),
          entrypoint: 'node dist/liekan-analytics-worker.mjs',
          networkMode: `container:${pgContainer}`,
          resources: workerBudget,
          heartbeatStartedAt: Number(lastHeartbeat),
          discoveryIntervalMs: 5000,
          pollingIntervalMs: 1000,
          closeBufferMs: 30000,
        };
        const [{ now }] = await q<{ now: Date }[]>('SELECT clock_timestamp() AS now');
        const bucket = naturalBucket,
          end = naturalEnd;
        if (+now >= +end - 60000) throw new Error('capture-lag-worker-start-too-late');
        const visitEnd = new Date(Math.floor(+now / 3600000) * 3600000),
          visitStart = new Date(+visitEnd - 3600000);
        await online(fixture.website, new Date(+visitStart + 1000));
        const visitCommittedAt = Date.now();
        result.lag.visitCorrection = {
          bucketStart: visitStart,
          bucketEnd: visitEnd,
          committedAt: new Date(visitCommittedAt),
          status: 'pending',
          kind: 'late-correction-of-confirmed-closed-hour',
        };
        const checkVisit = async () => {
          if (result.lag.visitCorrection.readyAt) return;
          const [check] = await q<{ now: Date; current: boolean }[]>(
            `SELECT clock_timestamp() AS now,EXISTS(
           SELECT 1 FROM liekan_analysis_manifest m JOIN liekan_analysis_site s USING(website_id,epoch)
           WHERE m.website_id=$1::uuid AND m.family='visit' AND m.bucket<=$2 AND m.bucket_end>=$3
           AND m.fingerprint=liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,m.bucket,m.bucket_end)
           AND m.versions=liekan_analysis_versions(m.website_id,$4,$5,$6)) AS current`,
            fixture.website,
            visitStart,
            visitEnd,
            ANALYSIS_ROLLUP_VERSION,
            (await import('./traffic-query')).TRAFFIC_POLICY_VERSION,
            (await import('../rules/population')).CRAWLER_POPULATION_VERSION,
          );
          if (check.current) {
            result.lag.visitCorrection.delayMs = +check.now - visitCommittedAt;
            result.lag.visitCorrection.status =
              result.lag.visitCorrection.delayMs <= 120000 ? 'passed' : 'failed';
            result.lag.visitCorrection.readyAt = check.now;
          } else if (+check.now - visitCommittedAt > 120000) {
            result.lag.visitCorrection.status = 'failed';
            result.lag.visitCorrection.delayMs = null;
            result.lag.visitCorrection.censoredAfterMs = +check.now - visitCommittedAt;
          }
        };
        result.lag.bucketStart = bucket;
        result.lag.bucketEnd = end;
        result.lag.samples = lagFixtures.map(item => ({
          websiteId: item.website,
          bucketStart: bucket,
          bucketEnd: end,
          delayMs: null as number | null,
          readyAt: null as Date | null,
          censoredAfterMs: null as number | null,
        }));
        result.lag.offered = {
          onlinePerSecond: rates.online,
          batchesPerSecond: rates.batch,
          rowsPerBatch: 2000,
          onlineInFlightLimit: 32,
          batchInFlightLimit: 2,
          eventTimeSpanMs: 0,
          distribution:
            'Independent round-robin streams over twenty sites; total calibrated envelope is unchanged.',
        };
        const control = { stop: false, active: new Set<Sample>(), samples: [] as Sample[] };
        const loadStartedAt = Date.now();
        result.lag.loadStartedAt = new Date(loadStartedAt);
        const pressure = paced(
          lagFixtures[0],
          rates.online,
          rates.batch,
          0,
          'lag-same-calibrated-envelope',
          {
            targets: lagFixtures,
            live: true,
            control,
            timeoutMs: Math.max(60000, +end + 180000 - Date.now()),
          },
        );
        await progress('lag-start', {
          bucket: bucket.toISOString(),
          end: end.toISOString(),
          sites: 20,
          offered: result.lag.offered,
        });
        const allSites = [
          ...fixtures.map(item => item.website),
          ...lagFixtures.map(item => item.website),
        ];
        let lastSnapshot = 0;
        const snapshotLag = async () => {
          if (Date.now() - lastSnapshot < 10000) return;
          lastSnapshot = Date.now();
          try {
            const builds = await q(
              `SELECT id,website_id,family,status,work_done::text,work_total::text,checkpoint,attempts,error_code,next_attempt_at,lease_until,updated_at
              FROM liekan_analysis_build WHERE website_id=ANY($1::uuid[]) ORDER BY updated_at DESC LIMIT 64`,
              allSites,
            );
            const queue = await q(
              `SELECT state::text AS state,count(*)::text FROM liekan_jobs.job WHERE name='liekan-analysis-build' GROUP BY state`,
            );
            const lease = await q(
              `SELECT epoch::text,lease_until,last_incremental_at,incremental_waiting_at,history_waiting_at FROM liekan_analysis_background_lease WHERE id`,
            );
            const heartbeatAt = Number(await readHeartbeat());
            const frame = {
              at: new Date(),
              builds,
              queue,
              lease,
              heartbeatAt,
              offered: control.samples.length,
              committed: control.samples.filter(item => item.success).length,
              active: control.active.size,
              ready: result.lag.samples.filter(item => item.readyAt).length,
            };
            await appendFile(`${folder}/capture-lag-progress.jsonl`, JSON.stringify(frame) + '\n', {
              mode: 0o600,
            });
          } catch (error) {
            await progress('lag-diagnostic-error', { error: code(error) });
          }
        };
        try {
          for (;;) {
            await checkVisit();
            if (!(await workerAlive())) throw new Error('capture-worker-exited');
            const [{ now: observedNow }] = await q<{ now: Date }[]>(
              'SELECT clock_timestamp() AS now',
            );
            await snapshotLag();
            if (+observedNow >= +end + 30000) {
              const pendingBeforeSnapshot = new Set(
                [...control.active]
                  .filter(item => item.eventAtMs < +end)
                  .map(item => item.websiteId),
              );
              const coverage = await q<{ website_id: string; now: Date; current: boolean }[]>(
                `WITH observed AS MATERIALIZED(SELECT clock_timestamp() AS now)
                SELECT site.website_id,observed.now,EXISTS(
                  SELECT 1 FROM liekan_analysis_manifest m JOIN liekan_analysis_site s USING(website_id,epoch)
                  WHERE m.website_id=site.website_id AND m.family='log' AND s.mode='live' AND m.bucket<=$2 AND m.bucket_end>=$3
                  AND m.fingerprint=liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,m.bucket,m.bucket_end)
                  AND m.versions=liekan_analysis_versions(m.website_id,$4,$5,$6)) AS current
                FROM unnest($1::uuid[]) site(website_id) CROSS JOIN observed`,
                lagFixtures.map(item => item.website),
                bucket,
                end,
                ANALYSIS_ROLLUP_VERSION,
                (await import('./traffic-query')).TRAFFIC_POLICY_VERSION,
                (await import('../rules/population')).CRAWLER_POPULATION_VERSION,
              );
              for (const sample of result.lag.samples) {
                const row = coverage.find(item => item.website_id === sample.websiteId);
                const pendingBeforeClose = [...control.active].some(
                  item => item.websiteId === sample.websiteId && item.eventAtMs < +end,
                );
                if (
                  !sample.readyAt &&
                  row.current &&
                  !pendingBeforeSnapshot.has(sample.websiteId) &&
                  !pendingBeforeClose
                ) {
                  sample.readyAt = row.now;
                  sample.delayMs = +row.now - +end;
                }
              }
              if (+observedNow >= +end + 120000 || result.lag.samples.every(item => item.readyAt)) {
                for (const sample of result.lag.samples)
                  if (!sample.readyAt)
                    sample.censoredAfterMs = Math.max(120000, +observedNow - +end);
                result.lag.observedUntil = observedNow;
                break;
              }
            }
            await sleep(1000);
          }
        } finally {
          control.stop = true;
          const measured = await pressure;
          result.lag.load = {
            elapsedMs: measured.elapsedMs,
            deadlineExceeded: measured.deadlineExceeded,
            failures: measured.failures,
            overlap: measured.overlap,
            samples: measured.samples,
            bySite: [],
            types: {},
          };
          for (const type of ['online', 'batch'] as const) {
            const offered = measured.samples.filter(item => item.type === type),
              committed = offered.filter(item => item.success),
              perSecond = (committed.length * 1000) / measured.elapsedMs,
              target = type === 'online' ? rates.online : rates.batch;
            result.lag.load.types[type] = {
              attempts: offered.length,
              committed: committed.length,
              failures: offered.length - committed.length,
              successRate: committed.length / offered.length,
              offeredPerSecond: (offered.length * 1000) / measured.elapsedMs,
              achievedPerSecond: perSecond,
              achievedRowsPerSecond: perSecond * (type === 'batch' ? 2000 : 1),
              configuredPerSecond: target,
              achievedRatio: perSecond / target,
              latency: counts(measured.timings[type]),
            };
          }
          for (const target of lagFixtures)
            result.lag.load.bySite.push({
              websiteId: target.website,
              onlineCommitted: measured.samples.filter(
                item => item.websiteId === target.website && item.type === 'online' && item.success,
              ).length,
              batchesCommitted: measured.samples.filter(
                item => item.websiteId === target.website && item.type === 'batch' && item.success,
              ).length,
            });
          result.lag.heartbeatLastAt = Number(await readHeartbeat());
          await snapshotLag();
          await save('capture-benchmark.json', result);
        }
        result.lag.statistics = summarizeClosedBucketLag(result.lag.samples);
        const populations = await q<{ website_id: string; raw_rows: string }[]>(
          `SELECT website_id,count(*)::text AS raw_rows FROM liekan_log
          WHERE website_id=ANY($1::uuid[]) AND created_at>=$2 AND created_at<$3 GROUP BY website_id`,
          lagFixtures.map(item => item.website),
          bucket,
          end,
        );
        for (const sample of result.lag.samples)
          sample.rawRowsInClosedBucket = Number(
            populations.find(item => item.website_id === sample.websiteId)?.raw_rows || 0,
          );
        result.lag.nonemptySamples = result.lag.samples.every(
          item => item.rawRowsInClosedBucket > 0,
        );
        result.lag.achievedCalibratedLoad =
          Object.values(result.lag.load.types).every(
            (item: any) => item.failures === 0 && item.achievedRatio >= 0.95,
          ) && !result.lag.load.deadlineExceeded;
        result.lag.status =
          result.lag.statistics.p95WithinBudget &&
          result.lag.nonemptySamples &&
          result.lag.achievedCalibratedLoad
            ? 'passed'
            : 'failed';
        result.success =
          result.online.passed &&
          result.batch.passed &&
          result.lag.status === 'passed' &&
          result.lag.visitCorrection.status === 'passed' &&
          result.arms.every(
            (arm: any) =>
              arm.atomicConsistent &&
              !arm.deadlineExceeded &&
              !Object.keys(arm.failures).length &&
              arm.overlap.online.overlappingCommitted >= 100 &&
              arm.overlap.batch.overlappingCommitted >= 100,
          ) &&
          result.lag.achievedCalibratedLoad;
        await save('capture-benchmark.json', result);
      });
    } finally {
      if (workerCreated) {
        await assertOwner(workerName);
        lastHeartbeat = await readHeartbeat();
        result.heartbeatStoppedAt = Number(lastHeartbeat);
        await docker(['stop', '--time', '15', workerName], false, 30000);
        result.workerStop = JSON.parse(
          await docker(['inspect', '--format', '{{json .State}}', workerName]),
        );
        result.workerStop.graceful = result.workerStop.ExitCode === 0 && !result.workerStop.Running;
        await save('capture-worker-state.json', result.workerStop);
        await writeFile(`${folder}/capture-worker.log`, await docker(['logs', workerName], true), {
          mode: 0o600,
        });
        result.success = Boolean(result.success && result.workerStop.graceful);
        await assertOwner(workerName);
        await docker(['rm', '--volumes', workerName]);
        result.workerContainerCleaned = true;
        result.heartbeatCleaned = true;
      }
      await restore();
      result.sourceScope.endMeasuredSurfaces = await sourceIdentity();
      result.sourceScope.measuredSurfacesUnchanged =
        JSON.stringify(result.sourceScope.measuredSurfaces) ===
        JSON.stringify(result.sourceScope.endMeasuredSurfaces);
      result.success = Boolean(result.success && result.sourceScope.measuredSurfacesUnchanged);
      await save('capture-benchmark.json', result);
    }
    expect(
      result.success,
      JSON.stringify({ online: result.online, batch: result.batch, lag: result.lag }),
    ).toBe(true);
  },
  7200000,
);
