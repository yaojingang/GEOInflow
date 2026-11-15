import { createHash, randomUUID } from 'node:crypto';
import {
  type AnalysisBucket,
  type AnalysisKind,
  type AnalysisRead,
  currentAnalysisRead,
  withAnalysisRead,
  withoutAnalysisRead,
} from '../warehouse/analysis-context';
import { factTable, identifier } from '../warehouse/catalog';
import { warehouseTime } from '../warehouse/fact-input';
import { factRelation } from '../warehouse/read';
import {
  geographicEventRelation,
  repairedQualityRelation,
  reportingLogRelation,
  websiteEventRelation,
} from '../warehouse/reporting-relations';
import {
  analysisBrowserFields,
  analysisLogFields,
  analysisVisitEntryFields,
} from '../warehouse/schema';
import {
  forgetWarehouseReportMemo,
  memoWarehouseReport,
  warehouseControlFingerprint,
  warehouseReportCommand,
  warehouseReportMetadata,
  warehouseReportQuery,
  warehouseReportSignal,
  withinWarehouseReport,
} from './warehouse-report-snapshot';
import { memoRoundMetric } from './warehouse-round-metrics';

export const analysisModelVersion = 'analysis-model-v2';
export const analysisModelDays = 64;
const hour = 3600;
const sourceFamilies = {
  browser: [
    'website_event',
    'session',
    'liekan_event_environment',
    'liekan_event_quality',
    'liekan_event_geography',
    'liekan_traffic_exclusion_member',
    'liekan_history_repair_result',
  ],
  log: ['liekan_log', 'liekan_crawler_evidence', 'liekan_history_repair_result'],
} as const;
const fields = (kind: AnalysisKind) => [
  ...factTable(kind === 'browser' ? 'website_event' : 'liekan_log').columns.map(c => c.name),
  ...(kind === 'browser' ? analysisBrowserFields : analysisLogFields).map(c => c[0]),
];
const scope = 'website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64}';
const rawScope = '_website_id={wh_site:UUID} AND _epoch={wh_epoch:UInt64}';
const bucketScope =
  'website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND _control={modelControl:String}';
