import { analysisWindowRelation, currentAnalysisRead } from '../warehouse/analysis-context';
import { analyticsEventRelation } from '../warehouse/reporting-relations';
import { warehouseTime } from '../warehouse/fact-input';
import { warehouseReportQuery } from './warehouse-report-snapshot';

/** Visit fragments are merged by session AND visit before window ratios or
 * duration. Exact visitor states merge across hours, never sum hourly UV. */
export async function analysisVisitTotals(site: string, start: Date, end: Date, halfOpen = false) {
  const model = currentAnalysisRead();
  if (!model) return;
  const first = Math.ceil(+start / 3600000) * 3600,
    last = Math.floor((+end + (halfOpen ? 0 : 1)) / 3600000) * 3600;
  const byHour = new Map(model.browser.map(b => [b[0], b]));
  const hours: number[] = [];
  for (let h = first; h < last; h += 3600) {
    if (!byHour.has(h)) return;
    hours.push(h);
  }
  if (!hours.length) return;
  // Whole-hour windows have no edge rows. Do not initialize canonical joins for
  // an empty UNION branch; partial hours use the same verified flat model when available.
  const edge = +start !== first * 1000 || +end !== last * 1000 - (halfOpen ? 0 : 1);
  const edgeColumns = ['session_id', 'visit_id', 'event_type', 'created_at'];
  const edgeSource = edge
    ? (analysisWindowRelation(
        'browser',
        edgeColumns,
        { start: +start, end: +end, endExclusive: halfOpen },
        true,
      ) ?? analyticsEventRelation())
    : undefined;
  const rows = await warehouseReportQuery<any>(
    site,
    `WITH fragments AS (
    SELECT session_id,visit_id,pv,custom,first_pv,last_pv,visitors FROM warehouse_analysis_visit_hour_v1
      WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND _control={ar_control:String}
      AND (_hour,_build) IN arrayZip({visitHours:Array(Int64)},{visitBuilds:Array(UUID)})
    ${
      edge
        ? `UNION ALL SELECT session_id,visit_id,countIf(event_type NOT IN(2,5)) AS pv,countIf(event_type=2) AS custom,
      minOrNullIf(created_at,event_type NOT IN(2,5)) AS first_pv,maxOrNullIf(created_at,event_type NOT IN(2,5)) AS last_pv,uniqExactState(session_id) AS visitors
      FROM ${edgeSource} WHERE created_at>={start:DateTime64(6,'UTC')} AND created_at${halfOpen ? '<' : '<='}{end:DateTime64(6,'UTC')}
      AND toInt64(toUnixTimestamp(toStartOfHour(created_at))) NOT IN {visitHours:Array(Int64)} GROUP BY session_id,visit_id`
        : ''
    }
  ), visits AS (
    SELECT session_id,visit_id,sum(pv) AS views,sum(custom) AS customs,min(first_pv) AS first,max(last_pv) AS last,uniqExactMergeState(visitors) AS identities
      FROM fragments GROUP BY session_id,visit_id HAVING views>0
  ) SELECT sum(views) AS pageviews,uniqExactMerge(identities) AS visitors,count() AS visits,
      countIf(views=1 AND customs=0) AS bounces,coalesce(sum((toUnixTimestamp64Micro(last)-toUnixTimestamp64Micro(first))/1000000.0),0) AS totaltime FROM visits`,
    {
      start: warehouseTime(start),
      end: warehouseTime(end),
      visitHours: hours,
      visitBuilds: hours.map(h => byHour.get(h)[1]),
    },
  );
  return rows[0];
}
