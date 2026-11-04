import {
  testClickHouseURL,
  testPostgresPort,
  testPostgresPasswordFile,
} from './warehouse-test-target';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { Kafka, logLevel } from 'kafkajs';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { WarehouseControl } from '../../src/lib/liekan/warehouse/control';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { WarehouseDeriver } from '../../src/lib/liekan/warehouse/derivation';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
import { initializeWarehouse } from '../../src/lib/liekan/warehouse/initialize';
import {
  inputDigest,
  LandingStore,
  type LandedDecision,
} from '../../src/lib/liekan/warehouse/landing';
import {
  exportMigrationArchive,
  restoreMigrationClone,
} from '../../src/lib/liekan/warehouse/migration-archive';
import { MigrationPages } from '../../src/lib/liekan/warehouse/migration-page';
import { MigrationRunner } from '../../src/lib/liekan/warehouse/migration-runner';
import { MigrationSource } from '../../src/lib/liekan/warehouse/migration-source';
import { PostgresAuthority } from '../../src/lib/liekan/warehouse/postgres-authority';
import { factRelation, boundaryParameters } from '../../src/lib/liekan/warehouse/read';
import { routingKey, type InputEnvelope } from '../../src/lib/liekan/warehouse/routing';
import { QueueReplayReader } from '../../src/lib/liekan/warehouse/replay-reader';
import { WarehouseRuntime } from '../../src/lib/liekan/warehouse/runtime';
import {
  confirmWarehouseTasks,
  prepareWarehouseTask,
  recoverWarehouseTasks,
  taskPlanner,
} from '../../src/lib/liekan/warehouse/tasks';
import { TransitionService } from '../../src/lib/liekan/warehouse/transition-service';
import { establishTransitionBaseline } from '../../src/lib/liekan/warehouse/transition-baseline';
import {
  captureAuthoritativeResult,
  decisionResult,
  TransitionCapture,
} from '../../src/lib/liekan/warehouse/transition-capture';
import { TransitionStream } from '../../src/lib/liekan/warehouse/transition-stream';
import { TransitionCoordinator } from '../../src/lib/liekan/warehouse/transition-coordinator';
import { WarehouseQueue, inspectQueueTopic } from '../../src/lib/liekan/warehouse/transport';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_baseline_${Date.now()}`,
  password = (await readFile(testPostgresPasswordFile, 'utf8')).trim();
const connection = { host: '127.0.0.1', port: testPostgresPort, user: 'liekan_ch_proto', password };
const url = (database: string) => {
  const u = new URL(`postgresql://127.0.0.1:${testPostgresPort}/${database}`);
  u.username = connection.user;
  u.password = password;
  return u.toString();
};
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' }),
  db = new ControlDatabase(url(run)),
  control = new WarehouseControl(db, 'postgres');
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
  cases: object[] = [];
