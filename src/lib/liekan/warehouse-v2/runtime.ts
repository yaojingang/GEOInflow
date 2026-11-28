import type { ClickHouseClient } from '@clickhouse/client';
import pg from 'pg';
import { createV2ClickHouseClient, ensureV2Schema } from './client';
import {
  createV2BrowserBatcher,
  createV2LogBatcher,
  type V2BrowserEventRow,
  type V2LogRow,
  WarehouseV2Batcher,
} from './ingest';
import { v2Tables } from './schema';

const { Pool } = pg;

export function warehouseV2Enabled(): boolean {
  if (process.env.CLICKHOUSE_URL) return false;
  if (process.env.LIEKAN_WAREHOUSE_V2 === '0' || process.env.LIEKAN_WAREHOUSE_V2 === 'false') {
    return false;
  }
  return (
    process.env.LIEKAN_ANALYTICS_BACKEND === 'clickhouse' ||
    process.env.LIEKAN_WAREHOUSE_V2 === '1' ||
    process.env.LIEKAN_WAREHOUSE_V2 === 'true'
  );
}

export type WarehouseV2Runtime = {
  ch: ClickHouseClient;
  pg: pg.Pool;
  logBatcher: WarehouseV2Batcher<V2LogRow>;
  browserBatcher: WarehouseV2Batcher<V2BrowserEventRow>;
  eventDataBatcher: WarehouseV2Batcher<Record<string, unknown>>;
  revenueBatcher: WarehouseV2Batcher<Record<string, unknown>>;
  sessionDataBatcher: WarehouseV2Batcher<Record<string, unknown>>;
  sessionLinkBatcher: WarehouseV2Batcher<Record<string, unknown>>;
  ensureReady: () => Promise<void>;
  close: () => Promise<void>;
};

const GLOBAL_KEY = Symbol.for('liekan.warehouse-v2-runtime.v1');
const globalHolder = globalThis as typeof globalThis & { [GLOBAL_KEY]?: WarehouseV2Runtime };

function parseClickHouseConfig() {
  const rawUrl = process.env.LIEKAN_CLICKHOUSE_URL;
  if (!rawUrl) throw new Error('warehouse-v2-clickhouse-url-missing');
  const url = new URL(rawUrl);
  const username = url.username
    ? decodeURIComponent(url.username)
    : (process.env.LIEKAN_CLICKHOUSE_USERNAME ?? 'default');
  const password = url.password
    ? decodeURIComponent(url.password)
    : (process.env.LIEKAN_CLICKHOUSE_PASSWORD ?? '');
  url.username = '';
  url.password = '';
  return {
    url: url.toString(),
    username,
    password,
    database: process.env.LIEKAN_CLICKHOUSE_DATABASE ?? 'liekan',
  };
}

export function createWarehouseV2Runtime(config?: {
  databaseURL?: string;
  clickhouseURL?: string;
  clickhouseDatabase?: string;
  clickhouseUsername?: string;
  clickhousePassword?: string;
  logFlushMs?: number;
  browserFlushMs?: number;
}): WarehouseV2Runtime {
  const databaseURL = config?.databaseURL ?? process.env.DATABASE_URL;
  if (!databaseURL) throw new Error('warehouse-v2-database-url-missing');

  const chCfg = config?.clickhouseURL
    ? {
        url: config.clickhouseURL,
        username: config.clickhouseUsername ?? 'default',
        password: config.clickhousePassword ?? '',
        database: config.clickhouseDatabase ?? 'liekan',
      }
    : parseClickHouseConfig();

  const ch = createV2ClickHouseClient({
    url: chCfg.url,
    username: chCfg.username,
    password: chCfg.password,
    database: chCfg.database,
    request_timeout: 60_000,
    max_open_connections: Number(process.env.LIEKAN_V2_CH_CONNECTIONS ?? 16),
  });

  const pgPool = new Pool({
    connectionString: databaseURL,
    max: Number(process.env.LIEKAN_V2_PG_POOL_MAX ?? 24),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  const logFlushMs = config?.logFlushMs ?? Number(process.env.LIEKAN_V2_LOG_FLUSH_MS ?? 100);
  const browserFlushMs =
    config?.browserFlushMs ?? Number(process.env.LIEKAN_V2_BROWSER_FLUSH_MS ?? 80);

  const logBatcher = createV2LogBatcher(ch, { flushMs: logFlushMs, maxRows: 2000 });
  const browserBatcher = createV2BrowserBatcher(ch, { flushMs: browserFlushMs, maxRows: 1000 });
  const eventDataBatcher = new WarehouseV2Batcher<Record<string, unknown>>(ch, v2Tables.eventData, {
    flushMs: 100,
    maxRows: 2000,
  });
  const revenueBatcher = new WarehouseV2Batcher<Record<string, unknown>>(ch, v2Tables.revenue, {
    flushMs: 100,
    maxRows: 1000,
  });
  const sessionDataBatcher = new WarehouseV2Batcher<Record<string, unknown>>(
    ch,
    v2Tables.sessionData,
    { flushMs: 100, maxRows: 1000 },
  );
  const sessionLinkBatcher = new WarehouseV2Batcher<Record<string, unknown>>(
    ch,
    v2Tables.sessionLink,
    { flushMs: 100, maxRows: 1000 },
  );

  let readyPromise: Promise<void> | undefined;

  return {
    ch,
    pg: pgPool,
    logBatcher,
    browserBatcher,
    eventDataBatcher,
    revenueBatcher,
    sessionDataBatcher,
    sessionLinkBatcher,
    ensureReady() {
      if (!readyPromise) {
        readyPromise = ensureV2Schema(ch).catch(err => {
          readyPromise = undefined;
          throw err;
        });
      }
      return readyPromise;
    },
    async close() {
      await Promise.allSettled([
        logBatcher.close(),
        browserBatcher.close(),
        eventDataBatcher.close(),
        revenueBatcher.close(),
        sessionDataBatcher.close(),
        sessionLinkBatcher.close(),
      ]);
      await Promise.allSettled([ch.close(), pgPool.end()]);
    },
  };
}

export function warehouseV2Runtime(): WarehouseV2Runtime {
  if (!globalHolder[GLOBAL_KEY]) {
    globalHolder[GLOBAL_KEY] = createWarehouseV2Runtime();
  }
  return globalHolder[GLOBAL_KEY];
}

export async function closeWarehouseV2Runtime(): Promise<void> {
  const current = globalHolder[GLOBAL_KEY];
  delete globalHolder[GLOBAL_KEY];
  await current?.close();
}
