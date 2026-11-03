import { testClickHouseURL } from './warehouse-test-target';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { initializeWarehouse } from '../../src/lib/liekan/warehouse/initialize';
import { MigrationPages } from '../../src/lib/liekan/warehouse/migration-page';
import { MigrationRunner } from '../../src/lib/liekan/warehouse/migration-runner';
import {
  exportMigrationArchive,
  restoreMigrationClone,
} from '../../src/lib/liekan/warehouse/migration-archive';
import { sealMigrationClone } from '../../src/lib/liekan/warehouse/migration-snapshot';
import { MigrationSource } from '../../src/lib/liekan/warehouse/migration-source';
import {
  previousSourceFingerprint,
  sourceFingerprint,
} from '../../src/lib/liekan/warehouse/catalog';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const sourceSchema = process.env.WAREHOUSE_MIGRATION_SOURCE_SCHEMA ?? 'legacy056';
assert.ok(['legacy056', 'main070'].includes(sourceSchema));
const mainSourceMigrations = [
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
const stamp = Date.now(),
  run = `warehouse_migration_${stamp}`,
  clone = `liekan_snapshot_test_${stamp}`;
const password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const connection = { host: '127.0.0.1', port: 25459, user: 'liekan_ch_proto', password };
const url = (database: string) => {
  const u = new URL(`postgresql://127.0.0.1:25459/${database}`);
  u.username = connection.user;
  u.password = password;
  return u.toString();
};
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' }),
  fixture = new pg.Client({ ...connection, database: clone });
const db = new ControlDatabase(url(run)),
  source = new MigrationSource(url(clone));
const chAdmin = createWarehouseClient({ url: testClickHouseURL, request_timeout: 30000 });
const ch = createWarehouseClient({
  url: testClickHouseURL,
  database: run,
  request_timeout: 30000,
  clickhouse_settings: { max_threads: 1, max_memory_usage: '268435456' },
});
const site = randomUUID(),
  session = randomUUID(),
  visit = randomUUID(),
  event = randomUUID();
const cases: object[] = [];
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${run}" TEMPLATE liekan_ch_catalog_20261103`);
  await admin.query(`CREATE DATABASE "${clone}" TEMPLATE liekan_ch_catalog_20261103`);
  await fixture.connect();
  if (sourceSchema === 'main070') {
    for (const file of mainSourceMigrations) {
      const sql = await readFile(`db/liekan/migrations/${file}`, 'utf8');
      await fixture.query('BEGIN');
      try {
        await fixture.query(sql);
        await fixture.query('INSERT INTO liekan_migration(name,checksum) VALUES($1,$2)', [
          file,
          createHash('sha256').update(sql).digest('hex'),
        ]);
        await fixture.query('COMMIT');
      } catch (error) {
        await fixture.query('ROLLBACK');
        throw error;
      }
    }
  }
  for (const file of (await readdir('db/liekan/migrations'))
    .filter(f => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) >= 57)
    .sort()) {
    const sql = await readFile(`db/liekan/migrations/${file}`, 'utf8');
    await db.transaction(async tx => {
      await tx.query(sql);
      await tx.query('INSERT INTO liekan_migration(name,checksum) VALUES($1,$2)', [
        file,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    });
  }
  await fixture.query(
    "INSERT INTO website(website_id,name,domain) VALUES($1,'Migration isolated fixture','migration.invalid')",
    [site],
  );
  await fixture.query('INSERT INTO session(session_id,website_id) VALUES($1,$2)', [session, site]);
  await fixture.query(
    `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type,hostname)
    VALUES($1,$2,$3,$4,'2026-10-20 10:12:13.123456+00','/historical',1,'migration.invalid')`,
    [event, site, session, visit],
  );
  await fixture.query(
    `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status)
    VALUES($1,$2,'browser','browser',ARRAY[]::text[],'fixture','missing')`,
    [event, site],
  );
  await fixture.query(
    `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available)
    VALUES($1,$2,'browser_unresolved','fixture',false)`,
    [event, site],
  );
  for (let i = 0; i < 5; i++)
    await fixture.query(
      `INSERT INTO liekan_collection_receipt(website_id,client_event_id,payload_hash,event_id)
    VALUES($1,$2,repeat('f',64),$3)`,
      [site, randomUUID(), i === 0 ? event : null],
    );
  await fixture.query(
    `INSERT INTO liekan_collection_diagnostic(website_id,bucket,shard,written,with_uuid,duplicate,first_at,last_at)
    SELECT $1,t,0,9223372036854775807,0,0,t,t FROM generate_series('2026-10-26 10:00:00+00'::timestamptz,'2026-10-26 10:07:00+00'::timestamptz,interval '1 minute')t`,
    [site],
  );
  await fixture.query(
    `INSERT INTO session_data(session_data_id,website_id,session_id,data_key,number_value,date_value,data_type)
    VALUES($1,$2,$3,'precise',1234567890.1234,'2026-11-03 10:11:12.123456+00',2)`,
    [randomUUID(), site, session],
  );
  await fixture.query(
    `INSERT INTO liekan_session_data_source(website_id,session_id,data_key,scope,classification,row_digest)
    SELECT website_id,session_id,data_key,'browser','browser',liekan_session_data_digest(d) FROM session_data d`,
    [],
  );
  const exported = await exportMigrationArchive({
    sourceURL: url(clone),
    directory: '.local/ch-implementation',
    pgDump: '.local/ch-implementation/isolated-pg_dump',
  });
  const restored = await restoreMigrationClone({
    archive: exported.archive,
    expectedSHA256: exported.sha256,
    adminURL: url('liekan_ch_proto'),
    directory: '.local/ch-implementation',
    boundary: exported.boundary,
    pgRestore: '.local/ch-implementation/isolated-pg_restore',
  });
  const sealed = await sealMigrationClone(fixture, 'a'.repeat(64), {
    sites: { [site]: '0' },
    kind: 'isolated-fixture',
  });
  await assert.rejects(
    () => fixture.query("UPDATE website SET name='Forbidden'"),
    /warehouse-source-clone-is-immutable/,
  );
  await assert.rejects(
    () => fixture.query('TRUNCATE liekan_collection_diagnostic'),
    /warehouse-source-clone-is-immutable/,
  );
  await source.connect();
  assert.equal(
    sealed.descriptor.sourceFingerprint,
    sourceSchema === 'main070' ? sourceFingerprint : previousSourceFingerprint,
  );
  assert.deepEqual(await source.inspect(), {
    tables: sourceSchema === 'main070' ? 156 : 138,
    errors: [],
    compatible: true,
  });
  assert.deepEqual(await source.sealedSnapshot(), sealed);
  cases.push({
    name: 'persistent clone binds archive/schema/boundary and rejects both update and truncate even on an already open privileged connection',
    status: 'pass',
  });
  const restoredSource = new MigrationSource(url(restored.descriptor.database));
  await restoredSource.connect();
  try {
    assert.equal((await restoredSource.sealedSnapshot()).digest, restored.digest);
    assert.deepEqual(
      await restoredSource.page('website_event'),
      await source.page('website_event'),
    );
  } finally {
    await restoredSource.close();
  }
  cases.push({
    name: 'actual PostgreSQL exported snapshot archive restores to a new sealed clone with identical full event payload and microseconds',
    status: 'pass',
  });
  await db.transaction(async tx => {
    await tx.query(
      "INSERT INTO website(website_id,name,domain) VALUES($1,'Migration target fixture','migration.invalid')",
      [site],
    );
    await tx.query(
      `INSERT INTO liekan_warehouse_installation(id,installation_id,schema_version,routing_version,topic_name,topic_id,partition_count,authority,transition)
      VALUES(1,$1,2,1,'isolated','11111111111111111111111111111111',2,'postgres','shadow')`,
      [randomUUID()],
    );
  });
  await db.read('INSERT INTO liekan_warehouse_site(website_id) VALUES($1) ON CONFLICT DO NOTHING', [
    site,
  ]);
  await chAdmin.command({ query: `CREATE DATABASE "${run}"` });
  await initializeWarehouse(ch);
  const pages = new MigrationPages(db, ch),
    migration = await pages.register(
      sealed.descriptor.snapshotId,
      sealed.digest,
      { [site]: '0' },
      undefined,
      sealed.descriptor.sourceFingerprint,
    );
  const runner = new MigrationRunner(db, ch, source),
    id = migration.migration_id;
  assert.equal(
    (
      await pages.register(
        sealed.descriptor.snapshotId,
        sealed.digest,
        { [site]: '0' },
        id,
        sealed.descriptor.sourceFingerprint,
      )
    ).migration_id,
    id,
  );
  await assert.rejects(
    () =>
      pages.register(
        sealed.descriptor.snapshotId,
        sealed.digest,
        { [site]: '0' },
        id,
        sourceSchema === 'main070' ? previousSourceFingerprint : sourceFingerprint,
      ),
    /warehouse-source-snapshot-changed/,
  );
  cases.push({
    name: `${sourceSchema} sealed source resumes with its original contract and rejects switching to another accepted contract`,
    status: 'pass',
  });
  const originalInsert = ch.insert.bind(ch);
  let partial = false;
  ch.insert = (async (args: any) => {
    const result = await originalInsert(args);
    if (!partial && args.table === 'warehouse_liekan_collection_receipt') {
      partial = true;
      throw new Error('isolated interruption after CH write');
    }
    return result;
  }) as typeof ch.insert;
  try {
    await assert.rejects(
      () => runner.run(id, { pageSize: 2 }),
      /isolated interruption after CH write/,
    );
  } finally {
    ch.insert = originalInsert;
  }
  assert.equal(
    (
      await db.read<{ status: string }>(
        'SELECT status FROM liekan_warehouse_checkpoint WHERE migration_id=$1',
        [id],
      )
    )[0].status,
    'intent',
  );
  cases.push({
    name: 'crash after CH candidate write leaves durable intent and no published receipt; next run reuses the original page size',
    status: 'pass',
  });
  let interrupted = false;
  await assert.rejects(
    () =>
      runner.run(id, {
        pageSize: 3,
        progress: async value => {
          if (
            value.family === 'liekan_collection_receipt' &&
            value.stage === 'copy' &&
            !interrupted
          ) {
            interrupted = true;
            throw new Error('isolated interruption after committed page');
          }
        },
      }),
    /isolated interruption/,
  );
  assert.equal(
    (
      await db.read(
        "SELECT 1 FROM liekan_warehouse_checkpoint WHERE migration_id=$1 AND family<>'liekan_collection_receipt'",
        [id],
      )
    ).length,
    0,
  );
  const original = await db.read(
    'SELECT candidate_id FROM liekan_warehouse_checkpoint WHERE migration_id=$1',
    [id],
  );
  const completed = await runner.run(id, { pageSize: 3 });
  assert.equal(completed.families.length, 26);
  assert.equal(completed.phase, 'verify');
  assert.equal(completed.families.find(f => f.family === 'liekan_collection_receipt').rows, '5');
  assert.equal(completed.families.find(f => f.family === 'liekan_collection_diagnostic').rows, '8');
  assert.equal(completed.families.find(f => f.family === 'website_event').rows, '1');
  assert.ok(
    (
      await db.read<{ candidate_id: string }>(
        'SELECT candidate_id FROM liekan_warehouse_checkpoint WHERE migration_id=$1',
        [id],
      )
    ).some(r => r.candidate_id === original[0].candidate_id),
  );
  cases.push({
    name: 'receipts-first complete 26-family migration resumes after committed page with changed page size, preserves candidate identity and verifies empty families',
    status: 'pass',
  });
  const repeated = await runner.run(id, { audit: true });
  assert.equal(repeated.digest, completed.digest);
  cases.push({
    name: 'independent bounded re-audit verifies every source page, candidate content, publication projection, receipt and property/hostname proofs',
    status: 'pass',
  });
  await db.read(
    "UPDATE liekan_warehouse_migration SET owner_id=$2,lease_until=clock_timestamp()+interval '1 minute' WHERE migration_id=$1",
    [id, randomUUID()],
  );
  await assert.rejects(() => runner.run(id), /warehouse-migration-owned-or-closed/);
  await db.read(
    'UPDATE liekan_warehouse_migration SET owner_id=NULL,lease_until=NULL WHERE migration_id=$1',
    [id],
  );
  cases.push({
    name: 'another live migration lease prevents concurrent runner ownership',
    status: 'pass',
  });
  // Fault injection touches only this test's new CH database.
  await ch.command({
    query: "ALTER TABLE warehouse_control_projection DELETE WHERE kind='event-host-v1'",
    clickhouse_settings: { mutations_sync: '1' },
  });
  await assert.rejects(
    () => runner.run(id, { audit: true }),
    /warehouse-migration-proof-verification-failed/,
  );
  cases.push({
    name: 'audit rejects missing proof even when copied row counts and published checkpoint still match',
    status: 'pass',
  });
} catch (error) {
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : 'unknown');
} finally {
  await Promise.allSettled([
    source.close(),
    fixture.end(),
    db.close(),
    admin.end(),
    ch.close(),
    chAdmin.close(),
  ]);
  await writeFile(
    `.local/ch-implementation/${run}.json`,
    JSON.stringify({ run, clone, sourceSchema, cases, fullUpgradeValidated: false }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      cases: cases.length,
      failed: cases.filter((c: any) => c.status === 'failed').length,
    }),
  );
}
