'use client';
import { verificationReasonLabel } from '@/lib/liekan/rules/verification-labels';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';

import { geographyEmptyText } from '@/lib/liekan/contracts/geography';
import { useEffect, useRef, useState } from 'react';
import styles from '@/styles/liekan/Shell.module.css';
import {
  countryName,
  geographyLabel,
  regionName,
  type GeographyDisplay,
} from '@/lib/liekan/contracts/geography';
import { chartOptions } from './chartOptions';
import { loadEcharts } from './chartRuntime';
import { ChartLoading, LoadingLines, Skeleton, useDataLoading } from './DataLoading';
import {
  columns,
  crawlerIdentityLabel,
  formatCellValue,
  formatMetricValue,
  formatPercentage,
  formatValue,
  selectRows,
  stateLabels,
  tableLimits,
} from './data';
import { Button } from './features/ui';
import { observeChartLayout } from './mobileChart';
import { useReportActions } from './ReportContext';
import { pageLink, pageSequence } from './PageLink';
import { pageUrl } from '@/lib/liekan/contracts/page-url';
import type { DataState, LiekanReport, Row } from './types';

function reportState(report: LiekanReport, table?: string): DataState {
  if (!report) return 'not_connected';
  if (table === 'goalBody') return report.states.goals;
  if (
    table === 'visitorTopBody' ||
    table === 'visitorPgBody' ||
    table === 'cityBody' ||
    table === 'srcBody' ||
    table === 'searchEngineBody' ||
    table === 'pgBody'
  )
    return report.states.human;
  return report.states.logs;
}
export function MetricCard({
  label,
  displayLabel = label,
  className,
  valueClass,
  report,
}: {
  label: string;
  displayLabel?: string;
  className: string;
  valueClass: string;
  report?: LiekanReport;
}) {
  const i18n = useLiekanI18n();
  const loading = useDataLoading();
  const card = report?.cards.find(card => card.label === label);
  const place = report?.meta?.geography?.cards?.[label];
  const display =
    place && i18n.locale === 'en-US'
      ? label === '海外 TOP1'
        ? countryName(place.country, i18n.locale)
        : geographyLabel(place, i18n.locale)
      : formatMetricValue(card || { value: null, label }, i18n.locale, i18n.system);
  const pageMetric = ['入口页 TOP1', '退出页 TOP1'].includes(label);
  return (
    <div className={className} aria-busy={loading || undefined}>
      <p data-liekan-metric-label className="text-[11.5px] text-sub">
        {i18n.system(displayLabel)}
      </p>
      <p className={`${valueClass} ${styles.metricValue} ${pageMetric ? styles.pageMetric : ''}`}>
        {loading ? (
          <Skeleton width="3.5em" />
        ) : pageMetric ? (
          pageLink(card?.value, report?.website.domain, display, undefined, i18n.locale)
        ) : (
          display
        )}
      </p>
      <p className="text-[10.5px] text-faint mt-1">
        {loading ? (
          <Skeleton width="75%" />
        ) : (
          <>
            {i18n.system(card?.detail || stateLabels[card?.state || 'not_connected']) ||
              i18n.text('当前统计范围')}
            {card?.state === 'estimated' && card.detail ? i18n.text(' · 估算') : ''}
          </>
        )}
      </p>
    </div>
  );
}
export function ReferenceChart({
  id,
  height,
  report,
}: {
  id: string;
  height: number;
  report?: LiekanReport;
}) {
  const i18n = useLiekanI18n();
  const loading = useDataLoading();
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const chart = report?.charts[id];
  const interaction = useRef<{ key: string; locale: string; option?: any }>(undefined);
  const interactionKey = JSON.stringify([
    id,
    report?.website.id,
    report?.range,
    chart,
    report?.meta.geography?.charts?.[id],
    report?.states.logs,
    report?.meta.aiCrawlerEnabled,
  ]);
  const hasData =
    !!chart && (chart.series.some(s => s.values.length > 0) || (chart.rows?.length || 0) > 0);
  useEffect(() => {
    setFailed(false);
    const previous = interaction.current;
    const retained = {
      key: interactionKey,
      locale: i18n.locale,
      option:
        previous?.key === interactionKey && previous.locale !== i18n.locale
          ? previous.option
          : undefined,
    };
    interaction.current = retained;
    if (loading || !hasData || !container.current) {
      retained.option = undefined;
      return;
    }
    let disposed = false;
    let instance: any;
    let stopLayout: () => void;
    const cleanup = (remember = false) => {
      stopLayout?.();
      stopLayout = undefined;
      if (!remember) retained.option = undefined;
      else if (instance) {
        try {
          retained.option = instance.getOption() ?? retained.option;
        } catch {
          retained.option = undefined;
        }
      }
      try {
        instance?.dispose();
      } catch {}
      instance = undefined;
    };
    const fail = () => {
      if (disposed) return;
      cleanup();
      setFailed(true);
    };
    loadEcharts()
      .then(echarts => {
        if (disposed || !container.current) return;
        instance = echarts.init(container.current, 'v5');
        const places = report?.meta?.geography?.charts?.[id];
        const displayChart =
          places && i18n.locale === 'en-US'
            ? {
                ...chart,
                labels: places.map(place =>
                  id === 'g1'
                    ? regionName(place.region, place.country, i18n.locale)
                    : countryName(place.country, i18n.locale),
                ),
              }
            : chart;
        const option = chartOptions(id, displayChart, i18n.locale);
        if (
          id === 'd1' &&
          (report?.states.logs === 'not_connected' || report?.meta.aiCrawlerEnabled === false)
        )
          option.series = option.series.slice(0, 1);
        if (id === 'c1' && report?.meta.aiCrawlerEnabled === false)
          option.series = option.series.slice(0, 1);
        option.animation = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const axes = Array.isArray(option.yAxis)
          ? option.yAxis
          : option.yAxis
            ? [option.yAxis]
            : [];
        axes.forEach((axis: any, index: number) => {
          if (axis.type !== 'value') return;
          const values = option.series.flatMap((series: any) =>
            (series.yAxisIndex || 0) === index
              ? series.data.filter((value: any) => typeof value === 'number')
              : [],
          );
          if (!values.length) return;
          const min = Math.min(...values),
            max = Math.max(...values);
          if (axis.min != null && min < axis.min) axis.min = Math.max(0, Math.floor(min * 0.8));
          if (axis.max != null && max > axis.max) axis.max = Math.ceil(max * 1.1);
        });
        stopLayout = observeChartLayout(instance, container.current, option, fail, retained.option);
      })
      .catch(fail);
    return () => {
      disposed = true;
      cleanup(true);
    };
  }, [
    id,
    chart,
    hasData,
    report?.states.logs,
    report?.meta.aiCrawlerEnabled,
    attempt,
    loading,
    i18n.locale,
    interactionKey,
  ]);
  const state =
    chart?.state ||
    (id.startsWith('h') || id.startsWith('g') || id.startsWith('s')
      ? report?.states.human
      : id.startsWith('f')
        ? report?.states.goals
        : report?.states.logs);
  return (
    <div
      id={id}
      data-liekan-chart-state={loading ? 'loading' : failed ? 'failed' : hasData ? 'data' : 'empty'}
      style={{ height, position: 'relative' }}
      role={failed ? 'group' : 'img'}
      aria-busy={loading || undefined}
      aria-label={i18n.text('{v0} 数据图表{v1}', [
        id,
        loading
          ? i18n.text(': 正在读取')
          : failed
            ? i18n.text(': 加载失败')
            : hasData
              ? ''
              : `: ${i18n.system(stateLabels[state || 'not_connected'])}`,
      ])}
    >
      <div ref={container} style={{ width: '100%', height: '100%' }} />
      {hasData && failed && (
        <div className={`${styles.chartEmpty} ${styles.chartFailure}`} role="alert">
          <span>{i18n.text('图表加载失败')}</span>
          <button type="button" className="chip" onClick={() => setAttempt(value => value + 1)}>
            {i18n.text('重试图表')}
          </button>
        </div>
      )}
      {loading && <ChartLoading />}
      {!loading && !hasData && (
        <div className={styles.chartEmpty}>
          {i18n.system(
            stateLabels[
              state === 'available' || state === 'estimated' ? 'empty' : state || 'not_connected'
            ],
          )}
        </div>
      )}
    </div>
  );
}
export function FilterChip({ label }: { label: string }) {
  const i18n = useLiekanI18n();
  const a = useReportActions();
  const loading = useDataLoading();
  const isPeriod = ['30 天', '7 天', '今天', '24h'].includes(label);
  const active = isPeriod
    ? a.period === label
    : a.filter === label ||
      (!a.filter && (label === '全部' || label === '按抓取量' || label === '按 PV'));
  return (
    <button
      type="button"
      className={`chip${active ? ' on' : ''}`}
      aria-pressed={active}
      disabled={loading}
      onClick={() => a.onFilter(label)}
    >
      {i18n.system(label)}
    </button>
  );
}
export function SortHeading({ className, label }: { className: string; label: string }) {
  const i18n = useLiekanI18n();
  const a = useReportActions();
  const loading = useDataLoading();
  return (
    <th
      className={className}
      aria-sort={
        a.sort.label === label ? (a.sort.direction === 1 ? 'ascending' : 'descending') : 'none'
      }
    >
      <button
        className={styles.sort}
        type="button"
        disabled={loading}
        onClick={() => a.onSort(label)}
      >
        {i18n.system(label)}
        {a.sort.label === label ? (
          <span aria-hidden="true">{a.sort.direction === 1 ? ' ↑' : ' ↓'}</span>
        ) : null}
      </button>
    </th>
  );
}
const cellClasses: Record<string, string[]> = {
  visitorPgBody: ['pl-6 pr-4 py-3', ...Array(5).fill('px-4 py-3 num text-right')],
  visitorTopBody: [
    'pl-6 pr-4 py-3 num text-[12px] font-medium text-ink',
    'px-4 py-3 num text-right',
    'px-4 py-3 num text-right pr-6',
  ],
  topBody: [
    'pl-6 pr-4 py-3 num text-[12px] font-medium text-ink',
    'px-4 py-3 num text-right',
    'px-4 py-3 num text-right text-brand font-semibold',
    'px-4 py-3 num text-right text-sub',
    'px-4 py-3 text-sub text-[12px]',
    'px-4 py-3 text-right pr-6',
  ],
  botBody: [
    'pl-6 pr-4 py-3',
    'px-4 py-3',
    'px-4 py-3 num text-right font-semibold',
    'px-4 py-3 num text-right text-sub',
    'px-4 py-3 num text-right text-sub',
    'px-4 py-3 text-sub text-[11.5px]',
    'px-4 py-3 text-faint text-[11.5px]',
    'px-4 py-3 text-right pr-6 num text-[12px]',
  ],
  apBody: [
    'pl-6 pr-4 py-3 num text-[12px] font-medium text-ink',
    'px-4 py-3 text-[12px] text-ink',
    'px-4 py-3 num text-right font-semibold',
    'px-4 py-3 num text-right text-sub',
    'px-4 py-3 num text-right text-sub',
    'px-4 py-3 text-sub text-[11.5px]',
    'px-4 py-3 text-faint text-[11.5px]',
    'px-4 py-3 text-right pr-6',
  ],
  cityBody: [
    'pl-6 pr-4 py-3 font-medium text-[12px] text-ink',
    'px-4 py-3 num text-right font-semibold',
    'px-4 py-3',
    'px-4 py-3 num text-right text-sub text-[12px]',
    'px-4 py-3 num text-right text-sub text-[12px]',
    'px-4 py-3 num text-right pr-6 text-down font-semibold',
  ],
  searchEngineBody: [
    'pl-6 pr-4 py-3 font-medium text-[12px] text-ink',
    'px-4 py-3',
    ...Array(5).fill('px-4 py-3 num text-right'),
    'px-4 py-3 num text-right pr-6',
  ],
  srcBody: [
    'pl-6 pr-4 py-3 num text-[12px] font-medium text-ink',
    'px-4 py-3',
    'px-4 py-3 num text-right font-semibold',
    'px-4 py-3',
    'px-4 py-3 num text-right text-sub text-[12px]',
    'px-4 py-3 num text-right text-[12px]',
    'px-4 py-3 num text-right pr-6 text-[12px]',
  ],
  pgBody: [
    'pl-6 pr-4 py-3 num text-[12px] font-medium text-ink',
    'px-4 py-3 num text-right font-semibold',
    'px-4 py-3 num text-right text-sub',
    'px-4 py-3 num text-right text-sub',
    'px-4 py-3 num text-right text-sub text-[12px]',
    'px-4 py-3 num text-right text-sub text-[12px]',
    'px-4 py-3 num text-right pr-6 text-purple font-semibold',
  ],
  goalBody: [
    'pl-6 pr-4 py-3.5 font-medium text-[12px] text-ink',
    'px-4 py-3.5 num text-right font-semibold',
    'px-4 py-3.5 num text-right text-sub',
    'px-4 py-3.5 num text-right',
    'px-4 py-3.5 num text-right pr-6 text-sub text-[12px]',
  ],
  logBody: [
    'pl-6 pr-4 py-2.5 num text-faint text-[11px] whitespace-nowrap',
    'px-4 py-2.5 text-sub text-[11px] whitespace-nowrap',
    'px-4 py-2.5 num text-ink text-[11px] whitespace-nowrap',
    'px-4 py-2.5 num text-[11px]',
    'px-4 py-2.5 num text-faint text-[10.5px] truncate',
    'px-4 py-2.5 text-right pr-6',
  ],
};
function Badge({ value, field }: { value: unknown; field?: string }) {
  const i18n = useLiekanI18n();
  const text =
    field === 'type' && value === '训练'
      ? 'AI 训练'
      : field === 'type' && value === '搜索'
        ? 'AI 搜索'
        : formatValue(value);
  const color =
    field === 'type'
      ? /训练/.test(text)
        ? 'purple'
        : /AI.*搜索/.test(text)
          ? 'blue'
          : /风险|异常/.test(text)
            ? 'red'
            : 'gray'
      : field === 'channel'
        ? /AI/.test(text)
          ? 'purple'
          : /传统|搜索/.test(text)
            ? 'blue'
            : /外部/.test(text)
              ? 'amber'
              : 'gray'
        : /风险|异常|404/.test(text)
          ? 'red'
          : /Disallow|低|盲|观察/.test(text)
            ? 'amber'
            : /引用|Allow|可用|新鲜/.test(text)
              ? 'green'
              : /AI|200/.test(text)
                ? 'blue'
                : 'gray';
  return (
    <span
      className={`bd bd-${color}`}
      title={i18n.system(
        field === 'freshness'
          ? i18n.text('更新日期距统计结束日期，仅依据导入目录元数据；缺少更新日期时显示空值。')
          : undefined,
      )}
    >
      {i18n.system(text)}
    </span>
  );
}
const percentage = formatPercentage;
function Cell({
  row,
  field,
  table,
  onCrawler,
  domain,
  place,
}: {
  place?: GeographyDisplay;
  row: Row;
  field: string;
  table: string;
  onCrawler?: (name: string, botId?: string | null) => void;
  domain?: string;
}) {
  const i18n = useLiekanI18n();
  const value = row[field];
  if (table === 'apBody' && field === 'title')
    return <>{formatCellValue(row, field, table, i18n.locale, i18n.text)}</>;
  if (table === 'apBody' && field === 'heat') return <>{formatValue(value, i18n.locale)}</>;
  if (table === 'apBody' && field === 'bot') {
    const bots = [
      { bot: row.bot, botId: row.botId },
      { bot: row.bot2, botId: row.bot2Id },
    ].filter(bot => bot.bot);
    return bots.length ? (
      <span className="crawler-page-leaders">
        {bots.map((bot, index) => {
          const identity = crawlerIdentityLabel(bot, i18n.text);
          return (
            <span key={index} title={`${bot.bot}${identity ? ` / ${identity}` : ''}`}>
              {bot.bot}
            </span>
          );
        })}
      </span>
    ) : (
      <>–</>
    );
  }
  if (table === 'cityBody' && field === 'city' && place)
    return <>{geographyLabel(place, i18n.locale)}</>;
  if (table === 'botBody' && field === 'name' && onCrawler) {
    const identity = crawlerIdentityLabel(row, i18n.text);
    return (
      <span className="relative block group">
        <span
          className="block num font-medium text-[12px] text-ink group-hover:underline"
          style={{ minWidth: identity ? 112 : undefined }}
        >
          {formatValue(value)}
        </span>
        <span className="block text-[10.5px] text-faint">
          {formatValue(row.vendor)}
          {identity ? ` · ${identity}` : ''}
        </span>
        <button
          type="button"
          aria-label={`${value}${identity ? ` · ${identity}` : ''}`}
          className="absolute inset-0 border-0 bg-transparent focus-visible:ring-2"
          style={{ minHeight: 44, minWidth: 44 }}
          onClick={() => onCrawler(String(value), row.botId as string | null | undefined)}
        />
      </span>
    );
  }
  if (table === 'botBody' && field === 'name') {
    const identity = crawlerIdentityLabel(row, i18n.text);
    return (
      <>
        <span
          className="block num font-medium text-[12px] text-ink"
          style={{ minWidth: identity ? 112 : undefined }}
        >
          {formatValue(value)}
        </span>
        <span className="block text-[10.5px] text-faint">
          {formatValue(row.vendor)}
          {identity ? ` · ${identity}` : ''}
        </span>
      </>
    );
  }
  if (table === 'logBody' && field === 'ipMasked')
    return (
      <>
        {formatValue(value)}
        {row.location && <span> / {row.location}</span>}
      </>
    );
  if (table === 'logBody' && field === 'path')
    return (
      <>
        {row.method || '–'} {pageLink(value, domain, formatValue(value), undefined, i18n.locale)}
      </>
    );
  if (field === 'path') return pageLink(value, domain, formatValue(value), undefined, i18n.locale);
  if (table === 'logBody' && field === 'classification')
    return (
      <span
        title={i18n.text('核验依据：{v0}；观测时间：{v1}；版本：{v2}', [
          i18n.system(verificationReasonLabel(row.verificationReason)),
          row.verificationObservedAt || i18n.text('历史未记录'),
          row.verificationVersion || i18n.text('历史未记录'),
        ])}
      >
        <Badge value={value} field={field} />
      </span>
    );
  if (['type', 'channel', 'evaluation', 'classification', 'freshness'].includes(field))
    return (
      <>
        <Badge value={value} field={field} />
        {table === 'botBody' &&
          field === 'type' &&
          String(row.productForm ?? '')
            .split(',')
            .filter(form => ['workbench', 'personal_agent'].includes(form))
            .map(form => (
              <span key={form} className="block text-[10.5px] text-faint mt-1">
                {i18n.text(form === 'workbench' ? 'AI 工作台' : '个人 Agent')}
              </span>
            ))}
      </>
    );
  if (table === 'searchEngineBody' && field === 'share') return <>{percentage(value)}</>;
  if (field === 'heat' || field === 'share') {
    if (value == null) return <>–</>;
    const amount = Number.parseFloat(String(value));
    const factor = field === 'heat' ? 1 : table === 'cityBody' ? 7 : 2.2;
    return (
      <div className="flex items-center gap-2">
        <div className="prog flex-1">
          <i
            style={{
              width: `${Math.max(0, Math.min(100, amount * factor))}%`,
              background:
                table === 'apBody' || /AI/.test(String(row.channel)) ? '#7C5CFC' : '#0F62FE',
            }}
          />
        </div>
        <span
          className="num text-[10.5px] text-faint"
          style={{ width: field === 'heat' ? 26 : table === 'cityBody' ? 38 : 36 }}
        >
          {field === 'heat' ? formatValue(value) : percentage(value)}
        </span>
      </div>
    );
  }
  return <>{formatCellValue(row, field, table, i18n.locale, i18n.system)}</>;
}
export function ReportRows({
  table,
  report,
  limit,
  pageSize,
  onCrawler,
}: {
  table: string;
  report?: LiekanReport;
  limit?: number;
  pageSize?: number;
  onCrawler?: (name: string, botId?: string | null) => void;
}) {
  const i18n = useLiekanI18n();
  const a = useReportActions();
  const pageRead = a.tablePageRead?.table === table ? a.tablePageRead : undefined;
  const loading = useDataLoading() || pageRead?.loading;
  const fields = columns[table] || [];
  const meta = report?.meta;
  // 服务端分页模式：meta.tablePages 有键 = 该表已是服务端切片，页码/总数/页宽全部来自
  // meta；本地筛选/排序/搜索仅作用于当前页（页脚提示），翻页经 onTablePage 重新请求。
  const serverPage = meta?.tablePages?.[table];
  const selected =
    serverPage && table === 'cityBody'
      ? report?.tables[table] || []
      : selectRows(report?.tables[table] || [], a.filter, a.sort, table, a.query, value =>
          pageUrl(value, report?.website.domain),
        );
  const perPage = typeof pageSize === 'number' && pageSize > 0 ? pageSize : 0;
  const paged = perPage > 0 || !!serverPage;
  const [page, setPage] = useState(1);
  const [pendingBatch, setPendingBatch] = useState<{ target: number; batchPage: number } | null>(
    null,
  );
  const pages = paged ? Math.max(1, Math.ceil(selected.length / perPage)) : 1;
  useEffect(() => {
    setPage(1);
    setPendingBatch(null);
  }, [a.filter, a.sort.label, a.sort.direction, a.query, table]);
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);
  const safePage = Math.min(page, pages);
  // 日志监测页窗口式分页：后端 keyset 每批 meta.pageSize 条已全部在前端，
  // 按 pageSize 切窗呈现全局页码；批内翻页本地完成，跨批边界经 onLogsPage 换批，
  // pendingBatch 记录跨批目标页，等新批到达后落到批内对应位置。
  const logsWindow =
    paged && table === 'logBody' && typeof meta?.totalLogs === 'number' ? meta : null;
  const batchPage = logsWindow ? logsWindow.page || 1 : 0;
  const batchPerPages = logsWindow
    ? Math.max(1, Math.ceil((logsWindow.pageSize || 100) / perPage))
    : 0;
  const batchFirstGlobal = logsWindow ? (batchPage - 1) * batchPerPages + 1 : 0;
  const batchLastGlobal = logsWindow ? batchFirstGlobal + batchPerPages - 1 : 0;
  const globalPages = logsWindow ? Math.max(1, Math.ceil(logsWindow.totalLogs / perPage)) : 0;
  const desiredGlobal = logsWindow
    ? pendingBatch
      ? Math.min(pendingBatch.target, globalPages)
      : Math.min(batchFirstGlobal + safePage - 1, globalPages)
    : 0;
  useEffect(() => {
    if (pendingBatch && batchPage === pendingBatch.batchPage) {
      setPage(Math.min(Math.max(pendingBatch.target - batchFirstGlobal + 1, 1), pages));
      setPendingBatch(null);
    }
  }, [pendingBatch, batchPage, batchFirstGlobal, pages]);
  const localPage = logsWindow
    ? Math.min(Math.max(desiredGlobal - batchFirstGlobal + 1, 1), pages)
    : safePage;
  const rows = serverPage
    ? selected
    : logsWindow
      ? selected.slice((localPage - 1) * perPage, localPage * perPage)
      : paged
        ? selected.slice((safePage - 1) * perPage, safePage * perPage)
        : selected.slice(0, limit ?? tableLimits[table]);
  const state = reportState(report, table);
  return (
    <>
      <tbody className="divide-y divide-line/60" id={table} aria-busy={loading || undefined}>
        {loading ? (
          Array.from({ length: pageRead?.loading ? Math.max(rows.length, 1) : 3 }, (_, i) => (
            <tr key={i} aria-hidden="true">
              {fields.map(([field], j) => (
                <td key={field} className={cellClasses[table]?.[j] || 'px-4 py-3'}>
                  <Skeleton width={j === 0 ? '80%' : '65%'} />
                </td>
              ))}
            </tr>
          ))
        ) : rows.length ? (
          rows.map((row, i) => (
            <tr
              key={String(row.id || row.path || row.name || row.source || row.time || i) + i}
              className="hover:bg-[#FAFBFD] transition-colors"
            >
              {fields.map(([field], j) => (
                <td
                  key={field}
                  title={formatCellValue(row, field, table, i18n.locale, i18n.system)}
                  className={
                    (cellClasses[table]?.[j] || 'px-4 py-3') +
                    (field === 'trend'
                      ? String(row.trend || '').startsWith('-')
                        ? ' text-down'
                        : ' text-up'
                      : field === 'status'
                        ? Number(row.status) >= 400
                          ? ' text-up'
                          : Number(row.status) === 304
                            ? ' text-faint'
                            : ' text-down'
                        : field === 'conversionRate' && /AI/.test(String(row.channel))
                          ? ' text-down font-semibold'
                          : '')
                  }
                  style={
                    field === 'userAgent'
                      ? {
                          maxWidth: 300,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }
                      : undefined
                  }
                >
                  <Cell
                    row={row}
                    field={field}
                    table={table}
                    onCrawler={onCrawler}
                    domain={report?.website.domain}
                    place={
                      report?.meta?.geography?.tables?.[table]?.[
                        report?.tables[table]?.indexOf(row)
                      ]
                    }
                  />
                </td>
              ))}
            </tr>
          ))
        ) : (
          <tr>
            <td colSpan={fields.length} className={styles.emptyRow}>
              {table === 'cityBody'
                ? i18n.system(geographyEmptyText(meta?.geographyCoverage, a.query))
                : a.query
                  ? i18n.text('没有匹配的记录')
                  : i18n.system(
                      stateLabels[state === 'available' || state === 'estimated' ? 'empty' : state],
                    )}
            </td>
          </tr>
        )}
      </tbody>
      {paged &&
        (serverPage
          ? serverPage.total > serverPage.pageSize
          : logsWindow
            ? logsWindow.totalLogs > perPage
            : selected.length > perPage) && (
          <tfoot>
            <tr>
              <td colSpan={fields.length} className="border-t border-line p-0">
                {pageRead?.retry && (
                  <div role="alert" className="px-6 pt-3 text-[11px] text-faint">
                    {i18n.text('更新失败，当前显示上次读取的数据')}{' '}
                    <button type="button" className="text-brand" onClick={pageRead.retry}>
                      {i18n.text('重试')}
                    </button>
                  </div>
                )}
                <Pager
                  disabled={pageRead?.loading}
                  total={
                    serverPage
                      ? serverPage.total
                      : logsWindow
                        ? logsWindow.totalLogs
                        : selected.length
                  }
                  page={
                    pageRead?.loading
                      ? pageRead.page
                      : serverPage
                        ? serverPage.page
                        : logsWindow
                          ? desiredGlobal
                          : safePage
                  }
                  pages={
                    serverPage
                      ? Math.max(1, Math.ceil(serverPage.total / serverPage.pageSize))
                      : logsWindow
                        ? globalPages
                        : pages
                  }
                  label={
                    pageRead?.loading
                      ? i18n.text('正在读取')
                      : serverPage && table !== 'cityBody' && (a.filter || a.sort.label || a.query)
                        ? i18n.text('当前页内筛选')
                        : undefined
                  }
                  onPrev={
                    serverPage
                      ? () => a.onTablePage?.(table, serverPage.page - 1)
                      : logsWindow
                        ? () => {
                            if (safePage > 1) {
                              setPage(safePage - 1);
                              return;
                            }
                            if (!a.onLogsPage || batchPage <= 1 || !logsWindow.previousCursor)
                              return;
                            setPendingBatch({
                              target: batchFirstGlobal - 1,
                              batchPage: batchPage - 1,
                            });
                            a.onLogsPage(batchPage - 1);
                          }
                        : () => setPage(p => Math.max(1, p - 1))
                  }
                  onNext={
                    serverPage
                      ? () => a.onTablePage?.(table, serverPage.page + 1)
                      : logsWindow
                        ? () => {
                            if (safePage < pages) {
                              setPage(safePage + 1);
                              return;
                            }
                            if (!a.onLogsPage || !logsWindow.nextCursor) return;
                            if (batchLastGlobal + 1 > globalPages) return;
                            setPendingBatch({
                              target: batchLastGlobal + 1,
                              batchPage: batchPage + 1,
                            });
                            a.onLogsPage(batchPage + 1);
                          }
                        : () => setPage(p => Math.min(pages, p + 1))
                  }
                />
              </td>
            </tr>
          </tfoot>
        )}
    </>
  );
}
function Pager({
  total,
  page,
  pages,
  label,
  disabled,
  onPrev,
  onNext,
}: {
  total: number;
  page: number;
  pages: number;
  label?: string;
  disabled?: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const i18n = useLiekanI18n();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3" data-report-pager>
      <span className="text-[11px] text-faint">
        {label ? `${label} · ` : ''}
        {i18n.fragment('共 ', true, true)}
        {formatValue(total)}
        {i18n.unit(' 条', formatValue(total), true, false)}
      </span>
      <div className="flex items-center gap-2">
        <span className="num text-[11px] text-faint">
          {i18n.fragment('第 ', false, true)}
          {formatValue(page)} / {formatValue(pages)}
          {i18n.unit(' 页', formatValue(pages), true, false)}
        </span>
        <Button disabled={disabled || page <= 1} onClick={onPrev}>
          {i18n.text('上一页')}
        </Button>
        <Button disabled={disabled || page >= pages} onClick={onNext}>
          {i18n.text('下一页')}
        </Button>
      </div>
    </div>
  );
}
export function ReportList({
  id,
  className,
  report,
  pageSize,
}: {
  id: string;
  className: string;
  report?: LiekanReport;
  pageSize?: number;
}) {
  const i18n = useLiekanI18n();
  const actions = useReportActions();
  const loading = useDataLoading();
  const sourceRows = report?.tables[id] || [];
  const serverPage = report?.meta.tablePages?.[id];
  const perPage =
    serverPage?.pageSize ?? (typeof pageSize === 'number' && pageSize > 0 ? pageSize : 0);
  const paged = id !== 'envGrid' && perPage > 0;
  const [page, setPage] = useState(1);
  const total = serverPage?.total ?? sourceRows.length;
  const pages = paged ? Math.max(1, Math.ceil(total / perPage)) : 1;
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);
  const safePage = serverPage?.page ?? Math.min(page, pages);
  const rows = serverPage
    ? sourceRows
    : paged
      ? sourceRows.slice((safePage - 1) * perPage, safePage * perPage)
      : tableLimits[id]
        ? sourceRows.slice(0, tableLimits[id])
        : sourceRows;
  const journeyShareTotal =
    id === 'journeyList' ? rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0) : 0;
  const state =
    id === 'blindList'
      ? report?.states.catalog
      : id === 'envGrid'
        ? report?.states.human
        : report?.states.logs;
  const empty = (
    <p className={styles.listEmpty}>
      {i18n.system(
        stateLabels[
          state === 'available' || state === 'estimated' ? 'empty' : state || 'not_connected'
        ],
      )}
    </p>
  );
  const step = (i: number) => (
    <span className="w-5 h-5 rounded-md bg-brand/10 text-brand text-[10px] font-bold flex items-center justify-center shrink-0 num">
      {i + 1}
    </span>
  );
  if (loading)
    return (
      <div id={id} className={className} aria-busy="true">
        {id === 'envGrid' ? (
          [i18n.text('浏览器'), i18n.text('操作系统')].map(label => (
            <div key={label}>
              <p className="text-[11px] text-faint mb-2">{i18n.system(label)}</p>
              <LoadingLines />
            </div>
          ))
        ) : (
          <LoadingLines />
        )}
      </div>
    );
  if (id === 'envGrid') {
    const categories = ['browser', 'os'].filter(category =>
      rows.some(
        row =>
          String(row.category).toLowerCase() === category ||
          String(row.category) === (category === 'browser' ? '浏览器' : '操作系统'),
      ),
    );
    return (
      <div id={id} className={className}>
        {rows.length
          ? categories.map(category => (
              <div key={category === 'browser' ? '浏览器' : '操作系统'}>
                <p className="text-[11px] text-faint mb-2">
                  {category === 'browser' ? i18n.text('浏览器') : i18n.text('操作系统')}
                </p>
                {rows
                  .filter(
                    row =>
                      String(row.category).toLowerCase() === category ||
                      String(row.category) === (category === 'browser' ? '浏览器' : '操作系统'),
                  )
                  .slice(0, 5)
                  .map((row, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between py-1.5 border-b border-line/50 last:border-0"
                    >
                      <span className="text-[11.5px] text-ink">{formatValue(row.name)}</span>
                      <span className="num text-[11px] text-sub">{percentage(row.share)}</span>
                    </div>
                  ))}
              </div>
            ))
          : empty}
      </div>
    );
  }
  return (
    <>
      <div id={id} className={className}>
        {rows.length
          ? rows.map((row, i) => {
              if (id === 'pathList')
                return (
                  <div key={i} className="flex items-center gap-3">
                    {step(i)}
                    <span className="num text-[10.5px] text-faint shrink-0 w-[52px]">
                      {row.time && /^\d{4}-\d{2}-\d{2}T/.test(String(row.time))
                        ? new Intl.DateTimeFormat('zh-CN', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            hour12: false,
                            timeZone: 'Asia/Shanghai',
                          }).format(new Date(String(row.time)))
                        : formatValue(row.time)}
                    </span>
                    <span className="num text-[11.5px] text-ink flex-1 min-w-0">
                      {pageLink(
                        row.path,
                        report?.website.domain,
                        formatValue(row.path),
                        undefined,
                        i18n.locale,
                      )}
                    </span>
                    <span className="text-[10.5px] text-faint shrink-0">
                      {formatValue(row.status)}
                    </span>
                  </div>
                );
              if (id === 'blindList')
                return (
                  <div key={i} className="px-6 py-3 hover:bg-[#FAFBFD] transition-colors">
                    <p className="num text-[12px] font-medium text-ink">
                      {pageLink(
                        row.path,
                        report?.website.domain,
                        formatValue(row.path),
                        undefined,
                        i18n.locale,
                      )}
                    </p>
                    <p className="text-[11px] text-faint mt-1">
                      {i18n.system(formatValue(row.reason))}
                    </p>
                    <p className="text-[11px] text-brand mt-0.5">
                      {i18n.system(formatValue(row.suggestion))}
                    </p>
                  </div>
                );
              if (id === 'journeyList') {
                // 全宽行首行放深度与 TOP6 内占比条；会话计数必须保留在 <p> 里，
                // 视觉夹具按 journeyList 行内 p 文本解析 count 与转化率。
                const depth = String(row.path ?? '').split(' → ').length;
                const share =
                  journeyShareTotal > 0 ? (Number(row.count) || 0) / journeyShareTotal : 0;
                return (
                  <div key={i} className="rounded-lg bg-wash px-3 py-2.5">
                    <div className={`flex items-center gap-3 ${styles.journeyRow}`}>
                      {step(i)}
                      <span
                        className={`num text-[11.5px] text-ink min-w-0 flex-1 ${styles.journeyPath}`}
                      >
                        {pageSequence(
                          String(row.path ?? '').split(' → '),
                          report?.website.domain,
                          i18n.locale,
                        )}
                      </span>
                      <span className={`text-[10.5px] text-faint shrink-0 ${styles.journeyDepth}`}>
                        {depth > 1 ? i18n.text('{v0} 页', [depth]) : i18n.text('单页')}
                      </span>
                      <span className="w-[120px] h-1.5 rounded-full bg-brand/10 overflow-hidden shrink-0">
                        <span
                          className="block h-full rounded-full bg-brand/60"
                          style={{ width: `${Math.min(100, share * 100).toFixed(1)}%` }}
                        />
                      </span>
                      <span className="num text-[11px] text-sub shrink-0 w-[44px] text-right">
                        {percentage(share * 100)}
                      </span>
                    </div>
                    <p className="text-[10.5px] text-faint mt-1" style={{ marginLeft: 32 }}>
                      {formatValue(row.count)}
                      {i18n.fragment(' 会话', true, true)}
                      {row.conversionRate != null
                        ? i18n.text(' · 转化 {v0}', [percentage(row.conversionRate)])
                        : ''}
                    </p>
                  </div>
                );
              }
              if (id === 'robotsList')
                return (
                  <div key={i} className="flex items-center gap-2.5 rounded-lg bg-wash px-3 py-2">
                    <span className="flex-1 text-ink text-[11.5px] font-medium">
                      {formatValue(row.bot)}
                    </span>
                    <Badge value={row.policy} />
                  </div>
                );
              if (id === 'pipeList')
                return (
                  <div key={i} className="flex items-center gap-3 rounded-lg bg-wash px-3 py-2.5">
                    <span className="text-[11.5px] font-bold text-brand shrink-0 w-[52px]">
                      {id === 'pipeList'
                        ? i18n.label(String(row.name), 'crawler-identity')
                        : formatValue(row.name)}
                    </span>
                    <span className="text-[11.5px] text-sub flex-1">
                      {i18n.system(formatValue(row.detail))}
                    </span>
                  </div>
                );
              const identity = id === 'prefList' ? crawlerIdentityLabel(row, i18n.text) : '';
              return (
                <div key={i} className="flex items-center gap-2.5 rounded-lg bg-wash px-3 py-2.5">
                  <span className="num text-[11.5px] font-semibold text-ink shrink-0 w-[110px]">
                    {formatValue(row.bot)}
                    {identity && (
                      <span className="block text-[10.5px] font-normal text-faint">{identity}</span>
                    )}
                  </span>
                  <span className="flex-1 text-[11.5px] text-sub">
                    {i18n.system(formatValue(row.preference))}
                  </span>
                </div>
              );
            })
          : empty}
      </div>
      {paged && total > perPage && (
        <div className="border-t border-line">
          <Pager
            total={total}
            page={safePage}
            pages={pages}
            onPrev={
              serverPage
                ? () => actions.onTablePage?.(id, Math.max(1, safePage - 1))
                : () => setPage(p => Math.max(1, p - 1))
            }
            onNext={
              serverPage
                ? () => actions.onTablePage?.(id, Math.min(pages, safePage + 1))
                : () => setPage(p => Math.min(pages, p + 1))
            }
          />
        </div>
      )}
    </>
  );
}
export function InsightRows({
  className,
  report,
  variant = 'rows',
}: {
  className?: string;
  report?: LiekanReport;
  variant?: 'rows' | 'paragraph';
}) {
  const i18n = useLiekanI18n();
  const loading = useDataLoading();
  if (variant === 'paragraph')
    return (
      <p className={className || 'text-[12px] text-sub leading-relaxed'}>
        <b className="text-ink">{i18n.text('GEO 洞察：')}</b>
        {loading ? (
          <Skeleton width="70%" />
        ) : report?.insights.length ? (
          report.insights.map(i18n.system).join(' ')
        ) : (
          i18n.text('接入日志与页面目录后生成当前范围的 GEO 发现。')
        )}
      </p>
    );
  return (
    <div className={className || 'text-[12px] text-sub leading-relaxed'}>
      {loading ? (
        <LoadingLines />
      ) : report?.insights.length ? (
        report.insights.map((insight, i) => (
          <p key={i} className="flex gap-2">
            <span
              className="w-1.5 h-1.5 rounded-full bg-brand mt-1.5 shrink-0"
              style={{ background: ['#0F62FE', '#009D9A', '#7C5CFC', '#B7791F'][i % 4] }}
            />
            {i18n.system(insight)}
          </p>
        ))
      ) : (
        <p className={styles.listEmpty}>
          {i18n.text('接入日志与页面目录后生成当前范围的 GEO 发现。')}
        </p>
      )}
    </div>
  );
}
export function LatestLog({ className, report }: { className: string; report?: LiekanReport }) {
  const i18n = useLiekanI18n();
  const loading = useDataLoading();
  const row = report?.tables.logBody?.[0];
  return (
    <pre
      className={className}
      style={{ fontFamily: 'ui-monospace,monospace', whiteSpace: 'pre-wrap', minHeight: '5lh' }}
    >
      {loading ? (
        <LoadingLines lines={3} />
      ) : row ? (
        i18n.text('{v0} [{v1}]\n"{v2} {v3}" {v4}\n{v5}\n→ 判定: {v6}', [
          formatValue(row.ipMasked),
          formatValue(row.time),
          row.method || 'GET',
          formatValue(row.path),
          formatValue(row.status),
          formatValue(row.userAgent),
          formatValue(row.classification),
        ])
      ) : (
        i18n.text('待导入访问日志\n支持 combined 格式和 JSON 记录\n导入后显示最近一条脱敏日志')
      )}
    </pre>
  );
}

export function LiveStatus({ report, live }: { report?: LiekanReport; live?: boolean }) {
  const i18n = useLiekanI18n();
  const loading = useDataLoading();
  const connected = ['available', 'empty', 'estimated'].includes(report?.states.logs);
  return (
    <>
      <span
        className="w-2 h-2 rounded-full"
        style={{ background: connected ? '#0E9F6E' : '#9AA3B2' }}
      />
      <span
        className="text-[11px] text-faint"
        title={i18n.system(
          live
            ? i18n.text('最近 30 天窗口固定于本次读取；主动刷新时重新计算。')
            : i18n.text('所选历史范围保持固定；主动刷新时重新读取。'),
        )}
      >
        {loading
          ? i18n.text('正在读取')
          : connected
            ? live
              ? i18n.text('本次快照')
              : i18n.text('历史快照')
            : i18n.text('待接入')}
      </span>
    </>
  );
}
