import { createHash } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import {
  WAREHOUSE_SCHEMA_VERSION,
  warehouseDDL,
  warehouseLogTrendDDL,
  warehouseOverviewLogDDL,
} from './schema';

export async function initializeWarehouseAnalytics(client: ClickHouseClient) {
  for (const query of [warehouseLogTrendDDL, ...warehouseOverviewLogDDL])
    await client.command({ query });
}

function definition(ddl: string) {
  const match =
    /^CREATE TABLE IF NOT EXISTS "?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]+)\)\s*ENGINE = MergeTree/.exec(
      ddl,
    );
  if (!match) throw new Error('Invalid warehouse schema definition');
  const pieces: string[] = [];
  let depth = 0,
    quote = '',
    begin = 0;
  for (let i = 0; i < match[2].length; i++) {
    const c = match[2][i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      pieces.push(match[2].slice(begin, i).trim());
      begin = i + 1;
    }
  }
  pieces.push(match[2].slice(begin).trim());
  const columns = pieces.map(piece => {
    const m = /^"?([a-z_][a-z0-9_]*)"?\s+([\s\S]+)$/.exec(piece);
    if (!m) throw new Error('Invalid warehouse column definition');
    return { name: m[1], type: m[2].replace(/\s/g, '') };
  });
  return { name: match[1], columns };
}

export const warehouseSchemaChecksum = () =>
  createHash('sha256').update(JSON.stringify(warehouseDDL())).digest('hex');

export async function initializeWarehouse(client: ClickHouseClient) {
  const statements = warehouseDDL(),
    checksum = warehouseSchemaChecksum();
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS warehouse_schema_history
    (version UInt32,checksum FixedString(64),applied_at DateTime64(6,'UTC'))
    ENGINE=MergeTree ORDER BY (version,checksum) SETTINGS fsync_after_insert=1,fsync_part_directory=1`,
  });
  const histories = await client
    .query({
      query:
        'SELECT DISTINCT version,checksum FROM warehouse_schema_history ORDER BY version DESC LIMIT 2',
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ version: number; checksum: string }>());
  if (
    histories.length &&
    (histories[0].version !== WAREHOUSE_SCHEMA_VERSION || histories[0].checksum !== checksum)
  )
    throw new Error('warehouse-schema-upgrade-required');
  for (const ddl of statements) await client.command({ query: ddl });
  const actual = await client
    .query({
      query: `SELECT table,name,type FROM system.columns
    WHERE database=currentDatabase() AND table IN {names:Array(String)} ORDER BY table,position`,
      query_params: { names: statements.map(s => definition(s).name) },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ table: string; name: string; type: string }>());
  for (const ddl of statements) {
    const expected = definition(ddl);
    const columns = actual
      .filter(c => c.table === expected.name)
      .map(c => ({ name: c.name, type: c.type.replace(/\s/g, '') }));
    if (JSON.stringify(columns) !== JSON.stringify(expected.columns))
      throw new Error(`warehouse-schema-mismatch:${expected.name}`);
  }
  const engines = await client
    .query({
      query: `SELECT name,engine,create_table_query FROM system.tables
    WHERE database=currentDatabase() AND name IN {names:Array(String)}`,
      query_params: { names: statements.map(s => definition(s).name) },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ name: string; engine: string; create_table_query: string }>());
  if (engines.some(t => t.engine !== 'MergeTree' || /\bTTL\b/.test(t.create_table_query)))
    throw new Error('warehouse-unexpected-storage-policy');
  if (!histories.length)
    await client.insert({
      table: 'warehouse_schema_history',
      values: [
        {
          version: WAREHOUSE_SCHEMA_VERSION,
          checksum,
          applied_at: new Date().toISOString().replace('T', ' ').replace('Z', '000'),
        },
      ],
      format: 'JSONEachRow',
    });
  await initializeWarehouseAnalytics(client);
  return { version: WAREHOUSE_SCHEMA_VERSION, checksum, tables: statements.length };
}
