'use client';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import type { LiekanLocale } from '@/lib/liekan/i18n/locale';
import type { LiekanReport } from './types';

export function fallbackReportRangeLabel(report: LiekanReport | undefined, locale: LiekanLocale) {
  if (!report?.meta.snapshot?.fallback) return undefined;
  const { startAt, endAt, timezone } = report.range;
  const display = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const last =
    report.meta.crawlerMetrics?.timeBoundary === 'half_open' ? Math.max(startAt, endAt - 1) : endAt;
  const from = display.format(startAt);
  const to = display.format(last);
  return from === to ? from : `${from} – ${to}`;
}

export function ReportSnapshotNotice({ report }: { report: LiekanReport }) {
  const i18n = useLiekanI18n();
  const snapshot = report.meta.snapshot;
  if (!snapshot) return null;
  const rangeLabel = fallbackReportRangeLabel(report, i18n.locale);
  return (
    <span>
      {rangeLabel && (
        <span role="status">
          {i18n.text('当前区间尚未就绪，显示上次统计（{v0}）', [rangeLabel])} ·{' '}
        </span>
      )}
      {i18n.text('数据截至 {v0}', [
        new Date(snapshot.dataThrough).toLocaleString(i18n.locale, {
          timeZone: report.range.timezone,
          hour12: false,
        }),
      ])}
      {snapshot.updateError && (
        <span role="status"> · {i18n.text('更新失败，当前显示上次读取的数据')}</span>
      )}
      {!snapshot.updateError && !rangeLabel && snapshot.state === 'updating' && (
        <span role="status"> · {i18n.text('后台正在更新，当前显示上次完成的数据')}</span>
      )}
    </span>
  );
}
