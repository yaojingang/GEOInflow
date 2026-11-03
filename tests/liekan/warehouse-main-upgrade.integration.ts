import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import {
  previousSourceFingerprint,
  schemaDifferences,
  schemaFingerprint,
  sourceCatalogSQL,
  sourceFingerprint,
} from '../../src/lib/liekan/warehouse/catalog';
import { assertMigrationUpgrade } from '../../scripts/liekan-migration-upgrade-check.mjs';

// Never consult DATABASE_URL. Both targets are new databases on the isolated PG
// instance; the existing schema-only template is read and cloned, never upgraded.
assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const root = resolve('.');
const run = `warehouse_main_upgrade_${Date.now()}`;
const directory = resolve('.local/ch-main-integration', run);
await mkdir(directory, { recursive: true, mode: 0o700 });
let ledgerBackup: { source: string; sha256: string; file: string } | undefined;
if (process.env.WAREHOUSE_UPGRADE_LEDGER_SQL) {
  const source = await realpath(resolve(process.env.WAREHOUSE_UPGRADE_LEDGER_SQL));
  assert.ok(
    source.startsWith(`${await realpath(resolve('.local'))}/`),
    'ledger fixture must stay within .local',
  );
  const contents = await readFile(source);
  const file = resolve(directory, 'original-migration-ledger.sql');
  await writeFile(file, contents, { mode: 0o600 });
  ledgerBackup = { source, sha256: createHash('sha256').update(contents).digest('hex'), file };
}
const password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const connection = { host: '127.0.0.1', port: 25459, user: 'liekan_ch_proto', password };
const template = 'liekan_ch_catalog_20261103';
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' });
const readonlySource = () =>
  new pg.Client({
    ...connection,
    database: template,
    options: '-c default_transaction_read_only=on',
  });
let source = readonlySource();
const manifest: Record<string, string> = JSON.parse(
  await readFile('config/liekan/migrations.json', 'utf8'),
);
const mainFiles = [
  '057_storage_retention.sql',
  '058_storage_physical_measurements.sql',
  '059_completed_job_retention_guard.sql',
  '060_completed_job_policy_ownership.sql',
  '061_storage_candidate_queue_identity.sql',
  '062_dashboard_attempt_fingerprint.sql',
  '063_dashboard_import_dependencies.sql',
  '064_dashboard_metadata_dependencies.sql',
  '065_dashboard_semantic_metadata.sql',
  '066_foreground_analysis_reads.sql',
  '067_robots_management.sql',
  '068_optional_analytics_engine.sql',
  '069_report_fragments.sql',
  '070_analytics_input_summary.sql',
];
const baseFiles = Object.keys(manifest)
  .filter(name => Number(name.slice(0, 3)) <= 56)
  .sort();
const chFiles = Object.keys(manifest)
  .filter(name => !mainFiles.includes(name))
  .sort();
const allFiles = Object.keys(manifest).sort();
assert.equal(mainFiles.length, 14);
assert.equal(baseFiles.length, 63);
assert.equal(chFiles.length, 98);
assert.equal(allFiles.length, 112);
for (const name of allFiles) {
  const actual = createHash('sha256')
    .update(await readFile(resolve('db/liekan/migrations', name)))
    .digest('hex');
  assert.equal(actual, manifest[name], `immutable SQL ${name}`);
}

type LedgerRow = { name: string; checksum: string; appliedAt: string };
async function ledger(client: pg.Client): Promise<LedgerRow[]> {
  return (
    await client.query(
      `SELECT name,checksum,to_char(applied_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS "appliedAt" FROM liekan_migration ORDER BY name`,
    )
  ).rows;
}
const selectedManifest = (names: string[]) =>
  Object.fromEntries(names.map(name => [name, manifest[name]]));
