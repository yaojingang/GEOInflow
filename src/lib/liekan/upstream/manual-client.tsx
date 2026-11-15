'use client';
import {
  hashKey,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { getClientAuthToken } from '@/lib/client';
import { AUTH_TOKEN } from '@/lib/constants';
import { setUser, useApp } from '@/store/app';
import { useBrowserCacheClock, useBrowserCacheQuery } from './cache-client';
import { browserQueryPolicy } from './cache-policy';
import { isRealtimeRead, liveReadInterval, liveClockChanged } from './live-read-policy';
import {
  aggregateReadFailure,
  hasClientFreshness,
  remainingFreshness,
  serializeClientFreshness,
  shareWithFreshness,
  withClientFreshness,
} from './client-freshness';

export const ordinaryReadOptions = {
  retry: false,
  networkMode: 'always' as const,
  staleTime: Infinity,
  gcTime: 600000,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchInterval: false,
} as const;

const livePolls = new WeakMap<object, number>();
let nextPage = 0;
const visitReads = new Map<string, string>();
const completedReads = new Map<string, string>();
const clockAnchors = new Map<string, { now: number; deadline: number }>();
function markVisitRead(key: readonly unknown[], epoch: string) {
  if (visitReads.size > 1000) visitReads.delete(visitReads.keys().next().value);
  visitReads.set(hashKey(key), epoch);
}
async function readOnceForVisit(
  client: QueryClient,
  query: any,
  epoch: string,
  result: any,
  force: boolean,
) {
  const id = hashKey(query.queryKey);
  if (visitReads.get(id) === epoch) return;
  markVisitRead(query.queryKey, epoch);
  if (force && query.state.data?.pages?.length > 1)
    client.setQueryData(query.queryKey, {
      ...query.state.data,
      pages: query.state.data.pages.slice(0, 1),
      pageParams: query.state.data.pageParams.slice(0, 1),
    });
  await result.refetch({ cancelRefetch: false }).catch(() => {});
}
interface ReadObservation {
  status: string;
  fetchStatus: string;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
}
interface PageRead {
  scope: string;
  token: number;
  round: number;
  force: boolean;
  now: number;
  clockReady?: boolean;
  clockConditions?: string;
  queries: Map<string, { key: readonly unknown[]; observations: Map<symbol, ReadObservation> }>;
}
interface ManualReading {
  page: PageRead;
  busy: boolean;
  readAt: number;
  error: string;
  refresh: (expectedPage?: number, force?: boolean) => Promise<void>;
  retirePage: (expectedPage: number) => boolean;
  advanceClock: (expectedPage: number) => void;
  register: (key: readonly unknown[], observation: ReadObservation) => () => void;
  authorized?: boolean;
}
const ManualContext = createContext<ManualReading>(null);
const AuthorizationContext = createContext(true);
const DependencyContext = createContext(true);

function observationOf(state: any) {
  return {
    status: state?.status,
    fetchStatus: state?.fetchStatus,
    dataUpdatedAt: state?.dataUpdatedAt,
    errorUpdatedAt: state?.errorUpdatedAt,
  };
}
function observationCommitted(observation: ReadObservation, state: any) {
  return (
    observation.fetchStatus === state.fetchStatus &&
    observation.dataUpdatedAt === state.dataUpdatedAt &&
    ((observation.status === state.status && observation.errorUpdatedAt === state.errorUpdatedAt) ||
      (observation.status === 'error' && state.status === 'success'))
  );
}

/** A trusted departure followed by a cached return is a new page visit. */
export function observeHistoryReturn(target: Window, reenter: () => void) {
  let departed = false;
  const hide = (event: PageTransitionEvent) => {
    if (event.isTrusted) departed = event.persisted;
  };
  const show = (event: PageTransitionEvent) => {
    if (!event.isTrusted || !event.persisted || !departed) return;
    departed = false;
    reenter();
  };
  target.addEventListener('pagehide', hide);
  target.addEventListener('pageshow', show);
  return () => {
    target.removeEventListener('pagehide', hide);
    target.removeEventListener('pageshow', show);
  };
}

/** Resolve URL aliases using metadata already read for this website. */
export function manualPageScope(path: string, client: QueryClient) {
  return path.replace(/\/websites\/([^/?#]+)/, (match, handle) => {
    for (const query of client.getQueryCache().getAll()) {
      const key = query.queryKey;
      if (key[0] !== 'liekan-feature' || !['site', 'sites'].includes(String(key[2]))) continue;
      const value: any = query.state.data;
      const sites = Array.isArray(value)
        ? value
        : Array.isArray(value?.data)
          ? value.data
          : [value];
      const site = sites.find(site => site?.id === handle || String(site?.siteNumber) === handle);
      if (site?.id) return `/websites/${site.id}`;
    }
    return match;
  });
}

export function ManualRefreshProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const client = useQueryClient();
  const [revision, update] = useReducer(value => value + 1, 0);
  const [busy, setBusy] = useState(false);
  const [readState, setReadState] = useState({ token: 0, at: 0, error: '' });
  const principal = useRef(getClientAuthToken());
  const conditions = new URLSearchParams(search?.toString() || '');
  const account = useApp(state => state.accountPreferences);
  if (account && !pathname?.startsWith('/share')) {
    if (!conditions.has('timezone')) conditions.set('timezone', account.timezone);
    if (!conditions.has('date')) conditions.set('date', account.range);
  }
  for (const cosmetic of ['theme', 'language', 'locale']) conditions.delete(cosmetic);
  // Conversation and task acknowledgments keep the current AI workspace mounted.
  if (pathname === '/liekan/ai-chat') {
    conditions.delete('aiConversation');
    conditions.delete('aiRun');
  }
  if (conditions.get('dateMode') === 'default') {
    conditions.delete('date');
    conditions.delete('dateMode');
    conditions.delete('live');
  }
  conditions.sort();
  const resourceConditions = new URLSearchParams();
  for (const name of ['websiteId', 'teamId', 'id', 'context', 'scope']) {
    if (conditions.has(name)) resourceConditions.set(name, conditions.get(name));
  }
  resourceConditions.sort();
  const locationScope = `${pathname || ''}?${resourceConditions}`;
  const activeLocation = useRef(locationScope);
  activeLocation.current = locationScope;
  const scope = `${manualPageScope(pathname || '', client)}?${resourceConditions}`;
  const clockConditions = ['date', 'unit', 'offset', 'timezone']
    .map(name => conditions.get(name))
    .join('|');
  const cachedClock = useBrowserCacheClock(scope, clockConditions);
  const anchorKey = `${getClientAuthToken() || ''}:${scope}:${clockConditions}`;
  const lastClock = useRef(clockConditions);
  const current = useRef<PageRead>(null);
  const retiredPage = useRef<number>(null);
  const pausedScope = useRef<string>(null);
  const pending = useRef<{
    page: PageRead;
    resolve: () => void;
    reject: (error: Error) => void;
    promise: Promise<void>;
  }>(null);
  if (!current.current || manualPageScope(current.current.scope, client) !== scope) {
    if (pausedScope.current !== locationScope) pausedScope.current = null;
    pending.current?.resolve();
    pending.current = null;
    current.current = {
      scope,
      token: ++nextPage,
      round: 0,
      force: false,
      now:
        clockAnchors.get(anchorKey)?.deadline > performance.now()
          ? clockAnchors.get(anchorKey).now
          : Date.now(),
      clockReady: cachedClock.ready,
      clockConditions,
      queries: new Map(),
    };
    lastClock.current = clockConditions;
  } else if (lastClock.current !== clockConditions) {
    lastClock.current = clockConditions;
    const next = {
      ...current.current,
      now:
        cachedClock.now ??
        (clockAnchors.get(anchorKey)?.deadline > performance.now()
          ? clockAnchors.get(anchorKey).now
          : Date.now()),
      clockConditions,
      clockReady: cachedClock.ready,
    };
    if (pending.current?.page === current.current) pending.current.page = next;
    current.current = next;
  }
  if (!current.current.clockReady && cachedClock.ready) {
    current.current = {
      ...current.current,
      clockReady: true,
      now: cachedClock.now ?? current.current.now,
    };
  }
  current.current.scope = scope;
  const page = current.current;
  const register = useCallback((key: readonly unknown[], observation: ReadObservation) => {
    const owner = current.current;
    const id = hashKey(key);
    const existing = owner.queries.get(id);
    const observer = Symbol();
    const observations = existing?.observations || new Map<symbol, ReadObservation>();
    observations.set(observer, observation);
    owner.queries.set(id, { key, observations });
    update();
    return () => {
      const registered = owner.queries.get(id);
      if (!registered) return;
      registered.observations.delete(observer);
      if (!registered.observations.size) owner.queries.delete(id);
    };
  }, []);
  const refresh = useCallback(
    (expectedPage?: number, force = true) => {
      if (retiredPage.current === current.current?.token) return Promise.resolve();
      if (expectedPage !== undefined && expectedPage !== current.current?.token)
        return Promise.resolve();
      if (force && pending.current?.page === current.current && pending.current.page.force)
        return pending.current.promise;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setReadState(state => ({
          token: current.current.token,
          at: state.token === current.current.token ? state.at : 0,
          error: '网络连接已断开，请恢复连接后主动重试。',
        }));
        return Promise.reject(new Error('网络连接已断开'));
      }
      const previous = current.current;
      pausedScope.current = null;
      pending.current?.resolve();
      for (const { key } of previous.queries.values())
        void client.cancelQueries({ queryKey: key, exact: true });
      const next = {
        ...previous,
        round: previous.round + 1,
        force,
        now: Date.now(),
        clockReady: true,
        queries: new Map(),
      };
      current.current = next;
      let resolve: () => void;
      let reject: (error: Error) => void;
      const promise = new Promise<void>((success, failure) => {
        resolve = success;
        reject = failure;
      });
      pending.current = { page: next, resolve, reject, promise };
      setBusy(true);
      setReadState(state => ({
        token: next.token,
        at: state.token === next.token ? state.at : 0,
        error: '',
      }));
      update();
      return promise;
    },
    [client],
  );

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const active = current.current;
        if (active !== page) return;
        const entries = [...active.queries.values()];
        const states = entries.map(({ key }) => client.getQueryState(key));
        if (
          entries.some(
            ({ key }) =>
              client.getQueryCache().find({ queryKey: key, exact: true })?.meta?.cachePending,
          )
        )
          return;
        if (states.some(state => !state || state.fetchStatus !== 'idle')) return;
        if (
          entries.some((entry, index) =>
            [...entry.observations.values()].some(
              snapshot => !observationCommitted(snapshot, states[index]),
            ),
          )
        )
          return;
        const job = pending.current;
        const failures = states.filter(
          (state, index) =>
            state?.status === 'error' ||
            aggregateReadFailure(state?.data) ||
            [...entries[index].observations.values()].some(snapshot => snapshot.status === 'error'),
        );
        const latest = Math.max(0, ...states.map(state => state?.dataUpdatedAt || 0));
        const ordinary = states.filter((state, index) => {
          const key = entries[index].key;
          const metadata = client.getQueryCache().find({ queryKey: key, exact: true })?.meta;
          return (
            !metadata?.geoSnapshot &&
            (metadata?.cacheAggregate === true ||
              serializeClientFreshness(state?.data) ||
              browserQueryPolicy(key, metadata) ||
              (key[0] === 'liekan' && key.length >= 15 && key[3] !== 'logs'))
          );
        });
        const fresh = ordinary.filter(
          state =>
            hasClientFreshness(state?.data) &&
            !aggregateReadFailure(state?.data) &&
            state.status !== 'error',
        );
        const remaining = Math.min(
          ...fresh.map(state => remainingFreshness(state.data, state.dataUpdatedAt)),
        );
        if (
          fresh.length &&
          remaining > 0 &&
          !ordinary.some(state => state.status === 'error' || aggregateReadFailure(state.data))
        ) {
          if (clockAnchors.size > 200) clockAnchors.delete(clockAnchors.keys().next().value);
          clockAnchors.set(anchorKey, { now: active.now, deadline: performance.now() + remaining });
        }
        if (latest && !failures.length)
          setReadState(state =>
            state.token === active.token && state.at === latest && !state.error
              ? state
              : { token: active.token, at: latest, error: '' },
          );
        if (failures.length) {
          const error = '部分数据读取失败，仍显示上次读取结果，请主动重试。';
          setReadState(state =>
            state.token === active.token && state.error === error
              ? state
              : { token: active.token, at: state.token === active.token ? state.at : 0, error },
          );
        }
        if (job?.page === active) {
          pending.current = null;
          setBusy(false);
          if (failures.length) {
            job.reject(new Error('部分数据读取失败'));
          } else job.resolve();
        } else if (!job) {
          setBusy(false);
        }
      }, 25);
    };
    const unsubscribe = client.getQueryCache().subscribe(settle);
    settle();
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [client, revision, page]);

  useEffect(() => {
    const credentialsChanged = (external = false) => {
      const token = getClientAuthToken();
      if (token === principal.current) return;
      principal.current = token;
      pausedScope.current = external ? activeLocation.current : null;
      void client.cancelQueries({ predicate: query => query.meta?.readPurpose === 'ordinary' });
      client.removeQueries({ predicate: query => query.meta?.readPurpose === 'ordinary' });
      pending.current?.resolve();
      pending.current = null;
      current.current = null;
      setBusy(false);
      setUser(null);
      update();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === AUTH_TOKEN || event.key === null) credentialsChanged(true);
    };
    const localCredentialsChanged = () => credentialsChanged();
    window.addEventListener('storage', storage);
    window.addEventListener('liekan-credentials-change', localCredentialsChanged);
    return () => {
      window.removeEventListener('storage', storage);
      window.removeEventListener('liekan-credentials-change', localCredentialsChanged);
    };
  }, [client]);
  useEffect(
    () =>
      observeHistoryReturn(window, () => {
        pausedScope.current = null;
        for (const { key } of current.current?.queries.values() || [])
          void client.cancelQueries({ queryKey: key, exact: true });
        pending.current?.resolve();
        pending.current = null;
        current.current = null;
        setBusy(false);
        update();
      }),
    [client],
  );
  const retirePage = useCallback((expectedPage: number) => {
    if (expectedPage !== current.current?.token || retiredPage.current === expectedPage)
      return false;
    retiredPage.current = expectedPage;
    pending.current?.resolve();
    pending.current = null;
    setBusy(false);
    update();
    return true;
  }, []);
  const authorized = pausedScope.current !== locationScope && retiredPage.current !== page.token;
  const advanceClock = useCallback((expectedPage: number) => {
    const active = current.current;
    if (
      !active ||
      active.token !== expectedPage ||
      pending.current ||
      Date.now() - active.now < 1000
    )
      return;
    current.current = { ...active, now: Date.now(), clockReady: true };
    update();
  }, []);
  const value = useMemo(
    () => ({
      page,
      authorized,
      busy: busy && pending.current?.page === page,
      readAt: readState.token === page.token ? readState.at : 0,
      error: readState.token === page.token ? readState.error : '',
      refresh,
      retirePage,
      advanceClock,
      register,
    }),
    [page, authorized, busy, readState, refresh, retirePage, advanceClock, register],
  );
  return <ManualContext.Provider value={value}>{children}</ManualContext.Provider>;
}

