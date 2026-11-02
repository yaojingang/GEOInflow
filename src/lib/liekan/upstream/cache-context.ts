import type { BrowserPopulation } from '../contracts/browser-population';
import { withPublishedRegistry } from './crawler-registry-context';
import { getPublishedCatalog } from '../crawlers/published';
import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { CachedResult } from './query-cache';
import { AnalyticsRestart, AnalyticsUnavailable } from './analytics-budget';
import { processSingleton } from './process-singleton';

interface CacheContext {
  populations?: Map<string, BrowserPopulation>;
  bypass?: boolean;
  probeOnly?: boolean;
  results: Array<Omit<CachedResult<unknown>, 'value'>>;
  deadline?: number;
  refresh?: boolean;
  actor?: string;
  scope?: unknown;
  request?: Request;
  parameters?: Record<string, unknown>;
  versions?: Map<string, Promise<unknown>>;
  reauthorize?: (deadline?: number) => Promise<boolean>;
  prepared?: boolean;
  background?: boolean;
  workKind?: 'interactive' | 'preheat';
  refreshRound?: string;
  redisSpentMs?: number;
  redisWaiting?: { count: number; startedAt: number };
}
interface CacheState {
  contexts: AsyncLocalStorage<CacheContext>;
  versionReader?: (tags: string[]) => Promise<unknown>;
  authorizationRunner?: <T>(work: () => Promise<T>) => Promise<T>;
}
const state = processSingleton<CacheState>('analytics-request-context', () => ({
  contexts: new AsyncLocalStorage<CacheContext>(),
}));
export function installAuthorizationRunner(runner: CacheState['authorizationRunner']) {
  state.authorizationRunner = runner;
}
export function runCacheAuthorization<T>(work: () => Promise<T>) {
  return cacheHeadersEnabled() && state.authorizationRunner
    ? state.authorizationRunner(work)
    : work();
}
export function installVersionReader(reader: CacheState['versionReader']) {
  state.versionReader = reader;
}
export async function prepareAnalyticsVersions(tags: string[]) {
  if (!cacheHeadersEnabled() || !state.versionReader) return;
  await state.versionReader(tags);
  contexts.getStore().prepared = true;
}
const contexts = state.contexts;
export const bypassQueryCache = () => contexts.getStore()?.bypass;
export const cacheHeadersEnabled = () => !!contexts.getStore() && !contexts.getStore()?.bypass;
export const currentCacheContext = () => contexts.getStore();
export function bindCacheRequest(
  request: Request,
  auth: any,
  parameters?: Record<string, unknown>,
  reauthorize?: (deadline?: number) => Promise<boolean>,
) {
  const context = contexts.getStore();
  if (!context) return;
  context.request = request;
  context.refresh = new URL(request.url).searchParams.get('refresh') === '1';
  context.actor = auth?.user?.id || auth?.shareToken?.shareId;
  context.scope = auth?.shareToken
    ? {
        shareId: auth.shareToken.shareId,
        parameters: auth.shareToken.parameters,
        websiteId: auth.shareToken.websiteId,
        websiteIds: auth.shareToken.websiteIds,
        linkIds: auth.shareToken.linkIds,
        pixelIds: auth.shareToken.pixelIds,
        boardLayoutHash: auth.shareToken.boardLayoutHash,
      }
    : { private: true };
  context.parameters = parameters;
  context.reauthorize = reauthorize;
}
export function noteBrowserPopulation(resourceId: string, population: BrowserPopulation) {
  const context = contexts.getStore();
  if (!context) return;
  context.populations ||= new Map();
  context.populations.set(JSON.stringify([resourceId, population.range]), {
    ...population,
    resourceId,
  });
}
/** Capture only metadata emitted by this load, including concurrent aggregate requests. */
export async function captureBrowserPopulations<T>(load: () => Promise<T>) {
  const context = contexts.getStore();
  const captured = {
    ...context,
    results: context?.results || [],
    populations: new Map<string, BrowserPopulation>(),
  };
  return contexts.run(captured, async () => ({
    value: await load(),
    populations: [...captured.populations.values()],
  }));
}
export function noteCacheResult({ generatedAt, expiresAt, status, tier }: CachedResult<unknown>) {
  contexts.getStore()?.results.push({ generatedAt, expiresAt, status, tier });
}
export const withoutQueryCache = <T>(work: () => Promise<T>) =>
  contexts.run({ bypass: true, results: [] }, work);
