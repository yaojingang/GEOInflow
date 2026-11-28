import { ReportTrend } from '../ReportTrend';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import { MetricCard, ReferenceChart, ReportList } from '../ReportComponents';
import type { ReportViewProps } from '../types';

export function HumanOverview({ report, rangeLabel, trendLabel, trend }: ReportViewProps) {
  const i18n = useLiekanI18n();
  return (
    <main className="max-w-[1200px] mx-auto px-8 py-6 space-y-4">
      <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <MetricCard
          label="访客数 UV"
          className="card p-4 fade-in d1"
          valueClass="num text-[24px] font-bold text-brand mt-1.5"
          report={report}
        />
        <MetricCard
          label="浏览量 PV"
          className="card p-4 fade-in d1"
          valueClass="num text-[24px] font-bold text-brand mt-1.5"
          report={report}
        />
        <MetricCard
          label="跳出率"
          className="card p-4 fade-in d1"
          valueClass="num text-[24px] font-bold text-down mt-1.5"
          report={report}
        />
        <MetricCard
          label="平均访问时长"
          className="card p-4 fade-in d1"
          valueClass="num text-[24px] font-bold text-down mt-1.5"
          report={report}
        />
        <MetricCard
          label="新访客占比"
          className="card p-4 fade-in d1"
          valueClass="num text-[24px] font-bold text-brand mt-1.5"
          report={report}
        />
      </section>
      <ReportTrend
        key={trend?.key}
        report={report}
        rangeLabel={rangeLabel}
        trendLabel={trendLabel}
        trend={trend}
        title="访客趋势（UV / PV / 跳出率）"
        suffix=" · 浏览器追踪数据"
        id="h1"
        height={270}
      />
      <section className="grid grid-cols-3 gap-4">
        <div className="card fade-in d2">
          <div className="px-6 pt-5 pb-2">
            <h2 className="text-[14px] font-bold tracking-tight">{i18n.text('访问时段热力')}</h2>
            <p className="text-[11.5px] text-faint mt-0.5">{i18n.system(rangeLabel)} · 24h</p>
          </div>
          <ReferenceChart id="h2" height={220} report={report} />
        </div>
        <div className="card fade-in d2">
          <div className="px-6 pt-5 pb-2">
            <h2 className="text-[14px] font-bold tracking-tight">{i18n.text('设备构成')}</h2>
            <p className="text-[11.5px] text-faint mt-0.5">
              {i18n.system(rangeLabel)}
              {i18n.fragment(' · 按会话', true, false)}
            </p>
          </div>
          <ReferenceChart id="h3" height={220} report={report} />
        </div>
        <div className="card fade-in d3">
          <div className="px-6 pt-5 pb-2">
            <h2 className="text-[14px] font-bold tracking-tight">
              {i18n.text('浏览器 / OS TOP5')}
            </h2>
          </div>
          <ReportList id="envGrid" className="px-6 pb-5 grid grid-cols-2 gap-4" report={report} />
        </div>
      </section>
    </main>
  );
}
