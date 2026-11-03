// Run install and the large signed demo separately so shared-host load stays bounded.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { testClickHouseURL } from './warehouse-test-target';
import { checkPassword, hashPassword } from '../../src/lib/password';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { seedWarehouseDemo } from '../../src/lib/liekan/warehouse/demo';
import { boundaryParameters, factRelation } from '../../src/lib/liekan/warehouse/read';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const stage = process.env.WAREHOUSE_FRESH_STAGE ?? 'install';
assert.ok(['install', 'demo'].includes(stage));
const directory = resolve('.local/ch-fresh-validation');
await mkdir(directory, { recursive: true, mode: 0o700 });
const stateFile = `${directory}/state.json`;
const state = await readFile(stateFile, 'utf8')
  .then(JSON.parse)
  .catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return {
      run: `warehouse_fresh_${Date.now()}`,
      secret: randomBytes(32).toString('hex'),
      steps: {},
    };
  });
assert.match(state.run, /^warehouse_fresh_\d+$/);
const save = () => writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
await save();
const password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const target = new URL(`postgresql://127.0.0.1:25459/${state.run}`);
target.username = 'liekan_ch_proto';
target.password = password;
const admin = new pg.Client({
  host: '127.0.0.1',
  port: 25459,
  user: 'liekan_ch_proto',
  password,
  database: 'liekan_ch_proto',
});
const db = new ControlDatabase(target.toString());
const chAdmin = createWarehouseClient({ url: testClickHouseURL });
const ch = createWarehouseClient({ url: testClickHouseURL, database: state.run });
const environment = {
  ...process.env,
  PATH: `${resolve('node_modules/.bin')}:${process.env.PATH}`,
  DATABASE_URL: target.toString(),
  DIRECT_DATABASE_URL: target.toString(),
  DATABASE_REPLICA_URL: '',
  SKIP_DB_CHECK: '',
  SKIP_DB_MIGRATION: '',
  APP_SECRET: state.secret,
  TWO_FACTOR_ENCRYPTION_KEY: state.secret,
  LIEKAN_ANALYTICS_BACKEND: 'clickhouse',
  LIEKAN_WAREHOUSE_TRANSITION: 'true',
  LIEKAN_CLICKHOUSE_URL: testClickHouseURL,
  LIEKAN_CLICKHOUSE_DATABASE: state.run,
  LIEKAN_CLICKHOUSE_USERNAME: 'default',
  LIEKAN_CLICKHOUSE_PASSWORD: '',
  CLICKHOUSE_URL: '',
  LIEKAN_QUEUE_BROKERS: '127.0.0.1:29109',
  LIEKAN_QUEUE_TOPIC: state.run,
  LIEKAN_RESULT_TOPIC: `${state.run}_results`,
  LIEKAN_QUEUE_PARTITIONS: '1',
  LIEKAN_INSTALL_MODE: 'fresh',
  LIEKAN_SEED_DEMO: 'false',
};
async function init(name: string) {
  const log = await open(`${directory}/${name}.log`, 'a', 0o600);
  try {
    const child = spawn('sh', ['scripts/liekan-warehouse-init.sh'], {
      env: environment,
      stdio: ['ignore', log.fd, log.fd],
    });
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    assert.equal(code, 0, `fresh ${name}; see private log`);
  } finally {
    await log.close();
  }
}
async function counts() {
  const site = 'b880cb21-e65a-4fdf-9c0e-3da5aed4e0fa';
  const [b] = await db.read<any>(
    'SELECT epoch,publication,deletion_revision FROM liekan_warehouse_site WHERE website_id=$1',
    [site],
  );
  const result: Record<string, number> = {};
  for (const family of ['session', 'website_event', 'liekan_log', 'liekan_crawler_evidence']) {
    const [row] = await ch
      .query({
        query: `SELECT count() AS n FROM ${factRelation(family)}`,
        query_params: boundaryParameters({
          websiteId: site,
          epoch: b.epoch,
          publication: b.publication,
          deletionRevision: b.deletion_revision,
        }),
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ n: string }>());
    result[family] = Number(row.n);
    assert.equal((await db.read<any>(`SELECT count(*)::text AS n FROM "${family}"`))[0].n, '0');
  }
  return result;
}
try {
  await admin.connect();
  if (!state.steps.databases) {
    // Never drop, reset or reuse an unrelated existing database.
    await admin.query(`CREATE DATABASE "${state.run}" TEMPLATE template0`);
    await chAdmin.command({ query: `CREATE DATABASE "${state.run}"` });
    state.steps.databases = true;
    await save();
  }
  if (stage === 'install') {
    await init('install');
    const [installation] = await db.read<any>(
      'SELECT authority,transition,facts_fenced,identity_bound FROM liekan_warehouse_installation WHERE id=1',
    );
    assert.deepEqual(installation, {
      authority: 'clickhouse',
      transition: 'none',
      facts_fenced: true,
      identity_bound: true,
    });
    assert.equal((await db.read('SELECT 1 FROM liekan_warehouse_transition')).length, 0);
    if (!state.steps.customized) {
      const [user] = await db.read<any>('SELECT username,password FROM "user"');
      assert.equal(user.username, 'admin');
      assert.ok(checkPassword('liekan', user.password));
      const customized = hashPassword('isolated-customized-password');
      await db.read('UPDATE "user" SET username=$1,password=$2', [
        'isolated-customized-admin',
        customized,
      ]);
      state.steps.customized = true;
      await save();
    }
    const before = await db.read(
      'SELECT user_id,username,password,role FROM "user" ORDER BY user_id',
    );
    await init('repeat');
    assert.deepEqual(
      await db.read('SELECT user_id,username,password,role FROM "user" ORDER BY user_id'),
      before,
    );
    state.steps.install = {
      passed: true,
      migrations: (await db.read<any>('SELECT count(*)::integer AS n FROM liekan_migration'))[0].n,
      customizedAdministratorPreserved: true,
    };
    await save();
    console.log(JSON.stringify({ stage, ...state.steps.install }));
  } else {
    assert.ok(state.steps.install?.passed, 'Run the install stage first');
    if (!state.steps.interrupted) {
      const stop = new AbortController();
      await assert.rejects(
        seedWarehouseDemo(db, ch, {
          secret: state.secret,
          signal: stop.signal,
          progress: () => stop.abort(),
        }),
        e => (e as Error).name === 'AbortError',
      );
      state.steps.interrupted = true;
      await save();
    }
    const result = await seedWarehouseDemo(db, ch, {
      secret: state.secret,
      progress: value => console.log(JSON.stringify(value)),
    });
    assert.ok(['created', 'existing'].includes(result.status));
    const manifest = JSON.parse(await readFile('scripts/liekan-demo-data/manifest.json', 'utf8'));
    const expected = {
      session: manifest.counts.session,
      website_event: manifest.counts.event,
      liekan_log: manifest.counts.log,
      liekan_crawler_evidence: manifest.counts.log,
    };
    assert.deepEqual(await counts(), expected);
    assert.equal((await seedWarehouseDemo(db, ch, { secret: state.secret })).status, 'existing');
    assert.deepEqual(await counts(), expected);
    const [website] = await db.read<any>(
      'SELECT w.name,w.domain,s.is_demo FROM website w JOIN liekan_setting s USING(website_id) WHERE w.website_id=$1',
      [manifest.websiteId],
    );
    assert.deepEqual(website, { name: manifest.name, domain: manifest.domain, is_demo: true });
    state.steps.demo = { passed: true, resumed: true, counts: expected, pgFacts: 0 };
    await save();
    console.log(JSON.stringify({ stage, ...state.steps.demo }));
  }
} finally {
  await Promise.allSettled([admin.end(), db.close(), ch.close(), chAdmin.close()]);
}
