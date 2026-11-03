import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryCache, type CachedResult } from './query-cache';
import { installAnalyticsRuntime } from './analytics-runtime';
import { AnalyticsRedis } from './analytics-redis';
import { analyticsGate, AnalyticsGate, analyticsComputationGate } from './analytics-budget';
import { getQuerySnapshot } from './query-snapshot';
import {
  bindCacheRequest,
  withQueryCacheHeaders,
  prepareAnalyticsVersions,
  analyticsWorkerContext,
  runCacheAuthorization,
} from './cache-context';
import { currentCacheContext } from './cache-context';
import { withinAnalysisPermit } from './analysis-permit-context';
import { primaryMetadataClient } from './analytics-deadline';

vi.mock('./analytics-hot', () => ({
  rememberAnalyticsHot: vi.fn(async () => {}),
  reserveWorkerComputation: vi.fn(async () => true),
}));
const id = '50000000-0000-4000-8000-000000000001';
const tags = [`website:${id}`];
let strong = 0,
  data = 0;
const sql = vi.fn();
function primary() {
  return {
    $transaction: async (work: (tx: any) => Promise<any>, options: any) => {
      const snapshot = options?.isolationLevel === 'RepeatableRead' ? { strong, data } : undefined;
      return work({
        $executeRawUnsafe: async (query: string) => {
          sql(query);
          return 0;
        },
        $queryRawUnsafe: async (query: string) => {
          sql(query);
          if (query.includes('FROM liekan_analytics_revision'))
            return [{ type: 'website', id, revision: String(snapshot?.strong ?? strong) }];
          if (query.includes('FROM liekan_log_state'))
            return [{ id, data: String(snapshot?.data ?? data), policy: '0' }];
          if (query.includes('SELECT role')) return [{ role: 'admin' }];
          if (query.includes('WITH resources')) return [{ id }];
          return [];
        },
      });
    },
  };
}
class MemoryRedis extends AnalyticsRedis {
  entries = new Map<string, CachedResult<any> | 'unshareable' | 'error'>();
  owners = new Map<string, string>();
  publishes = vi.fn();
  rounds = new Map<string, { round: string; at: number }>();
  serial = 0;
  async read<T>(key: string) {
    const entry = this.entries.get(key);
    return typeof entry === 'string'
      ? entry
      : entry && entry.expiresAt > Date.now()
        ? ({ ...entry, status: 'hit' as const } as CachedResult<T>)
        : null;
  }
  async claim(key: string, forced = false, background = false) {
    if (this.owners.has(key)) return false as const;
    const owner = `${background ? 'b' : forced ? 'f' : 'n'}:${++this.serial}`;
    this.owners.set(key, owner);
    return owner;
  }
  async lockMode(key: string): Promise<'forced' | 'ordinary' | 'background' | null> {
    const owner = this.owners.get(key);
    return owner?.startsWith('f:')
      ? 'forced'
      : owner?.startsWith('b:')
        ? 'background'
        : owner
          ? 'ordinary'
          : null;
  }
  async refreshSlot(key: string, round: string) {
    const previous = this.rounds.get(key);
    if (previous && previous.at > Date.now() - 5000) return previous.round === round ? 1 : 0;
    this.rounds.set(key, { round, at: Date.now() });
    return 1;
  }
  async renew(key: string, token: string) {
    return this.owners.get(key) === token;
  }
  async release(key: string, token: string) {
    if (this.owners.get(key) === token) this.owners.delete(key);
  }
  async publish<T>(key: string, token: string, result: CachedResult<T> | 'unshareable' | 'error') {
    this.publishes(result);
    if (this.owners.get(key) !== token) return false;
    this.entries.set(key, result);
    this.owners.delete(key);
    return true;
  }
}
const disabled = () => new AnalyticsRedis('');
beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost/test');
  strong = 0;
  data = 0;
  sql.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it('coalesces fifty viewers, clones their results, and always computes on a primary snapshot', async () => {
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, disabled());
  const load = vi.fn(async () => {
    expect(getQuerySnapshot()).toBeDefined();
    expect(sql.mock.calls.some(([statement]) => statement === 'SET LOCAL jit=off')).toBe(true);
    return { count: 1n };
  });
  const values = await Promise.all(
    Array.from({ length: 50 }, () => cache.read('a', 30000, tags, load)),
  );
  expect(load).toHaveBeenCalledOnce();
  values[0].value.count = 9n;
  expect(values[1].value.count).toBe(1n);
  expect((await cache.read('a', 30000, tags, load)).status).toBe('hit');
  expect(analyticsGate.state).toEqual({ active: 0, queued: 0 });
});

