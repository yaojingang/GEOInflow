import {
  testClickHouseURL,
  testPostgresPort,
  testPostgresPasswordFile,
} from './warehouse-test-target';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { Kafka, logLevel } from 'kafkajs';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { verifyWarehouseIdentity } from '../../src/lib/liekan/warehouse/installation-identity';
import { installWarehouse } from '../../src/lib/liekan/warehouse/installation';
import { TransitionService } from '../../src/lib/liekan/warehouse/transition-service';
import { TransitionCoordinator } from '../../src/lib/liekan/warehouse/transition-coordinator';
import { WarehouseQueue, inspectQueueTopic } from '../../src/lib/liekan/warehouse/transport';
import { assertTransitionMaintenance } from '../../src/lib/liekan/upstream/warehouse-maintenance';
assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_install_${Date.now()}`;
const freshRun = `${run}_fresh`;
const password = (await readFile(testPostgresPasswordFile, 'utf8')).trim();
const connection = { host: '127.0.0.1', port: testPostgresPort, user: 'liekan_ch_proto', password };
const url = (database: string) => {
  const u = new URL(`postgresql://127.0.0.1:${testPostgresPort}/${database}`);
  u.username = connection.user;
  u.password = password;
  return u.toString();
};
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' }),
  db = new ControlDatabase(url(run));
const chAdmin = createWarehouseClient({ url: testClickHouseURL }),
  ch = createWarehouseClient({ url: testClickHouseURL, database: run });
const queue = { brokers: ['127.0.0.1:29109'] },
  broker = new Kafka({ ...queue, logLevel: logLevel.NOTHING }).admin();
