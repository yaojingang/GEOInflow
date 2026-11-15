import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// Bounded identifiers and numeric counters only; never query text, parameters or rows.
type ReadTrace = {
  id: string;
  queries: number;
  authorizationMs: number;
  admissionMs: number;
  chMs: number;
  serializeMs: number;
  retries: number;
  queryIds: string[];
};
const traces = new AsyncLocalStorage<ReadTrace>();
export function noteReadRetry() {
  const t = traces.getStore();
  if (t) t.retries++;
}
export async function traceWarehouseRead<T>(
  run: (dispatch: () => Promise<T>) => Promise<T>,
  dispatch: (queryId: string) => Promise<T>,
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
      if (t) t.chMs += performance.now() - started;
    }
  });
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
export async function withReadDiagnostics(work: () => Promise<Response>) {
  if (traces.getStore()) return work();
  const trace: ReadTrace = {
    id: randomUUID(),
    queries: 0,
    authorizationMs: 0,
    admissionMs: 0,
    chMs: 0,
    serializeMs: 0,
    retries: 0,
    queryIds: [],
  };
  return traces.run(trace, async () => {
    const started = performance.now();
    const response = await work();
    response.headers.append(
      'Server-Timing',
      `read-auth;dur=${trace.authorizationMs.toFixed(1)},read-admission;dur=${trace.admissionMs.toFixed(1)},read-ch;dur=${trace.chMs.toFixed(1)},read-json;dur=${trace.serializeMs.toFixed(1)},read-queries;desc="${trace.queries}",read-restarts;desc="${trace.retries}"`,
    );
    response.headers.set('X-Liekan-Read-Id', trace.id);
    if (trace.queries || trace.retries)
      console.info(
        JSON.stringify({
          event: 'warehouse-report-read',
          ...trace,
          wallMs: Math.round(performance.now() - started),
          status: response.status,
          cache: response.headers.get('X-Liekan-Cache') ?? 'none',
        }),
      );
    return response;
  });
}
