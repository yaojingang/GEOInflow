import { calendarDayRange, calendarDateRange } from '../contracts/calendar';
import { formatInTimeZone } from 'date-fns-tz';
import type { LogReadQuery } from '../contracts/log-read';
import { crawlerIdentitySql } from '../crawlers/metric-scope';
import { crawlerAiSql, unknownCrawlerSql } from '../rules/population';
import { readAnalysisLogRollup, analysisSafeNumber } from './analysis-rollups';
import { readReportFragment, primeReportFragments } from './report-fragments';
import { query } from './server';
import { readClickHouseLogCounts } from './analytics-engine-counts';

export type LogStatistics = {
  requests: number;
  ai: number;
  abnormal: number;
  legacyRequests: number;
  unclassifiedRequests: number;
  classifications: string[];
};
const empty = (): LogStatistics => ({
  requests: 0,
  ai: 0,
  abnormal: 0,
  legacyRequests: 0,
  unclassifiedRequests: 0,
  classifications: [],
});

/** Natural days share closed facts; only the current five-minute tail uses source rows. */
export function logStatisticsRanges(
  start: number,
  end: number,
  timezone: string,
  now = Date.now(),
) {
  const closed = Math.floor(now / 300000) * 300000;
  const ranges: { start: number; end: number; tail: boolean }[] = [];
  let at = start;
  while (at < end) {
    const month = formatInTimeZone(at, timezone, 'yyyy-MM');
    const monthStart = calendarDateRange(`${month}-01`, timezone).startAt;
    const nextMonth = new Date(`${month}-01T00:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const monthEnd = calendarDateRange(nextMonth.toISOString().slice(0, 10), timezone).startAt;
    const next =
      at === monthStart && monthEnd <= end && monthEnd <= closed
        ? monthEnd
        : Math.min(calendarDayRange(at, timezone).endAt + 1, end);
    const split = Math.min(next, Math.max(at, closed));
    if (split > at) ranges.push({ start: at, end: split, tail: false });
    if (next > split) ranges.push({ start: split, end: next, tail: true });
    at = next;
  }
  return ranges;
}

async function load(
  websiteId: string,
  p: LogReadQuery,
  start: number,
  end: number,
): Promise<LogStatistics> {
  const input = {
    websiteId,
    startDate: new Date(start),
    endDate: new Date(end),
    timezone: p.timezone,
    crawlerMetricsVersion: 1,
    crawlerIdentityScope: p.crawlerIdentityScope,
    fields: ['counts'],
    allowRawOnly: true,
  } as const;
  const counts = await readClickHouseLogCounts(input);
  if (counts) return counts;
  const accelerated = await readAnalysisLogRollup(input);
  if (accelerated?.counts) return accelerated.counts;
  const [value] = await query<LogStatistics>(
    `SELECT count(*)::text AS requests,
      count(*) FILTER(WHERE ${crawlerAiSql()})::text AS ai,
      count(*) FILTER(WHERE status>=400)::text AS abnormal,
      count(*) FILTER(WHERE ai_eligible IS NULL)::text AS "legacyRequests",
      count(*) FILTER(WHERE ${unknownCrawlerSql()})::text AS "unclassifiedRequests",
      coalesce(array_agg(DISTINCT coalesce(l.reporting_classification_version,'legacy')),ARRAY[]::text[]) AS classifications
     FROM liekan_reporting_log l LEFT JOIN liekan_crawler_evidence e ON e.website_id=l.website_id AND e.log_id=l.id
     WHERE l.website_id=$1::uuid AND created_at>=$2::timestamptz AND created_at<$3::timestamptz
      AND user_agent NOT LIKE 'Liekan-Crawler-Check/%' ${crawlerIdentitySql(p.crawlerIdentityScope)}`,
    websiteId,
    new Date(start),
    new Date(end),
  );
  for (const key of [
    'requests',
    'ai',
    'abnormal',
    'legacyRequests',
    'unclassifiedRequests',
  ] as const)
    value[key] = analysisSafeNumber(String(value[key]));
  return value;
}

/** Exact additive counts and a classification union preserve mixed historical populations. */
export async function readLogStatistics(
  websiteId: string,
  p: LogReadQuery,
): Promise<LogStatistics> {
  const result = empty();
  const classifications = new Set<string>();
  const ranges = logStatisticsRanges(p.startAt, p.endAt, p.timezone);
  const conditions = { timezone: p.timezone, scope: p.crawlerIdentityScope, metrics: 1 };
  await primeReportFragments(
    'log-counts-v1',
    ranges.filter(r => !r.tail).map(r => ({ start: new Date(r.start), end: new Date(r.end) })),
    conditions,
    'log',
  );
  for (const range of ranges) {
    const source = () => load(websiteId, p, range.start, range.end);
    const value = range.tail
      ? await source()
      : await readReportFragment(
          'log-counts-v1',
          new Date(range.start),
          new Date(range.end),
          conditions,
          source,
          false,
          'log',
        );
    for (const key of [
      'requests',
      'ai',
      'abnormal',
      'legacyRequests',
      'unclassifiedRequests',
    ] as const)
      result[key] = analysisSafeNumber((BigInt(result[key]) + BigInt(value[key])).toString());
    for (const version of value.classifications) classifications.add(version);
  }
  result.classifications = [...classifications].sort();
  return result;
}
