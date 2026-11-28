import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Kafka, logLevel } from 'kafkajs';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Prototype, PROJECT, OUTPUT, delay } from './core.ts';

const run = `proto_clients_${Date.now()}`,
  p = new Prototype(run);
const exec = promisify(execFile);
const compose = ['compose', '-p', PROJECT, '-f', 'experiments/ch-prototype/compose.yaml'];
const docker = async (...args: string[]) =>
  (await exec('docker', args, { timeout: 30000 })).stdout.trim();
const output: any = { run, cases: [], scope: 'transport adapters only' };
const native = new KafkaJS.Kafka({
  kafkaJS: { brokers: ['127.0.0.1:29099'], logLevel: 0 },
  'socket.timeout.ms': 1000,
  'allow.auto.create.topics': false,
});
const nativeAdmin = native.admin();
const factories = {
  kafkajs: () =>
    new Kafka({
      brokers: ['127.0.0.1:29099'],
      logLevel: logLevel.NOTHING,
      requestTimeout: 1500,
      retry: { retries: 1, initialRetryTime: 100 },
    }).producer({ idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: false }),
  confluent: () =>
    native.producer({
      kafkaJS: { idempotent: true, acks: -1, maxInFlightRequests: 1 },
      'message.timeout.ms': 2000,
      'allow.auto.create.topics': false,
    }),
};
try {
  const id = await docker(...compose, 'ps', '-q', 'redpanda');
  const [container] = JSON.parse(await docker('inspect', id));
  assert.equal(container.Config.Labels['com.docker.compose.project'], PROJECT);
  await p.connect();
  await p.setup();
  await nativeAdmin.connect();
  const metadata = await nativeAdmin.fetchTopicMetadata({ topics: [p.inputTopic] });
  const brokerId = metadata[0].topicId;
  assert.ok(brokerId, 'native client must expose an actual broker topic ID');
  // 1.11.0's runtime names the base64 field differently from its declaration.
  // The two signed bigint fields have a consistent representation.
  output.topicId = [brokerId.mostSignificantBits, brokerId.leastSignificantBits]
    .map(n => BigInt.asUintN(64, n).toString(16).padStart(16, '0'))
    .join('');
  assert.notEqual(output.topicId, '0'.repeat(32));
  for (const [name, factory] of Object.entries(factories)) {
    let producer: any = factory();
    const send = (topic: string, value: string) =>
      producer.send({
        topic,
        ...(name === 'kafkajs' ? { acks: -1 } : {}),
        messages: [{ partition: 0, key: name, value }],
      });
    const prefix = `${name}_`;
    await producer.connect();
    try {
      for (let i = 0; i < 4; i++) await send(p.inputTopic, JSON.stringify({ id: prefix + i }));
      await producer.disconnect();
      producer = factory();
      await producer.connect();
      await send(p.inputTopic, JSON.stringify({ id: `${prefix}restart` }));
      const unknown = `${run}_${name}_absent`;
      await assert.rejects(() => send(unknown, JSON.stringify({ id: 'must-not-auto-create' })));
      assert.ok(!(await p.admin.listTopics()).includes(unknown));
      await docker('network', 'disconnect', `${PROJECT}_default`, id);
      let rejected = false,
        elapsed = 0;
      try {
        const start = performance.now();
        try {
          await send(p.inputTopic, JSON.stringify({ id: `${prefix}outage` }));
        } catch {
          rejected = true;
        }
        elapsed = Math.round(performance.now() - start);
        assert.ok(rejected, 'unreachable broker must not report success');
      } finally {
        await docker('network', 'connect', '--alias', 'redpanda', `${PROJECT}_default`, id);
      }
      await delay(500);
      await producer.disconnect();
      producer = factory();
      await producer.connect();
      await send(p.inputTopic, JSON.stringify({ id: `${prefix}recovered` }));
      const messages = (await p.snapshot())
        .map(m => m.value.id)
        .filter((v: string) => v.startsWith(prefix));
      assert.deepEqual(
        messages.sort(),
        [0, 1, 2, 3]
          .map(i => prefix + i)
          .concat(`${prefix}restart`, `${prefix}recovered`)
          .sort(),
      );
      output.cases.push({
        client: name,
        status: 'pass',
        messages: messages.length,
        timeoutRejected: rejected,
        rejectionMs: elapsed,
        autoCreated: false,
      });
      console.log(`PASS ${name}: confirmation, reconnect, bounded failure, no auto-create`);
    } finally {
      await producer.disconnect();
    }
  }
  output.conclusion =
    'Both transport adapters passed this small probe. KafkaJS remains the protocol baseline; broker topic-ID validation requires the metadata API demonstrated by the native adapter.';
} catch (error) {
  output.error = error instanceof Error ? error.message : String(error);
  console.error(output.error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([nativeAdmin.disconnect(), p.disconnect()]);
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(resolve(OUTPUT, `${run}-report.json`), JSON.stringify(output, null, 2));
}
