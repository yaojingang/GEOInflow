import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2).filter(a => a !== '--');
const benchmark = args.includes('--benchmark');
const rowIndex = args.indexOf('--rows');
const rows = rowIndex >= 0 ? Number(args[rowIndex + 1]) : 1000000;
if (
  args.some((a, i) => !['--benchmark', '--rows'].includes(a) && i !== rowIndex + 1) ||
  ![1000000, 10000000].includes(rows)
)
  throw new Error('Usage: test:analytics-engine [--benchmark --rows 1000000|10000000]');
const root = fileURLToPath(new URL('../../', import.meta.url));
const id = randomUUID(),
  label = 'io.liekan.analytics-engine-test';
const names = [`liekan-engine-pg-${id}`, `liekan-engine-ch-${id}`];
const folder = `${root}.local/analytics-engine/${id}`;
await mkdir(folder, { recursive: true, mode: 0o700 });
const password = randomBytes(32).toString('hex');
const env = {
  ...process.env,
  CLICKHOUSE_URL: '',
  DATABASE_REPLICA_URL: '',
  REDIS_URL: '',
  LIEKAN_ANALYTICS_REDIS_URL: '',
  APP_SECRET: randomBytes(32).toString('hex'),
  LIEKAN_ANALYTICS_ENGINE_TEST: '1',
};
if (benchmark) env.LIEKAN_ANALYTICS_ENGINE_BENCHMARK_ROWS = String(rows);
let interrupted = false,
  active;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true;
    active?.kill('SIGTERM');
  });
async function run(binary, args, options = {}) {
  if (interrupted && !options.cleanup) throw new Error('Analytics engine tests interrupted');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    active = child;
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout || 180000);
    child.stdout.on('data', c => {
      output += c;
      if (benchmark) {
        for (const line of String(c).split('\n'))
          if (line.startsWith('ENGINE_BENCH ')) console.log(line);
      }
    });
    child.stderr.on('data', c => {
      output += c;
    });
    child.on('error', reject);
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      active = null;
      if ((code !== 0 || signal) && !options.optional) {
        await writeFile(`${folder}/failure.log`, output, { mode: 0o600 });
        reject(new Error(`Test command failed; private diagnostics: ${folder}/failure.log`));
      } else resolve({ code, output });
    });
    child.stdin.end(options.input);
  });
}
try {
  await writeFile(
    `${folder}/pg.env`,
    `POSTGRES_USER=engine_test\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=liekan_engine_test\n`,
    { mode: 0o600 },
  );
  await writeFile(
    `${folder}/ch.env`,
    `CLICKHOUSE_USER=engine_test\nCLICKHOUSE_PASSWORD=${password}\nCLICKHOUSE_DB=liekan_engine_test\n`,
    { mode: 0o600 },
  );
  await run('docker', [
    'run',
    '-d',
    '--name',
    names[0],
    '--label',
    `${label}=${id}`,
    '--env-file',
    `${folder}/pg.env`,
    '-p',
    '127.0.0.1::5432',
    'postgres:16-alpine',
  ]);
  await run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      names[1],
      '--label',
      `${label}=${id}`,
      '--cpus',
      '2',
      '--memory',
      '4g',
      '--env-file',
      `${folder}/ch.env`,
      '-p',
      '127.0.0.1::8123',
      'clickhouse/clickhouse-server:26.8.34.13',
    ],
    { timeout: 300000 },
  );
  const pgPort = (await run('docker', ['port', names[0], '5432/tcp'])).output
    .trim()
    .split(':')
    .at(-1);
  const chPort = (await run('docker', ['port', names[1], '8123/tcp'])).output
    .trim()
    .split(':')
    .at(-1);
  env.DATABASE_URL = `postgresql://engine_test:${password}@127.0.0.1:${pgPort}/liekan_engine_test?schema=engine_${id.replaceAll('-', '')}`;
  env.LIEKAN_ANALYTICS_CLICKHOUSE_URL = `http://engine_test:${password}@127.0.0.1:${chPort}/liekan_engine_test`;
  env.LIEKAN_ANALYTICS_ENGINE_OUTPUT = folder;
  env.LIEKAN_ENGINE_PG_CONTAINER = names[0];
  env.LIEKAN_ENGINE_CH_CONTAINER = names[1];
  await writeFile(
    `${folder}/runtime.env`,
    Object.entries(env)
      .filter(([k]) =>
        ['DATABASE_URL', 'LIEKAN_ANALYTICS_CLICKHOUSE_URL', 'APP_SECRET'].includes(k),
      )
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    { mode: 0o600 },
  );
  for (let i = 0; ; i++) {
    const ready = await run('docker', ['exec', names[0], 'pg_isready', '-U', 'engine_test'], {
      optional: true,
    });
    const ch = await fetch(`http://127.0.0.1:${chPort}/ping`)
      .then(r => r.ok)
      .catch(() => false);
    if (!ready.code && ch) break;
    if (i >= 60) throw new Error('Owned test databases did not become ready');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.log('Owned PostgreSQL16 and ClickHouse26.8 test databases ready');
  await run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
  await run(process.execPath, ['scripts/liekan-migrate.mjs']);
  await run(process.execPath, ['scripts/liekan-migrate.mjs']);
  const file = benchmark
    ? 'src/lib/liekan/upstream/analytics-engine.benchmark.test.ts'
    : 'src/lib/liekan/upstream/analytics-engine.integration.test.ts';
  const result = await run(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', file, '--maxWorkers=1'],
    { timeout: benchmark ? 7200000 : 180000 },
  );
  console.log(result.output);
  if (!benchmark && env.LIEKAN_ENGINE_VISUAL === '1') {
    const { verifyAnalyticsEngineUI } = await import('./analytics-engine.visual.mjs');
    const { verifyBudgetedAnalyticsWorker } = await import('./analytics-engine.worker-smoke.mjs');
    await verifyBudgetedAnalyticsWorker({
      root,
      env,
      folder,
      run,
      id,
      label,
      afterPublish: () => verifyAnalyticsEngineUI({ root, env, folder }),
    });
  }
} finally {
  for (const name of names) {
    const inspection = await run(
      'docker',
      ['inspect', '--format', `{{index .Config.Labels "${label}"}}`, name],
      { optional: true, cleanup: true },
    );
    if (!inspection.code && inspection.output.trim() === id)
      await run('docker', ['rm', '-fv', name], { optional: true, cleanup: true });
  }
}
