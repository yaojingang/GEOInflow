import {
  testClickHouseURL,
  testPostgresPort,
  testPostgresPasswordFile,
} from './warehouse-test-target';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Kafka, logLevel } from 'kafkajs';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import type { LogRecord } from '../../src/lib/liekan/ingest';
import { closeQueue, getQueue } from '../../src/lib/liekan/log-ingestion/queue';
import { observeCollection } from '../../src/lib/liekan/upstream/collection-observation';
import { WarehouseCollectionPackage } from '../../src/lib/liekan/upstream/warehouse-collection-package';
import { browserPlanner } from '../../src/lib/liekan/warehouse/browser-planner';
import { canonicalWireRow } from '../../src/lib/liekan/warehouse/candidate';
import { factTable } from '../../src/lib/liekan/warehouse/catalog';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { WarehouseCompletion } from '../../src/lib/liekan/warehouse/completion';
import { type DecisionPlanner, WarehouseConsumer } from '../../src/lib/liekan/warehouse/consumer';
import { type Attempt, WarehouseControl } from '../../src/lib/liekan/warehouse/control';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { deriveCandidates } from '../../src/lib/liekan/warehouse/derivation-plan';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
import { ingressPlanner } from '../../src/lib/liekan/warehouse/ingress-planner';
import { initializeWarehouse } from '../../src/lib/liekan/warehouse/initialize';
import { LandingStore, receiptOutcome } from '../../src/lib/liekan/warehouse/landing';
import { logEnvelope } from '../../src/lib/liekan/warehouse/log-package';
import { logPlanner } from '../../src/lib/liekan/warehouse/log-planner';
import { repairLogSourceRelation } from '../../src/lib/liekan/warehouse/log-scope-proof';
import { collectionPlanner } from '../../src/lib/liekan/warehouse/planner';
import { WarehousePublisher } from '../../src/lib/liekan/warehouse/publication';
import { boundaryParameters, factRelation } from '../../src/lib/liekan/warehouse/read';
import { recorderPlanner } from '../../src/lib/liekan/warehouse/recorder-planner';
import { riskRelation } from '../../src/lib/liekan/warehouse/risk-proof';
import { type InputEnvelope, route, routingKey } from '../../src/lib/liekan/warehouse/routing';
import { WarehouseRuntime } from '../../src/lib/liekan/warehouse/runtime';
import {
  confirmWarehouseTasks,
  prepareWarehouseTask,
  waitWarehouseTask,
  taskPlanner,
  type TaskAuthority,
} from '../../src/lib/liekan/warehouse/tasks';
import { inspectQueueTopic, WarehouseQueue } from '../../src/lib/liekan/warehouse/transport';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_consumer_${Date.now()}`;
const password = (await readFile(testPostgresPasswordFile, 'utf8')).trim();
const connection = { host: '127.0.0.1', port: testPostgresPort, user: 'liekan_ch_proto', password };
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' });
const url = new URL(`postgresql://127.0.0.1:${testPostgresPort}/${run}`);
url.username = connection.user;
url.password = password;
const db = new ControlDatabase(url.toString());
const control = new WarehouseControl(db);
const chAdmin = createWarehouseClient({ url: testClickHouseURL });
const ch = createWarehouseClient({
  url: testClickHouseURL,
  database: run,
  request_timeout: 15000,
  clickhouse_settings: { max_threads: 1, max_memory_usage: '268435456' },
});
const options = { brokers: ['127.0.0.1:29109'], maxMessageBytes: 1024 * 1024 };
const kafka = new Kafka({ brokers: options.brokers, logLevel: logLevel.NOTHING });
const broker = kafka.admin(),
  rawProducer = kafka.producer();
const siteA = randomUUID(),
  siteB = randomUUID();
let queue: WarehouseQueue,
  worker: WarehouseConsumer,
  allowA = false;
let completion: WarehouseCompletion;
let taskAuthority: TaskAuthority | undefined;
const cases: object[] = [],
  health: string[] = [];
const fixture = (family: string, fields: Record<string, unknown>) =>
  canonicalWireRow(
    family,
    Object.fromEntries(factTable(family).columns.map(c => [c.name, fields[c.name] ?? null])),
  );
