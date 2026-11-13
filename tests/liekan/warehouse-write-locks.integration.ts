// Real PG row locks and incremental resource FK migration, in a new empty schema
// inside the explicitly isolated synthetic installation. No live rows are changed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { ClickHouseClient } from '@clickhouse/client';
import pg from 'pg';
import { WarehouseControl } from '../../src/lib/liekan/warehouse/control';
import type { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { manifestDigest, WarehousePublisher } from '../../src/lib/liekan/warehouse/publication';

assert.equal(process.env.WAREHOUSE_DOCKER_TEST, 'isolated-new-project');
const directory = '.local/ch-deploy-validation';
const recovery = JSON.parse(await readFile(`${directory}/recovery.json`, 'utf8'));
assert.ok(recovery.steps.verify?.passed);
const env = Object.fromEntries(
  (await readFile(`${directory}/private.env`, 'utf8'))
    .split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const n = l.indexOf('=');
      return [l.slice(0, n), l.slice(n + 1)];
    }),
);
const options = {
  host: '127.0.0.1',
  port: 25479,
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DB,
  options: '-c statement_timeout=5000 -c lock_timeout=1000',
};
const c = new pg.Client(options),
  other = new pg.Client(options);
const schema = `warehouse_write_locks_${Date.now()}`;
const report: any = { schema, cases: [] };
const db = {
  read: async (sql: string, values?: unknown[]) => (await c.query(sql, values)).rows,
  transaction: async (work: (tx: pg.Client) => Promise<unknown>) => {
    await c.query('BEGIN');
    try {
      const r = await work(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  },
} as unknown as ControlDatabase;
try {
  await c.connect();
  await other.connect();
  const original = (await c.query('SELECT * FROM public.liekan_warehouse_installation WHERE id=1'))
    .rows[0];
  assert.equal(original.installation_id, recovery.initial.installation_id);
  await c.query(`CREATE SCHEMA "${schema}"`);
  for (const client of [c, other]) await client.query(`SET search_path TO "${schema}", public`);
  const tables = [
    'website',
    'liekan_collection_diagnostic_state',
    'liekan_browser_risk_state',
    'liekan_analytics_revision',
    ...[
      'installation',
      'site',
      'partition',
      'attempt',
      'work',
      'barrier',
      'deletion',
      'publication',
      'candidate',
    ].map(n => `liekan_warehouse_${n}`),
  ];
  for (const table of tables)
    await c.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
  await c.query(
    `ALTER TABLE liekan_warehouse_work ADD FOREIGN KEY(website_id) REFERENCES liekan_warehouse_site(website_id)`,
  );
  await c.query(
    'ALTER TABLE liekan_collection_diagnostic_state ADD FOREIGN KEY(website_id) REFERENCES website(website_id)',
  );
  // Exercise 091 starting with the old FK, even if the host already applied it.
  await c.query(
    `ALTER TABLE liekan_warehouse_publication ADD CONSTRAINT liekan_warehouse_publication_website_id_fkey FOREIGN KEY(website_id) REFERENCES website(website_id)`,
  );
  await c.query(
    await readFile('db/liekan/migrations/091_warehouse_publication_resource.sql', 'utf8'),
  );
  await c.query(
    'INSERT INTO liekan_warehouse_installation SELECT * FROM public.liekan_warehouse_installation',
  );
  const site = randomUUID(),
    ownerId = randomUUID(),
    topic = original.topic_id;
  await c.query('INSERT INTO liekan_warehouse_site(website_id) VALUES($1)', [site]);
  await db.transaction(async tx => {
    await tx.query(await readFile('db/liekan/migrations/093_warehouse_claim_guard.sql', 'utf8'));
  });
  assert.deepEqual((await c.query('SELECT website_id FROM liekan_warehouse_claim_guard')).rows, [
    { website_id: site },
  ]);
  await c.query(
    `INSERT INTO liekan_warehouse_partition(topic_id,partition,owner_id,generation,lease_until) VALUES($1,0,$2,1,now()+interval '1 hour')`,
    [topic, ownerId],
  );
  const control = new WarehouseControl(db),
    owner = { topicId: topic, partition: 0, ownerId, generation: '1' };
  await other.query('BEGIN');
  // Upload/discovery FK checks retain this lock until their transaction ends.
  await other.query('SELECT 1 FROM liekan_warehouse_site WHERE website_id=$1 FOR KEY SHARE', [
    site,
  ]);
  await control.discover(
    owner,
    [
      {
        offset: '0',
        inputId: randomUUID(),
        websiteId: site,
        sessionId: null,
        identityKey: 'lock-probe',
      },
    ],
    '0',
  );
  const attempt = await control.intent(owner, site, ['0'], 'a'.repeat(64));
  const confirmed = await control.confirm(owner, attempt.attempt_id, 'a'.repeat(64));
  assert.equal(confirmed.version, '1');
  await other.query('ROLLBACK');
  report.cases.push({
    name: 'Discovery, decision and confirmation coexist with upload FK locks',
    status: 'pass',
  });
  await control.discover(
    owner,
    [
      {
        offset: '60001',
        inputId: randomUUID(),
        websiteId: site,
        sessionId: null,
        identityKey: 'claim-guard-probe',
      },
    ],
    '60001',
  );
  await other.query('BEGIN');
  try {
    await other.query('UPDATE liekan_warehouse_site SET version=version WHERE website_id=$1', [
      site,
    ]);
    const independent = await control.intent(owner, site, ['60001'], 'a'.repeat(64));
    assert.equal(independent.status, 'intent');
    await control.abort(owner, independent.attempt_id);
  } finally {
    await other.query('ROLLBACK');
  }
  report.cases.push({
    name: 'Incremental claim guard backfills existing sites and claims coexist with counter writes',
    status: 'pass',
  });
  await c.query('BEGIN');
  await c.query('SELECT 1 FROM liekan_warehouse_site WHERE website_id=$1 FOR NO KEY UPDATE', [
    site,
  ]);
  await assert.rejects(
    other.query(
      'SELECT 1 FROM liekan_warehouse_site WHERE website_id=$1 FOR NO KEY UPDATE NOWAIT',
      [site],
    ),
    (e: any) => e.code === '55P03',
  );
  await assert.rejects(
    other.query('SELECT 1 FROM liekan_warehouse_site WHERE website_id=$1 FOR UPDATE NOWAIT', [
      site,
    ]),
    (e: any) => e.code === '55P03',
  );
  await c.query('ROLLBACK');
  report.cases.push({
    name: 'Concurrent version writes and lifecycle exclusive locks remain mutually exclusive',
    status: 'pass',
  });
  await c.query(
    "INSERT INTO website(website_id,name,domain) VALUES($1,'Isolated lock fixture','locks.invalid')",
    [site],
  );
  const operation = randomUUID();
  const manifest = [
    {
      attemptId: attempt.attempt_id,
      family: 'session',
      candidateId: randomUUID(),
      rowCount: '1',
      digest: 'c'.repeat(64),
    },
  ];
  await c.query(
    `INSERT INTO liekan_warehouse_publication(operation_id,website_id,epoch,publication,manifest,manifest_digest,status) VALUES($1,$2,0,1,$3::jsonb,$4,'reserved')`,
    [operation, site, JSON.stringify(manifest), manifestDigest(manifest)],
  );
  await c.query('UPDATE liekan_warehouse_attempt SET effects=$2::jsonb WHERE attempt_id=$1', [
    attempt.attempt_id,
    JSON.stringify([{ kind: 'collection-state', diagnosticAt: new Date().toISOString() }]),
  ]);
  // This case isolates the real PG publication/effect transaction. CH transport
  // returns its matching manifest; full CH verification is tested by HTTP suites.
  const ch = {
    insert: async () => {},
    query: async () => ({
      json: async () =>
        manifest.map(e => ({
          attempt_id: e.attemptId,
          family: e.family,
          candidate_id: e.candidateId,
          row_count: e.rowCount,
          digest: e.digest,
        })),
    }),
  } as unknown as ClickHouseClient;
  const publisher = new WarehousePublisher(db, ch);
  const pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await other.query('BEGIN');
  await other.query('SELECT 1 FROM website WHERE website_id=$1 FOR UPDATE', [site]);
  const publishing = publisher.project(operation);
  publishing.catch(() => {});
  try {
    let blocked = false;
    for (let n = 0; n < 80; n++) {
      blocked = (await other.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid]))
        .rows[0].blocked;
      if (blocked) break;
      await delay(5);
    }
    assert.ok(blocked, 'The real publication transaction must wait for the held resource lock');
    // The writer can acquire control state while holding its business resource.
    // Old site-first publication instead held this row and formed a lock cycle.
    await other.query(
      'SELECT 1 FROM liekan_warehouse_site WHERE website_id=$1 FOR NO KEY UPDATE NOWAIT',
      [site],
    );
  } finally {
    await other.query('ROLLBACK');
    await publishing;
  }
  assert.equal(
    (
      await c.query('SELECT status FROM liekan_warehouse_publication WHERE operation_id=$1', [
        operation,
      ])
    ).rows[0].status,
    'published',
  );
  assert.equal(
    (await c.query('SELECT 1 FROM liekan_collection_diagnostic_state WHERE website_id=$1', [site]))
      .rowCount,
    1,
  );
  report.cases.push({
    name: 'Publication locks business resource before control state and commits its effects',
    status: 'pass',
  });
  for (const kind of ['link', 'pixel']) {
    const id = randomUUID();
    await c.query('INSERT INTO liekan_warehouse_site(website_id,resource_type) VALUES($1,$2)', [
      id,
      kind,
    ]);
    assert.equal(
      (await c.query('SELECT 1 FROM liekan_warehouse_claim_guard WHERE website_id=$1', [id]))
        .rowCount,
      1,
    );
    await c.query(
      `INSERT INTO liekan_warehouse_publication(operation_id,website_id,epoch,publication,manifest,manifest_digest,status) VALUES($1,$2,0,1,'[]',$3,'published')`,
      [randomUUID(), id, 'b'.repeat(64)],
    );
    assert.equal((await c.query('SELECT 1 FROM website WHERE website_id=$1', [id])).rowCount, 0);
    await c.query('DELETE FROM liekan_warehouse_site WHERE website_id=$1', [id]);
    assert.equal(
      (await c.query('SELECT 1 FROM liekan_warehouse_claim_guard WHERE website_id=$1', [id]))
        .rowCount,
      0,
    );
    assert.equal(
      (await c.query('SELECT 1 FROM liekan_warehouse_publication WHERE website_id=$1', [id]))
        .rowCount,
      0,
    );
  }
  report.cases.push({
    name: 'Incremental publication FK supports link/pixel resources and resource-owned cascade',
    status: 'pass',
  });
  // An idle queue has almost no active rows in the planner's statistics. A
  // subsequent upload must not make the identity guard scan all work once per
  // chosen key while holding the site's publication lock.
  await c.query('ALTER TABLE liekan_warehouse_work SET (autovacuum_enabled=false)');
  await c.query('ANALYZE liekan_warehouse_work');
  await c.query(
    `INSERT INTO liekan_warehouse_work(topic_id,partition,offset_id,input_id,website_id,identity_key,status)
    SELECT $1,0,n,gen_random_uuid(),$2,'bulk-key-'||n,'pending'
    FROM generate_series(1,50000) n`,
    [topic, site],
  );
  const bulkOffsets = Array.from({ length: 500 }, (_, i) => String(i + 1));
  const start = performance.now();
  const bulk = await control.intent(owner, site, bulkOffsets, 'd'.repeat(64));
  assert.equal(bulk.input_count, 500);
  report.cases.push({
    name: 'A 500-key intent after an idle queue survives 50000 newly pending keys under the real 5s statement limit',
    status: 'pass',
    elapsedMs: performance.now() - start,
  });
  // Conflict probes remain topic-wide, including work in another partition.
  await c.query(
    `INSERT INTO liekan_warehouse_work(topic_id,partition,offset_id,input_id,website_id,identity_key,status)
    VALUES($1,1,21000,gen_random_uuid(),$2,'bulk-key-501','working'),
      ($1,1,0,gen_random_uuid(),$2,'bulk-key-502','quarantined'),
      ($1,1,21001,gen_random_uuid(),$2,'bulk-key-503','pending'),
      ($1,1,1,gen_random_uuid(),$2,'bulk-key-504','confirmed'),
      ($1,1,2,gen_random_uuid(),$2,'bulk-key-505','cancelled')`,
    [topic, site],
  );
  await assert.rejects(
    () => control.intent(owner, site, ['501'], 'e'.repeat(64)),
    /warehouse-key-busy/,
  );
  await assert.rejects(
    () => control.intent(owner, site, ['502'], 'e'.repeat(64)),
    /warehouse-key-busy/,
  );
  const allowed = await control.intent(owner, site, ['505', '503', '504'], 'f'.repeat(64));
  assert.equal(allowed.input_count, 3);
  report.cases.push({
    name: 'Bulk key guard preserves cross-partition working, quarantine and offset ordering semantics',
    status: 'pass',
  });
} catch (error) {
  report.cases.push({
    status: 'failed',
    error: error instanceof Error ? error.message : 'unknown',
  });
  process.exitCode = 1;
} finally {
  await other.query('ROLLBACK').catch(() => {});
  await c.query('ROLLBACK').catch(() => {});
  await other.end();
  await c.end();
  await writeFile(`${directory}/write-locks-report.json`, JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
