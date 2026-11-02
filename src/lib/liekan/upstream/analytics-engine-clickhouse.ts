import { createHash } from 'node:crypto';
import { type ClickHouseClient, createClient } from '@clickhouse/client';

export const ENGINE_VERSION = 'liekan-log-projection-v1';
export const ENGINE_TABLE = 'liekan_log_projection_v1';
export const HOUR = 3600000;
export const projectionColumns = [
  'id',
  'created_at',
  'path',
  'status',
  'bot',
  'vendor',
  'bot_type',
  'verification',
  'ai_eligible',
  'recognition_state',
  'crawler_id',
  'catalog_version',
  'classification_version',
  'product_form',
  'self_check',
] as const;
export type Projection = Record<(typeof projectionColumns)[number], string | number | null>;
export const engineValueKey = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map(k => [k, item[k]]),
        )
      : item,
  );
let cached: { key: string; client: ClickHouseClient } | undefined;
export function engineConnection() {
  const raw = process.env.LIEKAN_ANALYTICS_CLICKHOUSE_URL;
  if (!raw) return null;
  const url = new URL(raw);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.search ||
    url.hash ||
    !/^\/[a-zA-Z_][a-zA-Z0-9_]*$/.test(url.pathname)
  )
    throw new Error('engine-invalid-connection');
  return {
    key: createHash('sha256').update(`${url.origin}${url.pathname}`).digest('hex'),
    clientKey: createHash('sha256').update(raw).digest('hex'),
    label: `${url.origin}${url.pathname}`,
    url,
  };
}
export function engineClient() {
  const config = engineConnection();
  if (!config) throw new Error('engine-unconfigured');
  if (cached?.key !== config.clientKey) {
    void cached?.client.close();
    cached = {
      key: config.clientKey,
      client: createClient({
        use_multipart_params_auto: true,
        url: config.url.origin,
        database: config.url.pathname.slice(1),
        username: decodeURIComponent(config.url.username || 'default'),
        password: decodeURIComponent(config.url.password),
        request_timeout: 5000,
        clickhouse_settings: {
          max_execution_time: 4,
          max_memory_usage: String(1024 ** 3),
          max_threads: 2,
          date_time_output_format: 'iso',
          output_format_json_quote_64bit_integers: 0,
        },
      }),
    };
  }
  return cached.client;
}
export async function engineQuery<T = Record<string, any>>(
  sql: string,
  params: Record<string, any> = {},
) {
  // Annual coverage has thousands of hourly generations. Bound each form field
  // below ClickHouse's default HTTP field limit while retaining one query.
  if (Array.isArray(params.generations) && params.generations.length > 1024) {
    params = { ...params };
    const generations = params.generations;
    delete params.generations;
    const parts: string[] = [];
    for (let offset = 0; offset < generations.length; offset += 1024) {
      const key = `generations_${offset / 1024}`;
      params[key] = generations.slice(offset, offset + 1024);
      parts.push(`{${key}:Array(UUID)}`);
    }
    sql = sql.replaceAll('{generations:Array(UUID)}', `arrayConcat(${parts.join(',')})`);
  }
  const result = await engineClient().query({
    query: sql,
    query_params: params,
    format: 'JSONEachRow',
  });
  return result.json<T>();
}
export async function initializeEngineTable() {
  await engineClient().command({
    query: `CREATE TABLE IF NOT EXISTS ${ENGINE_TABLE} (
    installation_id UUID,source_epoch UInt64,website_id UUID, generation UUID, bucket DateTime64(3,'UTC'), chunk UInt32, inserted_at DateTime64(3,'UTC') DEFAULT now64(3),
    id String, created_at DateTime64(6,'UTC'), path String, status UInt16,
    bot Nullable(String),vendor Nullable(String),bot_type Nullable(String),verification Nullable(String),
    ai_eligible Nullable(UInt8),recognition_state Nullable(String),crawler_id Nullable(String),
    catalog_version Nullable(String),classification_version Nullable(String),product_form Nullable(String),self_check UInt8
  ) ENGINE=MergeTree PARTITION BY toYYYYMM(bucket)
    ORDER BY (installation_id,website_id,bucket,generation,created_at,id)`,
  });
}
export function projectionDigest(rows: Projection[]) {
  return createHash('sha256')
    .update(rows.map(row => JSON.stringify(projectionColumns.map(key => row[key]))).join('\n'))
    .digest('hex');
}
export const chAi = "coalesce(ai_eligible,bot_type IN ('训练','搜索','用户触发'))";
export const chUnknown =
  "(coalesce(recognition_state IN ('unknown','ambiguous'),false) OR (isNull(recognition_state) AND bot='其他'))";
export function engineWindow(input: {
  startDate: Date;
  endDate: Date;
  crawlerMetricsVersion?: number;
}) {
  const start = +input.startDate,
    end = +input.endDate;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end > Math.floor((Date.now() - 30000) / HOUR) * HOUR ||
    end - start > 366 * 86400000
  )
    return null;
  const first = Math.floor(start / HOUR) * HOUR;
  const last = Math.floor((end - (input.crawlerMetricsVersion === 1 ? 0.001 : 0)) / HOUR) * HOUR;
  return {
    first: new Date(first),
    last: new Date(last),
    units: Math.round((last - first) / HOUR) + 1,
  };
}
export function supportedLogInput(input: {
  filters?: Record<string, unknown>;
  crawlerIdentityScope?: string;
  fields?: readonly string[];
}) {
  const fields = new Set(['summary', 'daily', 'bots', 'pages', 'statuses', 'hours']);
  if (input.fields?.some(field => !fields.has(field))) return false;
  const allowed = new Set([
    'resource',
    'botProductForm',
    'botCategory',
    'botType',
    'botId',
    'botName',
  ]);
  if (!['all', 'verified_range', 'verified_identity'].includes(input.crawlerIdentityScope || 'all'))
    return false;
  return Object.entries(input.filters || {}).every(
    ([key, value]) =>
      value == null ||
      (allowed.has(key) &&
        typeof value === 'string' &&
        (key !== 'botCategory' || value === 'other')),
  );
}
