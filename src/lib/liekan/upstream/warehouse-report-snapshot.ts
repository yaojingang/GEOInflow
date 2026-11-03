import { WarehouseReadReferences } from '../warehouse/read-reference';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { WarehouseReadBusy } from '../warehouse/read-admission';
import { warehouseReader } from '../warehouse/reader-runtime';
import { readReportingMetadata } from '../warehouse/reporting-context';
import { type ReportingMetadata, reportingParameters } from '../warehouse/reporting-relations';
import { AnalyticsRestart, AnalyticsUnavailable } from './analytics-budget';
import { processSingleton } from './process-singleton';

const snapshots = processSingleton(
  'warehouse-report-snapshot',
  () =>
    new AsyncLocalStorage<{
      metadata: Map<string, Promise<ReportingMetadata>>;
      references: WarehouseReadReferences;
    }>(),
);
export async function warehouseReportMetadata(site: string) {
  const context = snapshots.getStore();
  if (!context) return readReportingMetadata(warehouseReader().db, site);
  let pending = context.metadata.get(site);
  if (!pending) {
    pending = readReportingMetadata(warehouseReader().db, site).then(async metadata => {
      await context.references.pin(metadata.boundary);
      return metadata;
    });
    context.metadata.set(site, pending);
  }
  return pending;
}
export function warehouseControlFingerprint(m: ReportingMetadata) {
  // New fact publication may advance while the report retains its initial
  // pointer. A delete, policy change or a repair publication invalidates it.
  const { boundary, population: _population, ...rest } = m;
  return createHash('sha256')
    .update(JSON.stringify({ ...rest, boundary: { ...boundary, publication: '0' } }))
    .digest('hex');
}
export async function withinWarehouseReport<T>(work: () => Promise<T>): Promise<T> {
  if (snapshots.getStore()) return work();
  await warehouseReader().verifyIdentity();
  const references = new WarehouseReadReferences(warehouseReader().db);
  return snapshots
    .run({ metadata: new Map(), references }, async () => {
      const value = await work();
      for (const [site, pending] of snapshots.getStore().metadata) {
        const initial = await pending,
          current = await readReportingMetadata(warehouseReader().db, site);
        if (warehouseControlFingerprint(initial) !== warehouseControlFingerprint(current))
          throw new AnalyticsRestart();
      }
      await references.verify();
      return value;
    })
    .catch(error => {
      if (error instanceof WarehouseReadBusy) throw new AnalyticsUnavailable();
      throw error;
    })
    .finally(() => references.close());
}
export async function warehouseReportQuery<T = Record<string, unknown>>(
  site: string,
  sql: string,
  params: Record<string, unknown> = {},
  options: { signal?: AbortSignal; timeoutSeconds?: number } = {},
): Promise<T[]> {
  return withinWarehouseReport(async () => {
    const metadata = await warehouseReportMetadata(site);
    return warehouseReader().admission.run(() =>
      warehouseReader()
        .ch.query({
          query: sql,
          query_params: { ...params, ...reportingParameters(metadata) },
          format: 'JSONEachRow',
          abort_signal: AbortSignal.any([
            snapshots.getStore().references.signal,
            ...(options.signal ? [options.signal] : []),
          ]),
          ...(options.timeoutSeconds
            ? {
                clickhouse_settings: {
                  max_execution_time: Math.max(1, Math.min(55, options.timeoutSeconds)),
                },
              }
            : {}),
        })
        .then(r => r.json<T>()),
    );
  });
}

/** Consume one version-pinned query with bounded transport buffers. The admission
 * slot and control-version fence cover the complete stream, including callbacks. */
export async function warehouseReportStream<T extends Record<string, unknown>>(
  site: string,
  sql: string,
  params: Record<string, unknown>,
  consume: (rows: T[]) => Promise<void>,
  signal?: AbortSignal,
  longRunning = false,
) {
  return withinWarehouseReport(async () => {
    const metadata = await warehouseReportMetadata(site);
    const reader = warehouseReader();
    await (longRunning ? reader.exportAdmission : reader.admission).run(async () => {
      const result = await (longRunning ? reader.exportCH : reader.ch).query({
        query: sql,
        query_params: { ...params, ...reportingParameters(metadata) },
        format: 'JSONEachRow',
        abort_signal: AbortSignal.any([
          snapshots.getStore().references.signal,
          ...(signal ? [signal] : []),
        ]),
      });
      try {
        for await (const batch of result.stream<T>()) {
          if (signal?.aborted) throw new DOMException('Export canceled', 'AbortError');
          await consume(batch.map(row => row.json()));
        }
      } finally {
        result.close();
      }
    });
  });
}