async function candidate(label: string, files: string[]) {
  const cwd = resolve(directory, label);
  await mkdir(resolve(cwd, 'db/liekan/migrations'), { recursive: true });
  await mkdir(resolve(cwd, 'config/liekan'), { recursive: true });
  await copyFile(
    resolve(root, 'config/liekan/upstream.json'),
    resolve(cwd, 'config/liekan/upstream.json'),
  );
  await symlink(resolve(root, 'prisma'), resolve(cwd, 'prisma'), 'dir');
  for (const name of files)
    await copyFile(
      resolve(root, 'db/liekan/migrations', name),
      resolve(cwd, 'db/liekan/migrations', name),
    );
  return cwd;
}
async function restoreOriginalLedger(database: string, target: pg.Client, label: string) {
  assert.match(database, /^warehouse_main_upgrade_\d+_(main_first|ch_first)$/);
  const counts = (
    await target.query(
      'SELECT (SELECT count(*) FROM liekan_migration)::integer AS liekan,(SELECT count(*) FROM _prisma_migrations)::integer AS prisma',
    )
  ).rows[0];
  if (counts.liekan || counts.prisma) {
    assert.equal(counts.liekan, 63, 'partially populated fixture ledger must not be overwritten');
    assert.equal(counts.prisma, 26, 'partially populated upstream ledger must not be overwritten');
    return false;
  }
  assert.ok(
    ledgerBackup,
    'schema-only fixture requires WAREHOUSE_UPGRADE_LEDGER_SQL containing the original downloaded migration ledgers',
  );
  const log = await open(resolve(directory, `${label}-restore-ledger.log`), 'w', 0o600);
  try {
    const code = await new Promise<number>((done, reject) => {
      const child = spawn(
        '/opt/homebrew/opt/libpq/bin/psql',
        ['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', ledgerBackup.file],
        {
          env: {
            ...process.env,
            PGHOST: connection.host,
            PGPORT: String(connection.port),
            PGUSER: connection.user,
            PGDATABASE: database,
            PGPASSWORD: password,
          },
          stdio: ['ignore', log.fd, log.fd],
        },
      );
      child.once('error', reject);
      child.once('exit', done);
    });
    assert.equal(code, 0, `original ledger restore failed for ${label}; see private test log`);
  } finally {
    await log.close();
  }
  assert.equal(
    (await target.query('SELECT count(*)::integer AS n FROM _prisma_migrations')).rows[0].n,
    26,
  );
  return true;
}
async function migrate(database: string, cwd: string, label: string) {
  assert.match(database, /^warehouse_main_upgrade_\d+_(main_first|ch_first)$/);
  const url = new URL(`postgresql://127.0.0.1:25459/${database}`);
  url.username = connection.user;
  url.password = password;
  const log = await open(resolve(directory, `${label}.log`), 'w', 0o600);
  try {
    const code = await new Promise<number>((done, reject) => {
      const child = spawn(process.execPath, [resolve(root, 'scripts/liekan-migrate.mjs')], {
        cwd,
        env: {
          ...process.env,
          DATABASE_URL: url.toString(),
          DIRECT_DATABASE_URL: url.toString(),
          DATABASE_REPLICA_URL: '',
        },
        stdio: ['ignore', log.fd, log.fd],
      });
      child.once('error', reject);
      child.once('exit', done);
    });
    assert.equal(code, 0, `migration runner failed for ${label}; see private test log`);
  } finally {
    await log.close();
  }
}

