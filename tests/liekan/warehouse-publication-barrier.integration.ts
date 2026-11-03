import { testClickHouseURL } from './warehouse-test-target';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Kafka, logLevel } from 'kafkajs';
import pg from 'pg';
import { EVENT_TYPE } from '../../src/lib/constants';
import { confirmWarehouseAuthority } from '../../src/lib/liekan/upstream/warehouse-authority';
import { WarehouseCollectionPackage } from '../../src/lib/liekan/upstream/warehouse-collection-package';
import { browserPlanner } from '../../src/lib/liekan/warehouse/browser-planner';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import {
  WarehouseCompletion,
  WarehouseUnavailable,
} from '../../src/lib/liekan/warehouse/completion';
import { WarehouseConsumer } from '../../src/lib/liekan/warehouse/consumer';
import { WarehouseControl } from '../../src/lib/liekan/warehouse/control';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { initializeWarehouse } from '../../src/lib/liekan/warehouse/initialize';
import { boundaryParameters, factRelation } from '../../src/lib/liekan/warehouse/read';
import type { InputEnvelope } from '../../src/lib/liekan/warehouse/routing';
import { inspectQueueTopic, WarehouseQueue } from '../../src/lib/liekan/warehouse/transport';

// Same hard-coded local fixture boundary as the other consumer acceptance tests.
// This creates new databases/topic only; it never clears the imported source DB.
assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_publication_barrier_${Date.now()}`;
const password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const connection = { host: '127.0.0.1', port: 25459, user: 'liekan_ch_proto', password };
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' });
const url = new URL(`postgresql://127.0.0.1:25459/${run}`);
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
const broker = new Kafka({ brokers: options.brokers, logLevel: logLevel.NOTHING }).admin();
const completion = new WarehouseCompletion(db, ch);
const insert = ch.insert.bind(ch);
const cases: object[] = [],
  health: string[] = [];
let queue: WarehouseQueue,
  worker: WarehouseConsumer,
  blockedSite: string | undefined,
  publicationFailures = 0;

// All landing writes, fact writes, digest checks and PG transactions are real.
// Fail the final transport boundary before the CH manifest INSERT, reproducing
// an unavailable publication write without mocking derive() or completion.
ch.insert = ((input: any) => {
  if (
    blockedSite &&
    input.table === 'warehouse_publication' &&
    input.values.some((row: { website_id: string }) => row.website_id === blockedSite)
  ) {
    publicationFailures++;
    throw new Error('isolated-publication-transport-unavailable');
  }
  return insert(input);
}) as typeof ch.insert;

