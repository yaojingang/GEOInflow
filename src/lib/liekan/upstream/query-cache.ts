import { currentCacheContext, CacheProbeMiss } from './cache-context';
import { getPublishedCatalog } from '../crawlers/published';
import { geographyVersion } from '../contracts/geography';
import { GEOGRAPHY_ANCHOR_VERSION } from '../geography/evidence';
import { analyticsCacheLimits } from './cache-policy';
import { ANALYTICS_READ_VERSION } from './analytics-revision';
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { Decimal } from '@prisma/client/runtime/client';

// Tagged containers keep user-provided object fields separate from the wire codec.
function pack(value: any): any {
  if (Decimal.isDecimal(value)) return [3, value.toString()];
  if (Array.isArray(value)) return [1, value.map(pack)];
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return [2, Object.entries(value).map(([key, item]) => [key, pack(item)])];
  return [0, value];
}
function unpack([kind, value]: any): any {
  if (kind === 3) return new Decimal(value);
  if (kind === 1) return value.map(unpack);
  if (kind === 2) return Object.fromEntries(value.map(([key, item]: any) => [key, unpack(item)]));
  return value;
}
export const encodeAnalyticsResult = (value: unknown) => serialize(pack(value));
export const decodeAnalyticsResult = (bytes: Buffer) => unpack(deserialize(bytes));
const encode = encodeAnalyticsResult;
const decode = decodeAnalyticsResult;

export interface CachedResult<T> {
  value: T;
  generatedAt: number;
  expiresAt: number;
  status: 'hit' | 'miss' | 'coalesced';
  tier?: 'memory' | 'redis' | 'computed';
}
interface Entry {
  bytes: Buffer;
  tags: string[];
  generatedAt: number;
  expiresAt: number;
}
interface Flight {
  tags: string[];
  refreshed?: boolean;
  promise: Promise<CachedResult<unknown>>;
}

/** Bounded, process-local derived data. Authorization is performed by each caller. */
export class QueryCache {
  private runtime?: <T>(
    key: string,
    ttl: number,
    tags: string[],
    load: () => Promise<T>,
    refresh: boolean,
  ) => Promise<CachedResult<T>>;
  private probe?: <T>(key: string, tags: string[]) => Promise<CachedResult<T> | undefined>;
  configureProbe(probe: QueryCache['probe']) {
    this.probe = probe;
  }
  peek<T>(key: string, tags: string[]): Promise<CachedResult<T> | undefined> {
    return this.probe ? this.probe<T>(key, tags) : Promise.resolve(this.getLocal<T>(key));
  }
  private entries = new Map<string, Entry>();
  private flights = new Map<string, Flight>();
  private bytes = 0;

  constructor(
    private maxEntries: number = analyticsCacheLimits.entries,
    private maxBytes: number = analyticsCacheLimits.bytes,
    private now = Date.now,
  ) {}

  configure(runtime: QueryCache['runtime']) {
    this.runtime = runtime;
  }
  get isRuntimeConfigured() {
    return !!this.runtime;
  }

  getLocal<T>(key: string): CachedResult<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      this.remove(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return {
      value: decode(entry.bytes),
      generatedAt: entry.generatedAt,
      expiresAt: entry.expiresAt,
      status: 'hit',
      tier: 'memory',
    };
  }

  putLocal<T>(key: string, result: CachedResult<T>, tags: string[]) {
    const bytes = encode(result.value);
    if (
      result.expiresAt <= this.now() ||
      bytes.length > Math.min(this.maxBytes, analyticsCacheLimits.resultBytes)
    )
      return;
    this.remove(key);
    for (const [oldKey, old] of this.entries) if (old.expiresAt <= this.now()) this.remove(oldKey);
    while (this.entries.size >= this.maxEntries || this.bytes + bytes.length > this.maxBytes)
      this.remove(this.entries.keys().next().value!);
    this.entries.set(key, {
      bytes,
      tags,
      generatedAt: result.generatedAt,
      expiresAt: result.expiresAt,
    });
    this.bytes += bytes.length;
  }

