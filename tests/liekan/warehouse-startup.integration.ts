// Vary only a new empty schema in the explicitly identified downloaded clone.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { assertWarehouseStartup } from '../../src/lib/liekan/warehouse/startup';

assert.equal(process.env.WAREHOUSE_FULL_UPGRADE_TEST, 'isolated-downloaded-clone');
const directory = '.local/ch-full-validation';
const workflow = JSON.parse(await readFile(`${directory}/workflow.json`, 'utf8'));
const url = new URL('postgresql://127.0.0.1:25469/liekan_full_test');
url.username = 'liekan_full_test';
url.password = (await readFile(`${directory}/pg-password`, 'utf8')).trim();
const client = new pg.Client({ connectionString: url.toString() });
const schema = `warehouse_startup_${Date.now()}`;
const cases: object[] = [];
const env: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: url.toString(),
  LIEKAN_ANALYTICS_BACKEND: '',
  LIEKAN_WAREHOUSE_TRANSITION: '',
  CLICKHOUSE_URL: '',
  DOTENV_CONFIG_PATH: '/dev/null',
};
async function compiled(file: string, environment: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [file], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => {
    output += b;
  });
  child.stderr.on('data', b => {
    output += b;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  clearTimeout(timer);
  assert.ok(!output.includes(url.password), 'Do not expose credentials');
  return { code, output };
}
try {
  await client.connect();
  assert.equal(
    (await client.query('SELECT installation_id FROM liekan_warehouse_installation WHERE id=1'))
      .rows[0].installation_id,
    workflow.steps.install.installationId,
  );
  await client.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('schema', schema);
  env.DATABASE_URL = url.toString();
  await assertWarehouseStartup(env);
  await assert.rejects(
    assertWarehouseStartup({ ...env, LIEKAN_ANALYTICS_BACKEND: 'clickhouse' }),
    /warehouse-startup-installation-required/,
  );
  await client.query(
    `CREATE TABLE "${schema}".liekan_warehouse_installation(id integer PRIMARY KEY)`,
  );
  await assertWarehouseStartup(env);
  cases.push({
    name: 'Legacy PG with absent or empty warehouse metadata starts; configured CH requires installation',
    status: 'pass',
  });
  await client.query(`INSERT INTO "${schema}".liekan_warehouse_installation VALUES(1)`);
  await assert.rejects(assertWarehouseStartup(env), /warehouse-runtime-configuration-missing/);
  await assert.rejects(
    assertWarehouseStartup({ ...env, LIEKAN_ANALYTICS_BACKEND: 'clickhouse' }),
    /warehouse-runtime-configuration-missing/,
  );
  const complete = {
    ...env,
    LIEKAN_ANALYTICS_BACKEND: 'clickhouse',
    LIEKAN_WAREHOUSE_TRANSITION: 'true',
    LIEKAN_CLICKHOUSE_URL: 'http://127.0.0.1:28149',
    LIEKAN_CLICKHOUSE_DATABASE: 'liekan_full_test',
    LIEKAN_QUEUE_BROKERS: '127.0.0.1:29109',
  };
  await assertWarehouseStartup(complete);
  await assert.rejects(
    assertWarehouseStartup({ ...complete, LIEKAN_CH_QUERY_MEMORY_BYTES: 'invalid' }),
    /warehouse-query-memory-invalid/,
  );
  for (const key of ['LIEKAN_CLICKHOUSE_URL', 'LIEKAN_CLICKHOUSE_DATABASE', 'LIEKAN_QUEUE_BROKERS'])
    await assert.rejects(
      assertWarehouseStartup({ ...complete, [key]: '' }),
      /warehouse-runtime-configuration-incomplete/,
    );
  await assert.rejects(
    assertWarehouseStartup({ ...complete, CLICKHOUSE_URL: 'http://127.0.0.1:1' }),
    /warehouse-upstream-configuration-conflict/,
  );
  cases.push({
    name: 'Installed warehouse requires complete routed configuration and rejects upstream conflicts',
    status: 'pass',
  });
  await assert.rejects(
    assertWarehouseStartup({ ...env, DATABASE_URL: 'credential-sentinel-invalid-url' }),
    e => {
      assert.equal((e as Error).message, 'warehouse-startup-invalid-database-url');
      return true;
    },
  );
  for (const file of [
    'dist/liekan-warehouse-start-check.mjs',
    'dist/liekan-worker.mjs',
    'dist/liekan-analytics-worker.mjs',
  ]) {
    const result = await compiled(file, env);
    assert.equal(result.code, 1, file);
    assert.match(result.output, /warehouse-runtime-configuration-missing/);
  }
  assert.equal((await compiled('dist/liekan-warehouse-start-check.mjs', complete)).code, 0);
  const invalidMemory = await compiled('dist/liekan-warehouse-start-check.mjs', {
    ...complete,
    LIEKAN_CH_QUERY_MEMORY_BYTES: 'invalid',
  });
  assert.equal(invalidMemory.code, 1);
  assert.match(invalidMemory.output, /warehouse-query-memory-invalid/);
  cases.push({
    name: 'Compiled app startup probe and both legacy workers fail before jobs on missing CH configuration; valid probe exits zero',
    status: 'pass',
  });
} catch (error) {
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
  process.exitCode = 1;
} finally {
  await client.end();
  await writeFile(
    `${directory}/artifacts/startup-guard.json`,
    JSON.stringify({ schema, cases }, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ cases }));
}
