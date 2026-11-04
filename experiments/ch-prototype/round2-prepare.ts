import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { PROJECT, OUTPUT, ROUND2 } from './core.ts';

/** Freeze the completed restore and create a reader that cannot modify its tables. */
async function main() {
  assert.ok(ROUND2);
  const exec = promisify(execFile);
  const name = `${PROJECT}-pg-1`;
  const state = JSON.parse((await exec('docker', ['inspect', name])).stdout)[0];
  assert.equal(state.Config.Labels['com.docker.compose.project'], PROJECT);
  assert.ok(
    state.Mounts.some(
      (m: any) =>
        m.Type === 'bind' &&
        m.Destination === '/var/lib/postgresql/data' &&
        m.Source === `/var/tmp/${PROJECT}/source-pg-complete`,
    ),
  );
  const restore = JSON.parse(
    await readFile(resolve(OUTPUT, 'restore-command-evidence.json'), 'utf8'),
  );
  assert.equal(restore.project, PROJECT);
  assert.equal(restore.exitCode, 0, 'a complete pg_restore success record is required');
  assert.equal(restore.containerId, state.Id, 'restore belongs to a different clone');
  assert.equal(restore.database, 'liekan_source_round2');
  const backup = state.Mounts.find((m: any) => m.Destination === '/source-backup' && !m.RW);
  assert.ok(backup, 'read-only backup mount missing');
  assert.equal(
    restore.sha256,
    (await readFile(resolve(backup.Source, 'SHA256SUMS'), 'utf8')).split(/\s/)[0],
  );
  const password = (await readFile(resolve(OUTPUT, 'pg-password'), 'utf8')).trim();
  assert.match(password, /^[a-f0-9]{64}$/);
  const c = new pg.Client({
    host: '127.0.0.1',
    port: 25449,
    database: 'liekan_source_round2',
    user: 'liekan_ch_proto',
    password,
  });
  await c.connect();
  try {
    const loading = (
      await c.query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='pg_restore' AND state<>'idle'",
      )
    ).rows[0].n;
    assert.equal(loading, 0, 'restore still active');
    assert.ok((await c.query("SELECT to_regclass('public.website_event') ready")).rows[0].ready);
    // pg_dump does not carry planner statistics; collect them only in this isolated clone.
    await c.query('SET max_parallel_workers_per_gather=0');
    await c.query('ANALYZE');
    // Only this generated hex secret is interpolated; no user SQL or source values are evaluated.
    if (!(await c.query("SELECT 1 FROM pg_roles WHERE rolname='r2_reader'")).rowCount)
      await c.query(`CREATE ROLE r2_reader LOGIN PASSWORD '${password}'`);
    await c.query('GRANT CONNECT ON DATABASE liekan_source_round2 TO r2_reader');
    await c.query('GRANT USAGE ON SCHEMA public TO r2_reader');
    await c.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO r2_reader');
    await c.query('ALTER ROLE r2_reader SET default_transaction_read_only=on');
    await c.query('ALTER DATABASE liekan_source_round2 SET default_transaction_read_only=on');
    const evidence = (
      await c.query(`SELECT current_database() AS database,current_setting('server_version') AS version,
      pg_database_size(current_database())::text AS restored_bytes,
      (SELECT count(*) FROM pg_tables WHERE schemaname='public')::int AS tables`)
    ).rows[0];
    await writeFile(
      resolve(OUTPUT, 'restore-evidence.json'),
      JSON.stringify(
        {
          completed: new Date().toISOString(),
          project: PROJECT,
          backupSha256: (
            await readFile(
              resolve(
                state.Mounts.find((m: any) => m.Destination === '/source-backup' && !m.RW).Source,
                'SHA256SUMS',
              ),
              'utf8',
            )
          ).split(/\s/)[0],
          evidence,
          sourceUnmodified: true,
          readOnlyRole: 'r2_reader',
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log('Restored clone frozen; isolated read-only role installed.');
  } finally {
    await c.end();
  }
  const control = `${PROJECT}-control-1`;
  const controlState = JSON.parse((await exec('docker', ['inspect', control])).stdout)[0];
  assert.equal(controlState.Config.Labels['com.docker.compose.project'], PROJECT);
  for (const sql of ["ALTER SYSTEM SET max_wal_size='256MB'", 'SELECT pg_reload_conf()']) {
    await exec('docker', [
      'exec',
      control,
      'psql',
      '-U',
      'liekan_ch_proto',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-Atc',
      sql,
    ]);
  }
  for (const [key, value] of [
    ['write_caching_default', 'disabled'],
    ['auto_create_topics_enabled', 'false'],
  ]) {
    await exec('docker', [
      'exec',
      `${PROJECT}-redpanda-1`,
      'rpk',
      'cluster',
      'config',
      'set',
      key,
      value,
    ]);
  }
}
await main();
