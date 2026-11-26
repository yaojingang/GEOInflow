import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient } from '@clickhouse/client';
import { Kafka, logLevel } from 'kafkajs';
import pg from 'pg';
import { PARTITIONS, ROUTING_VERSION, route, routingKey } from './routing.ts';
import { topicIdentity } from './topic-identity.ts';

export const ROUND2 = process.env.PROTO_ROUND === '2';
export const PROJECT = ROUND2 ? 'liekan_ch_proto_round2_20261027' : 'liekan_ch_proto_20261027';
export const OUTPUT = resolve(ROUND2 ? '.local/ch-prototype-round2' : '.local/ch-prototype');
export const BROKER = ROUND2 ? '127.0.0.1:29109' : '127.0.0.1:29099';
export const inside = process.env.PROTO_IN_CONTAINER === '1';
export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
export type Event = {
  id: string;
  site: string;
  session: string;
  visit: string;
  uuid?: string;
  path: string;
  cents: number;
  properties: Record<string, string>;
  kind: 'browser' | 'log';
  source?: string;
  scope?: string;
  policyVersion?: number;
  occurredAt?: string;
  payload?: Record<string, unknown>;
  routingVersion?: number;
};
/** Canonicalize validated JSON with the current collection fingerprint ordering semantics. */
export function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])]),
    );
  return value;
}

/** Exclude the client receipt ID; compare trusted provenance separately from public content. */
export function contentFingerprint(event: Event): string {
  const { eventId: _eventId, ...payload } = event.payload ?? {
    path: event.path,
    cents: event.cents,
    properties: event.properties,
    kind: event.kind,
  };
  return createHmac(
    'sha256',
    ROUND2
      ? readFileSync(resolve(OUTPUT, 'pg-password'), 'utf8').trim()
      : 'isolated-round1-fixture-key',
  )
    .update(JSON.stringify(canonical({ type: event.kind, payload })))
    .digest('hex');
}

export type Input = { partition: number; offset: number; event: Event };
export type Outcome = Event & {
  verdict: string;
  original: string;
  originalSession: string;
  originalVisit: string;
};
type Row = Record<string, any>;

export async function fault(name: string) {
  if (process.env.PROTO_FAULT !== name) return;
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(
    resolve(
      OUTPUT,
      `fault-${process.env.PROTO_ACTOR_ID ? `${process.env.PROTO_ACTOR_ID}-` : ''}${name}.json`,
    ),
    JSON.stringify({ name, reached: true }),
  );
  // External harness kills this container; no self-reported pass and no simulated recovery.
  if (process.env.PROTO_RESUMABLE === '1') {
    const release = resolve(OUTPUT, `release-${process.env.PROTO_ACTOR_ID}-${name}`);
    while (
      await readFile(release).then(
        () => false,
        () => true,
      )
    )
      await delay(25);
  } else {
    await new Promise(() => {});
  }
}

