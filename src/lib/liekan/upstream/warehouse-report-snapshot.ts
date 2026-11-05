import { WarehouseReadReferences } from '../warehouse/read-reference';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { WarehouseReadBusy } from '../warehouse/read-admission';
import { warehouseReader } from '../warehouse/reader-runtime';
import { readReportingMetadata } from '../warehouse/reporting-context';
import { type ReportingMetadata, reportingParameters } from '../warehouse/reporting-relations';
import { AnalyticsRestart, AnalyticsUnavailable } from './analytics-budget';
import { currentCacheContext, currentAnalyticsSignal } from './cache-context';
import { analyticsRemaining } from './analytics-deadline';
import { processSingleton } from './process-singleton';

const snapshots = processSingleton(
  'warehouse-report-snapshot',
  () =>
    new AsyncLocalStorage<{
      metadata: Map<string, Promise<ReportingMetadata>>;
      references: WarehouseReadReferences;
      signal: AbortSignal;
      deadline?: number;
      pending: Set<Promise<unknown>>;
    }>(),
);
export async function warehouseReportMetadata(site: string) {
  const context = snapshots.getStore();
  context?.signal.throwIfAborted();
  if (!context) return readReportingMetadata(warehouseReader().db, site);
  let pending = context.metadata.get(site);
  if (!pending) {
    pending = readReportingMetadata(warehouseReader().db, site).then(async metadata => {
      context.signal.throwIfAborted();
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
export function warehouseReportSignal() {
  return snapshots.getStore()?.signal ?? currentAnalyticsSignal();
}
interface ReportDeadline {
  deadline?: number;
  signal?: AbortSignal;
}
export async function withinWarehouseReport<T>(
  work: () => Promise<T>,
  options: ReportDeadline = {},
): Promise<T> {
  const parent = snapshots.getStore();
  const deadline = Math.min(
    parent?.deadline ?? Infinity,
    options.deadline ?? Infinity,
    currentCacheContext()?.deadline ?? Infinity,
  );
  const controller = new AbortController();
  const timeout = () =>
    controller.abort(
      new AnalyticsUnavailable(
        '统计查询超时，请缩小时间范围后重试',
        5,
        503,
        'analysis-query-timeout',
      ),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (Number.isFinite(deadline)) {
    if (deadline <= Date.now()) timeout();
    else {
      timer = setTimeout(timeout, deadline - Date.now());
      timer.unref?.();
    }
  }
  const references = parent?.references ?? new WarehouseReadReferences(warehouseReader().db);
  const context = {
    metadata: parent?.metadata ?? new Map<string, Promise<ReportingMetadata>>(),
    pending: parent?.pending ?? new Set<Promise<unknown>>(),
    references,
    deadline: Number.isFinite(deadline) ? deadline : undefined,
    signal: AbortSignal.any([
      controller.signal,
      references.signal,
      ...[parent?.signal, options.signal, currentAnalyticsSignal()].filter(
        (s): s is AbortSignal => !!s,
      ),
    ]),
  };
  try {
    return await snapshots.run(context, async () => {
      context.signal.throwIfAborted();
      if (!parent) await warehouseReader().verifyIdentity();
      context.signal.throwIfAborted();
      const value = await work();
      if (!parent) await Promise.all([...context.pending]);
      context.signal.throwIfAborted();
      if (!parent) {
        for (const [site, pending] of context.metadata) {
          const initial = await pending,
            current = await readReportingMetadata(warehouseReader().db, site);
          if (warehouseControlFingerprint(initial) !== warehouseControlFingerprint(current))
            throw new AnalyticsRestart();
        }
        await references.verify();
      }
      context.signal.throwIfAborted();
      return value;
    });
  } catch (error) {
    const failure = context.signal.aborted
      ? context.signal.reason
      : error instanceof WarehouseReadBusy
        ? new AnalyticsUnavailable()
        : error;
    controller.abort(failure);
    throw failure;
  } finally {
    clearTimeout(timer);
    // Do not race work against a timer: references and admission remain held
    // until the aborted HTTP query/stream has actually settled.
    if (!parent) {
      await Promise.allSettled([...context.pending, ...context.metadata.values()]);
      await references.close();
    }
  }
}
function querySettings(timeoutSeconds?: number) {
  const context = snapshots.getStore();
  context.signal.throwIfAborted();
  const remaining =
    context.deadline === undefined
      ? undefined
      : Math.max(1, Math.ceil(analyticsRemaining(context.deadline, true) / 1000));
  const seconds = Math.min(timeoutSeconds ?? Infinity, remaining ?? Infinity);
  return {
    readonly: '2',
    cancel_http_readonly_queries_on_client_close: 1 as const,
    ...(Number.isFinite(seconds) ? { max_execution_time: Math.max(1, seconds) } : {}),
  };
}
function trackRead<T>(work: () => Promise<T>): Promise<T> {
  const pending = snapshots.getStore().pending;
  const promise = work();
  pending.add(promise);
  void promise.finally(() => pending.delete(promise)).catch(() => {});
  return promise;
}
export async function warehouseReportQuery<T = Record<string, unknown>>(
  site: string,
  sql: string,
  params: Record<string, unknown> = {},
  options: { signal?: AbortSignal; timeoutSeconds?: number } = {},
): Promise<T[]> {
  return withinWarehouseReport(
    () =>
      trackRead(async () => {
        const metadata = await warehouseReportMetadata(site);
        return warehouseReader().admission.run(
          () =>
            warehouseReader()
              .ch.query({
                query: sql,
                query_params: { ...params, ...reportingParameters(metadata) },
                format: 'JSONEachRow',
                abort_signal: snapshots.getStore().signal,
                clickhouse_settings: querySettings(Math.min(55, options.timeoutSeconds ?? 55)),
              })
              .then(r => r.json<T>()),
          snapshots.getStore().signal,
          snapshots.getStore().deadline,
        );
      }),
    { signal: options.signal },
  );
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
  return withinWarehouseReport(
    () =>
      trackRead(async () => {
        const metadata = await warehouseReportMetadata(site);
        const reader = warehouseReader();
        await (longRunning ? reader.exportAdmission : reader.admission).run(
          async () => {
            const result = await (longRunning ? reader.exportCH : reader.ch).query({
              query: sql,
              query_params: { ...params, ...reportingParameters(metadata) },
              format: 'JSONEachRow',
              abort_signal: snapshots.getStore().signal,
              clickhouse_settings: querySettings(longRunning ? undefined : 55),
            });
            try {
              for await (const batch of result.stream<T>()) {
                snapshots.getStore().signal.throwIfAborted();
                await consume(batch.map(row => row.json()));
              }
            } finally {
              result.close();
            }
          },
          snapshots.getStore().signal,
          snapshots.getStore().deadline,
        );
      }),
    { signal },
  );
}
