import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createWarehouseClient } from '../src/lib/liekan/warehouse/client';
import { ControlDatabase } from '../src/lib/liekan/warehouse/control-db';
import { initializeWarehouse } from '../src/lib/liekan/warehouse/initialize';
import {
  exportMigrationArchive,
  restoreMigrationClone,
} from '../src/lib/liekan/warehouse/migration-archive';
import { MigrationPages } from '../src/lib/liekan/warehouse/migration-page';
import { MigrationRunner } from '../src/lib/liekan/warehouse/migration-runner';
import { MigrationSource } from '../src/lib/liekan/warehouse/migration-source';
import { establishTransitionBaseline } from '../src/lib/liekan/warehouse/transition-baseline';
import { installWarehouse } from '../src/lib/liekan/warehouse/installation';
import { WarehouseRuntime, warehouseRuntimeConfig } from '../src/lib/liekan/warehouse/runtime';
import { TransitionCapture } from '../src/lib/liekan/warehouse/transition-capture';
import { TransitionCoordinator } from '../src/lib/liekan/warehouse/transition-coordinator';
import { TransitionService } from '../src/lib/liekan/warehouse/transition-service';
import { verifyBoundWarehouse } from '../src/lib/liekan/warehouse/installation-identity';
import { seedWarehouseDemo } from '../src/lib/liekan/warehouse/demo';
import { warehouseMonitor } from '../src/lib/liekan/warehouse/monitor';
import { WarehouseRecoveryGC } from '../src/lib/liekan/warehouse/recovery-gc';
import { migrationIOFailure } from '../src/lib/liekan/warehouse/migration-retry';
import { warehouseRetirementPreview } from '../src/lib/liekan/warehouse/retirement-preview';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`warehouse-required-environment:${name}`);
  return value;
}
function argument(name: string) {
  const position = process.argv.indexOf(`--${name}`);
  if (position < 0 || !process.argv[position + 1] || process.argv[position + 1].startsWith('--'))
    throw new Error(`warehouse-required-argument:${name}`);
  return process.argv[position + 1];
}
function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
const signal = new AbortController();
process.once('SIGINT', () => signal.abort());
process.once('SIGTERM', () => signal.abort());
let db: ControlDatabase,
  source: MigrationSource,
  ch: ReturnType<typeof createWarehouseClient>,
  runtime: WarehouseRuntime,
  replication: TransitionService;