export class Prototype {
  readonly pool = new pg.Pool({
    host: inside ? 'pg' : '127.0.0.1',
    port: inside ? 5432 : ROUND2 ? 25459 : 25439,
    password: ROUND2 ? readFileSync(resolve(OUTPUT, 'pg-password'), 'utf8').trim() : undefined,
    database: 'liekan_ch_proto',
    user: 'liekan_ch_proto',
    max: 8,
    connectionTimeoutMillis: 5000,
    application_name: PROJECT,
  });
  readonly ch = createClient({
    url: inside ? 'http://ch:8123' : ROUND2 ? 'http://127.0.0.1:28139' : 'http://127.0.0.1:28129',
    request_timeout: ROUND2 ? 60000 : 10000,
    clickhouse_settings: { max_threads: 2, max_memory_usage: '300000000' },
  });
  readonly kafka = new Kafka({
    clientId: PROJECT,
    brokers: [inside ? 'redpanda:9092' : BROKER],
    logLevel: logLevel.NOTHING,
    retry: { retries: 1, initialRetryTime: 100 },
    requestTimeout: ROUND2 ? 30000 : 4000,
  });
  readonly admin = this.kafka.admin();
  readonly producer = this.kafka.producer({
    allowAutoTopicCreation: false,
    idempotent: true,
    maxInFlightRequests: 1,
  });
  readonly inputTopic: string;
  readonly resultTopic: string;
  inputTopicId = '';
  constructor(
    readonly run: string,
    readonly strictRouting = process.env.PROTO_STRICT_ROUTING === '1',
  ) {
    assert.match(run, /^proto_[a-z0-9_]{1,55}$/);
    this.inputTopic = `${run}_input`;
    this.resultTopic = `${run}_result`;
  }
  /** Check the fixed experiment database before opening queue clients. */
  async connect() {
    assert.equal(
      (await this.pool.query('SELECT current_database() AS db')).rows[0].db,
      'liekan_ch_proto',
    );
    await this.admin.connect();
    await this.producer.connect();
  }
  /** Close all experiment connections, including after a failed assertion. */
  async disconnect() {
    await Promise.allSettled([
      this.producer.disconnect(),
      this.admin.disconnect(),
      this.ch.close(),
      this.pool.end(),
    ]);
  }
  /** Commit a short control transaction or roll back the entire operation. */
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let failed: Error | undefined;
    const connectionError = (error: Error) => {
      failed = error;
    };
    c.on('error', connectionError);
    try {
      await c.query('BEGIN');
      const value = await fn(c);
      await c.query('COMMIT');
      return value;
    } catch (e) {
      failed ??= e instanceof Error ? e : new Error(String(e));
      // An uncertain COMMIT cannot be undone; retain its original error for reconciliation.
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release(failed);
      c.removeListener('error', connectionError);
    }
  }
  /** Run a parameterized CH query and return its bounded protocol result. */
  async rows(sql: string, query_params: Record<string, any> = {}): Promise<Row[]> {
    return (await this.ch.query({ query: sql, query_params, format: 'JSONEachRow' })).json<Row>();
  }
  /** Write only experiment tables and wait for durable async insertion when selected. */
  async insert(table: string, values: Row[], asyncInsert = false) {
    assert.ok(['landing', 'events', 'properties', 'revenue', 'manifest'].includes(table));
    if (values.length)
      await this.ch.insert({
        table: `liekan_ch_proto.${table}`,
        values,
        format: 'JSONEachRow',
        clickhouse_settings: asyncInsert
          ? { async_insert: 1, wait_for_async_insert: 1, async_insert_busy_timeout_ms: 25 }
          : {},
      });
  }
  /** Initialize experiment-owned structures and register immutable topic identity. */
  async setup() {
    await this.pool.query(await readFile(new URL('schema.pg.sql', import.meta.url), 'utf8'));
    assert.equal(
      (await this.pool.query('SELECT name FROM proto_identity')).rows[0].name,
      'liekan_ch_proto',
    );
    for (const sql of (await readFile(new URL('schema.ch.sql', import.meta.url), 'utf8'))
      .split(';')
      .filter(s => s.trim())) {
      await this.ch.command({ query: sql });
    }
    await this.admin.createTopics({
      waitForLeaders: true,
      timeout: ROUND2 ? 30000 : 5000,
      topics: [this.inputTopic, this.resultTopic].map(topic => ({
        topic,
        numPartitions: topic === this.inputTopic ? 2 : 1,
        replicationFactor: 1,
        configEntries: [
          { name: 'retention.ms', value: '-1' },
          { name: 'retention.bytes', value: '-1' },
          { name: 'write.caching', value: 'false' },
        ],
      })),
    });
    if (ROUND2) {
      this.inputTopicId = await topicIdentity(BROKER, this.inputTopic);
      await this.pool.query(
        'INSERT INTO proto_topic(run,topic,identity,routing_version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [this.run, this.inputTopic, this.inputTopicId, this.strictRouting ? ROUTING_VERSION : 0],
      );
      await this.validateTopic();
    }
    await this.pool.query('INSERT INTO proto_migration(run) VALUES($1) ON CONFLICT DO NOTHING', [
      this.run,
    ]);
    for (let partition = 0; partition < 2; partition++)
      await this.pool.query(
        'INSERT INTO proto_partition(run,partition) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [this.run, partition],
      );
  }
  /** Register isolated test sites without touching product website records. */
  async addSites(...sites: string[]) {
    for (const site of sites)
      await this.pool.query(
        'INSERT INTO proto_site(run,site) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [this.run, site],
      );
  }
  /** Reject a recreated topic before using any previous offset or deletion boundary. */
  async validateTopic() {
    if (!ROUND2) return;
    const expected = (
      await this.pool.query(
        'SELECT identity,partitions,routing_version FROM proto_topic WHERE run=$1 AND topic=$2',
        [this.run, this.inputTopic],
      )
    ).rows[0];
    assert.ok(expected, 'input topic has no registered identity');
    const actual = await topicIdentity(BROKER, this.inputTopic);
    assert.equal(actual, expected.identity, 'input topic identity changed');
    if (this.strictRouting) {
      assert.equal(expected.routing_version, ROUTING_VERSION, 'routing version changed');
      assert.equal(expected.partitions, PARTITIONS, 'registered partition count changed');
      const metadata = await this.admin.fetchTopicMetadata({ topics: [this.inputTopic] });
      assert.equal(
        metadata.topics[0]?.partitions.length,
        PARTITIONS,
        'broker partition count changed',
      );
    }
    this.inputTopicId = expected.identity;
  }
  /** Acknowledge durable input only; business confirmation is a separate step. */
  async enqueue(events: { event: Event; partition?: number }[]) {
    await this.validateTopic();
    if (this.strictRouting)
      for (const { event, partition } of events) {
        assert.ok(
          partition === undefined || partition === route(event),
          'producer partition mismatch',
        );
        assert.ok(
          event.routingVersion === undefined || event.routingVersion === ROUTING_VERSION,
          'producer routing version mismatch',
        );
      }
    const topicMessages = [
      {
        topic: this.inputTopic,
        messages: events.map(({ event, partition }) => ({
          partition: this.strictRouting
            ? route(event)
            : (partition ??
              Number.parseInt(digest([event.site, event.uuid ?? event.id]).slice(0, 8), 16) % 2),
          key: this.strictRouting ? routingKey(event) : `${event.site}:${event.uuid ?? event.id}`,
          value: JSON.stringify(
            this.strictRouting ? { ...event, routingVersion: ROUTING_VERSION } : event,
          ),
        })),
      },
    ];
    return this.producer.sendBatch({ acks: -1, topicMessages });
  }
  /** Capture exclusive high watermarks after validating the input topic identity. */
  async bounds(topic = this.inputTopic) {
    if (topic === this.inputTopic) await this.validateTopic();
    const offsets = await this.admin.fetchTopicOffsets(topic);
    return Object.fromEntries(offsets.map(p => [p.partition, Number(p.high)]));
  }
  // Bounded synthetic prototype reader. Production replaces this with range seeking/checkpoints.
  /** Read the finite protocol fixture; this deliberately does not model a production consumer. */
  async snapshot(
    topic = this.inputTopic,
  ): Promise<{ partition: number; offset: number; value: any }[]> {
    const high = await this.bounds(topic);
    if (Object.values(high).every(n => n === 0)) return [];
    assert.ok(
      Object.values(high).reduce((a, b) => a + b, 0) < 20000,
      'prototype snapshot bound exceeded',
    );
    const records: { partition: number; offset: number; value: any }[] = [];
    const done = new Set(
      Object.entries(high)
        .filter(([, n]) => n === 0)
        .map(([p]) => Number(p)),
    );
    const consumer = this.kafka.consumer({
      groupId: `${this.run}_read_${randomUUID()}`,
      allowAutoTopicCreation: false,
      readUncommitted: true,
      sessionTimeout: 10000,
    });
    let finish!: () => void;
    let fail!: (e: unknown) => void;
    const completed = new Promise<void>((res, rej) => {
      finish = res;
      fail = rej;
    });
    const timer = setTimeout(() => fail(new Error('bounded input read timed out')), 15000);
    consumer.on(consumer.events.CRASH, e => fail(e.payload.error));
    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: true });
      await consumer.run({
        autoCommit: false,
        eachBatchAutoResolve: false,
        eachBatch: async ({ batch, heartbeat }) => {
          for (const message of batch.messages) {
            const offset = Number(message.offset);
            if (offset < high[batch.partition]) {
              assert.ok(message.value, 'protocol record must have a payload');
              records.push({
                partition: batch.partition,
                offset,
                value: JSON.parse(message.value.toString()),
              });
            }
            if (offset + 1 >= high[batch.partition]) done.add(batch.partition);
          }
          await heartbeat();
          if (done.size === Object.keys(high).length) finish();
        },
      });
      await completed;
    } finally {
      clearTimeout(timer);
      await consumer.disconnect();
    }
    return records.sort((a, b) => a.partition - b.partition || a.offset - b.offset);
  }
  /** Acquire only assigned partitions; invalidate their unresolved attempts atomically. */
  async claim(partitions = [0, 1]) {
    assert.ok(partitions.length > 0 && partitions.every(p => p === 0 || p === 1));
    await this.validateTopic();
    return this.tx(async c => {
      const { rows } = await c.query(
        'UPDATE proto_partition SET generation=generation+1 WHERE run=$1 AND partition=ANY($2::int[]) RETURNING partition,generation',
        [this.run, partitions],
      );
      await c.query(
        "UPDATE proto_work SET status='pending',attempt=NULL WHERE run=$1 AND partition=ANY($2::int[]) AND status='working'",
        [this.run, partitions],
      );
      await c.query(
        "UPDATE proto_attempt SET status='aborted' WHERE run=$1 AND partition=ANY($2::int[]) AND status='intent'",
        [this.run, partitions],
      );
      return Object.fromEntries(
        rows.map((r: Row) => [r.partition, Number(r.generation)]),
      ) as Record<number, number>;
    });
  }
  /** Persist payload-free work references so unresolved input survives a process crash. */
  async discover(inputs: Input[]) {
    await this.tx(async c => {
      for (const input of inputs) {
        const invalid =
          this.strictRouting &&
          (input.event.routingVersion !== ROUTING_VERSION ||
            route(input.event) !== input.partition);
        await c.query(
          `INSERT INTO proto_work(run,partition,offset_id,site,session,identity_key,status)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [
            this.run,
            input.partition,
            input.offset,
            input.event.site,
            input.event.session,
            this.strictRouting ? routingKey(input.event) : (input.event.uuid ?? input.event.id),
            invalid ? 'quarantined' : 'pending',
          ],
        );
        if (invalid)
          await c.query('INSERT INTO proto_quarantine VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [
            this.run,
            input.partition,
            input.offset,
            input.event.routingVersion !== ROUTING_VERSION
              ? 'routing-version'
              : 'routing-partition',
          ]);
      }
      for (const partition of [0, 1]) {
        const offsets = inputs.filter(i => i.partition === partition).map(i => i.offset + 1);
        if (offsets.length)
          await c.query(
            'UPDATE proto_partition SET discovered=greatest(discovered,$3) WHERE run=$1 AND partition=$2',
            [this.run, partition, Math.max(...offsets)],
          );
      }
    });
  }
  /** Read the experiment site control record. */
  async site(site: string) {
    return (
      await this.pool.query('SELECT * FROM proto_site WHERE run=$1 AND site=$2', [this.run, site])
    ).rows[0];
  }
  /** Read active logical deletion boundaries for one experiment site. */
  async deletions(site: string) {
    return (
      await this.pool.query(
        "SELECT * FROM proto_delete WHERE run=$1 AND site=$2 AND status='active'",
        [this.run, site],
      )
    ).rows;
  }
  /** Apply the version-or-input-position deletion rule to a protocol row. */
  deleted(row: Row, deletions: Row[]) {
    return deletions.some(
      d =>
        (d.reset || d.session === row.session) &&
        (Number(row.version) < Number(d.version) ||
          Number(row.offset_id) < Number(d.boundary?.[row.partition] ?? -1)),
    );
  }
  /** Resolve only confirmed, current-epoch receipts that survive logical deletion. */
  async receipt(event: Event): Promise<Row | undefined> {
    const found = await this.rows(
      `SELECT * FROM liekan_ch_proto.landing
      WHERE run={run:String} AND site={site:String} AND identity_key={key:String} AND verdict='new'`,
      { run: this.run, site: event.site, key: event.uuid ?? event.id },
    );
    if (!found.length) return;
    const attempts = (
      await this.pool.query(
        "SELECT * FROM proto_attempt WHERE run=$1 AND id=ANY($2::text[]) AND status='confirmed'",
        [this.run, found.map(r => r.attempt)],
      )
    ).rows;
    const site = await this.site(event.site),
      deleted = await this.deletions(event.site);
    return found
      .map((r): Row => ({ ...r, version: attempts.find((a: Row) => a.id === r.attempt)?.version }))
      .find(
        r =>
          r.version !== undefined &&
          Number(r.epoch) === Number(site.epoch) &&
          !this.deleted(r, deleted),
      );
  }
  /** Capture immutable outcomes while the temporary migration channel is open. */
  async result(
    c: pg.PoolClient,
    op: string,
    site: string,
    version: number,
    kind: string,
    payload: any,
  ) {
    // Caller holds migration row and site row. Closing captures a complete terminal boundary.
    await c.query(
      `INSERT INTO proto_result(run,op,site,version,kind,payload)
      SELECT $1,$2,$3,$4,$5,$6::jsonb FROM proto_migration WHERE run=$1 AND state='capture'
      ON CONFLICT(run,op) DO NOTHING`,
      [this.run, op, site, version, kind, JSON.stringify(payload)],
    );
  }
  /** Land a candidate, then recheck ownership and site state before authoritative confirmation. */
  async process(
    owners: Record<number, number>,
    options: { afterLookup?: () => Promise<void>; asyncInsert?: boolean } = {},
  ) {
    const inputs = (await this.snapshot()).map(r => ({
      partition: r.partition,
      offset: r.offset,
      event: r.value as Event,
    }));
    await this.discover(inputs);
    const work = (
      await this.pool.query(
        "SELECT * FROM proto_work WHERE run=$1 AND status NOT IN ('decided','quarantined') ORDER BY partition,offset_id",
        [this.run],
      )
    ).rows;
    const blocked = new Set<string>();
    const groups: Input[][] = [];
    // Group adjacent same-session work for actual multi-row landing inserts.
    for (const w of work) {
      if (owners[Number(w.partition)] === undefined) continue;
      const input = inputs.find(
        i => i.partition === w.partition && i.offset === Number(w.offset_id),
      );
      assert.ok(input, 'unresolved durable reference missing from input topic');
      const last = groups.at(-1);
      if (
        last &&
        last[0].partition === input.partition &&
        last[0].event.site === input.event.site &&
        last[0].event.session === input.event.session
      )
        last.push(input);
      else groups.push([input]);
    }
    let confirmed = 0;
    for (const group of groups) {
      const { event, partition } = group[0],
        id = randomUUID();
      const keys = group.map(i => `${i.event.site}:${i.event.uuid ?? i.event.id}`);
      if (keys.some(k => blocked.has(k))) continue;
      const state = await this.tx(async c => {
        const partitionState = (
          await c.query('SELECT * FROM proto_partition WHERE run=$1 AND partition=$2 FOR UPDATE', [
            this.run,
            partition,
          ])
        ).rows[0];
        assert.equal(Number(partitionState.generation), owners[partition], 'owner fenced');
        const s = (
          await c.query('SELECT * FROM proto_site WHERE run=$1 AND site=$2 FOR UPDATE', [
            this.run,
            event.site,
          ])
        ).rows[0];
        const activeWork = await c.query(
          'SELECT status FROM proto_work WHERE run=$1 AND partition=$2 AND offset_id=ANY($3::bigint[]) FOR UPDATE',
          [this.run, partition, group.map(i => i.offset)],
        );
        if (activeWork.rows.some(r => r.status === 'decided')) return null;
        // The partition lock serializes this test-and-register step even inside one owner.
        if (
          this.strictRouting &&
          (
            await c.query(
              "SELECT 1 FROM proto_work WHERE run=$1 AND status='working' AND identity_key=ANY($2::text[]) LIMIT 1",
              [this.run, group.map(i => routingKey(i.event))],
            )
          ).rowCount
        )
          return null;
        const pending = await c.query(
          "SELECT 1 FROM proto_delete WHERE run=$1 AND site=$2 AND status='pending' AND (reset OR session=$3)",
          [this.run, event.site, event.session],
        );
        if (pending.rowCount) {
          for (const i of group)
            await c.query(
              "UPDATE proto_work SET status='deferred' WHERE run=$1 AND partition=$2 AND offset_id=$3",
              [this.run, partition, i.offset],
            );
          return null;
        }
        await c.query(
          `INSERT INTO proto_attempt(run,id,partition,generation,site,session,epoch,revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            this.run,
            id,
            partition,
            owners[partition],
            event.site,
            event.session,
            s.epoch,
            s.revision,
          ],
        );
        for (const i of group)
          await c.query(
            "UPDATE proto_work SET status='working',attempt=$4 WHERE run=$1 AND partition=$2 AND offset_id=$3",
            [this.run, partition, i.offset, id],
          );
        return s;
      });
      if (!state) {
        keys.forEach(k => {
          blocked.add(k);
        });
        continue;
      }
      const deleted = await this.deletions(event.site),
        local = new Map<string, Row>();
      const landing: Row[] = [];
      for (const i of group) {
        const e = i.event,
          key = e.uuid ?? e.id;
        const fingerprint = contentFingerprint(e);
        const receipt = local.get(key) ?? (await this.receipt(e));
        const receiptEvent = receipt ? (JSON.parse(receipt.payload) as Event) : undefined;
        const provenanceMatches =
          !receiptEvent ||
          ((e.source === undefined || receiptEvent.source === e.source) &&
            (e.scope === undefined || receiptEvent.scope === e.scope));
        let verdict = receipt
          ? receipt.fingerprint === fingerprint && provenanceMatches
            ? 'duplicate'
            : 'conflict'
          : 'new';
        if (
          this.deleted(
            {
              session: e.session,
              version: Number.MAX_SAFE_INTEGER,
              partition,
              offset_id: i.offset,
            },
            deleted,
          )
        )
          verdict = 'canceled';
        const row = {
          run: this.run,
          attempt: id,
          site: e.site,
          session: e.session,
          identity_key: key,
          event_id: e.id,
          partition,
          offset_id: i.offset,
          epoch: Number(state.epoch),
          fingerprint,
          verdict,
          original_id: receipt?.original_id ?? e.id,
          original_session: receipt?.original_session ?? e.session,
          original_visit: receipt?.original_visit ?? e.visit,
          payload: JSON.stringify(e),
        };
        landing.push(row);
        if (verdict === 'new') local.set(key, row);
      }
      // A duplicate can name a different current session; the original receipt's session
      // still participates in the deletion fence.
      const dependentSessions = [
        ...new Set([event.session, ...landing.map(r => r.original_session)]),
      ];
      const dependencyPending = await this.pool.query(
        "SELECT 1 FROM proto_delete WHERE run=$1 AND site=$2 AND status='pending' AND (reset OR session=ANY($3::text[]))",
        [this.run, event.site, dependentSessions],
      );
      if (dependencyPending.rowCount) {
        await this.tx(async c => {
          await c.query("UPDATE proto_attempt SET status='aborted' WHERE run=$1 AND id=$2", [
            this.run,
            id,
          ]);
          await c.query(
            "UPDATE proto_work SET status='deferred',attempt=NULL WHERE run=$1 AND attempt=$2",
            [this.run, id],
          );
        });
        keys.forEach(k => {
          blocked.add(k);
        });
        continue;
      }
      await options.afterLookup?.();
      await fault('after_lookup');
      await this.insert('landing', landing, options.asyncInsert);
      const actual = await this.rows(
        'SELECT * FROM liekan_ch_proto.landing WHERE run={run:String} AND attempt={attempt:String} ORDER BY offset_id',
        { run: this.run, attempt: id },
      );
      assert.equal(actual.length, landing.length, 'landing cardinality mismatch');
      assert.equal(
        digest(actual.map(r => [r.event_id, r.payload, r.fingerprint, r.verdict])),
        digest(landing.map(r => [r.event_id, r.payload, r.fingerprint, r.verdict])),
        'landing content mismatch',
      );
      await fault('after_landing');
      const accepted = await this.tx(async c => {
        await c.query('SELECT * FROM proto_migration WHERE run=$1 FOR UPDATE', [this.run]);
        const p = (
          await c.query('SELECT * FROM proto_partition WHERE run=$1 AND partition=$2 FOR UPDATE', [
            this.run,
            partition,
          ])
        ).rows[0];
        const s = (
          await c.query('SELECT * FROM proto_site WHERE run=$1 AND site=$2 FOR UPDATE', [
            this.run,
            event.site,
          ])
        ).rows[0];
        const pending = await c.query(
          "SELECT 1 FROM proto_delete WHERE run=$1 AND site=$2 AND status='pending' AND (reset OR session=ANY($3::text[]))",
          [this.run, event.site, dependentSessions],
        );
        const attempt = (
          await c.query('SELECT status FROM proto_attempt WHERE run=$1 AND id=$2', [this.run, id])
        ).rows[0];
        if (
          attempt?.status !== 'intent' ||
          (!this.strictRouting && s.version !== state.version) ||
          Number(p.generation) !== owners[partition] ||
          s.epoch !== state.epoch ||
          s.revision !== state.revision ||
          pending.rowCount
        ) {
          await c.query("UPDATE proto_attempt SET status='aborted' WHERE run=$1 AND id=$2", [
            this.run,
            id,
          ]);
          await c.query(
            "UPDATE proto_work SET status='pending',attempt=NULL WHERE run=$1 AND attempt=$2",
            [this.run, id],
          );
          return false;
        }
        const version = Number(
          (
            await c.query(
              'UPDATE proto_site SET version=version+1 WHERE run=$1 AND site=$2 RETURNING version',
              [this.run, event.site],
            )
          ).rows[0].version,
        );
        await c.query(
          "UPDATE proto_attempt SET status='confirmed',version=$3 WHERE run=$1 AND id=$2 AND status='intent'",
          [this.run, id, version],
        );
        await c.query("UPDATE proto_work SET status='decided' WHERE run=$1 AND attempt=$2", [
          this.run,
          id,
        ]);
        await this.result(
          c,
          id,
          event.site,
          version,
          'events',
          landing.map(r => ({
            ...JSON.parse(r.payload),
            verdict: r.verdict,
            original: r.original_id,
            originalSession: r.original_session,
            originalVisit: r.original_visit,
            partition,
            offset: Number(r.offset_id),
            version,
            epoch: Number(state.epoch),
          })),
        );
        return true;
      });
      if (accepted) confirmed += group.length;
      else
        keys.forEach(k => {
          blocked.add(k);
        });
      await fault('after_confirm');
    }
    return confirmed;
  }
  /** Build immutable candidates and atomically publish only a fully verified selection. */
  async derive(options: { failSite?: string; asyncInsert?: boolean } = {}) {
    const jobs = (
      await this.pool.query(
        "SELECT * FROM proto_attempt WHERE run=$1 AND status='confirmed' AND NOT published ORDER BY version",
        [this.run],
      )
    ).rows;
    for (const job of jobs) {
      const candidate = randomUUID();
      const inputs = await this.rows(
        "SELECT * FROM liekan_ch_proto.landing WHERE run={run:String} AND attempt={id:String} AND verdict='new'",
        { run: this.run, id: job.id },
      );
      const events = inputs.map(r => ({
        run: this.run,
        site: job.site,
        logical_attempt: job.id,
        candidate,
        event_id: r.event_id,
        session: r.session,
        version: Number(job.version),
        epoch: Number(job.epoch),
        partition: r.partition,
        offset_id: Number(r.offset_id),
        kind: JSON.parse(r.payload).kind,
        scope: JSON.parse(r.payload).scope ?? 'browser',
        policy_version: JSON.parse(r.payload).policyVersion ?? 1,
      }));
      await this.insert('events', events, options.asyncInsert);
      await fault('after_events');
      if (options.failSite === job.site) continue;
      await this.insert(
        'properties',
        inputs.flatMap(r =>
          Object.entries(JSON.parse(r.payload).properties).map(([name, value]) => ({
            run: this.run,
            site: job.site,
            candidate,
            event_id: r.event_id,
            name,
            value,
          })),
        ),
        options.asyncInsert,
      );
      await this.insert(
        'revenue',
        inputs.map(r => ({
          run: this.run,
          site: job.site,
          candidate,
          event_id: r.event_id,
          cents: JSON.parse(r.payload).cents,
        })),
        options.asyncInsert,
      );
      for (const table of ['events', 'properties', 'revenue']) {
        const count = Number(
          (
            await this.rows(
              `SELECT count() n FROM liekan_ch_proto.${table} WHERE run={run:String} AND candidate={candidate:String}`,
              { run: this.run, candidate },
            )
          )[0].n,
        );
        const expected =
          table === 'properties'
            ? inputs.reduce((n, r) => n + Object.keys(JSON.parse(r.payload).properties).length, 0)
            : inputs.length;
        assert.equal(count, expected, `derive ${table} mismatch`);
      }
      const base = await this.site(job.site),
        publication = randomUUID();
      // Full immutable snapshot is deliberately bounded for protocol tests, not a scale design.
      const selected = (
        await this.pool.query(
          'SELECT id,candidate FROM proto_attempt WHERE run=$1 AND site=$2 AND published',
          [this.run, job.site],
        )
      ).rows;
      const manifest = [...selected, { id: job.id, candidate }].map((r: Row) => ({
        run: this.run,
        site: job.site,
        publication,
        logical_attempt: r.id,
        candidate: r.candidate,
      }));
      await this.insert('manifest', manifest);
      assert.equal(
        Number(
          (
            await this.rows(
              'SELECT count() n FROM liekan_ch_proto.manifest WHERE run={run:String} AND publication={publication:String}',
              { run: this.run, publication },
            )
          )[0].n,
        ),
        manifest.length,
      );
      await fault('before_publish');
      await this.tx(async c => {
        const s = (
          await c.query('SELECT * FROM proto_site WHERE run=$1 AND site=$2 FOR UPDATE', [
            this.run,
            job.site,
          ])
        ).rows[0];
        if (s.publication !== base.publication || s.epoch !== job.epoch) return;
        const changed = await c.query(
          'UPDATE proto_attempt SET published=true,candidate=$3 WHERE run=$1 AND id=$2 AND NOT published',
          [this.run, job.id, candidate],
        );
        if (!changed.rowCount) return;
        await c.query('UPDATE proto_site SET publication=$3 WHERE run=$1 AND site=$2', [
          this.run,
          job.site,
          publication,
        ]);
      });
    }
  }
  /** Execute visibility and quality predicates inside CH over one PG control snapshot. */
  async visible(site: string, qualified = false) {
    const controls = await this.tx(async c => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const state = (
        await c.query('SELECT * FROM proto_site WHERE run=$1 AND site=$2', [this.run, site])
      ).rows[0];
      const deletions = (
        await c.query("SELECT * FROM proto_delete WHERE run=$1 AND site=$2 AND status='active'", [
          this.run,
          site,
        ])
      ).rows;
      return { state, deletions };
    });
    const boundaries = controls.deletions.flatMap(d =>
      Object.entries(d.boundary).map(([part, high]) => [
        d.session,
        Number(d.version),
        Number(part),
        Number(high),
        d.reset ? 1 : 0,
      ]),
    );
    return this.rows(
      `SELECT e.* FROM liekan_ch_proto.events e WHERE run={run:String} AND site={site:String}
      AND epoch={epoch:UInt64} AND (logical_attempt,candidate) IN (
        SELECT logical_attempt,candidate FROM liekan_ch_proto.manifest WHERE run={run:String} AND site={site:String} AND publication={pub:String})
      AND NOT arrayExists((ds,dv,dp,dh,dr) -> (dr=1 OR ds=e.session) AND (e.version < dv OR (e.partition=dp AND e.offset_id < dh)),
        {ds:Array(String)},{dv:Array(UInt64)},{dp:Array(UInt32)},{dh:Array(UInt64)},{dr:Array(UInt8)})
      AND ({qualified:UInt8}=0 OR (scope='browser' AND policy_version={policy:UInt32}))
      ORDER BY event_id`,
      {
        run: this.run,
        site,
        epoch: controls.state.epoch,
        pub: controls.state.publication,
        ds: boundaries.map(d => d[0]),
        dv: boundaries.map(d => d[1]),
        dp: boundaries.map(d => d[2]),
        dh: boundaries.map(d => d[3]),
        dr: boundaries.map(d => d[4]),
        qualified: qualified ? 1 : 0,
        policy: 1,
      },
    );
  }
  /** Check protocol fixture identities and related property/revenue rows. */
  async totals(site: string) {
    const visible = await this.visible(site);
    const revenue = await this.rows(
      'SELECT * FROM liekan_ch_proto.revenue WHERE run={run:String} AND site={site:String}',
      { run: this.run, site },
    );
    const properties = await this.rows(
      'SELECT * FROM liekan_ch_proto.properties WHERE run={run:String} AND site={site:String}',
      { run: this.run, site },
    );
    const keys = new Set(visible.map(r => `${r.candidate}:${r.event_id}`));
    return {
      ids: visible.map(r => r.event_id),
      cents: revenue
        .filter(r => keys.has(`${r.candidate}:${r.event_id}`))
        .reduce((n, r) => n + Number(r.cents), 0),
      properties: properties.filter(r => keys.has(`${r.candidate}:${r.event_id}`)).length,
    };
  }
  /** Persist a pending deletion barrier before sampling transport boundaries. */
  async beginDelete(site: string, session: string, id = randomUUID(), reset = false) {
    await this.validateTopic();
    await this.tx(async c => {
      await c.query('SELECT * FROM proto_migration WHERE run=$1 FOR UPDATE', [this.run]);
      const s = (
        await c.query('SELECT * FROM proto_site WHERE run=$1 AND site=$2 FOR UPDATE', [
          this.run,
          site,
        ])
      ).rows[0];
      const exists = await c.query('SELECT 1 FROM proto_delete WHERE run=$1 AND id=$2', [
        this.run,
        id,
      ]);
      if (exists.rowCount) return;
      await c.query(
        'UPDATE proto_site SET version=version+1,revision=revision+1 WHERE run=$1 AND site=$2',
        [this.run, site],
      );
      await c.query(
        'INSERT INTO proto_delete(run,id,site,session,version,reset,topic,topic_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          this.run,
          id,
          site,
          session,
          Number(s.version) + 1,
          reset,
          this.inputTopic,
          this.inputTopicId,
        ],
      );
    });
    return id;
  }
  /** Reuse a durable boundary and activate deletion under the site fence. */
  async activateDelete(id: string, boundary?: Record<string, number>) {
    await this.validateTopic();
    const previous = (
      await this.pool.query('SELECT * FROM proto_delete WHERE run=$1 AND id=$2', [this.run, id])
    ).rows[0];
    assert.ok(previous);
    if (previous.status === 'active') return previous.boundary;
    const sampled = previous.boundary ?? boundary ?? (await this.bounds());
    const high = (
      await this.pool.query(
        'UPDATE proto_delete SET boundary=coalesce(boundary,$3::jsonb) WHERE run=$1 AND id=$2 RETURNING boundary',
        [this.run, id, JSON.stringify(sampled)],
      )
    ).rows[0].boundary;
    await fault('after_delete_boundary');
    return this.tx(async c => {
      await c.query('SELECT * FROM proto_migration WHERE run=$1 FOR UPDATE', [this.run]);
      await c.query('SELECT * FROM proto_site WHERE run=$1 AND site=$2 FOR UPDATE', [
        this.run,
        previous.site,
      ]);
      const d = (
        await c.query('SELECT * FROM proto_delete WHERE run=$1 AND id=$2 FOR UPDATE', [
          this.run,
          id,
        ])
      ).rows[0];
      if (d.status === 'active') return d.boundary;
      await c.query("UPDATE proto_delete SET boundary=$3,status='active' WHERE run=$1 AND id=$2", [
        this.run,
        id,
        JSON.stringify(high),
      ]);
      await c.query(
        'UPDATE proto_site SET revision=revision+1,epoch=epoch+$3 WHERE run=$1 AND site=$2',
        [this.run, d.site, d.reset ? 1 : 0],
      );
      await this.result(c, id, d.site, Number(d.version), 'delete', { ...d, boundary: high });
      return high;
    });
  }
  /** Reject receipt reclamation while confirmed decisions still depend on it. */
  async gcLanding(attempt: string) {
    const state = (
      await this.pool.query('SELECT * FROM proto_attempt WHERE run=$1 AND id=$2', [
        this.run,
        attempt,
      ])
    ).rows[0];
    if (state?.status === 'confirmed') return { reclaimed: false, reason: 'receipt-lifetime' };
    await this.ch.command({
      query:
        'ALTER TABLE liekan_ch_proto.landing DELETE WHERE run={run:String} AND attempt={attempt:String}',
      query_params: { run: this.run, attempt },
      clickhouse_settings: { mutations_sync: '1' },
    });
    return { reclaimed: true };
  }
  /** Serialize migration senders with a connection-scoped advisory lock. */
  async senderLock<T>(fn: (c: pg.PoolClient) => Promise<T>) {
    const c = await this.pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`${this.run}:sender`]);
      return await fn(c);
    } finally {
      await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`${this.run}:sender`]);
      c.release();
    }
  }
  /** Send immutable results in site order; retries may repeat transport messages. */
  async relay(expectedGeneration?: number) {
    return this.senderLock(async c => {
      const migration = (await c.query('SELECT * FROM proto_migration WHERE run=$1', [this.run]))
        .rows[0];
      if (
        migration.state === 'closed' ||
        (expectedGeneration !== undefined && Number(migration.generation) !== expectedGeneration)
      )
        return 0;
      const pending = (
        await c.query(
          `SELECT r.* FROM proto_result r WHERE run=$1 AND NOT sent
        AND NOT EXISTS(SELECT 1 FROM proto_delete d WHERE d.run=r.run AND d.site=r.site AND d.status='pending')
        ORDER BY site,version,seq`,
          [this.run],
        )
      ).rows;
      for (const r of pending) {
        await fault('before_result_send');
        const sent = await this.producer.send({
          topic: this.resultTopic,
          acks: -1,
          messages: [
            {
              partition: 0,
              key: r.site,
              value: JSON.stringify({
                op: r.op,
                site: r.site,
                version: Number(r.version),
                kind: r.kind,
                payload: r.payload,
              }),
            },
          ],
        });
        await fault('after_result_send');
        await c.query(
          'UPDATE proto_result SET sent=true,transport_offset=$3 WHERE run=$1 AND op=$2',
          [this.run, r.op, sent[0].baseOffset],
        );
      }
      return pending.length;
    });
  }
  /** Apply each result operation once, preserving deletion semantics. */
  async applyShadow() {
    const stream = await this.snapshot(this.resultTopic);
    for (const { value: result } of stream) {
      await this.tx(async c => {
        const newOp = await c.query(
          'INSERT INTO proto_shadow_operation(run,op,site,version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING op',
          [this.run, result.op, result.site, result.version],
        );
        if (!newOp.rowCount) return;
        if (result.kind === 'events') {
          for (const e of result.payload)
            if (e.verdict === 'new') {
              const deletes = (
                await c.query('SELECT * FROM proto_shadow_delete WHERE run=$1 AND site=$2', [
                  this.run,
                  e.site,
                ])
              ).rows;
              if (!this.deleted({ ...e, offset_id: e.offset }, deletes))
                await c.query(
                  `INSERT INTO proto_shadow_fact
              (run,id,site,session,version,epoch,partition,offset_id,amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
                  [
                    this.run,
                    e.id,
                    e.site,
                    e.session,
                    e.version,
                    e.epoch,
                    e.partition,
                    e.offset,
                    e.cents,
                  ],
                );
            }
        } else {
          const d = result.payload;
          await c.query(
            'INSERT INTO proto_shadow_delete(run,id,site,session,version,boundary,reset) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
            [
              this.run,
              result.op,
              result.site,
              d.session,
              result.version,
              JSON.stringify(d.boundary),
              d.reset,
            ],
          );
          const facts = (
            await c.query('SELECT * FROM proto_shadow_fact WHERE run=$1 AND site=$2', [
              this.run,
              result.site,
            ])
          ).rows;
          for (const f of facts)
            if (this.deleted(f, [d]))
              await c.query('DELETE FROM proto_shadow_fact WHERE run=$1 AND id=$2', [
                this.run,
                f.id,
              ]);
        }
      });
    }
    return stream.length;
  }
  /** Seal result capture only after pending controls have resolved. */
  async beginClose() {
    return this.tx(async c => {
      const m = (await c.query('SELECT * FROM proto_migration WHERE run=$1 FOR UPDATE', [this.run]))
        .rows[0];
      if (m.state !== 'capture') return Number(m.generation);
      const pending = await c.query(
        "SELECT 1 FROM proto_delete WHERE run=$1 AND status='pending'",
        [this.run],
      );
      assert.equal(pending.rowCount, 0, 'pending control operations prevent migration seal');
      const generation = Number(m.generation) + 1;
      await c.query(
        "UPDATE proto_migration SET state='draining',generation=$2,terminal_seq=(SELECT coalesce(max(seq),0) FROM proto_result WHERE run=$1) WHERE run=$1",
        [this.run, generation],
      );
      return generation;
    });
  }
  /** Drain and seal before deleting the temporary result topic. */
  async finalizeClose() {
    return this.senderLock(async c => {
      const m = (await c.query('SELECT * FROM proto_migration WHERE run=$1', [this.run])).rows[0];
      if (m.state === 'closed') {
        await this.cleanupClosed(c);
        return;
      }
      assert.equal(m.state, 'draining');
      assert.equal(
        (await c.query('SELECT 1 FROM proto_result WHERE run=$1 AND NOT sent', [this.run]))
          .rowCount,
        0,
        'unsent outcomes',
      );
      assert.equal(
        (
          await c.query(
            'SELECT 1 FROM proto_result r WHERE run=$1 AND NOT EXISTS(SELECT 1 FROM proto_shadow_operation s WHERE s.run=r.run AND s.op=r.op)',
            [this.run],
          )
        ).rowCount,
        0,
        'unapplied outcomes',
      );
      const terminal = await this.bounds(this.resultTopic);
      // Persist closed before topic cleanup: recovery never recreates or resumes the sender.
      await c.query("UPDATE proto_migration SET state='closed',terminal_offsets=$2 WHERE run=$1", [
        this.run,
        JSON.stringify(terminal),
      ]);
      await fault('after_close_seal');
      await this.cleanupClosed(c);
    });
  }
  /** Idempotently clean a channel whose closed state is already durable. */
  async cleanupClosed(c?: pg.PoolClient): Promise<void> {
    if (!c) return this.senderLock(client => this.cleanupClosed(client));
    assert.equal(
      (await c.query('SELECT state FROM proto_migration WHERE run=$1', [this.run])).rows[0].state,
      'closed',
    );
    const topics = await this.admin.listTopics();
    if (topics.includes(this.resultTopic))
      await this.admin.deleteTopics({ topics: [this.resultTopic] });
    await c.query('DELETE FROM proto_result WHERE run=$1', [this.run]);
  }
}
