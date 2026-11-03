import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import {
  identifier,
  schemaDifferences,
  sourceCatalogSQL,
  sourceFingerprint,
  type ActualTable,
} from './catalog';

export type SnapshotDescriptor = {
  version: 1;
  snapshotId: string;
  database: string;
  archiveSHA256: string;
  sourceFingerprint: string;
  boundary: Record<string, unknown>;
};
export function snapshotDigest(value: SnapshotDescriptor) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Only call on a newly restored, operator-owned clone. Install a write fence
// as well as the database default: a normal connection can override read_only.
export async function sealMigrationClone(
  client: Client,
  archiveSHA256: string,
  boundary: Record<string, unknown>,
) {
  if (!/^[0-9a-f]{64}$/.test(archiveSHA256)) throw new Error('warehouse-snapshot-invalid-archive');
  const [{ database }] = (
    await client.query<{ database: string }>('SELECT current_database() AS database')
  ).rows;
  if (!/^liekan_snapshot_[a-z0-9_]+$/.test(database))
    throw new Error('warehouse-snapshot-not-owned-clone');
  const existing = await client.query("SELECT to_regclass('liekan_snapshot.manifest') AS table");
  if (existing.rows[0].table) {
    const row = (
      await client.query<{ descriptor: SnapshotDescriptor; digest: string }>(
        'SELECT descriptor,digest FROM liekan_snapshot.manifest',
      )
    ).rows[0];
    if (
      !row ||
      row.descriptor.archiveSHA256 !== archiveSHA256 ||
      JSON.stringify(row.descriptor.boundary) !== JSON.stringify(boundary)
    )
      throw new Error('warehouse-snapshot-manifest-conflict');
    // JSONB object order is not an identity; persist canonical descriptor text.
    return row;
  }
  const actual = (await client.query(sourceCatalogSQL)).rows as ActualTable[];
  const errors = schemaDifferences(actual);
  if (errors.length) throw new Error(`warehouse-source-schema-incompatible:${errors.join(';')}`);
  const descriptor: SnapshotDescriptor = {
    version: 1,
    snapshotId: randomUUID(),
    database,
    archiveSHA256,
    sourceFingerprint,
    boundary,
  };
  const digest = snapshotDigest(descriptor);
  await client.query('BEGIN');
  try {
    await client.query('CREATE SCHEMA liekan_snapshot');
    await client.query(
      `CREATE TABLE liekan_snapshot.manifest (id integer PRIMARY KEY CHECK(id=1), descriptor json NOT NULL,digest character(64) NOT NULL)`,
    );
    await client.query('INSERT INTO liekan_snapshot.manifest VALUES(1,$1::json,$2)', [
      JSON.stringify(descriptor),
      digest,
    ]);
    await client.query(`CREATE FUNCTION liekan_snapshot.reject_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'warehouse-source-clone-is-immutable' USING ERRCODE='25006'; END $$`);
    const tables = (
      await client.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      )
    ).rows;
    for (const table of tables)
      await client.query(`CREATE TRIGGER liekan_snapshot_write_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
      ON public.${identifier(table.name)} FOR EACH STATEMENT EXECUTE FUNCTION liekan_snapshot.reject_write()`);
    await client.query(
      'CREATE TRIGGER liekan_snapshot_write_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON liekan_snapshot.manifest FOR EACH STATEMENT EXECUTE FUNCTION liekan_snapshot.reject_write()',
    );
    await client.query(
      `ALTER DATABASE ${identifier(database)} SET default_transaction_read_only=on`,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return { descriptor, digest };
}
