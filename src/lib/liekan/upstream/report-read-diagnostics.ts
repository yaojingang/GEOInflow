import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { withControlReadTiming } from '../warehouse/control-db';

export type ReadStage =
  | 'analysis-coverage'
  | 'analysis-proof'
  | 'log-extent'
  | 'log-page'
  | 'browser-population'
  | 'overview-browser-window'
  | 'overview-log-aggregate'
  | 'log-window-presence'
  | 'log-trend';

// Bounded identifiers and numeric counters only; never query text, parameters or rows.
type ReadTrace = {
  id: string;
  queries: number;
  snapshotMs: number;
  pgReadMs: number;
  pgPoolMs: number;
  authorizationMs: number;
  admissionMs: number;
  chMs: number;
  serializeMs: number;
  retries: number;
  queryIds: string[];
  queryStages: { id: string; stage: ReadStage; ms: number }[];
};
const traces = new AsyncLocalStorage<ReadTrace>();
export function noteReadRetry() {
  const t = traces.getStore();
  if (t) t.retries++;
}
export async function traceWarehouseRead<T>(
  run: (dispatch: () => Promise<T>) => Promise<T>,
  dispatch: (queryId: string) => Promise<T>,
  stage?: ReadStage,
) {
  const t = traces.getStore(),
    id = `liekan-read-${randomUUID()}`,
    queued = performance.now();
  if (t) {
    t.queries++;
    if (t.queryIds.length < 32) t.queryIds.push(id);
  }
  return run(async () => {
    if (t) t.admissionMs += performance.now() - queued;
    const started = performance.now();
    try {
      return await dispatch(id);
    } finally {
      if (t) {
        const ms = performance.now() - started;
        t.chMs += ms;
        if (stage && t.queryStages.length < 32)
          t.queryStages.push({ id, stage, ms: Math.round(ms * 10) / 10 });
      }
    }
  });
}
/** Time spent reading persisted snapshot candidates, including the PG round trip. */
export async function traceSummarySnapshot<T>(work: () => Promise<T>) {
  const t = traces.getStore();
  const started = performance.now();
  try {
    return await work();
  } finally {
    if (t) t.snapshotMs += performance.now() - started;
  }
}
export async function traceReadAuthorization<T>(work: () => Promise<T>) {
  const started = performance.now();
  try {
    return await work();
  } finally {
    const t = traces.getStore();
    if (t) t.authorizationMs += performance.now() - started;
  }
}
export async function traceSerialization<T>(work: () => Promise<T>) {
  const started = performance.now();
  try {
    return await work();
  } finally {
    const t = traces.getStore();
    if (t) t.serializeMs += performance.now() - started;
  }
}
export async function withReadDiagnostics(
  work: () => Promise<Response>,
  traceSnapshotReads = false,
) {
  if (traces.getStore()) return work();
  const trace: ReadTrace = {
    id: randomUUID(),
    queries: 0,
    snapshotMs: 0,
    pgReadMs: 0,
    pgPoolMs: 0,
    authorizationMs: 0,
    admissionMs: 0,
    chMs: 0,
    serializeMs: 0,
    retries: 0,
    queryIds: [],
    queryStages: [],
  };
  return traces.run(trace, async () => {
    const started = performance.now();
    const response = await (traceSnapshotReads
      ? withControlReadTiming((queued, sql) => {
          trace.pgPoolMs += queued;
          trace.pgReadMs += sql;
        }, work)
      : work());
    response.headers.append(
      'Server-Timing',
      `read-auth;dur=${trace.authorizationMs.toFixed(1)},read-admission;dur=${trace.admissionMs.toFixed(1)},read-ch;dur=${trace.chMs.toFixed(1)},read-pg-pool;dur=${trace.pgPoolMs.toFixed(1)},read-pg-sql;dur=${trace.pgReadMs.toFixed(1)},read-snapshot;dur=${trace.snapshotMs.toFixed(1)},read-json;dur=${trace.serializeMs.toFixed(1)},read-queries;desc="${trace.queries}",read-restarts;desc="${trace.retries}"`,
    );
    response.headers.set('X-Liekan-Read-Id', trace.id);
    if (trace.queries || trace.retries || traceSnapshotReads)
      console.info(
        JSON.stringify({
          event: 'warehouse-report-read',
          ...trace,
          wallMs: Math.round(performance.now() - started),
          status: response.status,
          cache:
            response.headers.get('X-Liekan-Cache') ??
            response.headers.get('X-Liekan-Read-Path') ??
            'none',
        }),
      );
    return response;
  });
}
