import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { sqlStatements } from '../../scripts/liekan-sql-statements.mjs';
import { DEFAULT_DEMO_ID, seedOfficialDemo, readDemoManifest } from '../../scripts/liekan-demo.mjs';
import { demoSpecs, demoKinds } from '../../scripts/liekan-demo-format.mjs';

const target = process.env.LIEKAN_DEMO_TEST_DATABASE_URL;
assert(target, 'Set LIEKAN_DEMO_TEST_DATABASE_URL to an isolated local test database');
const url = new URL(target);
assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'Requires an isolated local database');
const schema = 'demo_test_' + randomUUID().replaceAll('-', '');
url.searchParams.set('schema', schema);
const client = new pg.Client({ connectionString: target });
const secret = randomBytes(32).toString('hex');
let passed = 0;
const test = async (name, work) => {
  await work();
  passed++;
  console.log('PASS', name);
};
const automatic = () =>
  new Promise((resolve, reject) => {
    const image = process.env.LIEKAN_DEMO_TEST_IMAGE;
    const containerUrl = new URL(url);
    containerUrl.hostname = 'host.docker.internal';
    const child = spawn(
      image ? 'docker' : process.execPath,
      image
        ? [
            'run',
            '--rm',
            '-e',
            'DATABASE_URL',
            '-e',
            'APP_SECRET',
            '-e',
            'CLICKHOUSE_URL',
            '-e',
            'CLOUD_MODE',
            image,
            'node',
            'scripts/liekan-seed-demo.mjs',
            '--automatic',
          ]
        : ['scripts/liekan-seed-demo.mjs', '--automatic'],
      {
        env: {
          ...process.env,
          DATABASE_URL: image ? containerUrl.toString() : url.toString(),
          APP_SECRET: secret,
          CLICKHOUSE_URL: '',
          CLOUD_MODE: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', b => {
      output += b;
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code =>
      code === 0 ? resolve(JSON.parse(output)) : reject(new Error('Automatic demo startup failed')),
    );
  });
try {
  await client.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  for (const path of ['prisma/migrations', 'db/liekan/migrations'])
    for (const file of (await readdir(path))
      .filter(f => (path.startsWith('prisma') ? /^\d/.test(f) : f.endsWith('.sql')))
      .sort()) {
      await client.query('BEGIN');
      for (const sql of sqlStatements(
        await readFile(
          `${path}/${file}${path.startsWith('prisma') ? '/migration.sql' : ''}`,
          'utf8',
        ),
      ))
        await client.query(sql);
      await client.query('COMMIT');
    }
  const users = () =>
    client.query('SELECT user_id,username,password,role,deleted_at FROM "user" ORDER BY user_id');
  await client.query('UPDATE "user" SET password=$1 WHERE role=\'admin\'', [
    'customized-test-credential',
  ]);
  const before = (await users()).rows;
  const manifest = await readDemoManifest();
  if (process.env.LIEKAN_DEMO_TEST_PREINITIALIZED) {
    const owner = before.find(row => row.role === 'admin').user_id;
    await client.query(
      'INSERT INTO website(website_id,name,domain,user_id,created_by) VALUES($1,$2,$3,$4,$4)',
      [DEFAULT_DEMO_ID, manifest.name, manifest.domain, owner],
    );
    await client.query('INSERT INTO liekan_setting(website_id,is_demo) VALUES($1,true)', [
      DEFAULT_DEMO_ID,
    ]);
    await client.query(
      'INSERT INTO liekan_analysis_site(website_id,archive_epoch,archive_complete,archive_checked_at,dashboard_seed_checked_at) VALUES($1,1,true,now(),now()) ON CONFLICT(website_id) DO UPDATE SET archive_epoch=1,archive_complete=true,archive_checked_at=now(),dashboard_seed_checked_at=now()',
      [DEFAULT_DEMO_ID],
    );
  }
  const start = Date.now();
  let initializedAt;
  await test('fresh automatic startup imports the complete official example', async () => {
    const results = await Promise.all([automatic(), automatic()]);
    assert.deepEqual(results.map(r => r.status).sort(), ['created', 'existing']);
    initializedAt = Date.now();
  });
  await test('all portable feature counts and administrator credentials match', async () => {
    for (const kind of demoKinds.filter(k => !demoSpecs[k].global)) {
      const { table } = demoSpecs[kind];
      assert.equal(
        Number(
          (
            await client.query(`SELECT count(*) FROM ${table} WHERE website_id=$1`, [
              DEFAULT_DEMO_ID,
            ])
          ).rows[0].count,
        ),
        manifest.counts[kind],
        kind,
      );
    }
    assert.deepEqual((await users()).rows, before);
    const stats = (
      await client.query(
        'SELECT count(*) FILTER(WHERE event_type=1)::int pv,count(*) FILTER(WHERE event_type=2)::int conversions,count(*) FILTER(WHERE event_type=5)::int performance,max(created_at) latest FROM website_event WHERE website_id=$1',
        [DEFAULT_DEMO_ID],
      )
    ).rows[0];
    assert.equal(stats.pv, manifest.pageviews);
    assert.equal(stats.conversions, manifest.conversionEvents);
    assert.equal(stats.performance, manifest.performanceEvents);
    // The source is shifted at import start; a full import may take several minutes.
    assert(stats.latest.getTime() >= start - 600000);
    assert(stats.latest.getTime() <= initializedAt - 300000);
  });
  await test('replay payloads and trusted property digests survive import', async () => {
    const row = (
      await client.query(
        'SELECT events,started_at,ended_at FROM session_replay WHERE website_id=$1 LIMIT 1',
        [DEFAULT_DEMO_ID],
      )
    ).rows[0];
    const events = JSON.parse(gunzipSync(row.events));
    assert.equal(events.length, 6);
    assert.equal(events[0].timestamp, row.started_at.getTime());
    assert.equal(events.at(-1).timestamp, row.ended_at.getTime());
    const proof = (
      await client.query(
        'SELECT count(*)::int total,count(*) FILTER(WHERE s.row_digest=liekan_session_data_digest(d))::int valid FROM session_data d JOIN liekan_session_data_source s USING(website_id,session_id,data_key) WHERE website_id=$1',
        [DEFAULT_DEMO_ID],
      )
    ).rows[0];
    assert(proof.total > 1000);
    assert.equal(proof.total, proof.valid);
  });
  await test('qualified browser counts preserve missing historical evidence', async () => {
    const row = (
      await client.query(
        `SELECT
         (SELECT count(*) FROM website_event WHERE website_id=$1 AND event_type=1)::int AS raw,
         (SELECT count(*) FROM liekan_effective_browser_event WHERE website_id=$1 AND event_type=1)::int AS qualified`,
        [DEFAULT_DEMO_ID],
      )
    ).rows[0];
    assert.equal(row.raw, manifest.pageviews);
    assert(row.qualified > 0);
    assert(row.qualified < row.raw);
  });
  await test('synthetic crawler history stays bound and background rebuild is queued', async () => {
    const row = (
      await client.query(
        `SELECT count(*)::int total FROM liekan_log l JOIN liekan_crawler_evidence e ON e.log_id=l.id AND e.website_id=l.website_id JOIN liekan_crawler_rule_version r ON r.website_id=e.website_id AND r.version=e.classification_version AND r.catalog_version=e.catalog_version JOIN liekan_crawler_registry_version c ON c.version=e.catalog_version WHERE l.website_id=$1 AND l.verification='verified_range'`,
        [DEFAULT_DEMO_ID],
      )
    ).rows[0];
    assert(row.total > 20000);
    const archive = (
      await client.query(
        'SELECT archive_epoch,archive_complete,dashboard_seed_checked_at FROM liekan_analysis_site WHERE website_id=$1',
        [DEFAULT_DEMO_ID],
      )
    ).rows[0];
    assert.equal(archive.archive_epoch, null);
    assert.equal(archive.archive_complete, false);
    assert.equal(archive.dashboard_seed_checked_at, null);
    assert.equal(
      (
        await client.query('SELECT mode FROM liekan_analysis_site WHERE website_id=$1', [
          DEFAULT_DEMO_ID,
        ])
      ).rows[0].mode,
      'live',
    );
    assert(
      Number(
        (
          await client.query(
            "SELECT count(*) FROM liekan_dashboard_dirty WHERE website_id=$1 AND bucket='-infinity'",
            [DEFAULT_DEMO_ID],
          )
        ).rows[0].count,
      ) >= 2,
    );
    assert.equal(
      Number(
        (
          await client.query(
            "SELECT count(*) FROM liekan_log_source WHERE website_id=$1 AND state<>'paused'",
            [DEFAULT_DEMO_ID],
          )
        ).rows[0].count,
      ),
      0,
    );
  });
  const pointer = (
    await client.query('SELECT version,revision FROM liekan_crawler_registry_current')
  ).rows;
  const revision = (
    await client.query('SELECT revision FROM liekan_analytics_revision WHERE resource_id=$1', [
      DEFAULT_DEMO_ID,
    ])
  ).rows;
  await test('repeat startup preserves dates, revisions and global catalog authority', async () => {
    assert.equal((await automatic()).status, 'existing');
    assert.deepEqual((await users()).rows, before);
    assert.deepEqual(
      (await client.query('SELECT version,revision FROM liekan_crawler_registry_current')).rows,
      pointer,
    );
    assert.deepEqual(
      (
        await client.query('SELECT revision FROM liekan_analytics_revision WHERE resource_id=$1', [
          DEFAULT_DEMO_ID,
        ])
      ).rows,
      revision,
    );
  });
  await test('customized example is preserved automatically and conflicts manually', async () => {
    await client.query("UPDATE website SET name='Custom example' WHERE website_id=$1", [
      DEFAULT_DEMO_ID,
    ]);
    assert.equal((await automatic()).status, 'customized');
    await assert.rejects(seedOfficialDemo(client, { schema, secret }), /其他网站/);
    await client.query('UPDATE website SET name=$2 WHERE website_id=$1', [
      DEFAULT_DEMO_ID,
      manifest.name,
    ]);
  });
  await test('soft deletion is durable across startup', async () => {
    await client.query('UPDATE website SET deleted_at=now() WHERE website_id=$1', [
      DEFAULT_DEMO_ID,
    ]);
    assert.equal((await automatic()).status, 'deleted');
    await client.query('UPDATE website SET deleted_at=NULL WHERE website_id=$1', [DEFAULT_DEMO_ID]);
  });
  await test('cleared example stays empty after startup', async () => {
    for (const kind of demoKinds.toReversed().filter(k => !demoSpecs[k].global))
      await client.query(`DELETE FROM ${demoSpecs[kind].table} WHERE website_id=$1`, [
        DEFAULT_DEMO_ID,
      ]);
    await client.query('DELETE FROM liekan_session_data_source WHERE website_id=$1', [
      DEFAULT_DEMO_ID,
    ]);
    assert.equal((await automatic()).status, 'cleared');
    assert.equal(
      Number(
        (
          await client.query('SELECT count(*) FROM website_event WHERE website_id=$1', [
            DEFAULT_DEMO_ID,
          ])
        ).rows[0].count,
      ),
      0,
    );
  });
  await test('hard deletion is durable through the retained revision', async () => {
    await client.query('DELETE FROM website WHERE website_id=$1', [DEFAULT_DEMO_ID]);
    assert.equal((await automatic()).status, 'deleted');
  });
  await test('startup preserves a deleted administrator', async () => {
    await client.query('DELETE FROM liekan_analytics_revision WHERE resource_id=$1', [
      DEFAULT_DEMO_ID,
    ]);
    await client.query('UPDATE "user" SET deleted_at=now()');
    assert.equal((await automatic()).status, 'no-administrator');
  });
  console.log(
    JSON.stringify({
      passed,
      seconds: (Date.now() - start) / 1000,
      records: Object.values(manifest.counts).reduce((a, b) => a + b, 0),
    }),
  );
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.end();
}
