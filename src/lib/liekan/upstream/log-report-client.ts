'use client';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { useMemo } from 'react';
import { type LogCount, type LogSummary, logCountQuery } from '../contracts/log-read';
import type { LiekanReport } from '../contracts/report';
import { reportEvidenceViewPayload } from '../contracts/report-evidence-view';
import { useApi } from './client';
import { featureApi } from './features-client';

export function mergeLogReportParts(
  entries: LiekanReport,
  count?: LogCount,
  summary?: LogSummary,
  failed: { count?: boolean; summary?: boolean } = {},
): LiekanReport {
  const boundary = entries.meta.logReadBoundary;
  const exactCount = count?.readBoundary === boundary ? count : undefined;
  const matchingSummary = summary?.readBoundary === boundary ? summary : undefined;
  const report: LiekanReport = {
    ...entries,
    ...(matchingSummary
      ? {
          cards: matchingSummary.cards,
          tables: { ...entries.tables, ...matchingSummary.tables },
          states: { ...entries.states, ...matchingSummary.states },
        }
      : {}),
    meta: {
      ...entries.meta,
      ...matchingSummary?.meta,
      ...(exactCount ? { totalLogs: exactCount.total } : {}),
      logParts: {
        count: exactCount ? 'ready' : failed.count ? 'failed' : 'pending',
        summary: matchingSummary ? 'ready' : failed.summary ? 'failed' : 'pending',
      },
    },
  };
  if (!matchingSummary && failed.summary) {
    report.cards = ['日志处理能力', '今日已解析', '蜘蛛识别规则', '异常请求（今日）'].map(
      label => ({ key: label, label, value: null, state: 'unavailable' }),
    );
  }
  if (exactCount && matchingSummary?.evidence) {
    report.meta.crawlerEvidenceView = { ...matchingSummary.evidence, snapshot: '' };
    report.meta.crawlerEvidenceView.snapshot = bytesToHex(
      sha256(
        new TextEncoder().encode(
          reportEvidenceViewPayload(report, {
            filter: '全部',
            sort: { label: '', direction: 1 },
            search: '',
          }),
        ),
      ),
    );
  }
  return report;
}

/** All three reads retain React Query cancellation and the manual refresh identity. */
export function useLogReportParts<
  T extends {
    data?: LiekanReport;
    dataUpdatedAt: number;
    isPlaceholderData: boolean;
    error: unknown;
    isFetching: boolean;
  },
>(entries: T, queryKey: readonly unknown[], input: Record<string, unknown>, enabled: boolean) {
  const api = useApi();
  const boundary = entries.data?.meta.logReadBoundary;
  const active = enabled && !!boundary && !entries.isPlaceholderData && !entries.error;
  const parameters = active
    ? logCountQuery.parse({ ...input, page: 1, cursor: '', seek: 'after', readBoundary: boundary })
    : undefined;
  const common = {
    enabled: active,
    staleTime: Infinity,
    gcTime: 60000,
    refetchOnWindowFocus: false as const,
    refetchOnReconnect: false as const,
    refetchInterval: false as const,
    retry: false as const,
    meta: { cacheDirect: true, cacheAggregate: false },
    placeholderData: <P extends LogCount | LogSummary>(previous: P): P | undefined =>
      previous?.readBoundary === boundary ? previous : undefined,
  };
  const count = api.useQuery<LogCount>({
    ...common,
    queryKey: [...queryKey, { logPart: 'count', boundary, readAt: entries.dataUpdatedAt }],
    queryFn: ({ signal }) =>
      featureApi.get(`/liekan/websites/${entries.data.website.id}/log-count`, parameters, signal),
  });
  const summary = api.useQuery<LogSummary>({
    ...common,
    queryKey: [...queryKey, { logPart: 'summary', boundary, readAt: entries.dataUpdatedAt }],
    queryFn: ({ signal }) =>
      featureApi.get(
        `/liekan/websites/${entries.data.website.id}/log-summary`,
        logCountQuery.parse({ ...input, seek: input.seek || 'after', readBoundary: boundary }),
        signal,
      ),
  });
  const restricted = [count.error, summary.error].find(error =>
    [401, 403, 404].includes((error as any)?.status),
  );
  const data = useMemo(
    () =>
      enabled && boundary && entries.data
        ? mergeLogReportParts(entries.data, count.data, summary.data, {
            count: !!count.error,
            summary: !!summary.error,
          })
        : entries.data,
    [enabled, boundary, entries.data, count.data, summary.data, count.error, summary.error],
  );
  return {
    ...entries,
    data,
    error: restricted || entries.error,
    ...(restricted ? { isError: true, isSuccess: false, status: 'error' as const } : {}),
    isFetching:
      entries.isFetching ||
      (active && (count.isPending || summary.isPending || count.isFetching || summary.isFetching)),
  };
}
