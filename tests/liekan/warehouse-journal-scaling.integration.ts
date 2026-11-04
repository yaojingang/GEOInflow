// Real ClickHouse journal queries against a new, synthetic database only.
// No PG database, queue, container or existing installation is modified.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { ClickHouseClient } from '@clickhouse/client';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { WarehouseCompletion } from '../../src/lib/liekan/warehouse/completion';
import type { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import {
  LandingStore,
  type InputPosition,
  type Receipt,
} from '../../src/lib/liekan/warehouse/landing';
import { boundaryParameters, type ReadBoundary } from '../../src/lib/liekan/warehouse/read';
import { routingKey, type InputEnvelope } from '../../src/lib/liekan/warehouse/routing';
import { journalDDL } from '../../src/lib/liekan/warehouse/schema';
import { testClickHouseURL } from './warehouse-test-target';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const database = `warehouse_journal_scaling_${Date.now()}_${randomUUID().slice(0, 8)}`;
assert.match(database, /^warehouse_journal_scaling_\d+_[a-f0-9]{8}$/);
const admin = createWarehouseClient({ url: testClickHouseURL });
const ch = createWarehouseClient({
  url: testClickHouseURL,
  database,
  request_timeout: 60000,
  clickhouse_settings: {
    max_threads: 1,
    max_memory_usage: '536870912',
    max_execution_time: 50,
    log_queries: 1,
    log_queries_probability: 1,
    use_query_cache: 0,
  },
});
const site = randomUUID();
const topic = 'a'.repeat(32);
const epoch = '1';
const time = '2026-11-03 00:00:00.000000';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const boundary: ReadBoundary = {
  websiteId: site,
  epoch,
  publication: '300000',
  deletionRevision: '2',
};
const backgroundAttempts = 200000;
const queryIds = new Map<string, string[]>();
let measurement: string | undefined;
const measured = new Proxy(ch, {
  get(target, key) {
    if (key === 'query')
      return (options: Parameters<ClickHouseClient['query']>[0]) => {
        if (!measurement) return target.query(options);
        const queryId = `${database}_${measurement}_${randomUUID()}`;
        queryIds.set(measurement, [...(queryIds.get(measurement) ?? []), queryId]);
        return target.query({ ...options, query_id: queryId });
      };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const landing = new LandingStore(measured);
const report: any = {
  database,
  target: new URL(testClickHouseURL).port,
  synthetic: true,
  backgroundAttempts,
  postgres: 'not used; completion control reads use a fixed synthetic adapter',
  cases: [],
  metrics: {},
};

// Frozen pre-optimization SQL, intentionally not derived from the current query.
const oldReceiptSQL = `SELECT l.identity_key,l.payload_hash,l.original_session,l.original_visit,l.envelope,d.version
FROM warehouse_landing l INNER JOIN (
  SELECT attempt_id,max(version) AS version FROM warehouse_decision
  WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} GROUP BY attempt_id
) d ON d.attempt_id=l.attempt_id
WHERE l.website_id={wh_site:UUID} AND l.epoch={wh_epoch:UInt64}
  AND l.identity_key IN {keys:Array(String)} AND l.decision='new'
  AND NOT arrayExists(x -> (isNull(tupleElement(x,1)) OR tupleElement(x,1)=l.original_session)
    AND (d.version<tupleElement(x,2) OR (l.topic_id=tupleElement(x,3) AND arrayExists(
      p->tupleElement(p,1)=l.partition AND l.offset<tupleElement(p,2),arrayZip(tupleElement(x,4),tupleElement(x,5))))),
    (SELECT groupArray(tuple(session_id,version,topic_id,partitions,offsets)) FROM warehouse_deletion
      WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND revision<={wh_deletion:UInt64}))
ORDER BY d.version ASC LIMIT 1 BY l.identity_key`;
const oldCompletionSQL = `SELECT DISTINCT l.input_id,l.decision,l.original_session,l.original_visit,
arrayDistinct(arrayMap(f->JSONExtractString(f,'family'),JSONExtractArrayRaw(l.envelope,'facts'))) AS required,
p.families AS published
FROM warehouse_landing l INNER JOIN (
  SELECT attempt_id,max(version) AS version FROM warehouse_decision
  WHERE website_id={site:UUID} AND epoch={epoch:UInt64} GROUP BY attempt_id
) d ON d.attempt_id=l.attempt_id LEFT JOIN (
  SELECT attempt_id,groupUniqArray(family) AS families FROM warehouse_publication
  WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND publication<={publication:UInt64} GROUP BY attempt_id
) p ON p.attempt_id=l.attempt_id
WHERE l.website_id={site:UUID} AND l.epoch={epoch:UInt64} AND l.input_id IN {ids:Array(UUID)}`;

function input(n: number, client: number, session: number, offset: string): InputPosition {
  const envelope: InputEnvelope = {
    version: 1,
    routingVersion: 1,
    topicId: topic,
    inputId: id(100 + n),
    eventId: id(200 + n),
    websiteId: site,
    sessionId: id(session),
    visitId: id(300 + n),
    clientEventId: id(client),
    epoch,
    policyRevision: '0',
    kind: 'browser',
    fingerprint: 'b'.repeat(64),
    collectionSource: 'browser',
    collectionScope: 'browser',
    receivedAt: '2026-11-03T00:00:00.000Z',
    data: {},
  };
  return { partition: 0, offset, envelope };
}
const first = input(1, 401, 501, '10');
const reused = input(2, 401, 502, '30');
const latest = input(3, 401, 503, '50');
const historical = input(4, 402, 504, '0');
const complete = input(5, 403, 505, '70');
const unconfirmed = input(6, 404, 506, '80');

async function insertDecision(position: InputPosition, version: string, families: string[] = []) {
  const envelope = position.envelope;
  const attempt = randomUUID();
  const decision = {
    input: position,
    status: 'new',
    sessionId: envelope.sessionId,
    visitId: envelope.visitId,
    facts: families.map(family => ({ family, row: {} })),
  };
  await ch.insert({
    table: 'warehouse_landing',
    format: 'JSONEachRow',
    values: [
      {
        website_id: site,
        epoch,
        attempt_id: attempt,
        input_id: envelope.inputId,
        topic_id: topic,
        partition: 0,
        offset: position.offset,
        identity_key: routingKey(envelope),
        payload_hash: envelope.fingerprint,
        decision: 'new',
        original_session: envelope.sessionId,
        original_visit: envelope.visitId,
        envelope:
          position === historical
            ? JSON.stringify({
                kind: 'historical-receipt',
                migrationId: id(800),
                eventId: null,
                source: 'browser',
                scope: 'browser_unresolved',
              })
            : JSON.stringify(decision),
        received_at: time,
      },
    ],
  });
  if (position !== unconfirmed)
    await ch.insert({
      table: 'warehouse_decision',
      format: 'JSONEachRow',
      values: [
        {
          website_id: site,
          epoch,
          attempt_id: attempt,
          version,
          input_count: 1,
          digest: 'c'.repeat(64),
          confirmed_at: time,
        },
      ],
    });
  if (families.length)
    await ch.insert({
      table: 'warehouse_publication',
      format: 'JSONEachRow',
      values: families.map((family, index) => ({
        website_id: site,
        epoch,
        publication: String(70 + index),
        attempt_id: attempt,
        family,
        candidate_id: id(900 + index),
        row_count: '1',
        digest: 'd'.repeat(64),
        published_at: time,
      })),
    });
}
function normalizeReceipt(
  rows: (Omit<Receipt, 'source' | 'scope'> & { envelope: string })[],
): Receipt[] {
  return rows.map(({ envelope, ...row }) => {
    const parsed = JSON.parse(envelope);
    return {
      ...row,
      source:
        parsed.kind === 'historical-receipt'
          ? parsed.source
          : parsed.input.envelope.collectionSource,
      scope:
        parsed.kind === 'historical-receipt' ? parsed.scope : parsed.input.envelope.collectionScope,
    };
  });
}
const sorted = <T extends { identity_key: string }>(rows: T[]) =>
  rows.sort((a, b) => a.identity_key.localeCompare(b.identity_key));
async function measure<T>(name: string, work: () => Promise<T>): Promise<T> {
  assert.equal(measurement, undefined);
  measurement = name;
  try {
    return await work();
  } finally {
    measurement = undefined;
  }
}
async function metrics(name: string) {
  const ids = queryIds.get(name);
  assert.ok(ids?.length, `No measured queries for ${name}`);
  const rows = await (
    await admin.query({
      query: `SELECT query_id,read_rows,read_bytes,query_duration_ms,memory_usage FROM system.query_log
      WHERE query_id IN {ids:Array(String)} AND type='QueryFinish' ORDER BY query_id`,
      query_params: { ids },
      format: 'JSONEachRow',
    })
  ).json<{
    query_id: string;
    read_rows: string;
    read_bytes: string;
    query_duration_ms: string;
    memory_usage: string;
  }>();
  assert.equal(rows.length, ids.length, `Missing query_log finish rows for ${name}`);
  return {
    queries: rows.length,
    readRows: rows.reduce((n, r) => n + Number(r.read_rows), 0),
    detail: rows,
  };
}

let created = false;
let completion: WarehouseCompletion | undefined;
try {
  await admin.command({ query: `CREATE DATABASE "${database}"` });
  created = true;
  for (const statement of journalDDL) await ch.command({ query: statement });
  // Same site + epoch, so only the new identity/attempt predicate can exclude
  // this history. UUID distribution exercises real primary-index granules.
  await ch.command({
    query: `INSERT INTO warehouse_landing SELECT {site:UUID},1,generateUUIDv4(),generateUUIDv4(),
      {topic:String},toUInt32(0),number+1000,concat('unrelated-',leftPad(toString(number),12,'0')),
      repeat('a',64),'new',toNullable({session:UUID}),toNullable({visit:UUID}),
      '{"input":{"envelope":{"collectionSource":"browser","collectionScope":"browser"}},"facts":[]}',
      toDateTime64({time:String},6,'UTC') FROM numbers({rows:UInt64})`,
    query_params: { site, topic, session: id(997), visit: id(998), time, rows: backgroundAttempts },
  });
  await ch.command({
    query: `INSERT INTO warehouse_decision SELECT website_id,epoch,attempt_id,offset,toUInt32(1),repeat('c',64),received_at FROM warehouse_landing`,
  });
  await ch.command({
    query: `INSERT INTO warehouse_publication SELECT website_id,epoch,offset,attempt_id,'website_event',
      attempt_id,toUInt64(1),repeat('d',64),received_at FROM warehouse_landing`,
  });
  for (const [position, version] of [
    [first, '10'],
    [reused, '30'],
    [latest, '50'],
    [historical, '0'],
    [unconfirmed, '80'],
  ] as const)
    await insertDecision(position, version);
  await insertDecision(complete, '70', ['session', 'website_event', 'event_data', 'revenue']);
  // Mix requested and unrelated random attempts into the same parts. This
  // prevents min/max pruning of separate fixture parts from exaggerating the
  // improvement measured against the retained-journal baseline.
  for (const table of ['warehouse_landing', 'warehouse_decision', 'warehouse_publication'])
    await ch.command({ query: `OPTIMIZE TABLE ${table} FINAL` });
  await ch.insert({
    table: 'warehouse_deletion',
    format: 'JSONEachRow',
    values: [
      {
        website_id: site,
        epoch,
        revision: '1',
        operation_id: id(991),
        session_id: first.envelope.sessionId,
        version: '15',
        topic_id: topic,
        partitions: [0],
        offsets: ['20'],
        created_at: time,
      },
      {
        website_id: site,
        epoch,
        revision: '2',
        operation_id: id(992),
        session_id: reused.envelope.sessionId,
        version: '35',
        topic_id: topic,
        partitions: [0],
        offsets: ['40'],
        created_at: time,
      },
    ],
  });
  const keys = [first, historical, complete, unconfirmed].map(i => routingKey(i.envelope));
  const oldRows = normalizeReceipt(
    await measure('old_receipts', async () =>
      (
        await measured.query({
          query: oldReceiptSQL,
          query_params: { ...boundaryParameters(boundary), keys },
          format: 'JSONEachRow',
        })
      ).json<any>(),
    ),
  );
  const newRows = await measure('new_receipts', () => landing.receipts(boundary, keys));
  assert.deepEqual(sorted(newRows), sorted(oldRows));
  assert.equal(newRows.length, 3, 'Unconfirmed landing must not establish a receipt');
  assert.equal(
    newRows.find(r => r.identity_key === keys[0])?.original_session,
    latest.envelope.sessionId,
  );
  assert.equal(newRows.find(r => r.identity_key === keys[1])?.scope, 'browser_unresolved');
  for (const [revision, expected] of [
    ['0', first],
    ['1', reused],
    ['2', latest],
  ] as const) {
    const [receipt] = await landing.receipts({ ...boundary, deletionRevision: revision }, [
      keys[0],
    ]);
    assert.equal(receipt.original_session, expected.envelope.sessionId);
  }
  report.cases.push({
    name: 'Receipt results equal frozen old SQL; deletion revisions, UUID reuse, historical unknown scope and unconfirmed exclusion remain intact',
    status: 'pass',
  });

  // Request identity differs from its canonical stored receipt. A retry in an
  // older deletion's queue prefix must still be fenced after the UUID was reused.
  const beforeFirst = input(21, 401, 521, '19');
  const beforeSecond = input(22, 401, 522, '39');
  const afterBoth = input(23, 401, 523, '49');
  const deleted = await landing.deletedInputs(boundary, [beforeFirst, beforeSecond, afterBoth]);
  assert.deepEqual(
    [...deleted].sort(),
    [beforeFirst.envelope.inputId, beforeSecond.envelope.inputId].sort(),
  );
  const accepted = await landing.acceptedInputs(boundary, [latest, unconfirmed]);
  assert.equal(accepted.size, 1);
  assert.equal(accepted.get(latest.envelope.inputId)?.status, 'duplicate');
  const conflicting = structuredClone(latest);
  conflicting.envelope.fingerprint = 'f'.repeat(64);
  assert.equal(
    (await landing.acceptedInputs(boundary, [conflicting])).get(latest.envelope.inputId)?.status,
    'conflict',
  );
  report.cases.push({
    name: 'Deletion-before-receipt history and accepted-input replay/conflict semantics preserved',
    status: 'pass',
  });

  const oldComplete = await measure('old_completion', async () =>
    (
      await measured.query({
        query: oldCompletionSQL,
        query_params: {
          site,
          epoch,
          publication: boundary.publication,
          ids: [complete.envelope.inputId],
        },
        format: 'JSONEachRow',
      })
    ).json<any>(),
  );
  assert.equal(oldComplete.length, 1);
  assert.equal(oldComplete[0].required.length, 4);
  assert.ok(
    oldComplete[0].required.every((family: string) => oldComplete[0].published.includes(family)),
  );
  const control = {
    read: async (sql: string) => {
      if (sql.includes('FROM liekan_warehouse_site'))
        return [{ website_id: site, epoch, publication: boundary.publication, state: 'active' }];
      if (sql.includes('FROM liekan_warehouse_work')) return [];
      if (sql.includes('FROM liekan_warehouse_installation')) return [{ authority: 'clickhouse' }];
      throw new Error('Unexpected completion control query');
    },
  } as unknown as ControlDatabase;
  completion = new WarehouseCompletion(control, measured);
  const outcome = await measure('new_completion', () => completion.wait(complete.envelope, 55000));
  assert.deepEqual(outcome, {
    status: oldComplete[0].decision,
    sessionId: oldComplete[0].original_session,
    visitId: oldComplete[0].original_visit,
  });
  await completion.close();
  completion = undefined;
  report.cases.push({
    name: 'Actual completion polling returns the same complete multi-family package result as frozen old SQL',
    status: 'pass',
  });

  await admin.command({ query: 'SYSTEM FLUSH LOGS' });
  for (const name of ['old_receipts', 'new_receipts', 'old_completion', 'new_completion'])
    report.metrics[name] = await metrics(name);
  for (const [oldName, newName] of [
    ['old_receipts', 'new_receipts'],
    ['old_completion', 'new_completion'],
  ]) {
    const baseline = report.metrics[oldName].readRows;
    const optimized = report.metrics[newName].readRows;
    assert.ok(
      baseline >= backgroundAttempts,
      `${oldName} did not exercise the retained journal history`,
    );
    // Allow primary-index granules and repeated CTE scans, while requiring a
    // substantial real reduction rather than a timing-only/cache comparison.
    assert.ok(
      optimized < baseline * 0.4,
      `${newName} read ${optimized} rows vs ${baseline}: expected >60% reduction`,
    );
    report.metrics[newName].readRowRatio = optimized / baseline;
  }
  report.cases.push({
    name: 'Real query_log read_rows fall by more than 60% with 200000 unrelated accepted historical attempts',
    status: 'pass',
  });
} catch (error) {
  report.cases.push({
    status: 'failed',
    error: error instanceof Error ? error.message : 'unknown',
  });
  process.exitCode = 1;
} finally {
  for (const [name, cleanup] of [
    ['completion', async () => completion?.close()],
    ['query-client', async () => ch.close()],
    [
      'synthetic-database',
      async () => {
        if (created) await admin.command({ query: `DROP DATABASE "${database}"` });
      },
    ],
    ['admin-client', async () => admin.close()],
  ] as const) {
    try {
      await cleanup();
    } catch (error) {
      report.cases.push({
        status: 'failed',
        cleanup: name,
        error: error instanceof Error ? error.message : 'unknown',
      });
      process.exitCode = 1;
    }
  }
  await mkdir('.local/ch-final-review', { recursive: true });
  await writeFile(
    '.local/ch-final-review/journal-scaling-report.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
}