async function until(check: () => Promise<boolean>, label: string) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Bounded wait failed: ${label}; health=${health.slice(-4).join(',')}`);
}

async function visible(site: string, family: string) {
  const state = await control.site(site);
  return ch
    .query({
      query: `SELECT * FROM ${factRelation(family)}`,
      query_params: boundaryParameters({
        websiteId: site,
        epoch: state.epoch,
        publication: state.publication,
        deletionRevision: state.deletion_revision,
      }),
      format: 'JSONEachRow',
    })
    .then(r => r.json<Record<string, unknown>>());
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
          { name: 'write.caching', value: 'false' },
        ],
      },
    ],
  });
  const installation = await inspectQueueTopic(options, run);
  queue = new WarehouseQueue(options, installation);
  await queue.connect();
  await db.transaction(async tx => {
    await tx.query(
      `INSERT INTO liekan_warehouse_installation(id,installation_id,schema_version,routing_version,topic_name,topic_id,partition_count,authority,transition)
      VALUES(1,$1::uuid,2,1,$2,$3,1,'clickhouse','none')`,
      [randomUUID(), run, installation.topicId],
    );
    await tx.query('INSERT INTO liekan_warehouse_partition(topic_id,partition) VALUES($1,0)', [
      installation.topicId,
    ]);
  });
  worker = new WarehouseConsumer(control, ch, queue, browserPlanner(db), {
    groupId: run,
    cacheBytes: 0,
    concurrency: 1,
    confirmAuthority: confirmWarehouseAuthority,
    onHealth: h => health.push(h.code),
  });
  await worker.start();

  for (const kind of ['link', 'pixel'] as const) {
    const site = randomUUID(),
      clientEventId = randomUUID(),
      receivedAt = new Date(),
      fingerprint = createHash('sha256').update(`${kind}:${clientEventId}`).digest('hex');
    await db.transaction(async tx => {
      if (kind === 'link')
        await tx.query(
          "INSERT INTO link(link_id,name,url,slug) VALUES($1,'Isolated publication test','https://publication.invalid/',$2)",
          [site, site],
        );
      else
        await tx.query(
          "INSERT INTO pixel(pixel_id,name,slug) VALUES($1,'Isolated publication test',$2)",
          [site, site],
        );
    });
    const makeInput = async (): Promise<InputEnvelope> => {
      const sessionId = randomUUID(),
        visitId = randomUUID(),
        state = await control.site(site);
      const packet = new WarehouseCollectionPackage(
        { websiteId: site, eventId: clientEventId, fingerprint },
        receivedAt,
        kind,
      );
      await packet.createSession({ id: sessionId, websiteId: site, createdAt: receivedAt });
      await packet.saveEvent({
        websiteId: site,
        sessionId,
        visitId,
        eventType: kind === 'link' ? EVENT_TYPE.linkEvent : EVENT_TYPE.pixelEvent,
        eventName: 'synthetic-purchase',
        urlPath: '/publication-test',
        createdAt: receivedAt,
        eventData: { item: 'synthetic-item', revenue: 3.5, currency: 'CNY' },
      });
      const data = packet.seal();
      assert.equal(data.hasQuality, false);
      return {
        version: 1,
        routingVersion: 1,
        topicId: installation.topicId,
        inputId: randomUUID(),
        eventId: packet.eventId,
        clientEventId,
        websiteId: site,
        sessionId,
        visitId,
        epoch: state.epoch,
        policyRevision: state.policy_revision,
        kind,
        fingerprint,
        collectionSource: kind,
        collectionScope: kind,
        receivedAt: receivedAt.toISOString(),
        data,
      };
    };
    const original = await makeInput();
    const families = [
      ['session', 1],
      ['website_event', 1],
      ['event_data', 3],
      ['revenue', 1],
      ['liekan_collection_receipt', 1],
    ] as const;
    blockedSite = site;
    const failuresBefore = publicationFailures;
    await queue.enqueue(original);
    await until(async () => publicationFailures > failuresBefore, `${kind} publication fault`);
    const [originalWork] = await db.read<{ status: string; effects: unknown[] }>(
      'SELECT w.status,a.effects FROM liekan_warehouse_work w JOIN liekan_warehouse_attempt a USING(attempt_id) WHERE w.input_id=$1',
      [original.inputId],
    );
    assert.deepEqual(originalWork.effects, [], 'exercise the no-PG-effects package');
    assert.equal(originalWork.status, 'working', 'unpublished original retains its receipt key');
    for (const [family] of families)
      assert.equal((await visible(site, family)).length, 0, `${kind}/${family} invisible`);

    const retry = await makeInput();
    await queue.enqueue(retry);
    await until(
      async () =>
        (await db.read('SELECT 1 FROM liekan_warehouse_work WHERE input_id=$1', [retry.inputId]))
          .length === 1,
      `${kind} retry durably discovered`,
    );
    // Completion is the same gate awaited by /api/send before a successful HTTP
    // response. Both the initial submission and its UUID retry must time out.
    await Promise.all(
      [original, retry].map(input =>
        assert.rejects(
          completion.wait(input, 3000),
          error =>
            error instanceof WarehouseUnavailable &&
            error.code === 'warehouse-confirmation-pending',
        ),
      ),
    );
    const [retryWork] = await db.read<{ status: string; attempt_id: string | null }>(
      'SELECT status,attempt_id FROM liekan_warehouse_work WHERE input_id=$1',
      [retry.inputId],
    );
    assert.equal(retryWork.status, 'pending');
    assert.equal(
      retryWork.attempt_id,
      null,
      'retry must not create an empty early-success package',
    );
    for (const [family] of families)
      assert.equal((await visible(site, family)).length, 0, `${kind}/${family} still invisible`);

    blockedSite = undefined;
    const [accepted, repeated] = await Promise.all([
      completion.wait(original, 45000),
      completion.wait(retry, 45000),
    ]);
    assert.deepEqual(accepted, {
      status: 'new',
      sessionId: original.sessionId,
      visitId: original.visitId,
    });
    assert.deepEqual(repeated, { ...accepted, status: 'duplicate' });
    const afterRecovery = await makeInput();
    await queue.enqueue(afterRecovery);
    assert.deepEqual(await completion.wait(afterRecovery, 45000), repeated);
    for (const [family, expected] of families) {
      assert.equal(
        (await visible(site, family)).length,
        expected,
        `${kind}/${family} exactly once`,
      );
      const [pgCount] = await db.read<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${family} WHERE website_id=$1`,
        [site],
      );
      assert.equal(pgCount.n, '0', `${kind}/${family} must not be dual-written to PG`);
    }
    const [event] = await visible(site, 'website_event');
    assert.equal(event.event_id, original.eventId);
    const [revenue] = await visible(site, 'revenue');
    assert.equal(Number(revenue.revenue), 3.5);
    assert.equal(revenue.currency, 'CNY');
    const [publications] = await db.read<{ n: string }>(
      "SELECT count(*)::text AS n FROM liekan_warehouse_publication WHERE website_id=$1 AND status='published'",
      [site],
    );
    assert.equal(publications.n, '1', 'UUID retries must not publish another event package');
    cases.push({
      kind,
      name: 'publication failure withholds initial and UUID retry completion; recovery publishes properties/revenue once and PG facts stay empty',
      publicationFailures: publicationFailures - failuresBefore,
      status: 'pass',
    });
  }
  console.log(`PASS ${cases.length} link/pixel publication barrier cases`);
} catch (error) {
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
  console.error(error instanceof Error ? error.message : 'Publication barrier acceptance failed');
  process.exitCode = 1;
} finally {
  blockedSite = undefined;
  await worker?.close();
  await completion.close();
  await Promise.allSettled([
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
