#!/usr/bin/env node
// This harness owns only its randomly named, labelled PostgreSQL container.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { verifyAnalysisUpgradeHistories } from './analysis-upgrade-history.mjs';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const benchmark = args.includes('--benchmark');
const captureBenchmark = args.includes('--capture-benchmark');
const firstLoadBenchmark = args.includes('--first-load-benchmark');
const dashboardBenchmark = args.includes('--dashboard-benchmark') || firstLoadBenchmark;
let logRows = 9000000,
  browserRows = 9000;
const retainFixture = args.includes('--retain-fixture');
if (retainFixture && !firstLoadBenchmark)
  throw new Error('Retention requires --first-load-benchmark');
const scopeC = args.includes('--scope-c');
const scopeReads = args.includes('--scope-reads');
const scopeCapacity = args.includes('--scope-capacity');
if ([benchmark, captureBenchmark, dashboardBenchmark].filter(Boolean).length > 1)
  throw new Error('Select one benchmark mode');
let rows = 1000000,
  candidateImage = process.env.LIEKAN_TRAFFIC_IMAGE,
  baselineImage,
  distribution;
for (let index = 0; index < args.length; index++) {
  if (
    [
      '--benchmark',
      '--capture-benchmark',
      '--dashboard-benchmark',
      '--first-load-benchmark',
      '--retain-fixture',
      '--scope-c',
      '--scope-reads',
      '--scope-capacity',
    ].includes(args[index])
  )
    continue;
  if (args[index] === '--browser-rows' && args[index + 1]) {
    browserRows = Number(args[++index]);
    if (
      !firstLoadBenchmark ||
      !Number.isInteger(browserRows) ||
      browserRows < 900 ||
      browserRows > 90000 ||
      browserRows % 30
    )
      throw new Error('Browser auxiliary rows require a multiple of 30 from 900 to 90000');
    continue;
  }
  if (args[index] === '--log-rows' && args[index + 1]) {
    logRows = Number(args[++index]);
    if (
      !firstLoadBenchmark ||
      !Number.isInteger(logRows) ||
      logRows < 30000 ||
      logRows > 15000000 ||
      logRows % 30
    )
      throw new Error('First-load log rows require a multiple of 30 from 30000 to 15000000');
    continue;
  }
  if (args[index] === '--baseline-image' && args[index + 1]) {
    baselineImage = args[++index];
    continue;
  }
  if (args[index] === '--distribution' && args[index + 1]) {
    distribution = args[++index];
    continue;
  }
  if (args[index] === '--candidate-image' && args[index + 1]) {
    candidateImage = args[++index];
    continue;
  }
  if (args[index] === '--rows' && args[index + 1]) {
    rows = Number(args[++index]);
    continue;
  }
  throw new Error(
    'Usage: node tests/liekan/analysis-rollups.integration.mjs [--scope-c|--scope-reads|--scope-capacity|--benchmark|--capture-benchmark|--dashboard-benchmark --rows 10000|1000000|10000000|--first-load-benchmark --log-rows 30000|9000000 --browser-rows 900|9000|90000 --retain-fixture] [--candidate-image image] [--baseline-image image] [--distribution uniform|hotspot80]',
  );
}
if (
  (!benchmark && !captureBenchmark && !dashboardBenchmark && args.includes('--rows')) ||
  ![10000, 1000000, 10000000].includes(rows)
)
  throw new Error('Benchmark rows must be 10000 (smoke), 1000000, or 10000000');
if (
  (scopeC || scopeReads || scopeCapacity) &&
  (benchmark || captureBenchmark || dashboardBenchmark || baselineImage)
)
  throw new Error('Scoped correctness runs cannot include benchmarks');
if ([scopeC, scopeReads, scopeCapacity].filter(Boolean).length > 1)
  throw new Error('Select one correctness scope');
if (baselineImage && !dashboardBenchmark)
  throw new Error('--baseline-image requires --dashboard-benchmark');
if (distribution && (!dashboardBenchmark || !['uniform', 'hotspot80'].includes(distribution)))
  throw new Error('--distribution requires --dashboard-benchmark and uniform or hotspot80');
if (dashboardBenchmark && !firstLoadBenchmark && rows !== 10000 && !distribution)
  throw new Error(
    'Scale dashboard benchmarks require --distribution so each 1M/10M distribution owns a fresh database',
  );
if (
  (captureBenchmark || dashboardBenchmark) &&
  (!candidateImage || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]+$/.test(candidateImage))
)
  throw new Error('Production benchmark requires --candidate-image with the built candidate');