type Checkpoint = {
  publication: string;
  browser_publication: string;
  log_publication: string;
  browser: string;
  log: string;
};
function parseBuckets(value: string | undefined): AnalysisBucket[] {
  if (!value) return [];
  const rows = JSON.parse(value);
  if (
    !Array.isArray(rows) ||
    rows.length > analysisModelDays * 24 ||
    rows.some(
      b =>
        !Array.isArray(b) ||
        b.length !== 4 ||
        !Number.isSafeInteger(b[0]) ||
        b[0] % hour ||
        !/^[-a-f0-9]{36}$/.test(b[1]) ||
        !Number.isSafeInteger(b[2]) ||
        b[2] < 0 ||
        !Number.isSafeInteger(b[3]) ||
        b[3] < 0,
    )
  )
    throw new Error('warehouse-analysis-coverage-invalid');
  if (new Set(rows.map(b => b[0])).size !== rows.length)
    throw new Error('warehouse-analysis-coverage-duplicate');
  return rows;
}
export function analysisSource(kind: AnalysisKind) {
  return withoutAnalysisRead(() => {
    const immutableTimeWindow = {
      start: 'modelStart',
      end: 'modelEnd',
      endExclusive: true,
      hours: 'modelWindowHours',
    };
    if (kind === 'log') return reportingLogRelation({ immutableTimeWindow });
    const cols = factTable('website_event')
      .columns.map(c => `e.${identifier(c.name)} AS ${identifier(c.name)}`)
      .join(',');
    return `(WITH report_visit_keys AS (
      SELECT DISTINCT session_id,visit_id FROM ${factRelation('website_event', {
        columns: ['website_id', 'event_id', 'session_id', 'visit_id', 'created_at'],
        immutableTimeWindow,
      })}
    ) SELECT ${cols},${analysisBrowserFields
      .filter(c => !c[0].startsWith('_'))
      .map(c => `g.${identifier(c[0])} AS ${identifier(c[0])}`)
      .join(',')},
      ${analysisVisitEntryFields.map(c => `g._entry_${c} AS _entry_${c}`).join(',')},
      isNotNull(g.event_id) AS _qualified,
      coalesce(e.event_type IN(3,4) OR (env.scope='browser' AND env.identity_available AND q.classification='browser'),false) AS _qualified_event,
      env.identity_version AS _identity_version,q.rule_version AS _rule_version,toString(q.catalog_version) AS _catalog_version
      FROM (SELECT * FROM ${websiteEventRelation('observed')}
        WHERE toInt64(toUnixTimestamp(toStartOfHour(created_at))) IN {modelHours:Array(Int64)}) e
      LEFT JOIN ${geographicEventRelation(true, true)} g ON e.website_id=g.website_id AND e.event_id=g.event_id
      LEFT JOIN ${factRelation('liekan_event_environment')} env ON env.website_id=e.website_id AND env.event_id=e.event_id
      LEFT JOIN ${repairedQualityRelation()} q ON q.website_id=e.website_id AND q.event_id=e.event_id)`;
  });
}
async function changedHours(
  site: string,
  kind: AnalysisKind,
  previous: string,
  buckets: AnalysisBucket[],
) {
  if (!buckets.length) return new Set<number>();
  const since = 'publication>{modelPrevious:UInt64} AND publication<={wh_publication:UInt64}';
  const changes = await warehouseReportQuery<{ family: string }>(
    site,
    `SELECT DISTINCT family FROM warehouse_publication WHERE ${scope} AND ${since} AND family IN {modelFamilies:Array(String)}`,
    { modelPrevious: previous, modelFamilies: sourceFamilies[kind] },
  );
  const names = new Set(changes.map(c => c.family));
  if (!names.size) return new Set<number>();
  const attempts = (f: string) =>
    `SELECT attempt_id FROM warehouse_publication WHERE ${scope} AND ${since} AND family='${f}'`;
  if (names.delete('liekan_history_repair_result')) {
    const metadata = await warehouseReportMetadata(site);
    if (metadata.repairRunId && metadata.repairGeneration) {
      const active = await warehouseReportQuery(
        site,
        `SELECT 1 FROM warehouse_liekan_history_repair_result WHERE ${rawScope}
          AND run_id={wh_repair_run:UUID} AND generation={wh_repair_generation:UUID}
          AND kind={modelRepairKind:String} AND _attempt_id IN (${attempts('liekan_history_repair_result')}) LIMIT 1`,
        { modelPrevious: previous, modelRepairKind: kind === 'browser' ? 'event' : 'log' },
      );
      if (active.length) return new Set(buckets.map(b => b[0]));
    }
    // An accepted preview is still inactive. Only activation changes the control
    // fingerprint; unrelated candidate writes do not dirty all covered hours.
    if (!names.size) return new Set<number>();
  }
  let sql: string;
  if (kind === 'log') {
    sql = `SELECT DISTINCT toInt64(toUnixTimestamp(toStartOfHour(_record_time))) AS hour FROM warehouse_liekan_log
      WHERE ${rawScope} AND (_attempt_id IN (${attempts('liekan_log')}) ${names.has('liekan_crawler_evidence') ? `OR id IN (SELECT log_id FROM warehouse_liekan_crawler_evidence WHERE ${rawScope} AND _attempt_id IN (${attempts('liekan_crawler_evidence')}))` : ''})`;
  } else {
    const eventSources = [
      'liekan_event_quality',
      'liekan_event_environment',
      'liekan_event_geography',
      'liekan_traffic_exclusion_member',
    ].filter(f => names.has(f));
    const changedEvents = eventSources
      .map(
        f =>
          `SELECT event_id FROM warehouse_${f} WHERE ${rawScope} AND _attempt_id IN (${attempts(f)})`,
      )
      .join(' UNION ALL ');
    // All versions of a changed key contribute invalidation. A moved event or
    // earlier anchor rebuilds BOTH visits and every affected hour, not just arrival hour.
    sql = `WITH changed_visits AS (SELECT DISTINCT session_id,visit_id FROM warehouse_website_event
      WHERE ${rawScope} AND (_attempt_id IN (${attempts('website_event')})
        ${changedEvents ? `OR event_id IN (${changedEvents})` : ''}
        ${names.has('session') ? `OR session_id IN (SELECT session_id FROM warehouse_session WHERE ${rawScope} AND _attempt_id IN (${attempts('session')}))` : ''}))
      SELECT DISTINCT toInt64(toUnixTimestamp(toStartOfHour(_record_time))) AS hour FROM warehouse_website_event
      WHERE ${rawScope} AND (session_id,visit_id) IN changed_visits`;
  }
  const rows = await warehouseReportQuery<{ hour: string }>(site, sql, { modelPrevious: previous });
  return new Set(rows.map(r => Number(r.hour)));
}
type AnalysisSelection = {
  kinds?: AnalysisKind[];
  start?: number;
  end?: number;
  preserveOther?: boolean;
};
async function loadModel(site: string, selection?: AnalysisSelection) {
  const metadata = await warehouseReportMetadata(site);
  const control = createHash('sha256')
    .update(JSON.stringify([analysisModelVersion, warehouseControlFingerprint(metadata)]))
    .digest('hex');
  const [checkpoint] = await warehouseReportQuery<Checkpoint>(
    site,
    `SELECT toString(c.publication) AS publication,toString(c.browser_publication) AS browser_publication,toString(c.log_publication) AS log_publication,browser,log FROM warehouse_analysis_coverage_v1 c WHERE ${scope} AND control={modelControl:String} AND c.publication<={wh_publication:UInt64} ORDER BY c.publication DESC,recorded_at DESC,checkpoint DESC LIMIT 1`,
    { modelControl: control },
  );
  const result: AnalysisRead = {
    site,
    control,
    publication: {
      browser: checkpoint?.browser_publication ?? '0',
      log: checkpoint?.log_publication ?? '0',
    },
    browser: parseBuckets(checkpoint?.browser),
    log: parseBuckets(checkpoint?.log),
  };
  for (const kind of ['browser', 'log'] as const) {
    if (selection?.kinds && !selection.kinds.includes(kind)) {
      if (!selection.preserveOther) result[kind] = [];
      continue;
    }
    // Request-time integrity checks only cover buckets that this request can
    // use. Cross-window anchors still come from the authoritative fallback.
    if (Number.isFinite(selection?.start) && Number.isFinite(selection?.end))
      result[kind] = result[kind].filter(
        b => (b[0] + hour) * 1000 > selection.start && b[0] * 1000 <= selection.end,
      );
    const dirty =
      checkpoint && result.publication[kind] !== metadata.boundary.publication
        ? await changedHours(site, kind, result.publication[kind], result[kind])
        : new Set<number>();
    result[kind] = result[kind].filter(b => !dirty.has(b[0]));
    if (result[kind].length) {
      const counts = await warehouseReportQuery<{ hour: string; build: string; rows: string }>(
        site,
        `SELECT _hour AS hour,toString(_build) AS build,count() AS rows FROM warehouse_analysis_${kind}_v1 WHERE ${bucketScope} AND (_hour,_build) IN arrayZip({modelHours:Array(Int64)},{modelBuilds:Array(UUID)}) GROUP BY _hour,_build`,
        {
          modelControl: control,
          modelHours: result[kind].map(b => b[0]),
          modelBuilds: result[kind].map(b => b[1]),
        },
      );
      const found = new Map(counts.map(c => [`${c.hour}:${c.build}`, Number(c.rows)]));
      // Missing nonempty data is absent coverage, never a zero-valued report.
      result[kind] = result[kind].filter(b => (found.get(`${b[0]}:${b[1]}`) ?? 0) === b[2]);
      if (kind === 'browser' && result.browser.length) {
        const visits = await warehouseReportQuery<{ hour: string; build: string; rows: string }>(
          site,
          `SELECT _hour AS hour,toString(_build) AS build,count() AS rows FROM warehouse_analysis_visit_hour_v1 WHERE ${bucketScope} AND (_hour,_build) IN arrayZip({modelHours:Array(Int64)},{modelBuilds:Array(UUID)}) GROUP BY _hour,_build`,
          {
            modelControl: control,
            modelHours: result.browser.map(b => b[0]),
            modelBuilds: result.browser.map(b => b[1]),
          },
        );
        const counts = new Map(visits.map(c => [`${c.hour}:${c.build}`, Number(c.rows)]));
        result.browser = result.browser.filter(b => (counts.get(`${b[0]}:${b[1]}`) ?? 0) === b[3]);
      }
    }
    result.publication[kind] = metadata.boundary.publication;
  }
  return result;
}
function analysisEnabled(site: string) {
  const allowed = process.env.LIEKAN_WAREHOUSE_ANALYSIS_SITES?.split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return (
    process.env.LIEKAN_WAREHOUSE_ANALYSIS_READS !== '0' &&
    (!allowed?.length || allowed.includes(site))
  );
}
export async function withAvailableAnalysisModel<T>(
  site: string,
  work: () => Promise<T>,
  selection?: AnalysisSelection,
) {
  if (!analysisEnabled(site) || currentAnalysisRead()?.site === site) return work();
  return withinWarehouseReport(async () =>
    withVerifiedAnalysisRead(
      await memoWarehouseReport(`analysis-model:${site}:${JSON.stringify(selection ?? {})}`, () =>
        loadModel(site, selection),
      ),
      work,
      selection,
    ),
  );
}

