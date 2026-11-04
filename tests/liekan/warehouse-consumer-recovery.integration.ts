import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { Kafka, logLevel } from 'kafkajs';
import {
  testClickHouseURL,
  testPostgresPort,
  testPostgresPasswordFile,
} from './warehouse-test-target';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { initializeWarehouse } from '../../src/lib/liekan/warehouse/initialize';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { WarehouseControl } from '../../src/lib/liekan/warehouse/control';
import { WarehouseConsumer } from '../../src/lib/liekan/warehouse/consumer';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
import { factRelation, boundaryParameters } from '../../src/lib/liekan/warehouse/read';
import { WarehouseQueue, inspectQueueTopic } from '../../src/lib/liekan/warehouse/transport';
import { WarehouseConsumerSupervisor } from '../../src/lib/liekan/warehouse/consumer-supervisor';
import { receiptOutcome } from '../../src/lib/liekan/warehouse/landing';
import { routingKey, type InputEnvelope } from '../../src/lib/liekan/warehouse/routing';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_consumer_recovery_${Date.now()}`;
const password = (await readFile(testPostgresPasswordFile, 'utf8')).trim();
const connection = { host: '127.0.0.1', port: testPostgresPort, user: 'liekan_ch_proto', password };
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' });
const url = new URL(`postgresql://127.0.0.1:${testPostgresPort}/${run}`);
url.username = connection.user;
url.password = password;
const db = new ControlDatabase(url.toString()),
  control = new WarehouseControl(db);
const chAdmin = createWarehouseClient({ url: testClickHouseURL });
const ch = createWarehouseClient({
  url: testClickHouseURL,
  database: run,
  clickhouse_settings: { max_threads: 1, max_memory_usage: '268435456' },
});
const options = { brokers: ['127.0.0.1:29109'] };
const broker = new Kafka({ ...options, logLevel: logLevel.NOTHING }).admin();
const site = randomUUID(),
  health: any[] = [],
  cases: object[] = [];
