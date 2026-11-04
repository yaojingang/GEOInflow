import {
  testClickHouseURL,
  testPostgresPort,
  testPostgresPasswordFile,
} from './warehouse-test-target';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { Kafka, logLevel } from 'kafkajs';
import type { LogRecord } from '../../src/lib/liekan/ingest';
import { WarehouseCollectionPackage } from '../../src/lib/liekan/upstream/warehouse-collection-package';
import { browserPlanner } from '../../src/lib/liekan/warehouse/browser-planner';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { WarehouseCompletion } from '../../src/lib/liekan/warehouse/completion';
import { WarehouseConsumer } from '../../src/lib/liekan/warehouse/consumer';
import { WarehouseControl } from '../../src/lib/liekan/warehouse/control';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { WarehouseDeletions } from '../../src/lib/liekan/warehouse/deletions';
import { WarehouseRuntime } from '../../src/lib/liekan/warehouse/runtime';
import { WarehouseRecoveryGC } from '../../src/lib/liekan/warehouse/recovery-gc';
import {
  withinWarehouseAuthority,
  warehouseEnabled,
} from '../../src/lib/liekan/warehouse/authority-routing';
import {
  sessionPropertyRelation,
  reportingParameters,
} from '../../src/lib/liekan/warehouse/reporting-relations';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
import { initializeWarehouse } from '../../src/lib/liekan/warehouse/initialize';
import { logEnvelope } from '../../src/lib/liekan/warehouse/log-package';
import { logPlanner } from '../../src/lib/liekan/warehouse/log-planner';
import { collectionPlanner } from '../../src/lib/liekan/warehouse/planner';
import { PostgresAuthority } from '../../src/lib/liekan/warehouse/postgres-authority';
import {
  postgresLogLookup,
  postgresRecorderLookup,
} from '../../src/lib/liekan/warehouse/postgres-lookups';
import { boundaryParameters, factRelation } from '../../src/lib/liekan/warehouse/read';
import { recorderPlanner } from '../../src/lib/liekan/warehouse/recorder-planner';
import type { InputEnvelope } from '../../src/lib/liekan/warehouse/routing';
import { TransitionApplier } from '../../src/lib/liekan/warehouse/transition-apply';
import {
  TransitionCapture,
  captureAuthoritativeResult,
  decisionResult,
} from '../../src/lib/liekan/warehouse/transition-capture';
import { TransitionStream } from '../../src/lib/liekan/warehouse/transition-stream';
import { WarehouseQueue, inspectQueueTopic } from '../../src/lib/liekan/warehouse/transport';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_pgqueue_${Date.now()}`,
  password = (await readFile(testPostgresPasswordFile, 'utf8')).trim();
const connection = { host: '127.0.0.1', port: testPostgresPort, user: 'liekan_ch_proto', password };
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' }),
  url = new URL(`postgresql://127.0.0.1:${testPostgresPort}/${run}`);
url.username = connection.user;
url.password = password;
const db = new ControlDatabase(url.toString()),
  control = new WarehouseControl(db, 'postgres');
const offline = createWarehouseClient({
  url: 'http://127.0.0.1:9',
  database: run,
  request_timeout: 100,
});
const chAdmin = createWarehouseClient({ url: testClickHouseURL }),
  ch = createWarehouseClient({
    url: testClickHouseURL,
    database: run,
    request_timeout: 30000,
    clickhouse_settings: { max_threads: 1, max_memory_usage: '268435456' },
  });
const options = { brokers: ['127.0.0.1:29109'] },
  broker = new Kafka({ ...options, logLevel: logLevel.NOTHING }).admin();
const site = randomUUID(),
  cases: object[] = [],
  health: string[] = [];
let queue: WarehouseQueue,
  resultQueue: WarehouseQueue,
  stream: TransitionStream,
  worker: WarehouseConsumer,
  completion: WarehouseCompletion;
