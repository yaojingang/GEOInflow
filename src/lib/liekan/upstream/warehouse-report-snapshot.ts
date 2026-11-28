import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { analysisReadParameters } from '../warehouse/analysis-context';
import type { ReadBoundary } from '../warehouse/read';
import { WarehouseReadBusy } from '../warehouse/read-admission';
import { WarehouseReadReferences } from '../warehouse/read-reference';
import { warehouseReader } from '../warehouse/reader-runtime';
import { readReportingMetadata } from '../warehouse/reporting-context';
import { type ReportingMetadata, reportingParameters } from '../warehouse/reporting-relations';
import { warehouseV2Enabled } from '../warehouse-v2/index';
import { AnalyticsRestart, AnalyticsUnavailable } from './analytics-budget';
import { noteBackgroundInterval, noteReportTiming } from './analysis-diagnostics';
import { analyticsRemaining } from './analytics-deadline';
import { currentAnalyticsSignal, currentCacheContext } from './cache-context';
import { processSingleton } from './process-singleton';
import { traceSerialization, traceWarehouseRead, type ReadStage } from './report-read-diagnostics';
import { cachedRoundMetric, memoRoundMetric } from './warehouse-round-metrics';
import { WarehouseBackgroundBudget } from './warehouse-background-budget';
import { warehouseIngestionPressure } from './warehouse-ingestion-pressure';

const snapshots = processSingleton(
  'warehouse-report-snapshot',
  () =>
    new AsyncLocalStorage<{
      metadata: Map<string, Promise<ReportingMetadata>>;
      references: WarehouseReadReferences;
      signal: AbortSignal;
      deadline?: number;
      background?: boolean;
      publication?: Pick<ReadBoundary, 'websiteId' | 'publication'>;
      pending: Set<Promise<unknown>>;
      memo: Map<string, Promise<unknown>>;
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
      const pin = context.publication;
      if (pin?.websiteId === site) {
        if (BigInt(pin.publication) > BigInt(metadata.boundary.publication))
          throw new AnalyticsRestart();
        metadata = {
          ...metadata,
          boundary: { ...metadata.boundary, publication: pin.publication },
        };
      }
      if (!warehouseV2Enabled()) {
        await context.references.pin(metadata.boundary);
      }
      return metadata;
    });
    context.metadata.set(site, pending);
  }
  return pending;
}
export function warehouseControlFingerprint(m: ReportingMetadata) {
  // New fact publication may advance while the report retains its initial
  // pointer. A delete, policy change or a repair publication invalidates it.
  const { boundary, population: _population, logRevision: _logRevision, ...rest } = m;
  return createHash('sha256')
    .update(JSON.stringify({ ...rest, boundary: { ...boundary, publication: '0' } }))
    .digest('hex');
}

