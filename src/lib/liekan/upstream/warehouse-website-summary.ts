import { DEFAULT_RESET_DATE } from '@/lib/constants';
import { getCompareDate } from '@/lib/date';
import { calendarDayRange } from '../contracts/calendar';
import {
  identityUsable,
  totalIdentityFields,
  unavailableFields,
} from '../contracts/browser-population';
import { websiteSummarySchema } from '../contracts/website-summary';
import {
  geographicEventRelation,
  websiteSummaryEventRelation,
} from '../warehouse/reporting-relations';
import { factRelation } from '../warehouse/read';
import { warehouseTime } from '../warehouse/fact-input';
import { populationFromRow, readBrowserPopulation } from './browser-population';
import {
  warehouseReportMetadata,
  warehouseReportQuery,
  withinWarehouseReport,
} from './warehouse-report-snapshot';
import { channelFilterColumn } from './filter-extension';

function calendarSummarySql(relation: string) {
  return `WITH visits AS (
    SELECT if(e.created_at>={start:DateTime64(6)},0,1) AS period,e.session_id AS sid,e.visit_id AS vid,
      count() AS eligibleEvents,countIf(qualified) AS qualifiedEvents,
      countIf(event_type=1) AS eligiblePV,countIf(qualified AND event_type=1) AS pv,
      countIf(qualified AND event_type=2) AS custom,
      minOrNullIf(created_at,qualified AND event_type=1) AS first_at,
      maxOrNullIf(created_at,qualified AND event_type=1) AS last_at,
      countIf(qualified AND event_type=1 AND ${channelFilterColumn('e.')}='AI 搜索引荐')>0 AS ai,
      groupUniqArray(identity_version) AS iv,groupUniqArrayIf(identity_version,qualified AND event_type=1) AS qiv,
      groupUniqArray(rule_version) AS rv,groupUniqArray(catalog_version) AS cv
    FROM ${relation} e
    WHERE created_at BETWEEN {start:DateTime64(6)} AND {end:DateTime64(6)}
       OR created_at BETWEEN {previousStart:DateTime64(6)} AND {previousEnd:DateTime64(6)}
    GROUP BY period,sid,vid)
    SELECT period,sum(pv) AS pageviews,uniqExactIf(sid,pv>0) AS visitors,uniqExactIf(vid,pv>0) AS visits,
      countIf(pv=1 AND custom=0) AS bounces,
      sum(floor((toUnixTimestamp64Micro(last_at)-toUnixTimestamp64Micro(first_at))/1000000.0)) AS totaltime,
      uniqExactIf(vid,ai) AS aiVisits,sum(eligibleEvents) AS eligibleEvents,sum(qualifiedEvents) AS qualifiedEvents,
      sum(eligiblePV) AS eligiblePV,sum(pv) AS qualifiedPV,uniqExactIf(sid,pv>0) AS qualifiedVisitors,
      arraySlice(arraySort(groupUniqArrayArray(iv)),1,33) AS identityVersions,
      arraySlice(arraySort(groupUniqArrayArray(qiv)),1,33) AS qualifiedIdentityVersions,
      arraySlice(arraySort(groupUniqArrayArray(rv)),1,33) AS ruleVersions,
      arraySlice(arraySort(groupUniqArrayArray(cv)),1,33) AS catalogVersions
    FROM visits GROUP BY period`;
}

function customSummarySql() {
  return `WITH visits AS(SELECT if(e.created_at>={start:DateTime64(6)},0,1) AS period,session_id,visit_id,
        countIf(event_type NOT IN(2,5)) AS pv,minOrNullIf(created_at,event_type NOT IN(2,5)) AS first_at,maxOrNullIf(created_at,event_type NOT IN(2,5)) AS last_at,
        countIf(event_type=2) AS custom,countIf(event_type NOT IN(2,5) AND ${channelFilterColumn('e.')}='AI 搜索引荐')>0 AS ai
        FROM ${geographicEventRelation()} e WHERE (created_at BETWEEN {start:DateTime64(6)} AND {end:DateTime64(6)} OR created_at BETWEEN {previousStart:DateTime64(6)} AND {previousEnd:DateTime64(6)}) AND event_type!=5
        GROUP BY period,session_id,visit_id HAVING pv>0)
        SELECT period,sum(pv) AS pageviews,uniqExact(session_id) AS visitors,uniqExact(visit_id) AS visits,countIf(pv=1 AND custom=0) AS bounces,
        sum(floor((toUnixTimestamp64Micro(last_at)-toUnixTimestamp64Micro(first_at))/1000000.0)) AS totaltime,uniqExactIf(visit_id,ai) AS aiVisits FROM visits GROUP BY period`;
}

export async function warehouseWebsiteSummaries(
  sites: { id: string; createdAt: Date }[],
  p: { startAt: number; endAt: number; timezone: string },
) {
  return withinWarehouseReport(async () => {
    const start = new Date(p.startAt),
      end = new Date(p.endAt),
      previous = getCompareDate('prev', start, end, p.timezone),
      result = [];
    const day = calendarDayRange(p.startAt, p.timezone);
    const fullDay = day.startAt === p.startAt && day.endAt === p.endAt;
    const zero = { pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0, aiVisits: 0 };
    for (const site of sites) {
      const params = {
        start: warehouseTime(start),
        end: warehouseTime(end),
        previousStart: warehouseTime(previous.startDate),
        previousEnd: warehouseTime(previous.endDate),
      };
      const [presence] = await warehouseReportQuery<any>(
        site.id,
        `SELECT countIf(event_type NOT IN(2,5) AND created_at BETWEEN {created:DateTime64(6)} AND {now:DateTime64(6)})>0 AS received,
        maxOrNullIf(created_at,created_at>={reset:DateTime64(6)}) AS lastAt,
        countIf(created_at BETWEEN {previousStart:DateTime64(6)} AND {end:DateTime64(6)})>0 AS hasEvents
        FROM ${factRelation('website_event', { columns: ['created_at', 'event_type'] })}`,
        {
          ...params,
          created: warehouseTime(site.createdAt),
          now: warehouseTime(new Date()),
          reset: warehouseTime(new Date(DEFAULT_RESET_DATE)),
        },
      );
      const metadata = fullDay ? await warehouseReportMetadata(site.id) : undefined;
      const totals =
        metadata && !Number(presence.hasEvents)
          ? []
          : await warehouseReportQuery<any>(
              site.id,
              metadata
                ? calendarSummarySql(websiteSummaryEventRelation(metadata))
                : customSummarySql(),
              params,
            );
      const readPopulation = (period: number, from: Date, to: Date) => {
        if (!metadata) return readBrowserPopulation(site.id, from, to, p.timezone);
        return {
          ...populationFromRow(
            {
              eligibleEvents: 0,
              qualifiedEvents: 0,
              eligiblePV: 0,
              qualifiedPV: 0,
              qualifiedVisitors: 0,
              ...metadata.population,
              ...totals.find(row => Number(row.period) === period),
              metricScope: 'qualified-browser',
            },
            { startAt: +from, endAt: +to, timezone: p.timezone },
          ),
          resourceId: site.id,
        };
      };
      const population = await readPopulation(0, start, end);
      const comparisonPopulation = await readPopulation(1, previous.startDate, previous.endDate);
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