let runtime: WarehouseRuntime;
const at = new Date('2026-11-03T12:00:00Z');
async function until(check: () => Promise<boolean>, label: string) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timeout ${label}: ${health.slice(-3).join(',')}`);
}
async function browser(
  clientEventId: string | null = randomUUID(),
  fingerprint = 'a'.repeat(64),
  identify = false,
  sessionId: string = randomUUID(),
  visitId: string = randomUUID(),
) {
  const identity = {
    scope: 'browser' as const,
    available: true,
    version: 'cookieless-trusted-input-v3',
    sessionId,
    browser: 'chrome',
    os: 'Windows',
    device: 'desktop',
    screen: '1920x1080',
    language: 'zh-CN',
    originHostname: null,
    distinctId: null,
    hostname: 'pgqueue.invalid',
    classification: 'browser' as const,
  };
  const p = new WarehouseCollectionPackage(
    {
      websiteId: site,
      eventId: clientEventId,
      fingerprint,
      identify,
      identity,
      quality: {
        classification: 'browser',
        source: 'browser',
        reasons: [],
        ruleVersion: 'traffic-quality-v4',
        rangeVersion: null,
        rangeStatus: 'missing',
        hostname: 'pgqueue.invalid',
      },
    },
    at,
  );
  await p.createSession({ id: sessionId, websiteId: site, createdAt: at });
  await p.identity(site, identity);
  if (identify)
    await p.saveSessionData({
      websiteId: site,
      sessionId,
      sessionData: { plan: 'test', amount: 1.23445 },
    });
  else
    await p.saveEvent({
      websiteId: site,
      sessionId,
      visitId,
      eventType: 2,
      eventName: 'purchase',
      urlPath: '/purchase',
      createdAt: at,
      eventData: { revenue: 1.23445, currency: 'CNY' },
    });
  return {
    version: 1,
    routingVersion: 1,
    topicId: queue.installation.topicId,
    websiteId: site,
    sessionId,
    visitId,
    eventId: p.eventId,
    clientEventId,
    inputId: randomUUID(),
    epoch: (await control.site(site)).epoch,
    policyRevision: '0',
    kind: identify ? 'identify' : 'browser',
    fingerprint,
    collectionSource: 'browser',
    collectionScope: 'browser',
    receivedAt: at.toISOString(),
    data: p.seal(),
  } as InputEnvelope;
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
  await broker.connect();
  await broker.createTopics({
    waitForLeaders: true,
    topics: [run, `${run}_results`].map(topic => ({
      topic,
      numPartitions: 1,
      replicationFactor: 1,
      configEntries: [
        { name: 'retention.ms', value: '-1' },
        { name: 'retention.bytes', value: '-1' },
        { name: 'flush.messages', value: '1' },
        { name: 'segment.bytes', value: '1048576' },
        { name: 'max.message.bytes', value: String(12 * 1024 * 1024) },
      ],
    })),
  });
  const installation = await inspectQueueTopic(options, run),
    resultInstallation = await inspectQueueTopic(options, `${run}_results`);
  queue = new WarehouseQueue(options, installation);
  resultQueue = new WarehouseQueue(options, resultInstallation);
  await queue.connect();
  await resultQueue.connect();
  stream = new TransitionStream(db, resultQueue);
  await db.transaction(async tx => {
    await tx.query(
      "INSERT INTO website(website_id,name,domain) VALUES($1,'Isolated PG queue','pgqueue.invalid')",
      [site],
    );
    await tx.query('INSERT INTO liekan_warehouse_site(website_id) VALUES($1)', [site]);
    await tx.query(
      "INSERT INTO liekan_warehouse_installation(id,installation_id,schema_version,routing_version,topic_name,topic_id,partition_count,authority,transition) VALUES(1,$1,2,1,$2,$3,1,'postgres','shadow')",
      [randomUUID(), run, installation.topicId],
    );
    await tx.query('INSERT INTO liekan_warehouse_partition(topic_id,partition) VALUES($1,0)', [
      installation.topicId,
    ]);
    await tx.query('UPDATE liekan_warehouse_installation SET facts_fenced=true');
  });
  await new TransitionCapture(db).start({ name: `${run}_results`, id: resultInstallation.topicId });
  const planner = collectionPlanner(
    browserPlanner(db),
    logPlanner(db, offline, undefined, postgresLogLookup(db)),
    recorderPlanner(offline, undefined, postgresRecorderLookup(db)),
  );
  const start = async () => {
    const processor = new PostgresAuthority(control, planner, async () => {});
    worker = new WarehouseConsumer(control, offline, queue, planner, {
      groupId: run,
      cacheBytes: 0,
      authorityProcessor: {
        recover: (owner, attempt) => processor.recover(owner, attempt),
        process: async (owner, attempt, inputs) => {
          try {
            await processor.process(owner, attempt, inputs);
          } catch (error) {
            const e = error as {
              code?: string;
              table?: string;
              column?: string;
              constraint?: string;
              message?: string;
            };
            console.error(
              JSON.stringify({
                code: e.code,
                table: e.table,
                column: e.column,
                constraint: e.constraint,
                message: e.message?.startsWith('warehouse-') ? e.message : undefined,
              }),
            );
            throw error;
          }
        },
      },
      onHealth: h => health.push(h.code),
    });
    await worker.start();
  };
  completion = new WarehouseCompletion(db, offline);
  await start();
  const first = await browser();
  await queue.enqueue(first);
  assert.equal((await completion.wait(first, 30000)).status, 'new');
  const identified = await browser(null, 'c'.repeat(64), true, first.sessionId, first.visitId);
  await queue.enqueue(identified);
  assert.equal((await completion.wait(identified, 30000)).status, 'new');
  for (const family of [
    'session',
    'website_event',
    'liekan_collection_receipt',
    'liekan_event_quality',
    'liekan_event_environment',
    'revenue',
  ])
    assert.equal(
      (await db.read<{ n: string }>(`SELECT count(*)::text AS n FROM ${family}`))[0].n,
      '1',
      family,
    );
  assert.equal(
    (await db.read<{ n: string }>('SELECT count(*)::text AS n FROM session_data'))[0].n,
    '2',
  );
  assert.equal(
    (await db.read<{ revenue: string }>('SELECT revenue::text FROM revenue'))[0].revenue,
    '1.2345',
  );
  assert.equal(
    (
      await db.read(
        'SELECT 1 FROM liekan_session_data_source s JOIN session_data d USING(website_id,session_id,data_key) WHERE s.row_digest=liekan_session_data_digest(d)',
      )
    ).length,
    2,
  );
  cases.push({
    name: 'real queue PG authority confirms complete browser/Decimal/property/quality package while CH is unreachable',
    status: 'pass',
  });
  const retry = await browser(first.clientEventId);
  await queue.enqueue(retry);
  assert.deepEqual(await completion.wait(retry, 30000), {
    status: 'duplicate',
    sessionId: first.sessionId,
    visitId: first.visitId,
  });
  const conflict = await browser(first.clientEventId, 'b'.repeat(64));
  await queue.enqueue(conflict);
  assert.equal((await completion.wait(conflict, 30000)).status, 'conflict');
  assert.equal(
    (await db.read<{ n: string }>('SELECT count(*)::text AS n FROM website_event'))[0].n,
    '1',
  );
  cases.push({
    name: 'same UUID retains canonical PG response; conflicting payload adds no event',
    status: 'pass',
  });
  const replay = (sessionId: string, visitId: string): InputEnvelope => ({
    ...first,
    inputId: randomUUID(),
    clientEventId: null,
    eventId: randomUUID(),
    sessionId,
    visitId,
    kind: 'replay',
    data: {
      format: 'recorder-v1',
      facts: [
        {
          family: 'session_replay',
          row: factInput('session_replay', {
            replay_id: randomUUID(),
            website_id: site,
            session_id: sessionId,
            visit_id: visitId,
            chunk_index: 0,
            events: Buffer.from('isolated'),
            event_count: 1,
            started_at: at,
            ended_at: at,
            created_at: at,
          }),
        },
      ],
    },
  });
  for (const [e, status] of [
    [replay(first.sessionId, first.visitId), 'new'],
    [replay(randomUUID(), randomUUID()), 'cancelled'],
  ] as const) {
    await queue.enqueue(e);
    assert.equal((await completion.wait(e, 30000)).status, status);
  }
  assert.equal((await db.read('SELECT 1 FROM session_replay')).length, 1);
  cases.push({
    name: 'recorder proves PG parent session and visit without querying CH',
    status: 'pass',
  });
  const record = {
    id: createHash('sha256').update(run).digest('hex'),
    time: at.toISOString(),
    path: '/log',
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
  } as LogRecord;
  const uploads = [];
  for (let round = 0; round < 2; round++) {
    const batchId = randomUUID(),
      digest = createHash('sha256').update(batchId).digest('hex');
    uploads.push(batchId);
    await db.transaction(async tx => {
      await tx.query(
        "INSERT INTO liekan_import(id,website_id,digest,accepted,rejected,kind,inserted) VALUES($1,$2,$3,0,0,'manual',0)",
        [batchId, site, digest],
      );
      await tx.query(
        "INSERT INTO liekan_warehouse_upload(batch_id,website_id,source_epoch,kind,digest,expected,queued) VALUES($1,$2,1,'manual',$3,2,true)",
        [batchId, site, digest],
      );
    });
    const state = await control.site(site);
    await queue.enqueueMany(
      [0, 1].map(recordIndex =>
        logEnvelope(state, installation, record, {
          batchId,
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
            'SELECT status FROM liekan_warehouse_upload WHERE batch_id=$1',
            [batchId],
          )
        )[0].status === 'processed',
      'PG log upload',
    );
    assert.deepEqual(
      (
        await db.read(
          'SELECT processed,inserted,duplicates FROM liekan_warehouse_upload WHERE batch_id=$1',
          [batchId],
        )
      )[0],
      { processed: 2, inserted: round ? 0 : 1, duplicates: round ? 2 : 1 },
    );
  }
  cases.push({
    name: 'PG log identity lookup deduplicates repeated and cross-batch records; upload counters commit exactly once',
    status: 'pass',
  });
  await worker.close();
  const afterRestart = await browser();
  await queue.enqueue(afterRestart);
  await start();
  assert.equal((await completion.wait(afterRestart, 30000)).status, 'new');
  await until(async () => {
    const [p] = await db.read<{ safe_offset: string; discovered_offset: string }>(
      'SELECT safe_offset,discovered_offset FROM liekan_warehouse_partition',
    );
    return p.safe_offset === p.discovered_offset;
  }, 'PG safe offset without shadow');
  cases.push({
    name: 'zero-cache consumer restart replays durable input and advances PG safe offset without CH publication',
    status: 'pass',
  });
  await worker.close();
  await chAdmin.command({ query: `CREATE DATABASE "${run}"` });
  await initializeWarehouse(ch);
  const effectsBefore = await db.read(
    'SELECT * FROM liekan_collection_diagnostic_state ORDER BY website_id',
  );
  const uploadsBefore = await db.read(
    'SELECT processed,inserted,duplicates FROM liekan_warehouse_upload ORDER BY batch_id',
  );
  while (await stream.publish()) {}
  const applier = new TransitionApplier(db, ch, stream);
  while (await applier.drain('clickhouse')) {}
  while (await applier.drain('postgres')) {}
  const s = await control.site(site),
    params = boundaryParameters({
      websiteId: site,
      epoch: s.epoch,
      publication: s.publication,
      deletionRevision: s.deletion_revision,
    });
  for (const family of [
    'session',
    'website_event',
    'event_data',
    'revenue',
    'session_data',
    'liekan_session_data_source',
    'liekan_collection_receipt',
    'session_replay',
    'liekan_log',
    'liekan_crawler_evidence',
  ]) {
    const [{ n: expected }] = await db.read<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${family}`,
    );
    const [{ n: actual }] = await ch
      .query({
        query: `SELECT count() AS n FROM ${factRelation(family)}`,
        query_params: params,
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ n: string }>());
    assert.equal(actual, expected, family);
  }
  assert.deepEqual(
    await db.read('SELECT * FROM liekan_collection_diagnostic_state ORDER BY website_id'),
    effectsBefore,
  );
  assert.deepEqual(
    await db.read(
      'SELECT processed,inserted,duplicates FROM liekan_warehouse_upload ORDER BY batch_id',
    ),
    uploadsBefore,
  );
  assert.equal(
    (await db.read('SELECT 1 FROM liekan_warehouse_attempt WHERE NOT effects_applied')).length,
    0,
  );
  cases.push({
    name: 'sealed PG outcomes replay through real result stream into complete CH facts, with effects applied once',
    status: 'pass',
  });
  const qualified = await ch
    .query({
      query: `SELECT count() AS n FROM ${sessionPropertyRelation()}`,
      format: 'JSONEachRow',
      query_params: reportingParameters({
        boundary: {
          websiteId: site,
          epoch: s.epoch,
          publication: s.publication,
          deletionRevision: s.deletion_revision,
        },
        resourceKind: 'website',
        controlRevision: '0',
        population: {},
        reports: [],
        policyMode: 'balanced',
        allowedHostnames: [],
        hostnames: [],
        intervals: [],
        repairRunId: null,
        repairGeneration: null,
        exclusions: [],
      }),
    })
    .then(r => r.json<{ n: string }>());
  assert.equal(qualified[0].n, '2');
  await assert.rejects(
    () => db.read("UPDATE website_event SET url_path='/uncaptured'"),
    /postgres-fact-writer-fenced/,
  );
  cases.push({
    name: 'PG property proof remains eligible at a nonzero CH version; legacy direct PG fact writers are fenced',
    status: 'pass',
  });
  runtime = await WarehouseRuntime.connect({
    databaseURL: url.toString(),
    clickhouseURL: testClickHouseURL,
    clickhouseDatabase: run,
    queue: options,
  });
  const deletions = new WarehouseDeletions(runtime),
    finalizer = { lock: async () => {}, apply: async () => {} };
  const sync = async () => {
    while (await stream.publish()) {}
    while (await applier.drain('clickhouse')) {}
    while (await applier.drain('postgres')) {}
  };
  const counts = async () => {
    const current = await control.site(site);
    const [{ n: pgCount }] = await db.read<{ n: string }>(
      'SELECT count(*)::text AS n FROM website_event',
    );
    const [{ n: chCount }] = await ch
      .query({
        query: `SELECT count() AS n FROM ${factRelation('website_event')}`,
        query_params: boundaryParameters({
          websiteId: site,
          epoch: current.epoch,
          publication: current.publication,
          deletionRevision: current.deletion_revision,
        }),
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ n: string }>());
    return { pg: pgCount, ch: chCount };
  };
  // The duplicate belongs to the deleted canonical session even when its new
  // submitted session is different. It is queued before H while the worker stops.
  const pending = await browser(first.clientEventId);
  await queue.enqueue(pending);
  const deletion = await deletions.begin(site, 'session', first.sessionId, null, {
    authorize: async () => {},
  });
  await deletions.advance(deletion.operation_id, finalizer);
  assert.ok(
    (
      await db.read(
        'SELECT 1 FROM liekan_warehouse_pg_receipt_tombstone WHERE client_event_id=$1',
        [first.clientEventId],
      )
    ).length,
  );
  await start();
  assert.equal((await completion.wait(pending, 30000)).status, 'cancelled');
  await worker.close();
  await sync();
  assert.deepEqual(await counts(), { pg: '1', ch: '1' });
  cases.push({
    name: 'PG session deletion propagates; pre-boundary UUID retry with a different submitted session is cancelled using the retained tombstone',
    status: 'pass',
  });
  await start();
  const beforeReset = await browser();
  await queue.enqueue(beforeReset);
  await completion.wait(beforeReset, 30000);
  await worker.close();
  const reset = await deletions.begin(site, 'reset', null, null, { authorize: async () => {} });
  await deletions.advance(reset.operation_id, finalizer);
  await start();
  const afterReset = await browser();
  await queue.enqueue(afterReset);
  await completion.wait(afterReset, 30000);
  await worker.close();
  await sync();
  assert.deepEqual(await counts(), { pg: '1', ch: '1' });
  const [remaining] = await db.read<{ event_id: string }>('SELECT event_id FROM website_event');
  assert.equal(remaining.event_id, afterReset.eventId);
  cases.push({
    name: 'PG reset while CH shadow lags allows authorized old-epoch publication but only the post-reset event remains visible',
    status: 'pass',
  });
  // Exercise both sides of the real authority flag. This deliberately does not
  // stand in for the coordinator boundary/audit tests.
  process.env.LIEKAN_WAREHOUSE_TRANSITION = 'true';
  assert.equal(await withinWarehouseAuthority(async () => warehouseEnabled(), db), false);
  await assert.rejects(
    () =>
      withinWarehouseAuthority(async () => {
        assert.equal(warehouseEnabled(), false);
        await db.read(
          "UPDATE liekan_warehouse_installation SET authority='clickhouse',revision=revision+1,transition='rollback'",
        );
        assert.equal(warehouseEnabled(), false);
      }, db),
    /warehouse-authority-changed/,
  );
  assert.equal(await withinWarehouseAuthority(async () => warehouseEnabled(), db), true);
  delete process.env.LIEKAN_WAREHOUSE_TRANSITION;
  cases.push({
    name: 'request authority stays pinned across flag change and rejects a mixed-backend response',
    status: 'pass',
  });
  await completion.close();
  completion = new WarehouseCompletion(db, ch);
  const chPlanner = collectionPlanner(browserPlanner(db), logPlanner(db, ch), recorderPlanner(ch));
  const startCH = async () => {
    worker = new WarehouseConsumer(new WarehouseControl(db), ch, queue, chPlanner, {
      groupId: run,
      cacheBytes: 0,
      onHealth: h => health.push(h.code),
      acceptResult: async (tx, a, d) => {
        await captureAuthoritativeResult(tx, decisionResult('clickhouse', a, d));
      },
    });
    await worker.start();
  };
  await startCH();
  const chEvent = await browser();
  await queue.enqueue(chEvent);
  await completion.wait(chEvent, 30000);
  await worker.close();
  assert.equal((await counts()).pg, '1');
  const chDelete = await deletions.begin(site, 'session', chEvent.sessionId, null, {
    authorize: async () => {},
  });
  await deletions.advance(chDelete.operation_id, finalizer);
  await startCH();
  const chBeforeReset = await browser();
  await queue.enqueue(chBeforeReset);
  await completion.wait(chBeforeReset, 30000);
  await worker.close();
  const chReset = await deletions.begin(site, 'reset', null, null, { authorize: async () => {} });
  await deletions.advance(chReset.operation_id, finalizer);
  await startCH();
  const chAfterReset = await browser();
  await queue.enqueue(chAfterReset);
  await completion.wait(chAfterReset, 30000);
  await worker.close();
  await sync();
  assert.deepEqual(await counts(), { pg: '1', ch: '1' });
  assert.equal(
    (await db.read<{ event_id: string }>('SELECT event_id FROM website_event'))[0].event_id,
    chAfterReset.eventId,
  );
  await db.read(
    "UPDATE liekan_warehouse_installation SET authority='postgres',revision=revision+1,transition='shadow'",
  );
  await start();
  const rollbackRetry = { ...chAfterReset, inputId: randomUUID() };
  await queue.enqueue(rollbackRetry);
  assert.equal((await completion.wait(rollbackRetry, 30000)).status, 'duplicate');
  await worker.close();
  await sync();
  cases.push({
    name: 'CH outcomes, deletion and reset replay in order to PG; rollback sees only the final event and preserves its UUID receipt',
    status: 'pass',
  });
  await db.read(
    "UPDATE liekan_warehouse_installation SET authority='clickhouse',revision=revision+1,transition='rollback'",
  );
  const capture = new TransitionCapture(db);
  const gc = new WarehouseRecoveryGC(db, queue);
  assert.deepEqual(await gc.collect(5000, 60), { work: 0, attempts: 0, journal: 0 });
  await capture.stopCapture();
  await sync();
  await capture.close();
  const [{ n: captured }] = await db.read<{ n: string }>(
    'SELECT count(*)::text AS n FROM liekan_warehouse_transition_result',
  );
  await startCH();
  const final = await browser(null);
  await queue.enqueue(final);
  await completion.wait(final, 30000);
  await worker.close();
  const [finalPosition] = await db.read<{ offset: string }>(
    'SELECT offset_id AS offset FROM liekan_warehouse_work WHERE input_id=$1',
    [final.inputId],
  );
  assert.deepEqual(await counts(), { pg: '1', ch: '2' });
  assert.equal(
    (
      await db.read<{ n: string }>(
        'SELECT count(*)::text AS n FROM liekan_warehouse_transition_result',
      )
    )[0].n,
    captured,
  );
  cases.push({
    name: 'after capture/drain/close, new CH collection grows neither PG facts nor the temporary result journal',
    status: 'pass',
  });
  await db.transaction(async tx => {
    await tx.query(
      "UPDATE liekan_warehouse_work SET updated_at=clock_timestamp()-interval '20 minutes'",
    );
    await tx.query(
      "UPDATE liekan_warehouse_attempt SET updated_at=clock_timestamp()-interval '20 minutes'",
    );
  });
  const chControl = new WarehouseControl(db),
    gcOwner = await chControl.claim(queue.installation.topicId, 0, randomUUID());
  await chControl.safeOffset(gcOwner);
  await chControl.release(gcOwner);
  const beforeGC = (
    await db.read<{ n: string }>('SELECT count(*)::text AS n FROM liekan_warehouse_work')
  )[0].n;
  const adminFactory = queue.kafka.admin.bind(queue.kafka);
  (queue.kafka as any).admin = () => {
    const original = adminFactory();
    return new Proxy(original, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === 'deleteTopicRecords')
          return async (args: any) => {
            await original.deleteTopicRecords(args);
            throw new Error('synthetic-trim-reply-lost');
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  try {
    await assert.rejects(() => gc.collect(5000, 60), /synthetic-trim-reply-lost/);
  } finally {
    (queue.kafka as any).admin = adminFactory;
  }
  assert.ok(
    BigInt(
      (await db.read<{ n: string }>('SELECT count(*)::text AS n FROM liekan_warehouse_work'))[0].n,
    ) < BigInt(beforeGC),
  );
  const removed = await gc.collect(5000, 60);
  assert.ok(removed.attempts > 0 && removed.journal > 0);
  assert.deepEqual(await counts(), { pg: '1', ch: '2' });
  assert.equal((await db.read('SELECT 1 FROM liekan_warehouse_transition_result')).length, 0);
  const rewindOwner = await chControl.claim(queue.installation.topicId, 0, randomUUID());
  await chControl.discover(
    rewindOwner,
    [
      {
        offset: finalPosition.offset,
        inputId: final.inputId,
        websiteId: site,
        sessionId: final.sessionId,
        identityKey: JSON.stringify([site, 'session', final.sessionId]),
      },
    ],
    finalPosition.offset,
  );
  assert.equal((await chControl.ready(rewindOwner)).length, 0);
  await chControl.release(rewindOwner);
  await startCH();
  const [replayPosition] = await queue.highWatermarks();
  await queue.enqueue(final);
  await until(
    async () =>
      !!(
        await db.read(
          "SELECT 1 FROM liekan_warehouse_work WHERE offset_id=$1 AND status='confirmed'",
          [replayPosition.offset],
        )
      ).length,
    'same-input replay after GC',
  );
  await worker.close();
  assert.deepEqual(await counts(), { pg: '1', ch: '2' });
  const [floor] = await db.read<{ reclaimed_offset: string }>(
    'SELECT reclaimed_offset FROM liekan_warehouse_partition WHERE partition=0',
  );
  const [offsets] = await broker.fetchTopicOffsets(run);
  assert.ok(BigInt(offsets.low) >= BigInt(floor.reclaimed_offset) + 1n);
  cases.push({
    name: 'explicit exit allows bounded PG recovery and broker prefix reclamation after a lost trim reply; old offsets remain fenced and replay without client UUID cannot duplicate the accepted CH event',
    status: 'pass',
  });
  await writeFile(
    `.local/ch-implementation/${run}.json`,
    JSON.stringify(
      { run, cases, originalDatabaseTouched: false, completeCutoverValidated: false },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ run, passed: cases.length, failed: 0 }));
} catch (error) {
  cases.push({
    status: 'failed',
    error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
  });
  await writeFile(
    `.local/ch-implementation/${run}.json`,
    JSON.stringify(
      { run, cases, originalDatabaseTouched: false, completeCutoverValidated: false },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await worker?.close();
  await completion?.close();
  await stream?.close();
  await queue?.close();
  await resultQueue?.close();
  await runtime?.close();
  await broker.deleteTopics({ topics: [run, `${run}_results`] }).catch(() => {});
  await broker.disconnect();
  await Promise.allSettled([db.close(), admin.end(), offline.close(), ch.close(), chAdmin.close()]);
}
