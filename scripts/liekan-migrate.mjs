import { sqlStatements } from './liekan-sql-statements.mjs';
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { assertUpstreamMigrations, assertUpstreamSchema } from './liekan-schema-check.mjs';

const lockTimeoutSql = "SET LOCAL lock_timeout TO '2s'";
const importIndexMigration = '094_log_import_time_index.sql';
const importIndexName = 'liekan_import_website_imported_at_idx';
const indexBuildTimeoutMs = 900000;

const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function applyTransactionalMigrations(schema, migrations) {
  await client.$transaction(
    async tx => {
      await tx.$executeRawUnsafe(lockTimeoutSql);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(12800001)');
      await tx.$executeRawUnsafe(
        'CREATE TABLE IF NOT EXISTS liekan_migration (name text PRIMARY KEY, checksum varchar(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const name of migrations) {
        const sql = await readFile(resolve('db/liekan/migrations', name), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const applied = await tx.$queryRawUnsafe(
          'SELECT checksum FROM liekan_migration WHERE name=$1',
          name,
        );
        if (applied.length) {
          if (applied[0].checksum !== checksum)
            throw new Error(`Immutable migration checksum changed: ${name}`);
          continue;
        }
        for (const statement of sqlStatements(sql)) {
          await tx.$executeRawUnsafe(lockTimeoutSql);
          await tx.$executeRawUnsafe(statement);
        }
        await tx.$executeRawUnsafe(
          'INSERT INTO liekan_migration (name,checksum) VALUES ($1,$2)',
          name,
          checksum,
        );
        console.log(`Liekan migration applied: ${name}`);
      }
    },
    { timeout: 60000 },
  );
}

async function readImportIndex(connection) {
  const { rows } = await connection.query(
    `SELECT i.indisvalid AND i.indisready AND i.indislive AS valid,
       CASE WHEN i.indexrelid IS NOT NULL THEN
         i.indrelid=to_regclass('liekan_import') AND NOT i.indisunique
         AND a.amname='btree' AND i.indnatts=2 AND i.indnkeyatts=2
         AND i.indpred IS NULL AND i.indexprs IS NULL
         AND pg_get_indexdef(c.oid,1,true)='website_id'
         AND pg_get_indexdef(c.oid,2,true)='imported_at'
       END AS matches
     FROM pg_class c LEFT JOIN pg_index i ON i.indexrelid=c.oid
     LEFT JOIN pg_am a ON a.oid=c.relam
     WHERE c.oid=to_regclass($1)`,
    [importIndexName],
  );
  return rows[0];
}

async function applyImportIndex(schema) {
  const sql = await readFile(resolve('db/liekan/migrations', importIndexMigration), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const connection = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    lock_timeout: 10000,
    statement_timeout: indexBuildTimeoutMs,
  });
  await connection.connect();
  try {
    await connection.query("SELECT set_config('search_path', quote_ident($1), false)", [schema]);
    // Wait in autocommit, so another runner building concurrently can clear old snapshots.
    const deadline = Date.now() + indexBuildTimeoutMs;
    while (
      !(
        await connection.query(
          'SELECT pg_try_advisory_lock(hashtextextended($1,12800001)) AS locked',
          [importIndexMigration],
        )
      ).rows[0].locked
    ) {
      if (Date.now() >= deadline)
        throw new Error('Timed out waiting for the log import index migration');
      await delay(1000);
    }
    const {
      rows: [applied],
    } = await connection.query('SELECT checksum FROM liekan_migration WHERE name=$1', [
      importIndexMigration,
    ]);
    if (applied) {
      if (applied.checksum !== checksum)
        throw new Error(`Immutable migration checksum changed: ${importIndexMigration}`);
      return;
    }
    const index = await readImportIndex(connection);
    if (index && !index.matches) throw new Error(`Unexpected index definition: ${importIndexName}`);
    // A cancelled concurrent build can leave behind its own invalid index.
    if (index && !index.valid)
      await connection.query(`DROP INDEX CONCURRENTLY "${importIndexName}"`);
    if (!index?.valid) await connection.query(sql);
    const built = await readImportIndex(connection);
    if (!built?.valid || !built.matches)
      throw new Error(`Log import index is not ready: ${importIndexName}`);
    await connection.query('INSERT INTO liekan_migration (name,checksum) VALUES ($1,$2)', [
      importIndexMigration,
      checksum,
    ]);
    console.log(`Liekan migration applied: ${importIndexMigration}`);
  } finally {
    await connection.end();
  }
}

try {
  await assertUpstreamMigrations(client);
  await assertUpstreamSchema(client);
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid PostgreSQL schema');
  const migrations = (await readdir(resolve('db/liekan/migrations')))
    .filter(file => file.endsWith('.sql'))
    .sort();
  const indexAt = migrations.indexOf(importIndexMigration);
  await applyTransactionalMigrations(
    schema,
    indexAt < 0 ? migrations : migrations.slice(0, indexAt),
  );
  if (indexAt >= 0) {
    await applyImportIndex(schema);
    if (indexAt + 1 < migrations.length)
      await applyTransactionalMigrations(schema, migrations.slice(indexAt + 1));
  }
} finally {
  await client.$disconnect();
}
