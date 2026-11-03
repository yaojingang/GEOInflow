import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { createWarehouseClient } from './client';
import { WarehouseCompletion } from './completion';
import type { SiteState } from './control';
import { ControlDatabase, WarehouseConflict } from './control-db';
import { type InputEnvelope, ROUTING_VERSION } from './routing';
import { type QueueOptions, WarehouseQueue } from './transport';
import { warehouseIntakeEnabled } from './authority-routing';
import { verifyBoundWarehouse } from './installation-identity';

export {
  warehouseEnabled,
  warehouseIntakeEnabled,
  warehouseTransitionEnabled,
} from './authority-routing';
type Installation = {
  topic_name: string;
  topic_id: string;
  partition_count: number;
  routing_version: number;
  authority: string;
  transition: string;
};
export class WarehouseRuntime {
  readonly db: ControlDatabase;
  readonly ch: ClickHouseClient;
  readonly queue: WarehouseQueue;
  readonly completion: WarehouseCompletion;
  private constructor(db: ControlDatabase, ch: ClickHouseClient, queue: WarehouseQueue) {
    this.db = db;
    this.ch = ch;
    this.queue = queue;
    this.completion = new WarehouseCompletion(db, ch);
  }

  static async connect(config: {
    databaseURL: string;
    clickhouseURL: string;
    clickhouseDatabase: string;
    clickhouseUsername?: string;
    clickhousePassword?: string;
    queue: QueueOptions;
  }) {
    const db = new ControlDatabase(config.databaseURL);
    let ch: ClickHouseClient, queue: WarehouseQueue;
    try {
      const [installation] = await db.read<Installation>(
        'SELECT * FROM liekan_warehouse_installation WHERE id=1',
      );
      if (!installation || installation.routing_version !== ROUTING_VERSION)
        throw new Error('warehouse-installation-unavailable');
      const url = new URL(config.clickhouseURL);
      const username = url.username
          ? decodeURIComponent(url.username)
          : (config.clickhouseUsername ?? 'default'),
        password = url.password
          ? decodeURIComponent(url.password)
          : (config.clickhousePassword ?? '');
      url.username = '';
      url.password = '';
      ch = createWarehouseClient({
        url: url.toString(),
        username,
        password,
        database: config.clickhouseDatabase,
        request_timeout: 15000,
        clickhouse_settings: { max_execution_time: 10, max_threads: 2 },
      });
      if (installation.authority === 'clickhouse') await verifyBoundWarehouse(db, ch);
      queue = new WarehouseQueue(config.queue, {
        topicName: installation.topic_name,
        topicId: installation.topic_id,
        partitions: installation.partition_count,
        routingVersion: installation.routing_version,
      });
      await queue.connect();
      return new WarehouseRuntime(db, ch, queue);
    } catch (error) {
      await Promise.allSettled([db.close(), ch?.close(), queue?.close()]);
      throw error;
    }
  }

  async resource(id: string, type: 'website' | 'link' | 'pixel'): Promise<SiteState> {
    return this.db.transaction(async tx => {
      const [installation] = (
        await tx.query<Installation>(
          'SELECT * FROM liekan_warehouse_installation WHERE id=1 FOR SHARE',
        )
      ).rows;
      if (!installation || !['postgres', 'clickhouse'].includes(installation.authority))
        throw new WarehouseConflict('warehouse-authority-frozen');
      const rows = await tx.query(
        `SELECT ${type}_id FROM ${type} WHERE ${type}_id=$1::uuid AND deleted_at IS NULL FOR SHARE`,
        [id],
      );
      if (!rows.rowCount) throw new WarehouseConflict('warehouse-resource-unavailable');
      await tx.query(
        `INSERT INTO liekan_warehouse_site(website_id,resource_type,policy_revision)
        VALUES($1::uuid,$2,coalesce((SELECT revision FROM liekan_collection_policy WHERE website_id=$1::uuid),0)) ON CONFLICT DO NOTHING`,
        [id, type],
      );
      const [site] = (
        await tx.query<SiteState & { resource_type: string }>(
          'SELECT * FROM liekan_warehouse_site WHERE website_id=$1::uuid',
          [id],
        )
      ).rows;
      if (site?.state !== 'active' || site.resource_type !== type)
        throw new WarehouseConflict('warehouse-resource-unavailable');
      return site;
    });
  }

  envelope(
    site: SiteState,
    args: Omit<
      InputEnvelope,
      'version' | 'routingVersion' | 'topicId' | 'inputId' | 'epoch' | 'policyRevision'
    >,
  ): InputEnvelope {
    return {
      ...args,
      version: 1,
      routingVersion: 1,
      topicId: this.queue.installation.topicId,
      inputId: randomUUID(),
      epoch: site.epoch,
      policyRevision: site.policy_revision,
    };
  }
  async close() {
    await this.completion.close();
    await Promise.allSettled([this.queue.close(), this.db.close(), this.ch.close()]);
  }
}

const key = Symbol.for('liekan.warehouse-runtime.v1');
const processState = globalThis as typeof globalThis & { [key]?: Promise<WarehouseRuntime> };
export function warehouseRuntimeConfig() {
  const config = {
    databaseURL: process.env.DATABASE_URL,
    clickhouseURL: process.env.LIEKAN_CLICKHOUSE_URL,
    clickhouseDatabase: process.env.LIEKAN_CLICKHOUSE_DATABASE ?? 'liekan',
    clickhouseUsername: process.env.LIEKAN_CLICKHOUSE_USERNAME,
    clickhousePassword: process.env.LIEKAN_CLICKHOUSE_PASSWORD,
    queue: {
      brokers: (process.env.LIEKAN_QUEUE_BROKERS ?? '').split(',').filter(Boolean),
    } as QueueOptions,
  };
  if (!config.databaseURL || !config.clickhouseURL || !config.queue.brokers.length)
    throw new Error('warehouse-configuration-incomplete');
  if (process.env.LIEKAN_QUEUE_USERNAME)
    config.queue.sasl = {
      mechanism: 'scram-sha-256',
      username: process.env.LIEKAN_QUEUE_USERNAME,
      password: process.env.LIEKAN_QUEUE_PASSWORD ?? '',
    };
  if (process.env.LIEKAN_QUEUE_TLS === 'true') config.queue.ssl = true;
  return config;
}
export function warehouseRuntime(): Promise<WarehouseRuntime> {
  if (!warehouseIntakeEnabled()) throw new Error('warehouse-not-enabled');
  if (process.env.CLICKHOUSE_URL) throw new Error('warehouse-upstream-configuration-conflict');
  if (!processState[key]) {
    const config = warehouseRuntimeConfig();
    processState[key] = WarehouseRuntime.connect(config).catch(error => {
      delete processState[key];
      throw error;
    });
  }
  return processState[key];
}

// Called after worker deliveries have drained. Do not create a producer merely
// to shut down a process that never needed one.
export async function closeWarehouseRuntime() {
  const pending = processState[key];
  if (!pending) return;
  delete processState[key];
  const runtime = await pending.catch(() => undefined);
  await runtime?.close();
}