export function useManualRefresh() {
  return useContext(ManualContext);
}
export function ManualAuthorizationBoundary({
  authorized,
  children,
}: {
  authorized: boolean;
  children: ReactNode;
}) {
  const parent = useContext(AuthorizationContext);
  return (
    <AuthorizationContext.Provider value={authorized && parent}>
      {children}
    </AuthorizationContext.Provider>
  );
}

/** Retained metadata stays visible while its dependent reads wait for this generation. */
export function ManualReadDependencyBoundary({
  ready,
  children,
}: {
  ready: boolean;
  children: ReactNode;
}) {
  const parent = useContext(DependencyContext);
  return (
    <DependencyContext.Provider value={ready && parent}>{children}</DependencyContext.Provider>
  );
}

/** Each page visit and explicit refresh owns one stable query generation. */
export function useManualQueryOptions(options: any) {
  const reading = useManualRefresh();
  const authorized = useContext(AuthorizationContext);
  const dependenciesReady = useContext(DependencyContext);
  const selection = useRef<{ epoch: string; key: string; ready: boolean; normal: boolean }>(null);
  const epoch = `${reading?.page.token}:${reading?.page.round}`;
  const selectionKey = hashKey(options.queryKey);
  const ready =
    authorized &&
    dependenciesReady &&
    reading?.authorized !== false &&
    reading?.page.clockReady !== false &&
    options.enabled !== false;
  const previous = selection.current;
  const normalSelection =
    previous?.epoch === epoch &&
    (previous.key === selectionKey ? previous.normal : previous.normal || previous.ready === ready);
  selection.current = { epoch, key: selectionKey, ready, normal: normalSelection };
  const ordinary =
    options.meta?.readPurpose !== 'authorization' && typeof options.queryFn === 'function';
  const cached = useBrowserCacheQuery(options, epoch, ready && ordinary);
  const key = ordinary ? cached.key : options.queryKey;
  if (!ordinary) return options;
  const canRead = (query: any) =>
    authorized &&
    cached.ready &&
    reading?.page.clockReady !== false &&
    reading?.authorized !== false &&
    dependenciesReady &&
    (typeof options.enabled === 'function'
      ? options.enabled(query) !== false
      : options.enabled !== false);
  return {
    ...options,
    ...ordinaryReadOptions,
    refetchOnMount: (query: any) =>
      reading && visitReads.get(hashKey(key)) === epoch
        ? false
        : (options.meta?.revalidatePublishedParts &&
              (typeof options.refetchOnMount === 'function'
                ? options.refetchOnMount(query)
                : options.refetchOnMount) === 'always') ||
            !hasClientFreshness(query.state.data) ||
            remainingFreshness(query.state.data, query.state.dataUpdatedAt) <= 0
          ? ('always' as const)
          : false,
    queryKey: key,
    // A failed attempt waits for an explicit read, including after authorization resumes.
    enabled: (query: any) => canRead(query) && query.state.status !== 'error',
    canRead,
    meta: {
      ...cached.meta,
      readPurpose: 'ordinary',
      manualAuthorized: authorized && reading?.authorized !== false,
      manualPage: reading?.page.token,
      manualRound: reading?.page.round,
      manualEpoch: epoch,
      manualForce: reading?.page.force && !normalSelection,
      manualClock: reading
        ? {
            scope: reading.page.scope,
            conditions: reading.page.clockConditions,
            now: reading.page.now,
          }
        : undefined,
    },
    structuralSharing:
      options.structuralSharing === false
        ? false
        : typeof options.structuralSharing === 'function'
          ? options.structuralSharing
          : shareWithFreshness,
    queryFn:
      typeof options.queryFn === 'function'
        ? async (context: any) => {
            if (typeof navigator !== 'undefined' && navigator.onLine === false)
              throw Object.assign(new Error('网络连接已断开，请恢复连接后主动重试。'), {
                offline: true,
              });
            cached.assertCurrent();
            markVisitRead(key, epoch);
            const value = await withClientFreshness(
              context.signal,
              () =>
                options.queryFn({
                  ...context,
                  cacheQueryKey: context.queryKey,
                  queryKey: options.queryKey,
                }),
              {
                refresh: !!reading?.busy && reading.page.force && !normalSelection,
                queryKey: key,
                catalogScope: reading ? `${reading.page.token}:${reading.page.round}` : undefined,
              },
            );
            context.signal.throwIfAborted();
            cached.assertCurrent();
            if (completedReads.size > 1000)
              completedReads.delete(completedReads.keys().next().value);
            completedReads.set(hashKey(key), epoch);
            return value;
          }
        : options.queryFn,
  };
}
function ownerScope(key: readonly any[], options: any) {
  if (isRealtimeRead(key))
    return hashKey(
      key.map(value =>
        typeof value === 'number'
          ? undefined
          : value &&
              typeof value === 'object' &&
              Number.isFinite(value.startAt) &&
              Number.isFinite(value.endAt)
            ? { ...value, startAt: undefined, endAt: undefined }
            : value,
      ),
    );
  const clock = options?.meta?.manualClock;
  const relative = clock && !String(clock.conditions || '').split('|')[0];
  if (!relative) return hashKey(key);
  return hashKey(
    key.map((value, index) =>
      key[0] === 'liekan' && key.length >= 15 && [4, 5].includes(index)
        ? undefined
        : value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Number.isFinite(value.startAt) &&
            Number.isFinite(value.endAt)
          ? { ...value, startAt: undefined, endAt: undefined }
          : value,
    ),
  );
}
export function useRetainedRead(
  result: any,
  key: readonly unknown[],
  options?: any,
  queryClient?: QueryClient,
) {
  const reading = useManualRefresh();
  const client = useQueryClient(queryClient);
  const query = client.getQueryCache?.().find?.({ queryKey: key, exact: true });
  const readable = options?.canRead ? options.canRead(query) : result.isEnabled !== false;
  const id = hashKey(key);
  const registered =
    !!reading &&
    options?.meta?.manualPage === reading.page.token &&
    (readable || !!options?.meta?.cachePending);
  const observation = observationOf(result);
  const publicProjection =
    /^(?:liekan-public|liekan-shared)/.test(String(key[0])) ||
    options?.meta?.cacheAggregate === false;
  useEffect(() => {
    if (registered) return reading.register(key, observation);
  }, [
    id,
    registered,
    observation.status,
    observation.fetchStatus,
    observation.dataUpdatedAt,
    observation.errorUpdatedAt,
    reading?.register,
  ]);
  const previousSelection = useRef<{ epoch: string; id: string; ready: boolean }>(null);
  const epoch = `${reading?.page.token}:${reading?.page.round}`;
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = { epoch, id, ready: registered };
    if (
      registered &&
      readable &&
      (previous?.epoch !== epoch || previous.id !== id || previous.ready === false) &&
      query &&
      (query.isFetched() || query.state.status === 'pending') &&
      query.state.fetchStatus === 'idle' &&
      (publicProjection ||
        reading?.page.force ||
        query.state.isInvalidated ||
        !hasClientFreshness(query.state.data) ||
        remainingFreshness(query.state.data, query.state.dataUpdatedAt) <= 0)
    ) {
      if (previous?.epoch === epoch && previous.id !== id) visitReads.delete(hashKey(key));
      void readOnceForVisit(client, query, epoch, result, !!reading?.page.force);
    }
  }, [id, epoch, registered, readable]);
  const owner = ownerScope(key, options);
  const previous = useRef<{ owner: string; id: string; epoch: string; data: any }>(null);
  const partialFailure = aggregateReadFailure(result.data);
  if (result.data !== undefined && !result.isPlaceholderData && !partialFailure)
    previous.current = { owner, id, epoch, data: result.data };
  const restricted = [401, 403, 404, 409, 410].includes(result.error?.status);
  const principalPaused =
    options?.meta?.readPurpose === 'ordinary' &&
    (reading?.authorized === false || options.meta.manualAuthorized === false);
  const relativeClock =
    options?.meta?.manualClock &&
    !String(options.meta.manualClock.conditions || '')
      .split('|')[0]
      .startsWith('range:');
  const liveInterval =
    reading && readable && !restricted && !principalPaused
      ? liveReadInterval(key, relativeClock ? options.meta.manualClock.now : Date.now())
      : false;
  const liveRead = useRef({ result, reading, options });
  liveRead.current = { result, reading, options };
  useEffect(() => {
    if (!liveInterval) return;
    const poll = () => {
      const active = client.getQueryCache().find({ queryKey: key, exact: true });
      if (
        !active ||
        active.state.fetchStatus !== 'idle' ||
        document.visibilityState === 'hidden' ||
        navigator.onLine === false ||
        liveRead.current.reading?.authorized === false ||
        [401, 403, 404, 409, 410].includes((active.state.error as any)?.status)
      )
        return;
      const now = performance.now();
      if (now - (livePolls.get(active) ?? -Infinity) < liveInterval) return;
      livePolls.set(active, now);
      if (liveClockChanged(key, liveRead.current.options?.meta?.manualClock)) {
        liveRead.current.reading?.advanceClock(liveRead.current.reading.page.token);
        return;
      }
      void liveRead.current.result.refetch({ cancelRefetch: false }).catch(() => {});
    };
    const timer = setInterval(poll, liveInterval);
    document.addEventListener('visibilitychange', poll);
    window.addEventListener('online', poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
      window.removeEventListener('online', poll);
    };
  }, [client, id, liveInterval]);
  const invalidatedDefinition = useRef<string>(null);
  const definitionSelection = useRef<{ id: string; epoch: string }>(null);
  if (definitionSelection.current?.id !== id || definitionSelection.current?.epoch !== epoch) {
    definitionSelection.current = { id, epoch };
    invalidatedDefinition.current =
      query?.state.isInvalidated &&
      query.state.status !== 'error' &&
      !hasClientFreshness(result.data) &&
      !reading?.busy
        ? id
        : null;
  }
  if (!query?.state.isInvalidated) invalidatedDefinition.current = null;
  const invalidatedConfiguration = invalidatedDefinition.current === id && !reading?.busy;
  if (restricted || principalPaused || invalidatedConfiguration) previous.current = null;
  const retained =
    previous.current?.owner === owner &&
    (previous.current.id === id || previous.current.epoch !== epoch)
      ? previous.current.data
      : undefined;
  if (retained !== undefined && previous.current.epoch !== epoch)
    previous.current = { ...previous.current, id, epoch };
  const data =
    partialFailure && Array.isArray(result.data) && Array.isArray(retained)
      ? result.data.map(row => {
          const old = retained.find(previous => previous.id === row.id);
          return row.error &&
            ![401, 403, 404, 409, 410].includes(row.error.status) &&
            old &&
            !old.error
            ? old
            : row;
        })
      : (result.data ?? retained);
  if (partialFailure && data !== undefined) previous.current = { owner, id, epoch, data };
  return {
    ...result,
    ...(partialFailure
      ? { error: partialFailure, isError: true, isSuccess: false, status: 'error' }
      : {}),
    data: restricted || principalPaused || invalidatedConfiguration ? undefined : data,
    ...(result.data === undefined && !restricted && retained !== undefined
      ? {
          isPending: false,
          isLoading: false,
          isPlaceholderData: !result.error,
          ...(!result.error ? { status: 'success', isSuccess: true } : {}),
        }
      : {}),
    resolvedQueryKey: key,
    ...(reading?.busy && completedReads.get(id) !== epoch && data !== undefined
      ? { isPlaceholderData: true }
      : {}),
    isStaleAggregate:
      hasClientFreshness(data) && remainingFreshness(data, result.dataUpdatedAt) <= 0,
    manualCanRead: readable,
    refetch: (settings?: any) => (readable ? result.refetch(settings) : Promise.resolve(result)),
  };
}
export const useManualQuery: typeof useQuery = ((options: any, client?: any) => {
  const input = useManualQueryOptions(options);
  return useRetainedRead(useQuery(input, client), input.queryKey, input, client);
}) as typeof useQuery;
export const useManualInfiniteQuery: typeof useInfiniteQuery = ((options: any, client?: any) => {
  const input = useManualQueryOptions(options);
  return useRetainedRead(useInfiniteQuery(input, client), input.queryKey, input, client);
}) as typeof useInfiniteQuery;

