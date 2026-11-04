import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Kafka, type KafkaConfig, logLevel } from 'kafkajs';
import { verifyQueuePolicy } from './queue-policy';
import { queueStorage, requireQueueInputSpace } from './queue-storage';
import {
  type InputEnvelope,
  ROUTING_VERSION,
  route,
  routingKey,
  validateEnvelope,
} from './routing';

export type QueueInstallation = {
  topicName: string;
  topicId: string;
  partitions: number;
  routingVersion: number;
};
export type QueueOptions = {
  brokers: string[];
  ssl?: boolean;
  sasl?: { username: string; password: string } & (
    | { mechanism: 'plain' }
    | { mechanism: 'scram-sha-256' }
    | { mechanism: 'scram-sha-512' }
  );
  maxMessageBytes?: number;
  storagePath?: string;
};

export class WarehouseQueue {
  readonly kafka: Kafka;
  private readonly nativeAdmin;
  private readonly producer;
  private identityCheck: Promise<void> | undefined;
  readonly maxMessageBytes: number;

  constructor(
    private readonly options: QueueOptions,
    readonly installation: QueueInstallation,
  ) {
    this.maxMessageBytes = options.maxMessageBytes ?? 12 * 1024 * 1024;
    if (
      !options.brokers.length ||
      !Number.isSafeInteger(this.maxMessageBytes) ||
      this.maxMessageBytes < 1024
    )
      throw new Error('Invalid warehouse queue configuration');
    const config: KafkaConfig = {
      brokers: options.brokers,
      ssl: options.ssl,
      sasl: options.sasl,
      clientId: 'liekan-warehouse',
      logLevel: logLevel.NOTHING,
      connectionTimeout: 3000,
      requestTimeout: 10000,
      retry: { retries: 3, initialRetryTime: 100 },
    };
    this.kafka = new Kafka(config);
    const native = new KafkaJS.Kafka({
      kafkaJS: {
        brokers: options.brokers,
        ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
        ...(options.sasl ? { sasl: options.sasl } : {}),
        clientId: 'liekan-warehouse',
        logLevel: 0,
      },
      'allow.auto.create.topics': false,
      'socket.timeout.ms': 10000,
    });
    this.nativeAdmin = native.admin();
    this.producer = native.producer({
      kafkaJS: { idempotent: true, acks: -1, maxInFlightRequests: 5 },
      'message.timeout.ms': 10000,
      'linger.ms': 5,
      'batch.num.messages': 10000,
      'message.max.bytes': this.maxMessageBytes,
      'allow.auto.create.topics': false,
    });
  }

