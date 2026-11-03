import { AsyncLocalStorage } from 'node:async_hooks';
import { LiekanError } from './errors';

export const reportQueryGroups = [
  'human',
  'logs',
  'settings',
  'today-logs',
  'today-conversions',
  'content-impact',
  'monthly-ai',
  'plot-human',
  'plot-logs',
] as const;
type QueryGroup = (typeof reportQueryGroups)[number];
type GroupTiming = { wallMs: number; calls: number; failures: number };
export type ReportTimings = Partial<Record<QueryGroup, GroupTiming>>;
const reports = new AsyncLocalStorage<ReportTimings>();
const wallMs = (value: number) => Math.round(Math.max(0, value) * 10) / 10;
export const analysisTargetCategory = (target: string) =>
  ({
    'feature:page-report': 'page-report',
    'feature:analytics': 'analytics',
    'feature:journeys': 'journeys',
  })[target] || (target.startsWith('native:') ? 'native' : 'unknown');
const taskId = (id: string) => (/^[a-f0-9-]{36}$/i.test(id) ? id : 'unknown');

/** Only closed categories cross the diagnostics boundary; exception text stays private. */
export function analysisErrorReason(error: unknown) {
  const detail = error as {
    code?: unknown;
    cause?: { code?: unknown };
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  const code = detail?.code;
  if (code === 'analysis-source-expired') return 'source-expired';
  if (code === 'analysis-capacity-limited') return 'capacity';
  if (
    code === 'P2028' ||
    code === 'analysis-query-timeout' ||
    [
      code,
      detail?.cause?.code,
      detail?.meta?.code,
      detail?.meta?.driverAdapterError?.cause?.originalCode,
    ].includes('57014')
  )
    return 'timeout';
  if (error instanceof LiekanError) {
    if ([401, 403, 404].includes(error.status)) return 'authorization';
    if (error.status === 410) return 'invalidated-or-lease-lost';
    if ([400, 413].includes(error.status)) return 'input-or-result-limit';
    if (error.status === 503) return 'unavailable';
  }
  return 'compute-failed';
}

export async function captureReportTimings<T>(work: () => Promise<T>, timings: ReportTimings = {}) {
  return reports.run(timings, work);
}
/** Includes promise/connection queuing within the existing report transaction, in wall-clock ms. */
export async function timeReportQuery<T>(group: QueryGroup, work: () => Promise<T>): Promise<T> {
  const timings = reports.getStore();
  if (!timings) return work();
  const start = performance.now();
  let failed = false;
  try {
    return await work();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const timing = (timings[group] ||= { wallMs: 0, calls: 0, failures: 0 });
    timing.wallMs = wallMs(timing.wallMs + performance.now() - start);
    timing.calls++;
    if (failed) timing.failures++;
  }
}
export const reportServerTiming = (timings: ReportTimings) =>
  reportQueryGroups
    .filter(group => timings[group])
    .map(group => `report-${group};dur=${timings[group].wallMs.toFixed(1)};desc="wall-clock"`)
    .join(',');

type AttemptRow = {
  id: string;
  target: string;
  attempts: number;
  queued_at: Date;
  started_at: Date | null;
};
/** One bounded record per owned compute attempt, including failed publication and recovery. */
export function analysisAttemptDiagnostics(
  row: AttemptRow,
  nextAttemptAt: Date | null,
  executionPath: 'worker' | 'foreground' = 'worker',
) {
  const start = performance.now();
  const groups: ReportTimings = {};
  let computeMs = 0,
    publishMs = 0;
  let sourceState = 'unobserved';
  const delta = (from: Date | null) =>
    from && row.started_at ? wallMs(+new Date(row.started_at) - +new Date(from)) : null;
  return {
    async compute<T>(work: () => Promise<T>) {
      const started = performance.now();
      try {
        return await captureReportTimings(work, groups);
      } finally {
        computeMs += performance.now() - started;
      }
    },
    async publish<T>(work: () => Promise<T>) {
      const started = performance.now();
      try {
        return await work();
      } finally {
        publishMs += performance.now() - started;
      }
    },
    sources(results: Array<{ status: string; expiresAt: number }>) {
      if (!results.length) return;
      sourceState = results.some(result => result.expiresAt <= Date.now())
        ? 'expired'
        : results.some(result => result.status === 'miss')
          ? 'computed'
          : results.some(result => result.status === 'coalesced')
            ? 'coalesced'
            : 'hit';
    },
    finish(error?: unknown, recoveryFailed = false) {
      console.info(
        JSON.stringify({
          event: 'analysis-attempt',
          executionPath,
          taskId: taskId(row.id),
          target: analysisTargetCategory(row.target),
          attempt: row.attempts,
          attemptKind: row.attempts === 1 ? 'first' : 'retry',
          queuedAt: row.queued_at,
          startedAt: row.started_at,
          finishedAt: new Date().toISOString(),
          firstQueueWaitWallMs: row.attempts === 1 ? delta(row.queued_at) : null,
          retryEligibleWaitWallMs: row.attempts > 1 ? delta(nextAttemptAt) : null,
          computeWallMs: wallMs(computeMs),
          publishWallMs: wallMs(publishMs),
          attemptWallMs: wallMs(performance.now() - start),
          sourceResultState: sourceState,
          outcome: error ? 'failed' : 'ready',
          reason: error ? analysisErrorReason(error) : 'none',
          recoveryFailed,
          queryGroups: groups,
        }),
      );
    },
  };
}

const contention = new Map<string, { count: number; start: number }>();
/** Queue redeliveries form a bounded cycle. Emit one summary at acquisition or exhaustion. */
export function noteAnalysisDelivery(
  job: { id: string; retryCount: number; retryLimit?: number; data: { id: string } },
  acquired: boolean,
  retryDelivery: boolean,
) {
  const now = performance.now();
  for (const [id, entry] of contention) if (now - entry.start > 120000) contention.delete(id);
  let entry = contention.get(job.id);
  if (retryDelivery) {
    if (!entry) {
      if (contention.size >= 128) contention.delete(contention.keys().next().value);
      entry = { count: 0, start: now };
      contention.set(job.id, entry);
    }
    entry.count++;
  }
  if (entry && (acquired || !retryDelivery || job.retryCount >= (job.retryLimit ?? 10))) {
    contention.delete(job.id);
    console.info(
      JSON.stringify({
        event: 'analysis-admission',
        taskId: taskId(job.data.id),
        contendedDeliveries: entry.count,
        cycleWallMs: wallMs(now - entry.start),
        outcome: acquired ? 'acquired' : retryDelivery ? 'exhausted' : 'released',
      }),
    );
  }
}
