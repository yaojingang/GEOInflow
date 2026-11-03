#!/usr/bin/env node
// The harness owns one randomly named PostgreSQL container and never joins a deployment database.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const id = randomUUID(),
  name = `liekan-robots-${id}`,
  password = randomBytes(32).toString('hex');
const folder = `${root}/.local/robots-tests/${id}`;
const env = {
  ...process.env,
  DATABASE_URL: `postgresql://robots_test:${password}@127.0.0.1:15441/liekan_robots_acceptance`,
  LIEKAN_ROBOTS_TEST: '1',
  APP_SECRET: randomBytes(32).toString('hex'),
  CLICKHOUSE_URL: '',
};
let created = false;
async function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [],
      errors = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? 180000);
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', async code => {
      clearTimeout(timer);
      if (code && !options.optional) {
        await writeFile(`${folder}/failure.log`, Buffer.concat([...output, ...errors]), {
          mode: 0o600,
        });
        reject(new Error(`Check exited ${code}; diagnostics: ${folder}/failure.log`));
      } else resolve({ code, output: Buffer.concat(output).toString() });
    });
  });
}
try {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(15441, '127.0.0.1', resolve);
  });
  await new Promise(resolve => socket.close(resolve));
  await writeFile(
    `${folder}/database.env`,
    `POSTGRES_USER=robots_test\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=liekan_robots_acceptance\n`,
    { mode: 0o600 },
  );
  await run('docker', [
    'run',
    '--detach',
    '--name',
    name,
    '--label',
    `io.liekan.robots-test=${id}`,
    '--env-file',
    `${folder}/database.env`,
    '--publish',
    '127.0.0.1:15441:5432',
    'postgres:15-alpine',
  ]);
  created = true;
  for (let attempt = 0; ; attempt++) {
    if (
      (
        await run(
          'docker',
          ['exec', name, 'pg_isready', '-U', 'robots_test', '-d', 'liekan_robots_acceptance'],
          { optional: true },
        )
      ).code === 0
    )
      break;
    if (attempt > 30) throw new Error('PostgreSQL readiness timed out');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
  await run(process.execPath, ['scripts/liekan-migrate.mjs']);
  await run(process.execPath, ['scripts/liekan-migrate.mjs']);
  await run(process.execPath, [
    'node_modules/vitest/vitest.mjs',
    'run',
    'src/lib/liekan/upstream/robots-management.integration.test.ts',
    '--maxWorkers=1',
    '--reporter=json',
    `--outputFile=${folder}/vitest.json`,
  ]);
  const report = JSON.parse(await readFile(`${folder}/vitest.json`, 'utf8'));
  if (!report.success || report.numPassedTests < 10 || report.numPendingTests)
    throw new Error(`Robots tests did not fully execute; inspect ${folder}/vitest.json`);
  console.log(
    `Robots PostgreSQL lifecycle: ${report.numPassedTests} passed. Migration applied twice without changes.`,
  );
} finally {
  if (created) {
    const owned = await run(
      'docker',
      ['inspect', '--format', '{{index .Config.Labels "io.liekan.robots-test"}}', name],
      { optional: true },
    );
    if (owned.output.trim() === id)
      await run('docker', ['rm', '--force', name], { optional: true });
  }
}