/** A known task can be followed within one bounded foreground visit. */
export function useTaskPolling(
  key: string,
  enabled: boolean,
  read: (signal: AbortSignal) => Promise<unknown>,
  interval: number,
) {
  const [round, resume] = useReducer(value => value + 1, 0);
  const [expired, setExpired] = useState(false);
  const work = useRef(read);
  work.current = read;
  useEffect(() => {
    setExpired(false);
    if (!enabled) return;
    const deadline = Date.now() + 300000;
    const abort = new AbortController();
    let busy = false;
    let alive = true;
    const poll = () => {
      if (Date.now() >= deadline) {
        setExpired(true);
        return;
      }
      if (!alive || busy || document.visibilityState === 'hidden' || navigator.onLine === false)
        return;
      busy = true;
      void work
        .current(abort.signal)
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    };
    const timer = setInterval(poll, interval);
    const expiry = setTimeout(() => {
      clearInterval(timer);
      abort.abort();
      setExpired(true);
    }, 300000);
    window.addEventListener('online', poll);
    document.addEventListener('visibilitychange', poll);
    return () => {
      alive = false;
      abort.abort();
      clearInterval(timer);
      clearTimeout(expiry);
      window.removeEventListener('online', poll);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [key, enabled, interval, round]);
  return { expired, resume };
}
