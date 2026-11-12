import { createHash, randomUUID } from 'node:crypto';
import { formatInTimeZone } from 'date-fns-tz';
import { calendarDateRange, calendarDayRange } from '../contracts/calendar';
import type { ReportQuery } from '../contracts/query';
import { CRAWLER_POPULATION_VERSION } from '../rules/population';
import { warehouseTime } from '../warehouse/fact-input';
import { warehouseOverviewLogCoverage, warehouseOverviewLogDays } from '../warehouse/schema';
import { analysisErrorReason, timeReportQuery } from './analysis-diagnostics';
import { dashboardClock } from './dashboard-clock';
import {
  renderWarehouseOverviewAggregate,
  warehouseOverviewAggregateStates,
  warehouseOverviewLogWindow,
} from './warehouse-log-queries';
import {
  warehouseControlFingerprint,
  warehouseReportCommand,
  warehouseReportMetadata,
  warehouseReportQuery,
  warehouseReportSignal,
} from './warehouse-report-snapshot';

const maxDays = 32;
const buildBatchDays = 5;
const columns = `section,name,vendor,type,botId,path,requests,ai,pages,abnormal,
  classificationVersions,legacyRequests,unclassifiedRequests,lastTime`;
const scope =
  'website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND control={overviewControl:FixedString(64)}';
const publicationScope = 'website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64}';
const since = 'publication>{overviewPrevious:UInt64} AND publication<={wh_publication:UInt64}';
const dayKey = (time: number, timezone: string) => formatInTimeZone(time, timezone, 'yyyy-MM-dd');
const dateKey = /^\d{4}-\d{2}-\d{2}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
type Day = { key: string; start: number; next: number };

function completeDays(start: Date, end: Date, timezone: string) {
  if (+start !== calendarDayRange(+start, timezone).startAt) return [];
  const days: Day[] = [];
  for (let at = +start; at < +end && days.length <= maxDays; ) {
    const key = dayKey(at, timezone);
    const next = calendarDateRange(key, timezone).endAt + 1;
    if (next <= at) return [];
    if (next > +end) break;
    days.push({ key, start: at, next });
    at = next;
  }
  return days.length <= maxDays ? days : [];
}

function coverageEntries(payload: string): [string, string][] {
  const rows: unknown = JSON.parse(payload);
  if (
    !Array.isArray(rows) ||
    rows.length > maxDays ||
    rows.some(
      row =>
        !Array.isArray(row) ||
        row.length !== 2 ||
        typeof row[0] !== 'string' ||
        !dateKey.test(row[0]) ||
        typeof row[1] !== 'string' ||
        !uuid.test(row[1]),
    )
  )
    throw new Error('warehouse-overview-coverage-invalid');
  return rows;
}

async function invalidateDays(
  site: string,
  timezone: string,
  previous: string,
  days: Map<string, string>,
) {
  if (!days.size) return;
  const [changed] = await warehouseReportQuery<{ families: string[] }>(
    site,
    `SELECT groupUniqArray(family) AS families FROM warehouse_publication
     WHERE ${publicationScope} AND ${since}
       AND family IN ('liekan_log','liekan_crawler_evidence','liekan_history_repair_result')`,
    { overviewPrevious: previous },
  );
  if (!changed.families.length) return;
  if (changed.families.includes('liekan_history_repair_result')) {
    days.clear();
    return;
  }
  const keys = [...days.keys()].sort();
  const attempts = (family: 'liekan_log' | 'liekan_crawler_evidence') =>
    `SELECT attempt_id FROM warehouse_publication WHERE ${publicationScope}
     AND ${since} AND family='${family}'`;
  const raw = '_website_id={wh_site:UUID} AND _epoch={wh_epoch:UInt64}';
  const evidence = changed.families.includes('liekan_crawler_evidence')
    ? `OR id IN (SELECT log_id FROM warehouse_liekan_crawler_evidence
       WHERE ${raw} AND _attempt_id IN (${attempts('liekan_crawler_evidence')}))`
    : '';
  const dirty = await warehouseReportQuery<{ day: string }>(
    site,
    `SELECT DISTINCT toString(toDate32(_record_time,{overviewTimezone:String})) AS day
     FROM warehouse_liekan_log PREWHERE ${raw}
       AND toDate32(_record_time) BETWEEN toDate32({overviewFirst:DateTime64(6,'UTC')})
         AND toDate32({overviewEnd:DateTime64(6,'UTC')})
     WHERE _record_time >= {overviewFirst:DateTime64(6,'UTC')}
       AND _record_time < {overviewEnd:DateTime64(6,'UTC')}
       AND (_attempt_id IN (${attempts('liekan_log')}) ${evidence})`,
    {
      overviewPrevious: previous,
      overviewTimezone: timezone,
      overviewFirst: warehouseTime(new Date(calendarDateRange(keys[0], timezone).startAt)),
      overviewEnd: warehouseTime(new Date(calendarDateRange(keys.at(-1), timezone).endAt + 1)),
    },
  );
  for (const { day } of dirty) days.delete(day);
}