let queue: WarehouseQueue, worker: WarehouseConsumer, supervisor: WarehouseConsumerSupervisor;
let starts = 0;
async function until(check: () => Promise<boolean>, label: string, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Bounded recovery wait: ${label}`);
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
  await initializeWarehouse(ch);
  await broker.connect();
  await broker.createTopics({
    waitForLeaders: true,
    topics: [
      {
        topic: run,
        numPartitions: 1,
        replicationFactor: 1,
        configEntries: [
          { name: 'retention.ms', value: '-1' },
          { name: 'retention.bytes', value: '-1' },
          { name: 'flush.messages', value: '1' },
        ],
      },
    ],
  });
  const installation = await inspectQueueTopic(options, run);
  queue = new WarehouseQueue(options, installation);
  await queue.connect();
  await db.transaction(async tx => {
    await tx.query(
      "INSERT INTO website(website_id,name,domain) VALUES($1,'Consumer recovery fixture','recovery.invalid')",
      [site],
    );
    await tx.query('INSERT INTO liekan_warehouse_site(website_id) VALUES($1)', [site]);
    await tx.query(
      "INSERT INTO liekan_warehouse_installation(id,installation_id,schema_version,routing_version,topic_name,topic_id,partition_count,authority,transition) VALUES(1,$1,2,1,$2,$3,1,'clickhouse','none')",
      [randomUUID(), run, installation.topicId],
    );
    await tx.query('INSERT INTO liekan_warehouse_partition(topic_id,partition) VALUES($1,0)', [
      installation.topicId,
    ]);
  });
  const input: InputEnvelope = {
    version: 1,
    routingVersion: 1,
    topicId: installation.topicId,
    websiteId: site,
    sessionId: randomUUID(),
    visitId: randomUUID(),
    eventId: randomUUID(),
    clientEventId: randomUUID(),
    inputId: randomUUID(),
    epoch: '0',
    policyRevision: '0',
    kind: 'browser',
    fingerprint: 'a'.repeat(64),
    collectionSource: 'browser',
    collectionScope: 'browser',
    receivedAt: new Date().toISOString(),
    data: { fixture: true },
  };
  // An outstanding previous owner's lease reproduces a real fencing error in
  // eachBatch, before discovery/offset acknowledgement. No payload is discarded.
  const previousOwner = await control.claim(installation.topicId, 0, randomUUID(), 120);
  await queue.enqueue(input);
  const create = () => {
    starts++;
    worker = new WarehouseConsumer(
      control,
      ch,
      queue,
      async (inputs, _state, receipts) =>
        inputs.map(item => {
          const receipt = receipts.find(r => r.identity_key === routingKey(item.envelope));
          const status = receipt ? receiptOutcome(receipt, item.envelope) : 'new';
          if (status === 'unavailable') throw new Error('Isolated receipt unavailable');
          return {
            input: item,
            status,
            sessionId: receipt?.original_session ?? item.envelope.sessionId,
            visitId: receipt?.original_visit ?? item.envelope.visitId,
            facts: receipt
              ? []
              : [
                  {
                    family: 'website_event',
                    row: factInput('website_event', {
                      event_id: item.envelope.eventId,
                      website_id: site,
                      session_id: item.envelope.sessionId,
                      visit_id: item.envelope.visitId,
                      event_type: 1,
                      created_at: '2026-11-03T10:00:00Z',
                      url_path: '/recovery',
                    }),
                  },
                ],
          };
        }),
      { groupId: run, onHealth: h => health.push(h) },
    );
    return worker;
  };
  supervisor = new WarehouseConsumerSupervisor(
    async () =>
      (
        await db.read<{ authority: string; revision: string }>(
          'SELECT authority,revision FROM liekan_warehouse_installation WHERE id=1',
        )
      )[0],
    create,
    async () => {},
  );
  await supervisor.refresh();
  await until(
    async () => health.some(h => h.code === 'warehouse-consumer-unavailable'),
    'lease conflict crash',
  );
  assert.equal((await db.read('SELECT 1 FROM liekan_warehouse_work')).length, 0);
  assert.equal(worker.isOperational(), false, 'crashed consumer must be unhealthy');
  assert.equal(supervisor.isOperational(), false);
  const crash = health.find(h => h.code === 'warehouse-consumer-unavailable');
  assert.equal(crash.cause, 'warehouse-partition-owned');
  assert.equal(crash.automaticRestart, true);
  assert.equal(worker.needsRestart(), false, 'allow KafkaJS to finish its own retry');
  await control.release(previousOwner);
  const count = async () => {
    const state = await control.site(site);
    return (
      await (
        await ch.query({
          query: `SELECT count() AS n FROM ${factRelation('website_event')}`,
          query_params: boundaryParameters({
            websiteId: site,
            epoch: state.epoch,
            publication: state.publication,
            deletionRevision: state.deletion_revision,
          }),
          format: 'JSONEachRow',
        })
      ).json<{ n: string }>()
    )[0].n;
  };
  await until(async () => (await count()) === '1', 'SDK automatic restart after lease release');
  assert.equal(supervisor.isOperational(), true);
  assert.equal(starts, 1);
  cases.push({
    name: 'retriable lease failure is unhealthy while stopped and SDK restart recovers it',
    status: 'pass',
  });
  // Deterministic non-retriable callback exception; only this new test's
  // in-process control object is faulted. KafkaJS does not restart this class.
  const discover = control.discover.bind(control);
  let failOnce = true;
  control.discover = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new TypeError('isolated discovery fault; must never appear in diagnostics');
    }
    return discover(...args);
  };
  const next = {
    ...input,
    inputId: randomUUID(),
    eventId: randomUUID(),
    clientEventId: randomUUID(),
  };
  await queue.enqueue(next);
  await until(async () => worker.needsRestart(), 'nonretryable discovery exception');
  assert.equal(supervisor.isOperational(), false);
  assert.equal(
    health.filter(h => h.code === 'warehouse-consumer-unavailable').at(-1).automaticRestart,
    false,
  );
  assert.equal(JSON.stringify(health).includes('isolated discovery fault'), false);
  assert.equal(
    (await db.read('SELECT 1 FROM liekan_warehouse_work WHERE input_id=$1', [next.inputId])).length,
    0,
  );
  await supervisor.refresh();
  await until(async () => (await count()) === '2', 'same revision supervisor recovery');
  assert.equal(starts, 2);
  assert.equal(supervisor.isOperational(), true);
  await supervisor.refresh();
  assert.equal(starts, 2);
  await queue.enqueue({ ...next, inputId: randomUUID() });
  await until(
    async () =>
      (await db.read("SELECT 1 FROM liekan_warehouse_work WHERE status='confirmed'")).length === 3,
    'retry confirmation',
  );
  assert.equal(await count(), '2');
  assert.equal((await db.read('SELECT 1 FROM website_event')).length, 0);
  cases.push({
    name: 'unchanged authority restarts crashed consumer; durable input and retry publish exactly once without PG facts',
    status: 'pass',
  });
  await db.transaction(tx =>
    tx.query(
      "UPDATE liekan_warehouse_installation SET authority='frozen',revision=revision+1 WHERE id=1",
    ),
  );
  await supervisor.refresh();
  assert.equal(supervisor.authority, 'frozen');
  assert.equal(supervisor.isOperational(), true);
  await db.transaction(tx =>
    tx.query(
      "UPDATE liekan_warehouse_installation SET authority='clickhouse',revision=revision+1 WHERE id=1",
    ),
  );
  await supervisor.refresh();
  await queue.enqueue({
    ...input,
    inputId: randomUUID(),
    eventId: randomUUID(),
    clientEventId: randomUUID(),
  });
  await until(async () => (await count()) === '3', 'resume after authority freeze');
  assert.equal(starts, 3);
  assert.equal(supervisor.isOperational(), true);
  cases.push({
    name: 'planned authority freeze closes consumers and subsequent revision resumes discovery',
    status: 'pass',
  });
  console.log(`PASS ${cases.length} consumer recovery cases`);
} finally {
  await supervisor?.close();
  await Promise.allSettled([
    queue?.close(),
    broker.disconnect(),
    db.close(),
    admin.end(),
    ch.close(),
    chAdmin.close(),
  ]);
  await writeFile(
    `.local/ch-implementation/${run}.json`,
    JSON.stringify({ run, cases, health }, null, 2),
    { mode: 0o600 },
  );
}