try {
  const command = process.argv[2];
  if (!command || ['help', '--help', '-h'].includes(command)) {
    print({
      commands: [
        'schema',
        'seed-demo',
        'install --mode fresh|pg-transition',
        'preflight',
        'snapshot-export --directory PATH',
        'snapshot-restore --archive PATH --sha256 SHA --directory PATH --boundary PATH',
        'register',
        'backfill --migration UUID',
        'verify --migration UUID',
        'baseline --migration UUID',
        'status --migration UUID',
        'barrier --kind snapshot|cutover|rollback --operation UUID',
        'freeze --operation UUID',
        'resume-snapshot --operation UUID',
        'switch --operation UUID',
        'cancel-barrier --operation UUID',
        'sync',
        'transition-status',
        'exit-begin',
        'exit-complete',
        'reclaim',
        'monitor',
        'retirement-preview',
      ],
      note: 'Credentials and target services are read from environment. Backfill requires a sealed immutable clone. Barrier and switch commands change authority only after durable checks; use stable operation UUIDs to resume. No command drops source data.',
    });
  } else if (command === 'retirement-preview') {
    db = new ControlDatabase(required('DATABASE_URL'));
    print(await warehouseRetirementPreview(db));
  } else if (
    [
      'barrier',
      'freeze',
      'resume-snapshot',
      'switch',
      'cancel-barrier',
      'sync',
      'transition-status',
      'exit-begin',
      'exit-complete',
      'reclaim',
      'monitor',
    ].includes(command)
  ) {
    const config = warehouseRuntimeConfig();
    runtime = await WarehouseRuntime.connect(config);
    const coordinator = new TransitionCoordinator(runtime.db, runtime.queue);
    if (command === 'monitor') print(await warehouseMonitor(runtime.db, runtime.ch, runtime.queue));
    else if (command === 'reclaim')
      print(
        await new WarehouseRecoveryGC(runtime.db, runtime.queue).collect(
          5000,
          Number(process.env.LIEKAN_WAREHOUSE_RECOVERY_GRACE_SECONDS ?? 600),
        ),
      );
    else if (command === 'barrier')
      print(
        await coordinator.request(
          argument('kind') as 'snapshot' | 'cutover' | 'rollback',
          argument('operation'),
        ),
      );
    else if (command === 'freeze') {
      const frozen = await coordinator.freeze(argument('operation'));
      if (frozen.kind === 'snapshot' && frozen.status === 'frozen') {
        const { prepareWarehouseMigrationControls } = await import(
          '../src/lib/liekan/upstream/warehouse-migration-controls'
        );
        await prepareWarehouseMigrationControls(runtime.db, argument('operation'), signal.signal);
      }
      print(frozen);
    } else if (command === 'resume-snapshot')
      print(await coordinator.resumeSnapshot(argument('operation')));
    else if (command === 'switch') print(await coordinator.switch(argument('operation')));
    else if (command === 'cancel-barrier') {
      await coordinator.cancel(argument('operation'));
      print({ cancelled: true });
    } else if (command === 'exit-begin')
      print({ terminalSequence: await new TransitionCapture(runtime.db).stopCapture() });
    else if (command === 'exit-complete') {
      await new TransitionCapture(runtime.db).close();
      print({ closed: true });
    } else if (command === 'sync') {
      replication = new TransitionService(runtime.db, runtime.ch, config.queue);
      print(await replication.tick());
    } else
      print({
        installation: await runtime.db.read(
          'SELECT installation_id,authority,transition,revision,facts_fenced FROM liekan_warehouse_installation',
        ),
        transition: await runtime.db.read(
          'SELECT transition_id,migration_id,state,sequence,sent_sequence,ch_sequence,pg_sequence,terminal_sequence FROM liekan_warehouse_transition',
        ),
        barriers: await runtime.db.read(
          'SELECT operation_id,kind,status,boundary,result_sequence FROM liekan_warehouse_barrier ORDER BY created_at DESC LIMIT 20',
        ),
      });
  } else if (command === 'snapshot-export') {
    print(
      await exportMigrationArchive({
        sourceURL: required('LIEKAN_MIGRATION_SOURCE_URL'),
        directory: argument('directory'),
        pgDump: process.env.LIEKAN_PG_DUMP,
        signal: signal.signal,
      }),
    );
  } else if (command === 'snapshot-restore') {
    const input = JSON.parse(await readFile(resolve(argument('boundary')), 'utf8'));
    print(
      await restoreMigrationClone({
        archive: argument('archive'),
        expectedSHA256: argument('sha256'),
        directory: argument('directory'),
        boundary: input.boundary ?? input,
        adminURL: required('LIEKAN_MIGRATION_ADMIN_URL'),
        pgRestore: process.env.LIEKAN_PG_RESTORE,
        signal: signal.signal,
      }),
    );
  } else if (command === 'preflight') {
    source = new MigrationSource(required('LIEKAN_MIGRATION_SOURCE_URL'));
    await source.connect();
    print(await source.inspect());
  } else {
    if (
      ![
        'schema',
        'seed-demo',
        'install',
        'register',
        'backfill',
        'verify',
        'status',
        'baseline',
      ].includes(command)
    )
      throw new Error('warehouse-unknown-command');
    db = new ControlDatabase(required('DATABASE_URL'));
    if (command === 'baseline') print(await establishTransitionBaseline(db, argument('migration')));
    else if (command === 'status') {
      const id = argument('migration');
      print({
        migration: await db.read(
          'SELECT migration_id,phase,verified_digest,generation,revision,lease_until FROM liekan_warehouse_migration WHERE migration_id=$1',
          [id],
        ),
        families: await db.read(
          'SELECT family,status,pages,rows,digest FROM liekan_warehouse_migration_family WHERE migration_id=$1 ORDER BY family',
          [id],
        ),
      });
    } else {
      const url = new URL(required('LIEKAN_CLICKHOUSE_URL')),
        username =
          decodeURIComponent(url.username) || process.env.LIEKAN_CLICKHOUSE_USERNAME || 'default',
        password = decodeURIComponent(url.password) || process.env.LIEKAN_CLICKHOUSE_PASSWORD || '';
      url.username = '';
      url.password = '';
      ch = createWarehouseClient({
        url: url.toString(),
        username,
        password,
        database: process.env.LIEKAN_CLICKHOUSE_DATABASE ?? 'liekan',
        request_timeout: 60000,
        clickhouse_settings: { max_threads: 2, max_memory_usage: '536870912' },
      });
      if (command === 'install')
        print(
          await installWarehouse(db, ch, {
            mode: argument('mode') as 'fresh' | 'pg-transition',
            queue: warehouseRuntimeConfig().queue,
            inputTopic: process.env.LIEKAN_QUEUE_TOPIC ?? 'liekan-input-v1',
            resultTopic: process.env.LIEKAN_RESULT_TOPIC ?? 'liekan-authority-v1',
            partitions: Number(process.env.LIEKAN_QUEUE_PARTITIONS ?? 8),
            replicationFactor: Number(process.env.LIEKAN_QUEUE_REPLICATION_FACTOR ?? 1),
          }),
        );
      else if (command === 'seed-demo')
        print(
          await seedWarehouseDemo(db, ch, {
            secret: required('APP_SECRET'),
            automatic: process.argv.includes('--automatic'),
            signal: signal.signal,
            progress: print,
          }),
        );
      else if (command === 'schema') print(await initializeWarehouse(ch));
      else {
        await verifyBoundWarehouse(db, ch);
        source = new MigrationSource(required('LIEKAN_MIGRATION_SOURCE_URL'));
        await source.connect();
        if (command === 'register') {
          const [installation] = await db.read<{ authority: string }>(
            'SELECT authority FROM liekan_warehouse_installation WHERE id=1',
          );
          if (!installation || !['postgres', 'frozen'].includes(installation.authority))
            throw new Error('warehouse-migration-register-requires-postgres-authority');
          const sealed = await source.sealedSnapshot(),
            inspection = await source.inspect();
          if (!inspection.compatible) throw new Error('warehouse-source-schema-incompatible');
          const sites: Record<string, string> = {};
          let after: string | null = null;
          for (;;) {
            const resources = await source.resources(after);
            if (!resources.length) break;
            for (const resource of resources) {
              await db.transaction(async tx => {
                // Target is the existing business database. Missing identities
                // are not silently recreated with default owners or permissions.
                const exists = await tx.query(
                  `SELECT 1 FROM ${resource.resource_type} WHERE ${resource.resource_type}_id=$1 FOR SHARE`,
                  [resource.website_id],
                );
                if (exists.rowCount)
                  await tx.query(
                    `INSERT INTO liekan_warehouse_site(website_id,resource_type,epoch,policy_revision)
                  VALUES($1,$2,$3,coalesce((SELECT revision FROM liekan_collection_policy WHERE website_id=$1),0)) ON CONFLICT DO NOTHING`,
                    [resource.website_id, resource.resource_type, resource.epoch],
                  );
                const [current] = (
                  await tx.query<{ epoch: string; resource_type: string; state: string }>(
                    'SELECT epoch,resource_type,state FROM liekan_warehouse_site WHERE website_id=$1 FOR SHARE',
                    [resource.website_id],
                  )
                ).rows;
                if (
                  !current ||
                  BigInt(current.epoch) < BigInt(resource.epoch) ||
                  current.resource_type !== resource.resource_type
                )
                  throw new Error('warehouse-migration-source-boundary-changed');
                if (!exists.rowCount || current.epoch !== resource.epoch) {
                  const sourceInstallation = sealed.descriptor.boundary.installation as
                    | { installation_id?: string }
                    | undefined;
                  const proof = await tx.query(
                    `SELECT 1 FROM liekan_warehouse_installation i
                    WHERE i.id=1 AND i.installation_id=$1 AND EXISTS(
                      SELECT 1 FROM liekan_warehouse_deletion d JOIN liekan_warehouse_transition_result r ON r.operation_id=d.operation_id
                      WHERE d.website_id=$2 AND d.epoch>=$3 AND d.status IN('active','reclaimed')
                      AND d.kind=ANY($4::text[]) AND r.authority='postgres' AND r.kind=d.kind)`,
                    [
                      sourceInstallation?.installation_id ?? null,
                      resource.website_id,
                      resource.epoch,
                      exists.rowCount ? ['reset', 'website'] : ['website'],
                    ],
                  );
                  if (!proof.rowCount || (!exists.rowCount && current.state !== 'deleting'))
                    throw new Error('warehouse-migration-business-resource-missing');
                }
              });
              sites[resource.website_id] = resource.epoch;
            }
            after = resources.at(-1).website_id;
          }
          const existing = await db.read<{ migration_id: string }>(
            "SELECT migration_id FROM liekan_warehouse_migration WHERE phase NOT IN('exited','failed')",
          );
          const result = await new MigrationPages(db, ch).register(
            sealed.descriptor.snapshotId,
            sealed.digest,
            sites,
            existing[0]?.migration_id,
            sealed.descriptor.sourceFingerprint,
          );
          await db.transaction(async tx => {
            await tx.query(
              "UPDATE liekan_warehouse_migration SET boundary=boundary||jsonb_build_object('sourceControl',$2::jsonb) WHERE migration_id=$1",
              [result.migration_id, JSON.stringify(sealed.descriptor.boundary)],
            );
            await tx.query(
              'UPDATE liekan_warehouse_transition SET migration_id=$1 WHERE id=1 AND migration_id IS NULL',
              [result.migration_id],
            );
          });
          print({
            migrationId: result.migration_id,
            phase: result.phase,
            resources: Object.keys(sites).length,
          });
        } else {
          const runner = new MigrationRunner(db, ch, source);
          print(
            await runner.run(argument('migration'), {
              audit: command === 'verify',
              signal: signal.signal,
              progress: print,
            }),
          );
        }
      }
    }
  }
} catch (error) {
  // Database/tool errors can contain DSNs, source values or SQL. Emit only
  // our fixed operational code; server logs and private evidence hold details.
  const message = error instanceof Error ? error.message : '';
  print({
    error: /^warehouse-[a-z0-9:-]+$/.test(message)
      ? message
      : signal.signal.aborted
        ? 'warehouse-interrupted'
        : (migrationIOFailure(error) ?? 'warehouse-operation-failed'),
    // Engine codes are useful for diagnosing a retry without exposing SQL,
    // row values, connection URLs or credentials from an exception message.
    engineCode: /^(?:[A-Z][A-Z0-9_]{2,60}|[0-9A-Z]{5}|[0-9]{1,5})$/.test(
      String((error as any)?.code ?? ''),
    )
      ? String((error as any).code)
      : undefined,
    engineType: /^[A-Z_]{3,80}$/.test(String((error as any)?.type ?? ''))
      ? String((error as any).type)
      : undefined,
  });
  process.exitCode = 1;
} finally {
  await replication?.close();
  await runtime?.close();
  await Promise.allSettled([db?.close(), source?.close(), ch?.close()]);
}