it.each([false, true])(
  'caches a slow successful snapshot after computation (Redis %s)',
  async shared => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1000);
    const cache = new QueryCache();
    installAnalyticsRuntime(cache, primary, shared ? new MemoryRedis('') : disabled());
    const load = vi.fn(async () => {
      vi.setSystemTime(36000);
      return { count: 7 };
    });
    const first = await cache.read('slow-success', 30000, tags, load);
    expect(first.generatedAt).toBe(1000);
    expect(first.expiresAt).toBe(66000);
    vi.setSystemTime(65999);
    expect((await cache.read('slow-success', 30000, tags, load)).status).toBe('hit');
    expect(load).toHaveBeenCalledOnce();
  },
);
it.each([true, false])(
  'reuses the bound primary transaction and enforces background authorization %s',
  async allowed => {
    const cache = new QueryCache(),
      redis = new MemoryRedis('');
    const transaction = vi.fn(primary().$transaction);
    installAnalyticsRuntime(
      cache,
      () => primaryMetadataClient() || { $transaction: transaction },
      redis,
    );
    const authorization = vi.fn(() =>
      runCacheAuthorization(async () => {
        const client = primaryMetadataClient();
        expect(client).toBeDefined();
        expect(client.$transaction).toBeUndefined();
        await client.$queryRawUnsafe('SELECT role FROM "user"');
        return allowed;
      }),
    );
    const completion = analyticsWorkerContext(
      id,
      { private: true },
      () => cache.read('background-final-authorization', 30000, tags, async () => ({ count: 7 })),
      { reauthorize: authorization },
    );
    if (allowed) expect((await completion).value).toEqual({ count: 7 });
    else await expect(completion).rejects.toMatchObject({ status: 403 });
    expect(authorization).toHaveBeenCalledOnce();
    expect(redis.publishes).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledTimes(5);
  },
);
it('keeps an in-progress computation joined when another server bundle installs the shared runtime', async () => {
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, disabled());
  let release!: () => void, began!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const started = new Promise<void>(resolve => {
    began = resolve;
  });
  const load = vi.fn(async () => {
    began();
    await held;
    return { count: 1 };
  });
  const first = cache.read('bundle-shared', 30000, tags, load);
  await started;
  installAnalyticsRuntime(cache, primary, disabled());
  const second = cache.read('bundle-shared', 30000, tags, load);
  await new Promise(resolve => setTimeout(resolve, 0));
  release();
  await Promise.all([first, second]);
  expect(load).toHaveBeenCalledOnce();
});
it('uses Redis across processes and preserves original expiration through the local tier', async () => {
  const redis = new MemoryRedis('');
  const first = new QueryCache(),
    second = new QueryCache();
  installAnalyticsRuntime(first, primary, redis);
  installAnalyticsRuntime(second, primary, redis);
  const load = vi.fn(async () => ({ count: 10 }));
  const miss = await first.read('a', 30000, tags, load),
    hit = await second.read('a', 30000, tags, load);
  expect(load).toHaveBeenCalledOnce();
  expect(hit.status).toBe('hit');
  expect(hit.expiresAt).toBe(miss.expiresAt);
  strong++;
  expect((await second.read('a', 30000, tags, load)).status).toBe('miss');
  expect(load).toHaveBeenCalledTimes(2);
});
it('rechecks a shared result published between the initial miss and lease acquisition', async () => {
  const redis = new MemoryRedis('');
  const first = new QueryCache(),
    second = new QueryCache();
  installAnalyticsRuntime(first, primary, redis);
  installAnalyticsRuntime(second, primary, redis);
  let releaseCompute!: () => void, published!: () => void;
  const computation = new Promise<void>(resolve => {
    releaseCompute = resolve;
  });
  const publication = new Promise<void>(resolve => {
    published = resolve;
  });
  const claim = redis.claim.bind(redis),
    publish = redis.publish.bind(redis);
  let claims = 0;
  redis.claim = async (...args) => {
    if (++claims === 2) {
      releaseCompute();
      await publication;
    }
    return claim(...args);
  };
  redis.publish = async (...args) => {
    const result = await publish(...args);
    published();
    return result;
  };
  const load = vi.fn(async () => {
    await computation;
    return { count: 10 };
  });
  const results = await Promise.all([
    first.read('race', 30000, tags, load),
    second.read('race', 30000, tags, load),
  ]);
  expect(load).toHaveBeenCalledOnce();
  expect(results[1].generatedAt).toBe(results[0].generatedAt);
  expect(redis.owners.size).toBe(0);
});
it('does not start duplicate SQL when Redis becomes unavailable while another lease is active', async () => {
  const redis = new MemoryRedis('');
  redis.claim = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(null);
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, redis);
  const load = vi.fn(async () => ({ count: 10 }));
  await expect(cache.read('active-lease', 30000, tags, load)).rejects.toMatchObject({
    status: 503,
  });
  expect(load).not.toHaveBeenCalled();
});
it('discards a computation crossed by a strong write and retries on the new revision', async () => {
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, disabled());
  const load = vi.fn(async () => {
    if (load.mock.calls.length === 1) strong++;
    return { version: strong };
  });
  expect((await cache.read('a', 30000, tags, load)).value).toEqual({ version: 1 });
  expect(load).toHaveBeenCalledTimes(2);
});
it('keeps a bounded snapshot reusable while log ingestion continues', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1000);
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, disabled());
  const load = vi.fn(async () => {
    data++;
    vi.setSystemTime(Date.now() + 13000);
    return { count: data };
  });
  const result = await cache.read('a', 30000, tags, load);
  expect(result.expiresAt).toBe(44000);
  data++;
  vi.setSystemTime(43999);
  const warm = await cache.read('a', 30000, tags, load);
  expect(warm.status).toBe('hit');
  expect(warm.value).toEqual({ count: 1 });
  expect(warm.expiresAt).toBe(44000);
  expect(load).toHaveBeenCalledOnce();
  vi.setSystemTime(44000);
  expect((await cache.read('a', 30000, tags, load)).value).toEqual({ count: 3 });
  expect(load).toHaveBeenCalledTimes(2);
});
it.each([false, true])(
  'shares a snapshot across instances when ingestion advances before acquisition (prepared=%s)',
  async prepared => {
    const cache = new QueryCache();
    const putLocal = vi.spyOn(cache, 'putLocal');
    const redis = new MemoryRedis('');
    const connection = primary();
    installAnalyticsRuntime(
      cache,
      () => ({
        $transaction: async (work: (tx: any) => Promise<any>, options: any) => {
          if (options?.isolationLevel === 'RepeatableRead') data++;
          return connection.$transaction(work, options);
        },
      }),
      redis,
    );
    const load = vi.fn(async () => {
      const [row] = (await getQuerySnapshot().$queryRawUnsafe(
        'SELECT * FROM liekan_log_state',
      )) as { data: string }[];
      return { revision: row.data };
    });
    for (const revision of ['1', '1']) {
      let result: CachedResult<{ revision: string }>;
      const read = async () => {
        result = await cache.read('ingestion-before-snapshot', 30000, tags, load);
        return Response.json(result.value);
      };
      const response = prepared
        ? await withQueryCacheHeaders(async () => {
            await prepareAnalyticsVersions(tags);
            return read();
          })
        : await read();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ revision });
      expect(result.expiresAt).toBeGreaterThan(Date.now());
      // Use another process-local cache for the second read, exercising Redis reuse.
      cache.clear();
    }
    expect(load).toHaveBeenCalledOnce();
    expect(strong).toBe(0);
    expect(data).toBe(1);
    expect(putLocal).toHaveBeenCalledTimes(2);
    expect(redis.publishes).toHaveBeenCalledOnce();
  },
);

