import { createWarehouseClient } from './client';
import { ControlDatabase } from './control-db';
import { ReadAdmission } from './read-admission';
import { warehouseEnabled } from './runtime';
import { verifyBoundWarehouse } from './installation-identity';
import { warehouseReadResources } from './read-resources';

export function createWarehouseReader(config: {
  databaseURL: string;
  clickhouseURL: string;
  clickhouseDatabase: string;
  clickhouseUsername?: string;
  clickhousePassword?: string;
}) {
  const resources = warehouseReadResources(process.env.LIEKAN_CH_QUERY_MEMORY_BYTES);
  const url = new URL(config.clickhouseURL);
  const username = url.username
      ? decodeURIComponent(url.username)
      : (config.clickhouseUsername ?? 'default'),
    password = url.password ? decodeURIComponent(url.password) : (config.clickhousePassword ?? '');
  url.username = '';
  url.password = '';
  const db = new ControlDatabase(config.databaseURL);
  const admission = new ReadAdmission(
    Number(process.env.LIEKAN_CH_READ_CONCURRENCY ?? 1),
    Number(process.env.LIEKAN_CH_READ_WAITING ?? 64),
    Number(process.env.LIEKAN_CH_READ_WAIT_MS ?? 5000),
  );
  const ch = createWarehouseClient({
    url: url.toString(),
    username,
    password,
    database: config.clickhouseDatabase,
    request_timeout: 60000,
    clickhouse_settings: {
      max_execution_time: 55,
      max_threads: 2,
      // Several evidence families are joined in an audit. Smaller processing
      // blocks avoid a large allocation per join input on small installations.
      max_block_size: '8192',
      preferred_block_size_bytes: '1048576',
      // Several evidence joins share one query budget. Spill each build before
      // concurrent hash tables and aggregate states exhaust that shared limit.
      ...resources,
      join_use_nulls: 1,
      max_query_size: '1048576',
    },
  });
  const exportSeconds = Number(process.env.LIEKAN_CH_EXPORT_QUERY_TIMEOUT_SECONDS ?? 900);
  if (!Number.isSafeInteger(exportSeconds) || exportSeconds < 30 || exportSeconds > 86400)
    throw new Error('warehouse-export-timeout-invalid');
  const exportAdmission = new ReadAdmission(1, 16, 30000);
  const exportCH = createWarehouseClient({
    url: url.toString(),
    username,
    password,
    database: config.clickhouseDatabase,
    request_timeout: (exportSeconds + 30) * 1000,
    clickhouse_settings: {
      max_execution_time: exportSeconds,
      max_threads: 1,
      max_block_size: '8192',
      preferred_block_size_bytes: '1048576',
      ...resources,
      join_use_nulls: 1,
      max_query_size: '1048576',
    },
  });
  let identity: Promise<void> | undefined;
  return {
    db,
    ch,
    admission,
    exportCH,
    exportAdmission,
    verifyIdentity: () =>
      (identity ??= verifyBoundWarehouse(db, ch).catch(error => {
        identity = undefined;
        throw error;
      })),
    close: () => {
      admission.close();
      exportAdmission.close();
      return Promise.all([db.close(), ch.close(), exportCH.close()]);
    },
  };
}
type Reader = ReturnType<typeof createWarehouseReader>;
const key = Symbol.for('liekan.warehouse-reader.v1');
const state = globalThis as typeof globalThis & { [key]?: Reader };
// Report availability depends on PG control + CH, never on a producer connection.
export function warehouseReader(): Reader {
  if (!warehouseEnabled() || process.env.CLICKHOUSE_URL)
    throw new Error('warehouse-reader-configuration-conflict');
  if (!state[key]) {
    const databaseURL = process.env.DATABASE_URL,
      clickhouseURL = process.env.LIEKAN_CLICKHOUSE_URL;
    if (!databaseURL || !clickhouseURL)
      throw new Error('warehouse-reader-configuration-incomplete');
    state[key] = createWarehouseReader({
      databaseURL,
      clickhouseURL,
      clickhouseDatabase: process.env.LIEKAN_CLICKHOUSE_DATABASE ?? 'liekan',
      clickhouseUsername: process.env.LIEKAN_CLICKHOUSE_USERNAME,
      clickhousePassword: process.env.LIEKAN_CLICKHOUSE_PASSWORD,
    });
  }
  return state[key];
}

export async function closeWarehouseReader() {
  const reader = state[key];
  delete state[key];
  await reader?.close();
}
