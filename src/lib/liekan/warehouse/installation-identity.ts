import type { ClickHouseClient } from '@clickhouse/client';
import type { ControlDatabase } from './control-db';
export async function verifyWarehouseIdentity(ch: ClickHouseClient, id: string, create = false) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new Error('warehouse-installation-identity-invalid');
  const comment = `liekan-installation:${id.toLowerCase()}`;
  // CREATE is atomic in CH. A competing control database cannot replace the
  // first installation's identity by appending another metadata row.
  if (create)
    await ch.command({
      query: `CREATE TABLE IF NOT EXISTS warehouse_installation_identity (installation_id UUID) ENGINE=MergeTree ORDER BY installation_id COMMENT '${comment}'`,
    });
  const rows = await ch
    .query({
      query:
        "SELECT comment,engine FROM system.tables WHERE database=currentDatabase() AND name='warehouse_installation_identity'",
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ comment: string; engine: string }>());
  if (rows.length !== 1 || rows[0].comment !== comment || rows[0].engine !== 'MergeTree')
    throw new Error('warehouse-installation-target-identity-mismatch');
}
export async function verifyBoundWarehouse(db: ControlDatabase, ch: ClickHouseClient) {
  const [installation] = await db.read<{ installation_id: string; identity_bound: boolean }>(
    'SELECT installation_id,identity_bound FROM liekan_warehouse_installation WHERE id=1',
  );
  if (installation?.identity_bound) await verifyWarehouseIdentity(ch, installation.installation_id);
}
