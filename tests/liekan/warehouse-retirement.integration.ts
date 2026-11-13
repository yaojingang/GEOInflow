// Read-only retirement inventory against the restored synthetic installation,
// with control states varied only in a new empty schema.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import type { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { warehouseRetirementPreview } from '../../src/lib/liekan/warehouse/retirement-preview';
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
const c = new pg.Client({
  host: '127.0.0.1',
  port: 25479,
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DB,
  options: '-c statement_timeout=5000',
});
const schema = `warehouse_retirement_${Date.now()}`;
const cases: object[] = [];
const db = {
  transaction: async (work: (tx: pg.Client) => Promise<unknown>) => {
    await c.query('BEGIN');
    try {
      const value = await work(c);
      assert.equal(
        (await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only,
        'on',
      );
      await c.query('COMMIT');
      return value;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  },
} as unknown as ControlDatabase;
try {
  await c.connect();
  assert.equal(
    (await c.query('SELECT installation_id FROM public.liekan_warehouse_installation WHERE id=1'))
      .rows[0].installation_id,
    recovery.initial.installation_id,
  );
  await c.query(`CREATE SCHEMA "${schema}"`);
  await c.query(`SET search_path TO "${schema}",public`);
  for (const name of ['installation', 'transition', 'transition_baseline', 'migration'])
    await c.query(
      `CREATE TABLE liekan_warehouse_${name} (LIKE public.liekan_warehouse_${name} INCLUDING ALL)`,
    );
  await c.query(
    'INSERT INTO liekan_warehouse_installation SELECT * FROM public.liekan_warehouse_installation',
  );
  const preview = await warehouseRetirementPreview(db);
  assert.equal(preview.status, 'ready-for-review');
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.deletionAuthorized, false);
  assert.equal(preview.databaseWrites, false);
  assert.equal(preview.candidates.length, 42);
  assert.ok(preview.candidates.every(t => t.present));
  assert.ok(
    !preview.candidates.some(t => ['user', 'website', 'liekan_ingest_batch'].includes(t.table)),
  );
  assert.ok(preview.preserveBusinessMetadata.includes('liekan_ingest_batch'));
  const logs = preview.candidates.find(t => t.table === 'liekan_log')!;
  assert.equal(logs.disposition, 'migrated-facts');
  assert.equal(
    logs.physicalBytes,
    (await c.query("SELECT pg_total_relation_size('public.liekan_log')::text AS bytes")).rows[0]
      .bytes,
  );
  assert.ok(logs.referencedBy.some(r => r.table === 'liekan_crawler_evidence'));
  cases.push({
    name: 'Read-only physical inventory includes indexes and FK dependencies, preserves business metadata, never authorizes deletion',
    status: 'pass',
  });
  await c.query(
    "UPDATE liekan_warehouse_installation SET authority='postgres',facts_fenced=false,identity_bound=false",
  );
  const blocked = await warehouseRetirementPreview(db);
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blocked.blockers, [
    'postgres-still-authoritative',
    'postgres-fact-writers-not-fenced',
    'warehouse-identity-not-bound',
  ]);
  assert.equal(blocked.deletionAuthorized, false);
  cases.push({
    name: 'An active PG authority or unfenced/unbound warehouse blocks retirement review',
    status: 'pass',
  });
  await c.query(
    "UPDATE liekan_warehouse_installation SET authority='clickhouse',facts_fenced=true,identity_bound=true",
  );
  const migration = randomUUID();
  await c.query(
    `INSERT INTO liekan_warehouse_migration(migration_id,source_identity,source_fingerprint,
      source_snapshot,transform_version,phase,verified_digest)
    VALUES($1,'isolated-preview',$2,'isolated-preview',7,'exited',$2)`,
    [migration, 'a'.repeat(64)],
  );
  await c.query(
    `INSERT INTO liekan_warehouse_transition(id,transition_id,migration_id,state,topic_name,topic_id)
      VALUES(1,$1,$2,'capturing','isolated-preview','isolated-preview')`,
    [randomUUID(), migration],
  );
  assert.deepEqual((await warehouseRetirementPreview(db)).blockers, [
    'transition-not-closed',
    'historical-migration-not-verified-and-exited',
  ]);
  await c.query("UPDATE liekan_warehouse_transition SET state='closed',terminal_sequence=0");
  assert.deepEqual((await warehouseRetirementPreview(db)).blockers, [
    'historical-migration-not-verified-and-exited',
  ]);
  await c.query(
    `INSERT INTO liekan_warehouse_transition_baseline(id,migration_id,sequence,source_snapshot,verified_digest,status)
      VALUES(1,$1,0,$2,$2,'ready')`,
    [migration, 'a'.repeat(64)],
  );
  assert.equal((await warehouseRetirementPreview(db)).status, 'ready-for-review');
  await c.query('UPDATE liekan_warehouse_transition_baseline SET migration_id=$1', [randomUUID()]);
  assert.deepEqual((await warehouseRetirementPreview(db)).blockers, [
    'historical-migration-not-verified-and-exited',
  ]);
  cases.push({
    name: 'Closed transition requires a verified and exited matching migration baseline',
    status: 'pass',
  });
} catch (e) {
  cases.push({ status: 'failed', error: e instanceof Error ? e.message : 'unknown' });
  process.exitCode = 1;
} finally {
  await c.end();
  await writeFile(
    `${directory}/retirement-report.json`,
    JSON.stringify({ schema, cases }, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ cases }));
}
