import { createHash } from 'node:crypto';
import type { AiTx } from './ai-db';
import { crawlerTransaction } from './crawler-access';
import { AnalyticsRestart, AnalyticsUnavailable } from './analytics-budget';
import { LiekanError } from './errors';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key,v) => typeof v === 'bigint' ? v.toString() : v)).digest('hex');

/** CH computation holds no PG transaction. Revalidate the small control inputs
 * together before returning; fact publication itself is pinned by the CH reader. */
export async function warehouseControlRead<T>(
  work: (tx: AiTx) => Promise<T>,
  options: { deadline?: number; signal?: AbortSignal; stable?: (sql: string, rows: unknown[]) => unknown } = {},
) {
  const reads: { sql: string; args: unknown[]; digest: string }[] = [];
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
      reads.push({ sql, args, digest: digest(options.stable ? options.stable(sql, result) : result) });
      return result;
    },
    execute: async () => { throw new Error('warehouse-control-read-mutation'); },
  };
  const result = await work(tx);
  await execute(async current => {
    for (const read of reads) {
      remaining();
      const rows = await current.query(read.sql, ...read.args);
      if (digest(options.stable ? options.stable(read.sql, rows) : rows) !== read.digest) throw new AnalyticsRestart();
    }
  });
  return result;
}