  invalidate(tag: string) {
    for (const [key, entry] of this.entries) if (entry.tags.includes(tag)) this.remove(key);
    // Removing the flight also prevents its pre-write result from repopulating the cache.
    for (const [key, flight] of this.flights)
      if (flight.tags.includes(tag)) this.flights.delete(key);
  }

  clear() {
    this.entries.clear();
    this.flights.clear();
    this.bytes = 0;
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes.length;
    this.entries.delete(key);
  }

  async read<T>(
    key: string,
    ttl: number,
    tags: string[],
    load: () => Promise<T>,
    refresh = false,
  ): Promise<CachedResult<T>> {
    if (currentCacheContext()?.probeOnly) {
      const cached = await this.peek<T>(key, tags);
      if (!cached) throw new CacheProbeMiss();
      return cached;
    }
    if (this.runtime) return this.runtime(key, ttl, tags, load, refresh);
    if (refresh) this.remove(key);
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return {
        value: decode(entry.bytes),
        generatedAt: entry.generatedAt,
        expiresAt: entry.expiresAt,
        status: 'hit',
      };
    }
    this.remove(key);
    const existing = this.flights.get(key);
    if (existing && (!refresh || existing.refreshed)) {
      const result = await existing.promise;
      return {
        ...result,
        value: decode(encode(result.value)),
        status: 'coalesced',
      } as CachedResult<T>;
    }
    if (existing) this.flights.delete(key);
    const generatedAt = this.now();
    // Overflow requests remain uncached, so distinct requests cannot grow the flight map indefinitely.
    if (this.flights.size >= this.maxEntries)
      return { value: await load(), generatedAt, expiresAt: generatedAt, status: 'miss' };
    const flight = { tags, refreshed: refresh, promise: null } as Flight;
    flight.promise = Promise.resolve()
      .then(load)
      .then(value => {
        const expiresAt = this.now() + ttl;
        const bytes = encode(value);
        if (
          this.flights.get(key) === flight &&
          expiresAt > this.now() &&
          bytes.length <= this.maxBytes
        ) {
          for (const [oldKey, old] of this.entries)
            if (old.expiresAt <= this.now()) this.remove(oldKey);
          while (this.entries.size >= this.maxEntries || this.bytes + bytes.length > this.maxBytes)
            this.remove(this.entries.keys().next().value!);
          this.entries.set(key, { bytes, tags, generatedAt, expiresAt });
          this.bytes += bytes.length;
        }
        return { value, generatedAt, expiresAt, status: 'miss' as const };
      })
      .finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
      });
    this.flights.set(key, flight);
    const result = await flight.promise;
    return { ...result, value: decode(encode(result.value)) } as CachedResult<T>;
  }
}

const symbol = Symbol.for('liekan.analytics-cache.v1');
const shared = globalThis as typeof globalThis & { [symbol]?: QueryCache };
export const analyticsCache = (shared[symbol] ??= new QueryCache());
export const websiteCacheTag = (id: string) => `website:${id.toLowerCase()}`;
export function invalidateWebsiteAnalytics(...ids: string[]) {
  const websites = [...new Set(ids.filter(Boolean))];
  for (const id of websites) analyticsCache.invalidate(websiteCacheTag(id));
  // Queue production is advisory and cannot roll back a completed mutation.
  void import('./analytics-hot')
    .then(module => module.notifyAnalyticsHotInvalidation(websites))
    .catch(() => {});
}
export function analyticsCacheKey(namespace: string, value: unknown) {
  namespace = `${namespace}:${ANALYTICS_READ_VERSION}:${getPublishedCatalog()?.version || 'bundled'}:${geographyVersion}:${GEOGRAPHY_ANCHOR_VERSION}`;
  return analyticsInfrastructureKey(namespace, value);
}
/** Infrastructure and permission identities stay stable across request catalog snapshots. */
export function analyticsInfrastructureKey(namespace: string, value: unknown) {
  const canonical = (item: any): any => {
    if (item instanceof Date) return item.toISOString();
    if (typeof item === 'bigint') return { bigint: String(item) };
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map(key => [key, canonical(item[key])]),
      );
    return item;
  };
  return createHash('sha256')
    .update(namespace)
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