const cases: unknown[] = [];
let sourceBefore: LedgerRow[];
let sourceShape: unknown;
try {
  await admin.connect();
  await source.connect();
  sourceBefore = await ledger(source);
  sourceShape = (await source.query(sourceCatalogSQL)).rows;
  assert.equal(
    schemaFingerprint(sourceShape as any),
    previousSourceFingerprint,
    'source template must remain at 056',
  );
  if (sourceBefore.length) assertMigrationUpgrade([], sourceBefore, selectedManifest(baseFiles));
  else
    assert.ok(
      ledgerBackup,
      'schema-only template has no data ledger; supply WAREHOUSE_UPGRADE_LEDGER_SQL',
    );
  // PostgreSQL template cloning requires all sessions on that database closed.
  await source.end();
  const main = await candidate('main070', [...baseFiles, ...mainFiles].sort());
  const ch = await candidate('ch98', chFiles);
  const full = await candidate('merged112', allFiles);
  for (const [order, first, firstFiles] of [
    ['main_first', main, [...baseFiles, ...mainFiles]],
    ['ch_first', ch, chFiles],
  ] as [string, string, string[]][]) {
    const database = `${run}_${order}`;
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
    const target = new pg.Client({ ...connection, database });
    await target.connect();
    try {
      const restoredOriginalLedger = await restoreOriginalLedger(database, target, order);
      const before = await ledger(target);
      assertMigrationUpgrade([], before, selectedManifest(baseFiles));
      const website = randomUUID();
      await target.query(
        "INSERT INTO website(website_id,name,domain) VALUES($1,'Preserved upgrade fixture','upgrade.invalid')",
        [website],
      );
      await migrate(database, first, `${order}-first`);
      const intermediate = await ledger(target);
      assertMigrationUpgrade(before, intermediate, selectedManifest(firstFiles));
      assert.equal(intermediate.length, order === 'main_first' ? 77 : 98);
      await migrate(database, first, `${order}-first-repeat`);
      assert.deepEqual(await ledger(target), intermediate);
      if (order === 'main_first')
        await target.query(
          "INSERT INTO liekan_robots_state(website_id,draft) VALUES($1,'User-agent: *')",
          [website],
        );
      await migrate(database, full, `${order}-complete`);
      const after = await ledger(target);
      assertMigrationUpgrade(intermediate, after, manifest);
      assert.equal(after.length, 112);
      const shape = (await target.query(sourceCatalogSQL)).rows;
      assert.equal(shape.length, 156);
      assert.deepEqual(schemaDifferences(shape), []);
      assert.equal(schemaFingerprint(shape), sourceFingerprint);
      for (const [table, column] of [
        ['liekan_analysis_generation', 'gc_started_at'],
        ['liekan_dashboard_snapshot', 'attempt_fingerprint'],
        ['liekan_analysis_query', 'fast_attempted_at'],
        ['liekan_analysis_query_consumer', 'managed'],
      ])
        assert.ok(
          shape.find(item => item.name === table)?.columns.some(item => item.name === column),
          `${table}.${column}`,
        );
      if (order === 'main_first')
        assert.equal(
          (
            await target.query('SELECT draft FROM liekan_robots_state WHERE website_id=$1', [
              website,
            ])
          ).rows[0].draft,
          'User-agent: *',
        );
      assert.equal(
        (await target.query('SELECT name FROM website WHERE website_id=$1', [website])).rows[0]
          .name,
        'Preserved upgrade fixture',
      );
      await migrate(database, full, `${order}-complete-repeat`);
      assert.deepEqual(await ledger(target), after);
      cases.push({
        order,
        database,
        stageCounts: [before.length, intermediate.length, after.length],
        schemaTables: shape.length,
        immutableLedger: true,
        restoredOriginalLedger,
        idempotent: true,
        status: 'pass',
      });
    } finally {
      await target.end();
    }
  }
  source = readonlySource();
  await source.connect();
  assert.deepEqual(await ledger(source), sourceBefore);
  assert.deepEqual((await source.query(sourceCatalogSQL)).rows, sourceShape);
  cases.push({ name: 'source template ledger and schema unchanged', status: 'pass' });
} catch (error) {
  process.exitCode = 1;
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
} finally {
  await Promise.allSettled([source.end(), admin.end()]);
  const report = {
    run,
    sourceLedgerRows: sourceBefore?.length,
    ledgerSource: ledgerBackup ? { path: ledgerBackup.source, sha256: ledgerBackup.sha256 } : null,
    cases,
    passed: !process.exitCode,
  };
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({ run, passed: report.passed, report: resolve(directory, 'result.json') }),
  );
}
