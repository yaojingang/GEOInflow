import { createHash, randomUUID } from 'node:crypto';
import { formatInTimeZone } from 'date-fns-tz';
import type { CrawlerMetricOptions } from '../contracts/crawler-metrics';
import { CRAWLER_POPULATION_VERSION } from '../rules/population';
import { warehouseTime } from '../warehouse/fact-input';
import { warehouseReader } from '../warehouse/reader-runtime';
import { dashboardClock } from './dashboard-clock';
import {
  warehouseReportMetadata,
  warehouseReportQuery,
  warehouseReportSignal,
} from './warehouse-report-snapshot';

export type LogTrendRow = {
  day: string;
  bot: string;
  type: string;
  count: number;
  aiRequests: number;
};
type HourRow = Omit<LogTrendRow, 'day'> & { hour: number };
type TrendCount = Omit<HourRow, 'hour'>;
type Bucket = [hour: number, build: string];
type Checkpoint = { publication: string; payload: string };
type Load = {
  hours: (hours: number[]) => Promise<HourRow[]>;
  edge: (start: Date, end: Date, endExclusive: boolean) => Promise<LogTrendRow[]>;
};

const hourMs = 3600000;
const hourSeconds = 3600;
const maxHours = 32 * 24;
const table = 'warehouse_log_hourly_trend';
const scope = `website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND control={trendControl:String}`;
const publicationScope = 'website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64}';
const trendFamilies = "('liekan_log','liekan_crawler_evidence','liekan_history_repair_result')";

async function invalidateChangedHours(
  site: string,
  previous: string,
  buckets: Map<number, string>,
) {
  if (!buckets.size) return;
  const since = 'publication > {trendPrevious:UInt64} AND publication <= {wh_publication:UInt64}';
  const [change] = await warehouseReportQuery<{ families: string[] }>(
    site,
    `SELECT groupUniqArray(family) AS families FROM warehouse_publication
     WHERE ${publicationScope} AND ${since} AND family IN ${trendFamilies}`,
    { trendPrevious: previous },
  );
  if (!change.families.length) return;
  // New facts in the active repair run can change the reporting relation even
  // without a new repair generation. In this rarer case rebuild on demand.
  if (change.families.includes('liekan_history_repair_result')) {
    buckets.clear();
    return;
  }
  const attempts = (family: string) => `SELECT attempt_id FROM warehouse_publication
    WHERE ${publicationScope} AND ${since} AND family='${family}'`;
  const rawScope = '_website_id={wh_site:UUID} AND _epoch={wh_epoch:UInt64}';
  const evidence = change.families.includes('liekan_crawler_evidence')
    ? ` OR id IN (SELECT log_id FROM warehouse_liekan_crawler_evidence
      WHERE ${rawScope} AND _attempt_id IN (${attempts('liekan_crawler_evidence')}))`
    : '';
  const changed = await warehouseReportQuery<{ hour: number }>(
    site,
    `SELECT DISTINCT toUnixTimestamp(toStartOfHour(_record_time)) AS hour
     FROM warehouse_liekan_log
     PREWHERE ${rawScope} AND toDate32(_record_time) BETWEEN toDate32({trendFirst:DateTime64(6,'UTC')}) AND toDate32({trendEnd:DateTime64(6,'UTC')})
     WHERE _record_time >= {trendFirst:DateTime64(6,'UTC')} AND _record_time < {trendEnd:DateTime64(6,'UTC')}
       AND (_attempt_id IN (${attempts('liekan_log')})${evidence})`,
    {
      trendPrevious: previous,
      trendFirst: warehouseTime(new Date(Math.min(...buckets.keys()) * 1000)),
      trendEnd: warehouseTime(new Date((Math.max(...buckets.keys()) + hourSeconds) * 1000)),
    },
  );
  // Use all raw versions of the changed attempts for invalidation. Accepted
  // candidates are retained; unused versions can only over-invalidate.
  for (const { hour } of changed) buckets.delete(hour);
}

/** Only scheduled overviews write these disposable summaries, under their
 * existing worker lock. A manifest written after its rows commits coverage.
 * The authoritative query continues to handle the exact partial edges. */
