import { analyticsCacheLimits } from './cache-policy';
import { dashboardClock } from './dashboard-clock';
import {
  analyticsComputationGate,
  AnalyticsRestart,
  AnalyticsUnavailable,
} from './analytics-budget';
import {
  currentCacheContext,
  installVersionReader,
  installAuthorizationRunner,
  runCacheAuthorization,
} from './cache-context';
import { analyticsRedis, type AnalyticsRedis } from './analytics-redis';
import { readAnalyticsVersions, type AnalyticsVersions } from './analytics-revision';
import {
  analyticsCacheKey,
  analyticsInfrastructureKey,
  decodeAnalyticsResult,
  encodeAnalyticsResult,
  type CachedResult,
  type QueryCache,
} from './query-cache';
import { withinQuerySnapshot } from './query-snapshot';
import { randomUUID } from 'node:crypto';
import { rememberAnalyticsHot, reserveWorkerComputation } from './analytics-hot';
import {
  analyticsRemaining,
  analyticsQueryFailure,
  primaryMetadataClient,
  timedAnalyticsClient,
  withinPrimaryMetadata,
} from './analytics-deadline';

class RevisionChanged extends Error {}
interface Flight {
  forced: boolean;
  background: boolean;
  promise: Promise<CachedResult<any>>;
}
interface MetadataBatch {
  limit: number;
  promise: Promise<AnalyticsVersions>;
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function joinFlight<T>(promise: Promise<T>, deadline: number) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AnalyticsUnavailable('统计查询超时，请缩小时间范围后重试', 5, 503)),
          analyticsRemaining(deadline),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Install after Prisma initialization; the runtime takes an explicit primary connection. */
