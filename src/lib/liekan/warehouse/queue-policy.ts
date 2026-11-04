import kafkaJS, { type Admin } from 'kafkajs';

// A single-node installation cannot rely on replica acknowledgements for an
// fsync. Batch appends flush before acknowledgement; accepted source records
// remain until our fenced GC explicitly deletes a verified prefix.
export function queueTopicConfig(replicationFactor: number) {
  return [
    { name: 'retention.ms', value: '-1' },
    { name: 'retention.bytes', value: '-1' },
    { name: 'cleanup.policy', value: 'delete' },
    { name: 'flush.messages', value: '1' },
    { name: 'unclean.leader.election.enable', value: 'false' },
    { name: 'max.message.bytes', value: String(12 * 1024 * 1024) },
    { name: 'min.insync.replicas', value: String(Math.min(2, replicationFactor)) },
  ];
}

export async function verifyQueuePolicy(admin: Admin, topic: string, maxMessageBytes: number) {
  const required = queueTopicConfig(1);
  const { resources } = await admin.describeConfigs({
    resources: [
      {
        type: kafkaJS.ConfigResourceTypes.TOPIC,
        name: topic,
        configNames: required.map(entry => entry.name),
      },
    ],
    includeSynonyms: false,
  });
  const resource = resources.find(r => r.resourceName === topic);
  if (!resource || resource.errorCode) throw new Error('warehouse-queue-policy-unavailable');
  const actual = new Map(
    resource.configEntries.map(entry => [entry.configName, entry.configValue]),
  );
  for (const { name, value } of required) {
    if (name === 'max.message.bytes') {
      if (Number(actual.get(name)) >= maxMessageBytes) continue;
    } else if (name === 'min.insync.replicas') {
      const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
      const partitions = metadata.topics.find(t => t.name === topic)?.partitions;
      if (
        partitions?.length &&
        partitions.every(p => Number(actual.get(name)) >= Math.min(2, p.replicas.length))
      )
        continue;
    } else if (actual.get(name) === value) continue;
    throw new Error(`warehouse-unsafe-queue-policy:${name}`);
  }
}
