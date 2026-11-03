import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import type { Consumer, KafkaMessage } from 'kafkajs';
import type { Attempt, Ownership, PendingWork, SiteState, WarehouseControl } from './control';
import { type ControlSQL, WarehouseConflict } from './control-db';
import { WarehouseDeriver } from './derivation';
import {
  type InputPosition,
  inputDigest,
  type LandedDecision,
  LandingStore,
  type Receipt,
} from './landing';
import { validateLogPackage } from './log-planner';
import { QueueReplayReader } from './replay-reader';
import { route, routingKey, validateEnvelope } from './routing';
import { validateTask } from './tasks';
import type { WarehouseQueue } from './transport';

export type DecisionPlanner = (
  inputs: InputPosition[],
  state: SiteState,
  receipts: Receipt[],
) => Promise<LandedDecision[]>;
export type ConsumerHealth = {
  code: string;
  at: string;
  partition?: number;
  cause?: string;
  automaticRestart?: boolean;
};

export class WarehouseConsumer {
  readonly ownerId = randomUUID();
  private readonly consumer: Consumer;
  private readonly landing: LandingStore;
  private readonly deriver: WarehouseDeriver;
  private readonly replay: QueueReplayReader;
  private readonly owners = new Map<number, Ownership>();
  private readonly claiming = new Map<number, Promise<Ownership>>();
  private readonly running = new Map<number, Promise<void>>();
  private readonly assigned = new Set<number>();
  private readonly deferred = new Map<string, number>();
  private readonly deferredRecovery = new Map<string, number>();
  private readonly cache = new Map<string, { message: KafkaMessage; bytes: number }>();
  private cacheBytes = 0;
  private stopping = false;
  private operational = false;
  private restartRequired = false;
  private nextPartition = 0;
  private timer?: ReturnType<typeof setInterval>;
  private renewal?: ReturnType<typeof setInterval>;
  private renewing?: Promise<void>;
  private lastHealth?: ConsumerHealth;

  constructor(
    private readonly control: WarehouseControl,
    ch: ClickHouseClient,
    private readonly queue: WarehouseQueue,
    private readonly planner: DecisionPlanner,
    private readonly options: {
      groupId: string;
      cacheBytes?: number;
      concurrency?: number;
      onHealth?: (health: ConsumerHealth) => void;
      acceptResult?: (
        tx: ControlSQL,
        attempt: Attempt,
        decisions: LandedDecision[],
      ) => Promise<void>;
      authorityProcessor?: {
        process: (owner: Ownership, attempt: Attempt, inputs: InputPosition[]) => Promise<void>;
        recover: (owner: Ownership, attempt: Attempt) => Promise<void>;
      };
      confirmAuthority?: (
        tx: ControlSQL,
        attempt: Attempt,
        decisions: LandedDecision[],
      ) => Promise<void>;
    },
  ) {
    if (
      !Number.isInteger(options.concurrency ?? 2) ||
      (options.concurrency ?? 2) < 1 ||
      (options.concurrency ?? 2) > 32
    )
      throw new Error('Invalid warehouse consumer concurrency');
    this.landing = new LandingStore(ch);
    this.deriver = new WarehouseDeriver(control.db, ch);
    this.replay = new QueueReplayReader(queue);
    this.consumer = queue.kafka.consumer({
      groupId: options.groupId,
      allowAutoTopicCreation: false,
      maxBytesPerPartition: queue.maxMessageBytes,
      maxBytes: queue.maxMessageBytes,
      maxWaitTimeInMs: 100,
      sessionTimeout: 30000,
    });
    this.consumer.on(this.consumer.events.GROUP_JOIN, e => {
      this.operational = !this.stopping;
      this.restartRequired = false;
      this.assigned.clear();
      for (const partition of e.payload.memberAssignment[queue.installation.topicName] ?? [])
        this.assigned.add(partition);
    });
    for (const event of [
      this.consumer.events.REBALANCING,
      this.consumer.events.DISCONNECT,
      this.consumer.events.STOP,
    ]) {
      this.consumer.on(event, () => {
        this.operational = false;
        this.assigned.clear();
      });
    }
    this.consumer.on(this.consumer.events.CRASH, e => {
      this.operational = false;
      this.assigned.clear();
      this.restartRequired = !e.payload.restart;
      // Errors can contain connection URLs or payloads. Record only our fixed
      // conflict code, including when KafkaJS wraps the original cause.
      let error: unknown = e.payload.error,
        cause: string | undefined;
      for (let depth = 0; error && depth < 8; depth++) {
        if (error instanceof WarehouseConflict && /^warehouse-[a-z-]+$/.test(error.code)) {
          cause = error.code;
          break;
        }
        if (
          error instanceof TypeError ||
          error instanceof RangeError ||
          error instanceof ReferenceError ||
          error instanceof SyntaxError
        ) {
          cause = `warehouse-consumer-${error.name.toLowerCase()}`;
          break;
        }
        error = (error as { cause?: unknown }).cause;
      }
      this.health('warehouse-consumer-unavailable', undefined, {
        cause,
        automaticRestart: e.payload.restart,
      });
    });
  }

