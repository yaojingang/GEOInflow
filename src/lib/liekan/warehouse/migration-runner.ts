import { createHash, randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { factTables } from './catalog';
import { type ControlDatabase, WarehouseConflict } from './control-db';
import { MigrationPages } from './migration-page';
import type { MigrationSource } from './migration-source';
import { retryMigrationIO } from './migration-retry';

// The receipt family is a prerequisite, including when it is empty. A resumed
// migration never starts ordinary facts while receipt verification is pending.
export const migrationOrder = [
  'liekan_collection_receipt',
  ...factTables.map(t => t.name).filter(n => n !== 'liekan_collection_receipt'),
];
type Progress = {
  cursor_value: string[] | null;
  pages: string;
  rows: string;
  status: string;
  digest: string | null;
};
type Lease = { owner: string; generation: string };
export type MigrationProgress = {
  family: string;
  stage: 'copy' | 'verify';
  pages: string;
  rows: string;
};

export class MigrationRunner {
  private readonly pages: MigrationPages;
  constructor(
    private readonly db: ControlDatabase,
    ch: ClickHouseClient,
    private readonly source: MigrationSource,
  ) {
    this.pages = new MigrationPages(db, ch);
  }

  private async claim(id: string): Promise<Lease> {
    return this.db.transaction(async tx => {
      const owner = randomUUID();
      const result = await tx.query<{ generation: string }>(
        `UPDATE liekan_warehouse_migration
        SET owner_id=$2,generation=generation+1,lease_until=clock_timestamp()+interval '90 seconds'
        WHERE migration_id=$1 AND phase IN('prepared','capturing','backfill','verify')
          AND (owner_id IS NULL OR lease_until < clock_timestamp()) RETURNING generation`,
        [id, owner],
      );
      if (!result.rows.length) throw new WarehouseConflict('warehouse-migration-owned-or-closed');
      return { owner, generation: result.rows[0].generation };
    });
  }

  private async fence(id: string, lease: Lease) {
    const rows = await this.db.read(
      `UPDATE liekan_warehouse_migration
      SET lease_until=clock_timestamp()+interval '90 seconds'
      WHERE migration_id=$1 AND owner_id=$2 AND generation=$3 AND lease_until>clock_timestamp()
      RETURNING migration_id`,
      [id, lease.owner, lease.generation],
    );
    if (!rows.length) throw new WarehouseConflict('warehouse-migration-lease-lost');
  }

  async run(
    id: string,
    options: {
      pageSize?: number;
      signal?: AbortSignal;
      audit?: boolean;
      progress?: (value: MigrationProgress) => void | Promise<void>;
    } = {},
  ) {
    const size = options.pageSize ?? 5000;
    if (!Number.isInteger(size) || size < 1 || size > 10000)
      throw new Error('warehouse-migration-invalid-page-size');
    const inspection = await this.source.inspect();
    if (!inspection.compatible)
      throw new Error(`warehouse-source-schema-incompatible:${inspection.errors.join(';')}`);
    const sealed = await this.source.sealedSnapshot();
    const [migration] = await this.db.read<{
      source_identity: string;
      source_snapshot: string;
      source_fingerprint: string;
    }>(
      'SELECT source_identity,source_snapshot,source_fingerprint FROM liekan_warehouse_migration WHERE migration_id=$1',
      [id],
    );
    if (
      migration?.source_identity !== sealed.descriptor.snapshotId ||
      migration.source_snapshot !== sealed.digest ||
      migration.source_fingerprint !== sealed.descriptor.sourceFingerprint
    )
      throw new WarehouseConflict('warehouse-source-snapshot-changed');
    const lease = await this.claim(id);
    let heartbeatFailure: unknown;
    const heartbeat = setInterval(() => {
      this.fence(id, lease).catch(e => {
        heartbeatFailure = e;
      });
    }, 15000);
    const check = async () => {
      options.signal?.throwIfAborted();
      if (heartbeatFailure) throw heartbeatFailure;
      await this.fence(id, lease);
    };
    try {
      for (const family of migrationOrder) {
        await check();
        await this.db.read(
          `INSERT INTO liekan_warehouse_migration_family(migration_id,family)
          VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [id, family],
        );
        let [head] = await this.db.read<Progress>(
          'SELECT * FROM liekan_warehouse_migration_family WHERE migration_id=$1 AND family=$2',
          [id, family],
        );
        if (head.status === 'verified' && !options.audit) continue;
        if (head.status === 'copying') {
          for (;;) {
            await check();
            const [pending] = await this.db.read<{ row_count: string }>(
              `SELECT row_count FROM liekan_warehouse_checkpoint
              WHERE migration_id=$1 AND family=$2 AND page_key=$3`,
              [
                id,
                family,
                createHash('sha256')
                  .update(JSON.stringify([family, head.cursor_value]))
                  .digest('hex'),
              ],
            );
            const page = await retryMigrationIO(
              () =>
                this.source.page(
                  family,
                  head.cursor_value,
                  pending ? Number(pending.row_count) : size,
                ),
              check,
              options.signal,
            );
            if (!page) break;
            await retryMigrationIO(() => this.pages.apply(id, page), check, options.signal);
            [head] = await this.db.read<Progress>(
              'SELECT * FROM liekan_warehouse_migration_family WHERE migration_id=$1 AND family=$2',
              [id, family],
            );
            await options.progress?.({ family, stage: 'copy', rows: head.rows, pages: head.pages });
          }
          await check();
          await this.db.read(
            `UPDATE liekan_warehouse_migration_family SET status='copied',updated_at=clock_timestamp()
            WHERE migration_id=$1 AND family=$2 AND status='copying'`,
            [id, family],
          );
        }
        // Walk the exact durable page chain: a different CLI page size on resume
        // cannot change an already published page's digest or skip its tail.
        let cursor: string[] | null = null,
          rows = 0n,
          pages = 0n;
        const digest = createHash('sha256');
        for (;;) {
          await check();
          const checkpoints = await this.db.read<{
            row_count: string;
            cursor_after: string[];
            digest: string;
          }>(
            `SELECT row_count,cursor_after,digest FROM liekan_warehouse_checkpoint
            WHERE migration_id=$1 AND family=$2 AND page_key=$3 LIMIT 2`,
            [
              id,
              family,
              createHash('sha256')
                .update(JSON.stringify([family, cursor]))
                .digest('hex'),
            ],
          );
          if (!checkpoints.length) break;
          if (checkpoints.length !== 1)
            throw new WarehouseConflict('warehouse-migration-ambiguous-page-chain');
          const checkpoint = checkpoints[0];
          const page = await retryMigrationIO(
            () => this.source.page(family, cursor, Number(checkpoint.row_count)),
            check,
            options.signal,
          );
          if (!page) throw new WarehouseConflict('warehouse-source-page-missing');
          await retryMigrationIO(() => this.pages.verifyPage(id, page), check, options.signal);
          rows += BigInt(page.rows.length);
          pages++;
          digest
            .update(JSON.stringify([page.before, page.after, page.digest, page.rows.length]))
            .update('\n');
          cursor = page.after;
          await options.progress?.({
            family,
            stage: 'verify',
            rows: String(rows),
            pages: String(pages),
          });
        }
        if (await this.source.page(family, cursor, 1))
          throw new WarehouseConflict('warehouse-migration-source-tail-unmapped');
        if (
          rows !== BigInt(head.rows) ||
          pages !== BigInt(head.pages) ||
          JSON.stringify(cursor) !== JSON.stringify(head.cursor_value)
        )
          throw new WarehouseConflict('warehouse-migration-family-total-mismatch');
        await check();
        await this.db.read(
          `UPDATE liekan_warehouse_migration_family SET status='verified',digest=$3,updated_at=clock_timestamp()
          WHERE migration_id=$1 AND family=$2 AND status IN('copied','verified')`,
          [id, family, digest.digest('hex')],
        );
      }
      await check();
      return await this.db.transaction(async tx => {
        const summaries = (
          await tx.query<{
            family: string;
            status: string;
            rows: string;
            pages: string;
            digest: string;
          }>(
            'SELECT family,status,rows,pages,digest FROM liekan_warehouse_migration_family WHERE migration_id=$1 ORDER BY family',
            [id],
          )
        ).rows;
        if (
          summaries.length !== migrationOrder.length ||
          summaries.some(r => r.status !== 'verified' || !migrationOrder.includes(r.family))
        )
          throw new WarehouseConflict('warehouse-migration-incomplete');
        const digest = createHash('sha256').update(JSON.stringify(summaries)).digest('hex');
        const finished = await tx.query(
          `UPDATE liekan_warehouse_migration SET phase='verify',verified_digest=$4,revision=revision+1,
          updated_at=clock_timestamp() WHERE migration_id=$1 AND owner_id=$2 AND generation=$3 AND lease_until>clock_timestamp() RETURNING migration_id`,
          [id, lease.owner, lease.generation, digest],
        );
        if (!finished.rowCount) throw new WarehouseConflict('warehouse-migration-lease-lost');
        return { migrationId: id, phase: 'verify', digest, families: summaries };
      });
    } finally {
      clearInterval(heartbeat);
      await this.db.read(
        `UPDATE liekan_warehouse_migration SET owner_id=NULL,lease_until=NULL
        WHERE migration_id=$1 AND owner_id=$2 AND generation=$3`,
        [id, lease.owner, lease.generation],
      );
    }
  }
}
