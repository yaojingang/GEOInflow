// Run install and the large signed demo separately so shared-host load stays bounded.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  testClickHouseURL,
  testPostgresPort,
  testPostgresPasswordFile,
} from './warehouse-test-target';
import { checkPassword, hashPassword } from '../../src/lib/password';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { seedWarehouseDemo } from '../../src/lib/liekan/warehouse/demo';
import { boundaryParameters, factRelation } from '../../src/lib/liekan/warehouse/read';
import { factTables, identifier } from '../../src/lib/liekan/warehouse/catalog';
import { warehouseDemoFamily } from '../../src/lib/liekan/warehouse/demo-mapping';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const stage = process.env.WAREHOUSE_FRESH_STAGE ?? 'install';
assert.ok(['install', 'demo', 'restart'].includes(stage));
const directory = resolve(process.env.WAREHOUSE_FRESH_DIRECTORY ?? '.local/ch-fresh-validation');
assert.ok(
  directory.startsWith(`${resolve('.local')}/`),
  'fresh test output must stay within .local',
);
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
const password = (await readFile(testPostgresPasswordFile, 'utf8')).trim();
const target = new URL(`postgresql://127.0.0.1:${testPostgresPort}/${state.run}`);
target.username = 'liekan_ch_proto';
target.password = password;
const admin = new pg.Client({
  host: '127.0.0.1',
  port: testPostgresPort,
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
  for (const { name: family } of factTables) {
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
  } else if (stage === 'demo') {
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
    const format = await import(pathToFileURL(resolve('scripts/liekan-demo-format.mjs')).href);
    const fixture = await import(pathToFileURL(resolve('scripts/liekan-demo.mjs')).href);
    const expected: Record<string, number> = Object.fromEntries(
      factTables.map(table => [table.name, 0]),
    );
    for (const [kind, spec] of Object.entries(format.demoSpecs) as [string, any][]) {
      const family = warehouseDemoFamily(spec.table);
      if (family) expected[family] = manifest.counts[kind];
      else {
        const [row] = await db.read<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${identifier(spec.table)}${spec.global ? '' : ' WHERE website_id=$1'}`,
          spec.global ? [] : [manifest.websiteId],
        );
        assert.equal(Number(row.n), manifest.counts[kind], `complete demo metadata ${kind}`);
      }
    }
    for await (const [kind, row] of fixture.readDemoRecords())
      if (kind === 'session-data' && row.proof) expected.liekan_session_data_source++;
    assert.deepEqual(await counts(), expected);
    const [boundary] = await db.read<any>(
      'SELECT epoch,publication,deletion_revision FROM liekan_warehouse_site WHERE website_id=$1',
      [manifest.websiteId],
    );
    const replayParents = await ch
      .query({
        query: `SELECT visit_id,groupUniqArray(session_id) AS sessions FROM ${factRelation('session_replay')} GROUP BY visit_id`,
        query_params: boundaryParameters({
          websiteId: manifest.websiteId,
          epoch: boundary.epoch,
          publication: boundary.publication,
          deletionRevision: boundary.deletion_revision,
        }),
        format: 'JSONEachRow',
      })
      .then(result => result.json<{ visit_id: string; sessions: string[] }>());
    const parentByVisit = new Map(replayParents.map(row => [row.visit_id, row.sessions]));
    const bookmarkOwners = () =>
      db.read<{
        saved_replay_id: string;
        visit_id: string;
        session_id: string;
        owner_website_id: string;
      }>(
        `SELECT s.saved_replay_id,s.visit_id,o.session_id,o.website_id AS owner_website_id
      FROM session_replay_saved s LEFT JOIN liekan_warehouse_replay_bookmark_owner o USING(saved_replay_id)
      WHERE s.website_id=$1 ORDER BY s.saved_replay_id,o.session_id`,
        [manifest.websiteId],
      );
    const owners = await bookmarkOwners();
    assert.equal(owners.length, manifest.counts['saved-replay']);
    for (const owner of owners) {
      assert.equal(owner.owner_website_id, manifest.websiteId);
      assert.deepEqual(parentByVisit.get(owner.visit_id), [owner.session_id]);
    }
    assert.equal((await seedWarehouseDemo(db, ch, { secret: state.secret })).status, 'existing');
    assert.deepEqual(await counts(), expected);
    assert.deepEqual(await bookmarkOwners(), owners);
    const [website] = await db.read<any>(
      'SELECT w.name,w.domain,s.is_demo FROM website w JOIN liekan_setting s USING(website_id) WHERE w.website_id=$1',
      [manifest.websiteId],
    );
    assert.deepEqual(website, { name: manifest.name, domain: manifest.domain, is_demo: true });
    state.steps.demo = {
      passed: true,
      resumed: true,
      counts: expected,
      pgFacts: 0,
      replayBookmarkOwners: owners.length,
    };
    await save();
    console.log(JSON.stringify({ stage, ...state.steps.demo }));
  } else {
    assert.equal(
      state.steps.demo?.passed,
      true,
      'complete the isolated demo before restart verification',
    );
    const site = 'b880cb21-e65a-4fdf-9c0e-3da5aed4e0fa';
    const [before] = await db.read<any>('SELECT name FROM website WHERE website_id=$1', [site]);
    const priorCounts = await counts();
    await db.transaction(tx =>
      tx.query('UPDATE website SET name=$2 WHERE website_id=$1', [
        site,
        'Customized isolated demo',
      ]),
    );
    try {
      environment.LIEKAN_SEED_DEMO = 'true';
      await init('repeat-customized-demo');
      const [after] = await db.read<any>('SELECT name FROM website WHERE website_id=$1', [site]);
      assert.equal(after.name, 'Customized isolated demo');
      assert.deepEqual(await counts(), priorCounts);
      state.steps.restart = { passed: true, customizedDemoPreserved: true };
      await save();
      console.log(JSON.stringify({ stage, ...state.steps.restart }));
    } finally {
      await db.transaction(tx =>
        tx.query('UPDATE website SET name=$2 WHERE website_id=$1', [site, before.name]),
      );
    }
  }
} finally {
  await Promise.allSettled([admin.end(), db.close(), ch.close(), chAdmin.close()]);
}
