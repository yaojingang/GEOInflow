'use client';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import type {
  FeatureEntity,
  FeatureRange,
  FeatureRoute,
  FeatureUser,
} from '@/lib/liekan/contracts/features';
import {
  useManualRefresh,
  useManualQuery as useQuery,
} from '@/lib/liekan/contracts/manual-refresh';
import { hasDateControl, needsWebsite } from '@/lib/liekan/contracts/navigation';
import { isReportOwnedBy } from '@/lib/liekan/contracts/query';
import {
  hasClientFreshness,
  shareWithFreshness,
  useFreshnessLifecycle,
  withClientFreshness,
} from '@/lib/liekan/upstream/client-freshness';
import type { featureApi } from '@/lib/liekan/upstream/features-client';
import { useDataLoading } from '../DataLoading';

export interface WebsiteDeletedNotice {
  kind: 'website-deleted';
  name: string;
  domain?: string;
}

export interface FeatureContextValue {
  user: FeatureUser;
  route: FeatureRoute;
  api: typeof featureApi;
  sites: FeatureEntity[];
  sitesLoading?: boolean;
  sitesReady?: boolean;
  teams: FeatureEntity[];
  teamsReady?: boolean;
  siteId: string;
  site: FeatureEntity;
  range: FeatureRange;
  filters: Record<string, any>;
  query: Record<string, string>;
  href: (page: string, params?: Record<string, any>) => string;
  navigate: (page: string, params?: Record<string, any>, options?: { replace?: boolean }) => void;
  notify: (message: string, notice?: WebsiteDeletedNotice) => void;
  refresh: () => Promise<void>;
  entity?: FeatureEntity;
  setEntity?: (entity: FeatureEntity) => void;
  updateQuery?: (params: Record<string, any>) => void;
}
const Context = createContext<FeatureContextValue>(null);
export const FeatureProvider = ({
  value,
  children,
}: {
  value: FeatureContextValue;
  children: ReactNode;
}) => <Context.Provider value={value}>{children}</Context.Provider>;
export const useFeature = () => useContext(Context);
export function useResourceContext(entity?: FeatureEntity) {
  const c = useFeature();
  useEffect(() => {
    if (entity?.id) c?.setEntity?.(entity);
  }, [entity?.id, entity?.name, entity?.teamId, entity?.userId, c?.setEntity]);
}
export function useFreshQuery<T = any>(
  options: any,
  policy: {
    aggregate?: boolean | ((data: T | undefined) => boolean);
    direct?: boolean;
    endAt?: number;
    timezone?: string;
    interval?: number;
  } = {},
) {
  const aggregateFor = (data: T | undefined) =>
    typeof policy.aggregate === 'function' ? policy.aggregate(data) : policy.aggregate;
  const key = JSON.stringify(options.queryKey);
  const currentKey = useRef(key);
  currentKey.current = key;
  const force = useRef<string>(null);
  const client = useQueryClient();
  const manual = useRef<{ key: string; promise: Promise<any> }>(null);
  const result = useQuery<T, any>({
    ...options,
    queryFn: (context: any) => {
      const refresh = force.current === JSON.stringify(context.queryKey);
      if (refresh) force.current = null;
      return withClientFreshness(context.signal, () => options.queryFn(context), {
        refresh,
        queryKey: context.queryKey,
      });
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    meta: {
      ...options.meta,
      localeInvariant: true,
      cacheDirect: policy.direct || options.meta?.cacheDirect,
      cacheAggregate:
        options.meta?.cacheAggregate === false
          ? false
          : typeof policy.aggregate === 'boolean'
            ? policy.aggregate
            : options.meta?.cacheAggregate,
    },
    structuralSharing: shareWithFreshness,
  });
  const visible = useFreshnessLifecycle(result, {
    ...policy,
    aggregate: policy.direct ? false : aggregateFor(result.data),
    queryKey: options.queryKey,
    enabled: options.enabled,
  });
  return {
    ...visible,
    refetch: (settings?: any) => {
      if (options.enabled === false || typeof options.queryFn !== 'function')
        return Promise.resolve(result);
      if (manual.current?.key === key) return manual.current.promise;
      const promise = (async () => {
        await client.cancelQueries({
          queryKey: (result as any).resolvedQueryKey || options.queryKey,
          exact: true,
        });
        if (currentKey.current !== key) return result;
        force.current = key;
        return result.refetch({ ...settings, cancelRefetch: false });
      })();
      const running = { key, promise };
      manual.current = running;
      const release = () => {
        if (manual.current === running) {
          manual.current = null;
          if (force.current === key) force.current = null;
        }
      };
      void promise.then(release, release);
      return promise;
    },
  };
}
export function useData<T = any>(
  key: string | any[],
  load: (signal: AbortSignal) => Promise<T>,
  enabled = true,
  cache?: { queryKey: any[]; staleTime: number; aggregate?: boolean; direct?: boolean },
) {
  const c = useFeature();
  const loading = useDataLoading();
  const direct =
    cache?.direct ||
    ['realtime', 'session-detail', 'replay-view', 'replay-player'].includes(c?.route?.page);
  const result = useFreshQuery<T>(
    {
      queryKey: cache?.queryKey ?? [
        'liekan-feature',
        c?.user?.id,
        c?.siteId,
        c?.route?.teamId,
        c?.route?.context,
        c?.query?.scope,
        c?.route?.id,
        c?.route && hasDateControl(c.route) ? c?.range : undefined,
        c?.route && needsWebsite(c.route) ? c?.filters : undefined,
        ...(Array.isArray(key) ? key : [key]),
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) => load(signal),
      enabled: enabled && !loading,
      ...(cache?.staleTime != null ? { staleTime: cache.staleTime } : {}),
    },
    { aggregate: cache?.aggregate, direct, endAt: c?.range?.endAt, timezone: c?.range?.timezone },
  );
  return loading ? { ...result, data: undefined, isPending: true } : result;
}
export function useAction() {
  const c = useFeature();
  const client = useQueryClient();
  const reading = useManualRefresh();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scope = JSON.stringify([
    c?.user?.id,
    c?.route?.page,
    c?.site?.id || c?.siteId,
    c?.route?.id,
    c?.route?.teamId,
    c?.route?.context,
  ]);
  const current = useRef({ scope, token: reading?.page.token, alive: true });
  current.current.scope = scope;
  current.current.token = reading?.page.token;
  useEffect(() => {
    current.current.alive = true;
    return () => {
      current.current.alive = false;
    };
  }, []);
  async function run<T>(
    action: () => Promise<T>,
    message = '已保存',
    options: { navigateTo?: string; notice?: WebsiteDeletedNotice } = {},
  ): Promise<T> {
    setBusy(true);
    setError('');
    let departing = false;
    const canComplete = () =>
      current.current.alive &&
      current.current.scope === scope &&
      current.current.token === reading?.page.token;
    try {
      const result = await action();
      const websiteId = c?.siteId;
      const globalEdit =
        !websiteId || ['website-settings', 'websites', 'onboarding'].includes(c?.route?.page);
      const filters = {
        predicate: (query: { queryKey: readonly unknown[] }) => {
          const key = query.queryKey;
          if (key[0] === 'liekan')
            return isReportOwnedBy(key, c?.user?.id) && (!websiteId || key[1] === websiteId);
          if (key[0] !== 'liekan-feature' || !key.includes(c?.user?.id)) return false;
          return (
            globalEdit ||
            key.includes(websiteId) ||
            (!!c?.route?.id && key.includes(c.route.id)) ||
            key.includes('resource-analytics') ||
            key.some(value => Array.isArray(value) && value.includes(websiteId))
          );
        },
      };
      if (options.navigateTo) {
        const completing = reading ? reading.retirePage(reading.page.token) : canComplete();
        const updating = [
          client.cancelQueries({ ...filters, type: completing ? 'all' : 'inactive' }),
          client.invalidateQueries({ ...filters, refetchType: 'none' }),
          client.invalidateQueries({ queryKey: ['2fa-status'], refetchType: 'none' }),
        ];
        if (completing) {
          if (options.notice) c?.notify(message, options.notice);
          else c?.notify(message);
          c?.navigate(options.navigateTo, undefined, { replace: true });
          departing = true;
        }
        await Promise.all(updating);
        return result;
      }
      c?.notify(message);
      await client.invalidateQueries({ queryKey: ['2fa-status'] });
      await client.cancelQueries({ ...filters, type: 'inactive' });
      await client.invalidateQueries({ ...filters, refetchType: 'none' });
      const updating = reading
        ? reading.refresh(reading.page.token)
        : client.invalidateQueries(filters);
      await updating.catch(() => c?.notify(`${message}，部分数据更新失败，请重试读取`));
      return result;
    } catch (e: any) {
      setError(e?.message || '操作失败');
      throw e;
    } finally {
      if (!departing) setBusy(false);
    }
  }
  return { run, busy, error, setError };
}
