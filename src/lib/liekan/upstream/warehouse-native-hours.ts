import { getTimezoneOffset } from 'date-fns-tz';
import { analysisWindowRelation, type AnalysisWindow } from '../warehouse/analysis-context';

/** Only simple PV/UV series can use these fragments. Dimension/cohort filters,
 * bounce filtering and minute buckets keep the event relation and its semantics. */
export function nativeHourlyStats(
  name: string | undefined,
  query: string,
  params: Record<string, unknown>,
  window?: AnalysisWindow,
) {
  if (
    !['getPageviewStats', 'getSessionStats'].includes(name) ||
    !window ||
    !query.includes('from website_event_stats_hourly as website_event') ||
    /\bjoin\b/i.test(query) ||
    Object.keys(params).some(
      k => !['websiteId', 'startDate', 'endDate', 'timezone', 'unit'].includes(k),
    ) ||
    !['hour', 'day', 'week', 'month', 'year'].includes(String(params.unit ?? 'day'))
  )
    return;
  const flat = analysisWindowRelation(
    'browser',
    ['website_id', 'session_id', 'created_at', 'event_type'],
    window,
    true,
  );
  if (!flat) return;
  const first = Math.ceil(window.start / 3600000) * 3600;
  const last = Math.floor((window.end + 1) / 3600000) * 3600;
  if (last <= first) return;
  // A non-hour-aligned local calendar boundary can split a UTC fragment.
  const tz = String(params.timezone ?? 'UTC');
  for (let h = first; h < last; h += 3600)
    if (getTimezoneOffset(tz, new Date(h * 1000)) % 3600000 !== 0) return;
  const edge = window.start !== first * 1000 || window.end !== last * 1000 - 1;
  return `(SELECT website_id,session_id,toDateTime64(_hour,6,'UTC') AS created_at,toUInt8(1) AS event_type,pv AS views
    FROM warehouse_analysis_visit_hour_v1
    WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND _control={ar_control:String}
      AND (_hour,_build) IN arrayZip({ar_browser_hours:Array(Int64)},{ar_browser_builds:Array(UUID)})
      AND _hour>=${first} AND _hour<${last} AND pv>0
    ${
      edge
        ? `UNION ALL SELECT website_id,session_id,created_at,event_type,toUInt64(1) AS views FROM ${flat}
      WHERE event_type NOT IN(2,5) AND (created_at<fromUnixTimestamp64Milli(${first * 1000}) OR created_at>=fromUnixTimestamp64Milli(${last * 1000}))`
        : ''
    })`;
}
