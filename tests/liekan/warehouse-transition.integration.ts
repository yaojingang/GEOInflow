import { testClickHouseURL } from './warehouse-test-target';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { initializeWarehouse } from '../../src/lib/liekan/warehouse/initialize';
import { TransitionApplier } from '../../src/lib/liekan/warehouse/transition-apply';
import { factRelation, boundaryParameters } from '../../src/lib/liekan/warehouse/read';
import { Kafka, logLevel } from 'kafkajs';
import { WarehouseQueue, inspectQueueTopic } from '../../src/lib/liekan/warehouse/transport';
import {
  TransitionStream,
  assembleResultFrames,
  resultFrames,
} from '../../src/lib/liekan/warehouse/transition-stream';
import { WarehouseControl } from '../../src/lib/liekan/warehouse/control';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { applyPostgresFacts } from '../../src/lib/liekan/warehouse/postgres-facts';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
import { inputDigest, type LandedDecision } from '../../src/lib/liekan/warehouse/landing';
import { routingKey, type InputEnvelope } from '../../src/lib/liekan/warehouse/routing';
import {
  captureAuthoritativeResult,
  decisionResult,
  decodeAuthoritativeResult,
  TransitionCapture,
} from '../../src/lib/liekan/warehouse/transition-capture';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_transition_${Date.now()}`,
  password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const connection = { host: '127.0.0.1', port: 25459, user: 'liekan_ch_proto', password };
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' }),
  url = new URL(`postgresql://127.0.0.1:25459/${run}`);
url.username = connection.user;
url.password = password;
const db = new ControlDatabase(url.toString()),
  control = new WarehouseControl(db, 'postgres'),
  capture = new TransitionCapture(db);
