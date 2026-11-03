import { createHash, createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ClickHouseClient } from '@clickhouse/client';
import { sourceFingerprint } from './catalog';
import { type ControlDatabase, type ControlSQL, WarehouseConflict } from './control-db';
import { DemoFactMapping, warehouseDemoFamily } from './demo-mapping';
import { writeDemoReplayBookmarkOwners } from './demo-bookmarks';
import { MigrationPages, MIGRATION_TRANSFORM_VERSION } from './migration-page';
import type { MigrationRow } from './migration-source';
import { verifyBoundWarehouse } from './installation-identity';

// The signed fixture shares its validation, identity mapping and catalog binding
// with the PostgreSQL initializer. Analytics facts never enter PostgreSQL here.
export async function seedWarehouseDemo(
  db: ControlDatabase,
  ch: ClickHouseClient,
  options: {
    secret: string;
    automatic?: boolean;
    now?: number;
    signal?: AbortSignal;
    progress?: (value: unknown) => void;
  },
) {
  if (!options.secret) throw new Error('warehouse-demo-secret-required');
  const fixture = await import(pathToFileURL(resolve('scripts/liekan-demo.mjs')).href);
  const format = await import(pathToFileURL(resolve('scripts/liekan-demo-format.mjs')).href);
  const manifest = await fixture.readDemoManifest(),
    site = fixture.DEFAULT_DEMO_ID;
  await verifyBoundWarehouse(db, ch);
  const owner = randomUUID(),
    source = `official-demo-v${manifest.formatVersion}:${manifest.sha256}`;
  const secretProof = createHmac('sha256', options.secret)
    .update('liekan-demo-seed-identity')
    .digest('hex');
  const setup = await db.transaction(async tx => {
    const [installation] = (
      await tx.query<any>(
        'SELECT authority FROM liekan_warehouse_installation WHERE id=1 FOR SHARE',
      )
    ).rows;
    if (
      installation?.authority !== 'clickhouse' ||
      (
        await tx.query(
          "SELECT 1 FROM liekan_warehouse_transition WHERE state<>'closed' UNION ALL SELECT 1 FROM liekan_warehouse_barrier WHERE status IN('draining','frozen')",
        )
      ).rowCount
    ) {
      if (options.automatic) return { done: 'warehouse-transition' };
      throw new WarehouseConflict('warehouse-demo-requires-final-clickhouse');
    }
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('liekan-default-demo'))::text");
    const [existing] = (
      await tx.query<any>(
        'SELECT w.name,w.domain,w.deleted_at,s.is_demo FROM website w LEFT JOIN liekan_setting s USING(website_id) WHERE w.website_id=$1 FOR UPDATE OF w',
        [site],
      )
    ).rows;
    if (
      existing &&
      (existing.name !== fixture.DEFAULT_DEMO_NAME ||
        existing.domain !== fixture.DEFAULT_DEMO_DOMAIN ||
        existing.is_demo !== true)
    ) {
      if (options.automatic) return { done: 'customized' };
      throw new Error('warehouse-demo-identity-conflict');
    }
    const [prior] = (
      await tx.query<any>(
        'SELECT * FROM liekan_warehouse_migration WHERE source_identity=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
        [source],
      )
    ).rows;
    if (
      existing?.deleted_at ||
      (!existing &&
        (
          await tx.query(
            "SELECT 1 FROM liekan_analytics_revision WHERE resource_type='website' AND resource_id=$1",
            [site],
          )
        ).rowCount)
    )
      return { done: 'deleted' };
    if (
      existing &&
      !prior &&
      (
        await tx.query(
          "SELECT 1 FROM liekan_warehouse_migration WHERE source_identity LIKE 'official-demo-%' AND phase<>'exited'",
        )
      ).rowCount
    )
      throw new WarehouseConflict('warehouse-demo-incomplete-fixture-changed');
    if (existing && (!prior || prior.phase === 'exited')) return { done: 'existing' };
    if (
      !existing &&
      options.automatic &&
      (await tx.query('SELECT 1 FROM website WHERE website_id<>$1 LIMIT 1', [site])).rowCount
    )
      return { done: 'existing-installation' };
    if (prior && prior.boundary.demo.secretProof !== secretProof)
      throw new Error('warehouse-demo-resume-secret-changed');
    if (prior && prior.lease_until && new Date(prior.lease_until).getTime() > Date.now())
      throw new WarehouseConflict('warehouse-demo-owned');
    const [admin] = (
      await tx.query<{ id: string }>(
        'SELECT user_id AS id FROM "user" WHERE role=\'admin\' AND deleted_at IS NULL ORDER BY created_at,user_id LIMIT 1',
      )
    ).rows;
    if (!admin) {
      if (options.automatic) return { done: 'no-administrator' };
      throw new Error('warehouse-demo-administrator-required');
    }
    const catalogVersion =
      prior?.boundary.demo.catalogVersion ?? (await fixture.bindDemoCatalog(tx, manifest));
    if (!catalogVersion) return { done: 'incompatible-catalog' };
    if (
      !(
        await tx.query('SELECT 1 FROM liekan_crawler_registry_version WHERE version=$1', [
          catalogVersion,
        ])
      ).rowCount
    )
      throw new WarehouseConflict('warehouse-demo-catalog-missing');
    const anchor = prior?.boundary.demo.anchor ?? (options.now ?? Date.now()) - 300000;
    if (!existing) {
      await tx.query(
        'INSERT INTO website(website_id,name,domain,user_id,created_by) VALUES($1,$2,$3,$4,$4)',
        [site, fixture.DEFAULT_DEMO_NAME, fixture.DEFAULT_DEMO_DOMAIN, admin.id],
      );
      await tx.query(
        'INSERT INTO liekan_setting(website_id,is_demo,rules) VALUES($1,true,$2::jsonb)',
        [site, JSON.stringify(manifest.rules)],
      );
      await tx.query("UPDATE liekan_warehouse_site SET state='frozen' WHERE website_id=$1", [site]);
    }
    const [current] = (
      await tx.query<any>(
        'SELECT epoch,state FROM liekan_warehouse_site WHERE website_id=$1 FOR UPDATE',
        [site],
      )
    ).rows;
    if (current?.state !== 'frozen' || (prior && prior.boundary.sites[site] !== current.epoch))
      throw new WarehouseConflict('warehouse-demo-site-changed');
    const id = prior?.migration_id ?? randomUUID();
    if (!prior)
      await tx.query(
        `INSERT INTO liekan_warehouse_migration(migration_id,source_identity,source_fingerprint,source_snapshot,transform_version,phase,boundary)
      VALUES($1,$2,$3,$4,$5,'prepared',$6::jsonb)`,
        [
          id,
          source,
          sourceFingerprint,
          manifest.sha256,
          MIGRATION_TRANSFORM_VERSION,
          JSON.stringify({
            sites: { [site]: current.epoch },
            demo: { anchor, secretProof, catalogVersion, admin: admin.id },
          }),
        ],
      );
    await tx.query(
      "UPDATE liekan_warehouse_migration SET owner_id=$2,lease_until=clock_timestamp()+interval '90 seconds' WHERE migration_id=$1",
      [id, owner],
    );
    return {
      id,
      epoch: current.epoch,
      anchor,
      admin: prior?.boundary.demo.admin ?? admin.id,
      catalogVersion,
    };
  });
  if (setup.done) return { websiteId: site, status: setup.done, inserted: false };
  const pages = new MigrationPages(db, ch),
    counts: Record<string, number> = Object.fromEntries(
      format.demoKinds.map((kind: string) => [kind, 0]),
    );
  const mapping = new DemoFactMapping(
    manifest.counts,
    site,
    fixture.DEFAULT_DEMO_DOMAIN,
    setup.anchor,
  );
  const buffers = new Map<string, MigrationRow[]>(),
    cursors = new Map<string, string[] | null>(),
    totals = new Map<string, number>();
  let failed: unknown;
  const heartbeat = setInterval(
    () =>
      db
        .read(
          "UPDATE liekan_warehouse_migration SET lease_until=clock_timestamp()+interval '90 seconds' WHERE migration_id=$1 AND owner_id=$2 AND lease_until>clock_timestamp() RETURNING migration_id",
          [setup.id, owner],
        )
        .then(rows => {
          if (!rows.length) failed = new Error('warehouse-demo-lease-lost');
        })
        .catch(e => {
          failed = e;
        }),
    15000,
  );
  function check() {
    options.signal?.throwIfAborted();
    if (failed) throw failed;
  }
  async function fence(tx: ControlSQL) {
    await tx.query('SELECT website_id FROM website WHERE website_id=$1 FOR SHARE', [site]);
    const [current] = (
      await tx.query<any>(
        'SELECT epoch,state FROM liekan_warehouse_site WHERE website_id=$1 FOR SHARE',
        [site],
      )
    ).rows;
    if (current?.state !== 'frozen' || current.epoch !== setup.epoch)
      throw new WarehouseConflict('warehouse-demo-site-changed');
    if (
      !(
        await tx.query(
          'SELECT 1 FROM liekan_warehouse_migration WHERE migration_id=$1 AND owner_id=$2 AND lease_until>clock_timestamp() FOR SHARE',
          [setup.id, owner],
        )
      ).rowCount
    )
      throw new WarehouseConflict('warehouse-demo-lease-lost');
  }
  async function flush(family: string) {
    check();
    const rows = buffers.get(family) ?? [];
    if (!rows.length) return;
    const before = cursors.get(family) ?? null,
      after = [String((totals.get(family) ?? 0) + rows.length)];
    const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const page = { family, before, after, rows, digest };
    await pages.apply(setup.id, page);
    await pages.verifyPage(setup.id, page);
    cursors.set(family, after);
    totals.set(family, Number(after[0]));
    buffers.set(family, []);
    options.progress?.({ family, rows: after[0], stage: 'demo' });
  }
  async function fact(family: string, row: MigrationRow) {
    const records = buffers.get(family) ?? [];
    records.push(row);
    buffers.set(family, records);
    if (records.length >= 2000) await flush(family);
  }
  let metadataKind: string | undefined,
    metadataRows: Record<string, unknown>[] = [];
  async function flushMetadata() {
    if (!metadataRows.length) return;
    check();
    await db.transaction(async tx => {
      await fence(tx);
      await format.insertDemoBatch(tx, metadataKind, metadataRows, { resume: true });
      if (metadataKind === 'saved-replay')
        await writeDemoReplayBookmarkOwners(tx, mapping, metadataRows);
    });
    metadataRows = [];
  }
  try {
    let metadata = false;
    for await (const raw of fixture.readDemoRecords()) {
      check();
      const kind = raw[0];
      if (kind === 'metadata') {
        if (
          metadata ||
          raw[1].websiteId !== site ||
          raw[1].isDemo !== true ||
          raw[1].formatVersion !== manifest.formatVersion
        )
          throw new Error('warehouse-demo-invalid-metadata');
        metadata = true;
        continue;
      }
      if (!metadata || !Object.hasOwn(counts, kind)) throw new Error('warehouse-demo-invalid-kind');
      format.validateDemoRow(kind, raw[1], manifest);
      const row = format.materializeDemoRow(
        kind,
        raw[1],
        counts[kind]++,
        setup.anchor,
        options.secret,
        setup.admin,
      );
      if (row.catalog_version) row.catalog_version = setup.catalogVersion;
      const family = warehouseDemoFamily(format.demoSpecs[kind].table);
      if (family) {
        await flushMetadata();
        for (const [index, record] of mapping.facts(family, raw[1], row).entries())
          await fact(index === 0 ? family : 'liekan_session_data_source', record);
      } else {
        if (metadataKind !== kind) await flushMetadata();
        metadataKind = kind;
        metadataRows.push(row);
        if (metadataRows.length >= 500) await flushMetadata();
      }
    }
    await flushMetadata();
    for (const family of buffers.keys()) await flush(family);
    if (!metadata || Object.keys(counts).some(k => counts[k] !== manifest.counts[k]))
      throw new Error('warehouse-demo-count-mismatch');
    await db.transaction(async tx => {
      await fence(tx);
      const updated = await tx.query(
        "UPDATE liekan_warehouse_migration SET phase='exited',verified_digest=$3,owner_id=NULL,lease_until=NULL WHERE migration_id=$1 AND owner_id=$2 AND lease_until>clock_timestamp() RETURNING migration_id",
        [
          setup.id,
          owner,
          createHash('sha256')
            .update(JSON.stringify([...totals]))
            .digest('hex'),
        ],
      );
      if (!updated.rowCount) throw new WarehouseConflict('warehouse-demo-lease-lost');
      await tx.query(
        "UPDATE liekan_warehouse_migration_family SET status='verified' WHERE migration_id=$1",
        [setup.id],
      );
      await tx.query("UPDATE liekan_warehouse_site SET state='active' WHERE website_id=$1", [site]);
      await tx.query(
        'INSERT INTO liekan_log_state(website_id,data_revision) VALUES($1,1) ON CONFLICT(website_id) DO UPDATE SET data_revision=liekan_log_state.data_revision+1',
        [site],
      );
      await tx.query(
        "INSERT INTO liekan_analytics_revision(resource_type,resource_id,revision) VALUES('website',$1,1) ON CONFLICT(resource_type,resource_id) DO UPDATE SET revision=liekan_analytics_revision.revision+1",
        [site],
      );
    });
    return { websiteId: site, status: 'created', inserted: true, counts };
  } finally {
    clearInterval(heartbeat);
    await db.read(
      'UPDATE liekan_warehouse_migration SET owner_id=NULL,lease_until=NULL WHERE migration_id=$1 AND owner_id=$2',
      [setup.id, owner],
    );
  }
}
