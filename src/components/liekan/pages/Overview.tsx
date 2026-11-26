import { ReportTrend } from '../ReportTrend';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import {
  InsightRows,
  MetricCard,
  ReferenceChart,
  ReportRows,
  SortHeading,
} from '../ReportComponents';
import type { ReportViewProps } from '../types';
import { GeoWeightPlaceholder } from '../features/GeoWeightSummary';

export function Overview({
  report,
  rangeLabel,
  trendLabel,
  aiCrawlerEnabled,
  geoWeight,
  trend,
}: ReportViewProps) {
  const i18n = useLiekanI18n();
  if (aiCrawlerEnabled === false || report?.meta.aiCrawlerEnabled === false)
    return (
      <VisitorOverview
        report={report}
        rangeLabel={i18n.system(rangeLabel)}
        trendLabel={i18n.system(trendLabel)}
        trend={trend}
      />
    );
  return (
    <main className="max-w-[1200px] mx-auto px-8 py-6 space-y-4">
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard
          label="今日总请求"
          className="card p-4 fade-in d1"
          valueClass="num text-[24px] font-bold text-brand mt-1.5"
          report={report}
        />
        <MetricCard
          label="访客（UV）"
          className="card p-4 fade-in d1"
          valueClass="num text-[24px] font-bold text-down mt-1.5"
          report={report}
        />
        <MetricCard
          label="AI 蜘蛛请求"
          className="card p-4 fade-in d1"
          valueClass="num text-[24px] font-bold text-up mt-1.5"
          report={report}
        />
        {geoWeight ?? <GeoWeightPlaceholder />}
      </section>
      <ReportTrend
        key={trend?.key}
        report={report}
        rangeLabel={rangeLabel}
        trendLabel={trendLabel}
        trend={trend}
        title="AI 蜘蛛与浏览访问趋势"
        suffix=" · 浏览器 PV / 日志 AI 请求"
        id="d1"
        height={280}
      />
      <section className="grid grid-cols-3 gap-4">
        <div className="card fade-in d2">
          <div className="px-6 pt-5 pb-2">
            <h2 className="text-[14px] font-bold tracking-tight">{i18n.text('AI 蜘蛛构成')}</h2>
            <p className="text-[11.5px] text-faint mt-0.5">
              {i18n.system(rangeLabel)}
              {i18n.fragment(' · 按请求量', true, false)}
            </p>
          </div>
          <ReferenceChart id="d2" height={250} report={report} />
        </div>
        <div className="card fade-in d2">
          <div className="px-6 pt-5 pb-2">
            <h2 className="text-[14px] font-bold tracking-tight">{i18n.text('访客来源渠道')}</h2>
            <p className="text-[11.5px] text-faint mt-0.5">
              {i18n.system(rangeLabel)}
              {i18n.fragment(' · 按会话', true, false)}
            </p>
          </div>
          <ReferenceChart id="d3" height={250} report={report} />
        </div>
        <div className="card fade-in d3">
          <div className="px-6 pt-5 pb-2">
            <h2 className="text-[14px] font-bold tracking-tight">{i18n.text('GEO 关键发现')}</h2>
          </div>
          <InsightRows
            className="px-6 pb-5 space-y-2.5 text-[12px] text-sub leading-relaxed"
            report={report}
          />
        </div>
      </section>
      <section className="card fade-in d3 overflow-hidden">
        <div className="px-6 py-4 border-b border-line flex items-center justify-between">
          <h2 className="text-[14px] font-bold tracking-tight">
            {i18n.text('页面双视角 TOP（AI 抓取 × 浏览访问）')}
          </h2>
          <span className="text-[11.5px] text-faint">
            {i18n.system(rangeLabel)}
            {i18n.fragment(' · 按 PV / 抓取次数', true, false)}
          </span>
        </div>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-[11.5px] text-faint border-b border-line bg-[#FAFBFD]">
              <SortHeading className="font-medium pl-6 pr-4 py-3" label="页面" />
              <SortHeading className="font-medium px-4 py-3 text-right" label="浏览 PV" />
              <SortHeading className="font-medium px-4 py-3 text-right" label="AI 抓取" />
              <SortHeading className="font-medium px-4 py-3 text-right" label="AI/浏览 比值" />
              <SortHeading className="font-medium px-4 py-3" label="最活跃蜘蛛" />
              <SortHeading className="font-medium px-4 py-3 text-right pr-6" label="GEO 评价" />
            </tr>
          </thead>
          <ReportRows table="topBody" report={report} pageSize={20} />
        </table>
      </section>
    </main>
  );
}

function VisitorOverview({ report, rangeLabel, trendLabel, trend }: ReportViewProps) {
  const i18n = useLiekanI18n();
  return (
    <main className="max-w-[1200px] mx-auto px-8 py-6 space-y-4" data-visitor-overview>
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {['访客数 UV', '浏览量 PV', '跳出率', '平均访问时长'].map(label => (
          <MetricCard
            key={label}
            label={label}
            className="card p-4 fade-in d1"
            valueClass="num text-[24px] font-bold text-brand mt-1.5"
            report={report}
          />
        ))}
      </section>
      <ReportTrend
        key={trend?.key}
        report={report}
        rangeLabel={rangeLabel}
        trendLabel={trendLabel}
        trend={trend}
        title="访客浏览趋势"
        suffix=" · 浏览器 PV"
        id="d1"
        height={280}
        wrap
      />
      <section className="grid grid-cols-2 gap-4">
        <div className="card fade-in d2">
          <div className="px-6 pt-5 pb-2">
            <h2 className="text-[14px] font-bold tracking-tight">{i18n.text('访客来源渠道')}</h2>
            <p className="text-[11.5px] text-faint mt-0.5">
              {i18n.system(rangeLabel)}
              {i18n.fragment(' · 按会话', true, false)}
            </p>
          </div>
          <ReferenceChart id="d3" height={250} report={report} />
        </div>
        <div className="card fade-in d3">
          <div className="px-6 pt-5 pb-2">
            <h2 className="text-[14px] font-bold tracking-tight">{i18n.text('访问概况')}</h2>
          </div>
          <InsightRows
            className="px-6 pb-5 space-y-2.5 text-[12px] text-sub leading-relaxed"
            report={report}
          />
        </div>
      </section>
      <section className="card fade-in d3 overflow-hidden">
        <div className="px-6 py-4 border-b border-line flex flex-wrap gap-2 items-center justify-between">
          <h2 className="text-[14px] font-bold tracking-tight">{i18n.text('热门访问页面')}</h2>
          <span className="text-[11.5px] text-faint">
            {i18n.system(rangeLabel)}
            {i18n.fragment(' · 按浏览量', true, false)}
          </span>
        </div>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-[11.5px] text-faint border-b border-line bg-[#FAFBFD]">
              <SortHeading className="font-medium pl-6 pr-4 py-3" label="页面" />
              <SortHeading className="font-medium px-4 py-3 text-right" label="浏览量 PV" />
              <SortHeading className="font-medium px-4 py-3 text-right pr-6" label="访客数 UV" />
            </tr>
          </thead>
          <ReportRows table="visitorTopBody" report={report} pageSize={20} />
        </table>
      </section>
    </main>
  );
}
