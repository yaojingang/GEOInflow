import { AsyncLocalStorage } from 'node:async_hooks';
import { AnalyticsUnavailable } from './analytics-budget';
import { processSingleton } from './process-singleton';

const metadata = processSingleton('analytics-primary-metadata', () => new AsyncLocalStorage<any>());
export const primaryMetadataClient = () => metadata.getStore();
export const withinPrimaryMetadata = <T>(client: any, work: () => Promise<T>) =>
  metadata.run(client, work);

export function analyticsRemaining(deadline: number, computing = false) {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new AnalyticsUnavailable(
      '统计查询超时，请缩小时间范围后重试',
      5,
      503,
      computing ? 'analysis-query-timeout' : 'liekan-error',
    );
  return Math.ceil(remaining);
}

/** Only an entered computation that exhausts its deadline establishes a budget failure. */
export function analyticsQueryFailure(error: unknown, deadline: number, computing: boolean) {
  const detail = error as {
    code?: unknown;
    message?: unknown;
    cause?: { code?: unknown };
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  if (
    detail?.code === 'P2028' ||
    [
      detail?.code,
      detail?.cause?.code,
      detail?.meta?.code,
      detail?.meta?.driverAdapterError?.cause?.originalCode,
    ].includes('57014') ||
    /statement timeout/.test(String(detail?.message))
  )
    return new AnalyticsUnavailable(
      '统计查询超时，请缩小时间范围后重试',
      5,
      503,
      computing && Date.now() >= deadline ? 'analysis-query-timeout' : 'liekan-error',
    );
  return error;
}

/** Serialize timeout + statement as one operation, including concurrent snapshot loaders. */
const timedClients = processSingleton(
  'analytics-timed-clients',
  () =>
    new WeakMap<
      object,
      {
        state: { tx: any; tail: Promise<void>; failure?: unknown };
        deadline: number;
        computing: boolean;
      }
    >(),
);
export function timedAnalyticsClient(
  tx: any,
  deadline: number,
  computing = false,
  onFailure?: (error: unknown) => void,
) {
  const parent = timedClients.get(tx);
  const state = parent?.state || { tx, tail: Promise.resolve(), failure: undefined };
  deadline = Math.min(deadline, parent?.deadline ?? Infinity);
  computing ||= parent?.computing || false;
  tx = state.tx;
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    const next = state.tail.then(async () => {
      if (state.failure) throw state.failure;
      try {
        await tx.$executeRawUnsafe(
          `SET LOCAL statement_timeout = ${analyticsRemaining(deadline, computing)}`,
        );
        return await work();
      } catch (error) {
        onFailure?.(error);
        throw error;
      }
    });
    state.tail = next.then(
      () => {},
      error => {
        state.failure = error;
      },
    );
    return next;
  };
  const models = new Map<PropertyKey, any>();
  const client = new Proxy(tx, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === '$queryRawUnsafe' || property === '$executeRawUnsafe')
        return (...args: any[]) => run(() => value.apply(target, args));
      if (
        typeof property === 'string' &&
        !property.startsWith('$') &&
        value &&
        typeof value === 'object'
      ) {
        if (!models.has(property))
          models.set(
            property,
            new Proxy(value, {
              get(model, method) {
                const member = Reflect.get(model, method);
                return typeof member === 'function'
                  ? (...args: any[]) => run(() => member.apply(model, args))
                  : member;
              },
            }),
          );
        return models.get(property);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  timedClients.set(client, { state, deadline, computing });
  return client;
}
