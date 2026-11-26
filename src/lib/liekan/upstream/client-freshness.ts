'use client';
import {
  hashKey,
  type QueryClient,
  replaceEqualDeep,
  type UseQueryResult,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import type { CacheResource } from '../contracts/cache-manifest';
import { invalidatesRetainedRead } from '../contracts/report-status';
import { statisticsCacheTtl, uniqueCacheResources } from './cache-policy';
import { promoteRequestConsumer } from './request-pool';

interface Freshness {
  deadline: number;
  expiresAt: number;
  generatedAt?: number;
  dataThrough?: number;
  ttl?: number;
  failedRetryAfterMs?: number;
  failedRead?: Error;
  resources?: CacheResource[];
}
export interface SerializedFreshness {
  dataThrough?: number;
  generatedAt: number;
  expiresAt: number;
  resources: CacheResource[];
}
const freshness = new WeakMap<object, Freshness>();
const requests = new WeakMap<AbortSignal, Freshness>();
const requestOptions = new WeakMap<
  AbortSignal,
  { refresh?: boolean; priority?: 'foreground' | 'prefetch'; catalogScope?: string }
>();
const pendingQueries = new Map<string, Set<AbortSignal>>();
export function promoteQueryRequest(queryKey: readonly unknown[]) {
  for (const signal of pendingQueries.get(hashKey(queryKey)) || []) {
    const options = requestOptions.get(signal);
    if (options) options.priority = 'foreground';
    promoteRequestConsumer(signal);
  }
}
export function observeRequestPriority(client: QueryClient) {
  return client.getQueryCache().subscribe(event => {
    if (event.type === 'observerAdded' && event.query.isActive())
      promoteQueryRequest(event.query.queryKey);
  });
}
export const monotonicNow = () => performance.now();
export const reportDataThrough = (data: unknown) =>
  data && typeof data === 'object' ? freshness.get(data)?.dataThrough : undefined;
export const freshnessExpiry = (data: object) => freshness.get(data)?.expiresAt;
export const hasClientFreshness = (data: unknown) =>
  !!data && typeof data === 'object' && freshness.has(data);
export const clientRequestOptions = (signal?: AbortSignal) => signal && requestOptions.get(signal);
export function serializeClientFreshness(data: unknown): SerializedFreshness | undefined {
  const value = data && typeof data === 'object' ? freshness.get(data) : undefined;
  if (!value || value.failedRead || !value.resources?.length) return;
  return {
    dataThrough: value.dataThrough,
    generatedAt: value.generatedAt || 0,
    expiresAt: value.expiresAt || 0,
    resources: value.resources,
  };
}
/** A current authorized manifest supplies the server clock after a browser restart. */
export function restoreClientFreshness(
  data: unknown,
  value: SerializedFreshness,
  serverTime: number,
  receivedAt = monotonicNow(),
) {
  const valid =
    Number.isFinite(value.generatedAt) &&
    Number.isFinite(value.expiresAt) &&
    value.generatedAt > 0 &&
    value.expiresAt > value.generatedAt &&
    value.generatedAt <= serverTime;
  remember(data, {
    ...value,
    deadline: valid ? receivedAt + Math.max(0, value.expiresAt - serverTime) : -Infinity,
    ttl: valid ? value.expiresAt - value.generatedAt : undefined,
  });
}

function remember(data: unknown, value: Freshness) {
  if (data && typeof data === 'object') freshness.set(data, value);
}
function combineFreshness(previous: Freshness | undefined, next: Freshness) {
  return {
    ...(previous && previous.deadline <= next.deadline ? previous : next),
    resources: uniqueCacheResources([...(previous?.resources || []), ...(next.resources || [])]),
  };
}
// Used for local fixtures and explicitly browser-cached configuration.
export function rememberFreshness(data: unknown, expiresAt: number) {
  if (Number.isFinite(expiresAt))
    remember(data, { expiresAt, deadline: monotonicNow() + expiresAt - Date.now() });
}
/** Error rows carry retry timing, with no successful statistics lifetime. */
export function rememberAggregateFailure(data: unknown, retryAfterMs = 0) {
  remember(data, {
    expiresAt: 0,
    deadline: monotonicNow(),
    failedRetryAfterMs: retryAfterMs,
    failedRead: new Error('部分数据读取失败，请主动重试。'),
  });
}
export const aggregateReadFailure = (data: unknown) =>
  data && typeof data === 'object' ? freshness.get(data)?.failedRead : undefined;
function timestamp(value: unknown) {
  if (value == null || value === '') return NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.parse(String(value));
}
/** Translate server time once; wall-clock changes cannot renew a response. */
export function rememberResponseFreshness(
  data: any,
  headers: Headers,
  startedAt: number,
  receivedAt = monotonicNow(),
  resources?: CacheResource[],
) {
  const expiresAt = timestamp(headers.get('X-Liekan-Expires-At') ?? data?.meta?.expiresAt);
  const generatedAt = timestamp(headers.get('X-Liekan-Generated-At') ?? data?.meta?.generatedAt);
  const exactServerTime = timestamp(headers.get('X-Liekan-Server-Time'));
  const date = timestamp(headers.get('Date'));
  const serverTime = Number.isFinite(exactServerTime) ? exactServerTime : date;
  const precision = Number.isFinite(exactServerTime) ? 0 : 1000;
  const elapsed = Math.max(0, receivedAt - startedAt);
  const processing = Number(
    headers
      .get('Server-Timing')
      ?.match(/(?:^|,)\s*analytics\s*;\s*dur=(\d+(?:\.\d+)?)(?=\s*(?:,|;|$))/)?.[1],
  );
  // The server measures this request through serialization and authorization.
  // Deduct transport time without charging database computation a second time.
  const transport = elapsed - (Number.isFinite(processing) ? Math.min(elapsed, processing) : 0);
  const valid =
    Number.isFinite(expiresAt) &&
    Number.isFinite(generatedAt) &&
    Number.isFinite(serverTime) &&
    expiresAt > generatedAt &&
    generatedAt <= serverTime + precision;
  remember(data, {
    expiresAt: valid ? expiresAt : 0,
    generatedAt: valid ? generatedAt : undefined,
    ttl: valid ? expiresAt - generatedAt : undefined,
    resources,
    dataThrough: Number.isFinite(timestamp(headers.get('X-Liekan-Data-Through')))
      ? timestamp(headers.get('X-Liekan-Data-Through'))
      : undefined,
    deadline: valid ? receivedAt + (expiresAt - serverTime) - transport - precision : -Infinity,
  });
}
export function copyClientFreshness(data: unknown, source: unknown) {
  if (!source || typeof source !== 'object') return;
  const next = freshness.get(source);
  if (!next) return;
  const previous = data && typeof data === 'object' ? freshness.get(data) : undefined;
  remember(data, combineFreshness(previous, next));
}
export function rememberRequestFreshness(data: object, signal?: AbortSignal) {
  const value = freshness.get(data);
  if (signal && value) {
    const previous = requests.get(signal);
    requests.set(signal, combineFreshness(previous, value));
  }
}
/** A selected projection follows its current response, including renewed unchanged values. */
export function projectClientFreshness(data: unknown, source: unknown) {
  if (!source || typeof source !== 'object') return;
  const next = freshness.get(source);
  if (!next) return;
  const previous = data && typeof data === 'object' ? freshness.get(data) : undefined;
  remember(
    data,
    previous?.expiresAt === next.expiresAt && previous.deadline < next.deadline ? previous : next,
  );
}
export async function withClientFreshness<T>(
  signal: AbortSignal,
  load: () => Promise<T>,
  options?: {
    refresh?: boolean;
    priority?: 'foreground' | 'prefetch';
    queryKey?: readonly unknown[];
    catalogScope?: string;
  },
) {
  const parent = requestOptions.get(signal);
  if (!parent) requests.delete(signal);
  requestOptions.set(signal, {
    ...parent,
    ...options,
    refresh: parent?.refresh || options?.refresh,
  });
  const key = options?.queryKey && hashKey(options.queryKey);
  const registered = key && !pendingQueries.get(key)?.has(signal);
  if (registered) {
    if (!pendingQueries.has(key)) pendingQueries.set(key, new Set());
    pendingQueries.get(key).add(signal);
  }
  try {
    const value = await load();
    const expiry = requests.get(signal);
    if (expiry && !aggregateReadFailure(value)) remember(value, expiry);
    return value;
  } finally {
    if (parent) requestOptions.set(signal, parent);
    else {
      requestOptions.delete(signal);
      requests.delete(signal);
    }
    if (registered) {
      pendingQueries.get(key)?.delete(signal);
      if (!pendingQueries.get(key)?.size) pendingQueries.delete(key);
    }
  }
}
export function shareWithFreshness(oldData: unknown, newData: unknown) {
  const previous = oldData && typeof oldData === 'object' ? freshness.get(oldData) : undefined;
  const next = newData && typeof newData === 'object' ? freshness.get(newData) : undefined;
  const shared = replaceEqualDeep(oldData, newData);
  if (next)
    remember(
      shared,
      previous?.expiresAt > 0 &&
        previous.expiresAt === next.expiresAt &&
        previous.deadline < next.deadline
        ? previous
        : next,
    );
  return shared;
}
export function remainingFreshness(data: any, updatedAt: number, fallback = 0) {
  const value = data && typeof data === 'object' ? freshness.get(data) : undefined;
  return Math.max(0, value ? value.deadline - monotonicNow() : updatedAt + fallback - Date.now());
}
// TanStack measures staleTime from dataUpdatedAt; the deadline stays monotonic.
export function freshnessStaleTime(query: any, fallback = 0) {
  return (
    Math.max(0, Date.now() - query.state.dataUpdatedAt) +
    remainingFreshness(query.state.data, query.state.dataUpdatedAt, fallback)
  );
}
export function aggregateGrace(data: unknown, endAt?: number, timezone?: string) {
  const value = data && typeof data === 'object' ? freshness.get(data) : undefined;
  if (value?.ttl) return value.ttl >= 300000 ? 300000 : 30000;
  return Number.isFinite(endAt) ? statisticsCacheTtl(endAt, timezone) : 30000;
}
export function canDisplayAggregate(data: unknown, grace: number, now = monotonicNow()) {
  const value = data && typeof data === 'object' ? freshness.get(data) : undefined;
  return !!value && now < value.deadline + grace;
}

/** Ordinary snapshots remain visible until an explicit read or an authorization failure. */
export function useFreshnessLifecycle<T>(
  result: UseQueryResult<T, any>,
  options: {
    queryKey: readonly unknown[];
    enabled?: boolean;
    aggregate?: boolean;
    endAt?: number;
    timezone?: string;
    interval?: number;
  },
): UseQueryResult<T, any> & { isStaleAggregate?: boolean } {
  const client = useQueryClient();
  const key = JSON.stringify(options.queryKey);
  const restricted = invalidatesRetainedRead(result.error);
  useEffect(() => {
    if (options.enabled !== false) promoteQueryRequest(options.queryKey);
  }, [key, options.enabled]);
  useEffect(() => {
    if (!restricted) return;
    for (const query of client.getQueryCache().findAll({ queryKey: options.queryKey }))
      if (query.state.data !== undefined) query.setState({ data: undefined });
  }, [restricted, client, key]);
  const aggregate = options.aggregate !== false && hasClientFreshness(result.data);
  const isStaleAggregate = aggregate && remainingFreshness(result.data, result.dataUpdatedAt) <= 0;
  return { ...result, isStaleAggregate, ...(restricted ? { data: undefined } : {}) };
}
