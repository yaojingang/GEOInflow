import { randomUUID } from 'node:crypto';
import { Kafka, logLevel } from 'kafkajs';
import type { ClickHouseClient } from '@clickhouse/client';
import { factTables, identifier } from './catalog';
import { type ControlDatabase, WarehouseConflict } from './control-db';
import { initializeWarehouse } from './initialize';
import { verifyWarehouseIdentity } from './installation-identity';
import { ROUTING_VERSION } from './routing';
import { WAREHOUSE_SCHEMA_VERSION } from './schema';
import { queueTopicConfig, verifyQueuePolicy } from './queue-policy';
import { inspectQueueTopic, type QueueOptions, WarehouseQueue } from './transport';

type Installation = {
  installation_id: string;
  topic_name: string;
  topic_id: string;
  partition_count: number;
  authority: string;
  facts_fenced: boolean;
  identity_bound: boolean;
  setup_mode: 'fresh' | 'pg-transition' | null;
};
export async function installWarehouse(
  db: ControlDatabase,
  ch: ClickHouseClient,
  options: {
    mode: 'fresh' | 'pg-transition';
    queue: QueueOptions;
    inputTopic: string;
    resultTopic?: string;
    partitions: number;
    replicationFactor: number;
  },
) {
  if (
    !['fresh', 'pg-transition'].includes(options.mode) ||
    !Number.isInteger(options.partitions) ||
    options.partitions < 1 ||
    options.partitions > 4096 ||
    !Number.isInteger(options.replicationFactor) ||
    options.replicationFactor < 1
  )
    throw new Error('warehouse-invalid-installation-options');
  const names = [
    options.inputTopic,
    ...(options.mode === 'pg-transition' ? [options.resultTopic] : []),
  ];
  if (
    names.some(n => !n || !/^[a-zA-Z0-9_.-]{1,249}$/.test(n)) ||
    new Set(names).size !== names.length
  )
    throw new Error('warehouse-invalid-topic-names');
  const [existing] = await db.read<Installation>(
    'SELECT * FROM liekan_warehouse_installation WHERE id=1',
  );
  const finish = async (id: string, resumed: boolean) => {
    await verifyWarehouseIdentity(ch, id, true);
    return db.transaction(async tx => {
      const [row] = (
        await tx.query<Installation>(
          'SELECT * FROM liekan_warehouse_installation WHERE id=1 FOR UPDATE',
        )
      ).rows;
      if (
        row?.installation_id !== id ||
        row.setup_mode !== options.mode ||
        row.authority !== 'frozen' ||
        row.identity_bound
      )
        throw new WarehouseConflict('warehouse-installation-activation-conflict');
      const authority = options.mode === 'fresh' ? 'clickhouse' : 'postgres';
      await tx.query(
        'UPDATE liekan_warehouse_installation SET authority=$1,identity_bound=true,revision=revision+1,updated_at=clock_timestamp() WHERE id=1',
        [authority],
      );
      return { installationId: id, authority, resumed };
    });
  };
  const broker = new Kafka({
    ...options.queue,
    logLevel: logLevel.NOTHING,
    connectionTimeout: 3000,
    requestTimeout: 10000,
  }).admin();
  try {
    await broker.connect();
    if (!existing)
      await broker.createTopics({
        waitForLeaders: true,
        topics: names.map((topic, i) => ({
          topic,
          numPartitions: i === 0 ? options.partitions : 1,
          replicationFactor: options.replicationFactor,
          configEntries: queueTopicConfig(options.replicationFactor),
        })),
      });
    for (const topic of names) await verifyQueuePolicy(broker, topic, 12 * 1024 * 1024);
    const input = await inspectQueueTopic(options.queue, options.inputTopic);
    const result =
      options.mode === 'pg-transition'
        ? await inspectQueueTopic(options.queue, options.resultTopic)
        : null;
    if (input.partitions !== options.partitions || (result && result.partitions !== 1))
      throw new Error('warehouse-topic-partition-mismatch');
    if (existing) {
      if (
        existing.topic_id !== input.topicId ||
        existing.topic_name !== input.topicName ||
        existing.partition_count !== input.partitions ||
        !existing.facts_fenced
      )
        throw new WarehouseConflict('warehouse-installation-conflict');
      const [capture] = await db.read<{ topic_id: string; topic_name: string }>(
        'SELECT topic_id,topic_name FROM liekan_warehouse_transition WHERE id=1',
      );
      if (
        result
          ? capture?.topic_id !== result.topicId || capture?.topic_name !== result.topicName
          : !!capture
      )
        throw new WarehouseConflict('warehouse-installation-mode-conflict');
      await initializeWarehouse(ch);
      if (!existing.identity_bound) return finish(existing.installation_id, true);
      await verifyWarehouseIdentity(ch, existing.installation_id);
      return {
        installationId: existing.installation_id,
        authority: existing.authority,
        resumed: true,
      };
    }
    // An unregistered nonempty topic must never be silently attached or reset.
    for (const topic of [input, result].filter(Boolean)) {
      const queue = new WarehouseQueue(options.queue, topic);
      try {
        await queue.connect();
        if ((await queue.highWatermarks()).some(p => p.offset !== '0'))
          throw new Error('warehouse-installation-topic-not-empty');
      } finally {
        await queue.close();
      }
    }
    await initializeWarehouse(ch);
    // Existing CH facts require their original control database and install ID.
    const [{ rows }] = await ch
      .query({
        query:
          "SELECT toString(sum(rows)) AS rows FROM system.parts WHERE active AND database=currentDatabase() AND table!='warehouse_schema_history'",
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ rows: string }>());
    if (rows !== '0') throw new Error('warehouse-installation-target-not-empty');
    const installed = await db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(58914723)::text');
      if ((await tx.query('SELECT 1 FROM liekan_warehouse_installation')).rowCount)
        throw new WarehouseConflict('warehouse-installation-created-concurrently');
      // Old workers must be stopped by the deployment. Locks drain any final
      // legacy transaction before enabling the statement-level writer fence.
      await tx.query(
        `LOCK TABLE ${factTables
          .map(t => identifier(t.name))
          .sort()
          .join(',')} IN SHARE ROW EXCLUSIVE MODE`,
      );
      if (options.mode === 'fresh')
        for (const table of factTables)
          if ((await tx.query(`SELECT 1 FROM ${identifier(table.name)} LIMIT 1`)).rowCount)
            throw new Error('warehouse-fresh-install-requires-empty-facts');
      if (
        (
          await tx.query(
            'SELECT 1 FROM liekan_history_repair_run WHERE lease_until>clock_timestamp() LIMIT 1',
          )
        ).rowCount
      )
        throw new WarehouseConflict('warehouse-repair-worker-still-active');
      const id = randomUUID();
      await tx.query(
        `INSERT INTO liekan_warehouse_installation(id,installation_id,schema_version,routing_version,topic_name,topic_id,partition_count,authority,transition,facts_fenced,setup_mode)
        VALUES(1,$1,$2,$3,$4,$5,$6,'frozen',$7,true,$8)`,
        [
          id,
          WAREHOUSE_SCHEMA_VERSION,
          ROUTING_VERSION,
          input.topicName,
          input.topicId,
          input.partitions,
          options.mode === 'fresh' ? 'none' : 'shadow',
          options.mode,
        ],
      );
      await tx.query(
        'INSERT INTO liekan_warehouse_partition(topic_id,partition) SELECT $1,generate_series(0,$2::int-1)',
        [input.topicId, input.partitions],
      );
      for (const kind of ['website', 'link', 'pixel'])
        await tx.query(
          `INSERT INTO liekan_warehouse_site(website_id,resource_type,policy_revision)
        SELECT r.${kind}_id,$1,coalesce(p.revision,0) FROM ${kind} r LEFT JOIN liekan_collection_policy p ON p.website_id=r.${kind}_id WHERE r.deleted_at IS NULL`,
          [kind],
        );
      if (result)
        await tx.query(
          `INSERT INTO liekan_warehouse_transition(id,transition_id,state,topic_name,topic_id) VALUES(1,$1,'capturing',$2,$3)`,
          [randomUUID(), result.topicName, result.topicId],
        );
      return {
        installationId: id,
        authority: options.mode === 'fresh' ? 'clickhouse' : 'postgres',
        resumed: false,
      };
    });
    return finish(installed.installationId, false);
  } finally {
    await broker.disconnect();
  }
}
