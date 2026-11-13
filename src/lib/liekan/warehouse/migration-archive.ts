import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { identifier } from './catalog';
import { sealMigrationClone } from './migration-snapshot';

function connectionEnvironment(connection: string) {
  const url = new URL(connection);
  if (!['postgresql:', 'postgres:'].includes(url.protocol))
    throw new Error('warehouse-invalid-postgres-url');
  return {
    ...process.env,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get('sslmode') ?? 'prefer',
    PGAPPNAME: 'liekan-warehouse-snapshot',
    PGOPTIONS: '',
  };
}
async function command(
  binary: string,
  args: string[],
  connection: string,
  signal?: AbortSignal,
  files?: { input?: string; output?: string },
) {
  // Credentials go through the child environment, never argv or diagnostics.
  const input = files?.input ? await open(files.input, 'r') : null;
  const output = files?.output ? await open(files.output, 'wx', 0o600) : null;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, {
        env: connectionEnvironment(connection),
        stdio: [input?.fd ?? 'ignore', output?.fd ?? 'ignore', 'pipe'],
        signal,
      });
      child.stderr.resume();
      child.once('error', () => reject(new Error('warehouse-postgres-tool-unavailable')));
      child.once('close', code =>
        code === 0 ? resolve() : reject(new Error('warehouse-postgres-tool-failed')),
      );
    });
    await output?.sync();
  } finally {
    await input?.close();
    await output?.close();
  }
}
export async function archiveSHA256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function durableJSON(path: string, value: unknown) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

// Use an exported PG snapshot so data and the recorded control boundary describe
// the same instant. This dedicated export transaction is closed after pg_dump;
// backfill subsequently reads the durable clone, never this live transaction.
export async function exportMigrationArchive(options: {
  sourceURL: string;
  directory: string;
  pgDump?: string;
  signal?: AbortSignal;
}) {
  const directory = resolve(options.directory),
    id = randomUUID();
  const destination = join(directory, `snapshot_${id}`);
  await mkdir(destination, { mode: 0o700 });
  const archive = join(destination, 'source.dump');
  const client = new pg.Client({
    connectionString: options.sourceURL,
    application_name: 'liekan-snapshot-export',
  });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const [{ snapshot, wal, server }] = (
      await client.query<{ snapshot: string; wal: string; server: string }>(
        "SELECT pg_export_snapshot() AS snapshot,pg_current_wal_lsn()::text AS wal,current_setting('server_version_num') AS server",
      )
    ).rows;
    const hasControl = (
      await client.query("SELECT to_regclass('public.liekan_warehouse_installation') AS table")
    ).rows[0].table;
    const boundary: Record<string, unknown> = { snapshot, wal, server };
    if (hasControl) {
      const installation = (
        await client.query(
          'SELECT installation_id,topic_id,authority,transition,revision,identity_bound FROM liekan_warehouse_installation WHERE id=1',
        )
      ).rows[0];
      // Online capture is prepared/fenced by the transition coordinator. A
      // snapshot command by itself must not claim a live cutover boundary.
      if (installation && installation.authority !== 'frozen')
        throw new Error('warehouse-snapshot-authority-not-frozen');
      boundary.installation = installation ?? null;
      if (installation?.identity_bound) {
        const [controls] = (
          await client.query(
            `SELECT c.operation_id,c.status FROM liekan_warehouse_migration_business_control c JOIN liekan_warehouse_barrier b USING(operation_id)
          WHERE b.kind='snapshot' AND b.status='frozen' AND b.frozen_revision=$1 AND c.status='ready'`,
            [installation.revision],
          )
        ).rows;
        if (!controls) throw new Error('warehouse-migration-controls-not-ready');
        boundary.businessControls = controls;
      }
      if (
        (await client.query("SELECT to_regclass('public.liekan_warehouse_transition') AS table"))
          .rows[0].table
      ) {
        boundary.capture =
          (
            await client.query(
              'SELECT transition_id,state,sequence,topic_id,ch_sequence,pg_sequence FROM liekan_warehouse_transition WHERE id=1',
            )
          ).rows[0] ?? null;
      }
      boundary.partitions = (
        await client.query(
          'SELECT topic_id,partition,safe_offset FROM liekan_warehouse_partition ORDER BY topic_id,partition',
        )
      ).rows;
      boundary.sites = (
        await client.query(
          'SELECT website_id,epoch,version,publication,deletion_revision FROM liekan_warehouse_site ORDER BY website_id',
        )
      ).rows;
    } else boundary.mode = 'offline-backup';
    await command(
      options.pgDump ?? 'pg_dump',
      ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`],
      options.sourceURL,
      options.signal,
      { output: archive },
    );
    await chmod(archive, 0o600);
    await client.query('COMMIT');
    const sha256 = await archiveSHA256(archive);
    const manifest = { version: 1, archive: 'source.dump', sha256, boundary };
    await durableJSON(join(destination, 'archive.json'), manifest);
    return { ...manifest, directory: destination, archive };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

// Always creates a new database. A failed restore is preserved for diagnosis;
// no caller-supplied existing database is cleared or overwritten.
export async function restoreMigrationClone(options: {
  archive: string;
  expectedSHA256: string;
  adminURL: string;
  directory: string;
  boundary: Record<string, unknown>;
  pgRestore?: string;
  signal?: AbortSignal;
}) {
  const archive = resolve(options.archive);
  if ((await archiveSHA256(archive)) !== options.expectedSHA256)
    throw new Error('warehouse-archive-checksum-mismatch');
  const database = `liekan_snapshot_${randomUUID().replaceAll('-', '')}`;
  const destination = join(resolve(options.directory), database);
  await mkdir(destination, { mode: 0o700 });
  await durableJSON(join(destination, 'restore-intent.json'), {
    database,
    archiveSHA256: options.expectedSHA256,
  });
  const admin = new pg.Client({
    connectionString: options.adminURL,
    application_name: 'liekan-snapshot-create',
  });
  const cloneURL = new URL(options.adminURL);
  cloneURL.pathname = `/${database}`;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${identifier(database)} TEMPLATE template0`);
  } finally {
    await admin.end();
  }
  await command(
    options.pgRestore ?? 'pg_restore',
    ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', database],
    cloneURL.toString(),
    options.signal,
    { input: archive },
  );
  const clone = new pg.Client({
    connectionString: cloneURL.toString(),
    application_name: 'liekan-snapshot-seal',
  });
  await clone.connect();
  try {
    const sealed = await sealMigrationClone(clone, options.expectedSHA256, options.boundary);
    await durableJSON(join(destination, 'snapshot.json'), sealed);
    return { directory: destination, ...sealed };
  } finally {
    await clone.end();
  }
}
