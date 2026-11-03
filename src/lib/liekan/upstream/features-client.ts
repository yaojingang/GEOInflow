'use client';
import { browserPopulationSchema } from '../contracts/browser-population';
import {
  analysisAsyncPath,
  followAnalysisJob,
  waitForAnalysisAdmission,
  waitForAnalysisVisibility,
} from './analysis-query-client';
import type { QueryClient } from '@tanstack/react-query';
import { getApiUrl } from '@/lib/api-url';
import { getClientAuthToken, removeClientAuthToken, setClientAuthToken } from '@/lib/client';
import { DATE_RANGE_CONFIG, LOCALE_CONFIG, THEME_CONFIG, TIMEZONE_CONFIG } from '@/lib/constants';
import { consumeReturnUrl } from '@/lib/return-url';
import { getItem, setItem } from '@/lib/storage';
import { setLocale, setTimezone, setUser, useApp } from '@/store/app';
import type { ExportFrame, ExportRequest } from '../contracts/exports';
import { isReportOwnedBy } from '../contracts/query';
import type { WebsiteSummary } from '../contracts/website-summary';
import { defaultLiekanLocale, isLiekanLocale, readLocaleCookie } from '../i18n/locale';
import { aggregateRequestResources, isAggregateRequest } from './cache-policy';
import { clientCatalogVersion } from './catalog-client';
import {
  clientRequestOptions,
  copyClientFreshness,
  monotonicNow,
  rememberAggregateFailure,
  rememberRequestFreshness,
  rememberResponseFreshness,
} from './client-freshness';
import { RequestPool, browserReads as reads } from './request-pool';
// Keep initial task submissions within the server's per-consumer active quota.
const analysisReads = new RequestPool(2);
export async function streamFeatureExport(
  websiteId: string,
  body: ExportRequest,
  signal: AbortSignal,
  onFrame: (frame: ExportFrame) => void,
  catalogVersion?: string,
) {
  const response = await fetch(
    new URL(getApiUrl(`/liekan/websites/${websiteId}/exports`), window.location.origin),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${getClientAuthToken() || ''}`,
        ...(catalogVersion ? { 'X-Liekan-Catalog-Version': catalogVersion } : {}),
      },
      body: JSON.stringify(body),
      signal,
      cache: 'no-store',
    },
  );
  if (!response.ok) {
    let data = await response.json().catch(() => null);
    throw new FeatureApiError(
      data?.error?.message || `导出失败 (${response.status})`,
      response.status,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new FeatureApiError('导出响应为空', 500);
  const decoder = new TextDecoder();
  let pending = '',
    complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let boundary: number;
      while ((boundary = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (!line) continue;
        const frame: ExportFrame = JSON.parse(line);
        if (frame.type === 'error') throw new FeatureApiError(frame.message, frame.status);
        if (frame.type === 'complete') complete = true;
        onFrame(frame);
      }
      if (done) break;
    }
    if (!complete) throw new FeatureApiError('导出传输未完成，请重新生成', 500);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class FeatureApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: any,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}
export { isAggregateRequest } from './cache-policy';

function retryAfter(response: Response) {
  const value = response.headers.get('Retry-After');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const serverTime =
    Number(response.headers.get('X-Liekan-Server-Time')) ||
    Date.parse(response.headers.get('Date') || '');
  return Math.max(0, Date.parse(value) - (Number.isFinite(serverTime) ? serverTime : Date.now()));
}
function rememberPopulation(data: any, headers: Headers, params?: Record<string, any>) {
  if (!data || typeof data !== 'object' || data.population) return;
  try {
    const values = JSON.parse(headers.get('X-Liekan-Population') || '{}').populations;
    if (!Array.isArray(values)) return;
    const hasRange = params?.startAt != null && params?.endAt != null;
    const selected = hasRange
      ? values.find(
          entry =>
            entry?.range?.startAt === Number(params.startAt) &&
            entry.range.endAt === Number(params.endAt) &&
            (!params.timezone || entry.range.timezone === params.timezone),
        )
      : values[0];
    const population = browserPopulationSchema.safeParse(selected);
    if (population.success)
      Object.defineProperty(data, 'population', {
        value: population.data,
        enumerable: !Array.isArray(data),
        configurable: true,
      });
  } catch {
    /* Invalid optional metadata never changes a successful legacy response. */
  }
}
export async function featureRequest<T = any>(
  method: string,
  path: string,
  params?: Record<string, any>,
  signal?: AbortSignal,
  shareToken?: string,
  tokenOverride?: string,
  options?: { priority?: 'foreground' | 'prefetch'; onPrevious?: (value: unknown) => void },
): Promise<T> {
  const url = new URL(getApiUrl(path), window.location.origin);
  const aggregate = method === 'GET' && isAggregateRequest(path, params);
  const geoSnapshot =
    method === 'GET' && /^\/liekan\/websites\/[^/]+\/geo-weight\/snapshot$/.test(path);
  const context = clientRequestOptions(signal);
  if (method === 'GET' && params)
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '')
        url.searchParams.set(
          key,
          typeof value === 'object' ? JSON.stringify(value) : String(value),
        );
    }
  if (aggregate && context?.refresh) url.searchParams.set('refresh', '1');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!shareToken && aggregate && analysisAsyncPath(path, params)) headers.Prefer = 'respond-async';
  if (
    !shareToken &&
    headers.Prefer === 'respond-async' &&
    /^\/liekan\/websites\/[^/]+\/page-report$/.test(path)
  )
    headers['X-Liekan-View'] = crypto.randomUUID();
  if (shareToken) {
    headers['x-umami-share-token'] = shareToken;
    headers['x-umami-share-context'] = '1';
  } else {
    const token = tokenOverride ?? getClientAuthToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  if (
    context?.catalogScope &&
    method === 'GET' &&
    (aggregate ||
      /^\/liekan\/websites\/[^/]+\//.test(path) ||
      ['/liekan/crawler-registry', '/liekan/admin/crawler-sources'].includes(path))
  ) {
    const version = await clientCatalogVersion(context.catalogScope, headers);
    if (version) headers['X-Liekan-Catalog-Version'] = version;
    signal?.throwIfAborted();
  }
  const load = async (requestSignal?: AbortSignal, idleResume = -Infinity): Promise<any> => {
    const attemptHeaders = { ...headers };
    if (attemptHeaders['X-Liekan-View'] && idleResume !== -Infinity)
      attemptHeaders['X-Liekan-View'] = crypto.randomUUID();
    let startedAt = monotonicNow();
    const send = () => {
      startedAt = monotonicNow();
      return fetch(url, {
        method,
        headers: attemptHeaders,
        signal: requestSignal,
        cache: 'no-store',
        ...(method !== 'GET' && params && { body: JSON.stringify(params) }),
      });
    };
    let response = await send();
    let data = await response.json().catch(() => null);
    if (
      attemptHeaders.Prefer === 'respond-async' &&
      response.status === 429 &&
      data?.error?.code === 'analysis-concurrency-limited'
    ) {
      const websiteId = /\/websites\/([^/]+)\//.exec(path)?.[1];
      response = await waitForAnalysisAdmission(websiteId, send, requestSignal, {
        initialResponse: response,
        retryAfter,
      });
      data = await response.json().catch(() => null);
    }
    if (!response.ok)
      throw new FeatureApiError(
        data?.error?.message || data?.message || `请求失败 (${response.status})`,
        response.status,
        data?.error?.code,
        data?.error,
        retryAfter(response),
      );
    if (response.status === 202 && attemptHeaders.Prefer === 'respond-async') {
      try {
        const result = await followAnalysisJob(data, {
          signal: requestSignal,
          onPrevious: value => {
            if (requestSignal?.aborted) return;
            rememberPopulation(value, response.headers, params);
            rememberResponseFreshness(
              value,
              response.headers,
              startedAt,
              monotonicNow(),
              aggregateRequestResources(path, params),
            );
            options?.onPrevious?.(value);
          },
          ...(attemptHeaders['X-Liekan-View']
            ? {
                releaseJob: (taskPath: string) =>
                  fetch(new URL(getApiUrl(taskPath), window.location.origin), {
                    method: 'DELETE',
                    keepalive: true,
                    cache: 'no-store',
                    headers: Object.fromEntries(
                      Object.entries(attemptHeaders).filter(([key]) => key !== 'Prefer'),
                    ),
                  }),
              }
            : {}),
          fetchJob: taskPath =>
            fetch(new URL(getApiUrl(taskPath), window.location.origin), {
              headers: Object.fromEntries(
                Object.entries(attemptHeaders).filter(([key]) => key !== 'Prefer'),
              ),
              signal: requestSignal,
              cache: 'no-store',
            }),
        });
        response = result.response;
        data = result.data;
        startedAt = result.startedAt;
      } catch (error) {
        // A visible reader can replace a parked handle; rapid repeated failures remain bounded.
        if (
          (error as any)?.code !== 'analysis-idle' ||
          (!(error as any)?.visibilitySuspended && Date.now() - idleResume < 120000)
        )
          throw error;
        await waitForAnalysisVisibility(requestSignal);
        return load(requestSignal, Date.now());
      }
    }
    rememberPopulation(data, response.headers, params);
    if (aggregate || (geoSnapshot && data?.taskStatus === 'ready' && data?.result))
      rememberResponseFreshness(
        data,
        response.headers,
        startedAt,
        monotonicNow(),
        shareToken ? undefined : aggregateRequestResources(path, params),
      );
    return data;
  };
  try {
    const data = await (method === 'GET'
      ? (headers.Prefer === 'respond-async' ? analysisReads : reads).read(
          JSON.stringify([
            url.href,
            Object.fromEntries(Object.entries(headers).filter(([key]) => key !== 'X-Liekan-View')),
          ]),
          load,
          signal,
          options?.priority ?? context?.priority,
        )
      : load(signal));
    if (data && typeof data === 'object') rememberRequestFreshness(data, signal);
    return data;
  } catch (error: any) {
    if (aggregate && error && typeof error === 'object' && error.name !== 'AbortError')
      error.aggregate = true;
    throw error;
  }
}
export const featureApi = {
  get: <T = any>(
    path: string,
    params?: Record<string, any>,
    signal?: AbortSignal,
    options?: { priority?: 'foreground' | 'prefetch'; onPrevious?: (value: unknown) => void },
  ) => featureRequest<T>('GET', path, params, signal, undefined, undefined, options),
  post: <T = any>(path: string, body?: Record<string, any>, signal?: AbortSignal) =>
    featureRequest<T>('POST', path, body, signal),
  put: <T = any>(path: string, body?: Record<string, any>) => featureRequest<T>('PUT', path, body),
  del: <T = any>(path: string, body?: Record<string, any>) =>
    featureRequest<T>('DELETE', path, body),
};
export function acceptFeatureLogin(response: any) {
  if (response.requiresTwoFactor) {
    sessionStorage.setItem('umami.partial-token', response.partialToken);
    return '/login/two-factor';
  }
  setClientAuthToken(response.token);
  setUser(response.user);
  sessionStorage.removeItem('umami.partial-token');
  return consumeReturnUrl() ?? '/websites';
}
export function clearFeatureLogin() {
  removeClientAuthToken();
  setUser(null);
  sessionStorage.removeItem('umami.partial-token');
}
export async function resumeFeatureLogin(signal?: AbortSignal): Promise<string | null> {
  const token = getClientAuthToken();
  if (!token || signal?.aborted) return null;
  try {
    const user = await featureRequest('POST', '/auth/verify', {}, signal, undefined, token);
    if (signal?.aborted || getClientAuthToken() !== token) return null;
    setUser(user);
    return consumeReturnUrl() ?? '/websites';
  } catch (error) {
    if (signal?.aborted || getClientAuthToken() !== token) return null;
    if (error instanceof FeatureApiError && error.status === 401) {
      clearFeatureLogin();
      return null;
    }
    throw error;
  }
}
export async function refreshFeatureIdentity() {
  const token = getClientAuthToken();
  try {
    const user = await featureRequest('POST', '/auth/verify', {}, undefined, undefined, token);
    if (getClientAuthToken() !== token)
      throw new FeatureApiError('登录身份已变更，请重新读取。', 409);
    setUser(user);
    return user;
  } catch (error) {
    if (getClientAuthToken() === token && error instanceof FeatureApiError && error.status === 401)
      clearFeatureLogin();
    throw error;
  }
}
export async function verifyFeatureTwoFactor(body: { token?: string; backupCode?: string }) {
  const token = sessionStorage.getItem('umami.partial-token');
  if (!token) throw new FeatureApiError('验证会话已过期，请重新登录', 401);
  return featureRequest('POST', '/2fa/verify', body, undefined, undefined, token);
}
export async function verifyFeatureSso(token: string) {
  const user = await featureRequest('POST', '/auth/verify', {}, undefined, undefined, token);
  setClientAuthToken(token);
  setUser(user);
  return user;
}
export function featureAssetUrl(file: string) {
  return `${window.location.origin}${process.env.basePath || ''}/${file.replace(/^\/+/, '')}`;
}
export function getFeaturePreferences() {
  const account = useApp.getState().accountPreferences;
  let cookieLocale: ReturnType<typeof readLocaleCookie>;
  try {
    if (typeof document !== 'undefined') cookieLocale = readLocaleCookie(document.cookie);
  } catch {
    /* Browser policy can block cookie reads. */
  }
  const storedLocale = getItem(LOCALE_CONFIG);
  return {
    range: account?.range || getItem(DATE_RANGE_CONFIG) || '0day',
    timezone: account?.timezone || getItem(TIMEZONE_CONFIG) || 'Asia/Shanghai',
    countryCode: account?.countryCode ?? null,
    language: defaultLiekanLocale(
      cookieLocale || (isLiekanLocale(storedLocale) ? storedLocale : undefined),
    ),
    theme: getItem(THEME_CONFIG) || 'light',
  };
}

export async function getAllFeatureRows<T = any>(
  path: string,
  params: Record<string, any> = {},
  signal?: AbortSignal,
): Promise<T[]> {
  const data: T[] = [];
  for (let page = 1; ; page++) {
    const result = await featureApi.get(path, { ...params, page, pageSize: 100 }, signal);
    if (Array.isArray(result)) return result;
    const rows = result?.data;
    if (!Array.isArray(rows)) throw new FeatureApiError('列表数据格式不兼容', 500);
    data.push(...rows);
    if (
      !rows.length ||
      data.length >= Number(result.count ?? Infinity) ||
      (!result.count && rows.length < 100)
    )
      return data;
    if (page >= 1000) throw new FeatureApiError('列表超过可加载范围，请缩小条件', 413);
  }
}
export async function getFeatureSites(
  signal?: AbortSignal,
  teamId?: string,
  scope: 'personal' | 'all' = 'all',
): Promise<any[]> {
  if (teamId) return getAllFeatureRows(`/teams/${teamId}/websites`, {}, signal);
  if (scope === 'personal') return getAllFeatureRows('/me/websites', {}, signal);
  const [personal, teams] = await Promise.all([
    getAllFeatureRows('/me/websites', {}, signal),
    getAllFeatureRows<any>('/me/teams', {}, signal),
  ]);
  const collections = await mapFeatureRows(teams, team =>
    getAllFeatureRows(`/teams/${team.id}/websites`, {}, signal),
  );
  return [
    ...new Map([...personal, ...collections.flat()].map((site: any) => [site.id, site])).values(),
  ];
}
export function featureSiteQuery(userId: string, websiteId: string) {
  return {
    queryKey: ['liekan-feature', userId, 'site', websiteId],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      featureApi.get(`/websites/${websiteId}`, {}, signal),
    staleTime: 300000,
    gcTime: 600000,
    retry: false as const,
  };
}
export async function invalidateFeatureUserQueries(client: QueryClient, userId: string) {
  const filters = {
    predicate: (query: { queryKey: readonly unknown[] }) => {
      const key = query.queryKey;
      return key[0] === 'liekan'
        ? isReportOwnedBy(key, userId)
        : (key[0] === 'liekan-feature' && key.includes(userId)) ||
            (key[0] === 'liekan-ai' && key[1] === userId);
    },
  };
  await client.cancelQueries({ ...filters, type: 'inactive' });
  return client.invalidateQueries({ ...filters, refetchType: 'none' });
}
export async function invalidateFeatureWebsiteQueries(client: QueryClient, websiteId: string) {
  const filters = {
    predicate: (query: { queryKey: readonly unknown[] }) => {
      const key = query.queryKey;
      if (key[0] === 'liekan') return key[1] === websiteId;
      if (key[0] === 'liekan-ai')
        return (
          key.includes(websiteId) ||
          ['catalog', 'catalog-selected', 'context'].includes(String(key[2]))
        );
      return (
        key[0] === 'liekan-feature' &&
        (key.includes(websiteId) ||
          key.includes('sites') ||
          key.some(value => Array.isArray(value) && value.includes(websiteId)))
      );
    },
  };
  await client.cancelQueries({ ...filters, type: 'inactive' });
  return client.invalidateQueries({ ...filters, refetchType: 'none' });
}
export async function getFeatureWebsiteSummary(
  ids: string[],
  range: Record<string, any>,
  signal?: AbortSignal,
  get = featureApi.get,
) {
  const sorted = [...new Set(ids)].sort();
  const rows: any[] = [];
  const readChunk = async (chunk: string[]): Promise<any[]> => {
    try {
      const result = await get<WebsiteSummary>(
        '/liekan/websites/summary',
        {
          ids: chunk.join(','),
          startAt: range.startAt,
          endAt: range.endAt,
          timezone: range.timezone,
        },
        signal,
      );
      copyClientFreshness(rows, result);
      return result;
    } catch (error: any) {
      if (error.name === 'AbortError') throw error;
      if ([403, 404].includes(error.status) && chunk.length > 1) {
        const middle = Math.ceil(chunk.length / 2);
        const halves = await Promise.all([
          readChunk(chunk.slice(0, middle)),
          readChunk(chunk.slice(middle)),
        ]);
        return halves.flat();
      }
      return chunk.map(id => ({ id, error }));
    }
  };
  for (let start = 0; start < sorted.length; start += 50)
    rows.push(...(await readChunk(sorted.slice(start, start + 50))));
  if (rows.some(row => row.error))
    rememberAggregateFailure(
      rows,
      Math.max(...rows.map(row => Number(row.error?.retryAfterMs) || 0)),
    );
  return rows;
}
export function saveFeaturePreferences(value: {
  range: string;
  timezone: string;
  language?: string;
  theme: string;
}) {
  if ((value.language !== undefined && !isLiekanLocale(value.language)) || value.theme !== 'light')
    throw new FeatureApiError('当前界面支持简体中文、English 和浅色主题', 400);
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: value.timezone }).format();
  } catch {
    throw new FeatureApiError('时区无效', 400);
  }
  setItem(DATE_RANGE_CONFIG, value.range);
  setItem(TIMEZONE_CONFIG, value.timezone);
  setItem(THEME_CONFIG, value.theme);
  setTimezone(value.timezone);
  // Language is saved immediately by the shared selector. Other preferences do not overwrite it.
}

export async function mapFeatureRows<T, R>(
  items: T[],
  load: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += 4)
    results.push(...(await Promise.all(items.slice(index, index + 4).map(load))));
  return results;
}

/** Private evidence exports use the same session token as other feature requests. */
export async function downloadTrafficEvidence(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  catalogVersion?: string,
) {
  const response = await fetch(new URL(getApiUrl(path), window.location.origin), {
    method: 'POST',
    cache: 'no-store',
    signal,
    headers: {
      'Content-Type': 'application/json',
      authorization: `Bearer ${getClientAuthToken() || ''}`,
      ...(catalogVersion ? { 'X-Liekan-Catalog-Version': catalogVersion } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new FeatureApiError(data?.error?.message || '导出失败', response.status);
  }
  return {
    csv: await response.text(),
    readAt: response.headers.get('X-Liekan-Export-Read-At'),
    changed: response.headers.get('X-Liekan-Export-Changed'),
  };
}
