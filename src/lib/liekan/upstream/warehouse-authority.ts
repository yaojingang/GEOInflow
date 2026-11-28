import type { ControlSQL } from '../warehouse/control-db';

export function warehouseControlAdapter(tx: ControlSQL) {
  return {
    $queryRawUnsafe: async <T = any>(sql: string, ...params: unknown[]) =>
      (await tx.query<T>(sql, params)).rows,
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) =>
      (await tx.query(sql, params)).rowCount ?? 0,
  };
}
