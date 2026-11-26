import { warehouseIntakeEnabled } from '../warehouse/authority-routing';

/** The caller has authorized the parent deletion. Enlist every child before
 * legacy explicit deletes or foreign-key cascades can remove its receipts. */
export async function prepareWarehouseCascade(
  tx: { $queryRawUnsafe: (sql: string, ...values: any[]) => Promise<any> },
  resources: { id: string; kind: 'website' | 'link' | 'pixel' }[],
) {
  if (!warehouseIntakeEnabled()) return;
  for (const resource of resources.sort((a, b) => a.id.localeCompare(b.id)))
    await tx.$queryRawUnsafe(
      'SELECT liekan_warehouse_prepare_removal($1::uuid,$2)::text',
      resource.id,
      resource.kind,
    );
}
