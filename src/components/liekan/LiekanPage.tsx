'use client';
import { AnalysisPendingNotice } from './AnalysisPendingNotice';
import { downloadTrafficEvidence } from '@/lib/liekan/upstream/features-client';
import { reportEvidenceViewPayload } from '@/lib/liekan/contracts/report-evidence-view';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { crawlerDetailSelection } from '@/lib/liekan/rules/editor';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';

import { EXPORT_MAX_BYTES, type ExportFrame } from '@/lib/liekan/contracts/exports';
import { pageSearch, pageUrl } from '@/lib/liekan/contracts/page-url';
import { useQueryClient } from '@tanstack/react-query';
import Link from '@/components/liekan/Link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { keywordConditionsSchema } from '@/lib/liekan/contracts/keywords';
import { crawlerPageFiltersSchema, crawlerProductFormForLabel } from '@/lib/liekan/contracts/query';
import { featureDateRange } from '@/lib/liekan/contracts/analysis';
import { managementLabels } from '@/lib/liekan/contracts/management';
import {
  geoPageFromPath,
  pageNavigation,
  websiteAnalysisFamily,
} from '@/lib/liekan/contracts/navigation';
import { websiteMatchesHandle } from '@/lib/liekan/website-handle';
import {
  useApi,
  useFeatureAppState,
  useFeatureDateRange,
  useNavigation,
  useWebsite,
} from '@/lib/liekan/upstream/client';
import { useFreshnessLifecycle } from '@/lib/liekan/upstream/client-freshness';
import { useDateRangeClock } from '@/lib/liekan/upstream/date-range-clock';
import { useAccountPreferences } from '@/lib/liekan/upstream/account-preferences-client';
import {
  featureApi,
  getFeaturePreferences,
  streamFeatureExport,
} from '@/lib/liekan/upstream/features-client';
import { pageReportQuery } from '@/lib/liekan/upstream/page-report-client';
import styles from '@/styles/liekan/Shell.module.css';
import { AnalysisLoading, reportViews } from './AnalysisLoading';
import { AnalysisTabs } from './AnalysisTabs';
import { ManualRefreshControl } from './ManualRefreshControl';
import { useManualRefresh } from '@/lib/liekan/contracts/manual-refresh';
import { DataLoading, useDataLoading } from './DataLoading';
import { activeQuickDateRange, QuickRangeButtons } from './date-quick-range';
import {
  cardLabels,
  csvMatrix,
  downloadFile,
  formatMetricValue,
  pages,
  primaryTables,
  reportCsvFilename,
  stateLabels,
  tableCsv,
} from './data';
import { featureNavigationHref } from './features/routes';
import { useLiekanShell } from './LiekanShell';
import { ManagementDrawer } from './ManagementDrawer';
import { CrawlerDialog } from './features/CrawlerDialog';
import { GeoWeightPlaceholder, GeoWeightSummary } from './features/GeoWeightSummary';
import { ReportContext } from './ReportContext';
import type { LiekanReport, Resource } from './types';
import {
  clearTablePages,
  defaultDateRange,
  isLiveLogView,
  previousWeekRange,
  readViewState,
} from './viewState';

