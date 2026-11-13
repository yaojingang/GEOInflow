import assert from 'node:assert/strict';

/** Read the broker UUID through the native metadata API; names are not identities. */
export async function topicIdentity(broker: string, topic: string): Promise<string> {
  const { KafkaJS } = await import('@confluentinc/kafka-javascript');
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: [broker], logLevel: 0 },
    'socket.timeout.ms': 3000,
    'allow.auto.create.topics': false,
  });
  const admin = kafka.admin();
  try {
    await admin.connect();
    const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
    const id = metadata[0]?.topicId;
    assert.ok(id, 'broker topic identity unavailable');
    const hex = [id.mostSignificantBits, id.leastSignificantBits]
      .map(n => BigInt.asUintN(64, n).toString(16).padStart(16, '0'))
      .join('');
    assert.notEqual(hex, '0'.repeat(32));
    return hex;
  } finally {
    await admin.disconnect();
  }
}
