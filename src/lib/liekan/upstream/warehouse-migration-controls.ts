import { type ControlDatabase, WarehouseConflict } from '../warehouse/control-db';
import { initializeRepairUploadControls } from './warehouse-history-repair-inputs';
import { initializeWarehouseReplayBookmarks } from './warehouse-replay-bookmarks';

/** Resumable business metadata conversion while the source boundary is frozen.
 * Neither event bodies nor evidence records are copied into the control tables. */
export async function prepareWarehouseMigrationControls(
  db: ControlDatabase,
  operationId: string,
  signal?: AbortSignal,
) {
  for (;;) {
    if (signal?.aborted) throw new Error('warehouse-interrupted');
    const complete = await db.transaction(async tx => {
      const [installation] = (
        await tx.query<{ authority: string; revision: string }>(
          'SELECT authority,revision FROM liekan_warehouse_installation WHERE id=1 FOR SHARE',
        )
      ).rows;
      const [barrier] = (
        await tx.query<{ kind: string; status: string; frozen_revision: string }>(
          'SELECT kind,status,frozen_revision FROM liekan_warehouse_barrier WHERE operation_id=$1 FOR SHARE',
          [operationId],
        )
      ).rows;
      if (
        installation?.authority !== 'frozen' ||
        barrier?.kind !== 'snapshot' ||
        barrier.status !== 'frozen' ||
        barrier.frozen_revision !== installation.revision
      )
        throw new WarehouseConflict('warehouse-migration-controls-not-frozen');
      await tx.query(
        'INSERT INTO liekan_warehouse_migration_business_control(operation_id) VALUES($1) ON CONFLICT DO NOTHING',
        [operationId],
      );
      const [progress] = (
        await tx.query<{
          status: string;
          resource_cursor: string;
          current_resource: string;
          bookmark_cursor: string;
        }>(
          'SELECT * FROM liekan_warehouse_migration_business_control WHERE operation_id=$1 FOR UPDATE',
          [operationId],
        )
      ).rows;
      if (progress.status === 'ready') return true;
      let site = progress.current_resource;
      if (!site) {
        const [next] = (
          await tx.query<{ website_id: string }>(
            'SELECT website_id FROM website WHERE ($1::uuid IS NULL OR website_id>$1) ORDER BY website_id LIMIT 1',
            [progress.resource_cursor],
          )
        ).rows;
        if (!next) {
          await tx.query(
            "UPDATE liekan_warehouse_migration_business_control SET status='ready',updated_at=clock_timestamp() WHERE operation_id=$1",
            [operationId],
          );
          return true;
        }
        site = next.website_id;
        await initializeRepairUploadControls(tx, site);
        await tx.query(
          'UPDATE liekan_warehouse_migration_business_control SET current_resource=$2 WHERE operation_id=$1',
          [operationId, site],
        );
      }
      const after = await initializeWarehouseReplayBookmarks(tx, site, progress.bookmark_cursor);
      if (after)
        await tx.query(
          'UPDATE liekan_warehouse_migration_business_control SET bookmark_cursor=$2,updated_at=clock_timestamp() WHERE operation_id=$1',
          [operationId, after],
        );
      else
        await tx.query(
          'UPDATE liekan_warehouse_migration_business_control SET resource_cursor=$2,current_resource=NULL,bookmark_cursor=NULL,updated_at=clock_timestamp() WHERE operation_id=$1',
          [operationId, site],
        );
      return false;
    });
    if (complete) return { operationId, status: 'ready' };
  }
}