  isOperational() {
    return this.operational && !this.stopping;
  }
  needsRestart() {
    return this.restartRequired && !this.stopping;
  }
  healthSnapshot() {
    return this.lastHealth;
  }
  private health(
    code: string,
    partition?: number,
    detail?: Pick<ConsumerHealth, 'cause' | 'automaticRestart'>,
  ) {
    this.lastHealth = { code, partition, at: new Date().toISOString(), ...detail };
    this.options.onHealth?.(this.lastHealth);
  }
  private remember(partition: number, message: KafkaMessage) {
    const key = `${partition}:${message.offset}`;
    if (this.cache.has(key)) return;
    const bytes = (message.value?.length ?? 0) + (message.key?.length ?? 0) + 128;
    this.cache.set(key, { message, bytes });
    this.cacheBytes += bytes;
    const limit = this.options.cacheBytes ?? 32 * 1024 * 1024;
    while (this.cacheBytes > limit && this.cache.size) this.forget([...this.cache.keys()][0]);
  }
  private forget(key: string) {
    const old = this.cache.get(key);
    if (old) {
      this.cacheBytes -= old.bytes;
      this.cache.delete(key);
    }
  }
  private async owner(partition: number) {
    if (!this.assigned.has(partition) || this.stopping)
      throw new WarehouseConflict('warehouse-owner-fenced');
    if (this.owners.has(partition)) return this.owners.get(partition);
    if (this.claiming.has(partition)) return this.claiming.get(partition);
    const promise = this.control
      .claim(this.queue.installation.topicId, partition, this.ownerId)
      .then(owner => {
        this.owners.set(partition, owner);
        return owner;
      });
    this.claiming.set(partition, promise);
    try {
      return await promise;
    } finally {
      this.claiming.delete(partition);
    }
  }

