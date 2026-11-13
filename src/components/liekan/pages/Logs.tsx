import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import { DataLoading } from '../DataLoading';
import {
  FilterChip,
  LatestLog,
  LiveStatus,
  MetricCard,
  ReportList,
  ReportRows,
  SortHeading,
} from '../ReportComponents';
import type { ReportViewProps } from '../types';

export function Logs({ report, live }: ReportViewProps) {
  const i18n = useLiekanI18n();
  return (
    <main className="max-w-[1200px] mx-auto px-8 py-6 space-y-4">
      <DataLoading loading={!report || report.meta.logParts?.summary === 'pending'}>
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MetricCard
            label="日志处理能力"
            className="card p-4 fade-in d1"
            valueClass="num text-[24px] font-bold text-brand mt-1.5"
            report={report}
          />
          <MetricCard
            label="今日已解析"
            className="card p-4 fade-in d1"
            valueClass="num text-[24px] font-bold text-brand mt-1.5"
            report={report}
          />
          <MetricCard
            label="蜘蛛识别规则"
            className="card p-4 fade-in d1"
            valueClass="num text-[24px] font-bold text-brand mt-1.5"
            report={report}
          />
          <MetricCard
            label="异常请求（今日）"
            className="card p-4 fade-in d1"
            valueClass="num text-[24px] font-bold text-up mt-1.5"
            report={report}
          />
        </section>
      </DataLoading>
      <section className="card fade-in d2 overflow-hidden">
        <div className="px-6 py-4 border-b border-line flex items-center justify-between gap-3">
          <h2 className="text-[14px] font-bold tracking-tight">{i18n.text('实时访问流')}</h2>
          <div className="flex items-center gap-2">
            <FilterChip label="全部" />
            <FilterChip label="仅 AI 蜘蛛" />
            <FilterChip label="未知／未分类" />
            <FilterChip label="仅异常" />
            <LiveStatus report={report} live={live} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[11.5px] text-faint border-b border-line bg-[#FAFBFD]">
                <SortHeading className="font-medium pl-6 pr-4 py-3" label="时间" />
                <SortHeading className="font-medium px-4 py-3" label="IP / 归属" />
                <SortHeading className="font-medium px-4 py-3" label="请求" />
                <SortHeading className="font-medium px-4 py-3" label="状态" />
                <SortHeading className="font-medium px-4 py-3" label="User-Agent（截断）" />
                <SortHeading className="font-medium px-4 py-3 text-right pr-6" label="判定" />
              </tr>
            </thead>
            <ReportRows table="logBody" report={report} pageSize={20} />
          </table>
        </div>
      </section>
      <section className="grid grid-cols-2 gap-4">
        <div className="card fade-in d2 p-5">
          <h2 className="text-[14px] font-bold tracking-tight">{i18n.text('解析管线')}</h2>
          <DataLoading loading={!report || report.meta.logParts?.summary === 'pending'}>
            <ReportList
              id="pipeList"
              className="mt-3 space-y-2"
              report={
                report?.meta.logParts?.summary === 'failed'
                  ? { ...report, states: { ...report.states, logs: 'unavailable' } }
                  : report
              }
            />
          </DataLoading>
        </div>
        <div className="card fade-in d3 p-5">
          <h2 className="text-[14px] font-bold tracking-tight">
            {i18n.text('原始日志样例（combined 格式）')}
          </h2>
          <div className="mt-3 rounded-lg bg-ink p-3.5 overflow-x-auto">
            <LatestLog report={report} className="text-[10.5px] leading-relaxed text-[#9AA3B2]" />
          </div>
          <div className="mt-3 space-y-1.5 text-[11.5px] text-sub leading-relaxed">
            <p>{i18n.text('日志导入前会验证字段，访问地址脱敏后保存。')}</p>
            <p>{i18n.text('可按 User-Agent、页面、状态码和分类筛选当前结果。')}</p>
          </div>
        </div>
      </section>
    </main>
  );
}