const root = fileURLToPath(new URL('../../', import.meta.url));
const runId = randomUUID();
const name = `liekan-analysis-rollups-${runId}`;
const label = 'io.liekan.analysis-rollups-test';
const workerName = `${name}-worker`;
const appName = `${name}-app`,
  baselineName = `${name}-baseline`;
const password = randomBytes(32).toString('hex');
const image = process.env.LIEKAN_ANALYSIS_ROLLUPS_PG_IMAGE || 'postgres:15-alpine';
if (!['postgres:15-alpine', 'postgres:16-alpine'].includes(image))
  throw new Error('Only PostgreSQL15/16 acceptance images are allowed');
const env = {
  ...process.env,
  DATABASE_URL: `postgresql://analysis_test:${password}@127.0.0.1:15462/liekan_analysis_rollups_test?schema=analysis_${runId.replaceAll('-', '')}`,
  LIEKAN_ANALYSIS_ROLLUPS_TEST: '1',
  APP_SECRET: randomBytes(32).toString('hex'),
  CLICKHOUSE_URL: '',
  DATABASE_REPLICA_URL: '',
  REDIS_URL: '',
  LIEKAN_ANALYTICS_REDIS_URL: '',
};
if (!benchmark && !captureBenchmark && !dashboardBenchmark)
  env.LIEKAN_C2_DATABASE_URL = env.DATABASE_URL;
const folder = `${root}/.local/analysis-rollups/${runId}`;
env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT = folder;
if (captureBenchmark || dashboardBenchmark) {
  env.LIEKAN_ANALYSIS_ROLLUPS_CONTAINER = name;
  env.LIEKAN_ANALYSIS_ROLLUPS_OWNER = runId;
  env.LIEKAN_ANALYSIS_ROLLUPS_WORKER = workerName;
  env.LIEKAN_ANALYSIS_ROLLUPS_WORKER_ENV = `${folder}/worker.env`;
  env.LIEKAN_ANALYSIS_DASHBOARD_APP = appName;
  env.LIEKAN_ANALYSIS_DASHBOARD_BASELINE = baselineName;
}
if (benchmark || captureBenchmark || dashboardBenchmark) {
  if (benchmark) env.LIEKAN_ANALYSIS_ROLLUPS_BENCHMARK = '1';
  if (captureBenchmark) env.LIEKAN_ANALYSIS_CAPTURE_BENCHMARK = '1';
  if (dashboardBenchmark) env.LIEKAN_ANALYSIS_DASHBOARD_BENCHMARK = '1';
  if (firstLoadBenchmark) {
    env.LIEKAN_ANALYSIS_FIRST_LOAD_BENCHMARK = '1';
    env.LIEKAN_ANALYSIS_FIRST_LOAD_LOG_ROWS = String(logRows);
    env.LIEKAN_ANALYSIS_FIRST_LOAD_BROWSER_ROWS = String(browserRows);
  }
  if (distribution) env.LIEKAN_ANALYSIS_DASHBOARD_DISTRIBUTION = distribution;
  env.LIEKAN_ANALYSIS_ROLLUPS_BENCHMARK_ROWS = String(rows);
}
let created = false;
let interrupted = false,
  active;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true;
    if (active) stopProcess(active, 'SIGTERM');
  });
