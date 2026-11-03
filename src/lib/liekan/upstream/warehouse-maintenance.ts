import { warehouseTransitionEnabled } from '../warehouse/authority-routing';
import { LiekanError } from './errors';

// Call inside the mutation transaction. The shared installation lock makes
// starting capture wait for an already authorized maintenance operation.
export async function assertTransitionMaintenance(
  tx: { $queryRawUnsafe: (sql: string, ...values: any[]) => Promise<any> },
  kind: 'repair' | 'governance' | 'risk' | 'retention' = 'repair',
) {
  if (!warehouseTransitionEnabled()) return;
  const [row] =
    await tx.$queryRawUnsafe(`SELECT i.authority,t.state FROM liekan_warehouse_installation i
    LEFT JOIN liekan_warehouse_transition t ON t.id=i.id WHERE i.id=1 FOR SHARE OF i`);
  if (
    row &&
    (row.authority === 'frozen' ||
      (row.state && row.state !== 'closed' && !(kind === 'risk' && row.authority === 'clickhouse')))
  )
    throw new LiekanError(
      '数据迁移或回退窗口内暂缓此操作，完成迁移后可继续',
      409,
      'warehouse-transition-maintenance-frozen',
    );
}
