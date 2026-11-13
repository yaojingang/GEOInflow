import { type ClickHouseClientConfigOptions, ClickHouseLogLevel, createClient } from '@clickhouse/client';
import { prepareQueryParameters } from './query-parameters';

export const warehouseSettings = {
  output_format_json_quote_64bit_integers: 1,
  output_format_json_quote_64bit_floats: 1,
  output_format_json_quote_decimals: 1,
  output_format_json_quote_denormals: 1,
  output_format_decimal_trailing_zeros: 1,
  date_time_output_format: 'simple',
  input_format_null_as_default: 0,
  input_format_skip_unknown_fields: 0,
  insert_null_as_default: 0,
  // Success must mean the buffered batch has been flushed, even when server-side
  // batching is enabled on the writer connection.
  wait_for_async_insert: 1,
} as const;

export function createWarehouseClient(options: ClickHouseClientConfigOptions) {
  const client = createClient({
    ...options,
    // SDK error logging includes SQL parameters. Applications emit fixed health
    // codes; visitor data and connection credentials must not enter diagnostics.
    log: { level: ClickHouseLogLevel.OFF },
    clickhouse_settings: { ...options.clickhouse_settings, ...warehouseSettings },
  });
  const query = client.query.bind(client);
  client.query = ((input: any) => query(prepareQueryParameters(input))) as typeof client.query;
  return client;
}
