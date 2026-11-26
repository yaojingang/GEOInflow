import pg from 'pg';
import { WarehouseConflict } from './control-db';
import { warehouseReadResources } from './read-resources';

/**
 * Warehouse v2 startup configuration guard.
 * Validates PG connectivity, ensures upstream CLICKHOUSE_URL is not conflated
 * with Liekan's ClickHouse warehouse, and checks ClickHouse env settings.
 */
export async function assertWarehouseStartup(env: NodeJS.ProcessEnv = process.env) {
  let client: pg.Client | undefined;
  try {
    let url: URL;
    try {
      url = new URL(env.DATABASE_URL ?? '');
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('invalid-protocol');
    } catch {
      throw new WarehouseConflict('warehouse-startup-invalid-database-url');
    }
    const schema = url.searchParams.get('schema') || 'public';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema))
      throw new WarehouseConflict('warehouse-startup-invalid-database-schema');

    client = new pg.Client({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      options: '-c statement_timeout=5000 -c default_transaction_read_only=on',
      application_name: 'liekan-warehouse-startup',
    });
    await client.connect();
    await client.query('SELECT 1');

    const backend = env.LIEKAN_ANALYTICS_BACKEND === 'clickhouse';
    if (backend) {
      try {
        warehouseReadResources(env.LIEKAN_CH_QUERY_MEMORY_BYTES);
      } catch {
        throw new WarehouseConflict('warehouse-query-memory-invalid');
      }
      if (env.CLICKHOUSE_URL)
        throw new WarehouseConflict('warehouse-upstream-configuration-conflict');
      for (const name of ['LIEKAN_CLICKHOUSE_URL', 'LIEKAN_CLICKHOUSE_DATABASE']) {
        if (!env[name]?.trim())
          throw new WarehouseConflict('warehouse-runtime-configuration-incomplete');
      }
    }
  } catch (error) {
    throw error instanceof WarehouseConflict
      ? error
      : new WarehouseConflict('warehouse-startup-check-unavailable');
  } finally {
    await client?.end().catch(() => {});
  }
}