export async function readWarehouseLogTrend(
  site: string,
  start: Date,
  end: Date,
  timezone: string,
  hourly: boolean,
  metrics: CrawlerMetricOptions,
  load: Load,
): Promise<LogTrendRow[] | undefined> {
  const first = Math.ceil(+start / hourMs) * hourMs;
  const last = Math.floor(+end / hourMs) * hourMs;
  const size = (last - first) / hourMs;
  if (first <= 0 || last / 1000 > 0xffffffff || size <= 0 || size > maxHours) return;
  const requested = Array.from({ length: size }, (_, i) => (first + i * hourMs) / 1000);
  const dateFormat = hourly ? 'yyyy-MM-dd HH:00' : 'yyyy-MM-dd';
  const labels = new Map<number, string>();
  for (const hour of requested) {
    const label = formatInTimeZone(hour * 1000, timezone, dateFormat);
    // A UTC hour can straddle a displayed hour/day in fractional-offset zones.
    if (label !== formatInTimeZone((hour + hourSeconds) * 1000 - 1, timezone, dateFormat)) return;
    labels.set(hour, label);
  }

  const metadata = await warehouseReportMetadata(site);
  const { publication, deletionRevision, epoch } = metadata.boundary;
  const trendControl = createHash('sha256')
    .update(
      JSON.stringify([
        CRAWLER_POPULATION_VERSION,
        metrics.crawlerIdentityScope,
        metrics.crawlerMetricsVersion,
        deletionRevision,
        metadata.controlRevision,
        metadata.intervals,
        metadata.repairRunId,
        metadata.repairGeneration,
      ]),
    )
    .digest('hex');
  const [previous] = await warehouseReportQuery<Checkpoint>(
    site,
    `SELECT toString(t.publication) AS publication,payload FROM ${table} t
     WHERE ${scope} AND hour=0 AND t.publication <= {wh_publication:UInt64}
     ORDER BY t.publication DESC,recorded_at DESC,build DESC LIMIT 1`,
    { trendControl },
  );
  const keepFrom = last / 1000 - maxHours * hourSeconds;
  const saved = new Map<number, string>(
    previous ? (JSON.parse(previous.payload) as Bucket[]).filter(([hour]) => hour >= keepFrom) : [],
  );
  if (previous && previous.publication !== publication)
    await invalidateChangedHours(site, previous.publication, saved);

  const keys = requested.filter(hour => saved.has(hour));
  const rows = keys.length
    ? await warehouseReportQuery<{ hour: number; payload: string }>(
        site,
        `SELECT hour,payload FROM ${table} WHERE ${scope}
         AND (hour,build) IN arrayZip({trendHours:Array(UInt32)},{trendBuilds:Array(UUID)})`,
        { trendControl, trendHours: keys, trendBuilds: keys.map(hour => saved.get(hour)) },
      )
    : [];
  const counts = new Map(rows.map(row => [row.hour, JSON.parse(row.payload) as TrendCount[]]));
  const missing = new Set(requested.filter(hour => !counts.has(hour)));
  if (dashboardClock()?.scheduledOverview === 'first' && missing.size > 1) return;
  if (missing.size) {
    for (const hour of missing) counts.set(hour, []);
    for (const { hour, ...count } of await load.hours([...missing])) {
      const bucket = counts.get(hour);
      if (!bucket || !missing.has(hour)) throw new Error('warehouse-trend-hour-outside-build');
      bucket.push(count);
    }
  }

  const combined = new Map<string, LogTrendRow>();
  const add = (row: LogTrendRow) => {
    const key = JSON.stringify([row.day, row.bot, row.type]);
    const old = combined.get(key);
    if (!old) {
      combined.set(key, row);
      return;
    }
    old.count += row.count;
    old.aiRequests += row.aiRequests;
    if (!Number.isSafeInteger(old.count) || !Number.isSafeInteger(old.aiRequests))
      throw new Error('warehouse-counter-out-of-range');
  };
  for (const hour of requested)
    for (const count of counts.get(hour)) add({ ...count, day: labels.get(hour) });
  const endExclusive = metrics.crawlerMetricsVersion === 1;
  if (+start < first) for (const row of await load.edge(start, new Date(first), true)) add(row);
  if (+end > last || !endExclusive)
    for (const row of await load.edge(new Date(last), end, endExclusive)) add(row);

  if (missing.size || previous?.publication !== publication) {
    const ch = warehouseReader().ch;
    const signal = warehouseReportSignal();
    const build = randomUUID();
    const base = { website_id: site, epoch, control: trendControl, build, publication };
    if (missing.size) {
      await ch.insert({
        table,
        values: [...missing].map(hour => ({
          ...base,
          hour,
          payload: JSON.stringify(counts.get(hour)),
        })),
        format: 'JSONEachRow',
        abort_signal: signal,
      });
      for (const hour of missing) saved.set(hour, build);
    }
    signal?.throwIfAborted();
    await ch.insert({
      table,
      values: [{ ...base, hour: 0, payload: JSON.stringify([...saved]) }],
      format: 'JSONEachRow',
      abort_signal: signal,
    });
  }
  return [...combined.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
