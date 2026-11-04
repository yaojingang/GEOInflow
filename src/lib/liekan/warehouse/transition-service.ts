import type { ClickHouseClient } from '@clickhouse/client';
import type { ControlDatabase } from './control-db';
import { TransitionApplier } from './transition-apply';
import { TransitionStream } from './transition-stream';
import { verifyBoundWarehouse } from './installation-identity';
import { type QueueOptions, WarehouseQueue } from './transport';

/** Bounded pumping. The source baseline is mandatory in the production path;
 * primitive protocol tests may exercise an unbound stream separately. */
export class TransitionService {
  private queue?: WarehouseQueue;
  private stream?: TransitionStream;
  private applier?: TransitionApplier;
  private topicId?: string;
  constructor(
    private db: ControlDatabase,
    private ch: ClickHouseClient,
    private options: QueueOptions,
  ) {}
  async tick(limit = 10) {
    const [state] = await this.db.read<{
      state: string;
      topic_name: string;
      topic_id: string;
      migration_id: string;
      ready: boolean;
    }>(
      `SELECT t.*,coalesce(b.status='ready',false) AS ready FROM liekan_warehouse_transition t LEFT JOIN liekan_warehouse_transition_baseline b USING(id) WHERE t.id=1`,
    );
    if (!state || state.state === 'closed') {
      await this.close();
      return { state: 'inactive', sent: 0, clickhouse: 0, postgres: 0 };
    }
    if (!state.migration_id || !state.ready)
      return { state: 'awaiting-baseline', sent: 0, clickhouse: 0, postgres: 0 };
    if (this.topicId && this.topicId !== state.topic_id)
      throw new Error('warehouse-transition-topic-changed');
    if (!this.queue) {
      await verifyBoundWarehouse(this.db, this.ch);
      const queue = new WarehouseQueue(this.options, {
        topicName: state.topic_name,
        topicId: state.topic_id,
        partitions: 1,
        routingVersion: 1,
      });
      try {
        await queue.connect();
      } catch (error) {
        await queue.close();
        throw error;
      }
      this.queue = queue;
      this.topicId = state.topic_id;
      this.stream = new TransitionStream(this.db, queue);
      this.applier = new TransitionApplier(this.db, this.ch, this.stream);
    }
    const sent = await this.stream.publish(limit);
    const clickhouse = await this.applier.drain('clickhouse', limit);
    const postgres = await this.applier.drain('postgres', limit);
    return { state: state.state, sent, clickhouse, postgres };
  }
  async close() {
    await this.stream?.close();
    await this.queue?.close();
    this.queue = undefined;
    this.stream = undefined;
    this.applier = undefined;
    this.topicId = undefined;
  }
}