it('refreshes a bounded snapshot on demand and fences strong mutations immediately', async () => {
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, disabled());
  const load = vi.fn(async () => ({ data, strong }));
  await cache.read('bounded-refresh', 30000, tags, load);
  data++;
  expect((await cache.read('bounded-refresh', 30000, tags, load)).status).toBe('hit');
  expect((await cache.read('bounded-refresh', 30000, tags, load, true)).value).toEqual({
    data: 1,
    strong: 0,
  });
  strong++;
  expect((await cache.read('bounded-refresh', 30000, tags, load)).value).toEqual({
    data: 1,
    strong: 1,
  });
  expect(load).toHaveBeenCalledTimes(3);
});
it('restarts the whole request when a definition changed after resolving filters', async () => {
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, disabled());
  let calls = 0;
  const response = await withQueryCacheHeaders(async () => {
    await prepareAnalyticsVersions(tags);
    const resolved = strong;
    if (++calls === 1) strong++;
    const result = await cache.read('a', 30000, tags, async () => ({ version: resolved }));
    return Response.json(result.value);
  });
  expect(await response.json()).toEqual({ version: 1 });
  expect(calls).toBe(2);
});
it('isolates public scopes and rechecks authorization before cached data is returned', async () => {
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, disabled());
  const load = vi.fn(async () => ({ count: 1 }));
  for (const goals of [true, false])
    await withQueryCacheHeaders(async () => {
      bindCacheRequest(new Request('http://localhost'), {
        shareToken: { shareId: id, parameters: { goals } },
      });
      await cache.read('a', 30000, tags, load);
      return Response.json({});
    });
  expect(load).toHaveBeenCalledTimes(2);
});
it('routes oversized and degraded results through the same bounded computation gate', async () => {
  const redis = new MemoryRedis('');
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, redis);
  const load = vi.fn(async () => 'x'.repeat(2 * 1024 * 1024));
  await cache.read('a', 30000, tags, load);
  const next = await cache.read('a', 30000, tags, load);
  expect(load).toHaveBeenCalledTimes(2);
  expect(next.expiresAt).toBeGreaterThanOrEqual(next.generatedAt + 30000);
  expect(redis.publishes).toHaveBeenCalledWith('unshareable');
});
it('waits for ordinary work before a forced refresh and coalesces duplicate forced calls', async () => {
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, disabled());
  let release: () => void;
  const barrier = new Promise<void>(resolve => {
    release = resolve;
  });
  const load = vi.fn(async () => {
    if (load.mock.calls.length === 1) await barrier;
    return load.mock.calls.length;
  });
  const ordinary = cache.read('a', 30000, tags, load);
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  const forced = cache.read('a', 30000, tags, load, true);
  release();
  await ordinary;
  await forced;
  expect(load).toHaveBeenCalledTimes(2);
  await expect(cache.read('a', 30000, tags, load, true)).rejects.toMatchObject({ status: 429 });
});
it('sets real SQL timeouts before execution and releases concurrency after the transaction settles', async () => {
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, disabled());
  await cache.read('a', 30000, tags, async () => {
    await getQuerySnapshot().$queryRawUnsafe('SELECT 1');
    return 1;
  });
  expect(sql.mock.calls.some(([query]) => /^SET LOCAL statement_timeout = \d+$/.test(query))).toBe(
    true,
  );
  const gate = new AnalyticsGate(1, 1, 20);
  let release: () => void;
  const running = gate.run(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
  );
  await expect(gate.run(async () => 1)).rejects.toMatchObject({ status: 503 });
  expect(gate.state.active).toBe(1);
  release();
  await running;
  expect(gate.state.active).toBe(0);
});
it.each([
  'metadata-acquisition',
  'metadata-statements',
  'compute-acquisition',
  'early-statement',
  'expired-transaction',
  'expired-statement',
  'expired-before-statement',
])('preserves the runtime retry classification for %s', async phase => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1000);
  const cache = new QueryCache();
  const failure = Object.assign(
    new Error(
      phase === 'expired-statement'
        ? 'canceling statement due to statement timeout'
        : 'Unable to start a transaction in the given time',
    ),
    phase === 'expired-statement' ? { code: 'P2010', meta: { code: '57014' } } : { code: 'P2028' },
  );
  const provider = () => ({
    $transaction: async (work: (tx: unknown) => Promise<unknown>, options: any) => {
      if (
        phase === 'metadata-acquisition' ||
        (phase === 'compute-acquisition' && options.isolationLevel === 'RepeatableRead')
      )
        throw failure;
      return primary().$transaction(async tx => {
        if (phase === 'metadata-statements') {
          const query = tx.$queryRawUnsafe;
          tx.$queryRawUnsafe = async (statement: string) => {
            const result = await query(statement);
            if (statement.includes('FROM liekan_analytics_revision')) vi.setSystemTime(6001);
            return result;
          };
        }
        return work(tx);
      }, options);
    },
  });
  installAnalyticsRuntime(cache, provider, disabled());
  const load = vi.fn(async () => {
    if (phase.startsWith('expired-')) vi.setSystemTime(61001);
    if (phase === 'expired-before-statement') return getQuerySnapshot().$queryRawUnsafe('SELECT 1');
    throw failure;
  });
  await expect(cache.read('runtime-timeout-' + phase, 30000, tags, load)).rejects.toMatchObject({
    status: 503,
    code: phase.startsWith('expired-') ? 'analysis-query-timeout' : 'liekan-error',
  });
  expect(load).toHaveBeenCalledTimes(
    phase.startsWith('metadata-') || phase.endsWith('acquisition') ? 0 : 1,
  );
  expect(analyticsGate.state).toEqual({ active: 0, queued: 0 });
});
it.each(['leader', 'joined'])(
  'checks each consumer when the %s membership is removed during shared computation',
  async victim => {
    const a = '50000000-0000-4000-8000-000000000002',
      b = '50000000-0000-4000-8000-000000000003';
    const allowed = new Set([a, b]);
    const provider = () => ({
      $transaction: async (work: any, options: any) =>
        primary().$transaction(async tx => {
          const read = tx.$queryRawUnsafe;
          tx.$queryRawUnsafe = async (query: string, ...args: any[]) =>
            query.includes('SELECT role')
              ? [{ role: 'user' }]
              : query.includes('WITH resources')
                ? allowed.has(args[1])
                  ? [{ id }]
                  : []
                : read(query);
          return work(tx);
        }, options),
    });
    const cache = new QueryCache();
    installAnalyticsRuntime(cache, provider, disabled());
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    const load = vi.fn(async () => {
      await barrier;
      return { count: 10 };
    });
    const request = (actor: string) =>
      withQueryCacheHeaders(async () => {
        bindCacheRequest(new Request('http://localhost'), { user: { id: actor } });
        const result = await cache.read('same', 30000, tags, load);
        return Response.json(result.value);
      });
    const first = request(a);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    const joined = request(b);
    await new Promise(resolve => setTimeout(resolve, 10));
    allowed.delete(victim === 'leader' ? a : b);
    release();
    expect((await first).status).toBe(victim === 'leader' ? 403 : 200);
    expect((await joined).status).toBe(victim === 'joined' ? 403 : 200);
    expect(load).toHaveBeenCalledOnce();
    expect(currentCacheContext()).toBeUndefined();
  },
);
it('keeps a joined-reader wait timeout transient while the producer can still finish', async () => {
  vi.useFakeTimers();
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, disabled());
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => (release = resolve));
  const entered = new Promise<void>(resolve => (started = resolve));
  const load = vi.fn(async () => {
    started();
    await held;
    return 7;
  });
  const producer = analyticsWorkerContext(id, { private: true }, () =>
    cache.read('joined-wait', 30000, tags, load),
  );
  await entered;
  try {
    const waiting = analyticsWorkerContext(
      id,
      { private: true },
      () => cache.read('joined-wait', 30000, tags, load),
      { deadline: Date.now() + 30 },
    ).catch(error => error);
    await vi.advanceTimersByTimeAsync(30);
    expect(await waiting).toMatchObject({ status: 503, code: 'liekan-error' });
    expect(load).toHaveBeenCalledOnce();
  } finally {
    release();
    expect((await producer).value).toBe(7);
  }
});
it('coalesces manual refreshes across instances and applies the actor cooldown across instances', async () => {
  const redis = new MemoryRedis(''),
    first = new QueryCache(),
    second = new QueryCache();
  installAnalyticsRuntime(first, primary, redis);
  installAnalyticsRuntime(second, primary, redis);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => {
    release = resolve;
  });
  const load = vi.fn(async () => {
    await barrier;
    return { count: 10 };
  });
  const request = (cache: QueryCache) =>
    withQueryCacheHeaders(async () => {
      bindCacheRequest(new Request('http://localhost?refresh=1'), { user: { id, role: 'admin' } });
      return Response.json((await cache.read('manual', 30000, tags, load)).value);
    });
  const one = request(first);
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  const two = request(second);
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  expect((await one).ok).toBe(true);
  expect((await two).ok).toBe(true);
  expect(load).toHaveBeenCalledOnce();
  expect((await request(second)).status).toBe(429);
});
it('starts a new manual snapshot after a background preheat that had already started on another instance', async () => {
  const redis = new MemoryRedis(''),
    worker = new QueryCache(),
    application = new QueryCache();
  installAnalyticsRuntime(worker, primary, redis);
  installAnalyticsRuntime(application, primary, redis);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => {
    release = resolve;
  });
  const load = vi.fn(async () => {
    if (load.mock.calls.length === 1) await barrier;
    return load.mock.calls.length;
  });
  const background = analyticsWorkerContext(id, { private: true }, () =>
    worker.read('same', 30000, tags, load),
  );
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  const manual = withQueryCacheHeaders(async () => {
    bindCacheRequest(new Request('http://localhost?refresh=1'), { user: { id, role: 'admin' } });
    return Response.json((await application.read('same', 30000, tags, load)).value);
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  await background;
  expect(await (await manual).json()).toBe(2);
  expect(load).toHaveBeenCalledTimes(2);
});

it('expires a queued gate within the consumer deadline while retaining the active computation', async () => {
  vi.useFakeTimers();
  const gate = new AnalyticsGate(1, 32, 5000);
  let release!: () => void;
  const active = gate.run(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
  );
  const queued = gate.run(async () => 7, Date.now() + 30).catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  expect(await queued).toMatchObject({ status: 503 });
  expect(gate.state).toEqual({ active: 1, queued: 0 });
  release();
  await active;
  expect(gate.state).toEqual({ active: 0, queued: 0 });
});
it('restarts joined prepared requests after a strong revision changes during their shared flight', async () => {
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, disabled());
  let release!: () => void;
  const barrier = new Promise<void>(resolve => {
    release = resolve;
  });
  const load = vi.fn(async () => {
    if (load.mock.calls.length === 1) await barrier;
    return { version: strong };
  });
  const request = () =>
    withQueryCacheHeaders(async () => {
      await prepareAnalyticsVersions(tags);
      return Response.json((await cache.read('shared-restart', 30000, tags, load)).value);
    });
  const first = request();
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  const joined = request();
  await new Promise(resolve => setTimeout(resolve, 10));
  strong++;
  release();
  for (const response of await Promise.all([first, joined])) {
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1 });
  }
  expect(load).toHaveBeenCalledTimes(2);
});