  async connect() {
    await this.nativeAdmin.connect();
    await this.assertIdentity();
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      await verifyQueuePolicy(admin, this.installation.topicName, this.maxMessageBytes);
    } finally {
      await admin.disconnect();
    }
    await this.producer.connect();
  }
  sibling(installation: QueueInstallation) {
    return new WarehouseQueue(this.options, installation);
  }
  storage() {
    return queueStorage(this.options.storagePath);
  }

  async assertIdentity() {
    if (this.identityCheck) return this.identityCheck;
    this.identityCheck = (async () => {
      const [metadata] = await this.nativeAdmin.fetchTopicMetadata({
        topics: [this.installation.topicName],
      });
      const id = metadata?.topicId;
      if (!id) throw new Error('warehouse-topic-identity-unavailable');
      const actual = [id.mostSignificantBits, id.leastSignificantBits]
        .map(n => BigInt.asUintN(64, n).toString(16).padStart(16, '0'))
        .join('');
      if (
        actual === '0'.repeat(32) ||
        actual !== this.installation.topicId ||
        metadata.partitions.length !== this.installation.partitions ||
        this.installation.routingVersion !== ROUTING_VERSION
      )
        throw new Error('warehouse-topic-identity-changed');
    })();
    try {
      await this.identityCheck;
    } finally {
      this.identityCheck = undefined;
    }
  }

  async enqueue(envelope: InputEnvelope) {
    return (await this.enqueueMany([envelope]))[0];
  }

  // Dedicated transition-result topics use the same durable producer and topic
  // identity fencing. They never pass through the public collection endpoint.
  async enqueueResultFrame(value: string) {
    if (
      this.installation.partitions !== 1 ||
      Buffer.byteLength(value) > this.maxMessageBytes - 1024
    )
      throw new Error('warehouse-result-frame-invalid');
    const frame = JSON.parse(value);
    if (
      frame.format !== 'authority-frame-v1' ||
      !/^\d+$/.test(frame.sequence) ||
      !Number.isInteger(frame.part) ||
      frame.part < 0
    )
      throw new Error('warehouse-result-frame-invalid');
    await this.assertIdentity();
    const receipts = await this.producer.send({
      topic: this.installation.topicName,
      messages: [{ key: frame.sequence, partition: 0, value }],
    });
    if (
      receipts.length !== 1 ||
      receipts[0].partition !== 0 ||
      !/^\d+$/.test(receipts[0].baseOffset)
    )
      throw new Error('warehouse-result-frame-unconfirmed');
    return receipts[0].baseOffset;
  }

  async enqueueMany(envelopes: InputEnvelope[]) {
    if (!envelopes.length || envelopes.length > 10000) throw new Error('Invalid queue send batch');
    const records = envelopes.map(input => {
      const e = validateEnvelope(input);
      if (e.topicId !== this.installation.topicId)
        throw new Error('warehouse-envelope-topic-mismatch');
      const value = JSON.stringify(e),
        bytes = Buffer.byteLength(value);
      if (bytes > this.maxMessageBytes - 1024) throw new Error('warehouse-event-too-large');
      return {
        key: routingKey(e),
        value,
        partition: route(e, this.installation.partitions),
        inputId: e.inputId,
        bytes,
      };
    });
    await this.assertIdentity();
    let batch: typeof records = [],
      bytes = 0;
    const send = async () => {
      if (!batch.length) return;
      // Stop new intake under physical disk pressure. Result frames are exempt
      // so already accepted packages can finish and verified GC can reclaim.
      await requireQueueInputSpace(this.options.storagePath);
      const required = new Set(batch.map(r => r.partition));
      const acknowledgements = await this.producer.send({
        topic: this.installation.topicName,
        messages: batch.map(({ key, value, partition }) => ({ key, value, partition })),
      });
      for (const ack of acknowledgements) required.delete(ack.partition);
      if (required.size) throw new Error('warehouse-queue-confirmation-unavailable');
      batch = [];
      bytes = 0;
    };
    for (const record of records) {
      if (batch.length && (batch.length >= 1000 || bytes + record.bytes > 8 * 1024 * 1024))
        await send();
      batch.push(record);
      bytes += record.bytes;
    }
    await send();
    return records.map(({ inputId, partition }) => ({ inputId, partition }));
  }

  async highWatermarks() {
    await this.assertIdentity();
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      const result = await admin.fetchTopicOffsets(this.installation.topicName);
      if (result.length !== this.installation.partitions)
        throw new Error('warehouse-topic-identity-changed');
      return result.map(r => ({ partition: r.partition, offset: r.high }));
    } finally {
      await admin.disconnect();
    }
  }

  async close() {
    await Promise.allSettled([this.producer.disconnect(), this.nativeAdmin.disconnect()]);
  }
}

export async function inspectQueueTopic(
  options: QueueOptions,
  topicName: string,
): Promise<QueueInstallation> {
  const native = new KafkaJS.Kafka({
    kafkaJS: {
      brokers: options.brokers,
      ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
      ...(options.sasl ? { sasl: options.sasl } : {}),
      logLevel: 0,
    },
    'allow.auto.create.topics': false,
    'socket.timeout.ms': 10000,
  });
  const admin = native.admin();
  try {
    await admin.connect();
    const [metadata] = await admin.fetchTopicMetadata({ topics: [topicName] });
    const id = metadata?.topicId;
    if (!id) throw new Error('warehouse-topic-identity-unavailable');
    const topicId = [id.mostSignificantBits, id.leastSignificantBits]
      .map(n => BigInt.asUintN(64, n).toString(16).padStart(16, '0'))
      .join('');
    if (topicId === '0'.repeat(32)) throw new Error('warehouse-topic-identity-unavailable');
    return {
      topicName,
      topicId,
      partitions: metadata.partitions.length,
      routingVersion: ROUTING_VERSION,
    };
  } finally {
    await admin.disconnect();
  }
}