const queueOptions = { brokers: ['127.0.0.1:29109'] };
const broker = new Kafka({ ...queueOptions, logLevel: logLevel.NOTHING }).admin();
let queue: WarehouseQueue, stream: TransitionStream;
const chAdmin = createWarehouseClient({ url: testClickHouseURL, request_timeout: 30000 });
const ch = createWarehouseClient({
  url: testClickHouseURL,
  database: run,
  request_timeout: 30000,
  clickhouse_settings: { max_threads: 1, max_memory_usage: '268435456' },
});
const site = randomUUID(),
  session = randomUUID(),
  topic = '11111111111111111111111111111111',
  cases: object[] = [];
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
  await db.transaction(async tx => {
    await tx.query(
      "INSERT INTO website(website_id,name,domain) VALUES($1,'Transition isolated fixture','transition.invalid')",
      [site],
    );
    await tx.query('INSERT INTO liekan_warehouse_site(website_id) VALUES($1)', [site]);
    await tx.query(
      `INSERT INTO liekan_warehouse_installation(id,installation_id,schema_version,routing_version,topic_name,topic_id,partition_count,authority,transition)
      VALUES(1,$1,2,1,'isolated',$2,1,'postgres','shadow')`,
      [randomUUID(), topic],
    );
    await tx.query('INSERT INTO liekan_warehouse_partition(topic_id,partition) VALUES($1,0)', [
      topic,
    ]);
  });
  await chAdmin.command({ query: `CREATE DATABASE "${run}"` });
  await initializeWarehouse(ch);
  const owner = await control.claim(topic, 0, randomUUID(), 120);
  await assert.rejects(
    () => new WarehouseControl(db).claim(topic, 0, randomUUID()),
    /warehouse-authority-frozen/,
  );
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
          { name: 'write.caching', value: 'false' },
          { name: 'max.message.bytes', value: String(12 * 1024 * 1024) },
        ],
      },
    ],
  });
  const resultInstallation = await inspectQueueTopic(queueOptions, run);
  queue = new WarehouseQueue(queueOptions, resultInstallation);
  await queue.connect();
  stream = new TransitionStream(db, queue);
  await capture.start({ name: run, id: resultInstallation.topicId });
  const envelope: InputEnvelope = {
    version: 1,
    routingVersion: 1,
    topicId: topic,
    websiteId: site,
    sessionId: session,
    visitId: randomUUID(),
    eventId: randomUUID(),
    clientEventId: null,
    inputId: randomUUID(),
    epoch: '0',
    policyRevision: '0',
    kind: 'identify',
    fingerprint: 'd'.repeat(64),
    collectionSource: 'browser',
    collectionScope: 'browser',
    receivedAt: new Date().toISOString(),
    data: { format: 'isolated-capture', fixturePayload: '试'.repeat(2 * 1024 * 1024) },
  };
  const input = { partition: 0, offset: '0', envelope };
  const decision: LandedDecision = {
    input,
    status: 'new',
    sessionId: session,
    visitId: envelope.visitId,
    facts: [
      {
        family: 'session',
        row: factInput('session', {
          session_id: session,
          website_id: site,
          created_at: '2026-10-26T10:11:12.123456Z',
        }),
      },
    ],
  };
  await control.discover(
    owner,
    [
      {
        offset: '0',
        inputId: envelope.inputId,
        websiteId: site,
        sessionId: session,
        identityKey: routingKey(envelope),
      },
    ],
    '0',
  );
  const attempt = await control.intent(owner, site, ['0'], inputDigest([input]));
  await assert.rejects(
    () =>
      control.confirm(
        owner,
        attempt.attempt_id,
        attempt.input_digest,
        [],
        [],
        undefined,
        async (tx, accepted) => {
          await applyPostgresFacts(tx, site, [decision]);
          await captureAuthoritativeResult(tx, decisionResult('postgres', accepted, [decision]));
          throw new Error('isolated fail before authority commit');
        },
      ),
    /isolated fail/,
  );
  assert.equal((await db.read('SELECT 1 FROM session')).length, 0);
  assert.equal((await capture.pending('0')).length, 0);
  assert.equal(
    (await db.read<{ version: string }>('SELECT version FROM liekan_warehouse_site'))[0].version,
    '0',
  );
  cases.push({
    name: 'failed authoritative transaction rolls back facts, site version, confirmation and complete result together',
    status: 'pass',
  });
  const accepted = await control.confirm(
    owner,
    attempt.attempt_id,
    attempt.input_digest,
    [],
    [],
    undefined,
    async (tx, a) => {
      await applyPostgresFacts(tx, site, [decision]);
      await captureAuthoritativeResult(tx, decisionResult('postgres', a, [decision]));
    },
  );
  await control.decisionProjected(owner, accepted.attempt_id);
  const [row] = await capture.pending('0');
  assert.equal(row.sequence, '1');
  assert.deepEqual(
    decodeAuthoritativeResult(row),
    decisionResult('postgres', accepted, [decision]),
  );
  await control.confirm(
    owner,
    attempt.attempt_id,
    attempt.input_digest,
    [],
    [],
    undefined,
    async () => {
      throw new Error('must not rerun accepted operation');
    },
  );
  await db.transaction(tx =>
    captureAuthoritativeResult(tx, decisionResult('postgres', accepted, [decision])),
  );
  assert.equal((await capture.pending('0')).length, 1);
  await assert.rejects(
    () =>
      db.transaction(tx =>
        captureAuthoritativeResult(tx, {
          ...decisionResult('postgres', accepted, [decision]),
          siteVersion: '99',
        }),
      ),
    /operation-conflict/,
  );
  cases.push({
    name: 'accepted result contains immutable full outcomes; stable operation reconciliation cannot duplicate or replace the committed result',
    status: 'pass',
  });
  let statements = 0;
  const bulk = Array.from({ length: 200 }, (_, i) => ({
    ...decision,
    input: { ...input, envelope: { ...envelope, inputId: randomUUID() } },
    facts: [
      {
        family: 'session',
        row: factInput('session', {
          session_id: session,
          website_id: site,
          created_at: '2026-11-03T00:00:00Z',
          distinct_id: i ? 'later' : 'first-identity',
        }),
      },
      {
        family: 'session_data',
        retainCreatedAt: true,
        row: factInput('session_data', {
          session_data_id: randomUUID(),
          website_id: site,
          session_id: session,
          data_key: 'large-decimal',
          number_value: '900719925474.1234',
          data_type: 2,
          created_at: '2026-11-03T10:11:12.123456Z',
        }),
      },
      {
        family: 'liekan_session_data_source',
        row: factInput('liekan_session_data_source', {
          website_id: site,
          session_id: session,
          data_key: 'large-decimal',
          scope: 'browser',
          classification: 'browser',
          row_digest: 'a'.repeat(64),
          updated_at: '2026-11-03T10:11:12.123456Z',
        }),
      },
      {
        family: 'liekan_collection_diagnostic',
        row: factInput('liekan_collection_diagnostic', {
          website_id: site,
          bucket: '2026-11-03T10:11:00Z',
          shard: 0,
          written: 1,
          with_uuid: 0,
          duplicate: 0,
          first_at: '2026-11-03T10:11:12.123456Z',
          last_at: '2026-11-03T10:11:12.123456Z',
        }),
      },
    ],
  }));
  const normalized = await db.transaction(tx =>
    applyPostgresFacts(
      {
        query: async (sql, values) => {
          statements++;
          return tx.query(sql, values);
        },
      },
      site,
      bulk,
    ),
  );
  assert.ok(statements <= 7, 'hot-key batch must use family-sized statements');
  assert.equal(
    (await db.read<{ written: string }>('SELECT written FROM liekan_collection_diagnostic'))[0]
      .written,
    '200',
  );
  const [property] = await db.read<{
    number: string;
    verified: boolean;
    id: string;
  }>(`SELECT d.number_value::text AS number,d.session_data_id AS id,s.row_digest=liekan_session_data_digest(d) AS verified
    FROM session_data d JOIN liekan_session_data_source s USING(website_id,session_id,data_key)`);
  assert.equal(property.number, '900719925474.1234');
  assert.equal(property.verified, true);
  assert.equal(property.id, bulk[0].facts[1].row.session_data_id);
  assert.equal(
    (await db.read<{ distinct_id: string }>('SELECT distinct_id FROM session'))[0].distinct_id,
    'first-identity',
  );
  assert.ok(
    normalized.every(
      d => d.facts.find(f => f.family === 'liekan_session_data_source').propertyProof,
    ),
  );
  cases.push({
    name: 'temporary PG writer folds 200 hot-key packages into bounded family batches, preserves first identity/property ID, exact Decimal/microseconds and native property eligibility proof',
    status: 'pass',
  });
  await db.read("UPDATE session SET distinct_id='Changed after authoritative capture'");
  assert.equal((await capture.pending('0'))[0].payload, row.payload);
  await assert.rejects(
    () => db.read('UPDATE liekan_warehouse_transition_result SET payload=$1', ['corrupt']),
    /immutable/,
  );
  assert.throws(() => decodeAuthoritativeResult({ ...row, payload: '{}' }), /payload-corrupt/);
  cases.push({
    name: 'later mutable facts never reconstruct historical outcomes; SQL update and digest corruption are rejected',
    status: 'pass',
  });
  await assert.rejects(() => capture.stopCapture(), /exit-requires-clickhouse/);
  await db.read(
    "UPDATE liekan_warehouse_installation SET authority='clickhouse',transition='rollback'",
  );
  const frames = resultFrames(row);
  assert.equal(frames.length, 2);
  assert.equal(assembleResultFrames(row, frames), row.payload);
  assert.throws(() => assembleResultFrames(row, [frames[1], frames[0]]), /frame-mismatch/);
  const send = queue.enqueueResultFrame.bind(queue);
  let failed = false;
  queue.enqueueResultFrame = async value => {
    const result = await send(value);
    if (!failed) {
      failed = true;
      throw new Error('isolated response lost after broker write');
    }
    return result;
  };
  try {
    await assert.rejects(() => stream.publish(), /isolated response lost/);
  } finally {
    queue.enqueueResultFrame = send;
  }
  assert.equal((await db.read('SELECT 1 FROM liekan_warehouse_transition_delivery')).length, 0);
  await stream.close();
  stream = new TransitionStream(db, queue);
  assert.equal(await stream.publish(), 1);
  const delivered = await stream.read('1');
  assert.equal(delivered.payload, row.payload);
  assert.equal(delivered.digest, row.digest);
  cases.push({
    name: 'durable chunked result transport recovers a lost broker response and process restart, reassembles a multi-megabyte outcome and rejects reordered chunks',
    status: 'pass',
  });
  const terminal = await capture.stopCapture();
  assert.equal(terminal, '1');
  await assert.rejects(() => capture.close(), /warehouse-transition-not-drained/);
  await db.transaction(tx =>
    captureAuthoritativeResult(tx, {
      ...decisionResult('postgres', accepted, [decision]),
      operationId: randomUUID(),
      siteVersion: '2',
    }),
  );
  assert.equal((await capture.pending('0')).length, 1);
  const applier = new TransitionApplier(db, ch, stream);
  assert.equal(await applier.drain('clickhouse'), 1);
  assert.equal(await applier.drain('postgres'), 1);
  assert.equal(await applier.drain('clickhouse'), 0);
  const [head] = await db.read<{ publication: string }>(
    'SELECT publication FROM liekan_warehouse_site WHERE website_id=$1',
    [site],
  );
  const shadow = await ch
    .query({
      query: `SELECT session_id,distinct_id FROM ${factRelation('session')}`,
      query_params: boundaryParameters({
        websiteId: site,
        epoch: '0',
        publication: head.publication,
        deletionRevision: '0',
      }),
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ session_id: string; distinct_id: string | null }>());
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].session_id, session);
  assert.equal(shadow[0].distinct_id, null);
  cases.push({
    name: 'real CH result applier publishes the captured PG outcome without rereading later-mutated facts; authoritative PG side acknowledges once without applying again',
    status: 'pass',
  });
  await capture.close();
  await capture.close();
  const before = await queue.highWatermarks();
  await assert.rejects(() => stream.publish(), /warehouse-result-publisher-fenced/);
  assert.deepEqual(await queue.highWatermarks(), before);
  await assert.rejects(
    () => capture.start({ name: 'isolated-results', id: '2'.repeat(32) }),
    /already-created/,
  );
  cases.push({
    name: 'capture closure records a terminal sequence, refuses incomplete drain and remains idempotently closed on restart',
    status: 'pass',
  });
} catch (error) {
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : 'unknown');
} finally {
  await stream?.close();
  await queue?.close();
  await broker.deleteTopics({ topics: [run] }).catch(() => {});
  await broker.disconnect();
  await Promise.allSettled([db.close(), admin.end(), ch.close(), chAdmin.close()]);
  await writeFile(
    `.local/ch-implementation/${run}.json`,
    JSON.stringify({ run, cases, transportAndCutoverValidated: false }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      cases: cases.length,
      failed: cases.filter((c: any) => c.status === 'failed').length,
    }),
  );
}
