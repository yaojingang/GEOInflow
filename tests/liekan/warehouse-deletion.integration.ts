import {
  testClickHouseURL,
  testPostgresPort,
  testPostgresPasswordFile,
} from './warehouse-test-target';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { Kafka, logLevel } from 'kafkajs';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { ControlDatabase, WarehouseConflict } from '../../src/lib/liekan/warehouse/control-db';
import { WarehouseUnavailable } from '../../src/lib/liekan/warehouse/completion';
import { WarehouseControl } from '../../src/lib/liekan/warehouse/control';
import { WarehouseDeletionGC } from '../../src/lib/liekan/warehouse/deletion-gc';
import { WarehouseReadReferences } from '../../src/lib/liekan/warehouse/read-reference';
import { factTables } from '../../src/lib/liekan/warehouse/catalog';
import { WarehouseConsumer, type DecisionPlanner } from '../../src/lib/liekan/warehouse/consumer';
import {
  WarehouseDeletions,
  type DeletionOperation,
} from '../../src/lib/liekan/warehouse/deletions';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
import { initializeWarehouse } from '../../src/lib/liekan/warehouse/initialize';
import { receiptOutcome, LandingStore } from '../../src/lib/liekan/warehouse/landing';
import { boundaryParameters, factRelation } from '../../src/lib/liekan/warehouse/read';
import { route, routingKey } from '../../src/lib/liekan/warehouse/routing';
import { WarehouseRuntime, warehouseRuntime } from '../../src/lib/liekan/warehouse/runtime';
import { inspectQueueTopic } from '../../src/lib/liekan/warehouse/transport';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_deletion_${Date.now()}`,
  password = (await readFile(testPostgresPasswordFile, 'utf8')).trim();
const connection = { host: '127.0.0.1', port: testPostgresPort, user: 'liekan_ch_proto', password };
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' }),
  url = new URL(`postgresql://127.0.0.1:${testPostgresPort}/${run}`);
url.username = connection.user;
url.password = password;
const db = new ControlDatabase(url.toString()),
  control = new WarehouseControl(db),
  chAdmin = createWarehouseClient({ url: testClickHouseURL });
const ch = createWarehouseClient({
  url: testClickHouseURL,
  database: run,
  clickhouse_settings: { max_threads: 1, max_memory_usage: '268435456' },
});
const queueOptions = { brokers: ['127.0.0.1:29109'], maxMessageBytes: 1024 * 1024 },
  broker = new Kafka({ brokers: queueOptions.brokers, logLevel: logLevel.NOTHING }).admin();
let site = randomUUID();
const session = randomUUID(),
  second = randomUUID(),
  actor = randomUUID(),
  cases: object[] = [],
  health: string[] = [];
