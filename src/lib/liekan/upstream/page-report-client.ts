'use client';
import { featureDateRange } from '../contracts/analysis';
import { readFeatureDateRange } from './date-range';
import { type KeywordConditions, keywordStatusVersion } from '../contracts/keywords';
import { logReadQuery } from '../contracts/log-read';
import {
  type LiekanPageReport,
  pageReportSchema,
  type ReportResource,
} from '../contracts/page-report';
import type { CrawlerPageFilters } from '../contracts/query';
import {
  copyClientFreshness,
  freshnessStaleTime,
  hasClientFreshness,
  remainingFreshness,
  shareWithFreshness,
  withClientFreshness,
} from './client-freshness';
import { featureApi } from './features-client';
import { stableBusinessKey } from './cache-policy';
import { isReportPreparing, type ReportPreparing } from '../contracts/report-status';

/** The first fifteen fields retain the shared report cache and ownership layout. */
const reportKeyFields = {
  resource: 3,
  page: 10,
  cursor: 11,
  seek: 12,
  tablePages: 13,
  logBoundary: 16,
};

export function canReuseReportPlaceholder(
  current: readonly unknown[],
  previous: readonly unknown[],
  returnedLogBoundary: string | undefined,
  requestedLogBoundary: string | undefined,
) {
  const previousKey = stableBusinessKey(previous);
  if (current.length !== previousKey.length) return false;
  const isLog = current[reportKeyFields.resource] === 'logs';
  // Table pagination changes only its page map. Log pagination also changes its
  // page, cursor and seek, and the first request learns its boundary from the response.
  const { page, cursor, seek, tablePages, logBoundary } = reportKeyFields;
  const pages = isLog ? [page, cursor, seek, tablePages, logBoundary] : [tablePages];
  return (
    current.every((field, index) => pages.includes(index) || field === previousKey[index]) &&
    (!isLog || (!!requestedLogBoundary && requestedLogBoundary === returnedLogBoundary))
  );
}