/** Omit raw joins only when *every* physical source timestamp is covered.
 * This deliberately checks all versions/candidates, a superset of the pinned
 * accepted facts. Older anchors, null times and uncovered moved versions retain
 * fallback. Fact versions are not publication numbers and cannot bound this probe.
 * The existing read reference and family watermark keep the model valid; append
 * after this fixed publication cannot add visible rows to the current request.
 */
export async function withVerifiedAnalysisRead<T>(
  value: AnalysisRead | undefined,
  work: () => Promise<T>,
  selection?: AnalysisSelection,
): Promise<T> {
  if (!value) return withAnalysisRead(value, work);
  const metadata = await warehouseReportMetadata(value.site);
  const complete: AnalysisKind[] = [];
  const verified: AnalysisKind[] = [];
  const windows: Partial<Record<AnalysisKind, { start: number; end: number }>> = {};
  for (const kind of ['browser', 'log'] as const) {
    if (!value[kind].length || value.publication?.[kind] !== metadata.boundary.publication)
      continue;
    verified.push(kind);
    const hours = value[kind].map(b => b[0]).sort((a, b) => a - b);
    const key = JSON.stringify([
      'analysis-source-complete',
      value.site,
      value.control,
      metadata.boundary,
      kind,
      createHash('sha256').update(JSON.stringify(hours)).digest('hex'),
    ]);
    // Only the small boolean is shared by tasks in the same protected round.
    // Recovery reuses this proof only within that referenced round; coverage integrity checks remain.
    const covered = await memoWarehouseReport(key, () =>
      memoRoundMetric(key, async () => {
        const missing = await warehouseReportQuery(
          value.site,
          `SELECT 1 FROM warehouse_${kind === 'browser' ? 'website_event' : 'liekan_log'}
        WHERE ${rawScope} AND (isNull(created_at) OR
          toInt64(toUnixTimestamp(toStartOfHour(created_at))) NOT IN {modelCoveredHours:Array(Int64)}) LIMIT 1`,
          { modelCoveredHours: hours },
        );
        return missing.length === 0;
      }),
    );
    if (covered) complete.push(kind);
    const start = selection?.start,
      end = selection?.end;
    if (
      kind === 'browser' &&
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start <= end
    ) {
      const first = Math.floor(start / 3600000) * 3600;
      const last = Math.floor(end / 3600000) * 3600;
      const selected = new Set(hours);
      let gap = (last - first) / hour + 1 > selected.size;
      for (let h = first; !gap && h <= last; h += hour) gap = !selected.has(h);
      if (gap) {
        // An absent physical timestamp in an uncovered hour is a conservative
        // proof for this window only. Scan all candidates/versions: never prune
        // by mutable quality or publication before canonical selection.
        const emptyGap =
          covered ||
          (await memoWarehouseReport(
            JSON.stringify(['analysis-window-complete', key, start, end]),
            async () =>
              (
                await warehouseReportQuery(
                  value.site,
                  `SELECT 1 FROM warehouse_${kind === 'browser' ? 'website_event' : 'liekan_log'}
             WHERE ${rawScope} AND (isNull(created_at) OR (
               created_at>=fromUnixTimestamp64Milli({modelWindowStart:Int64})
               AND created_at<=fromUnixTimestamp64Milli({modelWindowEnd:Int64})
               AND toInt64(toUnixTimestamp(toStartOfHour(created_at)))
                 NOT IN {modelCoveredHours:Array(Int64)})) LIMIT 1`,
                  { modelCoveredHours: hours, modelWindowStart: start, modelWindowEnd: end },
                )
              ).length === 0,
          ));
        if (emptyGap) windows[kind] = { start, end };
      }
    }
  }
  return withAnalysisRead(value, work, complete, verified, windows);
}

