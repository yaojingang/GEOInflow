import { createHash } from 'node:crypto';
import { warehouseV2Enabled } from '../warehouse-v2/index';
import type { AiTx } from './ai-db';
import { crawlerTransaction } from './crawler-access';
import { AnalyticsRestart, AnalyticsUnavailable } from './analytics-budget';
import { LiekanError } from './errors';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key,v) => typeof v === 'bigint' ? v.toString() : v)).digest('hex');

/** CH computation holds no PG transaction. In v2, control inputs are read once
 * without replay unless the computed result will outlive this read. */
export async function warehouseControlRead<T>(
  work: (tx: AiTx) => Promise<T>,
  options: {
    deadline?: number;
    signal?: AbortSignal;
    verifyInput?: (sql: string) => boolean;
    stable?: (sql: string, rows: unknown[]) => unknown;
  } = {},
) {
  const reads: { sql: string; args: unknown[]; digest: string }[] = [];
  const verifyAll = !warehouseV2Enabled();
  const remaining = () => {
    if (options.signal?.aborted) throw new LiekanError('统计读取已取消', 499);
    const value = Math.min(5000, (options.deadline ?? Infinity) - Date.now());
    if (value <= 0) throw new AnalyticsUnavailable();
    return Math.floor(value);
  };
  const execute = async <V>(fn: (tx: AiTx) => Promise<V>) => {
    const timeout = remaining();
    return crawlerTransaction(fn, { timeout, transactionTimeout: timeout + 1000, maxWait: 1000 });
  };
  const tx: AiTx = {
    query: async <Row = Record<string, any>>(sql: string, ...args: unknown[]) => {
      if (reads.length >= 256) throw new AnalyticsUnavailable();
      const result = await execute(current => current.query<Row>(sql, ...args));
      if (verifyAll || options.verifyInput?.(sql)) {
        reads.push({
          sql,
          args,
          digest: digest(options.stable ? options.stable(sql, result) : result),
        });
      }
      return result;
    },
    execute: async () => {
      throw new Error('warehouse-control-read-mutation');
    },
  };
  const result = await work(tx);
  if (reads.length) {
    await execute(async current => {
      for (const read of reads) {
        remaining();
        const rows = await current.query(read.sql, ...read.args);
        if (digest(options.stable ? options.stable(read.sql, rows) : rows) !== read.digest)
          throw new AnalyticsRestart();
      }
    });
  }
  return result;
}
