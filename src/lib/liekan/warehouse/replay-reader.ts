import { randomUUID } from 'node:crypto';
import type { Consumer, KafkaMessage } from 'kafkajs';
import type { WarehouseQueue } from './transport';

type ReplayRequest = {
  partition: number;
  wanted: Set<string>;
  rows: Map<string, KafkaMessage>;
  bytes: number;
  resolve: (rows: Map<string, KafkaMessage>) => void;
  reject: (error: Error) => void;
};

// A separate, uncommitted reader retrieves payloads by durable queue reference.
// Slow sites do not pin the main discovery consumer or retain payloads in PG.
export class QueueReplayReader {
  private consumer: Consumer;
  private startPromise?: Promise<void>;
  private restartRequired = false;
  private rejectStartup?: (error: Error) => void;
  private chain: Promise<unknown> = Promise.resolve();
  private request?: ReplayRequest;
  private closed = false;

  constructor(private readonly queue: WarehouseQueue) {
    this.consumer = this.createConsumer();
  }

  private createConsumer() {
    const consumer = this.queue.kafka.consumer({
      groupId: `liekan-replay-${randomUUID()}`,
      allowAutoTopicCreation: false,
      maxBytesPerPartition: this.queue.maxMessageBytes,
      maxBytes: this.queue.maxMessageBytes,
      maxWaitTimeInMs: 100,
      sessionTimeout: 30000,
    });
    consumer.on(consumer.events.CRASH, () => {
      if (this.consumer !== consumer) return;
      this.restartRequired = true;
      const error = new Error('warehouse-replay-unavailable');
      this.rejectStartup?.(error);
      this.request?.reject(error);
    });
    return consumer;
  }

  private async start() {
    // fetch() serializes this lifecycle. A failed connection or an exhausted
    // KafkaJS restart leaves no reusable reader; retire it before a fresh join.
    if (this.restartRequired) {
      await this.consumer.disconnect();
      if (this.closed) throw new Error('warehouse-replay-stopped');
      this.consumer = this.createConsumer();
      this.startPromise = undefined;
      this.restartRequired = false;
    }
    if (!this.startPromise)
      this.startPromise = (async () => {
        const consumer = this.consumer;
        await consumer.connect();
        await consumer.subscribe({
          topic: this.queue.installation.topicName,
          fromBeginning: true,
        });
        let timer: ReturnType<typeof setTimeout>;
        let off: () => void;
        const joined = new Promise<void>((resolve, reject) => {
          this.rejectStartup = reject;
          timer = setTimeout(() => reject(new Error('warehouse-replay-assignment-timeout')), 20000);
          off = consumer.on(consumer.events.GROUP_JOIN, () => {
            consumer.pause([{ topic: this.queue.installation.topicName }]);
            clearTimeout(timer);
            off();
            resolve();
          });
        });
        // run() may still be pending when an assignment timeout/crash rejects.
        // Keep that rejection handled until the startup sequence awaits it.
        void joined.catch(() => {});
        try {
          await Promise.all([
            consumer.run({
              autoCommit: false,
              eachBatchAutoResolve: false,
              eachBatch: async ({ batch, isStale, heartbeat, pause }) => {
                const job = this.request;
                if (
                  this.consumer !== consumer ||
                  this.restartRequired ||
                  !job ||
                  batch.partition !== job.partition ||
                  isStale()
                ) {
                  pause();
                  return;
                }
                for (const message of batch.messages) {
                  if (this.request !== job || isStale()) break;
                  const first = [...job.wanted][0];
                  if (first !== undefined && BigInt(message.offset) > BigInt(first)) {
                    job.reject(new Error('warehouse-replay-source-missing'));
                    pause();
                    return;
                  }
                  if (job.wanted.delete(message.offset)) {
                    job.bytes += message.value?.length ?? 0;
                    if (job.bytes > 32 * 1024 * 1024 && job.rows.size) {
                      // Return a bounded prefix. Unselected references stay pending
                      // and the next drain fetches them; a large batch is not a fault.
                      job.resolve(job.rows);
                      pause();
                      return;
                    }
                    job.rows.set(message.offset, message);
                  }
                  if (!job.wanted.size) {
                    pause();
                    job.resolve(job.rows);
                    return;
                  }
                }
                await heartbeat();
                if (job.wanted.size && this.request === job)
                  consumer.seek({
                    topic: batch.topic,
                    partition: batch.partition,
                    offset: [...job.wanted][0],
                  });
              },
            }),
            joined,
          ]);
          if (this.restartRequired || this.closed) throw new Error('warehouse-replay-unavailable');
        } finally {
          clearTimeout(timer);
          off?.();
          this.rejectStartup = undefined;
        }
      })().catch(error => {
        this.restartRequired = true;
        this.startPromise = undefined;
        throw error;
      });
    return this.startPromise;
  }

  fetch(partition: number, offsets: string[]): Promise<Map<string, KafkaMessage>> {
    const work = async () => {
      if (
        this.closed ||
        !offsets.length ||
        offsets.length > 500 ||
        offsets.some(v => !/^\d+$/.test(v))
      )
        throw new Error('Invalid replay request');
      await this.start();
      await this.queue.assertIdentity();
      if (this.restartRequired || this.closed) throw new Error('warehouse-replay-unavailable');
      const sorted = [...new Set(offsets)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await new Promise<Map<string, KafkaMessage>>((resolve, reject) => {
          this.request = {
            partition,
            wanted: new Set(sorted),
            rows: new Map(),
            bytes: 0,
            resolve,
            reject,
          };
          timer = setTimeout(() => reject(new Error('warehouse-replay-timeout')), 20000);
          this.consumer.seek({
            topic: this.queue.installation.topicName,
            partition,
            offset: sorted[0],
          });
          this.consumer.resume([
            { topic: this.queue.installation.topicName, partitions: [partition] },
          ]);
        });
      } finally {
        clearTimeout(timer);
        this.request = undefined;
        this.consumer.pause([{ topic: this.queue.installation.topicName }]);
      }
    };
    const result = this.chain.then(work, work);
    this.chain = result.catch(() => {});
    return result;
  }

  async close() {
    this.closed = true;
    this.rejectStartup?.(new Error('warehouse-replay-stopped'));
    this.request?.reject(new Error('warehouse-replay-stopped'));
    await this.chain;
    await this.consumer.disconnect();
  }
}