/** Called only by the scheduled overview worker, under its computation lock. */
export async function prepareWarehouseOverviewLogSegments(
  site: string,
  start: Date,
  end: Date,
  metrics: ReportQuery,
  backfill = false,
) {
  const scheduledOverview = dashboardClock()?.scheduledOverview;
  if (!scheduledOverview || !['7d', '30d'].includes(metrics.chartPeriod)) return;
  const { timezone } = metrics;
  const days = completeDays(start, end, timezone);
  if (!days.length) return;
  try {
    const metadata = await warehouseReportMetadata(site);
    const { publication } = metadata.boundary;
    const overviewControl = createHash('sha256')
      .update(
        JSON.stringify([
          1,
          warehouseControlFingerprint(metadata),
          CRAWLER_POPULATION_VERSION,
          timezone,
          metrics.crawlerIdentityScope,
          metrics.crawlerMetricsVersion,
        ]),
      )
      .digest('hex');
    const [checkpoint] = await warehouseReportQuery<{ publication: string; payload: string }>(
      site,
      `SELECT toString(c.publication) AS publication,payload
       FROM ${warehouseOverviewLogCoverage} c WHERE ${scope} AND c.publication<={wh_publication:UInt64}
       ORDER BY c.publication DESC,recorded_at DESC,checkpoint DESC LIMIT 1`,
      { overviewControl },
    );
    const requested = new Set(days.map(day => day.key));
    const keepAfter = dayKey(+end - maxDays * 86400000, timezone);
    const saved = new Map(
      checkpoint
        ? coverageEntries(checkpoint.payload).filter(
            ([key]) => key > keepAfter || requested.has(key),
          )
        : [],
    );
    if (checkpoint && checkpoint.publication !== publication)
      await invalidateDays(site, timezone, checkpoint.publication, saved);
    const missing = days.filter(day => !saved.has(day.key));
    if (!backfill && scheduledOverview === 'first' && missing.length > 1) return;
    let buildDays = missing;
    if (backfill && missing.length) {
      const firstMissing = days.indexOf(missing[0]);
      const batchEnd = days[Math.min(firstMissing + buildBatchDays, days.length) - 1].next;
      buildDays = missing.filter(day => day.start < batchEnd);
    }
    // A long build plus a raw fallback can exhaust the scheduled report's
    // deadline. The idle worker fills this coverage in bounded batches.
    if (
      !backfill &&
      missing.length &&
      (missing.length > 7 || missing.at(-1).next - missing[0].start > 8 * 86400000)
    )
      return;
    if (buildDays.length) {
      await timeReportQuery('overview-log-day-build', async () => {
        const build = randomUUID();
        const from = new Date(buildDays[0].start);
        const to = new Date(buildDays.at(-1).next);
        const window = await warehouseOverviewLogWindow(site, from, to, true);
        if (window.hasFacts) {
          const states = warehouseOverviewAggregateStates(
            from,
            to,
            timezone,
            metrics,
            window.restrictEvidenceToWindow,
            buildDays.map(day => day.key),
          );
          await warehouseReportCommand(
            site,
            `INSERT INTO ${warehouseOverviewLogDays} (website_id,epoch,control,build,day,${columns})
             SELECT {wh_site:UUID},{wh_epoch:UInt64},{overviewControl:FixedString(64)},
               {overviewBuild:UUID},day,${columns} FROM (${states.sql})
             SETTINGS optimize_aggregation_in_order=1`,
            { ...states.params, overviewControl, overviewBuild: build },
            28,
          );
        }
        for (const { key } of buildDays) saved.set(key, build);
      });
    }
    if (buildDays.length || checkpoint?.publication !== publication) {
      // A failed or interrupted insert leaves its random build unreachable.
      // Empty days also appear in the checkpoint and require no state rows.
      await warehouseReportCommand(
        site,
        `INSERT INTO ${warehouseOverviewLogCoverage} (website_id,epoch,control,publication,checkpoint,payload)
         SELECT {wh_site:UUID},{wh_epoch:UInt64},{overviewControl:FixedString(64)},
           {wh_publication:UInt64},{overviewCheckpoint:UUID},{overviewCoverage:String}`,
        {
          overviewControl,
          overviewCheckpoint: randomUUID(),
          overviewCoverage: JSON.stringify([...saved].sort().slice(-maxDays)),
        },
        5,
      );
    }
    if (backfill) return;
    const edgeStart = new Date(days.at(-1).next);
    const edgeWindow = await warehouseOverviewLogWindow(
      site,
      edgeStart,
      end,
      metrics.crawlerMetricsVersion === 1,
    );
    const edge = edgeWindow.hasFacts
      ? warehouseOverviewAggregateStates(
          edgeStart,
          end,
          timezone,
          metrics,
          edgeWindow.restrictEvidenceToWindow,
        )
      : undefined;
    // Keep a zero summary even when every covered day was empty. Once the raw
    // probe proves the edge is empty, its joins cannot contribute to the result.
    const edgeSql =
      edge?.sql ??
      `SELECT 'summary',NULL,NULL,NULL,NULL,NULL,toUInt64(0),toUInt64(0),
        arrayReduce('uniqExactState',CAST([], 'Array(String)')),toUInt64(0),
        arrayReduce('uniqExactState',CAST([], 'Array(String)')),toUInt64(0),toUInt64(0),NULL`;
    return {
      params: {
        ...edge?.params,
        overviewControl,
        overviewFirstDay: days[0].key,
        overviewLastDay: days.at(-1).key,
        overviewDays: days.map(day => day.key),
        overviewBuilds: days.map(day => saved.get(day.key)),
      },
      sql: renderWarehouseOverviewAggregate(`
        SELECT section,name,vendor,type,botId,path,sum(requests) AS requests,sum(ai) AS ai,
          uniqExactMerge(pages) AS pages,sum(abnormal) AS abnormal,
          uniqExactMerge(classificationVersions) AS classificationVersions,
          sum(legacyRequests) AS legacyRequests,sum(unclassifiedRequests) AS unclassifiedRequests,
          max(lastTime) AS lastTime
        FROM (
          SELECT ${columns} FROM ${warehouseOverviewLogDays} WHERE ${scope}
            AND day BETWEEN {overviewFirstDay:Date32} AND {overviewLastDay:Date32}
            AND (day,build) IN arrayZip({overviewDays:Array(Date32)},{overviewBuilds:Array(UUID)})
          UNION ALL ${edgeSql}
        ) GROUP BY section,name,vendor,type,botId,path`),
    };
  } catch (error) {
    warehouseReportSignal()?.throwIfAborted();
    console.info(
      JSON.stringify({
        event: 'warehouse-overview-log-segments-deferred',
        reason: analysisErrorReason(error),
      }),
    );
    return;
  }
}
