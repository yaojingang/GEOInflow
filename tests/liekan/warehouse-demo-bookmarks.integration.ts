import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { DemoFactMapping } from '../../src/lib/liekan/warehouse/demo-mapping';
import { writeDemoReplayBookmarkOwners } from '../../src/lib/liekan/warehouse/demo-bookmarks';
import type { DeletionOperation } from '../../src/lib/liekan/warehouse/deletions';

// Focused metadata/lifecycle regression. No CH service, queue, production facts
// or already-exited official demo is modified or retroactively repaired.
assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_demo_bookmarks_${Date.now()}`;
const directory = resolve('.local/ch-main-integration', run);
await mkdir(directory, { recursive: true, mode: 0o700 });
const password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const connection = { host: '127.0.0.1', port: 25459, user: 'liekan_ch_proto', password };
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' });
const url = new URL(`postgresql://127.0.0.1:25459/${run}`);
url.username = connection.user;
url.password = password;
process.env.DATABASE_URL = url.toString();
process.env.DATABASE_REPLICA_URL = '';
process.env.CLICKHOUSE_URL = '';
process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
process.env.APP_SECRET = 'isolated-demo-bookmark-test';
const db = new ControlDatabase(url.toString());
const cases: unknown[] = [];
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${run}" TEMPLATE liekan_ch_catalog_20261103`);
  for (const name of (await readdir('db/liekan/migrations'))
    .filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) >= 57)
    .sort()) {
    const sql = await readFile(`db/liekan/migrations/${name}`, 'utf8');
    await db.transaction(async tx => {
      await tx.query(sql);
      await tx.query('INSERT INTO liekan_migration(name,checksum) VALUES($1,$2)', [
        name,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    });
  }
  const site = randomUUID(),
    session = randomUUID(),
    other = randomUUID(),
    visit = randomUUID(),
    otherVisit = randomUUID();
  await db.transaction(async tx => {
    await tx.query(
      "INSERT INTO website(website_id,name,domain) VALUES($1,'Isolated demo bookmark regression','demo-bookmark.invalid')",
      [site],
    );
    await tx.query(
      'INSERT INTO liekan_warehouse_site(website_id) VALUES($1) ON CONFLICT DO NOTHING',
      [site],
    );
  });
  const anchor = Date.parse('2026-11-03T00:00:00Z');
  const mapping = new DemoFactMapping({ event: 0, log: 0 }, site, 'demo-bookmark.invalid', anchor);
  const replay = (session_id: string, visit_id: string, chunk_index = 0) => ({
    replay_id: randomUUID(),
    website_id: site,
    session_id,
    visit_id,
    chunk_index,
    event_count: 0,
    events: `\\x${gzipSync(Buffer.from('[]')).toString('hex')}`,
    started_at: new Date(anchor).toISOString(),
    ended_at: new Date(anchor).toISOString(),
    created_at: new Date(anchor).toISOString(),
  });
  mapping.facts('session_replay', {}, replay(session, visit));
  mapping.facts('session_replay', {}, replay(session, visit, 1));
  mapping.facts('session_replay', {}, replay(other, otherVisit));
  const bookmarks = [visit, otherVisit].map((visit_id, index) => ({
    saved_replay_id: randomUUID(),
    website_id: site,
    visit_id,
    name: `Isolated synthetic replay ${index}`,
    created_at: new Date(anchor).toISOString(),
    updated_at: null,
  }));
  const format = await import(pathToFileURL(resolve('scripts/liekan-demo-format.mjs')).href);
  const save = (rows: Record<string, unknown>[]) =>
    db.transaction(async tx => {
      // Same two calls and transaction boundary as seedWarehouseDemo.flushMetadata.
      await format.insertDemoBatch(tx, 'saved-replay', rows, { resume: true });
      await writeDemoReplayBookmarkOwners(tx, mapping, rows);
    });
  await save(bookmarks);
  await save(bookmarks);
  const owners = await db.read<any>(
    'SELECT * FROM liekan_warehouse_replay_bookmark_owner WHERE website_id=$1 ORDER BY saved_replay_id',
    [site],
  );
  assert.equal(owners.length, 2);
  assert.deepEqual(new Set(owners.map(row => row.session_id)), new Set([session, other]));
  cases.push({
    name: 'demo replay ownership is created atomically and resumable batches are idempotent',
    status: 'pass',
  });

  const missing = { ...bookmarks[0], saved_replay_id: randomUUID(), visit_id: randomUUID() };
  await assert.rejects(() => save([missing]), /warehouse-demo-replay-owner-missing/);
  assert.equal(
    (
      await db.read('SELECT 1 FROM session_replay_saved WHERE saved_replay_id=$1', [
        missing.saved_replay_id,
      ])
    ).length,
    0,
  );
  const changed = { ...bookmarks[0], visit_id: otherVisit };
  await assert.rejects(() => save([changed]), /warehouse-demo-bookmark-owner-conflict/);
  assert.deepEqual(
    await db.read(
      'SELECT * FROM liekan_warehouse_replay_bookmark_owner WHERE website_id=$1 ORDER BY saved_replay_id',
      [site],
    ),
    owners,
  );
  assert.throws(
    () => mapping.facts('session_replay', {}, replay(other, visit)),
    /warehouse-demo-replay-owner-ambiguous/,
  );
  cases.push({
    name: 'missing parent and conflicting ownership roll back the bookmark batch; ambiguous replay parents are rejected',
    status: 'pass',
  });

  const { warehouseLifecycleFinalizer } = await import(
    '../../src/lib/liekan/upstream/warehouse-lifecycle'
  );
  const operation = {
    operation_id: randomUUID(),
    website_id: site,
    session_id: session,
    kind: 'session',
    actor_id: null,
    epoch: '0',
    revision: '1',
    version: '0',
    topic_id: 'isolated',
    boundary: null,
    status: 'intent',
    owner_id: null,
    generation: '0',
    created_at: new Date(),
    authority: 'clickhouse',
  } as DeletionOperation;
  await db.transaction(async tx => {
    await warehouseLifecycleFinalizer.lock(tx, operation);
    await warehouseLifecycleFinalizer.apply(tx, operation);
  });
  assert.deepEqual(
    (
      await db.read<{ saved_replay_id: string }>(
        'SELECT saved_replay_id FROM session_replay_saved WHERE website_id=$1',
        [site],
      )
    ).map(row => row.saved_replay_id),
    [bookmarks[1].saved_replay_id],
  );
  const remaining = await db.read<any>(
    'SELECT saved_replay_id,session_id FROM liekan_warehouse_replay_bookmark_owner WHERE website_id=$1',
    [site],
  );
  assert.deepEqual(remaining, [
    { saved_replay_id: bookmarks[1].saved_replay_id, session_id: other },
  ]);
  assert.equal(
    (await db.read<{ n: string }>('SELECT count(*)::text AS n FROM session_replay'))[0].n,
    '0',
  );
  cases.push({
    name: 'real session-delete finalizer removes its demo bookmark and cascading owner while preserving the other session, with zero PG replay facts',
    status: 'pass',
  });
} catch (error) {
  process.exitCode = 1;
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
} finally {
  await Promise.allSettled([db.close(), admin.end()]);
  const report = {
    run,
    cases,
    passed: !process.exitCode,
    scope: 'isolated metadata writer and session-delete finalizer; no full demo re-import',
  };
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({ run, passed: report.passed, report: resolve(directory, 'result.json') }),
  );
}
