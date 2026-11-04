import { DEFAULT_RESET_DATE } from '@/lib/constants';
import { getCompareDate } from '@/lib/date';
import {
  identityUsable,
  totalIdentityFields,
  unavailableFields,
} from '../contracts/browser-population';
import { websiteSummarySchema } from '../contracts/website-summary';
import { geographicEventRelation } from '../warehouse/reporting-relations';
import { factRelation } from '../warehouse/read';
import { warehouseTime } from '../warehouse/fact-input';
import { readBrowserPopulation } from './browser-population';
import { warehouseReportQuery, withinWarehouseReport } from './warehouse-report-snapshot';
import { channelFilterColumn } from './filter-extension';
export async function warehouseWebsiteSummaries(
  sites: { id: string; createdAt: Date }[],
  p: { startAt: number; endAt: number; timezone: string },
) {
  return withinWarehouseReport(async () => {
    const start = new Date(p.startAt),
      end = new Date(p.endAt),
      previous = getCompareDate('prev', start, end, p.timezone),
      result = [];
    const zero = { pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0, aiVisits: 0 };
    for (const site of sites) {
      const params = {
        start: warehouseTime(start),
        end: warehouseTime(end),
        previousStart: warehouseTime(previous.startDate),
        previousEnd: warehouseTime(previous.endDate),
      };
      const totals = await warehouseReportQuery<any>(
        site.id,
        `WITH visits AS(SELECT if(e.created_at>={start:DateTime64(6)},0,1) AS period,session_id,visit_id,
        countIf(event_type NOT IN(2,5)) AS pv,minOrNullIf(created_at,event_type NOT IN(2,5)) AS first_at,maxOrNullIf(created_at,event_type NOT IN(2,5)) AS last_at,
        countIf(event_type=2) AS custom,countIf(event_type NOT IN(2,5) AND ${channelFilterColumn('e.')}='AI 搜索引荐')>0 AS ai
        FROM ${geographicEventRelation()} e WHERE (created_at BETWEEN {start:DateTime64(6)} AND {end:DateTime64(6)} OR created_at BETWEEN {previousStart:DateTime64(6)} AND {previousEnd:DateTime64(6)}) AND event_type!=5
        GROUP BY period,session_id,visit_id HAVING pv>0)
        SELECT period,sum(pv) AS pageviews,uniqExact(session_id) AS visitors,uniqExact(visit_id) AS visits,countIf(pv=1 AND custom=0) AS bounces,
        sum(floor((toUnixTimestamp64Micro(last_at)-toUnixTimestamp64Micro(first_at))/1000000.0)) AS totaltime,uniqExactIf(visit_id,ai) AS aiVisits FROM visits GROUP BY period`,
        params,
      );
      const [presence] = await warehouseReportQuery<any>(
        site.id,
        `SELECT countIf(event_type NOT IN(2,5) AND created_at BETWEEN {created:DateTime64(6)} AND {now:DateTime64(6)})>0 AS received,
        maxOrNullIf(created_at,created_at>={reset:DateTime64(6)}) AS lastAt FROM ${factRelation('website_event')}`,
        {
          created: warehouseTime(site.createdAt),
          now: warehouseTime(new Date()),
          reset: warehouseTime(new Date(DEFAULT_RESET_DATE)),
        },
      );
      const population = await readBrowserPopulation(site.id, start, end, p.timezone),
        comparisonPopulation = await readBrowserPopulation(
          site.id,
          previous.startDate,
          previous.endDate,
          p.timezone,
        );
      const normalize = (period: number, pop: typeof population) => {
        const row = totals.find(r => Number(r.period) === period) ?? zero;
        const values = Object.fromEntries(Object.keys(zero).map(k => [k, Number(row[k] ?? 0)]));
        return identityUsable(pop)
          ? values
          : unavailableFields(values, [
              ...totalIdentityFields,
              'aiVisits',
              ...(pop.metricScope === 'qualified-browser' ? ['pageviews'] : []),
            ]);
      };
      const current = normalize(0, population),
        comparison = normalize(1, comparisonPopulation);
      result.push({
        id: site.id,
        ...current,
        population,
        comparison: { ...comparison, population: comparisonPopulation },
        views: current.pageviews,
        received: !!presence.received,
        lastAt: presence.lastAt
          ? new Date(String(presence.lastAt).replace(' ', 'T') + 'Z').toISOString()
          : null,
      });
    }
    return websiteSummarySchema.parse(result);
  });
}