export function LiekanPage({ resource }: { resource: Resource }) {
  const i18n = useLiekanI18n();
  const metadataLoading = useDataLoading();
  const reading = useManualRefresh();
  const api = useApi();
  const userId = useFeatureAppState(state => state.user?.id);
  const forceRefresh = useRef(false);
  const queryClient = useQueryClient();
  const { websiteId, teamId, pathname, query: params, router, updateParams } = useNavigation();
  const website = useWebsite();
  const accountPreferences = useAccountPreferences();
  const timezone =
    accountPreferences?.timezone || getFeaturePreferences().timezone || 'Asia/Shanghai';
  const { dateRange, invalidDate } = useFeatureDateRange(timezone);
  const actualRange = featureDateRange(dateRange, timezone);
  const route = { page: geoPageFromPath(pathname), websiteId };
  const href = (page: string, values: Record<string, any> = {}) =>
    featureNavigationHref(route, params, page, values);
  const shell = useLiekanShell();
  const dynamicDefault = params.dateMode === 'default';
  const now = useDateRangeClock(timezone, dynamicDefault);
  const [savedNow, setLiveNow] = useState(now);
  const liveNow = reading?.page.now ?? savedNow;
  const { filter, search, logPage, cursor, seek, chartPeriod, sort, compare, tablePages } =
    readViewState(
      { ...params, date: dynamicDefault ? '0day' : params.date || getFeaturePreferences().range },
      resource,
    );
  const keywordParsed = keywordConditionsSchema.safeParse(params);
  const otherCrawlers =
    resource === 'ai/bots'
      ? filter === '其他爬虫'
      : resource === 'ai/pages' && (params.botCategory === 'other' || params.botType === '其他');
  const crawlerParsed = crawlerPageFiltersSchema.safeParse({
    botType: otherCrawlers ? undefined : params.botType || undefined,
    botCategory:
      resource === 'ai/bots'
        ? otherCrawlers
          ? 'other'
          : undefined
        : otherCrawlers
          ? 'other'
          : params.botCategory || undefined,
    botProductForm: otherCrawlers
      ? undefined
      : resource === 'ai/bots'
        ? crawlerProductFormForLabel(filter)
        : params.botProductForm || undefined,
    botId: params.botId || undefined,
    botName: params.botName || undefined,
  });
  const crawlerConditions = crawlerParsed.success ? crawlerParsed.data : {};
  const keywordConditions = keywordParsed.success
    ? keywordParsed.data
    : keywordConditionsSchema.parse({});
  const keywordPage =
    Number.isSafeInteger(Number(params.page)) &&
    Number(params.page) > 0 &&
    Number(params.page) <= 100000
      ? Number(params.page)
      : 1;
  const pageIdentity = JSON.stringify([
    userId,
    websiteId,
    teamId,
    pathname,
    resource,
    Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
  ]);
  const currentPage = useRef({ mounted: false, identity: pageIdentity });
  currentPage.current.identity = pageIdentity;
  useEffect(() => {
    currentPage.current.mounted = true;
    return () => {
      currentPage.current.mounted = false;
    };
  }, []);
  const [action, setAction] = useState('');
  const [actionError, setActionError] = useState('');
  const geographyExport = useRef<AbortController>(null);
  useEffect(() => () => geographyExport.current?.abort(), [pageIdentity]);
  const liveLogs = isLiveLogView(params, resource);
  const logEpoch = `${reading?.page.token}:${reading?.page.round}`;
  const logConditions = JSON.stringify([logPage, cursor, seek]);
  const logReset = useRef<{ epoch: string; conditions: string; active: boolean }>(null);
  if (logReset.current?.epoch !== logEpoch)
    logReset.current = {
      epoch: logEpoch,
      conditions: logConditions,
      active: (reading?.page.round || 0) > 0,
    };
  else if (logReset.current.conditions !== logConditions) logReset.current.active = false;
  const resetLogBatch = resource === 'logs' && logReset.current.active;
  const displayedLogPage = resetLogBatch ? 1 : logPage;
  const defaultRange = defaultDateRange(now, timezone);
  const startAt = liveLogs
    ? liveNow - 30 * 86400000
    : !dynamicDefault
      ? actualRange.startAt
      : defaultRange.startAt;
  const endAt = liveLogs ? liveNow : dynamicDefault ? defaultRange.endAt : actualRange.endAt;
  const page = pages.find(page => page.resource === resource);
  const shiftedRange = previousWeekRange(startAt, endAt, timezone);
  const updateView = (next: Record<string, string | number>) =>
    router.push(updateParams(next), { scroll: false });
  useEffect(() => {
    if (dynamicDefault && params.date !== `range:${defaultRange.startAt}:${defaultRange.endAt}`)
      router.replace(
        updateParams({
          date: '0day',
          dateMode: undefined,
          live: undefined,
          ...(resetLogBatch ? { page: undefined, cursor: undefined, seek: undefined } : {}),
        }),
        {
          scroll: false,
        },
      );
    else if (liveLogs && params.live !== '1')
      router.replace(
        updateParams({
          live: '1',
          ...(resetLogBatch ? { page: undefined, cursor: undefined, seek: undefined } : {}),
        }),
        { scroll: false },
      );
    else if (resetLogBatch && (params.page || params.cursor || params.seek))
      router.replace(updateParams({ page: undefined, cursor: undefined, seek: undefined }), {
        scroll: false,
      });
  }, [
    params.date,
    dynamicDefault,
    params.live,
    resource,
    liveLogs,
    router,
    updateParams,
    defaultRange.startAt,
    defaultRange.endAt,
    resetLogBatch,
    params.page,
    params.cursor,
    params.seek,
  ]);
  const reportInput = {
    resource,
    ...(resource === 'ai/pages'
      ? crawlerConditions
      : resource === 'ai/bots'
        ? {
            botProductForm: crawlerConditions.botProductForm,
            botCategory: crawlerConditions.botCategory,
          }
        : {}),
    startAt,
    endAt,
    timezone,
    chartPeriod,
    ...(resource.startsWith('ai/') || resource === 'logs'
      ? {
          crawlerIdentityScope:
            params.crawlerIdentityScope === 'verified_identity'
              ? ('verified_identity' as const)
              : params.crawlerIdentityScope === 'verified_range'
                ? ('verified_range' as const)
                : ('all' as const),
          crawlerMetricsVersion: 1 as const,
          // Crawler aggregates retain the selected boundary across page visits.
          // Log cursors still capture the current instant for their live window.
          endAt:
            resource === 'logs'
              ? Math.min(endAt % 1000 === 999 ? endAt + 1 : endAt, now)
              : endAt % 1000 === 999
                ? endAt + 1
                : endAt,
        }
      : {}),
    ...(Object.keys(tablePages).length ? { tablePages } : {}),
    ...(resource === 'human/geo'
      ? {
          search: search.slice(0, 200),
          geoSort:
            (
              {
                城市: 'city',
                会话: 'sessions',
                占比: 'share',
                平均时长: 'duration',
                跳出率: 'bounceRate',
                转化率: 'conversionRate',
                按时长: 'duration',
              } as const
            )[filter === '按时长' ? filter : sort.label] || 'sessions',
          direction:
            filter === '按时长' || sort.direction === -1 ? ('desc' as const) : ('asc' as const),
        }
      : {}),
    ...(resource === 'human/keywords'
      ? {
          ...keywordConditions,
          page: keywordPage,
          keywordSnapshot: /^[a-f0-9-]{36}$/.test(params.keywordSnapshot || '')
            ? params.keywordSnapshot
            : '',
        }
      : {}),
    ...(resource === 'logs'
      ? {
          page: displayedLogPage,
          filter:
            filter === '仅 AI 蜘蛛'
              ? 'ai'
              : filter === '仅异常'
                ? 'abnormal'
                : filter === '未知／未分类'
                  ? 'other'
                  : '',
          search: pageSearch(search, website?.domain).slice(0, 200),
          ...(!resetLogBatch && cursor ? { cursor, seek } : {}),
        }
      : {}),
  };
  const reportWebsiteId = website?.id || websiteId;
  const currentReport = pageReportQuery(userId, reportWebsiteId, reportInput, teamId, () => {
    const value = forceRefresh.current;
    forceRefresh.current = false;
    return value;
  });
  const rawQuery = api.useQuery<LiekanReport>({
    ...currentReport,
    enabled: !!websiteId && !metadataLoading,
    placeholderData: (previous, previousQuery) => {
      // logs 换批与 tp_* 翻页都会换 queryKey：queryKey[13] 是 tp_ 页码集合槽位，
      // 仅该槽位变化时保留上一份数据，翻页期间显示旧切片 + 更新提示而非整页骨架。
      const pageTurnOnly =
        !!previousQuery &&
        currentReport.queryKey.length === previousQuery.queryKey.length &&
        currentReport.queryKey.every(
          (value, index) => index === 13 || value === previousQuery.queryKey[index],
        );
      return (resource === 'logs' || pageTurnOnly) &&
        websiteMatchesHandle(previous?.website, websiteId) &&
        previousQuery?.queryKey[3] === resource &&
        previousQuery?.queryKey[14] === userId &&
        (liveLogs || (previous.range.startAt === startAt && previous.range.endAt === endAt))
        ? previous
        : undefined;
    },
    refetchInterval: false,
  });
  const query = useFreshnessLifecycle(rawQuery, {
    queryKey: currentReport.queryKey,
    enabled: !!websiteId && !metadataLoading,
    aggregate: resource !== 'logs',
    endAt,
    timezone,
  });
  const reportKey = JSON.stringify(currentReport.queryKey);
  const activeReportKey = useRef(reportKey);
  activeReportKey.current = reportKey;
  const manualRefresh = useRef<{
    key: string;
    promise: Promise<boolean | undefined>;
  }>(null);
  const rawPrevious = api.useQuery<LiekanReport>({
    ...pageReportQuery(userId, reportWebsiteId, { resource, ...shiftedRange, timezone }, teamId),
    enabled: compare && !!websiteId && !metadataLoading,
  });
  const previous = useFreshnessLifecycle(rawPrevious, {
    queryKey: pageReportQuery(
      userId,
      reportWebsiteId,
      { resource, ...shiftedRange, timezone },
      teamId,
    ).queryKey,
    enabled: compare && !!websiteId && !metadataLoading,
    aggregate: resource !== 'logs',
    endAt: shiftedRange.endAt,
    timezone,
  });
  const restricted = [401, 403, 404].includes((query.error as any)?.status);
  const previousRestricted = [401, 403, 404].includes((previous.error as any)?.status);
  const displayKey = ['liekan-feature', userId, 'website-display-settings', websiteId];
  const displayQuery = api.useQuery<{ aiCrawlerEnabled?: boolean }>({
    queryKey: displayKey,
    queryFn: ({ signal }) => featureApi.get(`/liekan/websites/${websiteId}/settings`, {}, signal),
    enabled: !!websiteId && !!userId && !metadataLoading,
    staleTime: 300000,
    retry: false,
  });
  const displayMismatch =
    !!query.data &&
    displayQuery.data?.aiCrawlerEnabled !== undefined &&
    (query.data.meta.aiCrawlerEnabled !== false) !== displayQuery.data.aiCrawlerEnabled;
  const synchronizedDisplay = useRef('');
  useEffect(() => {
    const key = `${reportWebsiteId}:${reading?.page.token || pageIdentity}:${reading?.page.round || 0}`;
    if (
      !displayMismatch ||
      restricted ||
      metadataLoading ||
      displayQuery.isFetching ||
      displayQuery.error ||
      synchronizedDisplay.current === key
    )
      return;
    synchronizedDisplay.current = key;
    forceRefresh.current = true;
    void Promise.allSettled([displayQuery.refetch(), query.refetch()]);
  }, [
    websiteId,
    query.dataUpdatedAt,
    displayQuery.data?.aiCrawlerEnabled,
    displayMismatch,
    restricted,
    metadataLoading,
    displayQuery.isFetching,
    displayQuery.error,
  ]);
  const report = restricted || metadataLoading || displayMismatch ? undefined : query.data;
  const keywordResetSeen = useRef('');
  useEffect(() => {
    if (
      resource !== 'human/keywords' ||
      !report?.meta.keywordReset ||
      keywordResetSeen.current === report.meta.keywordSnapshot
    )
      return;
    keywordResetSeen.current = report.meta.keywordSnapshot;
    router.replace(updateParams({ page: undefined, keywordSnapshot: undefined }), {
      scroll: false,
    });
  }, [resource, report?.meta.keywordSnapshot, report?.meta.keywordReset, router, updateParams]);
  const crawlerWebsite = websiteMatchesHandle(report?.website, websiteId)
    ? report.website
    : websiteMatchesHandle(website, websiteId)
      ? website
      : undefined;
  const crawlerHidden =
    displayQuery.data?.aiCrawlerEnabled === false || query.data?.meta.aiCrawlerEnabled === false;
  // GEO reads use website authority and settings, so a full aggregate report can load independently.
  const geoWeight =
    !metadataLoading &&
    !restricted &&
    !crawlerHidden &&
    userId &&
    websiteMatchesHandle(website, websiteId) &&
    ['overview', 'ai/overview'].includes(resource) ? (
      displayQuery.error ? (
        <GeoWeightPlaceholder failed onReload={() => void displayQuery.refetch()} />
      ) : displayQuery.isSuccess ? (
        <GeoWeightSummary
          userId={userId}
          websiteId={website.id}
          endAt={endAt}
          readAt={now}
          timezone={timezone}
        />
      ) : undefined
    ) : undefined;
  const refresh = () => {
    if (reading)
      return reading.refresh().then(
        () => true,
        () => false,
      );
    if (displayMismatch || displayQuery.error) void displayQuery.refetch();
    if (manualRefresh.current?.key === reportKey) return manualRefresh.current.promise;
    const promise = (async () => {
      await queryClient.cancelQueries({ queryKey: currentReport.queryKey, exact: true });
      const updatesBefore = queryClient.getQueryState(currentReport.queryKey)?.dataUpdateCount || 0;
      forceRefresh.current = true;
      const result = await query.refetch({ cancelRefetch: false });
      if (result.isError) return false;
      // Cancelled reads can resolve with retained data; completion advances the update count.
      const updatesAfter = queryClient.getQueryState(currentReport.queryKey)?.dataUpdateCount || 0;
      return updatesAfter > updatesBefore ? true : undefined;
    })();
    const running = { key: reportKey, promise };
    manualRefresh.current = running;
    const release = () => {
      if (manualRefresh.current === running) manualRefresh.current = null;
    };
    void promise.then(release, release);
    return promise;
  };
  const afterSaved = async () => {
    const isCurrentPage = () =>
      currentPage.current.mounted && currentPage.current.identity === pageIdentity;
    const invalidate = async (refetchType: 'none' | 'active') => {
      const results = await Promise.allSettled([
        queryClient.invalidateQueries(
          { queryKey: ['liekan', websiteId], refetchType },
          { throwOnError: true },
        ),
        queryClient.invalidateQueries(
          { queryKey: ['liekan-feature', userId], refetchType },
          { throwOnError: true },
        ),
      ]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    };
    if (!isCurrentPage()) {
      await invalidate('none');
      return;
    }
    await Promise.all([
      queryClient.cancelQueries({
        queryKey: (rawQuery as any).resolvedQueryKey || currentReport.queryKey,
        exact: true,
      }),
      queryClient.cancelQueries({
        queryKey:
          (rawPrevious as any).resolvedQueryKey ||
          pageReportQuery(userId, reportWebsiteId, { resource, ...shiftedRange, timezone }, teamId)
            .queryKey,
        exact: true,
      }),
    ]);
    await invalidate('none');
    if (!isCurrentPage()) {
      await invalidate('none');
      return;
    }
    if (reading) {
      await reading.refresh(reading.page.token);
    } else if (liveLogs) {
      const nextNow = Date.now();
      setLiveNow(nextNow);
      await queryClient.fetchQuery({
        ...pageReportQuery(
          userId,
          websiteId,
          { ...reportInput, startAt: nextNow - 30 * 86400000, endAt: nextNow },
          teamId,
          () => true,
        ),
        staleTime: 0,
      });
    } else {
      forceRefresh.current = true;
      await query.refetch({ throwOnError: true });
    }
  };
  const rangeLabel = useMemo(() => {
    const date = (value: number) =>
      new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        timeZone: timezone,
      }).format(value);
    return `${date(startAt)} 至 ${date(endAt)}`;
  }, [startAt, endAt, timezone]);
  useEffect(() => {
    if (!shell) return;
    if (report?.website)
      shell.setWebsite({
        ...report.website,
        robotsRange: report.range,
        teamId: website?.teamId,
        demo: report.meta.demo,
      } as any);
    else if (website)
      shell.setWebsite({
        id: website.id,
        name: website.name,
        domain: website.domain,
        siteNumber: website.siteNumber,
        robotsRange: { startAt, endAt, timezone },
        teamId: website.teamId,
      } as any);
    if (report?.tables.botBody)
      shell.setBotCount(
        report.states.logs === 'not_connected' ? null : report.tables.botBody.length,
      );
  }, [report, website, startAt, endAt, timezone, shell?.setWebsite, shell?.setBotCount]);
  useEffect(() => {
    if (websiteMatchesHandle(report?.website, websiteId) && userId)
      queryClient.setQueryData(
        ['liekan-feature', userId, 'reported-crawler-display', websiteId],
        report.meta.aiCrawlerEnabled !== false,
      );
  }, [report, userId, websiteId, queryClient]);
  useEffect(() => {
    setActionError('');
    setAction('');
  }, [resource]);
  const close = useCallback(() => {
    setAction('');
    if (compare) router.push(updateParams({ compareWeek: undefined }), { scroll: false });
  }, [compare, router, updateParams]);
  const setRange = (start: number, end: number) =>
    router.push(
      updateParams({
        ...(resource === 'human/geo' ? clearTablePages(tablePages) : {}),
        date: `range:${start}:${end}`,
        dateMode: undefined,
        live: undefined,
        page: undefined,
        cursor: undefined,
        seek: undefined,
      }),
    );
  const onFilter = (label: string) => {
    setActionError('');
    if (['30 天', '7 天', '今天', '24h'].includes(label)) {
      updateView({
        chartPeriod:
          label === '今天' ? 'today' : label === '24h' ? '24h' : label === '7 天' ? '7d' : '30d',
      });
      return;
    }
    // 筛选/排序改变行内容与顺序：清空服务端分页参数，等价回第 1 页并恢复本地全量模式。
    updateView({
      ...clearTablePages(tablePages),
      filter: label,
      page: undefined,
      cursor: undefined,
      seek: undefined,
    });
  };
  const gotoLogsPage = (page: number) => {
    const next = page > displayedLogPage;
    const cursor = next ? report?.meta.nextCursor : report?.meta.previousCursor;
    updateView({
      page,
      cursor: cursor || undefined,
      seek: cursor ? (next ? 'after' : 'before') : undefined,
    });
  };
  const exportGeography = async () => {
    if (!report || geographyExport.current) return;
    const controller = new AbortController(),
      owner = pageIdentity;
    geographyExport.current = controller;
    let file: Extract<ExportFrame, { type: 'file' }> | undefined,
      bytes = 0;
    const chunks: Uint8Array[] = [];
    setActionError('');
    try {
      await streamFeatureExport(
        report.website.id,
        {
          kind: 'geography',
          locale: i18n.locale,
          format: 'csv',
          ...report.range,
          search: reportInput.search || '',
          geoSort: reportInput.geoSort || 'sessions',
          direction: reportInput.direction || 'desc',
        },
        controller.signal,
        frame => {
          if (owner !== currentPage.current.identity || controller.signal.aborted) return;
          if (frame.type === 'file') {
            if (frame.size > EXPORT_MAX_BYTES) throw new Error('导出文件超过 50 MiB');
            file = frame;
          }
          if (frame.type === 'chunk') {
            const chunk = Uint8Array.from(atob(frame.data), char => char.charCodeAt(0));
            bytes += chunk.length;
            if (bytes > EXPORT_MAX_BYTES) throw new Error('导出文件超过 50 MiB');
            chunks.push(chunk);
          }
        },
        report.meta?.catalogVersion,
      );
      if (owner !== currentPage.current.identity || controller.signal.aborted) return;
      if (!file || file.size !== bytes) throw new Error('导出传输未完成');
      const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: file.mime }));
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (owner === currentPage.current.identity && !controller.signal.aborted)
        setActionError(error instanceof Error ? error.message : '导出失败');
    } finally {
      if (geographyExport.current === controller) geographyExport.current = null;
    }
  };
  const onAction = (label: string) => {
    setActionError('');
    if (label === '未知请求日志') {
      router.push(href('logs', { filter: '未知／未分类' }));
      return;
    }
    if (label.startsWith('导出')) {
      if (!report || query.isFetching) {
        setActionError('数据仍在读取，请稍后重试');
        return;
      }
      if (['ai/bots', 'ai/pages', 'logs'].includes(resource)) {
        void (async () => {
          try {
            const conditions = {
              reportResource: resource,
              ...(resource === 'ai/pages'
                ? crawlerConditions
                : resource === 'ai/bots'
                  ? {
                      botProductForm: crawlerConditions.botProductForm,
                      botCategory: crawlerConditions.botCategory,
                    }
                  : {}),
              reportDisplay: JSON.stringify({ filter, sort, search }),
              startAt: report.range.startAt,
              endAt: report.range.endAt,
              timezone,
              crawlerIdentityScope: reportInput.crawlerIdentityScope,
              crawlerMetricsVersion: 1,
              population:
                resource === 'logs'
                  ? 'all_logs'
                  : resource === 'ai/bots'
                    ? 'recognized_crawlers'
                    : 'ai_crawlers',
              view: resource === 'logs' ? 'requests' : 'summary',
              dimension: resource === 'ai/pages' ? 'path' : 'bot',
              search: resource === 'logs' ? reportInput.search || undefined : undefined,
              ...(resource === 'logs' && reportInput.filter
                ? { logFilter: reportInput.filter }
                : {}),
            };
            const base = `/liekan/websites/${reportWebsiteId}/crawler-analysis`;
            const view = report.meta.crawlerEvidenceView;
            if (!view) throw new Error(i18n.text('请刷新页面后导出'));
            const viewSnapshot = bytesToHex(
              sha256(
                new TextEncoder().encode(
                  reportEvidenceViewPayload(report, { filter, sort, search }),
                ),
              ),
            );
            const exported = await downloadTrafficEvidence(
              `${base}/export`,
              {
                kind: 'evidence',
                query: conditions,
                locale: i18n.locale,
                viewSnapshot,
                viewReportQuery: view.query,
                policySnapshot: view.policySnapshot,
              },
              undefined,
              report.meta.catalogVersion,
            );
            downloadFile(exported.csv, reportCsvFilename(resource, report.range));
          } catch (error: any) {
            setActionError(error.message || '导出失败');
          }
        })();
        return;
      }
      if (resource === 'human/geo') {
        void exportGeography();
        return;
      }
      const table =
        resource === 'overview' && report.meta.aiCrawlerEnabled === false
          ? 'visitorTopBody'
          : resource === 'content' && report.meta.aiCrawlerEnabled === false
            ? 'visitorPgBody'
            : primaryTables[resource];
      // 服务端分页表中客户端只持有当前切片；切片未覆盖全量时导出走既有服务端导出
      // （10 万行/50 MiB 上限），整表就在当前切片内则保留本地 CSV。
      const serverPage = table ? report.meta.tablePages?.[table] : undefined;
      if (serverPage && !(serverPage.page === 1 && serverPage.total <= serverPage.pageSize)) {
        router.push(href('exports'));
        return;
      }
      const content = table
        ? tableCsv(
            table,
            report.tables[table] || [],
            filter,
            sort,
            search,
            value => pageUrl(value, report.website.domain),
            i18n.locale,
            source => i18n.label(source, 'pageviews'),
          )
        : csvMatrix(
            ['指标', '数值', '状态'].map(i18n.system),
            report.cards
              .filter(card => cardLabels[resource]?.includes(card.label))
              .map(card => [
                i18n.system(card.label),
                formatMetricValue(card, i18n.locale, i18n.system),
                i18n.system(stateLabels[card.state] || '已接入'),
              ]),
          );
      downloadFile(content, reportCsvFilename(resource, report.range));
      return;
    }
    if (label === '生成内容建议') {
      refresh().then(succeeded => {
        if (succeeded === undefined || activeReportKey.current !== reportKey) return;
        setActionError(succeeded ? '' : '读取数据失败，请重试');
      });
      return;
    }
    if (label === '对比上周') {
      updateView({ compareWeek: '1' });
      return;
    }
    if (label === '站点设置') {
      router.push(href('website-settings'));
      return;
    }
    if (label === 'UTM 管理') {
      router.push(href('utm'));
      return;
    }
    if (label === '目标配置') {
      router.push(href('goals'));
      return;
    }
    setAction(label);
  };
  if (crawlerHidden && resource.startsWith('ai/') && !restricted && !metadataLoading)
    return (
      <div className={styles.notice}>
        <h2 className="font-bold text-ink">{i18n.text('AI 蜘蛛数据展示已关闭')}</h2>
        <p className="mt-2">{i18n.text('已有数据和采集配置会保留，可从网站设置重新开启。')}</p>
        {displayMismatch && (displayQuery.error || query.error) && (
          <div role="alert">
            <p className="mt-2">{i18n.text('展示设置读取失败，请重新同步。')}</p>
            <button onClick={refresh}>{i18n.text('重新读取设置与报表')}</button>
          </div>
        )}
        <div className="flex flex-wrap gap-4 mt-3 text-brand">
          <Link href={href('overview')}>{i18n.text('查看访客统计')}</Link>
          <Link href={href('website-settings', { section: 'basic' })}>{i18n.text('网站设置')}</Link>
        </div>
      </div>
    );
  const period =
    chartPeriod === 'today'
      ? '今天'
      : chartPeriod === '24h'
        ? '24h'
        : chartPeriod === '7d'
          ? '7 天'
          : '30 天';
  const View = reportViews[resource];
  const headerActions = (
    <div data-liekan-owned-actions className={styles.headerActions}>
      <QuickRangeButtons
        variant="chip"
        activeToken={activeQuickDateRange(params)}
        onSelect={token =>
          updateView({
            ...(resource === 'human/geo' ? clearTablePages(tablePages) : {}),
            date: token,
            unit: undefined,
            offset: undefined,
            dateMode: undefined,
            live: undefined,
            // 与 setRange 一致：换时间范围必须重置日志服务端分页，避免带着旧 page/cursor 请求。
            page: undefined,
            cursor: undefined,
            seek: undefined,
          })
        }
      />
      <button
        type="button"
        className="chip"
        onClick={() => setAction('统计范围')}
        title={i18n.text('统计时区：{v0}', [timezone])}
      >
        {i18n.system(rangeLabel)}
      </button>
      <ManualRefreshControl />
      {page.actions.map(label => (
        <button key={label} type="button" className="chip" onClick={() => onAction(label)}>
          {label === '站点设置'
            ? i18n.text('网站设置')
            : label === 'UTM 管理'
              ? i18n.text('UTM 活动')
              : i18n.system(managementLabels[label] || label)}
        </button>
      ))}
    </div>
  );
  return (
    <ReportContext.Provider
      value={{
        crawlers:
          resource === 'ai/pages'
            ? {
                conditions: crawlerConditions,
                onChange: next =>
                  updateView({
                    ...clearTablePages(tablePages),
                    botType: next.botType,
                    botProductForm: next.botProductForm,
                    botCategory: next.botCategory,
                    botId: next.botId,
                    botName: next.botName,
                    page: undefined,
                    cursor: undefined,
                    seek: undefined,
                  }),
              }
            : undefined,
        keywords:
          resource === 'human/keywords'
            ? {
                conditions: keywordConditions,
                busy: query.isFetching || !report,
                onChange: next =>
                  updateView({ ...next, page: undefined, keywordSnapshot: undefined }),
                onPage: page =>
                  updateView({
                    page: page > 1 ? page : undefined,
                    keywordSnapshot: report?.meta.keywordSnapshot,
                  }),
              }
            : undefined,
        filter,
        query: search,
        sort,
        period,
        onFilter,
        onSort: label => {
          updateView({
            ...clearTablePages(tablePages),
            filter: filter.startsWith('按') ? undefined : filter,
            sort: label,
            direction: sort.label === label && sort.direction === -1 ? 'asc' : 'desc',
          });
        },
        onAction,
        onLogsPage: gotoLogsPage,
        // 翻页只改本表页码；各表白名单独立，其他表已请求的页码保持不变。
        onTablePage: (table, page) => updateView({ [`tp_${table}`]: page > 1 ? page : undefined }),
      }}
    >
      {shell?.websiteActionsTarget && createPortal(headerActions, shell.websiteActionsTarget)}
      <div className={styles.header}>
        <div className={styles.headerInner}>
          <div>
            <h1 data-liekan-page-title className="text-[16px] font-bold tracking-tight">
              {i18n.system(
                websiteAnalysisFamily(route)?.label ||
                  pageNavigation[route.page]?.title ||
                  page.title,
              )}
            </h1>
          </div>
          {!shell?.websiteActionsTarget && headerActions}
        </div>
      </div>
      <div className={styles.tabsFrame}>
        <AnalysisTabs route={route} href={href} />
      </div>
      <div className={styles.analysisTools}>
        {report?.meta.snapshot && (
          <span>
            {i18n.text('数据截至 {v0}，后台每 30 秒检查更新', [
              new Date(report.meta.snapshot.dataThrough).toLocaleString(i18n.locale, {
                timeZone: report.range.timezone,
                hour12: false,
              }),
            ])}
            {report.meta.snapshot.updateError && (
              <span role="status"> · {i18n.text('更新失败，当前显示上次读取的数据')}</span>
            )}
          </span>
        )}
        {resource === 'logs' && (
          <span>
            {i18n.fragment('最近导入：', false, true)}
            {report?.meta.latestImportAt
              ? new Date(report.meta.latestImportAt).toLocaleString(i18n.locale, {
                  timeZone: timezone,
                })
              : query.isPending
                ? i18n.text('正在读取')
                : query.isError
                  ? i18n.text('读取失败')
                  : i18n.text('尚未导入')}
          </span>
        )}
        {resource === 'human/search-engines' ? (
          <span>{i18n.text('分别查看传统搜索与 AI 搜索引荐的平台占比和明细')}</span>
        ) : resource === 'human/keywords' ? (
          <span>{i18n.text('按搜索引擎查看关键词，支持完整筛选导出')}</span>
        ) : (
          <>
            <Link href={href('filters')}>{i18n.text('高级筛选')}</Link>
            <Link
              href={href('website-settings', { section: 'collection', panel: 'traffic-quality' })}
            >
              {i18n.text('流量质量')}
            </Link>
            <Link href={href('annotations')}>{i18n.text('图表注释')}</Link>
            <Link href={href('exports')}>{i18n.text('导出数据')}</Link>
            <Link href={href('sharing', { context: 'website' })}>{i18n.text('分享当前网站')}</Link>
          </>
        )}
        {search && (
          <button
            type="button"
            onClick={() =>
              updateView({
                ...clearTablePages(tablePages),
                search: undefined,
                page: undefined,
                cursor: undefined,
                seek: undefined,
              })
            }
          >
            {i18n.text('清除查询')}
          </button>
        )}
      </div>
      {invalidDate && (
        <div className={styles.tools} role="status">
          {i18n.fragment('日期参数无效，当前使用默认日期范围。', false, true)}
          <button
            onClick={() =>
              router.replace(
                updateParams({
                  ...(resource === 'human/geo' ? clearTablePages(tablePages) : {}),
                  date: '0day',
                  unit: undefined,
                  offset: undefined,
                  dateMode: undefined,
                  live: undefined,
                  page: undefined,
                  cursor: undefined,
                  seek: undefined,
                }),
                { scroll: false },
              )
            }
          >
            {i18n.text('重置日期')}
          </button>
        </div>
      )}
      {params.clearedFilters === '1' && (
        <div className={styles.notice}>
          {i18n.text('已清除当前页面不支持的筛选，统计采用页面显示的条件。')}
        </div>
      )}
      {(query.isError || actionError) && (
        <div className={styles.notice} role="alert">
          {query.isError
            ? report
              ? i18n.text('更新失败，当前显示上次读取的数据')
              : query.isStaleAggregate && !restricted
                ? i18n.system(query.error?.message) || i18n.text('统计数据已过期，请重试读取。')
                : !restricted && query.error?.message
                  ? i18n.system(query.error.message)
                  : i18n.text('无法读取此范围的数据')
            : i18n.system(actionError)}
          {query.isError && (
            <button type="button" onClick={() => refresh()}>
              {i18n.text('重试')}
            </button>
          )}
          {query.isError && !report && !restricted && !liveLogs && (
            <>
              <span>{i18n.text('也可缩小时间范围后重试：')}</span>
              {(
                [
                  ['0day', i18n.text('今天')],
                  ['7day', i18n.text('近 7 天')],
                  ['30day', i18n.text('近 30 天')],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  // dateMode 必须一并清除：残留 default 会让 dynamicDefault 忽略新 token 并回写 range:。
                  onClick={() =>
                    updateView({
                      ...(resource === 'human/geo' ? clearTablePages(tablePages) : {}),
                      date: value,
                      unit: undefined,
                      offset: undefined,
                      dateMode: undefined,
                      live: undefined,
                      page: undefined,
                      cursor: undefined,
                      seek: undefined,
                    })
                  }
                >
                  {i18n.system(label)}
                </button>
              ))}
            </>
          )}
        </div>
      )}
      <AnalysisPendingNotice websiteId={reportWebsiteId} websiteHandle={websiteId} />
      {displayMismatch && !restricted && (displayQuery.error || query.error) && (
        <div className={styles.notice} role="alert">
          {i18n.fragment('数据展示设置与报表暂未同步，请重试读取。', false, true)}
          <button onClick={refresh}>{i18n.text('重新读取设置与报表')}</button>
        </div>
      )}
      {query.isError && !report ? (
        geoWeight && !restricted ? (
          <main className="max-w-[1200px] mx-auto px-8 py-6">
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div
                className={
                  resource === 'overview' ? 'col-start-2 lg:col-start-4' : 'lg:col-start-3'
                }
              >
                {geoWeight}
              </div>
            </section>
          </main>
        ) : null
      ) : report || geoWeight ? (
        <DataLoading loading={!report}>
          <View
            report={report}
            geoWeight={geoWeight}
            aiCrawlerEnabled={!crawlerHidden}
            rangeLabel={i18n.system(rangeLabel)}
            live={liveLogs}
            trendLabel={
              chartPeriod === 'today'
                ? i18n.text('今天')
                : chartPeriod === '24h'
                  ? i18n.text('近 24 小时')
                  : chartPeriod === '7d'
                    ? i18n.text('近 7 天')
                    : i18n.text('近 30 天')
            }
          />
        </DataLoading>
      ) : metadataLoading || query.isPending || displayMismatch ? (
        <AnalysisLoading
          resource={resource}
          geoWeight={geoWeight}
          aiCrawlerEnabled={!crawlerHidden}
          rangeLabel={i18n.system(rangeLabel)}
          trendLabel={
            chartPeriod === 'today'
              ? i18n.text('今天')
              : chartPeriod === '24h'
                ? i18n.text('近 24 小时')
                : chartPeriod === '7d'
                  ? i18n.text('近 7 天')
                  : i18n.text('近 30 天')
          }
        />
      ) : null}
      {action === '蜘蛛归因与控制' || action.startsWith('蜘蛛详情:')
        ? crawlerWebsite && (
            <CrawlerDialog
              key={`${websiteId}:${action}`}
              websiteId={crawlerWebsite.id}
              websiteName={crawlerWebsite.name}
              websiteDomain={crawlerWebsite.domain}
              botName={crawlerDetailSelection(action).name}
              selectedIdentity={crawlerDetailSelection(action).botId}
              identityScope={
                params.crawlerIdentityScope === 'verified_identity'
                  ? 'verified_identity'
                  : params.crawlerIdentityScope === 'verified_range'
                    ? 'verified_range'
                    : 'all'
              }
              range={report?.range}
              onClose={close}
            />
          )
        : (action || compare) && (
            <ManagementDrawer
              action={compare ? '对比上周' : action}
              websiteId={crawlerWebsite?.id || websiteId}
              websiteName={report?.website?.name || website?.name}
              websiteDomain={report?.website?.domain || website?.domain}
              canManage={report?.meta.canManage || false}
              onClose={close}
              onSaved={afterSaved}
              onSearch={value =>
                updateView({
                  ...clearTablePages(tablePages),
                  search: value.slice(0, 200),
                  page: undefined,
                  cursor: undefined,
                  seek: undefined,
                })
              }
              initialSearch={search}
              onPage={gotoLogsPage}
              onLogsFilter={onFilter}
              logsFilter={filter}
              report={report}
              isFetching={query.isFetching}
              onRange={setRange}
              comparison={
                compare
                  ? {
                      current: report,
                      previous: previousRestricted || metadataLoading ? undefined : previous.data,
                      startAt,
                      endAt,
                      previousStartAt: shiftedRange.startAt,
                      previousEndAt: shiftedRange.endAt,
                      labels:
                        resource === 'overview' && report?.meta.aiCrawlerEnabled === false
                          ? ['访客数 UV', '浏览量 PV', '跳出率', '平均访问时长']
                          : i18n.system(cardLabels[resource]) || [],
                      error: previous.error,
                      fetching: previous.isFetching,
                      refetch: () => previous.refetch(),
                    }
                  : undefined
              }
            />
          )}
    </ReportContext.Provider>
  );
}
