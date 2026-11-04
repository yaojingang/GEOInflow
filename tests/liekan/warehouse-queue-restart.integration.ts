// Isolated Kafka crash/restart test. Never accepts arbitrary container names.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Kafka, logLevel } from 'kafkajs';
import { queueTopicConfig } from '../../src/lib/liekan/warehouse/queue-policy';
import { inspectQueueTopic, WarehouseQueue } from '../../src/lib/liekan/warehouse/transport';
import type { InputEnvelope } from '../../src/lib/liekan/warehouse/routing';

assert.equal(process.env.WAREHOUSE_DOCKER_TEST, 'isolated-new-project');
const directory = '.local/kafka-validation-20261104';
const project = 'geoinflow-kafka-validation-20261104';
const name = `${project}-warehouse-queue-1`;
const execute = promisify(execFile);
const docker = async (...args: string[]) =>
  (await execute('docker', args, { timeout: 90000 })).stdout;
const options = { brokers: ['127.0.0.1:29109'] };
const topic = `warehouse_kafka_restart_${Date.now()}`;
const admin = new Kafka({ ...options, logLevel: logLevel.NOTHING }).admin();
const report: Record<string, unknown> = { passed: false, project, cases: [] };
let queue: WarehouseQueue;
try {
  const before = JSON.parse(await docker('inspect', name))[0];
  assert.equal(before.Config.Labels['com.docker.compose.project'], project);
  assert.equal(before.Config.Labels['com.docker.compose.service'], 'warehouse-queue');
  assert.equal(before.State.Health.Status, 'healthy');
  assert.equal(
    before.Mounts.find((m: any) => m.Destination === '/var/lib/kafka/data')?.Name,
    `${project}_liekan-warehouse-queue`,
  );
  const marker = () => docker('exec', name, 'cat', '/var/lib/kafka/data/.liekan-kafka-cluster-id');
  const clusterId = await marker();
  await admin.connect();
  await admin.createTopics({
    waitForLeaders: true,
    topics: [{ topic, numPartitions: 1, replicationFactor: 1, configEntries: queueTopicConfig(1) }],
  });
  const identity = await inspectQueueTopic(options, topic);
  queue = new WarehouseQueue(options, identity);
  await queue.connect();
  const site = randomUUID(),
    session = randomUUID();
  const records: InputEnvelope[] = Array.from({ length: 24 }, () => ({
    version: 1,
    routingVersion: 1,
    topicId: identity.topicId,
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
    data: { synthetic: true },
  }));
  for (const mode of ['restart', 'kill'] as const) {
    // An acknowledged batch immediately precedes the abrupt process kill.
    await queue.enqueueMany(
      records.slice(mode === 'restart' ? 0 : 12, mode === 'restart' ? 12 : 24),
    );
    if (mode === 'restart') await docker('restart', '-t', '60', name);
    else {
      await docker('kill', '--signal', 'KILL', name);
      await docker('start', name);
    }
    let after: any;
    for (const end = Date.now() + 90000; Date.now() < end; ) {
      after = JSON.parse(await docker('inspect', name))[0];
      if (after.State.Health?.Status === 'healthy') break;
      await delay(1000);
    }
    assert.equal(after.State.Health?.Status, 'healthy');
    assert.equal(after.RestartCount, 0);
    assert.deepEqual(after.Mounts, before.Mounts);
    assert.equal(await marker(), clusterId);
    assert.deepEqual(await inspectQueueTopic(options, topic), identity);
    assert.equal((await queue.highWatermarks())[0].offset, mode === 'restart' ? '12' : '24');
    (report.cases as unknown[]).push({ mode, retained: mode === 'restart' ? 12 : 24 });
  }
  const consumer = new Kafka({ ...options, logLevel: logLevel.NOTHING }).consumer({
    groupId: topic,
    allowAutoTopicCreation: false,
    sessionTimeout: 10000,
  });
  const received = new Set<string>();
  try {
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) => {
        received.add(JSON.parse(message.value.toString()).inputId);
      },
    });
    for (const end = Date.now() + 30000; received.size < records.length && Date.now() < end; )
      await delay(100);
    assert.deepEqual([...received].sort(), records.map(r => r.inputId).sort());
  } finally {
    await consumer.disconnect();
  }
  report.passed = true;
  report.exactMessageIds = received.size;
  report.powerLossTested = false;
} catch (error) {
  report.error = error instanceof Error ? error.message : 'queue-restart-failed';
  process.exitCode = 1;
} finally {
  await Promise.allSettled([queue?.close(), admin.disconnect()]);
  await writeFile(`${directory}/queue-restart-report.json`, JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