let queue: WarehouseQueue,
  inputQueue: WarehouseQueue,
  stream: TransitionStream,
  source: MigrationSource,
  replication: TransitionService;
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
    topics: [run, `${run}_input`].map(topic => ({
      topic,
      numPartitions: 1,
      replicationFactor: 1,
      configEntries: [
        { name: 'retention.ms', value: '-1' },
        { name: 'retention.bytes', value: '-1' },
        { name: 'flush.messages', value: '1' },
        { name: 'segment.bytes', value: '1048576' },
      ],
    })),
  });
  const installation = await inspectQueueTopic(options, run);
  queue = new WarehouseQueue(options, installation);
  await queue.connect();
  stream = new TransitionStream(db, queue);
  const inputInstallation = await inspectQueueTopic(options, `${run}_input`);
  inputQueue = new WarehouseQueue(options, inputInstallation);
  await inputQueue.connect();
  const topic = inputInstallation.topicId;
  const coordinator = new TransitionCoordinator(db, inputQueue);
  replication = new TransitionService(db, ch, options);
  await db.transaction(async tx => {
    await tx.query(
      "INSERT INTO website(website_id,name,domain) VALUES($1,'Baseline fixture','baseline.invalid')",
      [site],
    );
    await tx.query('INSERT INTO liekan_warehouse_site(website_id) VALUES($1)', [site]);
    await tx.query(
      "INSERT INTO liekan_warehouse_installation(id,installation_id,schema_version,routing_version,topic_name,topic_id,partition_count,authority,transition,facts_fenced) VALUES(1,$1,2,1,$3,$2,1,'postgres','shadow',true)",
      [randomUUID(), topic, inputInstallation.topicName],
    );
    await tx.query('INSERT INTO liekan_warehouse_partition(topic_id,partition) VALUES($1,0)', [
      topic,
    ]);
  });
  await new TransitionCapture(db).start({ name: run, id: installation.topicId });
  let offset = 0;
  const accept = async () => {
    const owner = await control.claim(topic, 0, randomUUID(), 120);
    const envelope: InputEnvelope = {
      version: 1,
      routingVersion: 1,
      topicId: topic,
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
      receivedAt: '2026-11-03T12:00:00Z',
      data: { fixture: 'baseline-counter' },
    };
    const input = { partition: 0, offset: String(offset++), envelope };
    await inputQueue.enqueue(envelope);
    const facts = [
      {
        family: 'session',
        row: factInput('session', {
          session_id: envelope.sessionId,
          website_id: site,
          created_at: envelope.receivedAt,
        }),
      },
      {
        family: 'website_event',
        row: factInput('website_event', {
          event_id: envelope.eventId,
          session_id: envelope.sessionId,
          visit_id: envelope.visitId,
          website_id: site,
          event_type: 1,
          url_path: '/baseline',
          created_at: envelope.receivedAt,
        }),
      },
      {
        family: 'liekan_collection_receipt',
        row: factInput('liekan_collection_receipt', {
          website_id: site,
          event_id: envelope.eventId,
          client_event_id: envelope.clientEventId,
          payload_hash: envelope.fingerprint,
          collection_source: 'browser',
          collection_scope: 'browser',
          created_at: envelope.receivedAt,
        }),
      },
      {
        family: 'liekan_geography_ingress',
        row: factInput('liekan_geography_ingress', {
          website_id: site,
          bucket: envelope.receivedAt,
          reason: 'invalid_ip',
          count: 1,
        }),
      },
    ];
    const decision: LandedDecision = {
      input,
      status: 'new',
      sessionId: envelope.sessionId,
      visitId: envelope.visitId,
      facts,
    };
    await control.discover(
      owner,
      [
        {
          offset: input.offset,
          inputId: envelope.inputId,
          websiteId: site,
          sessionId: envelope.sessionId,
          identityKey: routingKey(envelope),
        },
      ],
      input.offset,
    );
    const attempt = await control.intent(owner, site, [input.offset], inputDigest([input]));
    await new PostgresAuthority(
      control,
      async () => [decision],
      async () => {},
    ).process(owner, attempt, [input]);
    await control.safeOffset(owner);
    await control.release(owner);
  };
  await accept();
  assert.equal((await replication.tick()).state, 'awaiting-baseline');
  assert.equal(
    (
      await db.read<{ sent_sequence: string }>(
        'SELECT sent_sequence FROM liekan_warehouse_transition',
      )
    )[0].sent_sequence,
    '0',
  );
  const snapshotBarrier = await coordinator.request('snapshot');
  assert.deepEqual(snapshotBarrier.boundary, [{ partition: 0, offset: '1' }]);
  await coordinator.freeze(snapshotBarrier.operation_id);
  await assert.rejects(
    () => coordinator.cancel(snapshotBarrier.operation_id),
    /cannot-cancel-frozen/,
  );
  const archive = await exportMigrationArchive({
    sourceURL: url(run),
    directory: '.local/ch-implementation',
    pgDump: '.local/ch-implementation/isolated-pg_dump',
  });
  assert.equal((archive.boundary.capture as { sequence: string }).sequence, '1');
  const restored = await restoreMigrationClone({
    archive: archive.archive,
    expectedSHA256: archive.sha256,
    adminURL: url('liekan_ch_proto'),
    directory: '.local/ch-implementation',
    boundary: archive.boundary,
    pgRestore: '.local/ch-implementation/isolated-pg_restore',
  });
  source = new MigrationSource(url(restored.descriptor.database));
  await source.connect();
  const sealed = await source.sealedSnapshot();
  const migration = await new MigrationPages(db, ch).register(
    sealed.descriptor.snapshotId,
    sealed.digest,
    { [site]: '0' },
    undefined,
    sealed.descriptor.sourceFingerprint,
  );
  await db.transaction(async tx => {
    await tx.query(
      "UPDATE liekan_warehouse_migration SET boundary=boundary||jsonb_build_object('sourceControl',$2::jsonb) WHERE migration_id=$1",
      [migration.migration_id, JSON.stringify(archive.boundary)],
    );
    await tx.query('UPDATE liekan_warehouse_transition SET migration_id=$1 WHERE id=1', [
      migration.migration_id,
    ]);
  });
  await coordinator.resumeSnapshot(snapshotBarrier.operation_id);
  await accept();
  await assert.rejects(() => stream.publish(), /result-publisher-fenced/);
  await assert.rejects(
    () => establishTransitionBaseline(db, migration.migration_id),
    /source-not-verified/,
  );
  const complete = await new MigrationRunner(db, ch, source).run(migration.migration_id, {
    pageSize: 10,
  });
  assert.equal(complete.phase, 'verify');
  cases.push({
    name: 'real exported/restored immutable snapshot records result O; later PG input is outside that snapshot and replay waits for full verification',
    status: 'pass',
  });
  const baseline = await establishTransitionBaseline(db, migration.migration_id);
  assert.equal(baseline.sequence, '1');
  assert.equal(baseline.status, 'ready');
  assert.deepEqual(await establishTransitionBaseline(db, migration.migration_id), baseline);
  assert.equal(await stream.publish(), 1);
  assert.equal(
    (
      await db.read<{ sequence: string }>(
        'SELECT sequence FROM liekan_warehouse_transition_delivery',
      )
    )[0].sequence,
    '2',
  );
  const cutover = await coordinator.request('cutover');
  await coordinator.freeze(cutover.operation_id);
  await assert.rejects(() => coordinator.switch(cutover.operation_id), /results-not-drained/);
  assert.deepEqual(await replication.tick(), {
    state: 'frozen',
    sent: 0,
    clickhouse: 1,
    postgres: 1,
  });
  assert.deepEqual(await replication.tick(), {
    state: 'frozen',
    sent: 0,
    clickhouse: 0,
    postgres: 0,
  });
  const switched = await coordinator.switch(cutover.operation_id);
  assert.equal(switched.status, 'completed');
  assert.deepEqual(await coordinator.switch(cutover.operation_id), switched);
  await assert.rejects(() => control.claim(topic, 0, randomUUID()), /authority-frozen/);
  // The task transaction has acquired the installation's shared lock but has
  // not committed when rollback reads H. Its producer then fails before send.
  // The barrier must observe the registration after taking its exclusive lock
  // and leave recovery free to enqueue and publish that task.
  const taskRuntime = {
    db,
    ch,
    queue: inputQueue,
    envelope: WarehouseRuntime.prototype.envelope,
  } as WarehouseRuntime;
  const riskResult = {
    kind: 'browser-risk' as const,
    windowEnd: '2026-11-03T12:00:00Z',
    logEpoch: '1',
    ruleVersion: 'isolated-barrier-v1',
    coverage: 'observed' as const,
    events: 0,
    visits: 0,
    insufficient: 0,
    flagged: 0,
    nextBefore: '2026-11-03T12:00:00Z',
    nextAfter: '2026-11-03T12:01:00Z',
  };
  let registrationReached: () => void, finishRegistration: () => void, boundaryRead: () => void;
  const registered = new Promise<void>(resolve => {
    registrationReached = resolve;
  });
  const registrationRelease = new Promise<void>(resolve => {
    finishRegistration = resolve;
  });
  const capturedBoundary = new Promise<void>(resolve => {
    boundaryRead = resolve;
  });
  const enqueue = inputQueue.enqueue.bind(inputQueue),
    highWatermarks = inputQueue.highWatermarks.bind(inputQueue),
    rollbackId = randomUUID();
  let taskEnvelope: InputEnvelope;
  inputQueue.enqueue = async envelope => {
    taskEnvelope = envelope;
    throw new Error('isolated task producer stopped before enqueue');
  };
  inputQueue.highWatermarks = async () => {
    const values = await highWatermarks();
    boundaryRead();
    return values;
  };
  try {
    const preparing = prepareWarehouseTask(
      taskRuntime,
      await control.site(site),
      riskResult,
      [],
      async () => {
        registrationReached();
        await registrationRelease;
      },
    ).then(
      () => null,
      error => error as Error,
    );
    await Promise.race([
      registered,
      preparing.then(error => {
        throw error ?? new Error('Task did not pause registration');
      }),
    ]);
    const requesting = coordinator.request('rollback', rollbackId).then(
      () => null,
      error => error as Error,
    );
    await Promise.race([
      capturedBoundary,
      requesting.then(error => {
        throw error ?? new Error('Barrier did not capture H');
      }),
    ]);
    finishRegistration();
    assert.match((await preparing)?.message ?? '', /isolated task producer stopped/);
    assert.match((await requesting)?.message ?? '', /warehouse-transition-control-not-drained/);
    assert.equal(
      (await db.read('SELECT 1 FROM liekan_warehouse_barrier WHERE operation_id=$1', [rollbackId]))
        .length,
      0,
    );
  } finally {
    finishRegistration();
    inputQueue.enqueue = enqueue;
    inputQueue.highWatermarks = highWatermarks;
  }
  await recoverWarehouseTasks(taskRuntime);
  const replay = new QueueReplayReader(inputQueue);
  try {
    const found = await replay.fetch(0, [String(offset)]);
    assert.deepEqual(JSON.parse(found.get(String(offset)).value.toString()), taskEnvelope);
  } finally {
    await replay.close();
  }
  const taskControl = new WarehouseControl(db),
    taskOwner = await taskControl.claim(topic, 0, randomUUID(), 120),
    taskInput = { partition: 0, offset: String(offset++), envelope: taskEnvelope };
  await taskControl.discover(
    taskOwner,
    [
      {
        offset: taskInput.offset,
        inputId: taskEnvelope.inputId,
        websiteId: site,
        sessionId: taskEnvelope.sessionId,
        identityKey: routingKey(taskEnvelope),
      },
    ],
    taskInput.offset,
  );
  const taskAttempt = await taskControl.intent(
      taskOwner,
      site,
      [taskInput.offset],
      inputDigest([taskInput]),
    ),
    taskDecisions = await taskPlanner(db)([taskInput], await taskControl.site(site), []),
    landing = new LandingStore(ch);
  await landing.stage(taskAttempt, taskDecisions);
  const acceptedTask = await taskControl.confirm(
    taskOwner,
    taskAttempt.attempt_id,
    taskAttempt.input_digest,
    taskDecisions.map(d => d.sessionId),
    taskDecisions.flatMap(d => d.effects ?? []),
    (tx, a) => confirmWarehouseTasks(tx, a, taskDecisions),
    (tx, a) =>
      captureAuthoritativeResult(tx, decisionResult('clickhouse', a, taskDecisions)).then(() => {}),
  );
  await new WarehouseDeriver(db, ch).derive(acceptedTask.attempt_id);
  await taskControl.decisionProjected(taskOwner, acceptedTask.attempt_id);
  await taskControl.safeOffset(taskOwner);
  await taskControl.release(taskOwner);
  assert.equal(
    (
      await db.read<{ status: string }>(
        'SELECT status FROM liekan_warehouse_task WHERE task_id=$1',
        [taskEnvelope.sessionId],
      )
    )[0].status,
    'published',
  );
  const rollback = await coordinator.request('rollback', rollbackId);
  const blockedTaskState = await taskControl.site(site);
  await assert.rejects(
    () => prepareWarehouseTask(taskRuntime, blockedTaskState, riskResult, []),
    /warehouse-transition-control-frozen/,
  );
  await coordinator.freeze(rollback.operation_id);
  await replication.tick();
  await coordinator.switch(rollback.operation_id);
  assert.equal(
    (await db.read<{ authority: string }>('SELECT authority FROM liekan_warehouse_installation'))[0]
      .authority,
    'postgres',
  );
  cases.push({
    name: 'coordinator fences a durable queue boundary, exports while frozen, resumes, rejects premature cutover, then atomically switches and rolls back with idempotent recovery',
    status: 'pass',
  });
  cases.push({
    name: 'rollback waits for in-flight task registration, rejects before installing H after producer failure, recovers the real queued task and completes the same operation ID after publication',
    status: 'pass',
  });
  const s = await control.site(site),
    params = boundaryParameters({
      websiteId: site,
      epoch: s.epoch,
      publication: s.publication,
      deletionRevision: s.deletion_revision,
    });
  const [{ total }] = await ch
    .query({
      query: `SELECT sum(count) AS total FROM ${factRelation('liekan_geography_ingress')}`,
      query_params: params,
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ total: string }>());
  assert.equal(total, '2');
  assert.equal(
    (await db.read<{ count: string }>('SELECT count FROM liekan_geography_ingress'))[0].count,
    '2',
  );
  assert.equal(
    (
      await ch
        .query({
          query: `SELECT count() AS n FROM ${factRelation('website_event')}`,
          query_params: params,
          format: 'JSONEachRow',
        })
        .then(r => r.json<{ n: string }>())
    )[0].n,
    '2',
  );
  cases.push({
    name: 'snapshot plus post-O delta counts exactly two inputs, including additive counters and events; pre-O result is not replayed twice',
    status: 'pass',
  });
  assert.equal(
    (await db.read("SELECT 1 FROM liekan_warehouse_attempt WHERE status<>'projected'")).length,
    0,
  );
  cases.push({
    name: 'verified baseline covers old accepted attempts without stale CH recovery or a permanent pending publication',
    status: 'pass',
  });
  const cancel = await coordinator.request('cutover');
  await coordinator.cancel(cancel.operation_id);
  await coordinator.cancel(cancel.operation_id);
  const gate = await coordinator.request('snapshot');
  assert.deepEqual(await coordinator.request('snapshot', gate.operation_id), gate);
  const owner = await control.claim(topic, 0, randomUUID(), 120);
  const envelope: InputEnvelope = {
    version: 1,
    routingVersion: 1,
    topicId: topic,
    websiteId: site,
    sessionId: randomUUID(),
    visitId: randomUUID(),
    eventId: randomUUID(),
    clientEventId: randomUUID(),
    inputId: randomUUID(),
    epoch: '0',
    policyRevision: '0',
    kind: 'browser',
    fingerprint: 'b'.repeat(64),
    collectionSource: 'browser',
    collectionScope: 'browser',
    receivedAt: '2026-11-03T12:01:00Z',
    data: { fixture: 'post-barrier' },
  };
  await inputQueue.enqueue(envelope);
  await control.discover(
    owner,
    [
      {
        offset: String(offset),
        inputId: envelope.inputId,
        websiteId: site,
        sessionId: envelope.sessionId,
        identityKey: routingKey(envelope),
      },
    ],
    String(offset),
  );
  assert.equal((await control.ready(owner)).length, 0);
  await assert.rejects(() =>
    control.intent(
      owner,
      site,
      [String(offset)],
      inputDigest([{ partition: 0, offset: String(offset), envelope }]),
    ),
  );
  await coordinator.freeze(gate.operation_id);
  await assert.rejects(() => control.claim(topic, 0, randomUUID()), /authority-frozen/);
  await coordinator.resumeSnapshot(gate.operation_id);
  assert.equal((await control.ready(owner)).length, 1);
  await control.release(owner);
  cases.push({
    name: 'durable H excludes later queued inputs from planning, permits a complete pre-H freeze, resumes pending input and supports idempotent draining cancellation',
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
  await replication?.close();
  await stream?.close();
  await queue?.close();
  await inputQueue?.close();
  await broker.deleteTopics({ topics: [run, `${run}_input`] }).catch(() => {});
  await broker.disconnect();
  await Promise.allSettled([source?.close(), db.close(), admin.end(), ch.close(), chAdmin.close()]);
  await writeFile(
    `.local/ch-implementation/${run}.json`,
    JSON.stringify(
      { run, cases, originalDatabaseTouched: false, fullUpgradeValidated: false },
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