export function installAnalyticsRuntime(
  cache: QueryCache,
  primary: () => any,
  redis: AnalyticsRedis = analyticsRedis,
) {
  if (cache.isRuntimeConfigured) return;
  const flights = new Map<string, Flight>();
  const refreshes = new Map<string, { at: number; round: string }>();
  const metadataBatches = new WeakMap<
    NonNullable<ReturnType<typeof currentCacheContext>>,
    Map<string, MetadataBatch>
  >();
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema))
    throw new Error('Invalid analytics database schema');
  const url = new URL(process.env.DATABASE_URL);
  const database = analyticsInfrastructureKey('database-v1', [
    url.protocol,
    url.host,
    url.pathname,
    schema,
  ]);

  async function readVersions(
    tags: string[],
    limit: number,
    authorize: boolean,
    identity: { actor?: string; private: boolean },
  ): Promise<AnalyticsVersions> {
    return primary().$transaction(
      async (transaction: any) => {
        const tx = timedAnalyticsClient(transaction, limit);
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        if (authorize && identity.private && identity.actor) {
          const ids = [...new Set(tags.map(tag => tag.split(':')[1]))];
          const users = await tx.$queryRawUnsafe(
            'SELECT role FROM "user" WHERE user_id=$1::uuid AND deleted_at IS NULL',
            identity.actor,
          );
          if (!users.length) throw new AnalyticsUnavailable('登录状态已失效', 0, 401);
          if (ids.length) {
            const allowed = await tx.$queryRawUnsafe(
              `WITH resources AS (
              SELECT website_id AS id,user_id,team_id FROM website WHERE deleted_at IS NULL
              UNION ALL SELECT link_id,user_id,team_id FROM link WHERE deleted_at IS NULL
              UNION ALL SELECT pixel_id,user_id,team_id FROM pixel WHERE deleted_at IS NULL)
             SELECT DISTINCT r.id::text AS id FROM resources r WHERE r.id=ANY($1::uuid[]) AND
             ($3::text='admin' OR r.user_id=$2::uuid OR (r.user_id IS NULL AND EXISTS (
               SELECT 1 FROM team_user m JOIN team t ON t.team_id=m.team_id
               WHERE m.team_id=r.team_id AND m.user_id=$2::uuid AND t.deleted_at IS NULL)))`,
              ids,
              identity.actor,
              users[0].role,
            );
            if (allowed.length !== ids.length)
              throw new AnalyticsUnavailable('资源访问权限已变更', 0, 403);
          }
        }
        return readAnalyticsVersions(tx, tags);
      },
      { timeout: analyticsRemaining(limit), maxWait: Math.min(5000, analyticsRemaining(limit)) },
    );
  }
  async function versions(
    tags: string[],
    fresh = false,
    deadline = currentCacheContext()?.deadline || Date.now() + 5000,
    authorize = true,
  ): Promise<AnalyticsVersions> {
    const normalizedTags = [...new Set(tags)].sort();
    const key = JSON.stringify(normalizedTags);
    const context = currentCacheContext();
    if (!fresh && context?.versions?.has(key))
      return context.versions.get(key) as Promise<AnalyticsVersions>;
    const limit = Math.min(deadline, Date.now() + 5000);
    const identity = { actor: context?.actor, private: !!(context?.scope as any)?.private };
    if (fresh && context) {
      let batches = metadataBatches.get(context);
      if (!batches) metadataBatches.set(context, (batches = new Map()));
      const batchKey = analyticsCacheKey('metadata-batch-v1', [
        normalizedTags,
        authorize,
        context.actor,
        context.scope,
      ]);
      const pending = batches.get(batchKey);
      if (pending) {
        pending.limit = Math.min(pending.limit, limit);
        return pending.promise;
      }
      let resolve!: (value: AnalyticsVersions) => void;
      let reject!: (error: unknown) => void;
      const batch: MetadataBatch = {
        limit,
        promise: new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      };
      batches.set(batchKey, batch);
      queueMicrotask(() => {
        // Close before SQL starts: a later ready result must obtain its own current check.
        batches.delete(batchKey);
        if (!batches.size) metadataBatches.delete(context);
        void readVersions(normalizedTags, batch.limit, authorize, identity).then(resolve, reject);
      });
      return batch.promise;
    }
    const promise = readVersions(normalizedTags, limit, authorize, identity);
    if (!fresh) context?.versions?.set(key, promise);
    return promise;
  }
  installVersionReader(tags => versions(tags));
  installAuthorizationRunner(async work => {
    if (primaryMetadataClient()) return work();
    const deadline = Math.min(currentCacheContext()?.deadline || Infinity, Date.now() + 5000);
    return primary().$transaction(
      async transaction => {
        const tx = timedAnalyticsClient(transaction, deadline);
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        return withinPrimaryMetadata(tx, work);
      },
      {
        timeout: analyticsRemaining(deadline),
        maxWait: Math.min(5000, analyticsRemaining(deadline)),
      },
    );
  });

  async function compute<T>(
    tags: string[],
    expected: AnalyticsVersions,
    ttl: number,
    load: () => Promise<T>,
    deadline: number,
  ): Promise<CachedResult<T>> {
    return analyticsComputationGate().run(async () => {
      if (
        currentCacheContext()?.background &&
        currentCacheContext()?.workKind !== 'interactive' &&
        !(await reserveWorkerComputation())
      )
        throw new AnalyticsUnavailable();
      const generatedAt = Date.now();
      const computeDeadline = Math.min(deadline, generatedAt + 60000);
      const remaining = () => analyticsRemaining(computeDeadline);
      let computing = false;
      const value = await primary()
        .$transaction(
          async (transaction: any) => {
            const tx = timedAnalyticsClient(transaction, computeDeadline);
            await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
            await tx.$executeRawUnsafe('SET LOCAL jit=off');
            // Ingestion can advance before snapshot acquisition; the result freshness check handles it.
            if ((await readAnalyticsVersions(tx, tags)).strong !== expected.strong)
              throw new RevisionChanged();
            computing = true;
            return withinQuerySnapshot(timedAnalyticsClient(tx, computeDeadline, true), load);
          },
          {
            isolationLevel: 'RepeatableRead',
            timeout: remaining(),
            maxWait: Math.min(5000, remaining()),
          },
        )
        .catch((error: unknown) => {
          throw analyticsQueryFailure(error, computeDeadline, computing);
        });
      const current = await versions(tags, true, computeDeadline, false);
      if (current.strong !== expected.strong) throw new RevisionChanged();
      // Ingestion advances independently of this immutable snapshot. Its TTL starts at completion;
      // policy, reset, repair and resource mutations remain fenced by the strong version.
      return {
        value,
        generatedAt,
        expiresAt: Date.now() + ttl,
        status: 'miss',
        tier: 'computed',
      };
    }, deadline);
  }

  cache.configureProbe(async <T>(inputKey: string, tags: string[]) => {
    const context = currentCacheContext();
    if (context?.refresh) return undefined;
    const revision = await versions(tags);
    const key = `liekan:analytics:v1:${database}:${analyticsCacheKey('result-contract-v4', [inputKey, revision.strong, context?.scope])}`;
    let result = cache.getLocal<T>(key);
    if (!result) {
      const shared = await redis.read<T>(key);
      if (shared && typeof shared !== 'string') result = shared;
    }
    if (!result || result.expiresAt <= Date.now()) return undefined;
    const current = await versions(tags, true);
    if (current.strong !== revision.strong) throw new AnalyticsRestart();
    if (context?.reauthorize && !(await runCacheAuthorization(context.reauthorize)))
      throw new AnalyticsUnavailable('资源访问权限已变更', 0, 403);
    if (!dashboardClock()) void rememberAnalyticsHot(result, revision).catch(() => {});
    return result;
  });

  cache.configure(
    async <T>(
      inputKey: string,
      ttl: number,
      tags: string[],
      load: () => Promise<T>,
      requestedRefresh: boolean,
    ) => {
      const context = currentCacheContext();
      const forced = requestedRefresh || !!context?.refresh;
      const deadline = context?.deadline || Date.now() + 65000;
      const refreshRound = context?.refreshRound || randomUUID();
      const refreshKey = analyticsCacheKey('refresh', [context?.actor || 'internal', inputKey]);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const revision = await versions(tags, attempt > 0);
          const finish = async (result: CachedResult<T>) => {
            // Each consumer, including joined requests, checks its own primary authorization.
            const current = await versions(tags, true, deadline);
            if (current.strong !== revision.strong)
              throw context?.prepared ? new AnalyticsRestart() : new RevisionChanged();
            if (
              context?.background &&
              context.reauthorize &&
              !(await runCacheAuthorization(context.reauthorize))
            )
              throw new AnalyticsUnavailable('资源访问权限已变更', 0, 403);
            if (!dashboardClock()) void rememberAnalyticsHot(result, revision).catch(() => {});
            return {
              ...result,
              value: decodeAnalyticsResult(encodeAnalyticsResult(result.value)),
            } as CachedResult<T>;
          };
          const key = `liekan:analytics:v1:${database}:${analyticsCacheKey('result-contract-v4', [inputKey, revision.strong, context?.scope])}`;
          if (!forced) {
            const local = cache.getLocal<T>(key);
            if (local) return await finish(local);
          }
          let existing = flights.get(key);
          if (
            existing &&
            forced &&
            (!existing.forced || (!context?.background && existing.background))
          ) {
            await joinFlight(
              existing.promise.catch(() => {}),
              deadline,
            );
            existing = flights.get(key);
          }
          if (existing)
            return await finish({
              ...(await joinFlight(existing.promise, deadline)),
              status: 'coalesced',
            });
          if (forced && attempt === 0 && !context?.background) {
            const previous = refreshes.get(refreshKey);
            if (previous && previous.at > Date.now() - 5000 && previous.round !== refreshRound)
              throw new AnalyticsUnavailable('刷新过于频繁，请稍后重试', 5, 429);
            refreshes.delete(refreshKey);
            refreshes.set(refreshKey, { at: Date.now(), round: refreshRound });
            while (refreshes.size > 128) refreshes.delete(refreshes.keys().next().value!);
          }
          const flight: Flight = { forced, background: !!context?.background, promise: undefined! };
          flight.promise = (async () => {
            if (!forced) {
              const shared = await redis.read<T>(key);
              if (shared && typeof shared !== 'string') {
                cache.putLocal(key, shared, tags);
                return shared;
              }
              if (shared === 'error') throw new AnalyticsUnavailable();
              if (shared === 'unshareable') return compute(tags, revision, ttl, load, deadline);
            }
            let owner = await redis.claim(key, forced, !!context?.background);
            let joiningForced =
              forced &&
              !context?.background &&
              owner === false &&
              (await redis.lockMode(key)) === 'forced';
            const waitUntil = Math.min(deadline, Date.now() + 30000);
            let waitMs = 75;
            while (owner === false) {
              if (Date.now() >= waitUntil) throw new AnalyticsUnavailable();
              await pause(Math.min(waitMs, waitUntil - Date.now()));
              waitMs = Math.min(waitMs * 2, 5000);
              if (Date.now() >= waitUntil) throw new AnalyticsUnavailable();
              if (!forced || (joiningForced && (await redis.lockMode(key)) === null)) {
                const shared = await redis.read<T>(key);
                if (shared && typeof shared !== 'string') {
                  cache.putLocal(key, shared, tags);
                  return shared;
                }
                if (shared === 'error') throw new AnalyticsUnavailable();
                if (shared === 'unshareable') return compute(tags, revision, ttl, load, deadline);
              }
              owner = await redis.claim(key, forced, !!context?.background);
              // A known active lease keeps ownership when our command budget or connection ends.
              if (owner === null) throw new AnalyticsUnavailable();
              if (
                forced &&
                !context?.background &&
                owner === false &&
                (await redis.lockMode(key)) === 'forced'
              )
                joiningForced = true;
            }
            // A previous owner may publish after our miss and before this lease succeeds.
            if (!forced && typeof owner === 'string') {
              const shared = await redis.read<T>(key);
              if (shared) {
                await redis.release(key, owner);
                if (typeof shared !== 'string') {
                  cache.putLocal(key, shared, tags);
                  return shared;
                }
                if (shared === 'error') throw new AnalyticsUnavailable();
                return compute(tags, revision, ttl, load, deadline);
              }
            }
            if (
              forced &&
              typeof owner === 'string' &&
              !context?.background &&
              (await redis.refreshSlot(refreshKey, refreshRound)) === 0
            ) {
              await redis.release(key, owner);
              throw new AnalyticsUnavailable('刷新过于频繁，请稍后重试', 5, 429);
            }
            let owns = typeof owner === 'string';
            let renewing = false;
            const renewal = owns
              ? setInterval(async () => {
                  if (renewing || !owns) return;
                  renewing = true;
                  try {
                    owns = await redis.renew(key, owner as string);
                  } finally {
                    renewing = false;
                  }
                }, 10000)
              : undefined;
            try {
              const result = await compute(tags, revision, ttl, load, deadline);
              const cacheable =
                result.expiresAt > Date.now() &&
                encodeAnalyticsResult(result.value).length <= analyticsCacheLimits.resultBytes;
              if (cacheable) cache.putLocal(key, result, tags);
              if (owns)
                await redis.publish(key, owner as string, cacheable ? result : 'unshareable');
              return result;
            } catch (error) {
              if (owns && !(error instanceof RevisionChanged))
                await redis.publish(key, owner as string, 'error');
              throw error;
            } finally {
              clearInterval(renewal);
              if (typeof owner === 'string') await redis.release(key, owner);
            }
          })().finally(() => {
            if (flights.get(key) === flight) flights.delete(key);
          });
          // Distinct overflow requests still use the global compute gate.
          if (flights.size < 128) flights.set(key, flight);
          return await finish(await flight.promise);
        } catch (error) {
          if (error instanceof RevisionChanged && context?.prepared) throw new AnalyticsRestart();
          if (error instanceof RevisionChanged && attempt === 0 && Date.now() < deadline) continue;
          if (error instanceof RevisionChanged)
            throw new AnalyticsUnavailable('统计配置已变更，请稍后重试');
          throw analyticsQueryFailure(error, deadline, false);
        }
      }
      throw new AnalyticsUnavailable();
    },
  );
}