const options = {
  queue,
  inputTopic: run,
  resultTopic: `${run}_results`,
  partitions: 1,
  replicationFactor: 1,
};
const cases: object[] = [];
let replication: TransitionService;
let input: WarehouseQueue, prisma: any;
let freshDb: ControlDatabase, freshCH: ReturnType<typeof createWarehouseClient>;
async function verifyDaemon(file: string, healthVariable: string) {
  const health = resolve(`.local/ch-implementation/${run}-${file}.health.json`);
  const child = spawn(process.execPath, [`dist/${file}.mjs`], {
    env: {
      ...process.env,
      DATABASE_URL: url(run),
      LIEKAN_WAREHOUSE_TRANSITION: 'true',
      LIEKAN_ANALYTICS_BACKEND: 'postgres',
      LIEKAN_CLICKHOUSE_URL: testClickHouseURL,
      LIEKAN_CLICKHOUSE_DATABASE: run,
      LIEKAN_QUEUE_BROKERS: queue.brokers.join(','),
      [healthVariable]: health,
    },
    stdio: 'ignore',
  });
  const done = new Promise<number | null>(done => child.once('exit', done));
  try {
    let healthy = false;
    for (let i = 0; i < 150; i++) {
      try {
        const state = JSON.parse(await readFile(health, 'utf8'));
        if (state.healthy) {
          healthy = true;
          break;
        }
      } catch {}
      if (child.exitCode !== null) break;
      await delay(100);
    }
    assert.equal(healthy, true, `${file} health`);
  } finally {
    child.kill('SIGTERM');
    let timer: NodeJS.Timeout;
    const timeout = new Promise<'timeout'>(done => {
      timer = setTimeout(() => done('timeout'), 15000);
    });
    const code = await Promise.race([done, timeout]);
    clearTimeout(timer);
    if (code === 'timeout') {
      child.kill('SIGKILL');
      await done;
      throw new Error('warehouse-test-daemon-stop-timeout');
    }
    assert.equal(code, 0, `${file} graceful shutdown`);
  }
}
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${run}" TEMPLATE liekan_ch_catalog_20261103`);
  for (const file of (await readdir('db/liekan/migrations'))
    .filter(f => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) >= 57)
    .sort()) {
    const sql = await readFile(`db/liekan/migrations/${file}`, 'utf8');
    await db.transaction(async tx => {
      await tx.query(sql);
      await tx.query('INSERT INTO liekan_migration(name,checksum) VALUES($1,$2)', [
        file,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    });
  }
  await chAdmin.command({ query: `CREATE DATABASE "${run}"` });
  const site = randomUUID(),
    session = randomUUID(),
    event = randomUUID(),
    receipt = randomUUID();
  await db.transaction(async tx => {
    await tx.query(
      "INSERT INTO website(website_id,name,domain) VALUES($1,'Install fixture','install.invalid')",
      [site],
    );
    await tx.query('INSERT INTO session(session_id,website_id) VALUES($1,$2)', [session, site]);
    await tx.query(
      "INSERT INTO website_event(event_id,session_id,website_id,event_type,url_path,visit_id) VALUES($1,$2,$3,1,'/install',$2)",
      [event, session, site],
    );
    await tx.query(
      "INSERT INTO liekan_collection_receipt(website_id,client_event_id,event_id,payload_hash,collection_source,collection_scope) VALUES($1,$2,$3,$4,'browser','browser')",
      [site, receipt, event, 'a'.repeat(64)],
    );
  });
  await assert.rejects(
    () => installWarehouse(db, ch, { ...options, mode: 'fresh' }),
    /fresh-install-requires-empty-facts/,
  );
  assert.equal((await db.read('SELECT 1 FROM liekan_warehouse_installation')).length, 0);
  const installed = await installWarehouse(db, ch, { ...options, mode: 'pg-transition' });
  assert.equal(installed.authority, 'postgres');
  await verifyWarehouseIdentity(ch, installed.installationId);
  await assert.rejects(
    () => verifyWarehouseIdentity(ch, randomUUID(), true),
    /target-identity-mismatch/,
  );
  await verifyWarehouseIdentity(ch, installed.installationId);
  const resumed = await installWarehouse(db, ch, { ...options, mode: 'pg-transition' });
  assert.equal(resumed.installationId, installed.installationId);
  assert.equal(resumed.resumed, true);
  await verifyDaemon('liekan-warehouse-worker', 'LIEKAN_WAREHOUSE_HEALTH_FILE');
  await verifyDaemon('liekan-transition-worker', 'LIEKAN_TRANSITION_HEALTH_FILE');
  cases.push({
    name: 'compiled PG-authority consumer and continuous result replication daemons start healthy against isolated services and shut down cleanly',
    status: 'pass',
  });
  assert.equal(
    (await db.read<{ state: string }>('SELECT state FROM liekan_warehouse_transition'))[0].state,
    'capturing',
  );
  await assert.rejects(
    () => db.read('DELETE FROM website_event WHERE event_id=$1', [event]),
    /writer-fenced/,
  );
  assert.equal((await db.read('SELECT 1 FROM website_event WHERE event_id=$1', [event])).length, 1);
  cases.push({
    name: 'fresh mode refuses legacy facts; PG queue activation, capture and SQL writer fence commit atomically; installation resumes with original identity',
    status: 'pass',
  });
  replication = new TransitionService(db, ch, queue);
  assert.equal((await replication.tick()).state, 'awaiting-baseline');
  process.env.LIEKAN_WAREHOUSE_TRANSITION = 'true';
  for (const kind of ['repair', 'governance', 'risk', 'retention'] as const)
    await assert.rejects(
      () =>
        db.transaction(tx =>
          assertTransitionMaintenance(
            { $queryRawUnsafe: async (sql, ...values) => (await tx.query(sql, values)).rows },
            kind,
          ),
        ),
      /迁移/,
    );
  cases.push({
    name: 'production replicator awaits verified baseline; all PG maintenance mutations remain frozen during capture',
    status: 'pass',
  });
  const saved = randomUUID();
  await db.read(
    'INSERT INTO session_replay_saved(saved_replay_id,website_id,visit_id,name) VALUES($1,$2,$3,$4)',
    [saved, site, session, 'Legacy bookmark'],
  );
  input = new WarehouseQueue(queue, await inspectQueueTopic(queue, options.inputTopic));
  await input.connect();
  const coordinator = new TransitionCoordinator(db, input);
  const barrier = await coordinator.request('snapshot');
  await coordinator.freeze(barrier.operation_id);
  await assert.rejects(
    () => coordinator.resumeSnapshot(barrier.operation_id),
    /controls-not-ready/,
  );
  process.env.DATABASE_URL = url(run);
  const { prepareWarehouseMigrationControls } = await import(
    '../../src/lib/liekan/upstream/warehouse-migration-controls'
  );
  prisma = (await import('../../src/lib/prisma')).default;
  assert.equal((await prepareWarehouseMigrationControls(db, barrier.operation_id)).status, 'ready');
  await prepareWarehouseMigrationControls(db, barrier.operation_id);
  assert.deepEqual(
    (
      await db.read<{ session_id: string }>(
        'SELECT session_id FROM liekan_warehouse_replay_bookmark_owner WHERE saved_replay_id=$1',
        [saved],
      )
    )[0],
    { session_id: session },
  );
  await coordinator.resumeSnapshot(barrier.operation_id);
  cases.push({
    name: 'bound production snapshot cannot resume before idempotent business-control conversion preserves legacy replay ownership',
    status: 'pass',
  });
  await db.transaction(async tx => {
    await tx.query('SELECT liekan_warehouse_prepare_removal($1,$2)', [site, 'website']);
    await tx.query('DELETE FROM website_event WHERE website_id=$1', [site]);
    await tx.query('DELETE FROM website WHERE website_id=$1', [site]);
  });
  const [deleted] = await db.read<{ authority: string; status: string }>(
    'SELECT authority,status FROM liekan_warehouse_deletion WHERE website_id=$1',
    [site],
  );
  assert.deepEqual(deleted, { authority: 'postgres', status: 'pending' });
  assert.deepEqual(
    (
      await db.read<{ session_id: string }>(
        'SELECT session_id FROM liekan_warehouse_pg_receipt_tombstone WHERE website_id=$1 AND client_event_id=$2',
        [site, receipt],
      )
    )[0],
    { session_id: session },
  );
  cases.push({
    name: 'PG parent cascade retains canonical UUID evidence and a durable PG-authority deletion before legacy fact cleanup',
    status: 'pass',
  });
  // A new resource after capture is registered before its first queue input.
  const next = randomUUID();
  await db.read(
    "INSERT INTO website(website_id,name,domain) VALUES($1,'New fixture','new.invalid')",
    [next],
  );
  assert.equal(
    (await db.read('SELECT 1 FROM liekan_warehouse_site WHERE website_id=$1', [next])).length,
    1,
  );
  await assert.rejects(() =>
    db.read(
      "INSERT INTO website(website_id,name,domain) VALUES($1,'Reuse fixture','reuse.invalid')",
      [site],
    ),
  );
  await broker.connect();
  await broker.deleteTopics({ topics: [options.inputTopic] });
  await assert.rejects(() => installWarehouse(db, ch, { ...options, mode: 'pg-transition' }));
  assert.equal((await broker.listTopics()).includes(options.inputTopic), false);
  cases.push({
    name: 'new resources register during PG capture, retired IDs cannot be reused, and a missing installed topic is never recreated',
    status: 'pass',
  });
  await admin.query(`CREATE DATABASE "${freshRun}" TEMPLATE liekan_ch_catalog_20261103`);
  freshDb = new ControlDatabase(url(freshRun));
  for (const file of (await readdir('db/liekan/migrations'))
    .filter(f => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) >= 57)
    .sort()) {
    const sql = await readFile(`db/liekan/migrations/${file}`, 'utf8');
    await freshDb.transaction(async tx => {
      await tx.query(sql);
      await tx.query('INSERT INTO liekan_migration(name,checksum) VALUES($1,$2)', [
        file,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    });
  }
  await chAdmin.command({ query: `CREATE DATABASE "${freshRun}"` });
  freshCH = createWarehouseClient({ url: testClickHouseURL, database: freshRun });
  const freshOptions = { ...options, inputTopic: freshRun, mode: 'fresh' as const };
  const interrupted = new Proxy(freshCH, {
    get(target, key) {
      if (key === 'command')
        return (args: any) => {
          if (args.query.includes('warehouse_installation_identity'))
            throw new Error('synthetic-binding-interruption');
          return target.command(args);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await assert.rejects(
    () => installWarehouse(freshDb, interrupted, freshOptions),
    /synthetic-binding-interruption/,
  );
  const [pending] = await freshDb.read<{
    authority: string;
    identity_bound: boolean;
    installation_id: string;
  }>('SELECT authority,identity_bound,installation_id FROM liekan_warehouse_installation');
  assert.equal(pending.authority, 'frozen');
  assert.equal(pending.identity_bound, false);
  const ready = await installWarehouse(freshDb, freshCH, freshOptions);
  assert.equal(ready.authority, 'clickhouse');
  assert.equal(ready.resumed, true);
  assert.equal(ready.installationId, pending.installation_id);
  assert.equal((await freshDb.read('SELECT 1 FROM liekan_warehouse_transition')).length, 0);
  await verifyWarehouseIdentity(freshCH, ready.installationId);
  cases.push({
    name: 'empty installation starts directly on CH without result capture; interruption after PG setup resumes the same identity before intake is enabled',
    status: 'pass',
  });
} catch (error) {
  cases.push({
    status: 'failed',
    error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
  });
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message.slice(0, 300) : 'unknown');
} finally {
  delete process.env.LIEKAN_WAREHOUSE_TRANSITION;
  await input?.close();
  await prisma?.client.$disconnect();
  await replication?.close();
  await broker.connect().catch(() => {});
  await broker
    .deleteTopics({ topics: [options.inputTopic, options.resultTopic, freshRun] })
    .catch(() => {});
  await Promise.allSettled([
    broker.disconnect(),
    db.close(),
    admin.end(),
    ch.close(),
    chAdmin.close(),
    freshDb?.close(),
    freshCH?.close(),
  ]);
  await writeFile(
    `.local/ch-implementation/${run}.json`,
    JSON.stringify(
      {
        run,
        additionalDatabases: [freshRun],
        cases,
        originalDatabaseTouched: false,
        fullUpgradeValidated: false,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      run,
      passed: cases.filter((c: any) => c.status === 'pass').length,
      failed: cases.filter((c: any) => c.status === 'failed').length,
    }),
  );
}
