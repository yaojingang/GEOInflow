import pg from 'pg';
import { WarehouseConflict } from './control-db';
import { warehouseReadResources } from './read-resources';

// An installed warehouse must never silently reopen stale PG facts because an
// operator restarted only the legacy Compose file. This probe does not migrate,
// select authority, or contact CH/queue; the durable installation remains owner.
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
    const table = `"${schema}"."liekan_warehouse_installation"`;
    const [{ present }] = (
      await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [table])
    ).rows;
    const installed =
      present && (await client.query(`SELECT 1 FROM ${table} WHERE id=1`)).rowCount > 0;
    const backend = env.LIEKAN_ANALYTICS_BACKEND === 'clickhouse';
    const routed = env.LIEKAN_WAREHOUSE_TRANSITION === 'true';
    if (installed && (!backend || !routed))
      throw new WarehouseConflict('warehouse-runtime-configuration-missing-use-warehouse-deploy');
    if (!installed && (backend || routed))
      throw new WarehouseConflict('warehouse-startup-installation-required');
    if (installed) {
      try {
        warehouseReadResources(env.LIEKAN_CH_QUERY_MEMORY_BYTES);
      } catch {
        throw new WarehouseConflict('warehouse-query-memory-invalid');
      }
      if (env.CLICKHOUSE_URL)
        throw new WarehouseConflict('warehouse-upstream-configuration-conflict');
      for (const name of [
        'LIEKAN_CLICKHOUSE_URL',
        'LIEKAN_CLICKHOUSE_DATABASE',
        'LIEKAN_QUEUE_BROKERS',
      ]) {
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