function stopProcess(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
async function run(binary, args, options = {}) {
  if (interrupted && !options.cleanup) throw new Error('Analysis rollups acceptance interrupted');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: root,
      env: options.env || env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    active = child;
    const chunks = [];
    let size = 0;
    let forced;
    const stop = () => {
      stopProcess(child, 'SIGTERM');
      forced = setTimeout(() => stopProcess(child, 'SIGKILL'), 5000);
    };
    const timer = setTimeout(stop, options.timeout || 180000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size < 16 * 1024 * 1024) chunks.push(chunk);
      else stopProcess(child, 'SIGTERM');
    });
    // Commands can include credentials in diagnostics; retain them only in the protected run folder.
    const errors = [];
    child.stderr.on('data', chunk => {
      if (errors.length < 10000) errors.push(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error(`${binary} could not start`));
    });
    child.on('close', async code => {
      clearTimeout(timer);
      clearTimeout(forced);
      if (active === child) active = null;
      const output = Buffer.concat(chunks).toString();
      if (code !== 0 && !options.optional) {
        await writeFile(`${folder}/failure.log`, Buffer.concat([...chunks, ...errors]), {
          mode: 0o600,
        });
        reject(new Error(`${binary} exited ${code}; protected diagnostics: ${folder}/failure.log`));
      } else
        resolve({
          code,
          output:
            binary === 'docker' && args[0] === 'logs'
              ? Buffer.concat([...chunks, ...errors]).toString()
              : output,
        });
    });
    child.stdin.end(options.input);
  });
}
async function available() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(15462, '127.0.0.1', resolve);
  });
  await new Promise(resolve => server.close(resolve));
}
try {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await available();
  if (captureBenchmark || dashboardBenchmark) {
    if (captureBenchmark)
      await run('node', ['--test', 'tests/liekan/analysis-capture-statistics.test.mjs']);
    const inspected = await run('docker', [
      'image',
      'inspect',
      '--format',
      '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}',
      candidateImage,
    ]);
    const [id, revision] = inspected.output.trim().split(/\s+/);
    if (!/^sha256:[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{40}$/.test(revision))
      throw new Error('Capture candidate requires pinned image ID and revision metadata');
    env.LIEKAN_ANALYSIS_ROLLUPS_CANDIDATE_ID = id;
    if (dashboardBenchmark && baselineImage) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]+$/.test(baselineImage))
        throw new Error('Invalid baseline image');
      const baseline = await run('docker', [
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        baselineImage,
      ]);
      env.LIEKAN_ANALYSIS_DASHBOARD_BASELINE_ID = baseline.output.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(env.LIEKAN_ANALYSIS_DASHBOARD_BASELINE_ID))
        throw new Error('Invalid immutable baseline image');
    }
    await writeFile(
      `${folder}/candidate.json`,
      JSON.stringify(
        {
          image: candidateImage,
          id,
          revision,
          entrypoint: 'node dist/liekan-analytics-worker.mjs',
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const internal = new URL(env.DATABASE_URL);
    internal.port = '5432';
    await writeFile(
      `${folder}/worker.env`,
      `DATABASE_URL=${internal.toString()}\nAPP_SECRET=${env.APP_SECRET}\nDATABASE_REPLICA_URL=\nCLICKHOUSE_URL=\nREDIS_URL=\nLIEKAN_ANALYTICS_REDIS_URL=\nDISABLE_TELEMETRY=1\nNEXT_TELEMETRY_DISABLED=1\n`,
      { mode: 0o600 },
    );
  }
  await writeFile(
    `${folder}/database.env`,
    `POSTGRES_USER=analysis_test\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=liekan_analysis_rollups_test\n`,
    { mode: 0o600 },
  );
  await run('docker', [
    'run',
    '--detach',
    '--name',
    name,
    '--label',
    `${label}=${runId}`,
    '--shm-size',
    '256m',
    '--env-file',
    `${folder}/database.env`,
    '--publish',
    '127.0.0.1:15462:5432',
    ...(dashboardBenchmark
      ? ['--publish', '127.0.0.1::3000', '--publish', '127.0.0.1::3001', '--cpus=2', '--memory=2g']
      : []),
    image,
  ]);
  created = true;
  for (let attempt = 0; ; attempt++) {
    const ready = await run(
      'docker',
      ['exec', name, 'pg_isready', '-U', 'analysis_test', '-d', 'liekan_analysis_rollups_test'],
      { optional: true },
    );
    if (ready.code === 0) break;
    if (attempt >= 30) throw new Error('Isolated PostgreSQL readiness timed out');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.log('Isolated analysis rollups PostgreSQL ready');
  await writeFile(
    `${folder}/runtime.env`,
    `DATABASE_URL=${env.DATABASE_URL}\nLIEKAN_ANALYSIS_ROLLUPS_TEST=1\nAPP_SECRET=${env.APP_SECRET}\nCLICKHOUSE_URL=\n`,
    { mode: 0o600 },
  );
  console.log(`Protected environment: ${folder}/runtime.env`);
  await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy']);
  await run('node', ['scripts/liekan-migrate.mjs']);
  await run('node', ['scripts/liekan-migrate.mjs']);
  if (
    !benchmark &&
    !captureBenchmark &&
    !dashboardBenchmark &&
    !scopeC &&
    !scopeReads &&
    !scopeCapacity
  ) {
    await verifyAnalysisUpgradeHistories({ run, env, folder });
    const browser = await run(
      'pnpm',
      ['exec', 'tsx', 'tests/liekan/browser-population.integration.ts'],
      { env: { ...env, LIEKAN_HUMAN_TEST_DATABASE_URL: env.DATABASE_URL } },
    );
    await writeFile(`${folder}/browser-population.log`, browser.output, { mode: 0o600 });
    const cases = Number(browser.output.match(/(\d+) integration cases passed/)?.[1]);
    if (!cases) throw new Error('Browser population integration did not run its cases');
    console.log(`Browser population and environment integration passed: ${cases} cases`);
  }
  await run('node', ['scripts/liekan-queue-bootstrap.mjs']);
  if (captureBenchmark) {
    const started = Date.now();
    await run('docker', [
      'run',
      '--detach',
      '--name',
      workerName,
      '--cpus=1',
      '--memory=512m',
      '--label',
      `${label}=${runId}`,
      '--network',
      `container:${name}`,
      '--env-file',
      `${folder}/worker.env`,
      '--entrypoint',
      'node',
      env.LIEKAN_ANALYSIS_ROLLUPS_CANDIDATE_ID,
      'dist/liekan-analytics-worker.mjs',
    ]);
    const budgetInspection = await run('docker', [
      'inspect',
      '--format',
      '{{json .HostConfig}}',
      workerName,
    ]);
    const workerBudget = JSON.parse(budgetInspection.output);
    await writeFile(
      `${folder}/worker-preflight-budget.json`,
      JSON.stringify(
        {
          NanoCpus: workerBudget.NanoCpus,
          Memory: workerBudget.Memory,
          NetworkMode: workerBudget.NetworkMode,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (workerBudget.NanoCpus !== 1000000000 || workerBudget.Memory !== 536870912)
      throw new Error('Capture worker production resource limits are missing');
    for (let attempt = 0; ; attempt++) {
      const heartbeat = await run(
        'docker',
        ['exec', workerName, 'cat', '/tmp/liekan-analytics-worker-heartbeat'],
        { optional: true },
      );
      if (heartbeat.code === 0 && Number(heartbeat.output.trim()) >= started) break;
      const running = await run(
        'docker',
        ['inspect', '--format', '{{.State.Running}}', workerName],
        { optional: true },
      );
      if (running.output.trim() !== 'true' || attempt >= 60) {
        const logs = await run('docker', ['logs', workerName], { optional: true });
        await writeFile(`${folder}/worker-preflight.log`, logs.output, { mode: 0o600 });
        throw new Error('Owned production worker preflight failed before capture measurements');
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await run('docker', ['stop', '--time', '15', workerName], { timeout: 30000 });
    const state = await run('docker', ['inspect', '--format', '{{json .State}}', workerName]);
    await writeFile(`${folder}/worker-preflight.json`, state.output, { mode: 0o600 });
    const final = JSON.parse(state.output);
    if (final.Running || final.ExitCode !== 0)
      throw new Error('Owned production worker preflight did not stop gracefully');
    const ownership = await run('docker', [
      'inspect',
      '--format',
      `{{ index .Config.Labels "${label}" }}`,
      workerName,
    ]);
    if (ownership.output.trim() !== runId)
      throw new Error('Capture worker ownership changed before preflight cleanup');
    await run('docker', ['rm', '--volumes', workerName]);
  }
  const files = firstLoadBenchmark
    ? ['src/lib/liekan/upstream/analysis-first-load.benchmark.test.ts']
    : dashboardBenchmark
      ? ['src/lib/liekan/upstream/analysis-dashboard.benchmark.test.ts']
      : captureBenchmark
        ? ['src/lib/liekan/upstream/analysis-capture.benchmark.test.ts']
        : benchmark
          ? ['src/lib/liekan/upstream/analysis-rollups.benchmark.test.ts']
          : scopeCapacity
            ? [
                'src/lib/liekan/upstream/analysis-capacity.integration.test.ts',
                'src/lib/liekan/upstream/analysis-queries.integration.test.ts',
              ]
            : scopeReads
              ? [
                  'src/lib/liekan/upstream/analysis-queries.integration.test.ts',
                  'src/lib/liekan/upstream/dashboard-snapshots.integration.test.ts',
                  'src/lib/liekan/upstream/dashboard-scheduling.integration.test.ts',
                  'src/lib/liekan/upstream/report-fragments.integration.test.ts',
                  'src/lib/liekan/upstream/analytics-input-summary.integration.test.ts',
                ]
              : scopeC
                ? [
                    'src/lib/liekan/upstream/analysis-rollups.integration.test.ts',
                    'src/lib/liekan/upstream/analysis-capacity.integration.test.ts',
                    'src/lib/liekan/upstream/analysis-queries.integration.test.ts',
                    'src/lib/liekan/upstream/dashboard-snapshots.integration.test.ts',
                    'src/lib/liekan/upstream/dashboard-scheduling.integration.test.ts',
                    'src/lib/liekan/upstream/report-fragments.integration.test.ts',
                    'src/lib/liekan/upstream/analytics-input-summary.integration.test.ts',
                    'src/lib/liekan/upstream/bounded-browser-events.integration.test.ts',
                    'src/lib/liekan/upstream/visit-build-paging.integration.test.ts',
                  ]
                : [
                    'src/lib/liekan/upstream/analysis-ingestion.integration.test.ts',
                    'src/lib/liekan/upstream/analysis-revenue.integration.test.ts',
                    'src/lib/liekan/upstream/analysis-population.integration.test.ts',
                    'src/lib/liekan/upstream/analysis-rollups.integration.test.ts',
                    'src/lib/liekan/upstream/analysis-capacity.integration.test.ts',
                    'src/lib/liekan/upstream/analysis-queries.integration.test.ts',
                    'src/lib/liekan/upstream/dashboard-snapshots.integration.test.ts',
                    'src/lib/liekan/upstream/dashboard-scheduling.integration.test.ts',
                    'src/lib/liekan/upstream/bounded-browser-events.integration.test.ts',
                    'src/lib/liekan/upstream/browser-detail-facts.integration.test.ts',
                    'src/lib/liekan/upstream/report-fragments.integration.test.ts',
                    'src/lib/liekan/upstream/analytics-input-summary.integration.test.ts',
                    'src/lib/liekan/upstream/visit-build-paging.integration.test.ts',
                  ];
  await run(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      ...files,
      '--maxWorkers=1',
      '--reporter=json',
      `--outputFile=${folder}/vitest.json`,
    ],
    { timeout: benchmark || captureBenchmark || dashboardBenchmark ? 7200000 : 1200000 },
  );
  const report = JSON.parse(await readFile(`${folder}/vitest.json`, 'utf8'));
  if (
    !report.success ||
    report.numPassedTests < 1 ||
    report.testResults.some(
      suite => !suite.assertionResults?.some(test => test.status === 'passed'),
    )
  )
    throw new Error('A required PostgreSQL suite failed or did not execute');
  console.log(
    `Analysis rollups PostgreSQL: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ${report.numPendingTests} skipped`,
  );
  console.log(`Evidence: ${folder}/vitest.json`);
  if (captureBenchmark) console.log(`Capture evidence: ${folder}/capture-benchmark.json`);
  if (firstLoadBenchmark) console.log(`First-load evidence: ${folder}/first-load-benchmark.json`);
  if (dashboardBenchmark && !firstLoadBenchmark) {
    const measurement = JSON.parse(await readFile(`${folder}/dashboard-benchmark.json`, 'utf8'));
    console.log(
      `Dashboard mechanical execution complete; candidate performance targets passed: ${measurement.candidateTargetsPassed === true}; overall evidence gate passed: ${measurement.passed === true}`,
    );
    console.log(`Dashboard evidence: ${folder}/dashboard-benchmark.json`);
  }
  if (benchmark) {
    const measurements = JSON.parse(await readFile(`${folder}/benchmark.json`, 'utf8'));
    console.log(
      `Scale benchmark: ${measurements.population.totalRows} raw rows across10sites; ${measurements.population.selectedSiteRows} selected-site rows; ${measurements.samplesPerPath} logical-cold samples per path`,
    );
    console.log(
      `Measured read p95(ms): raw=${measurements.reads.raw.p95Ms}, covered=${measurements.reads.covered.p95Ms}; build(ms)=${measurements.build.elapsedMs}`,
    );
    console.log(`Benchmark evidence: ${folder}/benchmark.json`);
  }
} finally {
  // Re-read ownership before removing a resource, including an interrupted creation.
  if (captureBenchmark || dashboardBenchmark)
    for (const container of [workerName, appName, baselineName]) {
      const ownedWorker = await run(
        'docker',
        ['inspect', '--format', `{{ index .Config.Labels "${label}" }}`, container],
        { optional: true, cleanup: true },
      );
      if (ownedWorker.code === 0) {
        if (ownedWorker.output.trim() !== runId)
          throw new Error('Capture worker ownership changed; cleanup stopped');
        await run('docker', ['rm', '--force', '--volumes', container], { cleanup: true });
      }
    }
  const owned = await run(
    'docker',
    ['inspect', '--format', `{{ index .Config.Labels "${label}" }}`, name],
    { optional: true, cleanup: true },
  );
  if (owned.code === 0 && owned.output.trim() === runId) {
    if (retainFixture) console.log(`Owned database retained for rechecks: ${name}`);
    else await run('docker', ['rm', '--force', '--volumes', name], { cleanup: true });
  } else if (created) throw new Error('Isolated container ownership changed; cleanup stopped');
}