// Small exact metadata only. Every lookup still enters the request's protected
// boundary and final control/permission checks; this never caches visitor rows.
const frozenCounts = processSingleton(
  'warehouse-frozen-counts',
  () => new Map<string, { count: number; until: number }>(),
);
export async function frozenCountKey(site: string, query: string, params: Record<string, unknown>) {
  const metadata = await warehouseReportMetadata(site);
  return createHash('sha256')
    .update(
      JSON.stringify([
        metadata.boundary,
        warehouseControlFingerprint(metadata),
        query,
        Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest('hex');
}
export function readFrozenCount(key: string) {
  const saved = frozenCounts.get(key);
  if (saved && saved.until > Date.now()) return saved.count;
  frozenCounts.delete(key);
}
export function saveFrozenCount(key: string, count: number) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('warehouse-counter-out-of-range');
  while (frozenCounts.size >= 256) frozenCounts.delete(frozenCounts.keys().next().value);
  frozenCounts.set(key, { count, until: Date.now() + 15 * 60000 });
}
export function warehouseReportSignal() {
  return snapshots.getStore()?.signal ?? currentAnalyticsSignal();
}
interface ReportDeadline {
  background?: boolean;
  deadline?: number;
  signal?: AbortSignal;
  publication?: Pick<ReadBoundary, 'websiteId' | 'publication'>;
}
export async function withinWarehouseReport<T>(
  work: () => Promise<T>,
  options: ReportDeadline = {},
): Promise<T> {
  const ambient = snapshots.getStore();
  // A saved ranking owns an older publication. Give that subread its own
  // metadata and references while inheriting cancellation and the deadline.
  const parent = options.publication ? undefined : ambient;
  const deadline = Math.min(
    ambient?.deadline ?? Infinity,
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
    memo: parent?.memo ?? new Map<string, Promise<unknown>>(),
    references,
    background: ambient?.background || options.background,
    deadline: Number.isFinite(deadline) ? deadline : undefined,
    publication: parent?.publication ?? options.publication,
    signal: AbortSignal.any([
      controller.signal,
      references.signal,
      ...[ambient?.signal, options.signal, currentAnalyticsSignal()].filter(
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
      if (!parent && !warehouseV2Enabled()) {
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
      if (!warehouseV2Enabled()) await references.close();
    }
  }
}

/** Reuse common evidence only inside one protected report boundary, never across
 * users, independent HTTP reads or publications. Callers receive their own copy. */
export function forgetWarehouseReportMemo(key: string, prefix = false) {
  const memo = snapshots.getStore()?.memo;
  if (prefix) {
    for (const candidate of memo?.keys() ?? [])
      if (candidate.startsWith(key)) memo.delete(candidate);
  } else memo?.delete(key);
}
export async function cachedWarehouseReport<T>(key: string, round = false) {
  const value = snapshots.getStore()?.memo.get(key) as Promise<T> | undefined;
  return value
    ? { value: structuredClone(await value) }
    : round
      ? cachedRoundMetric<T>(key)
      : undefined;
}
export async function memoWarehouseReport<T>(
  key: string,
  load: () => Promise<T>,
  options?: { round?: boolean },
): Promise<T> {
  const context = snapshots.getStore();
  if (!context) return withinWarehouseReport(() => memoWarehouseReport(key, load, options));
  let value = context.memo.get(key) as Promise<T> | undefined;
  if (!value) {
    // Explicitly selected aggregates may share the protected round. The round
    // store enforces byte/entry bounds; arbitrary request memos stay local.
    value = options?.round ? memoRoundMetric(key, load) : load();
    context.memo.set(key, value);
    void value.catch(() => context.memo.delete(key));
  }
  return structuredClone(await value);
}
function querySettings(timeoutSeconds?: number, longRunning = false) {
  const context = snapshots.getStore();
  context.signal.throwIfAborted();
  const remaining =
    context.deadline === undefined
      ? undefined
      : Math.max(1, Math.ceil(analyticsRemaining(context.deadline, true) / 1000));
  const seconds = Math.min(timeoutSeconds ?? Infinity, remaining ?? Infinity);
  return {
    readonly: '2',
    workload: context.background || longRunning ? 'liekan_background' : 'liekan_interactive',
    ...(context.background ? { max_threads: 1 } : {}),
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

const backgroundBudget = processSingleton(
  'warehouse-background-budget',
  () =>
    new WarehouseBackgroundBudget(
      warehouseIngestionPressure(() => warehouseReader().db),
      (stage, ms) => {
        noteReportTiming(stage, ms);
        if (stage === 'query-execution') noteBackgroundInterval(stage, ms);
      },
    ),
);
export const warehouseBackgroundClaimAfter = (reportClaim = false) =>
  backgroundBudget.claimAfter(reportClaim);
export const warehouseFairClaimDue = () => backgroundBudget.fairClaimDue;
export const withWarehouseReportClaim = <T>(work: () => Promise<T>) =>
  backgroundBudget.withClaim(work);

export async function warehouseReportCheckpoint(store?: {
  deferUntil(value: number): Promise<void>;
}) {
  const context = snapshots.getStore();
  if (context?.background)
    await backgroundBudget.checkpoint(context.signal, store && (value => store.deferUntil(value)));
}

function dispatchRead<T>(work: () => Promise<T>, longRunning = false) {
  const reader = warehouseReader(),
    context = snapshots.getStore();
  const admit = (execute: () => Promise<T>) =>
    (longRunning ? reader.exportAdmission : reader.admission).run(
      execute,
      context.signal,
      context.deadline,
    );
  return context.background
    ? backgroundBudget.run(work, context.signal, context.deadline, admit)
    : admit(work);
}

/** Derived tables share the report's pinned publication, deadline and admission. */
export async function warehouseReportCommand(
  site: string,
  sql: string,
  params: Record<string, unknown>,
  timeoutSeconds: number,
) {
  return withinWarehouseReport(() =>
    trackRead(async () => {
      const metadata = await warehouseReportMetadata(site);
      const reader = warehouseReader();
      const context = snapshots.getStore();
      const { readonly: _readonly, ...settings } = querySettings(timeoutSeconds);
      return dispatchRead(() =>
        reader.ch.command({
          query: sql,
          query_params: {
            ...params,
            ...reportingParameters(metadata),
            ...analysisReadParameters(),
          },
          abort_signal: context.signal,
          clickhouse_settings: {
            ...settings,
            wait_end_of_query: 1,
            async_insert: 0,
            read_overflow_mode: 'throw',
            group_by_overflow_mode: 'throw',
            timeout_overflow_mode: 'throw',
          },
        }),
      );
    }),
  );
}
type ReportReadOptions = { signal?: AbortSignal; timeoutSeconds?: number; traceStage?: ReadStage };

export async function warehouseReportQuery<T = Record<string, unknown>>(
  site: string,
  sql: string,
  params: Record<string, unknown> = {},
  options: ReportReadOptions = {},
): Promise<T[]> {
  return warehouseReportResponse<T[]>(site, sql, params, 'JSONEachRow', options);
}

/** Native adapters use the same cancellation, deadline, reference and admission
 * path; JSON retains the upstream numeric type metadata. */
export async function warehouseReportResponse<T>(
  site: string,
  sql: string,
  params: Record<string, unknown>,
  format: 'JSON' | 'JSONEachRow',
  options: ReportReadOptions = {},
): Promise<T> {
  return withinWarehouseReport(
    () =>
      trackRead(async () => {
        const metadata = await warehouseReportMetadata(site),
          context = snapshots.getStore();
        return traceWarehouseRead(
          dispatch => dispatchRead(dispatch),
          async queryId => {
            const result = await warehouseReader().ch.query({
              query: sql,
              query_id: queryId,
              query_params: {
                ...params,
                ...reportingParameters(metadata),
                ...analysisReadParameters(),
              },
              format,
              abort_signal: context.signal,
              clickhouse_settings: {
                ...querySettings(Math.min(55, options.timeoutSeconds ?? 55)),
                group_by_use_nulls: 1,
              },
            });
            try {
              return (await traceSerialization(() => result.json())) as T;
            } finally {
              result.close?.();
            }
          },
          options.traceStage,
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
  traceStage?: ReadStage,
) {
  return withinWarehouseReport(
    () =>
      trackRead(async () => {
        const metadata = await warehouseReportMetadata(site);
        const reader = warehouseReader();
        await traceWarehouseRead(
          dispatch => dispatchRead(dispatch, longRunning),
          async queryId => {
            const result = await (longRunning ? reader.exportCH : reader.ch).query({
              query: sql,
              query_id: queryId,
              query_params: {
                ...params,
                ...reportingParameters(metadata),
                ...analysisReadParameters(),
              },
              format: 'JSONEachRow',
              abort_signal: snapshots.getStore().signal,
              clickhouse_settings: querySettings(longRunning ? undefined : 55, longRunning),
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
          traceStage,
        );
      }),
    { signal },
  );
}
