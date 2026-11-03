'use client';
import { analysisAcceptedSchema, type AnalysisJob } from '../contracts/analysis-acceleration';

const privateTaskPath =
  /^\/liekan\/websites\/[a-f0-9-]{36}\/analytics-jobs\/[a-f0-9-]{36}(\/result)?$/i;

type Pending = { job?: AnalysisJob; websiteId: string; paused: boolean; resume?: () => void };
const pending = new Map<string, Pending>();
const listeners = new Set<() => void>();
let snapshot = '[]';
function publish() {
  snapshot = JSON.stringify(
    [...pending.entries()].map(([id, { job, websiteId, paused }]) => ({
      id,
      job,
      websiteId,
      paused,
    })),
  );
  for (const listener of listeners) listener();
}
export const analysisPendingStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  snapshot: () => snapshot,
  serverSnapshot: () => '[]',
  resume(id: string) {
    pending.get(id)?.resume?.();
  },
};
export function analysisAsyncPath(path: string, parameters?: Record<string, unknown>) {
  if ([3, 4].includes(Number(parameters?.eventType))) return false;
  if (/^\/liekan\/websites\/[^/]+\/page-report$/.test(path))
    return !['logs', 'human/keywords'].includes(String(parameters?.resource));
  if (/^\/liekan\/websites\/[^/]+\/(analytics|journeys)$/.test(path)) return true;
  return (
    /^\/websites\/[^/]+\/(stats|pageviews|metrics|events\/(stats|series)|goals\/stats|funnels\/stats|retention|journeys|breakdown|attribution|heatmaps|performance\/(stats|chart|metrics)|revenue\/(stats|chart|metrics)|utm\/metrics)$/.test(
      path,
    ) &&
    !Object.keys(parameters || {}).some(key => /\d+$|^drill_|^pf_|^epf|^spf|^channel/.test(key))
  );
}
function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function waitForAnalysisVisibility(signal?: AbortSignal) {
  while (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    await new Promise<void>((resolve, reject) => {
      const clear = () => {
        document.removeEventListener('visibilitychange', change);
        signal?.removeEventListener('abort', abort);
      };
      const change = () => {
        if (document.visibilityState !== 'hidden') {
          clear();
          resolve();
        }
      };
      const abort = () => {
        clear();
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      };
      signal?.throwIfAborted();
      document.addEventListener('visibilitychange', change);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
function foregroundBudget() {
  let elapsed = 0,
    last = performance.now(),
    active = typeof document === 'undefined' || document.visibilityState !== 'hidden',
    suspended = !active;
  const tick = () => {
    const now = performance.now();
    if (active) elapsed += now - last;
    last = now;
    active = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    suspended ||= !active;
  };
  document?.addEventListener('visibilitychange', tick);
  return {
    elapsed: () => {
      tick();
      return elapsed;
    },
    suspended: () => {
      tick();
      return suspended;
    },
    reset: () => {
      tick();
      elapsed = 0;
    },
    close: () => document?.removeEventListener('visibilitychange', tick),
  };
}
async function resumePolling(entry: Pending, signal?: AbortSignal) {
  entry.paused = true;
  publish();
  await new Promise<void>((resolve, reject) => {
    const clear = () => {
      signal?.removeEventListener('abort', abort);
      entry.resume = undefined;
    };
    const abort = () => {
      clear();
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    entry.resume = () => {
      clear();
      resolve();
    };
    signal?.throwIfAborted();
    signal?.addEventListener('abort', abort, { once: true });
  });
  entry.paused = false;
  publish();
}
/** A previous page's durable jobs may still occupy the actor quota. Follow capacity without duplicating work. */
export async function waitForAnalysisAdmission(
  websiteId: string,
  send: () => Promise<Response>,
  signal?: AbortSignal,
  options?: {
    initialResponse: Response;
    retryAfter: (response: Response) => number | undefined;
  },
) {
  const id = `waiting:${websiteId}:${crypto.randomUUID()}`,
    entry: Pending = { websiteId, paused: false };
  const budget = foregroundBudget();
  let response = options?.initialResponse,
    retryDelay = 250;
  pending.set(id, entry);
  publish();
  try {
    for (;;) {
      signal?.throwIfAborted();
      await waitForAnalysisVisibility(signal);
      if (budget.elapsed() >= 15 * 60000) {
        await resumePolling(entry, signal);
        budget.reset();
        retryDelay = 250;
      }
      const hint = response && options?.retryAfter(response);
      // Recover short contention quickly, then return to the existing bounded cadence.
      await wait(
        Math.max(retryDelay, Number.isFinite(hint) ? Math.max(0, Math.min(10000, hint)) : 0),
        signal,
      );
      if (document.visibilityState === 'hidden') continue;
      response = await send();
      if (response.status !== 429) return response;
      const value = await response
        .clone()
        .json()
        .catch(() => null);
      if (value?.error?.code !== 'analysis-concurrency-limited') return response;
      retryDelay = Math.min(3000, retryDelay * 2);
    }
  } finally {
    budget.close();
    pending.delete(id);
    publish();
  }
}
/** Poll handles only; the original data response is read once when the durable task completes. */
export async function followAnalysisJob(
  input: unknown,
  options: {
    signal?: AbortSignal;
    fetchJob: (path: string) => Promise<Response>;
    onPrevious?: (value: unknown) => void;
    releaseJob?: (path: string) => Promise<unknown>;
  },
): Promise<{ response: Response; data: any; startedAt: number }> {
  const accepted = analysisAcceptedSchema.parse(input);
  let job = accepted.analysisJob;
  const budget = foregroundBudget();
  const entry: Pending = { job, websiteId: job.websiteId, paused: false };
  pending.set(job.id, entry);
  publish();
  if (accepted.previousResult !== undefined) options.onPrevious?.(accepted.previousResult);
  const read = async (path: string) => {
    // A server response can identify only the private job routes on the current origin.
    if (!privateTaskPath.test(path)) throw new Error('Invalid analytics task path');
    const startedAt = performance.now();
    const response = await options.fetchJob(path),
      data = await response.json().catch(() => null);
    if (response.status === 503 && data?.error?.code === 'analysis-read-busy') {
      const seconds = Number(response.headers.get('Retry-After'));
      return {
        response,
        data,
        startedAt,
        retryAfterMs:
          Number.isFinite(seconds) && seconds > 0
            ? Math.max(1000, Math.min(10000, seconds * 1000))
            : 3000,
      };
    }
    if (!response.ok) {
      const error: any = new Error(data?.error?.message || '后台统计读取失败');
      error.status = response.status;
      error.code = data?.error?.code;
      throw error;
    }
    return { response, data, startedAt, retryAfterMs: 0 };
  };
  let retryAfterMs = 0;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      await waitForAnalysisVisibility(options.signal);
      if (budget.elapsed() >= 15 * 60000) {
        await resumePolling(entry, options.signal);
        budget.reset();
      }
      await wait(retryAfterMs || Math.max(1000, Math.min(10000, job.retryAfterMs)), options.signal);
      retryAfterMs = 0;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') continue;
      const status = await read(job.resultUrl.replace(/\/result$/, ''));
      if (status.retryAfterMs) {
        retryAfterMs = status.retryAfterMs;
        continue;
      }
      job = analysisAcceptedSchema.parse(status.data).analysisJob;
      entry.job = job;
      publish();
      if (['failed', 'invalidated', 'expired'].includes(job.status)) {
        const error: any = new Error(
          job.status === 'failed'
            ? job.errorCode === 'analysis-capacity-limited'
              ? '统计缓存容量不足，请在统计加速中查看存储与清理'
              : '后台统计计算失败，请缩小范围或重试'
            : '统计条件已变化，请重新读取',
        );
        error.status = job.status === 'failed' ? 503 : 410;
        error.code = job.errorCode;
        throw error;
      }
      if (job.status === 'ready') {
        const result = await read(job.resultUrl);
        if (result.retryAfterMs) {
          retryAfterMs = result.retryAfterMs;
          continue;
        }
        if (result.response.status !== 202) return result;
      }
    }
  } catch (error) {
    if ((error as any)?.code === 'analysis-idle' && budget.suspended())
      (error as any).visibilitySuspended = true;
    throw error;
  } finally {
    budget.close();
    pending.delete(job.id);
    publish();
    const releasePath = job.resultUrl.replace(/\/result$/, '');
    if (options.releaseJob && privateTaskPath.test(releasePath))
      void options.releaseJob(releasePath).catch(() => {});
  }
}
