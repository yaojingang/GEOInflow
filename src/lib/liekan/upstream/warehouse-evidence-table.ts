import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { warehouseReportQuery, warehouseReportStream } from './warehouse-report-snapshot';

// Kept off the JSON contract. Readers expose a bounded page and the export path
// consumes the same complete query at its pinned publication boundary.
export const warehouseEvidenceRows = Symbol('warehouse-evidence-rows');
export const warehouseEvidenceSections = Symbol('warehouse-evidence-sections');
export type WarehouseEvidenceRows = {
  count(signal?: AbortSignal): Promise<number>;
  page(offset: number, limit: number, signal?: AbortSignal): Promise<any[]>;
  stream(consume: (rows: any[]) => Promise<void>, signal?: AbortSignal): Promise<void>;
  fingerprint(signal?: AbortSignal): Promise<string>;
  dispose?(): Promise<void>;
};
const resources = new AsyncLocalStorage<Set<WarehouseEvidenceRows>>();
export function registerWarehouseEvidenceRows<T extends WarehouseEvidenceRows>(source: T): T {
  resources.getStore()?.add(source);
  return source;
}
export async function withWarehouseEvidenceResources<T>(work: () => Promise<T>): Promise<T> {
  if (resources.getStore()) return work();
  const owned = new Set<WarehouseEvidenceRows>();
  return resources.run(owned, async () => {
    try {
      return await work();
    } finally {
      await Promise.allSettled([...owned].map(source => source.dispose?.()));
    }
  });
}
export function warehouseEvidenceTable(
  site: string,
  sql: string,
  params: Record<string, unknown>,
  order: string,
  map: (row: any) => any = row => row,
  fingerprintContext?: unknown,
): WarehouseEvidenceRows {
  let summary: Promise<{ total: number; hash: string }>;
  const summarize = (signal?: AbortSignal) =>
    (summary ??= warehouseReportQuery<{ total: string | number; rowHash: string }>(
      site,
      `SELECT count() AS total,toString(sum(reinterpretAsUInt256(SHA256(toJSONString(tuple(*)))))) AS rowHash FROM (${sql})`,
      params,
      { signal },
    ).then(([row]) => {
      const total = Number(row.total);
      if (!Number.isSafeInteger(total) || total < 0)
        throw new Error('warehouse-evidence-total-out-of-range');
      return {
        total,
        hash: createHash('sha256')
          .update(
            JSON.stringify([
              'row-sum-sha256-v1',
              row.total,
              row.rowHash,
              ...(fingerprintContext === undefined ? [] : [fingerprintContext]),
            ]),
          )
          .digest('hex'),
      };
    }));
  return registerWarehouseEvidenceRows({
    async count(signal) {
      return (await summarize(signal)).total;
    },
    async fingerprint(signal) {
      return (await summarize(signal)).hash;
    },
    async page(offset, limit, signal) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new Error('warehouse-evidence-page-out-of-range');
      return (
        await warehouseReportQuery(
          site,
          `${sql} ORDER BY ${order} LIMIT {evidenceLimit:UInt64} OFFSET {evidenceOffset:UInt64}`,
          { ...params, evidenceLimit: limit, evidenceOffset: offset },
          { signal },
        )
      ).map(map);
    },
    stream(consume, signal) {
      return warehouseReportStream(
        site,
        `${sql} ORDER BY ${order}`,
        params,
        batch => consume(batch.map(map)),
        signal,
        true,
      );
    },
  });
}
