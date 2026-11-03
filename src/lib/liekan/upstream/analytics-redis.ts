import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { decodeAnalyticsResult, encodeAnalyticsResult, type CachedResult } from './query-cache';
import { currentCacheContext } from './cache-context';
import { processSingleton } from './process-singleton';

const PROTOCOL = 1;
const GET = `local v=redis.call('GET',KEYS[1]); if not v then return nil end; return {v,redis.call('PTTL',KEYS[1])}`;
const RENEW = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],30000) end; return 0`;
const RELEASE = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`;
const PUBLISH = `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]); redis.call('DEL',KEYS[1]); return 1`;

/** Dedicated analytics connection; failures never change the authentication Redis connection. */
export class AnalyticsRedis {
  private client?: ReturnType<typeof createClient>;
  private connecting?: Promise<void>;
  private disabledUntil = 0;
  constructor(private url = process.env.LIEKAN_ANALYTICS_REDIS_URL) {}

  get enabled() {
    return !!this.url;
  }
  async command<T>(args: string[], cleanup = false): Promise<T | null> {
    if (!this.url || (!cleanup && Date.now() < this.disabledUntil)) return null;
    const context = currentCacheContext();
    const started = performance.now();
    const waiting = context?.redisWaiting;
    // Owner-checked release has a separate reply budget after computation has expired.
    const budget = cleanup
      ? 150
      : Math.min(
          150 - (context?.redisSpentMs || 0) - (waiting ? started - waiting.startedAt : 0),
          (context?.deadline || Infinity) - Date.now(),
        );
    if (budget <= 0) return null;
    // Concurrent aggregates share one request's elapsed network wait, including connection setup.
    if (context && !cleanup) {
      context.redisWaiting ??= { count: 0, startedAt: started };
      context.redisWaiting.count++;
    }
    let timer: ReturnType<typeof setTimeout>;
    let connection = this.client;
    try {
      if (!this.client) {
        this.client = createClient({
          url: this.url,
          disableOfflineQueue: true,
          commandsQueueMaxLength: 128,
          socket: { connectTimeout: 150, reconnectStrategy: false },
        });
        this.client.on('error', () => {});
      }
      connection = this.client;
      const work = async () => {
        if (!connection.isReady) {
          this.connecting ??= connection
            .connect()
            .then(() => {})
            .finally(() => {
              this.connecting = undefined;
            });
          await this.connecting;
        }
        return (await connection.sendCommand(args, { timeout: Math.ceil(budget) })) as T;
      };
      // The library timeout ends when bytes leave the socket. Bound the entire reply wait here.
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Analytics Redis deadline')), budget);
        }),
      ]);
    } catch {
      this.disabledUntil = Date.now() + 10000;
      try {
        connection?.destroy();
      } catch {}
      if (this.client === connection) {
        this.client = undefined;
        this.connecting = undefined;
      }
      return null;
    } finally {
      clearTimeout(timer);
      if (context && !cleanup && --context.redisWaiting.count === 0) {
        context.redisSpentMs =
          (context.redisSpentMs || 0) + performance.now() - context.redisWaiting.startedAt;
        context.redisWaiting = undefined;
      }
    }
  }
  async read<T>(key: string): Promise<CachedResult<T> | 'unshareable' | 'error' | null> {
    const start = performance.now();
    const reply = await this.command<[string, number]>(['EVAL', GET, '1', `${key}:result`]);
    if (!reply || reply[1] <= 0) return null;
    try {
      const value = JSON.parse(reply[0]);
      if (value.protocol !== PROTOCOL) return null;
      if (value.marker) return value.marker === 'unshareable' ? 'unshareable' : 'error';
      const expiresAt = Math.min(
        value.expiresAt,
        Date.now() + reply[1] - (performance.now() - start),
      );
      if (
        !Number.isFinite(value.generatedAt) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
      )
        return null;
      return {
        value: decodeAnalyticsResult(Buffer.from(value.bytes, 'base64')),
        generatedAt: value.generatedAt,
        expiresAt,
        status: 'hit',
        tier: 'redis',
      };
    } catch {
      return null;
    }
  }
  async claim(key: string, forced = false, background = false): Promise<string | false | null> {
    const token = `${background ? 'b' : forced ? 'f' : 'n'}:${randomUUID()}`;
    const result = await this.command<number>([
      'EVAL',
      `if redis.call('EXISTS',KEYS[1])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'PX',30000); return 1`,
      '1',
      `${key}:lock`,
      token,
    ]);
    return result === 1 ? token : result === 0 ? false : null;
  }
  async lockMode(key: string) {
    const value = await this.command<string>(['GET', `${key}:lock`]);
    return value?.startsWith('f:')
      ? 'forced'
      : value?.startsWith('b:')
        ? 'background'
        : value
          ? 'ordinary'
          : null;
  }
  async refreshSlot(key: string, round: string) {
    const script = `local v=redis.call('GET',KEYS[1]); if v==ARGV[1] then return 1 end; if v then return 0 end;
redis.call('SET',KEYS[1],ARGV[1],'PX',5000); return 1`;
    return this.command<number>(['EVAL', script, '1', `liekan:analytics:refresh:${key}`, round]);
  }
  async renew(key: string, token: string) {
    return (await this.command<number>(['EVAL', RENEW, '1', `${key}:lock`, token])) === 1;
  }
  async release(key: string, token: string) {
    await this.command(['EVAL', RELEASE, '1', `${key}:lock`, token], true);
  }
  async publish<T>(key: string, token: string, result: CachedResult<T> | 'unshareable' | 'error') {
    const marker = typeof result === 'string' ? result : undefined;
    const ttl = typeof result === 'string' ? 2000 : result.expiresAt - Date.now();
    if (ttl <= 0) return this.publish(key, token, 'unshareable');
    const payload =
      typeof result === 'string'
        ? { protocol: PROTOCOL, marker }
        : {
            protocol: PROTOCOL,
            generatedAt: result.generatedAt,
            expiresAt: result.expiresAt,
            bytes: encodeAnalyticsResult(result.value).toString('base64'),
          };
    return (
      (await this.command<number>([
        'EVAL',
        PUBLISH,
        '2',
        `${key}:lock`,
        `${key}:result`,
        token,
        JSON.stringify(payload),
        String(Math.ceil(ttl)),
      ])) === 1
    );
  }
  close() {
    this.client?.destroy();
    this.client = undefined;
  }
}

export const analyticsRedis = processSingleton('analytics-redis', () => new AnalyticsRedis());