const planner: DecisionPlanner = async (inputs, _state, receipts) => {
  if (inputs[0].envelope.websiteId === siteA && !allowA) throw new Error('isolated delayed site');
  return inputs.map(input => {
    const e = input.envelope,
      receipt = receipts.find(r => r.identity_key === routingKey(e));
    if (receipt) {
      const status = receiptOutcome(receipt, e);
      if (status === 'unavailable') throw new Error('Receipt unavailable');
      return {
        input,
        status,
        sessionId: receipt.original_session,
        visitId: receipt.original_visit,
        facts: [],
      };
    }
    const created = '2026-11-03 10:00:00.000000';
    return {
      input,
      status: 'new',
      sessionId: e.sessionId,
      visitId: e.visitId,
      facts: [
        {
          family: 'session',
          row: fixture('session', {
            session_id: e.sessionId,
            website_id: e.websiteId,
            created_at: created,
          }),
        },
        {
          family: 'website_event',
          row: fixture('website_event', {
            event_id: e.eventId,
            website_id: e.websiteId,
            session_id: e.sessionId,
            visit_id: e.visitId,
            event_type: '1',
            url_path: '/isolated-fixture',
            created_at: created,
          }),
        },
      ],
    };
  });
};
async function until(check: () => Promise<boolean>, label: string) {
  const start = Date.now();
  while (Date.now() - start < 45000) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`Bounded wait failed: ${label}; health=${health.slice(-4).join(',')}`);
}
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${run}" TEMPLATE liekan_ch_catalog_20261103`);
  // The schema-only template has an empty pg-boss version table, not an installed
  // queue. Recreate only that empty test-owned namespace using the pinned package.
  await db.transaction(async tx => {
    const [rows] = (
      await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM liekan_jobs.job')
    ).rows;
    assert.equal(rows.n, '0');
    await tx.query('DROP SCHEMA liekan_jobs CASCADE');
  });
  for (const file of (await readdir('db/liekan/migrations'))
    .filter(f => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) >= 57)
    .sort()) {
    const sql = await readFile(`db/liekan/migrations/${file}`, 'utf8');
    const concurrentIndex = file === '094_log_import_time_index.sql';
    if (concurrentIndex) await db.read(sql);
    await db.transaction(async tx => {
      if (!concurrentIndex) await tx.query(sql);
      await tx.query('INSERT INTO liekan_migration(name,checksum) VALUES($1,$2)', [
        file,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    });
  }
  const installer = new PgBoss({
    connectionString: url.toString(),
    schema: 'liekan_jobs',
    migrate: true,
    schedule: false,
    supervise: false,
    max: 2,
  });
  installer.on('error', () => {});
  await installer.start();
  try {
    await installer.createQueue('liekan-history-repair');
  } finally {
    await installer.stop();
  }
  await chAdmin.command({ query: `CREATE DATABASE "${run}"` });
  await initializeWarehouse(ch);
  await broker.connect();
  await broker.createTopics({
    waitForLeaders: true,
    topics: [
      {
        topic: run,
        numPartitions: 2,
        replicationFactor: 1,
        configEntries: [
          { name: 'retention.ms', value: '-1' },
          { name: 'retention.bytes', value: '-1' },
          { name: 'flush.messages', value: '1' },
          { name: 'segment.bytes', value: '1048576' },
        ],
      },
    ],
  });
  const installation = await inspectQueueTopic(options, run);
  queue = new WarehouseQueue(options, installation);
  await queue.connect();
  await db.transaction(async tx => {
    for (const site of [siteA, siteB]) {
      await tx.query(
        `INSERT INTO website(website_id,name,domain) VALUES($1::uuid,'Isolated consumer test','warehouse-test.invalid')`,
        [site],
      );
      await tx.query('INSERT INTO liekan_warehouse_site(website_id) VALUES($1::uuid)', [site]);
    }
    await tx.query(
      `INSERT INTO liekan_warehouse_installation(id,installation_id,schema_version,routing_version,topic_name,topic_id,partition_count,authority,transition)
      VALUES(1,$1::uuid,2,1,$2,$3,2,'clickhouse','none')`,
      [randomUUID(), run, installation.topicId],
    );
    await tx.query(
      'INSERT INTO liekan_warehouse_partition(topic_id,partition) VALUES($1,0),($1,1)',
      [installation.topicId],
    );
  });
  const event = (site: string, partition = 0): InputEnvelope => {
    const e: InputEnvelope = {
      version: 1,
      routingVersion: 1,
      topicId: installation.topicId,
      websiteId: site,
      sessionId: randomUUID(),
      clientEventId: randomUUID(),
      eventId: randomUUID(),
      inputId: randomUUID(),
      visitId: randomUUID(),
      epoch: '0',
      policyRevision: '0',
      kind: 'browser',
      fingerprint: 'a'.repeat(64),
      collectionSource: 'browser',
      collectionScope: 'browser',
      receivedAt: new Date().toISOString(),
      data: { fixture: true },
    };
    while (route(e, 2) !== partition) e.clientEventId = randomUUID();
    return e;
  };
  const delayed = event(siteA),
    fast = Array.from({ length: 12 }, () => event(siteB));
  await queue.enqueue(delayed);
  for (const e of fast) await queue.enqueue(e);
  const start = async (nextPlanner = planner, tasks = false) => {
    worker = new WarehouseConsumer(control, ch, queue, nextPlanner, {
      groupId: run,
      cacheBytes: 0,
      ...(tasks
        ? {
            confirmAuthority: (tx, attempt, decisions) =>
              confirmWarehouseTasks(tx, attempt, decisions, taskAuthority),
          }
        : {}),
      onHealth: h => health.push(h.code),
    });
    await worker.start();
  };
  await start();
  const counts = async (site: string) => {
    const s = await control.site(site);
    return (
      await ch
        .query({
          query: `SELECT count() AS n FROM ${factRelation('website_event')}`,
          query_params: boundaryParameters({
            websiteId: site,
            epoch: s.epoch,
            publication: s.publication,
            deletionRevision: s.deletion_revision,
          }),
          format: 'JSONEachRow',
        })
        .then(r => r.json<{ n: string }>())
    )[0].n;
  };
  await until(async () => (await counts(siteB)) === '12', 'later same-partition site publishes');
  assert.equal(await counts(siteA), '0');
  assert.equal(
    (
      await db.read<{ safe_offset: string }>(
        'SELECT safe_offset FROM liekan_warehouse_partition WHERE partition=0',
      )
    )[0].safe_offset,
    '-1',
  );
  cases.push({
    name: 'blocked site does not block later same-partition inputs; zero-cache replay; safe retention boundary',
    status: 'pass',
  });
  await worker.close();
  allowA = true;
  await start();
  await until(async () => (await counts(siteA)) === '1', 'pending input recovered after restart');
  cases.push({
    name: 'fresh consumer recovers deferred queue references after committed discovery offset',
    status: 'pass',
  });
  const duplicate = {
    ...fast[0],
    inputId: randomUUID(),
    sessionId: randomUUID(),
    visitId: randomUUID(),
    eventId: randomUUID(),
  };
  await queue.enqueue(duplicate);
  await until(
    async () =>
      (
        await db.read(
          "SELECT 1 FROM liekan_warehouse_work w JOIN liekan_warehouse_attempt a USING(attempt_id) WHERE w.input_id=$1::uuid AND a.status='projected'",
          [duplicate.inputId],
        )
      ).length === 1,
    'duplicate completes',
  );
  assert.equal(await counts(siteB), '12');
  const receipts = await new LandingStore(ch).receipts(
    { websiteId: siteB, epoch: '0', publication: '999', deletionRevision: '0' },
    [routingKey(duplicate)],
  );
  assert.equal(receipts[0].original_session, fast[0].sessionId);
  assert.equal(receipts[0].original_visit, fast[0].visitId);
  cases.push({
    name: 'same UUID retry preserves original response and does not add a fact',
    status: 'pass',
  });
  const [attempt] = await db.read<Attempt>(
    `SELECT * FROM liekan_warehouse_attempt WHERE website_id=$1::uuid AND status='projected' AND input_count>1 LIMIT 1`,
    [siteB],
  );
  assert.ok(attempt);
  const plan = deriveCandidates(attempt, await new LandingStore(ch).recover(attempt));
  await assert.rejects(
    () => new WarehousePublisher(db, ch).reserve(siteB, '0', [plan.manifest[0]]),
    /warehouse-publication-incomplete-package/,
  );
  cases.push({
    name: 'partial confirmed event-family manifest cannot be published',
    status: 'pass',
  });
  await rawProducer.connect();
  const wrong = event(siteB, 0);
  await rawProducer.send({
    topic: run,
    messages: [{ partition: 1, key: routingKey(wrong), value: JSON.stringify(wrong) }],
  });
  await until(
    async () =>
      (
        await db.read(
          "SELECT 1 FROM liekan_warehouse_work WHERE input_id=$1::uuid AND status='quarantined'",
          [wrong.inputId],
        )
      ).length === 1,
    'wrong route quarantined',
  );
  assert.equal(await counts(siteB), '12');
  cases.push({
    name: 'wrong-partition record is quarantined before business decision',
    status: 'pass',
  });
  await worker.close();
  await start(browserPlanner(db));
  completion = new WarehouseCompletion(db, ch);
  const browser = event(siteB),
    at = new Date(browser.receivedAt);
  const identity = {
    scope: 'browser_unresolved' as const,
    available: false,
    version: 'cookieless-trusted-input-v3',
    sessionId: browser.sessionId,
    browser: 'chrome',
    os: 'Windows',
    device: 'desktop',
    screen: '1920x1080',
    language: 'zh-CN',
    originHostname: null,
    distinctId: null,
    hostname: 'example.test',
    classification: 'unknown' as const,
  };
  const p = new WarehouseCollectionPackage(
    {
      websiteId: siteB,
      eventId: browser.clientEventId,
      fingerprint: browser.fingerprint,
      identity,
      quality: {
        classification: 'unknown',
        source: 'browser',
        reasons: ['missing-input'],
        ruleVersion: 'traffic-quality-v4',
        rangeVersion: null,
        rangeStatus: 'missing',
        hostname: 'example.test',
      },
    },
    at,
  );
  await p.createSession({ id: browser.sessionId, websiteId: siteB, createdAt: at });
  await p.identity(siteB, identity);
  await p.saveEvent({
    websiteId: siteB,
    sessionId: browser.sessionId,
    visitId: browser.visitId,
    eventType: 2,
    eventName: 'purchase',
    urlPath: '/purchase',
    createdAt: at,
    eventData: { revenue: 1.23445, currency: 'CNY' },
  });
  browser.eventId = p.eventId;
  browser.data = p.seal();
  browser.collectionScope = 'browser_unresolved';
  await queue.enqueue(browser);
  const response = await completion.wait(browser, 30000);
  assert.equal(response.status, 'new');
  assert.equal(await counts(siteB), '13');
  const repeated = { ...browser, inputId: randomUUID() };
  await queue.enqueue(repeated);
  assert.equal((await completion.wait(repeated, 30000)).status, 'duplicate');
  assert.equal(await counts(siteB), '13');
  const s = await control.site(siteB),
    params = boundaryParameters({
      websiteId: siteB,
      epoch: s.epoch,
      publication: s.publication,
      deletionRevision: s.deletion_revision,
    });
  for (const [family, n] of [
    ['liekan_event_quality', '1'],
    ['liekan_event_environment', '1'],
    ['event_data', '2'],
    ['revenue', '1'],
  ] as const) {
    assert.equal(
      (
        await ch
          .query({
            query: `SELECT count() AS n FROM ${factRelation(family)}`,
            query_params: params,
            format: 'JSONEachRow',
          })
          .then(r => r.json<{ n: string }>())
      )[0].n,
      n,
    );
  }
  const diagnostic = (
    await ch
      .query({
        query: `SELECT sum(written) AS written,sum(with_uuid) AS with_uuid,sum(duplicate) AS duplicate FROM ${factRelation('liekan_collection_diagnostic')}`,
        query_params: params,
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ written: string; with_uuid: string; duplicate: string }>())
  )[0];
  assert.deepEqual(diagnostic, { written: '1', with_uuid: '1', duplicate: '1' });
  assert.equal(
    (await db.read<{ n: string }>('SELECT count(*)::text AS n FROM website_event'))[0].n,
    '0',
  );
  assert.equal(
    (await db.read<{ n: string }>('SELECT count(*)::text AS n FROM liekan_collection_receipt'))[0]
      .n,
    '0',
  );
  cases.push({
    name: 'real browser package publishes properties, revenue and unknown quality; completion waits for all families; PG facts stay empty',
    status: 'pass',
  });
  assert.equal(
    (
      await db.read<{ started_at: Date }>(
        'SELECT started_at FROM liekan_collection_diagnostic_state WHERE website_id=$1::uuid',
        [siteB],
      )
    )[0].started_at.toISOString(),
    at.toISOString(),
  );
  const observed = {
    ...browser,
    inputId: randomUUID(),
    clientEventId: randomUUID(),
    fingerprint: 'd'.repeat(64),
  };
  const observedPackage = new WarehouseCollectionPackage(
    {
      ...p.input,
      eventId: observed.clientEventId,
      fingerprint: observed.fingerprint,
      observation: observeCollection({ headers: new Headers({ accept: 'text/html' }) }, at),
    },
    at,
  );
  await observedPackage.createSession({ id: browser.sessionId, websiteId: siteB, createdAt: at });
  await observedPackage.identity(siteB, identity);
  await observedPackage.saveEvent({
    websiteId: siteB,
    sessionId: browser.sessionId,
    visitId: browser.visitId,
    eventType: 1,
    urlPath: '/observed',
    createdAt: at,
  });
  observed.eventId = observedPackage.eventId;
  observed.data = observedPackage.seal();
  await queue.enqueue(observed);
  assert.equal((await completion.wait(observed, 30000)).status, 'new');
  const observationState = (
    await db.read<{ first_received_at: Date; last_received_at: Date; epoch: number }>(
      'SELECT * FROM liekan_observation_state WHERE website_id=$1::uuid',
      [siteB],
    )
  )[0];
  assert.equal(observationState.first_received_at.toISOString(), at.toISOString());
  assert.equal(observationState.last_received_at.toISOString(), at.toISOString());
  assert.equal(observationState.epoch, 1);
  assert.equal(
    (await db.read<{ n: string }>('SELECT count(*)::text n FROM liekan_event_observation'))[0].n,
    '0',
  );
  cases.push({
    name: 'diagnostic/observation control metadata publishes atomically with CH evidence, retains UTC and does not write PG observations',
    status: 'pass',
  });
  await worker.close();
  let recorderEnabled = true;
  await start(
    recorderPlanner(ch, async () => new Set(recorderEnabled ? ['replay', 'heatmap'] : [])),
  );
  const replay = {
    ...browser,
    inputId: randomUUID(),
    eventId: randomUUID(),
    clientEventId: undefined,
    kind: 'replay' as const,
    collectionScope: 'recorder',
    data: {
      format: 'recorder-v1',
      facts: [
        {
          family: 'session_replay',
          row: factInput('session_replay', {
            replay_id: randomUUID(),
            website_id: siteB,
            session_id: browser.sessionId,
            visit_id: browser.visitId,
            chunk_index: 0,
            event_count: 1,
            events: gzipSync(Buffer.from(JSON.stringify([{ type: 2, timestamp: at.valueOf() }]))),
            started_at: at,
            ended_at: at,
            created_at: at,
          }),
        },
      ],
    },
  };
  await queue.enqueue(replay);
  assert.equal((await completion.wait(replay, 30000)).status, 'new');
  const replayState = await control.site(siteB);
  const replayRows = await ch
    .query({
      query: `SELECT events FROM ${factRelation('session_replay')}`,
      query_params: boundaryParameters({
        websiteId: siteB,
        epoch: replayState.epoch,
        publication: replayState.publication,
        deletionRevision: replayState.deletion_revision,
      }),
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ events: string }>());
  assert.equal(replayRows.length, 1);
  assert.equal(
    JSON.parse(gunzipSync(Buffer.from(replayRows[0].events, 'hex')).toString())[0].timestamp,
    at.valueOf(),
  );
  const foreign = structuredClone(replay);
  foreign.inputId = randomUUID();
  foreign.sessionId = randomUUID();
  foreign.data.facts[0].row.session_id = foreign.sessionId;
  await queue.enqueue(foreign);
  assert.equal((await completion.wait(foreign, 30000)).status, 'cancelled');
  recorderEnabled = false;
  const disabled = { ...replay, inputId: randomUUID() };
  await queue.enqueue(disabled);
  assert.equal((await completion.wait(disabled, 30000)).status, 'cancelled');
  assert.equal(
    (await db.read<{ n: string }>('SELECT count(*)::text n FROM session_replay'))[0].n,
    '0',
  );
  cases.push({
    name: 'recorder gzip roundtrip publishes only accepted same-site sessions and enabled collection; PG replay stays empty',
    status: 'pass',
  });
  await worker.close();
  await start(ingressPlanner);
  const ingress = {
    ...browser,
    inputId: randomUUID(),
    eventId: randomUUID(),
    clientEventId: undefined,
    kind: 'ingress' as const,
    data: { format: 'ingress-v1', reason: 'blocked_ip' },
  };
  await queue.enqueue(ingress);
  assert.equal((await completion.wait(ingress, 30000)).status, 'new');
  const ingressState = await control.site(siteB);
  const ingressRows = await ch
    .query({
      query: `SELECT sum(count) n FROM ${factRelation('liekan_geography_ingress')}`,
      query_params: boundaryParameters({
        websiteId: siteB,
        epoch: ingressState.epoch,
        publication: ingressState.publication,
        deletionRevision: ingressState.deletion_revision,
      }),
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ n: string }>());
  assert.equal(ingressRows[0].n, '1');
  assert.equal(
    (await db.read<{ n: string }>('SELECT count(*)::text n FROM liekan_geography_ingress'))[0].n,
    '0',
  );
  cases.push({
    name: 'rejected ingress aggregate uses durable CH delivery without PG analytical writes',
    status: 'pass',
  });
  await worker.close();
  await start(logPlanner(db, ch));
  const records: LogRecord[] = Array.from(
    { length: 20 },
    (_, i) =>
      ({
        id: createHash('sha256').update(`isolated-log-${i}`).digest('hex'),
        time: '2026-11-03T01:02:03Z',
        path: `/article/${i}`,
        method: 'GET',
        status: 200,
        bytes: 123,
        ipMasked: 'masked',
        ipHash: 'b'.repeat(64),
        userAgent: 'IsolatedTestBot',
        location: '未知',
        bot: '其他',
        vendor: '其他',
        type: '其他',
        verification: 'unverified',
      }) as LogRecord,
  );
  const registerUpload = async (batchId: string, size: number, repairScopeId?: string) =>
    db.transaction(async tx => {
      const digest = createHash('sha256').update(batchId).digest('hex');
      await tx.query(
        `INSERT INTO liekan_import(id,website_id,digest,accepted,rejected,kind,inserted,repair_scope_id) VALUES($1::uuid,$2::uuid,$3,0,0,'manual',0,$4::uuid)`,
        [batchId, siteB, digest, repairScopeId ?? null],
      );
      await tx.query(
        `INSERT INTO liekan_warehouse_upload(batch_id,website_id,source_epoch,kind,digest,expected,queued) VALUES($1::uuid,$2::uuid,1,'manual',$3,$4,true)`,
        [batchId, siteB, digest, size],
      );
    });
  const logBatch = randomUUID();
  await registerUpload(logBatch, records.length);
  const logInputs = records.map(r =>
    logEnvelope(s, installation, r, {
      batchId: logBatch,
      sourceId: null,
      sourceEpoch: 1,
      kind: 'manual',
      receivedAt: at,
    }),
  );
  await queue.enqueueMany(logInputs);
  await until(
    async () =>
      (
        await db.read<{ status: string }>(
          'SELECT status FROM liekan_warehouse_upload WHERE batch_id=$1::uuid',
          [logBatch],
        )
      )[0].status === 'processed',
    'log batch publication',
  );
  await queue.enqueueMany(logInputs);
  await until(
    async () =>
      (
        await db.read<{ n: string }>(
          "SELECT count(*)::text AS n FROM liekan_warehouse_work WHERE input_id=ANY($1::uuid[]) AND status='cancelled'",
          [logInputs.map(i => i.inputId)],
        )
      )[0].n === '20',
    'stable input retry accounted once',
  );
  const duplicatedBatch = randomUUID();
  await registerUpload(duplicatedBatch, 5);
  await queue.enqueueMany(
    records.slice(0, 5).map(r =>
      logEnvelope(s, installation, r, {
        batchId: duplicatedBatch,
        sourceId: null,
        sourceEpoch: 1,
        kind: 'manual',
        receivedAt: at,
      }),
    ),
  );
  await until(
    async () =>
      (
        await db.read<{ status: string }>(
          'SELECT status FROM liekan_warehouse_upload WHERE batch_id=$1::uuid',
          [duplicatedBatch],
        )
      )[0].status === 'processed',
    'cross batch log duplicates',
  );
  const batches = await db.read<{
    batch_id: string;
    processed: number;
    inserted: number;
    duplicates: number;
  }>('SELECT batch_id,processed,inserted,duplicates FROM liekan_warehouse_upload');
  assert.deepEqual(
    batches.find(b => b.batch_id === logBatch),
    { batch_id: logBatch, processed: 20, inserted: 20, duplicates: 0 },
  );
  assert.deepEqual(
    batches.find(b => b.batch_id === duplicatedBatch),
    { batch_id: duplicatedBatch, processed: 5, inserted: 0, duplicates: 5 },
  );
  const ls = await control.site(siteB);
  assert.equal(
    (
      await ch
        .query({
          query: `SELECT count() AS n FROM ${factRelation('liekan_log')}`,
          query_params: boundaryParameters({
            websiteId: siteB,
            epoch: ls.epoch,
            publication: ls.publication,
            deletionRevision: ls.deletion_revision,
          }),
          format: 'JSONEachRow',
        })
        .then(r => r.json<{ n: string }>())
    )[0].n,
    '20',
  );
  assert.equal(
    (await db.read<{ n: string }>('SELECT count(*)::text AS n FROM liekan_log'))[0].n,
    '0',
  );
  cases.push({
    name: 'bulk log transport, exactly-once upload counts, repeated input and cross-batch ID deduplication without PG log facts',
    status: 'pass',
  });
  const frozenLogs = await ch
    .query({
      query: `SELECT count() AS n FROM ${repairLogSourceRelation()}`,
      query_params: {
        ...boundaryParameters({
          websiteId: siteB,
          epoch: ls.epoch,
          publication: ls.publication,
          deletionRevision: ls.deletion_revision,
        }),
        wh_interval_source: [],
        wh_interval_start: [],
        wh_interval_end: [],
      },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ n: string }>());
  assert.equal(frozenLogs[0].n, '20');
  const repeatedBatch = randomUUID();
  await registerUpload(repeatedBatch, 2);
  await queue.enqueueMany(
    [0, 1].map(recordIndex =>
      logEnvelope(s, installation, records[0], {
        batchId: repeatedBatch,
        sourceId: null,
        sourceEpoch: 1,
        kind: 'manual',
        receivedAt: at,
        recordIndex,
      }),
    ),
  );
  await until(
    async () =>
      (
        await db.read<{ status: string }>(
          'SELECT status FROM liekan_warehouse_upload WHERE batch_id=$1::uuid',
          [repeatedBatch],
        )
      )[0].status === 'processed',
    'identical records within an upload',
  );
  assert.deepEqual(
    (
      await db.read(
        'SELECT processed,inserted,duplicates FROM liekan_warehouse_upload WHERE batch_id=$1::uuid',
        [repeatedBatch],
      )
    )[0],
    { processed: 2, inserted: 0, duplicates: 2 },
  );
  cases.push({
    name: 'same record repeated within one upload retains both input positions and completes exactly',
    status: 'pass',
  });
  await worker.close();
  await start(logPlanner(db, ch, async () => new Set()));
  const revokedBatch = randomUUID();
  await registerUpload(revokedBatch, 1);
  await queue.enqueueMany([
    logEnvelope(s, installation, records[0], {
      batchId: revokedBatch,
      sourceId: null,
      sourceEpoch: 1,
      kind: 'manual',
      receivedAt: at,
    }),
  ]);
  await until(
    async () =>
      (
        await db.read<{ status: string }>(
          'SELECT status FROM liekan_warehouse_upload WHERE batch_id=$1::uuid',
          [revokedBatch],
        )
      )[0].status === 'cancelled',
    'revoked batch completion',
  );
  assert.deepEqual(
    (
      await db.read(
        'SELECT processed,inserted,cancelled FROM liekan_warehouse_upload WHERE batch_id=$1::uuid',
        [revokedBatch],
      )
    )[0],
    { processed: 1, inserted: 0, cancelled: 1 },
  );
  cases.push({
    name: 'revoked source is durably cancelled without new facts or a permanently blocked batch',
    status: 'pass',
  });
  await worker.close();
  await start(logPlanner(db, ch));
  await db.transaction(tx =>
    tx.query(
      'UPDATE liekan_warehouse_site SET policy_revision=policy_revision+1 WHERE website_id=$1::uuid',
      [siteB],
    ),
  );
  const policyBatch = randomUUID();
  await registerUpload(policyBatch, 1);
  await queue.enqueueMany([
    logEnvelope(s, installation, records[0], {
      batchId: policyBatch,
      sourceId: null,
      sourceEpoch: 1,
      kind: 'manual',
      receivedAt: at,
    }),
  ]);
  await until(
    async () =>
      (
        await db.read<{ status: string }>(
          'SELECT status FROM liekan_warehouse_upload WHERE batch_id=$1::uuid',
          [policyBatch],
        )
      )[0].status === 'processed',
    'policy change after enqueue',
  );
  assert.deepEqual(
    (
      await db.read(
        'SELECT processed,duplicates,cancelled FROM liekan_warehouse_upload WHERE batch_id=$1::uuid',
        [policyBatch],
      )
    )[0],
    { processed: 1, duplicates: 1, cancelled: 0 },
  );
  cases.push({
    name: 'policy revision change does not discard acknowledged log input',
    status: 'pass',
  });
  await worker.close();
  const taskRuntime = await WarehouseRuntime.connect({
    databaseURL: url.toString(),
    clickhouseURL: testClickHouseURL,
    clickhouseDatabase: run,
    queue: options,
  });
  try {
    const now = new Date(),
      windowEnd = new Date(Math.floor(+now / 60000) * 60000),
      next = new Date(+windowEnd + 60000);
    await db.transaction(tx =>
      tx.query(
        "INSERT INTO liekan_browser_risk_state(website_id,epoch,next_window,rule_version) VALUES($1,1,$2,'fixture')",
        [siteB, windowEnd],
      ),
    );
    const result = {
      kind: 'browser-risk' as const,
      windowEnd: windowEnd.toISOString(),
      logEpoch: '1',
      ruleVersion: 'fixture',
      coverage: 'observed' as const,
      events: 120,
      visits: 1,
      insufficient: 0,
      flagged: 1,
      nextBefore: windowEnd.toISOString(),
      nextAfter: next.toISOString(),
    };
    const fact = {
      family: 'liekan_browser_risk',
      row: factInput('liekan_browser_risk', {
        website_id: siteB,
        window_end: windowEnd,
        session_id: randomUUID(),
        visit_id: randomUUID(),
        reasons: ['regular-timing'],
        features: { pageviews: 120 },
      }),
    };
    const taskId = await prepareWarehouseTask(taskRuntime, await control.site(siteB), result, [
      fact,
    ]);
    await start(taskPlanner(db), true);
    const taskStatus = async (id: string) =>
      (
        await db.read<{ status: string }>(
          'SELECT status FROM liekan_warehouse_task WHERE task_id=$1',
          [id],
        )
      )[0].status;
    await until(
      async () => (await taskStatus(taskId)) === 'published',
      'risk task complete publication',
    );
    const riskCount = async () => {
      const site = await control.site(siteB);
      const [r] = await ch
        .query({
          query: `SELECT count() AS n FROM ${factRelation('liekan_browser_risk')}`,
          query_params: boundaryParameters({
            websiteId: siteB,
            epoch: site.epoch,
            publication: site.publication,
            deletionRevision: site.deletion_revision,
          }),
          format: 'JSONEachRow',
        })
        .then(r => r.json<{ n: string }>());
      return Number(r.n);
    };
    assert.equal(await riskCount(), 1);
    const proofState = await control.site(siteB);
    const [proofCount] = await ch
      .query({
        query: `SELECT count() AS n FROM ${riskRelation()}`,
        query_params: {
          ...boundaryParameters({
            websiteId: siteB,
            epoch: proofState.epoch,
            publication: proofState.publication,
            deletionRevision: proofState.deletion_revision,
          }),
          riskRule: 'fixture',
          riskEpoch: '1',
        },
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ n: string }>());
    assert.equal(proofCount.n, '1');

    assert.equal(
      (
        await db.read<{ n: string }>(
          'SELECT count(*)::text AS n FROM liekan_browser_risk WHERE website_id=$1',
          [siteB],
        )
      )[0].n,
      '0',
    );
    assert.equal(
      (
        await db.read<{ n: number }>(
          'SELECT flagged AS n FROM liekan_browser_risk_window WHERE website_id=$1',
          [siteB],
        )
      )[0].n,
      1,
    );
    const second = await prepareWarehouseTask(
      taskRuntime,
      await control.site(siteB),
      { ...result, flagged: 0, nextBefore: next.toISOString() },
      [{ ...fact, deleted: true }],
    );
    await until(
      async () => (await taskStatus(second)) === 'published',
      'risk correction tombstone',
    );
    assert.equal(await riskCount(), 0);
    assert.equal(
      (
        await db.read<{ n: number }>(
          'SELECT flagged AS n FROM liekan_browser_risk_window WHERE website_id=$1',
          [siteB],
        )
      )[0].n,
      0,
    );
    cases.push({
      name: 'internal risk task publishes CH facts and PG control atomically, corrections retract removed visits',
      status: 'pass',
    });
    await worker.close();
    const obsolete = await prepareWarehouseTask(taskRuntime, await control.site(siteB), result, [
      fact,
    ]);
    await db.transaction(tx =>
      tx.query(
        'UPDATE liekan_warehouse_site SET deletion_revision=deletion_revision+1 WHERE website_id=$1',
        [siteB],
      ),
    );
    await start(taskPlanner(db), true);
    await until(
      async () => (await taskStatus(obsolete)) === 'cancelled',
      'stale task snapshot cancellation',
    );
    assert.equal(await riskCount(), 0);
    cases.push({
      name: 'deletion boundary change cancels derived task without resurrecting visit facts',
      status: 'pass',
    });
    process.env.DATABASE_URL = url.toString();
    process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
    process.env.LIEKAN_CLICKHOUSE_URL = testClickHouseURL;
    process.env.LIEKAN_CLICKHOUSE_DATABASE = run;
    delete process.env.CLICKHOUSE_URL;
    const { processWarehouseBrowserRisk } = await import(
      '../../src/lib/liekan/upstream/warehouse-browser-risk'
    );
    const { browserRiskReport } = await import('../../src/lib/liekan/upstream/browser-risk');
    await worker.close();
    await start(
      collectionPlanner(browserPlanner(db), logPlanner(db, ch), undefined, taskPlanner(db)),
      true,
    );
    const rs = await control.site(siteB),
      riskSession = randomUUID(),
      riskVisit = randomUUID();
    await db.transaction(tx =>
      tx.query(
        "INSERT INTO liekan_collection_policy(website_id,mode,revision) VALUES($1,'standard',$2)",
        [siteB, rs.policy_revision],
      ),
    );
    const riskEnd = new Date(Math.floor((Date.now() - 180000) / 60000) * 60000);
    const makeRiskEvent = async (time: Date) => {
      const receipt = randomUUID(),
        fingerprint = createHash('sha256').update(receipt).digest('hex');
      const qualifiedIdentity = {
        ...identity,
        scope: 'browser' as const,
        available: true,
        sessionId: riskSession,
        classification: 'browser' as const,
      };
      const pkg = new WarehouseCollectionPackage(
        {
          websiteId: siteB,
          eventId: receipt,
          fingerprint,
          identity: qualifiedIdentity,
          quality: {
            classification: 'browser',
            source: 'browser',
            reasons: [],
            ruleVersion: 'traffic-quality-v4',
            rangeVersion: null,
            rangeStatus: 'missing',
            hostname: 'example.test',
          },
        },
        time,
      );
      await pkg.createSession({ id: riskSession, websiteId: siteB, createdAt: time });
      await pkg.identity(siteB, qualifiedIdentity);
      await pkg.saveEvent({
        websiteId: siteB,
        sessionId: riskSession,
        visitId: riskVisit,
        eventType: 1,
        urlPath: '/risk-fixture',
        createdAt: time,
      });
      return taskRuntime.envelope(await control.site(siteB), {
        websiteId: siteB,
        sessionId: riskSession,
        visitId: riskVisit,
        clientEventId: receipt,
        eventId: pkg.eventId,
        kind: 'browser',
        fingerprint,
        collectionSource: 'browser',
        collectionScope: 'browser',
        receivedAt: time.toISOString(),
        data: pkg.seal(),
      });
    };
    const inputs = [];
    for (let i = 0; i < 36; i++)
      inputs.push(await makeRiskEvent(new Date(+riskEnd - 100000 + i * 2000)));
    await queue.enqueueMany(inputs);
    await until(
      async () =>
        Number(
          (
            await db.read<{ n: string }>(
              "SELECT count(*)::text AS n FROM liekan_warehouse_work w JOIN liekan_warehouse_attempt a USING(attempt_id) WHERE w.input_id=ANY($1::uuid[]) AND a.status='projected'",
              [inputs.map(e => e.inputId)],
            )
          )[0].n,
        ) === inputs.length,
      'risk browser input publication',
    );
    await db.transaction(tx =>
      tx.query(
        'UPDATE liekan_browser_risk_state SET next_window=$2,next_attempt_at=now() WHERE website_id=$1',
        [siteB, riskEnd],
      ),
    );
    await processWarehouseBrowserRisk(taskRuntime);
    await until(
      async () =>
        (
          await db.read<{ events: number }>(
            'SELECT events FROM liekan_browser_risk_window WHERE website_id=$1 AND window_end=$2',
            [siteB, riskEnd],
          )
        )[0]?.events === 36,
      'real risk worker publication',
    );
    const riskRange = new URLSearchParams({
      startAt: String(+riskEnd - 300000),
      endAt: String(+riskEnd),
      timezone: 'UTC',
    });
    const riskReport: any = await browserRiskReport(siteB, riskRange);
    assert.equal(riskReport.findings.length, 1);
    assert.equal(riskReport.findings[0].features.pageviews, 36);
    assert.equal(riskReport.impact.includedPV, 36);
    assert.equal(riskReport.impact.flaggedPV, 36);
    assert.equal(riskReport.impact.fullyExcludedUV, 1);
    cases.push({
      name: 'real risk observer and report read CH events, publish verified findings and preserve qualified impact',
      status: 'pass',
    });
    const { authorizeWarehouseTask } = await import(
      '../../src/lib/liekan/upstream/warehouse-authority'
    );
    taskAuthority = authorizeWarehouseTask;
    await worker.close();
    await start(
      collectionPlanner(
        browserPlanner(db),
        logPlanner(db, ch),
        undefined,
        taskPlanner(db, taskAuthority),
      ),
      true,
    );
    const { actOnWarehouseTrafficExclusion } = await import(
      '../../src/lib/liekan/upstream/warehouse-traffic-exclusions'
    );
    const { warehouseQualityTotals, warehouseTrafficGovernanceState } = await import(
      '../../src/lib/liekan/upstream/warehouse-traffic-quality'
    );
    const { parseQualityRange } = await import('../../src/lib/liekan/upstream/traffic-quality');
    const actorId = randomUUID();
    await db.transaction(async tx => {
      await tx.query('INSERT INTO "user"(user_id,username,password,role) VALUES($1,$2,$3,$4)', [
        actorId,
        `isolated-${actorId}`,
        'isolated-disabled',
        'user',
      ]);
      await tx.query('UPDATE website SET user_id=$2 WHERE website_id=$1', [siteB, actorId]);
    });
    const previewInput = {
      action: 'preview',
      expectedRevision: '0',
      windowEnd: riskEnd.toISOString(),
      visits: [{ sessionId: riskSession, visitId: riskVisit }],
    };
    const beforeLate: any = await actOnWarehouseTrafficExclusion(
      siteB,
      previewInput,
      { userId: actorId },
      taskRuntime,
    );
    assert.equal(beforeLate.evidence.events, 36);
    assert.equal(
      (await warehouseQualityTotals(siteB, parseQualityRange(riskRange))).includedPV,
      36,
    );
    const late = await makeRiskEvent(new Date(+riskEnd - 28000));
    await queue.enqueue(late);
    await completion.wait(late, 30000);
    assert.equal(
      (
        await db.read<{ next_window: Date }>(
          'SELECT next_window FROM liekan_browser_risk_state WHERE website_id=$1',
          [siteB],
        )
      )[0].next_window.toISOString(),
      riskEnd.toISOString(),
    );
    await processWarehouseBrowserRisk(taskRuntime);
    await until(
      async () =>
        (
          await db.read<{ events: number }>(
            'SELECT events FROM liekan_browser_risk_window WHERE website_id=$1 AND window_end=$2',
            [siteB, riskEnd],
          )
        )[0]?.events === 37,
      'late queued event reopens risk window',
    );
    assert.equal(
      ((await browserRiskReport(siteB, riskRange)) as any).findings[0].features.pageviews,
      37,
    );
    assert.equal(
      (
        await db.read<{ n: string }>(
          'SELECT count(*)::text AS n FROM liekan_browser_risk WHERE website_id=$1',
          [siteB],
        )
      )[0].n,
      '0',
    );
    cases.push({
      name: 'late publication rewinds received-time observation and replaces prior risk generation',
      status: 'pass',
    });
    await assert.rejects(
      () =>
        actOnWarehouseTrafficExclusion(
          siteB,
          {
            action: 'confirm',
            expectedRevision: '0',
            previewId: beforeLate.id,
            digest: beforeLate.digest,
          },
          { userId: actorId },
          taskRuntime,
        ),
      /治理依据/,
    );
    cases.push({
      name: 'late input and reobserved window invalidate previously published governance preview',
      status: 'pass',
    });
    const preview: any = await actOnWarehouseTrafficExclusion(
      siteB,
      previewInput,
      { userId: actorId },
      taskRuntime,
    );
    assert.equal(preview.evidence.events, 37);
    const memberState = await control.site(siteB);
    const memberSessions = await ch
      .query({
        query: `SELECT DISTINCT _session_id FROM ${factRelation('liekan_traffic_exclusion_member')} WHERE collection_id={collection:UUID}`,
        query_params: {
          ...boundaryParameters({
            websiteId: siteB,
            epoch: memberState.epoch,
            publication: memberState.publication,
            deletionRevision: memberState.deletion_revision,
          }),
          collection: preview.id,
        },
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ _session_id: string }>());
    assert.deepEqual(memberSessions, [{ _session_id: riskSession }]);
    assert.equal(
      (
        await db.read<{ n: string }>(
          'SELECT count(*)::text AS n FROM liekan_traffic_exclusion_member',
        )
      )[0].n,
      '0',
    );
    const confirmed = await actOnWarehouseTrafficExclusion(
      siteB,
      { action: 'confirm', expectedRevision: '0', previewId: preview.id, digest: preview.digest },
      { userId: actorId },
      taskRuntime,
    );
    assert.equal(confirmed.revision, '1');
    assert.equal((await warehouseQualityTotals(siteB, parseQualityRange(riskRange))).includedPV, 0);
    const governance: any = await warehouseTrafficGovernanceState(siteB);
    assert.equal(governance.collections[0].events, 37);
    await assert.rejects(
      () =>
        actOnWarehouseTrafficExclusion(
          siteB,
          {
            action: 'confirm',
            expectedRevision: '1',
            previewId: preview.id,
            digest: preview.digest,
          },
          { userId: actorId },
          taskRuntime,
        ),
      /治理依据/,
    );
    const revoked = await actOnWarehouseTrafficExclusion(
      siteB,
      { action: 'revoke', expectedRevision: '1', collectionId: preview.id },
      { userId: actorId },
      taskRuntime,
    );
    assert.equal(revoked.revision, '2');
    assert.equal(
      (await warehouseQualityTotals(siteB, parseQualityRange(riskRange))).includedPV,
      37,
    );
    cases.push({
      name: 'CH membership preview, confirmation, totals, governance list and revocation work without PG member facts',
      status: 'pass',
    });
    const expired: any = await actOnWarehouseTrafficExclusion(
      siteB,
      { ...previewInput, expectedRevision: '2' },
      { userId: actorId },
      taskRuntime,
    );
    await db.transaction(tx =>
      tx.query(
        "UPDATE liekan_traffic_exclusion SET expires_at=now()-interval '1 second' WHERE id=$1",
        [expired.id],
      ),
    );
    await assert.rejects(
      () =>
        actOnWarehouseTrafficExclusion(
          siteB,
          {
            action: 'confirm',
            expectedRevision: '2',
            previewId: expired.id,
            digest: expired.digest,
          },
          { userId: actorId },
          taskRuntime,
        ),
      /治理依据/,
    );
    await db.transaction(tx =>
      tx.query('UPDATE website SET user_id=NULL WHERE website_id=$1', [siteB]),
    );
    await assert.rejects(
      () =>
        actOnWarehouseTrafficExclusion(
          siteB,
          { ...previewInput, expectedRevision: '2' },
          { userId: actorId },
          taskRuntime,
        ),
      /权限/,
    );
    cases.push({
      name: 'expired previews and revoked manager authority are rejected',
      status: 'pass',
    });
    await db.transaction(tx =>
      tx.query('UPDATE website SET user_id=$2 WHERE website_id=$1', [siteB, actorId]),
    );
    const { snapshot, requireRun } = await import(
      '../../src/lib/liekan/upstream/history-repair-db'
    );
    const { warehouseControlAdapter } = await import(
      '../../src/lib/liekan/upstream/warehouse-authority'
    );
    const { emptyCounts } = await import('../../src/lib/liekan/history-repair/model');
    const { emptyLogImpact } = await import('../../src/lib/liekan/history-repair/log-impact');
    const runId = randomUUID(),
      generation = randomUUID();
    const { withPublishedRegistry } = await import(
      '../../src/lib/liekan/upstream/crawler-registry-context'
    );
    const frozen = await withPublishedRegistry(() =>
      db.transaction(tx => snapshot(warehouseControlAdapter(tx) as any, siteB, 'UTC')),
    );
    const [repair] = await db.transaction(async tx => {
      await tx.query(
        "INSERT INTO liekan_history_repair_campaign(id,eligible_websites,engine_version) VALUES('traffic-quality-repair-20261022-v1',ARRAY[$1::uuid],$2) ON CONFLICT DO NOTHING",
        [siteB, frozen.rulepack.engine],
      );
      return (
        await tx.query<any>(
          `INSERT INTO liekan_history_repair_run(id,website_id,campaign_id,actor_id,status,phase,generation,repair_scope_id,snapshot,counts,locale)
        VALUES($1,$2,'traffic-quality-repair-20261022-v1',$3,'preparing','events',$4,$5,$6::jsonb,$7::jsonb,'zh-CN') RETURNING *`,
          [
            runId,
            siteB,
            actorId,
            generation,
            randomUUID(),
            JSON.stringify(frozen),
            JSON.stringify(emptyCounts()),
          ],
        )
      ).rows;
    });
    await worker.close();
    const taskResult: any = {
      kind: 'history-repair-batch',
      runId,
      generation,
      actorId,
      revision: repair.revision,
      inputRevision: repair.input_revision,
      scopeRevision: String(repair.scope_revision),
      authorityHash: frozen.authorityHash,
      beforeStatus: 'preparing',
      beforePhase: 'events',
      beforeCursor: {},
      next: {
        status: 'preparing',
        phase: 'undated-events',
        cursor: { membership: 'a'.repeat(64) },
        counts: { ...emptyCounts(), processed: '1', afterPV: '1' },
        logImpact: emptyLogImpact(),
        preview: null,
        errorCode: null,
        completedAt: null,
        membershipDigest: null,
      },
      days: [
        {
          day: '2026-11-03',
          beforePV: 0,
          afterPV: 1,
          beforeIdentityMissingPV: 0,
          afterIdentityMissingPV: 0,
          events: 1,
          logs: 0,
          changedEvents: 1,
          changedLogs: 0,
          evidence: 1,
          logEvidence: 0,
        },
      ],
      visitorDays: [],
      coverageDays: [],
    };
    const task = await prepareWarehouseTask(taskRuntime, await control.site(siteB), taskResult, [
      {
        family: 'liekan_history_repair_result',
        row: factInput('liekan_history_repair_result', {
          run_id: runId,
          website_id: siteB,
          generation,
          kind: 'event',
          record_id: inputs[0].eventId,
          before_value: { classification: 'unknown' },
          after_value: { classification: 'browser' },
          proof: { kind: 'fixture' },
          issue: null,
          created_at: new Date(),
        }),
      },
      {
        family: 'liekan_history_repair_visitor',
        row: factInput('liekan_history_repair_visitor', {
          run_id: runId,
          website_id: siteB,
          generation,
          scope_day: 'all',
          item_key: '',
          session_id: riskSession,
          before_included: false,
          after_included: true,
          created_at: new Date(),
        }),
      },
    ]);
    await assert.rejects(
      () =>
        db.transaction(tx =>
          requireRun(warehouseControlAdapter(tx) as any, siteB, { userId: actorId }),
        ),
      /正在发布/,
    );
    const { dispatchWarehouseRepairContinuations, reconcileHistoryRepairs } = await import(
      '../../src/lib/liekan/upstream/history-repair-worker'
    );
    const repairQueue = await getQueue();
    await db.transaction(async tx => {
      await tx.query(`CREATE FUNCTION test_repair_queue_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.name='liekan-history-repair' THEN RAISE EXCEPTION 'test-repair-queue-unavailable'; END IF;
          RETURN NEW;
        END; $$`);
      await tx.query(`CREATE TRIGGER test_repair_queue_failure BEFORE INSERT ON liekan_jobs.job
        FOR EACH ROW EXECUTE FUNCTION test_repair_queue_failure()`);
    });
    await start(
      collectionPlanner(
        browserPlanner(db),
        logPlanner(db, ch),
        undefined,
        taskPlanner(db, taskAuthority),
      ),
      true,
    );
    await waitWarehouseTask(db, task, 30000);
    const continuationJobs = () =>
      db.read<{ id: string; state: string; step: string }>(
        `SELECT id,state::text,data->>'stepId' AS step FROM liekan_jobs.job
         WHERE name='liekan-history-repair' AND data->>'runId'=$1 ORDER BY created_on`,
        [runId],
      );
    const updated = (
      await db.read<any>(
        'SELECT phase,counts,queued_job_id FROM liekan_history_repair_run WHERE id=$1',
        [runId],
      )
    )[0];
    assert.equal(updated.phase, 'undated-events');
    assert.equal(updated.counts.processed, '1');
    assert.equal(updated.queued_job_id, task);
    const pendingContinuations = () =>
      db.read<{ step_id: string }>(
        'SELECT step_id FROM liekan_warehouse_repair_continuation WHERE run_id=$1',
        [runId],
      );
    await assert.rejects(
      () => dispatchWarehouseRepairContinuations(repairQueue),
      /history-repair-continuation-dispatch-failed/,
    );
    assert.deepEqual(await pendingContinuations(), [{ step_id: task }]);
    assert.deepEqual(await continuationJobs(), []);
    const liveIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const liveBatch = randomUUID(),
        id = createHash('sha256').update(liveBatch).digest('hex');
      liveIds.push(id);
      await registerUpload(liveBatch, 1, repair.repair_scope_id);
      await queue.enqueue(
        logEnvelope(
          await control.site(siteB),
          installation,
          { ...records[0], id, time: new Date().toISOString() },
          { batchId: liveBatch, sourceId: null, sourceEpoch: 1, kind: 'manual', receivedAt: at },
        ),
      );
      await until(async () => {
        const [upload] = await db.read<{ status: string; inserted: number }>(
          'SELECT status,inserted FROM liekan_warehouse_upload WHERE batch_id=$1',
          [liveBatch],
        );
        return upload.status === 'processed' && upload.inserted === 1;
      }, 'ordinary same-site log publishes while repair queue rejects inserts');
    }
    const live = await control.site(siteB);
    const [visible] = await ch
      .query({
        query: `SELECT count() AS n FROM ${factRelation('liekan_log')} WHERE id IN {ids:Array(String)}`,
        query_params: {
          ...boundaryParameters({
            websiteId: siteB,
            epoch: live.epoch,
            publication: live.publication,
            deletionRevision: live.deletion_revision,
          }),
          ids: liveIds,
        },
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ n: string }>());
    assert.equal(visible.n, String(liveIds.length));
    await assert.rejects(
      () => dispatchWarehouseRepairContinuations(repairQueue),
      /history-repair-continuation-dispatch-failed/,
    );
    assert.deepEqual(await pendingContinuations(), [{ step_id: task }]);
    await db.transaction(tx =>
      tx.query(
        "UPDATE liekan_history_repair_run SET updated_at=now()-interval '2 minutes' WHERE id=$1",
        [runId],
      ),
    );
    await reconcileHistoryRepairs();
    assert.deepEqual(await pendingContinuations(), [{ step_id: task }]);
    assert.deepEqual(await continuationJobs(), []);
    await db.transaction(tx =>
      tx.query('DROP TRIGGER test_repair_queue_failure ON liekan_jobs.job'),
    );
    await Promise.all([
      dispatchWarehouseRepairContinuations(repairQueue),
      dispatchWarehouseRepairContinuations(repairQueue),
    ]);
    await dispatchWarehouseRepairContinuations(repairQueue);
    assert.deepEqual(await pendingContinuations(), []);
    const jobsAfterPublication = await continuationJobs();
    assert.deepEqual(jobsAfterPublication, [
      { id: updated.queued_job_id, state: 'created', step: updated.queued_job_id },
    ]);
    assert.equal(
      (
        await db.read<{ n: string }>('SELECT count(*)::text AS n FROM liekan_history_repair_result')
      )[0].n,
      '0',
    );
    assert.equal(
      (
        await db.read<{ n: string }>(
          'SELECT count(*)::text AS n FROM liekan_history_repair_visitor',
        )
      )[0].n,
      '0',
    );
    assert.equal(
      (
        await db.read<{ n: string }>(
          'SELECT after_pv::text AS n FROM liekan_history_repair_day WHERE run_id=$1',
          [runId],
        )
      )[0].n,
      '1',
    );
    await db.transaction(tx =>
      requireRun(warehouseControlAdapter(tx) as any, siteB, { userId: actorId }),
    );
    const outbox = await ch
      .query({
        query:
          "SELECT value FROM warehouse_control_projection WHERE kind='task-outbox-v1' AND key={key:String} LIMIT 1",
        query_params: { key: task },
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ value: string }>());
    await queue.enqueue(JSON.parse(outbox[0].value));
    await delay(1000);
    assert.deepEqual(await continuationJobs(), jobsAfterPublication);
    assert.equal(
      (
        await db.read<{ n: string }>(
          'SELECT after_pv::text AS n FROM liekan_history_repair_day WHERE run_id=$1',
          [runId],
        )
      )[0].n,
      '1',
    );
    cases.push({
      name: 'repair batch publishes CH result/visitor facts and PG cursor/day counts atomically; nested metadata survives jsonb order, edits fence pending work and replay does not recount',
      status: 'pass',
    });
    cases.push({
      name: 'repair queue insert failure leaves durable continuation; same-site intake publishes and racing dispatchers enqueue exactly once on recovery',
      status: 'pass',
    });
    const { warehouseReportMetadata } = await import(
      '../../src/lib/liekan/upstream/warehouse-report-snapshot'
    );
    const { warehouseRepairSourceCounts } = await import(
      '../../src/lib/liekan/upstream/warehouse-history-repair-read'
    );
    const { planWarehouseRepairBatch } = await import(
      '../../src/lib/liekan/upstream/warehouse-history-repair-plan'
    );
    const sourceBoundary = (await warehouseReportMetadata(siteB)).boundary;
    const completeSnapshot = { ...frozen, warehouseSource: sourceBoundary },
      completeGeneration = randomUUID();
    const sourceCounts = await warehouseRepairSourceCounts({
      ...repair,
      snapshot: completeSnapshot,
    } as any);
    await db.transaction(tx =>
      tx.query(
        `UPDATE liekan_history_repair_run SET generation=$2,snapshot=$3::jsonb,counts=$4::jsonb,
      phase='events',status='preparing',cursor='{}',log_impact='{}',preview=NULL,scope_finalized=true,revision=revision+1,batch_size=100 WHERE id=$1`,
        [
          runId,
          completeGeneration,
          JSON.stringify(completeSnapshot),
          JSON.stringify({
            ...emptyCounts(),
            events: sourceCounts.events,
            logs: sourceCounts.logs,
            missingQuality: sourceCounts.missing,
          }),
        ],
      ),
    );
    let finished: any,
      steps = 0;
    while (steps++ < 25) {
      const [r] = await db.read<any>('SELECT * FROM liekan_history_repair_run WHERE id=$1', [
        runId,
      ]);
      if (r.preview?.complete) {
        finished = r;
        break;
      }
      const planned = await planWarehouseRepairBatch(r);
      const nextTask = await prepareWarehouseTask(
        taskRuntime,
        await control.site(siteB),
        planned.result,
        planned.facts,
        async tx => {
          assert.equal(await authorizeWarehouseTask(tx, siteB, planned.result), true);
        },
      );
      await waitWarehouseTask(db, nextTask, 30000);
    }
    assert.ok(finished?.preview?.complete, 'bounded repair phases reach complete preview');
    assert.equal(
      finished.counts.processed,
      String(BigInt(sourceCounts.events) + BigInt(sourceCounts.logs)),
    );
    assert.equal(finished.counts.beforePV, '37');
    assert.equal(finished.counts.afterPV, '37');
    assert.equal(finished.counts.beforeUV, '1');
    assert.equal(finished.counts.afterUV, '1');
    assert.equal(
      (
        await db.read<{ n: string }>(
          'SELECT count(*)::text AS n FROM liekan_history_repair_visitor',
        )
      )[0].n,
      '0',
    );
    assert.equal(
      (
        await db.read<{ n: string }>('SELECT count(*)::text AS n FROM liekan_history_repair_result')
      )[0].n,
      '0',
    );
    assert.equal(finished.active_generation, null, 'complete preview does not activate itself');
    cases.push({
      name: 'real frozen CH repair plans progress across event/log/visitor/day phases with qualified counts, durable resumable batches and an inactive complete preview',
      status: 'pass',
      steps,
    });
    const { ingestWarehouseRepairEvidence } = await import(
      '../../src/lib/liekan/upstream/warehouse-history-repair-evidence'
    );
    const { warehouseRepairEvents, warehouseRepairEvidence } = await import(
      '../../src/lib/liekan/upstream/warehouse-history-repair-read'
    );
    const { evidenceManifestDigest } = await import('../../src/lib/liekan/history-repair/model');
    const event = (await warehouseRepairEvents({ ...finished, cursor: {} }))[0];
    const uploadId = randomUUID();
    let revision = finished.revision;
    const append: any = {
      action: 'append',
      actionId: randomUUID(),
      runId,
      uploadId,
      expectedRevision: revision,
      sequence: 0,
      source: 'isolated-evidence.jsonl',
      records: [
        {
          eventId: event.id,
          requestUserAgent:
            'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        },
      ],
    };
    const added = await ingestWarehouseRepairEvidence(
      siteB,
      append,
      { userId: actorId },
      taskRuntime,
    );
    revision = added.revision;
    assert.equal(added.accepted, 1);
    assert.equal(added.rejected, 0);
    assert.deepEqual(
      await ingestWarehouseRepairEvidence(siteB, append, { userId: actorId }, taskRuntime),
      added,
    );
    assert.equal(
      (await db.read<any>('SELECT count(*)::text AS n FROM liekan_history_repair_input'))[0].n,
      '0',
    );
    assert.equal(
      (
        await db.read<any>(
          'SELECT chunks FROM liekan_warehouse_repair_upload WHERE run_id=$1 AND upload_id=$2',
          [runId, uploadId],
        )
      )[0].chunks,
      1,
    );
    await assert.rejects(
      () =>
        ingestWarehouseRepairEvidence(
          siteB,
          {
            ...append,
            actionId: randomUUID(),
            expectedRevision: revision,
            records: [{ eventId: event.id, requestUserAgent: 'different' }],
          },
          { userId: actorId },
          taskRuntime,
        ),
      /内容已改变/,
    );
    const finalized = await ingestWarehouseRepairEvidence(
      siteB,
      {
        action: 'finalize',
        actionId: randomUUID(),
        runId,
        uploadId,
        expectedRevision: revision,
        chunks: 1,
        rows: 1,
        manifestDigest: evidenceManifestDigest([added.hash]),
      },
      { userId: actorId },
      taskRuntime,
    );
    revision = finalized.revision;
    assert.equal(finalized.finalized, true);
    let evidenceRun = (
      await db.read<any>('SELECT * FROM liekan_history_repair_run WHERE id=$1', [runId])
    )[0];
    const matched = await warehouseRepairEvidence(evidenceRun, [event.id]);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].record.automated, true);
    cases.push({
      name: 'CH evidence append is idempotent, validates changed chunks, finalizes ordered manifest and retains only file control in PG',
      status: 'pass',
    });
    const badUpload = randomUUID(),
      bad = await ingestWarehouseRepairEvidence(
        siteB,
        {
          ...append,
          actionId: randomUUID(),
          uploadId: badUpload,
          expectedRevision: revision,
          records: [
            { eventId: event.id, requestUserAgent: 'Mozilla/5.0 human browser' },
            { eventId: randomUUID(), requestUserAgent: 'test-bot' },
          ],
        },
        { userId: actorId },
        taskRuntime,
      );
    revision = bad.revision;
    assert.equal(bad.accepted, 0);
    assert.deepEqual(
      bad.errors.map(e => e.code),
      ['conflicting-event-evidence', 'event-not-resolved'],
    );
    await assert.rejects(
      () =>
        ingestWarehouseRepairEvidence(
          siteB,
          {
            action: 'finalize',
            actionId: randomUUID(),
            runId,
            uploadId: badUpload,
            expectedRevision: revision,
            chunks: 1,
            rows: 2,
            manifestDigest: evidenceManifestDigest([bad.hash]),
          },
          { userId: actorId },
          taskRuntime,
        ),
      /无效行/,
    );
    const discarded = await ingestWarehouseRepairEvidence(
      siteB,
      {
        action: 'discard',
        actionId: randomUUID(),
        runId,
        uploadId: badUpload,
        expectedRevision: revision,
      },
      { userId: actorId },
      taskRuntime,
    );
    revision = discarded.revision;
    assert.equal(discarded.discarded, true);
    const goodDiscard = await ingestWarehouseRepairEvidence(
      siteB,
      { action: 'discard', actionId: randomUUID(), runId, uploadId, expectedRevision: revision },
      { userId: actorId },
      taskRuntime,
    );
    revision = goodDiscard.revision;
    evidenceRun = (
      await db.read<any>('SELECT * FROM liekan_history_repair_run WHERE id=$1', [runId])
    )[0];
    assert.deepEqual(await warehouseRepairEvidence(evidenceRun, [event.id]), []);
    const rawInputs = await ch
      .query({
        query: `SELECT records FROM ${factRelation('liekan_history_repair_input')} WHERE run_id={rid:UUID}`,
        query_params: {
          ...boundaryParameters((await warehouseReportMetadata(siteB)).boundary),
          rid: runId,
        },
        format: 'JSONEachRow',
      })
      .then(r => r.json<any>());
    assert.equal(rawInputs.length, 2);
    assert.ok(
      rawInputs.every(r => !r.records.includes('Googlebot') && !r.records.includes('Mozilla')),
    );
    cases.push({
      name: 'conflicting/unresolved evidence rejects finalize; discard removes input eligibility while immutable hashed evidence remains auditable without raw UA',
      status: 'pass',
    });
    const { previewHistoryRepair, confirmHistoryRepair, actHistoryRepair, getHistoryRepair } =
      await import('../../src/lib/liekan/upstream/history-repair');
    const { processHistoryRepairJob } = await import(
      '../../src/lib/liekan/upstream/history-repair-worker'
    );
    await db.transaction(async tx => {
      await tx.query(
        "INSERT INTO liekan_queue_installation(id,package_version,checksum) VALUES('liekan_jobs','12.36.0',$1) ON CONFLICT(id) DO UPDATE SET package_version=EXCLUDED.package_version",
        ['0'.repeat(64)],
      );
      await tx.query(
        "INSERT INTO liekan_worker_state(id,version) VALUES('warehouse-isolated-repair','history-repair-v1.2') ON CONFLICT(id) DO UPDATE SET heartbeat_at=clock_timestamp()",
      );
    });
    const boss = await getQueue();
    try {
      const activeUpload = randomUUID(),
        newEvidence = await ingestWarehouseRepairEvidence(
          siteB,
          { ...append, actionId: randomUUID(), uploadId: activeUpload, expectedRevision: revision },
          { userId: actorId },
          taskRuntime,
        );
      const readyInput = await ingestWarehouseRepairEvidence(
        siteB,
        {
          action: 'finalize',
          actionId: randomUUID(),
          runId,
          uploadId: activeUpload,
          expectedRevision: newEvidence.revision,
          chunks: 1,
          rows: 1,
          manifestDigest: evidenceManifestDigest([newEvidence.hash]),
        },
        { userId: actorId },
        taskRuntime,
      );
      await previewHistoryRepair(
        siteB,
        { actionId: randomUUID(), runId, expectedRevision: readyInput.revision },
        { userId: actorId },
      );
      const workOne = async () => {
        const jobs = await boss.fetch<{ runId: string; stepId: string }>('liekan-history-repair', {
          batchSize: 1,
        });
        for (const job of jobs) {
          await processHistoryRepairJob(job.data, taskRuntime);
          await boss.complete('liekan-history-repair', job.id);
        }
        return jobs.length;
      };
      let ready: any;
      await until(async () => {
        await dispatchWarehouseRepairContinuations(boss);
        await workOne();
        const [r] = await db.read<any>('SELECT * FROM liekan_history_repair_run WHERE id=$1', [
          runId,
        ]);
        if (r.status === 'ready') {
          ready = r;
          return true;
        }
        assert.ok(
          ['scanning', 'preparing'].includes(r.status),
          `repair job ended with ${r.status}/${r.error_code}`,
        );
        return false;
      }, 'repair preview via publication continuations');
      assert.ok(ready?.preview.complete, 'real queue steps complete a preview');
      assert.equal(ready.queued_job_id, null);
      assert.equal(ready.counts.afterPV, '36');
      assert.equal(ready.active_generation, null);
      const detail = await getHistoryRepair(siteB, { view: 'status' }, { userId: actorId });
      assert.equal(detail.uploads.find(u => u.id === activeUpload).finalized, true);
      assert.equal(detail.hasData, true);
      await confirmHistoryRepair(
        siteB,
        {
          actionId: randomUUID(),
          runId,
          expectedRevision: ready.revision,
          generation: ready.generation,
          previewDigest: ready.preview.digest,
          partialConfirmed: true,
        },
        { userId: actorId },
      );
      await workOne();
      await workOne();
      let [active] = await db.read<any>('SELECT * FROM liekan_history_repair_run WHERE id=$1', [
        runId,
      ]);
      assert.equal(active.active_generation, ready.generation);
      assert.ok(['completed', 'completed_limited'].includes(active.status));
      const activated = await warehouseQualityTotals(siteB, parseQualityRange(riskRange));
      assert.equal(activated.includedPV, 36);
      await actHistoryRepair(
        siteB,
        { action: 'rollback', actionId: randomUUID(), runId, expectedRevision: active.revision },
        { userId: actorId },
      );
      const reverted = await warehouseQualityTotals(siteB, parseQualityRange(riskRange));
      assert.equal(reverted.includedPV, 37);
      const audit = await getHistoryRepair(
        siteB,
        { view: 'preview', generation: ready.generation },
        { userId: actorId },
      );
      assert.equal(audit.selectedGeneration.id, ready.generation);
      cases.push({
        name: 'real PG task queue drives frozen CH repair through explicit confirmation, report activation and rollback with archived preview retained',
        status: 'pass',
      });
    } finally {
      await closeQueue();
    }
  } finally {
    await taskRuntime.close();
  }
  console.log(`PASS ${cases.length} formal warehouse consumer cases`);
} catch (error) {
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
  console.error(error instanceof Error ? error.message : 'Warehouse consumer failed');
  process.exitCode = 1;
} finally {
  await closeQueue();
  if (process.env.LIEKAN_CLICKHOUSE_DATABASE === run)
    await (await import('../../src/lib/liekan/warehouse/reader-runtime')).warehouseReader().close();
  await worker?.close();
  await completion?.close();
  await Promise.allSettled([
    rawProducer.disconnect(),
    queue?.close(),
    broker.disconnect(),
    admin.end(),
    db.close(),
    ch.close(),
    chAdmin.close(),
  ]);
  await mkdir('.local/ch-implementation', { recursive: true, mode: 0o700 });
  await writeFile(
    `.local/ch-implementation/${run}.json`,
    JSON.stringify({ run, cases, health, fullUpgradeValidated: false }, null, 2),
    { mode: 0o600 },
  );
}