let runtime: WarehouseRuntime, consumer: WarehouseConsumer;
let pendingResponses = 0;
async function confirmation(e: Parameters<WarehouseRuntime['completion']['wait']>[0]) {
  // A pending response is an explicit API outcome under shared-host contention.
  // Retry only that outcome and require the same input to finish within 90s.
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      return await runtime.completion.wait(e, 30000);
    } catch (error) {
      if (
        !(error instanceof WarehouseUnavailable) ||
        error.code !== 'warehouse-confirmation-pending' ||
        Date.now() >= deadline
      )
        throw error;
      pendingResponses++;
    }
  }
}
async function until(fn: () => Promise<boolean>, label: string) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(150);
  }
  throw new Error(`Timed out ${label}: ${health.slice(-3).join(',')}`);
}
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${run}" TEMPLATE liekan_ch_catalog_20261103`);
  for (const file of (await readdir('db/liekan/migrations'))
    .filter(f => /^\d{3}_/.test(f) && Number(f.slice(0, 3)) >= 57)
    .sort())
    await db.transaction(tx =>
      readFile(`db/liekan/migrations/${file}`, 'utf8').then(sql => tx.query(sql)),
    );
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
  const installation = await inspectQueueTopic(queueOptions, run);
  await db.transaction(async tx => {
    await tx.query(
      "INSERT INTO website(website_id,name,domain) VALUES($1,'Isolated deletion fixture','warehouse.invalid')",
      [site],
    );
    await tx.query('INSERT INTO liekan_warehouse_site(website_id) VALUES($1)', [site]);
    await tx.query(
      `INSERT INTO liekan_warehouse_installation(id,installation_id,schema_version,routing_version,topic_name,topic_id,partition_count,authority,transition,facts_fenced)
      VALUES(1,$1,2,1,$2,$3,2,'clickhouse','none',true)`,
      [randomUUID(), run, installation.topicId],
    );
    await tx.query(
      'INSERT INTO liekan_warehouse_partition(topic_id,partition) VALUES($1,0),($1,1)',
      [installation.topicId],
    );
  });
  process.env.DATABASE_URL = url.toString();
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  process.env.LIEKAN_CLICKHOUSE_URL = testClickHouseURL;
  process.env.LIEKAN_CLICKHOUSE_DATABASE = run;
  process.env.LIEKAN_QUEUE_BROKERS = '127.0.0.1:29109';
  runtime = await warehouseRuntime();
  const planner: DecisionPlanner = async (inputs, _state, receipts) =>
    inputs.map(input => {
      const e = input.envelope,
        old = receipts.find(r => r.identity_key === routingKey(e));
      if (old) {
        const status = receiptOutcome(old, e);
        assert.notEqual(status, 'unavailable');
        return {
          input,
          status: status as 'duplicate' | 'conflict',
          sessionId: old.original_session,
          visitId: old.original_visit,
          facts: [],
        };
      }
      return {
        input,
        status: 'new' as const,
        sessionId: e.sessionId,
        visitId: e.visitId,
        facts: [
          {
            family: 'session',
            row: factInput('session', {
              session_id: e.sessionId,
              website_id: site,
              created_at: e.receivedAt,
            }),
          },
          {
            family: 'website_event',
            row: factInput('website_event', {
              event_id: e.eventId,
              website_id: site,
              session_id: e.sessionId,
              visit_id: e.visitId,
              event_type: 1,
              url_path: '/isolated',
              created_at: e.receivedAt,
            }),
          },
          ...(e.data.replay
            ? [
                {
                  family: 'session_replay',
                  row: factInput('session_replay', {
                    replay_id: randomUUID(),
                    website_id: site,
                    session_id: e.sessionId,
                    visit_id: e.visitId,
                    chunk_index: 0,
                    events: Buffer.from('isolated'),
                    event_count: 1,
                    started_at: e.receivedAt,
                    ended_at: e.receivedAt,
                    created_at: e.receivedAt,
                  }),
                },
              ]
            : []),
        ],
      };
    });
  consumer = new WarehouseConsumer(control, ch, runtime.queue, planner, {
    groupId: run,
    onHealth: h => health.push(h.code),
  });
  await consumer.start();
  const event = async (sid = session, partition = 0) => {
    const e = runtime.envelope(await control.site(site), {
      websiteId: site,
      sessionId: sid,
      visitId: randomUUID(),
      clientEventId: randomUUID(),
      eventId: randomUUID(),
      kind: 'browser',
      fingerprint: 'a'.repeat(64),
      collectionSource: 'browser',
      collectionScope: 'browser',
      receivedAt: new Date().toISOString(),
      data: { isolated: true },
    });
    while (route(e, 2) !== partition) e.clientEventId = randomUUID();
    return e;
  };
  const send = async (e: Awaited<ReturnType<typeof event>>) => {
    await runtime.queue.enqueue(e);
    return confirmation(e);
  };
  const boundary = async () => {
    const s = await control.site(site);
    return {
      websiteId: site,
      epoch: s.epoch,
      publication: s.publication,
      deletionRevision: s.deletion_revision,
    };
  };
  const count = async () =>
    Number(
      (
        await ch
          .query({
            query: `SELECT count() AS n FROM ${factRelation('website_event')}`,
            query_params: boundaryParameters(await boundary()),
            format: 'JSONEachRow',
          })
          .then(r => r.json<{ n: string }>())
      )[0].n,
    );
  const original = await event();
  assert.equal((await send(original)).status, 'new');
  assert.equal(await count(), 1);
  const originalBoundary = await boundary();
  const originalReference = new WarehouseReadReferences(db);
  await originalReference.pin(originalBoundary);
  const [originalRow] = await ch
    .query({
      query: 'SELECT * FROM warehouse_website_event WHERE event_id={id:UUID}',
      query_params: { id: original.eventId },
      format: 'JSONEachRow',
    })
    .then(r => r.json<any>());
  const deletion = new WarehouseDeletions(runtime),
    auth = { authorize: async () => {} },
    effects: string[] = [];
  const finalizer = {
    lock: async () => {},
    apply: async (_tx: any, op: DeletionOperation) => {
      effects.push(op.operation_id);
    },
  };
  const first = await deletion.begin(site, 'session', session, actor, auth);
  const queued = await event(session, 1),
    retry = { ...original, inputId: randomUUID(), sessionId: second, eventId: randomUUID() };
  await runtime.queue.enqueueMany([queued, retry]);
  await until(
    async () =>
      Number(
        (
          await db.read<{ n: string }>(
            'SELECT count(*)::text AS n FROM liekan_warehouse_work WHERE input_id=ANY($1::uuid[])',
            [[queued.inputId, retry.inputId]],
          )
        )[0].n,
      ) === 2,
    'pending deletion queue capture',
  );
  await deletion.advance(first.operation_id, finalizer);
  const cancelled = await Promise.all([confirmation(queued), confirmation(retry)]);
  assert.deepEqual(
    cancelled.map(c => c.status),
    ['cancelled', 'cancelled'],
  );
  assert.equal(await count(), 0);
  assert.equal(
    (await new LandingStore(ch).receipts(await boundary(), [routingKey(original)])).length,
    0,
  );
  await deletion.advance(first.operation_id, finalizer);
  assert.deepEqual(effects, [first.operation_id]);
  cases.push({
    name: 'session delete hides old facts/receipts, cancels queued cross-partition input and a UUID retry with changed submitted session, idempotently',
    status: 'pass',
  });
  const gc = new WarehouseDeletionGC(db, ch);
  assert.deepEqual(await gc.collect(5, 0), { tables: 0, completed: 0 });
  const stalePin = new WarehouseReadReferences(db);
  await assert.rejects(stalePin.pin(originalBoundary), /warehouse-read-boundary-changed/);
  await stalePin.close();
  await originalReference.close();
  const proof = randomUUID();
  await db.read(
    `INSERT INTO liekan_warehouse_reference(reference_id,website_id,epoch,publication,kind,owner_id)
    VALUES($1,$2,$3,$4,'geo',$1)`,
    [proof, site, originalBoundary.epoch, originalBoundary.publication],
  );
  assert.deepEqual(await gc.collect(5, 0), { tables: 0, completed: 0 });
  await db.read('DELETE FROM liekan_warehouse_reference WHERE reference_id=$1', [proof]);
  const actualCommand = ch.command.bind(ch);
  ch.command = (async (query: any) => {
    await actualCommand(query);
    throw new Error('isolated GC response lost');
  }) as typeof ch.command;
  try {
    await assert.rejects(gc.collect(5, 0), /isolated GC response lost/);
  } finally {
    ch.command = actualCommand;
  }
  assert.equal(
    (
      await db.read<any>(
        'SELECT table_cursor FROM liekan_warehouse_deletion_gc WHERE operation_id=$1',
        [first.operation_id],
      )
    )[0].table_cursor,
    0,
  );
  for (let i = 0; i < factTables.length; i++) await gc.collect(5, 0);
  const physical = async () =>
    Number(
      (
        await ch
          .query({
            query: 'SELECT count() AS n FROM warehouse_website_event WHERE event_id={id:UUID}',
            query_params: { id: original.eventId },
            format: 'JSONEachRow',
          })
          .then(r => r.json<any>())
      )[0].n,
    );
  assert.equal(await physical(), 0);
  const [journal] = await ch
    .query({
      query: 'SELECT count() AS n FROM warehouse_landing WHERE website_id={site:UUID}',
      query_params: { site },
      format: 'JSONEachRow',
    })
    .then(r => r.json<any>());
  assert.ok(Number(journal.n) > 0, 'canonical deletion/retry identity history remains protected');
  await ch.insert({
    table: 'warehouse_website_event',
    values: [originalRow],
    format: 'JSONEachRow',
  });
  assert.equal(await count(), 0, 'late fenced writes remain logically deleted');
  await db.read(
    "UPDATE liekan_warehouse_deletion_gc SET completed_at=clock_timestamp()-interval '2 days' WHERE operation_id=$1",
    [first.operation_id],
  );
  for (let i = 0; i < factTables.length; i++) await gc.collect(5, 0);
  assert.equal(await physical(), 0);
  cases.push({
    name: 'physical deletion honors read/proof references, fences stale pins, resumes lost mutation replies, and reclaims late invisible writes without losing canonical receipts',
    status: 'pass',
  });
  const fresh = await event(session, 1);
  assert.equal((await send(fresh)).status, 'new');
  const reused = { ...original, inputId: randomUUID(), sessionId: second, eventId: randomUUID() };
  assert.equal((await send(reused)).status, 'new');
  assert.equal(await count(), 2);
  const secondDelete = await deletion.begin(site, 'session', session, actor, auth);
  const reusedRetry = { ...reused, inputId: randomUUID(), sessionId: session };
  await runtime.queue.enqueue(reusedRetry);
  await deletion.advance(secondDelete.operation_id, finalizer);
  assert.equal((await confirmation(reusedRetry)).status, 'duplicate');
  assert.equal(await count(), 1);
  cases.push({
    name: 'new post-delete events and a reused UUID remain valid; a second deletion resolves the current canonical receipt rather than an obsolete identity',
    status: 'pass',
  });
  const third = await deletion.begin(site, 'session', second, actor, auth);
  await assert.rejects(
    () =>
      deletion.advance(third.operation_id, {
        lock: async () => {},
        apply: async () => {
          throw new Error('isolated injected finalizer failure');
        },
      }),
    /injected/,
  );
  assert.equal(await count(), 1, 'projected marker is invisible before the PG pointer commits');
  const [saved] = await db.read<DeletionOperation>(
    'SELECT * FROM liekan_warehouse_deletion WHERE operation_id=$1',
    [third.operation_id],
  );
  const newAfterBoundary = await event(second, 1);
  await runtime.queue.enqueue(newAfterBoundary);
  await deletion.advance(third.operation_id, finalizer);
  const [finished] = await db.read<DeletionOperation>(
    'SELECT * FROM liekan_warehouse_deletion WHERE operation_id=$1',
    [third.operation_id],
  );
  assert.deepEqual(finished.boundary, saved.boundary);
  assert.equal((await confirmation(newAfterBoundary)).status, 'new');
  assert.equal(await count(), 1);
  cases.push({
    name: 'failed PG lifecycle commit leaves CH marker invisible; retry reuses the durable queue boundary and preserves newer input',
    status: 'pass',
  });
  const reset = await deletion.begin(site, 'reset', null, actor, auth),
    oldEpoch = await event();
  await runtime.queue.enqueue(oldEpoch);
  await deletion.advance(reset.operation_id, finalizer);
  assert.equal((await confirmation(oldEpoch)).status, 'cancelled');
  assert.equal(await count(), 0);
  assert.equal((await send(await event())).status, 'new');
  assert.equal(await count(), 1);
  for (let i = 0; i < factTables.length + 4; i++) await gc.collect(50, 0);
  assert.equal(await count(), 1, 'old-epoch physical cleanup preserves newly accepted data');
  const [oldJournal] = await ch
    .query({
      query:
        'SELECT count() AS n FROM warehouse_landing WHERE website_id={site:UUID} AND epoch={epoch:UInt64}',
      query_params: { site, epoch: reset.epoch },
      format: 'JSONEachRow',
    })
    .then(r => r.json<any>());
  assert.equal(Number(oldJournal.n), 0);
  cases.push({
    name: 'reset advances collection epoch, fences queued old epoch and permits new collection',
    status: 'pass',
  });
  const remove = await deletion.begin(site, 'website', null, actor, auth);
  await deletion.advance(remove.operation_id, finalizer);
  await assert.rejects(() => runtime.resource(site, 'website'), WarehouseConflict);
  cases.push({
    name: 'website deletion keeps a durable resource tombstone that rejects new intake',
    status: 'pass',
  });
  await db.transaction(tx =>
    tx.query(
      `INSERT INTO "user"(user_id,username,password,role) VALUES($1,'warehouse-lifecycle-owner','isolated-unused-password','user')`,
      [actor],
    ),
  );
  const queries = await import('../../src/queries/prisma/website');
  site = randomUUID();
  await queries.createWebsite({
    id: site,
    name: 'Owned lifecycle fixture',
    domain: 'owned.warehouse.invalid',
    userId: actor,
  });
  assert.equal((await control.site(site)).state, 'active');
  const { readReportingMetadata } = await import(
    '../../src/lib/liekan/warehouse/reporting-context'
  );
  assert.equal((await readReportingMetadata(db, site)).boundary.publication, '0');
  const {
    deleteWarehouseStatistics,
    warehouseLifecycleFinalizer,
    recoverWarehouseDeletions,
    assertWarehouseLifecycleEditable,
  } = await import('../../src/lib/liekan/upstream/warehouse-lifecycle');
  await assert.rejects(
    () => deleteWarehouseStatistics(site, 'session', { userId: randomUUID() }, session, runtime),
    e => (e as any).status === 401,
  );
  assert.equal(
    (await db.read('SELECT 1 FROM liekan_warehouse_deletion WHERE website_id=$1', [site])).length,
    0,
  );
  const video = await event();
  video.data = { replay: true };
  await send(video);
  const { createWarehouseReplayBookmark } = await import(
    '../../src/lib/liekan/upstream/warehouse-replay-bookmarks'
  );
  const bookmark = await createWarehouseReplayBookmark(site, video.visitId, 'Owned replay', {
    userId: actor,
  });
  assert.equal(
    (
      await db.read(
        'SELECT 1 FROM liekan_warehouse_replay_bookmark_owner WHERE saved_replay_id=$1 AND session_id=$2',
        [bookmark.id, session],
      )
    ).length,
    1,
  );
  const { deleteSession } = await import('../../src/queries/prisma/session');
  assert.deepEqual(await deleteSession(site, session, { userId: actor }), { id: session });
  assert.equal(await count(), 0);
  assert.equal(
    (await db.read('SELECT 1 FROM session_replay_saved WHERE saved_replay_id=$1', [bookmark.id]))
      .length,
    0,
  );
  cases.push({
    name: 'real create/session-delete and replay-bookmark adapters authorize, register empty website metadata and atomically remove associated business bookmarks',
    status: 'pass',
  });
  await send(await event());
  const { warehouseControlAdapter } = await import(
    '../../src/lib/liekan/upstream/warehouse-authority'
  );
  const recovery = await deletion.begin(site, 'reset', null, actor, {
    authorize: async tx => {
      await tx.query('SELECT website_id FROM website WHERE website_id=$1 FOR UPDATE', [site]);
    },
  });
  await assert.rejects(
    () => db.transaction(tx => assertWarehouseLifecycleEditable(warehouseControlAdapter(tx), site)),
    e => (e as any).code === 'warehouse-lifecycle-pending',
  );
  const held = await event();
  await runtime.queue.enqueue(held);
  await recoverWarehouseDeletions(runtime);
  assert.equal(await count(), 0);
  assert.equal((await confirmation(held)).status, 'cancelled');
  assert.ok(
    (
      await db.read<{ reset_at: Date }>('SELECT reset_at FROM website WHERE website_id=$1', [site])
    )[0].reset_at,
  );
  assert.equal(
    (
      await db.read<DeletionOperation>(
        'SELECT * FROM liekan_warehouse_deletion WHERE operation_id=$1',
        [recovery.operation_id],
      )
    )[0].status,
    'active',
  );
  await send(await event());
  await queries.resetWebsite(site, { userId: actor });
  assert.equal(await count(), 0);
  cases.push({
    name: 'real reset API and restart recovery clear PG business metadata with CH epoch publication; pending command blocks ownership changes and old queued intake',
    status: 'pass',
  });
  await send(await event());
  await queries.deleteWebsite(site, { userId: actor });
  assert.equal((await db.read('SELECT 1 FROM website WHERE website_id=$1', [site])).length, 0);
  assert.equal((await control.site(site)).state, 'deleting');
  assert.equal(await count(), 0);
  cases.push({
    name: 'real website delete removes business website and preserves CH resource tombstone, without scanning PG analytics facts',
    status: 'pass',
  });
  const { createLink, deleteLink } = await import('../../src/queries/prisma/link');
  const { createPixel, deletePixel } = await import('../../src/queries/prisma/pixel');
  const linkId = randomUUID(),
    pixelId = randomUUID();
  await createLink({
    id: linkId,
    name: 'Lifecycle link',
    slug: randomUUID(),
    url: 'https://warehouse.invalid/',
    userId: actor,
  });
  await createPixel({ id: pixelId, name: 'Lifecycle pixel', slug: randomUUID(), userId: actor });
  assert.equal(
    (
      await db.read<{ resource_type: string }>(
        'SELECT resource_type FROM liekan_warehouse_site WHERE website_id=$1',
        [linkId],
      )
    )[0].resource_type,
    'link',
  );
  assert.equal(
    (
      await db.read<{ resource_type: string }>(
        'SELECT resource_type FROM liekan_warehouse_site WHERE website_id=$1',
        [pixelId],
      )
    )[0].resource_type,
    'pixel',
  );
  await deleteLink(linkId);
  await deletePixel(pixelId);
  await recoverWarehouseDeletions(runtime);
  assert.equal((await control.site(linkId)).state, 'deleting');
  assert.equal((await control.site(pixelId)).state, 'deleting');
  cases.push({
    name: 'native link and pixel creation/deletion participate in the same durable resource lifecycle',
    status: 'pass',
  });
  const team = randomUUID(),
    cascaded = randomUUID(),
    soft = randomUUID();
  await db.transaction(async tx => {
    await tx.query(
      `INSERT INTO team(team_id,name,access_code) VALUES($1,'Deletion fixture team',$2)`,
      [team, randomUUID()],
    );
    await tx.query(
      `INSERT INTO team_user(team_user_id,team_id,user_id,role) VALUES($1,$2,$3,'team-owner')`,
      [randomUUID(), team, actor],
    );
  });
  await queries.createWebsite({
    id: cascaded,
    name: 'Cascade',
    domain: 'cascade.invalid',
    teamId: team,
  });
  site = cascaded;
  await send(await event());
  await (await import('../../src/queries/prisma/team')).deleteTeam(team);
  assert.equal((await db.read('SELECT 1 FROM website WHERE website_id=$1', [cascaded])).length, 1);
  await recoverWarehouseDeletions(runtime);
  assert.equal(await count(), 1, 'existing team deletion preserves the detached website');
  const deletedUser = randomUUID(),
    personal = randomUUID();
  await db.transaction(tx =>
    tx.query(
      `INSERT INTO "user"(user_id,username,password,role) VALUES($1,$2,'isolated-unused-password','user')`,
      [deletedUser, deletedUser],
    ),
  );
  await queries.createWebsite({
    id: personal,
    name: 'Account cascade',
    domain: 'account.invalid',
    userId: deletedUser,
  });
  site = personal;
  await send(await event());
  await (await import('../../src/queries/prisma/user')).deleteUser(deletedUser);
  assert.equal((await db.read('SELECT 1 FROM website WHERE website_id=$1', [personal])).length, 0);
  await recoverWarehouseDeletions(runtime);
  assert.equal(await count(), 0);
  assert.equal((await control.site(personal)).state, 'deleting');
  await queries.createWebsite({
    id: soft,
    name: 'Soft deletion',
    domain: 'soft.invalid',
    userId: actor,
  });
  site = soft;
  await send(await event());
  await db.transaction(tx =>
    tx.query('UPDATE website SET deleted_at=clock_timestamp() WHERE website_id=$1', [soft]),
  );
  await recoverWarehouseDeletions(runtime);
  assert.equal(await count(), 0);
  assert.equal((await control.site(soft)).state, 'deleting');
  await assert.rejects(() =>
    queries.createWebsite({ id: soft, name: 'ID reuse', domain: 'reuse.invalid', userId: actor }),
  );
  cases.push({
    name: 'account cascade and soft deletion retire CH facts; team deletion preserves detached website semantics; deleted identity cannot be reused',
    status: 'pass',
  });
  await (await import('../../src/lib/liekan/warehouse/reader-runtime')).warehouseReader().close();
  console.log(`PASS ${cases.length} warehouse deletion cases`);
} catch (error) {
  const detail = (value: any): object => ({
    name: value?.name,
    code: value?.code,
    message: String(value?.message ?? 'unknown').replaceAll(password, '[redacted]'),
    stack: String(value?.stack ?? '').replaceAll(password, '[redacted]'),
    ...(value instanceof AggregateError ? { causes: value.errors.map(detail) } : {}),
  });
  cases.push({ status: 'failed', error: detail(error) });
  console.error(JSON.stringify(detail(error)));
  process.exitCode = 1;
} finally {
  await consumer?.close();
  await runtime?.close();
  await Promise.allSettled([
    broker.disconnect(),
    admin.end(),
    db.close(),
    ch.close(),
    chAdmin.close(),
  ]);
  await mkdir('.local/ch-implementation', { recursive: true, mode: 0o700 });
  await writeFile(
    `.local/ch-implementation/${run}.json`,
    JSON.stringify({ run, cases, health, pendingResponses, fullUpgradeValidated: false }, null, 2),
    { mode: 0o600 },
  );
}