export const CacheProbeMiss = processSingleton(
  'analytics-cache-probe-miss',
  () => class CacheProbeMiss extends Error {},
);
export async function probeCacheOnly<T>(work: () => Promise<T>) {
  const parent = currentCacheContext();
  if (!parent || parent.refresh) return undefined;
  const child: CacheContext = { ...parent, probeOnly: true, results: [], populations: new Map() };
  try {
    const value = await contexts.run(child, work);
    if (!child.results.length) return undefined;
    parent.results.push(...child.results);
    if (child.populations.size) {
      parent.populations ||= new Map();
      for (const [key, population] of child.populations) parent.populations.set(key, population);
    }
    return value;
  } catch (error) {
    if (error instanceof CacheProbeMiss) return undefined;
    throw error;
  }
}
export function analyticsWorkerContext<T>(
  actor: string,
  scope: unknown,
  work: () => Promise<T>,
  options?: {
    deadline?: number;
    reauthorize?: (deadline?: number) => Promise<boolean>;
    kind?: 'interactive' | 'preheat';
    refresh?: boolean;
  },
) {
  return contexts.run(
    {
      results: [],
      deadline: Math.min(
        Date.now() + (options?.kind === 'interactive' ? 60000 : 30000),
        options?.deadline || Infinity,
      ),
      refresh: options?.refresh ?? true,
      actor,
      scope,
      versions: new Map(),
      background: true,
      workKind: options?.kind || 'preheat',
      refreshRound: randomUUID(),
      reauthorize: options?.reauthorize,
    },
    work,
  );
}
export async function withQueryCacheHeaders(
  work: () => Promise<Response>,
  request?: Request,
): Promise<Response> {
  if (request && !process.env.CLICKHOUSE_URL) {
    const version = request.headers.get('x-liekan-catalog-version');
    if (version && !z.uuid().safeParse(version).success)
      return Response.json({ error: { message: '目录版本无效', status: 400 } }, { status: 400 });
    return withPublishedRegistry(async () => {
      const response = await withQueryCacheHeaders(work);
      response.headers.set('X-Liekan-Catalog-Version', getPublishedCatalog()?.version || '');
      return response;
    }, version || undefined);
  }
  if (contexts.getStore() && !contexts.getStore().bypass) return work();
  const context: CacheContext = {
    results: [],
    deadline: Date.now() + 65000,
    versions: new Map(),
    refreshRound: randomUUID(),
  };
  const start = performance.now();
  let response: Response;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await contexts.run(context, work);
        break;
      } catch (error) {
        if (!(error instanceof AnalyticsRestart) || attempt > 0)
          throw error instanceof AnalyticsRestart
            ? new AnalyticsUnavailable('统计配置已变更，请稍后重试')
            : error;
        context.versions.clear();
        context.results = [];
        context.populations?.clear();
        context.prepared = false;
      }
    }
    if (
      response.ok &&
      (context.results.length || ['GET', 'HEAD'].includes(context.request?.method || '')) &&
      context.reauthorize &&
      !(await contexts.run(context, () => runCacheAuthorization(context.reauthorize)))
    )
      return Response.json(
        { error: { message: '访问权限已变更，请重新打开页面', status: 403 } },
        { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
      );
  } catch (error) {
    if (!(error instanceof AnalyticsUnavailable)) throw error;
    return Response.json(
      { error: { message: error.message, status: error.status } },
      {
        status: error.status,
        headers: { 'Cache-Control': 'private, no-store', 'Retry-After': String(error.retryAfter) },
      },
    );
  }
  response.headers.set('X-Liekan-Server-Time', String(Date.now()));
  if (response.ok && context.populations?.size) {
    const populations = [...context.populations.values()];
    // Full metadata lives on object contracts; legacy arrays receive a bounded summary.
    const summary = populations
      .slice(0, 4)
      .map(({ ruleVersions, catalogVersions, identity, ...population }) => ({
        ...population,
        identity: {
          ...identity,
          versions: identity.versions.slice(0, 4),
          ...(identity.qualifiedVersions ? { qualifiedVersions: identity.qualifiedVersions.slice(0, 4) } : {}),
        },
        ruleVersions: ruleVersions.slice(0, 4),
        catalogVersions: catalogVersions.slice(0, 4),
        versionSetsTruncated:
          population.versionSetsTruncated ||
          ruleVersions.length > 4 ||
          catalogVersions.length > 4 ||
          identity.versions.length > 4 ||
          (identity.qualifiedVersions?.length ?? 0) > 4,
      }));
    response.headers.set(
      'X-Liekan-Population',
      JSON.stringify({ populations: summary, truncated: populations.length > 4 }),
    );
  }

  if (response.ok && context.results.length) {
    const { results } = context;
    response.headers.set(
      'X-Liekan-Generated-At',
      String(Math.min(...results.map(r => r.generatedAt))),
    );
    response.headers.set('X-Liekan-Expires-At', String(Math.min(...results.map(r => r.expiresAt))));
    response.headers.set(
      'X-Liekan-Cache',
      results.some(r => r.status === 'miss')
        ? 'miss'
        : results.some(r => r.status === 'coalesced')
          ? 'coalesced'
          : 'hit',
    );
    response.headers.set(
      'X-Liekan-Cache-Tier',
      [...new Set(results.map(r => r.tier || 'computed'))].join(','),
    );
    response.headers.set(
      'X-Liekan-Cache-Source',
      [...new Set(results.map(r => (r.tier === 'computed' || !r.tier ? 'database' : r.tier)))].join(
        ',',
      ),
    );
    response.headers.set(
      'Server-Timing',
      `analytics;dur=${(performance.now() - start).toFixed(1)},cache;desc="${results.filter(r => r.status === 'hit').length}/${results.length}"`,
    );
    response.headers.set('Cache-Control', 'private, no-store');
  }
  return response;
}
