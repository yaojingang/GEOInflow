import {
  type ClickHouseClient,
  type ClickHouseClientConfigOptions,
  ClickHouseLogLevel,
  createClient,
} from '@clickhouse/client';
import { geoHistoryRowHash, geoLogFingerprint, v2Tables, warehouseV2DDL } from './schema';

export const v2ClientSettings = {
  output_format_json_quote_64bit_integers: 1,
  output_format_json_quote_64bit_floats: 1,
  output_format_json_quote_decimals: 1,
  date_time_output_format: 'simple',
  input_format_null_as_default: 0,
  insert_null_as_default: 0,
} as const;

export function createV2ClickHouseClient(options: ClickHouseClientConfigOptions): ClickHouseClient {
  return createClient({
    ...options,
    log: { level: ClickHouseLogLevel.OFF },
    max_open_connections: options.max_open_connections ?? 16,
    clickhouse_settings: {
      ...v2ClientSettings,
      ...options.clickhouse_settings,
    },
  });
}

export async function ensureV2Schema(ch: ClickHouseClient): Promise<void> {
  for (const statement of warehouseV2DDL()) {
    await ch.command({ query: statement });
  }
  // ClickHouse 26.8 validates fresh projection definitions against compiled MergeTree
  // defaults, even for ADD IF NOT EXISTS. Existing definitions remain usable on smaller pools.
  const [projection] = await queryV2Json<{ installed: number; canInstall: number }>(
    ch,
    `SELECT EXISTS(SELECT 1 FROM system.projections WHERE database=currentDatabase()
        AND table='${v2Tables.logs}' AND name='geo_history_by_hour') AS installed,
      (SELECT value FROM system.metrics WHERE metric='BackgroundMergesAndMutationsPoolSize') >=
      (SELECT max(toUInt64(default)) FROM system.merge_tree_settings WHERE name IN (
        'number_of_free_entries_in_pool_to_execute_mutation',
        'number_of_free_entries_in_pool_to_lower_max_size_of_merge',
        'number_of_free_entries_in_pool_to_execute_optimize_entire_partition')) AS canInstall`,
    {},
  );
  // The alias expands to the exact expression indexed by legacy projections.
  // On new installations the stored column also serves exact reads without a projection.
  await ch.command({
    query: `ALTER TABLE ${v2Tables.logs} ADD COLUMN IF NOT EXISTS geo_history_row_hash
      UInt128 ${projection.installed ? 'ALIAS' : 'MATERIALIZED'} ${geoHistoryRowHash}`,
  });
  if (!projection.installed && projection.canInstall) {
    await ch.command({
      query: `ALTER TABLE ${v2Tables.logs} ADD PROJECTION IF NOT EXISTS geo_history_by_hour (
        SELECT website_id,epoch,hour,_deleted,count(),${geoLogFingerprint}
        GROUP BY website_id,epoch,hour,_deleted)`,
    });
  }
}

export async function queryV2Json<T>(
  ch: ClickHouseClient,
  query: string,
  queryParams: Record<string, unknown>,
  options?: {
    abortSignal?: AbortSignal;
    maxThreads?: number;
    maxMemoryBytes?: number;
    maxQuerySize?: number;
  },
): Promise<T[]> {
  const result = await ch.query({
    query,
    query_params: queryParams,
    format: 'JSONEachRow',
    abort_signal: options?.abortSignal,
    clickhouse_settings: {
      ...(options?.maxThreads ? { max_threads: options.maxThreads } : {}),
      ...(options?.maxMemoryBytes ? { max_memory_usage: String(options.maxMemoryBytes) } : {}),
      ...(options?.maxQuerySize ? { max_query_size: String(options.maxQuerySize) } : {}),
    },
  });
  return result.json<T>();
}

export async function insertV2Rows<T extends Record<string, unknown>>(
  ch: ClickHouseClient,
  table: string,
  rows: readonly T[],
  options?: {
    deduplicationToken?: string;
    asyncInsert?: boolean;
  },
): Promise<void> {
  if (!rows.length) return;
  await ch.insert({
    table,
    values: rows as T[],
    format: 'JSONEachRow',
    clickhouse_settings: {
      ...(options?.deduplicationToken
        ? { insert_deduplication_token: options.deduplicationToken }
        : {}),
      ...(options?.asyncInsert
        ? { async_insert: 1, wait_for_async_insert: 1 }
        : { async_insert: 0 }),
    },
  });
}
