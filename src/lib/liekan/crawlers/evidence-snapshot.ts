import { warehouseEnabled } from '../warehouse/authority-routing';
import type { AiTx } from '../upstream/ai-db';
import { withinQuerySnapshot } from '../upstream/query-snapshot';

// Warehouse readers already hold a publication reference. Installing a PG
// snapshot here would misroute their small business queries to a fake SQL client.
export function evidenceSnapshot<T>(tx: AiTx, work: () => Promise<T>) {
  if (warehouseEnabled()) return work();
  return withinQuerySnapshot(
    {
      aiPrivate: true,
      $queryRawUnsafe: (sql, ...args) => tx.queryPrepared(sql, ...args),
      $executeRawUnsafe: (sql, ...args) => tx.execute(sql, ...args),
    },
    work,
  );
}