  async start() {
    await this.queue.assertIdentity();
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: this.queue.installation.topicName,
      fromBeginning: true,
    });
    await this.consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      partitionsConsumedConcurrently: 2,
      eachBatch: async ({ batch, isStale, isRunning, resolveOffset, heartbeat }) => {
        if (!isRunning() || isStale() || this.stopping) return;
        await this.queue.assertIdentity();
        if (!isRunning() || isStale() || this.stopping) return;
        const owner = await this.owner(batch.partition);
        for (let start = 0; start < batch.messages.length; start += 1000) {
          const messages = batch.messages.slice(start, start + 1000);
          const parsed: { message: KafkaMessage; input: ReturnType<typeof validateEnvelope> }[] =
            [];
          for (const message of messages) {
            try {
              const input = validateEnvelope(JSON.parse(message.value?.toString() ?? ''));
              parsed.push({ message, input });
            } catch {
              await this.control.fault(owner, message.offset, 'warehouse-invalid-envelope');
            }
          }
          const sites = new Set(
            (
              await this.control.db.read<{ website_id: string }>(
                'SELECT website_id FROM liekan_warehouse_site WHERE website_id=ANY($1::uuid[])',
                [parsed.map(p => p.input.websiteId)],
              )
            ).map(s => s.website_id),
          );
          const references = [];
          for (const { message, input } of parsed) {
            if (!sites.has(input.websiteId)) {
              await this.control.fault(owner, message.offset, 'warehouse-unknown-site');
              continue;
            }
            const valid =
              input.topicId === owner.topicId &&
              route(input, this.queue.installation.partitions) === batch.partition &&
              message.key?.toString() === routingKey(input);
            references.push({
              offset: message.offset,
              inputId: input.inputId,
              websiteId: input.websiteId,
              sessionId: input.sessionId,
              identityKey: routingKey(input),
              ...(!valid ? { quarantineReason: 'warehouse-routing-mismatch' } : {}),
            });
            if (valid) this.remember(batch.partition, message);
          }
          await this.control.discover(owner, references, messages.at(-1).offset);
          if (isStale() || !isRunning() || this.stopping) return;
          for (const message of messages) resolveOffset(message.offset);
          await this.consumer.commitOffsets([
            {
              topic: batch.topic,
              partition: batch.partition,
              offset: (BigInt(messages.at(-1).offset) + 1n).toString(),
            },
          ]);
          await heartbeat();
        }
      },
    });
    this.timer = setInterval(() => {
      const partitions = [...this.assigned].sort((a, b) => a - b);
      for (let index = 0; index < partitions.length; index++) {
        if (this.running.size >= (this.options.concurrency ?? 2)) break;
        const partition = partitions[(this.nextPartition + index) % partitions.length];
        if (this.running.has(partition) || this.stopping) continue;
        const task = this.drain(partition)
          .catch(e =>
            this.health(
              e instanceof WarehouseConflict ? e.code : 'warehouse-processing-unavailable',
              partition,
            ),
          )
          .finally(() => this.running.delete(partition));
        this.running.set(partition, task);
      }
      this.nextPartition = partitions.length ? (this.nextPartition + 1) % partitions.length : 0;
    }, 100);
    this.renewal = setInterval(() => {
      if (this.renewing || this.stopping) return;
      this.renewing = (async () => {
        for (const [partition, owner] of this.owners) {
          if (!this.assigned.has(partition) && !this.running.has(partition)) {
            await this.control.release(owner);
            this.owners.delete(partition);
            continue;
          }
          try {
            await this.control.renew(owner);
          } catch {
            this.owners.delete(partition);
            this.health('warehouse-owner-fenced', partition);
          }
        }
      })()
        .catch(() => this.health('warehouse-control-unavailable'))
        .finally(() => {
          this.renewing = undefined;
        });
    }, 5000);
  }

  private async payloads(owner: Ownership, work: PendingWork[]): Promise<InputPosition[]> {
    const missing = work
      .filter(w => !this.cache.has(`${owner.partition}:${w.offset_id}`))
      .map(w => w.offset_id);
    const recovered = missing.length
      ? await this.replay.fetch(owner.partition, missing)
      : new Map<string, KafkaMessage>();
    const inputs: InputPosition[] = [];
    const families = new Map<string, number>();
    let bytes = 0;
    for (const w of work) {
      const message =
        this.cache.get(`${owner.partition}:${w.offset_id}`)?.message ?? recovered.get(w.offset_id);
      if (!message) break; // The replay reader may return a bounded prefix.
      const input = validateEnvelope(JSON.parse(message.value?.toString() ?? ''));
      if (
        input.inputId !== w.input_id ||
        input.websiteId !== w.website_id ||
        routingKey(input) !== w.identity_key ||
        input.topicId !== owner.topicId ||
        route(input, this.queue.installation.partitions) !== owner.partition
      )
        throw new Error('warehouse-replay-reference-mismatch');
      const counts = new Map<string, number>();
      if (Array.isArray(input.data.facts))
        for (const f of input.data.facts) counts.set(f.family, (counts.get(f.family) ?? 0) + 1);
      bytes += message.value?.length ?? 0;
      if (
        inputs.length &&
        (bytes > 32 * 1024 * 1024 ||
          [...counts].some(([f, n]) => (families.get(f) ?? 0) + n > 15000))
      )
        break;
      for (const [f, n] of counts) families.set(f, (families.get(f) ?? 0) + n);
      inputs.push({ partition: owner.partition, offset: w.offset_id, envelope: input });
    }
    if (!inputs.length) throw new Error('warehouse-replay-empty');
    return inputs;
  }

  private async restore(owner: Ownership, attempt: Attempt) {
    if (this.options.authorityProcessor)
      return this.options.authorityProcessor.recover(owner, attempt);
    await this.landing.projectDecision(attempt);
    await this.deriver.derive(attempt.attempt_id);
    // A receipt retry must wait for its original package's publication, including
    // link/pixel packages without PG effects. Releasing the key after the decision
    // alone would let an empty duplicate package acknowledge unpublished facts.
    await this.control.decisionProjected(owner, attempt.attempt_id);
  }

  private async drain(partition: number) {
    const owner = await this.owner(partition);
    for (const attempt of await this.control.recovery(owner)) {
      if ((this.deferredRecovery.get(attempt.attempt_id) ?? 0) > Date.now()) continue;
      try {
        await this.restore(owner, attempt);
        this.deferredRecovery.delete(attempt.attempt_id);
      } catch {
        this.deferredRecovery.set(attempt.attempt_id, Date.now() + 2000);
        this.health('warehouse-projection-deferred', partition);
      }
    }
    const excluded = [...this.deferred].filter(([, at]) => at > Date.now()).map(([site]) => site);
    const ready = await this.control.ready(owner, 500, excluded);
    const groups = new Map<string, PendingWork[]>();
    for (const work of ready) {
      const rows = groups.get(work.website_id) ?? [];
      rows.push(work);
      groups.set(work.website_id, rows);
    }
    for (const [site, work] of groups) {
      if (!this.assigned.has(partition) || this.stopping) break;
      let attempt: Attempt | undefined;
      try {
        // Use the already bounded ready/replay batch. A second 100-row cap
        // fragmented bulk logs into many tiny CH parts and repeated the full
        // acceptance/publication protocol for each fragment. payloads() still
        // bounds bytes and rows per fact family, including large properties.
        const chosen = work.slice(0, 500);
        const inputs = await this.payloads(owner, chosen);
        attempt = await this.control.intent(
          owner,
          site,
          inputs.map(i => i.offset),
          inputDigest(inputs),
        );
        if (this.options.authorityProcessor) {
          await this.options.authorityProcessor.process(owner, attempt, inputs);
          for (const input of inputs) this.forget(`${partition}:${input.offset}`);
          this.deferred.delete(site);
          continue;
        }
        const state = await this.control.site(site);
        const receipts = await this.landing.receipts(
          {
            websiteId: site,
            epoch: attempt.epoch,
            publication: state.publication,
            deletionRevision: attempt.deletion_revision,
          },
          inputs.map(i => routingKey(i.envelope)),
        );
        // Reset discards the old collection epoch. Policy changes preserve raw
        // evidence; the planner re-evaluates against the current control snapshot,
        // and confirm fences a concurrent revision change. Never discard an
        // already acknowledged log merely because policy changed in the queue.
        const deleted = await this.landing.deletedInputs(
          {
            websiteId: site,
            epoch: attempt.epoch,
            publication: state.publication,
            deletionRevision: attempt.deletion_revision,
          },
          inputs,
        );
        const stale = inputs.filter(
          i => i.envelope.epoch !== attempt.epoch || deleted.has(i.envelope.inputId),
        );
        const usable = inputs.filter(i => !stale.includes(i));
        const replayed = await this.landing.acceptedInputs(
          {
            websiteId: site,
            epoch: attempt.epoch,
            publication: state.publication,
            deletionRevision: attempt.deletion_revision,
          },
          usable,
        );
        const unaccepted = usable.filter(i => !replayed.has(i.envelope.inputId));
        const decisions: LandedDecision[] = [
          ...(unaccepted.length ? await this.planner(unaccepted, state, receipts) : []),
          ...replayed.values(),
          ...stale.map(input => {
            const batchId =
              input.envelope.kind === 'log'
                ? validateLogPackage(input.envelope).packet.batchId
                : null;
            return {
              input,
              status: 'cancelled' as const,
              sessionId: null,
              visitId: null,
              facts: [],
              ...(batchId
                ? {
                    effects: [
                      {
                        kind: 'log-upload' as const,
                        batchId,
                        processed: 1,
                        inserted: 0,
                        duplicates: 0,
                        conflicts: 0,
                        cancelled: 1,
                      },
                    ],
                  }
                : input.envelope.kind === 'task'
                  ? {
                      effects: [
                        {
                          kind: 'analysis-task' as const,
                          taskId: validateTask(input.envelope).taskId,
                          cancelled: true,
                        },
                      ],
                    }
                  : {}),
            };
          }),
        ];
        await this.landing.stage(attempt, decisions);
        const accepted = await this.control.confirm(
          owner,
          attempt.attempt_id,
          attempt.input_digest,
          decisions.map(d => d.sessionId).filter((id): id is string => id !== null),
          decisions.flatMap(d => d.effects ?? []),
          this.options.confirmAuthority
            ? (tx, a) => this.options.confirmAuthority(tx, a, decisions)
            : undefined,
          this.options.acceptResult
            ? (tx, a) => this.options.acceptResult(tx, a, decisions)
            : undefined,
        );
        await this.restore(owner, accepted);
        for (const input of inputs) this.forget(`${partition}:${input.offset}`);
        this.deferred.delete(site);
      } catch (error) {
        // Unknown COMMIT outcomes are reconciled by attempt ID. Only an intent
        // may be aborted; already accepted packages always recover from landing.
        if (attempt) await this.control.abort(owner, attempt.attempt_id).catch(() => {});
        this.deferred.set(site, Date.now() + 2000);
        this.health(
          error instanceof WarehouseConflict ? error.code : 'warehouse-site-deferred',
          partition,
        );
      }
    }
    await this.control.safeOffset(owner);
  }

  async close() {
    this.stopping = true;
    this.operational = false;
    clearInterval(this.timer);
    clearInterval(this.renewal);
    await this.consumer.stop();
    await Promise.allSettled([...this.running.values(), ...this.claiming.values(), this.renewing]);
    await this.replay.close();
    for (const owner of this.owners.values()) await this.control.release(owner).catch(() => {});
    await this.consumer.disconnect();
  }
}
