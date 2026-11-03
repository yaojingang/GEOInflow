// Exercise real control SQL with cold planner statistics. Only connection-local
// temporary copies in the restored synthetic installation may be mutated.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { WarehouseControl } from '../../src/lib/liekan/warehouse/control';
import type { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';

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
  options: '-c statement_timeout=5000 -c lock_timeout=1000',
});
const db = {
  read: async (sql: string, values?: unknown[]) => (await c.query(sql, values)).rows,
  transaction: async (work: (tx: pg.Client) => Promise<unknown>) => {
    await c.query('BEGIN');
    try {
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  },
} as unknown as ControlDatabase;
const report: any = { cases: [], rows: 50000, temporaryTablesOnly: true };
try {
  await c.connect();
  const original = (await c.query('SELECT * FROM liekan_warehouse_installation WHERE id=1'))
    .rows[0];
  assert.equal(original.installation_id, recovery.initial.installation_id);
  for (const table of [
    'installation',
    'site',
    'partition',
    'attempt',
    'work',
    'barrier',
    'deletion',
  ])
    await c.query(
      `CREATE TEMP TABLE liekan_warehouse_${table} (LIKE public.liekan_warehouse_${table} INCLUDING ALL)`,
    );
  await c.query(
    'INSERT INTO liekan_warehouse_installation SELECT * FROM public.liekan_warehouse_installation',
  );
  const site = randomUUID(),
    ownerId = randomUUID(),
    topic = original.topic_id;
  await c.query('INSERT INTO liekan_warehouse_site(website_id) VALUES($1)', [site]);
  await c.query(
    `INSERT INTO liekan_warehouse_partition(topic_id,partition,owner_id,generation,lease_until)
    VALUES($1,0,$2,1,now()+interval '1 hour')`,
    [topic, ownerId],
  );
  const insert = (start: number, end: number) =>
    c.query(
      `INSERT INTO liekan_warehouse_work
    (topic_id,partition,offset_id,input_id,website_id,identity_key,status)
    SELECT $1,0,n,gen_random_uuid(),$2,'key-'||n,'pending' FROM generate_series($3::integer,$4::integer) n`,
      [topic, site, start, end],
    );
  await insert(0, 9999);
  await c.query("UPDATE liekan_warehouse_work SET status='confirmed'");
  await c.query('ANALYZE liekan_warehouse_work');
  await insert(10000, report.rows + 9999); // old statistics say there is no pending work
  const control = new WarehouseControl(db);
  const owner = { topicId: topic, partition: 0, ownerId, generation: '1' };
  const started = performance.now();
  assert.equal((await control.ready(owner)).length, 500);
  report.readyMs = performance.now() - started;
  const offsets = Array.from({ length: 100 }, (_, i) => String(report.rows + 9900 + i));
  const intentStart = performance.now();
  const intent = await control.intent(owner, site, offsets, 'a'.repeat(64));
  report.intentMs = performance.now() - intentStart;
  assert.equal(intent.input_count, 100);
  report.cases.push({
    name: 'Idle queue suddenly gains 50000 pending keys while statistics still show only completed work',
    status: 'pass',
  });
  // Earliest pending blocks later pending, and a working key blocks even an
  // earlier offset. Quarantined entries also preserve ordering.
  await c.query(
    `UPDATE liekan_warehouse_work SET identity_key='ordered' WHERE offset_id IN(10001,10002)`,
  );
  await c.query(
    `UPDATE liekan_warehouse_work SET identity_key='quarantined-key',status=CASE WHEN offset_id=10003 THEN 'quarantined' ELSE 'pending' END WHERE offset_id IN(10003,10004)`,
  );
  await c.query(`UPDATE liekan_warehouse_work SET identity_key=$1 WHERE offset_id=10005`, [
    `key-${report.rows + 9999}`,
  ]);
  const ready = await control.ready(owner, 10);
  assert.ok(ready.some(r => r.offset_id === '10001'));
  for (const offset of ['10002', '10003', '10004', '10005'])
    assert.ok(!ready.some(r => r.offset_id === offset));
  for (const offset of ['10002', '10004', '10005'])
    await assert.rejects(
      () => control.intent(owner, site, [offset], 'b'.repeat(64)),
      /warehouse-key-busy/,
    );
  await control.intent(owner, site, ['10001'], 'c'.repeat(64));
  report.cases.push({
    name: 'Pending, quarantined and working keys still block out-of-order decisions',
    status: 'pass',
  });
} catch (error) {
  report.cases.push({
    status: 'failed',
    error: error instanceof Error ? error.message : 'unknown',
  });
  process.exitCode = 1;
} finally {
  await c.end();
  await writeFile(`${directory}/work-cold-report.json`, JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