it('keeps dashboard computation independent of occupied heavy computation slots', async () => {
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, disabled());
  let release!: () => void,
    allStarted!: () => void,
    active = 0;
  const held = new Promise<void>(resolve => (release = resolve)),
    started = new Promise<void>(resolve => (allStarted = resolve));
  const heavy = [0, 1].map(i =>
    cache.read('occupied-heavy-' + i, 30000, tags, async () => {
      if (++active === 2) allStarted();
      await held;
      return i;
    }),
  );
  await started;
  const shortLoad = vi.fn(async () => ({ ready: 7 }));
  const short = withinAnalysisPermit({ token: id, epoch: '1', lane: 'dashboard' }, () =>
    cache.read('independent-dashboard', 30000, tags, shortLoad),
  );
  try {
    await vi.waitFor(() => expect(shortLoad).toHaveBeenCalledOnce(), { timeout: 1000 });
    expect((await short).value).toEqual({ ready: 7 });
  } finally {
    release();
    await Promise.allSettled([...heavy, short]);
  }
});
it('admits two dashboard computations and queues a third until a slot settles', async () => {
  const cache = new QueryCache();
  installAnalyticsRuntime(cache, primary, disabled());
  const permit = { token: id, epoch: '1', lane: 'dashboard' as const };
  const gate = await withinAnalysisPermit(permit, async () => analyticsComputationGate());
  const releases: (() => void)[] = [];
  const run = (key: string, load: () => Promise<unknown>) =>
    withinAnalysisPermit(permit, () => cache.read(key, 30000, tags, load));
  const first = run(
    'dashboard-first',
    () => new Promise(resolve => releases.push(() => resolve(1))),
  );
  const second = run(
    'dashboard-second',
    () => new Promise(resolve => releases.push(() => resolve(2))),
  );
  let third: Promise<unknown>;
  const thirdLoad = vi.fn(async () => 3);
  try {
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    third = run('dashboard-third', thirdLoad);
    await vi.waitFor(() => expect(gate.state).toEqual({ active: 2, queued: 1 }));
    expect(thirdLoad).not.toHaveBeenCalled();
    releases[0]();
    await first;
    await third;
    expect(thirdLoad).toHaveBeenCalledOnce();
    expect(gate.state).toEqual({ active: 1, queued: 0 });
  } finally {
    for (const release of releases) release();
    await Promise.allSettled([first, second, third]);
  }
});