/** Only the existing background report lock calls this builder. Each batch writes
 * immutable candidates, verifies them, then publishes coverage. Interrupted or
 * superseded candidates are unreachable; retries get a different build UUID. */
export async function prepareAnalysisModel(
  site: string,
  start: Date,
  end: Date,
  options: {
    kinds?: AnalysisKind[];
    prepared?: AnalysisRead;
    onCheckpoint?: (value: AnalysisRead) => Promise<void>;
  } = {},
) {
  if (!analysisEnabled(site)) return;
  return withinWarehouseReport(() =>
    withoutAnalysisRead(async () => {
      const metadata = await warehouseReportMetadata(site);
      const kinds = options.kinds ?? ['browser', 'log'];
      const control = createHash('sha256')
        .update(JSON.stringify([analysisModelVersion, warehouseControlFingerprint(metadata)]))
        .digest('hex');
      const reusable = options.prepared;
      if (reusable && (reusable.site !== site || reusable.control !== control))
        throw new Error('warehouse-analysis-prepared-boundary');
      if (reusable) {
        // A recovered round is durable state, not a reason to accept malformed
        // coverage or a family watermark beyond its frozen publication.
        for (const kind of ['browser', 'log'] as const) {
          parseBuckets(JSON.stringify(reusable[kind]));
          const publication = reusable.publication?.[kind];
          if (
            !/^\d+$/.test(publication ?? '') ||
            BigInt(publication) > BigInt(metadata.boundary.publication)
          )
            throw new Error('warehouse-analysis-prepared-boundary');
        }
      }
      const result =
        reusable &&
        kinds.every(kind => reusable.publication?.[kind] === metadata.boundary.publication)
          ? structuredClone(reusable)
          : await loadModel(site, { kinds, preserveOther: true });
      const last = Math.ceil(+end / 3600000) * hour;
      const recentEnd = Math.max(last, Math.floor(Date.now() / 3600000) * hour);
      const retentionStart = recentEnd - analysisModelDays * 86400;
      const first = Math.max(Math.floor(+start / 3600000) * hour, retentionStart);
      if (last <= first) return result;
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(last) ||
        last <= first ||
        last - first > analysisModelDays * 86400
      )
        throw new Error('warehouse-analysis-build-range');
      const requested = Array.from({ length: (last - first) / hour }, (_, i) => first + i * hour);
      for (const kind of kinds) {
        result[kind] = result[kind].filter(b => b[0] >= retentionStart && b[0] < recentEnd);
        const have = new Set(result[kind].map(b => b[0]));
        const missing = requested.filter(h => !have.has(h));
        // Physical versions are a superset of the frozen accepted input. A missing
        // hour here proves an empty build without running its canonical joins,
        // INSERT and two checksums. Nonempty candidates still take full verification.
        const physical = missing.length
          ? await warehouseReportQuery<{ hour: string }>(
              site,
              `SELECT DISTINCT toInt64(toUnixTimestamp(toStartOfHour(_record_time))) AS hour
           FROM warehouse_${kind === 'browser' ? 'website_event' : 'liekan_log'}
           WHERE ${rawScope} AND toInt64(toUnixTimestamp(toStartOfHour(_record_time))) IN {modelMissingHours:Array(Int64)}`,
              { modelMissingHours: missing },
            )
          : [];
        const occupied = new Set(physical.map(r => Number(r.hour)));
        for (let offset = 0; offset < missing.length; offset += 128) {
          warehouseReportSignal()?.throwIfAborted();
          const coveredHours = missing.slice(offset, offset + 128),
            hours = coveredHours.filter(h => occupied.has(h)),
            build = randomUUID(),
            columns = fields(kind),
            source = analysisSource(kind);
          const params = {
            modelControl: result.control,
            modelBuild: build,
            modelHours: hours,
            modelWindowHours: hours,
            modelStart: warehouseTime(new Date(coveredHours[0] * 1000)),
            modelEnd: warehouseTime(
              new Date((coveredHours[coveredHours.length - 1] + hour) * 1000),
            ),
          };
          const window = `toInt64(toUnixTimestamp(toStartOfHour(created_at))) IN {modelHours:Array(Int64)}`;
          if (hours.length)
            await warehouseReportCommand(
              site,
              `INSERT INTO warehouse_analysis_${kind}_v1 (${columns.map(identifier).join(',')},epoch,_control,_hour,_build,_publication)
          SELECT ${columns.map(identifier).join(',')},{wh_epoch:UInt64},{modelControl:String},toInt64(toUnixTimestamp(toStartOfHour(created_at))),{modelBuild:UUID},{wh_publication:UInt64}
          FROM ${source} WHERE ${window}`,
              params,
              55,
            );
          const digest = (relation: string, where: string) =>
            `SELECT toInt64(toUnixTimestamp(toStartOfHour(created_at))) AS hour,count() AS rows,toString(sum(cityHash64(tuple(${columns.map(identifier).join(',')})))) AS checksum FROM ${relation} WHERE ${where} GROUP BY hour ORDER BY hour`;
          const expected = hours.length
            ? await warehouseReportQuery<{
                hour: string;
                rows: string;
                checksum: string;
              }>(site, digest(source, window), params)
            : [];
          const actual = hours.length
            ? await warehouseReportQuery<{
                hour: string;
                rows: string;
                checksum: string;
              }>(
                site,
                digest(
                  `warehouse_analysis_${kind}_v1`,
                  `${bucketScope} AND _build={modelBuild:UUID}`,
                ),
                params,
              )
            : [];
          if (JSON.stringify(actual) !== JSON.stringify(expected))
            throw new Error('warehouse-analysis-verification-failed');
          if (kind === 'browser' && hours.length)
            await warehouseReportCommand(
              site,
              `INSERT INTO warehouse_analysis_visit_hour_v1
          (website_id,session_id,visit_id,epoch,_control,_hour,_build,_publication,pv,custom,first_pv,last_pv,visitors)
          SELECT website_id,session_id,visit_id,epoch,_control,_hour,_build,{wh_publication:UInt64},countIf(event_type NOT IN(2,5)),countIf(event_type=2),minOrNullIf(created_at,event_type NOT IN(2,5)),maxOrNullIf(created_at,event_type NOT IN(2,5)),uniqExactState(session_id)
          FROM warehouse_analysis_browser_v1 WHERE ${bucketScope} AND _build={modelBuild:UUID} AND _qualified GROUP BY website_id,session_id,visit_id,epoch,_control,_hour,_build`,
              params,
              55,
            );
          const visitCounts =
            kind === 'browser' && hours.length
              ? await warehouseReportQuery<{ hour: string; rows: string }>(
                  site,
                  `SELECT _hour AS hour,count() AS rows FROM warehouse_analysis_visit_hour_v1 WHERE ${bucketScope} AND _build={modelBuild:UUID} GROUP BY _hour`,
                  params,
                )
              : [];
          const fragments = new Map(visitCounts.map(r => [Number(r.hour), Number(r.rows)]));
          const counts = new Map(actual.map(r => [Number(r.hour), Number(r.rows)]));
          result[kind].push(
            ...coveredHours.map(
              h => [h, build, counts.get(h) ?? 0, fragments.get(h) ?? 0] as AnalysisBucket,
            ),
          );
          result[kind].sort((a, b) => a[0] - b[0]);
          // Publish each verified group so a canceled 64-day build resumes from it.
          await warehouseReportCommand(
            site,
            `INSERT INTO warehouse_analysis_coverage_v1 (website_id,epoch,control,publication,checkpoint,browser,log,browser_publication,log_publication)
          SELECT {wh_site:UUID},{wh_epoch:UInt64},{modelControl:String},{wh_publication:UInt64},{modelCheckpoint:UUID},{modelBrowser:String},{modelLog:String},{modelBrowserPublication:UInt64},{modelLogPublication:UInt64}`,
            {
              modelControl: result.control,
              modelCheckpoint: randomUUID(),
              modelBrowser: JSON.stringify(result.browser),
              modelLog: JSON.stringify(result.log),
              modelBrowserPublication: result.publication.browser,
              modelLogPublication: result.publication.log,
            },
            55,
          );
          await options.onCheckpoint?.(structuredClone(result));
        }
      }
      forgetWarehouseReportMemo(`analysis-model:${site}:`, true);
      return result;
    }),
  );
}
