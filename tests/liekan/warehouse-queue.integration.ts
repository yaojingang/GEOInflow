import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Kafka, logLevel } from 'kafkajs';
import kafkaJS from 'kafkajs';
import { queueTopicConfig } from '../../src/lib/liekan/warehouse/queue-policy';
import {
  type InputEnvelope,
  route,
  routingKey,
  validateEnvelope,
} from '../../src/lib/liekan/warehouse/routing';
import { inspectQueueTopic, WarehouseQueue } from '../../src/lib/liekan/warehouse/transport';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_queue_${Date.now()}`;
const options = { brokers: ['127.0.0.1:29109'], maxMessageBytes: 1024 * 1024 };
const kafka = new Kafka({ brokers: options.brokers, logLevel: logLevel.NOTHING });
const admin = kafka.admin();
const consumer = kafka.consumer({
  groupId: run,
  allowAutoTopicCreation: false,
  sessionTimeout: 10000,
});
let queue: WarehouseQueue | undefined;
const cases: object[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await admin.connect();
  await admin.createTopics({
    waitForLeaders: true,
    topics: [
      {
        topic: run,
        numPartitions: 2,
        replicationFactor: 1,
        configEntries: [
          { name: 'retention.ms', value: '-1' },
          { name: 'retention.bytes', value: '-1' },
          { name: 'cleanup.policy', value: 'delete' },
          { name: 'flush.messages', value: '1' },
        ],
      },
    ],
  });
  const installation = await inspectQueueTopic(options, run);
  queue = new WarehouseQueue(options, installation);
  await queue.connect();
  const site = randomUUID(),
    session = randomUUID();
  const events: InputEnvelope[] = Array.from({ length: 64 }, () => ({
    version: 1,
    routingVersion: 1,
    topicId: installation.topicId,
    websiteId: site,
    sessionId: session,
    clientEventId: randomUUID(),
    inputId: randomUUID(),
    eventId: randomUUID(),
    visitId: randomUUID(),
    epoch: '0',
    policyRevision: '0',
    kind: 'browser',
    fingerprint: 'a'.repeat(64),
    collectionSource: 'browser',
    collectionScope: 'browser',
    receivedAt: new Date().toISOString(),
    data: { fixture: true },
  }));
  const acks = await Promise.all(events.map(e => queue.enqueue(e)));
  assert.equal(acks.length, 64);
  assert.equal(new Set(acks.map(a => a.partition)).size, 2);
  const received = new Set<string>();
  let finish: () => void, fail: (e: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  timer = setTimeout(() => fail(new Error('warehouse queue bounded consume timeout')), 20000);
  consumer.on(consumer.events.CRASH, e => fail(e.payload.error));
  await consumer.connect();
  await consumer.subscribe({ topic: run, fromBeginning: true });
  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, heartbeat }) => {
      for (const message of batch.messages) {
        const input = validateEnvelope(JSON.parse(message.value.toString()));
        assert.equal(batch.partition, route(input, 2));
        assert.equal(message.key.toString(), routingKey(input));
        received.add(input.inputId);
      }
      await heartbeat();
      if (received.size === events.length) finish();
    },
  });
  await done;
  clearTimeout(timer);
  assert.deepEqual([...received].sort(), events.map(e => e.inputId).sort());
  cases.push({
    name: '64 concurrent durable native sends, exact IDs and normal two-partition routes',
    status: 'pass',
  });
  await assert.rejects(
    () => queue.enqueue({ ...events[0], data: { oversize: 'x'.repeat(1024 * 1024) } }),
    /warehouse-event-too-large/,
  );
  await assert.rejects(
    () => queue.enqueue({ ...events[0], topicId: '0'.repeat(32) }),
    /warehouse-envelope-topic-mismatch/,
  );
  assert.equal(
    (await queue.highWatermarks()).reduce((n, b) => n + BigInt(b.offset), 0n),
    64n,
  );
  cases.push({
    name: 'oversize and foreign-topic input rejected before broker write',
    status: 'pass',
  });
  const invalid = new WarehouseQueue(options, { ...installation, partitions: 3 });
  try {
    await assert.rejects(() => invalid.connect(), /warehouse-topic-identity-changed/);
  } finally {
    await invalid.close();
  }
  cases.push({ name: 'registered partition mismatch rejected', status: 'pass' });
  for (const [name, value, safe] of [
    ['flush.messages', '1000', '1'],
    ['retention.ms', '60000', '-1'],
    ['retention.bytes', '1048576', '-1'],
    ['cleanup.policy', 'compact', 'delete'],
    ['unclean.leader.election.enable', 'true', 'false'],
  ]) {
    const change = (value: string) =>
      admin.alterConfigs({
        validateOnly: false,
        resources: [
          {
            type: kafkaJS.ConfigResourceTypes.TOPIC,
            name: run,
            configEntries: [
              { name: 'retention.ms', value: '-1' },
              { name: 'retention.bytes', value: '-1' },
              { name: 'cleanup.policy', value: 'delete' },
              { name: 'flush.messages', value: '1' },
              { name: 'unclean.leader.election.enable', value: 'false' },
            ].map(e => (e.name === name ? { name, value } : e)),
          },
        ],
      });
    await change(value);
    const unsafe = new WarehouseQueue(options, installation);
    try {
      await assert.rejects(
        () => unsafe.connect(),
        new RegExp(`warehouse-unsafe-queue-policy:${name}`),
      );
    } finally {
      await unsafe.close();
      await change(safe);
    }
  }
  cases.push({
    name: 'unsafe durability, retention and compaction policies fail closed',
    status: 'pass',
  });
  const pressureTopic = `${run}_pressure`;
  await admin.createTopics({
    waitForLeaders: true,
    topics: [
      {
        topic: pressureTopic,
        numPartitions: 1,
        replicationFactor: 1,
        configEntries: queueTopicConfig(1),
      },
    ],
  });
  const pressureIdentity = await inspectQueueTopic(options, pressureTopic);
  const pressure = new WarehouseQueue(
    { ...options, storagePath: `/nonexistent-geoinflow-test-${run}` },
    pressureIdentity,
  );
  try {
    await pressure.connect();
    await assert.rejects(
      () => pressure.enqueue({ ...events[0], topicId: pressureIdentity.topicId }),
      /warehouse-queue-storage-unavailable/,
    );
    assert.equal((await pressure.highWatermarks())[0].offset, '0');
    await pressure.enqueueResultFrame(
      JSON.stringify({ format: 'authority-frame-v1', sequence: '1', part: 0 }),
    );
    assert.equal((await pressure.highWatermarks())[0].offset, '1');
  } finally {
    await pressure.close();
  }
  cases.push({
    name: 'missing storage mount blocks new input while durable result drain remains possible',
    status: 'pass',
  });
  console.log(`PASS ${cases.length} formal warehouse queue cases`);
} catch (error) {
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
  console.error(error instanceof Error ? error.message : 'Warehouse queue test failed');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await Promise.allSettled([consumer.disconnect(), queue?.close(), admin.disconnect()]);
  await mkdir('.local/ch-implementation', { recursive: true, mode: 0o700 });
  await writeFile(
    `.local/ch-implementation/${run}.json`,
    JSON.stringify({ run, cases, fullUpgradeValidated: false }, null, 2),
    { mode: 0o600 },
  );
}
