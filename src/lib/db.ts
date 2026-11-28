import { warehouseEnabled, withinWarehouseAuthority } from './liekan/warehouse/authority-routing';
export const PRISMA = 'prisma';
export const POSTGRESQL = 'postgresql';
export const CLICKHOUSE = 'clickhouse';
export const KAFKA = 'kafka';
export const KAFKA_PRODUCER = 'kafka-producer';

// Fixes issue with converting bigint values
(BigInt.prototype as unknown as { toJSON(): number }).toJSON = function () {
  return Number(this);
};

export function getDatabaseType(url = process.env.DATABASE_URL) {
  const type = url?.split(':')[0];

  if (type === 'postgres') {
    return POSTGRESQL;
  }

  return type;
}

export function isRelationalOnly() {
  return !process.env.CLICKHOUSE_URL && getDatabaseType() === POSTGRESQL;
}

export async function runQuery(queries: any) {
  return withinWarehouseAuthority(() => runSelectedQuery(queries));
}
async function runSelectedQuery(queries: any) {
  if (warehouseEnabled()) {
    if (process.env.CLICKHOUSE_URL) throw new Error('warehouse-upstream-configuration-conflict');
    if (!queries[CLICKHOUSE]) throw new Error('warehouse-query-adapter-missing');
    return (await import('./liekan/upstream/warehouse-report-snapshot')).withinWarehouseReport(() =>
      queries[CLICKHOUSE](),
    );
  }
  if (process.env.CLICKHOUSE_URL) {
    if (queries[KAFKA]) {
      return queries[KAFKA]();
    }

    return queries[CLICKHOUSE]();
  }

  const db = getDatabaseType();

  if (db === POSTGRESQL) {
    return queries[PRISMA]();
  }
}

export function notImplemented() {
  throw new Error('Not implemented.');
}
