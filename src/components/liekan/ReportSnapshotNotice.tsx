'use client';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import type { LiekanLocale } from '@/lib/liekan/i18n/locale';
import type { LiekanReport } from './types';

export function fallbackReportRangeLabel(report: LiekanReport | undefined, locale: LiekanLocale) {
  if (!report?.meta.snapshot?.fallback) return undefined;
  return [report.range.startAt, report.range.endAt]
    .map(value =>
      new Date(value).toLocaleDateString(locale, {
        timeZone: report.range.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
    )
    .join(' – ');
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
    </span>
  );
}