export function pageReportQuery(
  userId: string,
  websiteId: string,
  input: Partial<KeywordConditions> &
    CrawlerPageFilters & {
      resource: ReportResource;
      startAt: number;
      endAt: number;
      timezone: string;
      crawlerIdentityScope?: 'all' | 'verified_range' | 'verified_identity';
      crawlerMetricsVersion?: 1;
      chartPeriod?: string;
      filter?: string;
      search?: string;
      page?: number;
      cursor?: string;
      readBoundary?: string;
      reportVersion?: string;
      overviewVersion?: string;
      keywordSnapshot?: string;
      seek?: string;
      tablePages?: Record<string, number>;
      geoSort?: 'city' | 'sessions' | 'share' | 'duration' | 'bounceRate' | 'conversionRate';
    },
  teamId?: string,
  fresh?: () => boolean,
  priority: 'foreground' | 'prefetch' = 'foreground',
) {
  const p = {
    chartPeriod: 'today',
    filter: '',
    search: '',
    page: 1,
    cursor: '',
    seek: '',
    ...input,
  };
  // tablePages 以扁平 tp_<table> 参数上送（reportQuery 归口解析）；
  // queryKey 记录排序后的页码集合，保证等价分页状态命中同一缓存。
  const tpParams = Object.fromEntries(
    Object.entries(p.tablePages ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, tablePage]) => [`tp_${table}`, tablePage]),
  );
  const queryKey = [
    'liekan',
    websiteId,
    teamId,
    p.resource,
    p.startAt,
    p.endAt,
    p.timezone,
    p.chartPeriod,
    p.filter,
    p.search,
    p.page,
    p.cursor,
    p.seek,
    JSON.stringify(tpParams),
    userId,
  ];
  if (p.resource === 'logs' || p.crawlerIdentityScope || p.crawlerMetricsVersion)
    queryKey.push(
      JSON.stringify([
        p.crawlerIdentityScope || 'all',
        p.crawlerMetricsVersion ?? null,
        'calendar-v2',
      ]),
    );
  if (p.resource === 'logs') queryKey.push(p.readBoundary ?? '');
  if (p.reportVersion || p.overviewVersion) queryKey.push(p.reportVersion ?? p.overviewVersion);
  if (p.resource === 'human/geo')
    queryKey.push(JSON.stringify([p.geoSort || 'sessions', p.direction || 'desc']));
  if (p.resource === 'ai/pages' || p.resource === 'ai/bots')
    queryKey.push(
      JSON.stringify([
        p.botType ?? '',
        p.botId ?? '',
        p.botName ?? '',
        p.botProductForm ?? '',
        p.botCategory ?? '',
      ]),
    );
  if (p.resource === 'human/keywords')
    queryKey.push(
      JSON.stringify([
        p.engine || '',
        p.evidence || '',
        p.status || '',
        p.sort || 'sessions',
        p.direction || 'desc',
        p.keywordSnapshot || '',
        keywordStatusVersion,
      ]),
    );
  return {
    queryKey,
    queryFn: ({
      signal,
      client,
      cacheQueryKey,
    }: {
      signal: AbortSignal;
      client?: import('@tanstack/react-query').QueryClient;
      cacheQueryKey?: readonly unknown[];
    }) =>
      withClientFreshness(
        signal,
        () =>
          featureApi.get<LiekanPageReport | ReportPreparing>(
            `/liekan/websites/${websiteId}/${p.resource === 'logs' ? 'log-entries' : 'page-report'}`,
            p.resource === 'logs'
              ? logReadQuery.parse({
                  ...p,
                  seek: p.seek || 'after',
                  ...(fresh?.() ? { refresh: '1' } : {}),
                })
              : {
                  ...p,
                  tablePages: undefined,
                  ...tpParams,
                  ...(p.resource === 'human/keywords' ? { keywordStatusVersion } : {}),
                  ...(fresh?.() ? { refresh: '1' } : {}),
                },
            signal,
            {
              priority,
              waitForResult: false,
              onPrevious: previous => {
                if (signal.aborted || !client) return;
                const parsed = pageReportSchema.safeParse(previous);
                if (parsed.success) {
                  copyClientFreshness(parsed.data, previous);
                  client.setQueryData(cacheQueryKey || queryKey, parsed.data);
                }
              },
            },
          ),
        { priority, queryKey },
      ),
    staleTime: (query: any) =>
      isReportPreparing(query.state.data)
        ? Infinity
        : p.resource === 'logs'
          ? 0
          : freshnessStaleTime(query),
    // A composite report contains a separately refreshed published Today part.
    // Revalidate that part once per visit; the manual-read boundary still owns retries.
    meta: { revalidatePublishedParts: p.resource === 'overview' },
    gcTime: 600000,
    structuralSharing: shareWithFreshness,
    refetchOnMount: (query: any) =>
      isReportPreparing(query.state.data)
        ? false
        : p.resource === 'overview' && query.state.data?.meta?.todayRequests
          ? 'always'
          : hasClientFreshness(query.state.data) &&
              remainingFreshness(query.state.data, query.state.dataUpdatedAt) <= 0
            ? 'always'
            : true,
    refetchOnWindowFocus: false as const,
    refetchOnReconnect: false as const,
    retry: false as const,
  };
}

/** Match scheduled preset range semantics, including local calendar/DST boundaries. */
export function trendReportInput(
  resource: 'overview' | 'human/overview',
  chartPeriod: 'today' | '7d' | '30d' | '24h',
  endAt: number,
  timezone: string,
) {
  const token = { today: '0day', '7d': '7day', '30d': '30day', '24h': '24hour' }[chartPeriod];
  const { dateRange } = readFeatureDateRange(token, '', 0, timezone, 'zh-CN', endAt);
  return { resource, ...featureDateRange(dateRange, timezone), chartPeriod, timezone };
}
