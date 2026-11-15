'use client';
import { useEffect, useState } from 'react';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import { isReportPreparing, type ReportPreparing } from '@/lib/liekan/contracts/report-status';
import { useApi } from '@/lib/liekan/upstream/client';
import { pageReportQuery, trendReportInput } from '@/lib/liekan/upstream/page-report-client';
import { DataLoading, useDataLoading } from './DataLoading';
import { FilterChip, ReferenceChart } from './ReportComponents';
import { ReportContext, useReportActions } from './ReportContext';
import { fallbackReportRangeLabel, ReportSnapshotNotice } from './ReportSnapshotNotice';
import type { LiekanReport, ReportViewProps } from './types';

type Props = ReportViewProps & {
  title: string;
  suffix: string;
  id: string;
  height: number;
  wrap?: boolean;
};

/** Static previews and loading layouts do not acquire a query observer. */
export function ReportTrend(props: Props) {
  return props.trend ? (
    <PublishedReportTrend {...props} />
  ) : (
    <TrendView {...props} label={props.trendLabel || props.rangeLabel} visible={props.report} />
  );
}

/** The chart reads an existing canonical report independently of cards and rankings. */
function PublishedReportTrend(props: Props) {
  const { report, rangeLabel, trendLabel, trend } = props;
  const i18n = useLiekanI18n();
  const actions = useReportActions();
  const inheritedLoading = useDataLoading();
  const api = useApi();
  const [selection, setSelection] = useState(trend?.initialPeriod ?? trend?.basePeriod);
  const separate = !!trend && !!selection && selection !== trend.basePeriod;
  const input = trendReportInput(
    trend?.resource ?? 'overview',
    selection ?? 'today',
    trend?.endAt ?? 0,
    trend?.timezone ?? 'UTC',
  );
  const query = api.useQuery<LiekanReport | ReportPreparing>({
    ...pageReportQuery(trend?.userId, trend?.websiteId, input, trend?.teamId),
    enabled: separate && !inheritedLoading,
    refetchInterval: false,
  });
  const invalidated = separate && [401, 403, 404, 409, 410].includes((query.error as any)?.status);
  const invalidate = trend?.onInvalidated;
  useEffect(() => {
    if (invalidated) invalidate?.(query.error);
  }, [invalidated, query.error, invalidate]);
  const preparing = separate && !query.error && isReportPreparing(query.data);
  // Only server-validated fallback results can survive a completed read. In particular,
  // a 202 or a control/permission error must not resurrect an invalid cached chart.
  const displayed = !separate
    ? report
    : invalidated || preparing
      ? undefined
      : (query.data as LiekanReport | undefined);
  const pending = separate && query.isPending && !query.error;
  const visible = displayed ?? (pending ? report : undefined);
  const fallbackLabel = fallbackReportRangeLabel(visible, i18n.locale);
  const label = fallbackLabel
    ? i18n.text('上次统计：{v0}', [fallbackLabel])
    : separate && (displayed || !visible)
      ? i18n.text(
          selection === 'today'
            ? '今天'
            : selection === '24h'
              ? '近 24 小时'
              : selection === '7d'
                ? '近 7 天'
                : '近 30 天',
        )
      : trendLabel || rangeLabel;
  const period =
    selection === 'today'
      ? '今天'
      : selection === '24h'
        ? '24h'
        : selection === '7d'
          ? '7 天'
          : selection === '30d'
            ? '30 天'
            : actions.period;
  return (
    <TrendView
      {...props}
      label={label}
      period={period}
      visible={visible}
      displayed={separate ? displayed : undefined}
      preparing={preparing}
      pending={pending}
      error={separate ? query.error : undefined}
      retry={() => void query.refetch()}
      onSelect={label => setSelection(label === '今天' ? 'today' : label === '7 天' ? '7d' : '30d')}
    />
  );
}

function TrendView({
  title,
  suffix,
  id,
  height,
  wrap = false,
  label,
  period,
  visible,
  displayed,
  preparing = false,
  pending = false,
  error,
  retry,
  onSelect,
}: Props & {
  label: string;
  period?: string;
  visible?: LiekanReport;
  displayed?: LiekanReport;
  preparing?: boolean;
  pending?: boolean;
  error?: unknown;
  retry?: () => void;
  onSelect?: (label: string) => void;
}) {
  const i18n = useLiekanI18n();
  const actions = useReportActions();
  const inheritedLoading = useDataLoading();
  return (
    <section className="card fade-in d2" data-report-trend>
      <div
        className={`px-6 pt-5 pb-2 flex ${wrap ? 'flex-wrap gap-3 ' : ''}items-center justify-between`}
      >
        <div>
          <h2 className="text-[14px] font-bold tracking-tight">{i18n.text(title)}</h2>
          <p className="text-[11.5px] text-faint mt-0.5">
            {label}
            {i18n.fragment(suffix, true, false)}
          </p>
        </div>
        <ReportContext.Provider
          value={{
            ...actions,
            period: period ?? actions.period,
            onFilter: onSelect ?? actions.onFilter,
          }}
        >
          <div className="flex items-center gap-2">
            <FilterChip label="30 天" />
            <FilterChip label="7 天" />
            <FilterChip label="今天" />
          </div>
        </ReportContext.Provider>
      </div>
      {displayed?.meta.snapshot && (
        <div className="px-6 text-[11.5px] text-faint">
          <ReportSnapshotNotice report={displayed} />
        </div>
      )}
      {error && visible && (
        <div className="px-6 text-[12px] text-faint" role="status">
          {i18n.text('更新失败，当前显示上次读取的数据')}{' '}
          <button type="button" className="text-brand" onClick={retry}>
            {i18n.text('重试')}
          </button>
        </div>
      )}
      {preparing || (error && !visible) ? (
        <div className="px-6 py-6 text-[12px] text-faint" role={error ? 'alert' : 'status'}>
          {i18n.text(error ? '无法读取此范围的数据' : '数据准备中，请稍后查看')}{' '}
          <button type="button" className="text-brand" onClick={retry}>
            {i18n.text(error ? '重试' : '重新查看')}
          </button>
        </div>
      ) : (
        <DataLoading loading={inheritedLoading || (pending && !visible)}>
          {pending && visible && (
            <span role="status" className="px-6 text-[11.5px] text-faint">
              {i18n.text('正在读取统计数据')}
            </span>
          )}
          <ReferenceChart id={id} height={height} report={visible} />
        </DataLoading>
      )}
    </section>
  );
}
