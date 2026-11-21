import { createHash, randomUUID } from 'node:crypto';
import { logCountExpressions, logCountPattern, logCountVersion } from './warehouse-log-hour-counts';
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
  warehouseReportCheckpoint,
  warehouseReportCommand,
  warehouseReportMetadata,
  warehouseReportQuery,
  warehouseReportSignal,
  withinWarehouseReport,
} from './warehouse-report-snapshot';
import {
  analysisBuildStep,
  AnalysisBuildAbandoned,
  type AnalysisBuild,
  type AnalysisBuildStore,
} from './warehouse-analysis-build';
import { memoRoundMetric } from './warehouse-round-metrics';

export const analysisModelVersion = 'analysis-model-v2';
export const analysisModelDays = 64;
const hour = 3600;
const maxLogBuildAttempts = 1024;
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
  log_counts?: string;
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
export function analysisSource(kind: AnalysisKind, reuseLogAttempts = false) {
  return withoutAnalysisRead(() => {
    const immutableTimeWindow = {
      start: 'modelStart',
      end: 'modelEnd',
      endExclusive: true,
      hours: 'modelWindowHours',
    };
    if (kind === 'log')
      return reportingLogRelation(
        {
          immutableTimeWindow,
          ...(reuseLogAttempts ? { logAttemptIdsParameter: 'modelLogAttempts' } : {}),
        },
        fields(kind),
      );
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
  const bucketHours = buckets.map(b => b[0]);
  const bucketHour = 'toInt64(toUnixTimestamp(toStartOfHour(_record_time)))';
  const coveredDays = `toDate32(_record_time) BETWEEN
    toDate32(toDateTime({modelFirstHour:Int64},'UTC')) AND
    toDate32(toDateTime({modelLastHour:Int64},'UTC'))`;
  const coveredHour = `${bucketHour} IN {modelCoveredHours:Array(Int64)}`;
  let sql: string;
  if (kind === 'log') {
    sql = `SELECT DISTINCT ${bucketHour} AS hour FROM warehouse_liekan_log
      PREWHERE ${rawScope} AND ${coveredDays}
      WHERE ${coveredHour} AND (_attempt_id IN (${attempts('liekan_log')}) ${names.has('liekan_crawler_evidence') ? `OR id IN (SELECT log_id FROM warehouse_liekan_crawler_evidence WHERE ${rawScope} AND _attempt_id IN (${attempts('liekan_crawler_evidence')}))` : ''})`;
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
      SELECT DISTINCT ${bucketHour} AS hour FROM warehouse_website_event
      PREWHERE ${rawScope} AND ${coveredDays}
      WHERE ${coveredHour} AND (session_id,visit_id) IN changed_visits`;
  }
  const rows = await warehouseReportQuery<{ hour: string }>(site, sql, {
    modelPrevious: previous,
    modelFirstHour: Math.min(...bucketHours),
    modelLastHour: Math.max(...bucketHours),
    modelCoveredHours: bucketHours,
  });
  return new Set(rows.map(r => Number(r.hour)));
}
type AnalysisSelection = {
  kinds?: AnalysisKind[];
  start?: number;
  end?: number;
  preserveOther?: boolean;
};
async function loadModel(
  site: string,
  selection?: AnalysisSelection,
  recovery?: { prepared?: AnalysisRead; onCheckpoint?: (value: AnalysisRead) => Promise<void> },
) {
  const metadata = await warehouseReportMetadata(site);
  const control = createHash('sha256')
    .update(JSON.stringify([analysisModelVersion, warehouseControlFingerprint(metadata)]))
    .digest('hex');
  const [checkpoint] = recovery?.prepared
    ? []
    : await warehouseReportQuery<Checkpoint>(
        site,
        `SELECT toString(c.publication) AS publication,toString(c.browser_publication) AS browser_publication,toString(c.log_publication) AS log_publication,browser,log,log_counts FROM warehouse_analysis_coverage_v1 c WHERE ${scope} AND control={modelControl:String} AND c.publication<={wh_publication:UInt64} ORDER BY c.publication DESC,recorded_at DESC,checkpoint DESC LIMIT 1`,
        { modelControl: control },
      );
  const result: AnalysisRead = recovery?.prepared
    ? structuredClone(recovery.prepared)
    : {
        site,
        control,
        publication: {
          browser: checkpoint?.browser_publication ?? '0',
          log: checkpoint?.log_publication ?? '0',
        },
        browser: parseBuckets(checkpoint?.browser),
        log: parseBuckets(checkpoint?.log),
        ...(checkpoint?.log_counts && { logCounts: JSON.parse(checkpoint.log_counts) }),
      };
  for (const kind of ['browser', 'log'] as const) {
    if (selection?.kinds && !selection.kinds.includes(kind)) {
      if (!selection.preserveOther) result[kind] = [];
      continue;
    }
    if (
      result.checkedFamilies?.includes(kind) &&
      result.publication[kind] === metadata.boundary.publication
    )
      continue;
    // Request-time integrity checks only cover buckets that this request can
    // use. Cross-window anchors still come from the authoritative fallback.
    if (Number.isFinite(selection?.start) && Number.isFinite(selection?.end))
      result[kind] = result[kind].filter(
        b => (b[0] + hour) * 1000 > selection.start && b[0] * 1000 <= selection.end,
      );
    const dirty =
      result[kind].length && result.publication[kind] !== metadata.boundary.publication
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
        { traceStage: 'analysis-coverage' },
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
          { traceStage: 'analysis-coverage' },
        );
        const counts = new Map(visits.map(c => [`${c.hour}:${c.build}`, Number(c.rows)]));
        result.browser = result.browser.filter(b => (counts.get(`${b[0]}:${b[1]}`) ?? 0) === b[3]);
      }
    }
    result.publication[kind] = metadata.boundary.publication;
    if (recovery) {
      result.checkedFamilies = [...new Set([...(result.checkedFamilies ?? []), kind])];
      await recovery.onCheckpoint?.(structuredClone(result));
    }
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
          { traceStage: 'analysis-proof' },
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
                  { traceStage: 'analysis-proof' },
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
 * superseded candidates are unreachable. Durable receipts resume confirmed
 * stages; ambiguous partial candidates receive a new build UUID. */
export async function prepareAnalysisModel(
  site: string,
  start: Date,
  end: Date,
  options: {
    kinds?: AnalysisKind[];
    completeThrough?: number;
    prepared?: AnalysisRead;
    buildStore?: AnalysisBuildStore;
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
      const store = options.buildStore;
      const pending = store?.current();
      const required = pending && !kinds.includes(pending.kind) ? [...kinds, pending.kind] : kinds;
      const result = await loadModel(
        site,
        { kinds: required, preserveOther: true },
        { prepared: reusable, onCheckpoint: options.onCheckpoint },
      );
      const last =
        Math.min(
          Math.ceil(+end / 3600000),
          Math.floor((options.completeThrough ?? Infinity) / 3600000),
        ) * hour;
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
      const buildGroup = async (state: AnalysisBuild) => {
        if (state.control !== result.control || state.publication !== metadata.boundary.publication)
          throw new Error('warehouse-analysis-build-boundary');
        try {
          await buildAnalysisGroup(site, result, state, store, options.onCheckpoint);
          await store?.save(null);
          await warehouseReportCheckpoint(store);
        } catch (error) {
          if (error instanceof AnalysisBuildAbandoned) await store?.save(null);
          throw error;
        }
      };
      if (pending) await buildGroup(pending);
      for (const kind of kinds) {
        result[kind] = result[kind].filter(b => b[0] >= retentionStart && b[0] < recentEnd);
        const have = new Set(result[kind].map(b => b[0]));
        const missing = requested.filter(h => !have.has(h));
        for (let offset = 0; offset < missing.length; offset += 128) {
          warehouseReportSignal()?.throwIfAborted();
          const state: AnalysisBuild = {
            id: randomUUID(),
            sourceBuild: randomUUID(),
            checkpoint: randomUUID(),
            kind,
            hours: missing.slice(offset, offset + 128),
            control: result.control,
            publication: metadata.boundary.publication,
            receipts: {},
          };
          await store?.save(state);
          await buildGroup(state);
        }
      }
      forgetWarehouseReportMemo(`analysis-model:${site}:`, true);
      return result;
    }),
  );
}

type BuildDigest = { hour: string; rows: string; checksum: string; countVersion?: string; requests?: string; abnormal?: string };
type PhysicalHourProbe = { hour: string } | { hours: string[]; attempts: string[] };
async function buildAnalysisGroup(
  site: string,
  result: AnalysisRead,
  state: AnalysisBuild,
  store?: AnalysisBuildStore,
  checkpoint?: (value: AnalysisRead) => Promise<void>,
) {
  const step = <T>(name: string, work: () => Promise<T>, recover?: () => Promise<T>) =>
    analysisBuildStep(state, store, name, work, recover);
  const kind = state.kind,
    coveredHours = state.hours;
  if (
    !['browser', 'log'].includes(kind) ||
    !coveredHours.length ||
    coveredHours.length > 128 ||
    coveredHours.some(h => !Number.isSafeInteger(h) || h % hour) ||
    new Set(coveredHours).size !== coveredHours.length ||
    (state.sourceBuild !== undefined &&
      (state.sourceBuild === state.id || !/^[-a-f0-9]{36}$/.test(state.sourceBuild)))
  )
    throw new Error('warehouse-analysis-build-plan-invalid');
  const modelStart = warehouseTime(new Date(Math.min(...coveredHours) * 1000));
  const modelEnd = warehouseTime(new Date((Math.max(...coveredHours) + hour) * 1000));
  const physicalHour = 'toInt64(toUnixTimestamp(toStartOfHour(_record_time)))';
  const physical = await step('physical', () =>
    warehouseReportQuery<PhysicalHourProbe>(
      site,
      `SELECT ${
        kind === 'log'
          ? `groupUniqArray(${physicalHour}) AS hours,
          groupUniqArray(${maxLogBuildAttempts + 1})(_attempt_id) AS attempts`
          : `DISTINCT ${physicalHour} AS hour`
      }
     FROM warehouse_${kind === 'browser' ? 'website_event' : 'liekan_log'}
     PREWHERE ${rawScope}
       AND toDate32(_record_time) BETWEEN toDate32({modelStart:DateTime64(6,'UTC')})
         AND toDate32(subtractMicroseconds({modelEnd:DateTime64(6,'UTC')},1))
     WHERE ${physicalHour} IN {modelMissingHours:Array(Int64)}`,
      { modelMissingHours: coveredHours, modelStart, modelEnd },
    ),
  );
  // An old receipt has only the list of hours. A saturated set is also
  // incomplete. Both cases fall back to the source relation's inline scan.
  const probe = physical[0];
  const logProbe = probe && 'hours' in probe ? probe : undefined;
  const logAttempts =
    logProbe && logProbe.attempts.length <= maxLogBuildAttempts ? logProbe.attempts : undefined;
  const occupied = new Set(
    (logProbe?.hours ?? physical.flatMap(row => ('hour' in row ? [row.hour] : []))).map(Number),
  );
  const hours = coveredHours.filter(h => occupied.has(h)),
    columns = fields(kind),
    source = analysisSource(kind, logAttempts !== undefined);
  const sourceControl = createHash('sha256').update(`source-build:${result.control}`).digest('hex');
  const params = {
    staticPattern: logCountPattern,
    countVersion: logCountVersion,
    modelControl: result.control,
    modelBuild: state.id,
    ...(state.sourceBuild ? { modelSourceBuild: state.sourceBuild, sourceControl } : {}),
    modelHours: hours,
    modelWindowHours: hours,
    modelStart,
    modelEnd,
    ...(logAttempts ? { modelLogAttempts: logAttempts } : {}),
  };
  const writeRows = (table: string, names: string[], select: string, staging = false) =>
    warehouseReportCommand(
      site,
      `INSERT INTO ${table} (${names.map(identifier).join(',')}) ${select}`,
      {
        ...params,
        writeBuild: staging ? state.sourceBuild : state.id,
        writeControl: staging ? sourceControl : result.control,
      },
      55,
    );
  const stageScope = `${scope} AND _control={sourceControl:String} AND _build={modelSourceBuild:UUID}`;
  const stageRows = async (name: string, table: string, names: string[], select: string) => {
    if (!state.sourceBuild) return;
    // No published coverage refers to this build. Confirm a complete source
    // write before allowing its content to become the expected digest.
    const rows = await step(
      name,
      async () => {
        const reply = await writeRows(table, names, select, true);
        return reply.summary?.written_rows ?? null;
      },
      async () => {
        throw new AnalysisBuildAbandoned();
      },
    );
    const projection = names.map(name =>
      name === '_build'
        ? '{writeBuild:UUID}'
        : name === '_control'
          ? '{writeControl:String}'
          : identifier(name),
    );
    return { rows, select: `SELECT ${projection.join(',')} FROM ${table} WHERE ${stageScope}` };
  };
  const verifySourceRows = (expectedRows: string | null | undefined, digests: BuildDigest[]) => {
    if (
      expectedRows != null &&
      BigInt(expectedRows) !== digests.reduce((total, digest) => total + BigInt(digest.rows), 0n)
    )
      throw new AnalysisBuildAbandoned();
  };
  const factTableName = `warehouse_analysis_${kind}_v1`;
  const window = `toInt64(toUnixTimestamp(toStartOfHour(created_at))) IN {modelHours:Array(Int64)}`;
  const factColumns = [...columns, 'epoch', '_control', '_hour', '_build', '_publication'];
  const factSelect = `SELECT ${columns.map(identifier).join(',')},{wh_epoch:UInt64},{writeControl:String},toInt64(toUnixTimestamp(toStartOfHour(created_at))),{writeBuild:UUID},{wh_publication:UInt64}
       FROM ${source} WHERE ${window}`;
  // Groups already in progress from the previous version finish with the
  // original protocol, so an old pending insert is never replayed as a new one.
  const stagedFacts = hours.length
    ? await stageRows('source-facts', factTableName, factColumns, factSelect)
    : undefined;
  const digest = (relation: string, where: string) =>
    `SELECT toInt64(toUnixTimestamp(toStartOfHour(created_at))) AS hour,count() AS rows,toString(sum(cityHash64(tuple(${columns.map(identifier).join(',')})))) AS checksum
      ${kind === 'log' ? `,{countVersion:String} AS countVersion,${logCountExpressions}` : ''} FROM ${relation} WHERE ${where} GROUP BY hour ORDER BY hour`;
  const expected = await step('source', () =>
    hours.length
      ? warehouseReportQuery<BuildDigest>(
          site,
          stagedFacts ? digest(factTableName, stageScope) : digest(source, window),
          params,
        )
      : Promise.resolve([]),
  );
  verifySourceRows(stagedFacts?.rows, expected);
  if (hours.length && !Object.hasOwn(state.receipts, 'facts') && !state.intent)
    await warehouseReportCheckpoint(store);
  const verifyFacts = async () => {
    const actual = hours.length
      ? await warehouseReportQuery<BuildDigest>(
          site,
          digest(factTableName, `${bucketScope} AND _build={modelBuild:UUID}`),
          params,
        )
      : [];
    if (actual.length !== expected.length || expected.some((r, i) =>
      r.hour !== actual[i].hour || r.rows !== actual[i].rows || r.checksum !== actual[i].checksum ||
      (r.countVersion === logCountVersion && (r.requests !== actual[i].requests || r.abnormal !== actual[i].abnormal))
    )) throw new AnalysisBuildAbandoned();
    return actual;
  };
  await step(
    'facts',
    async () => {
      if (hours.length)
        await writeRows(factTableName, factColumns, stagedFacts?.select ?? factSelect);
      return true;
    },
    async () => {
      await step('verified', verifyFacts);
      return true;
    },
  );
  const actual = await step('verified', verifyFacts);
  const visitsSource = `SELECT website_id,session_id,visit_id,epoch,_control,_hour,_build,
    countIf(event_type NOT IN(2,5)) AS pv,countIf(event_type=2) AS custom,
    minOrNullIf(created_at,event_type NOT IN(2,5)) AS first_pv,
    maxOrNullIf(created_at,event_type NOT IN(2,5)) AS last_pv,uniqExactState(session_id) AS visitors
    FROM warehouse_analysis_browser_v1 WHERE ${bucketScope} AND _build={modelBuild:UUID} AND _qualified
    GROUP BY website_id,session_id,visit_id,epoch,_control,_hour,_build`;
  const visitDigest = (
    relation: string,
    where = `${bucketScope} AND _build={modelBuild:UUID}`,
  ) => `SELECT _hour AS hour,count() AS rows,
    toString(sum(cityHash64(tuple(website_id,session_id,visit_id,pv,custom,first_pv,last_pv,finalizeAggregation(visitors))))) AS checksum
    FROM ${relation} WHERE ${where} GROUP BY _hour ORDER BY _hour`;
  const hasVisits = kind === 'browser' && hours.length > 0;
  const visitTable = 'warehouse_analysis_visit_hour_v1';
  const visitColumns = [
    'website_id',
    'session_id',
    'visit_id',
    'epoch',
    '_control',
    '_hour',
    '_build',
    'pv',
    'custom',
    'first_pv',
    'last_pv',
    'visitors',
    '_publication',
  ];
  const visitSelect = `SELECT website_id,session_id,visit_id,epoch,{writeControl:String},_hour,{writeBuild:UUID},pv,custom,first_pv,last_pv,visitors,{wh_publication:UInt64} FROM (${visitsSource})`;
  if (
    hasVisits &&
    !Object.hasOwn(state.receipts, state.sourceBuild ? 'source-visits' : 'visit-source') &&
    !state.intent
  )
    await warehouseReportCheckpoint(store);
  const stagedVisits = hasVisits
    ? await stageRows('source-visits', visitTable, visitColumns, visitSelect)
    : undefined;
  const expectedVisits = await step('visit-source', () =>
    hasVisits
      ? warehouseReportQuery<BuildDigest>(
          site,
          stagedVisits ? visitDigest(visitTable, stageScope) : visitDigest(`(${visitsSource})`),
          params,
        )
      : Promise.resolve([]),
  );
  verifySourceRows(stagedVisits?.rows, expectedVisits);
  if (hasVisits && !Object.hasOwn(state.receipts, 'visits') && !state.intent)
    await warehouseReportCheckpoint(store);
  const verifyVisits = async () => {
    const actualVisits = hasVisits
      ? await warehouseReportQuery<BuildDigest>(site, visitDigest(visitTable), params)
      : [];
    if (JSON.stringify(actualVisits) !== JSON.stringify(expectedVisits))
      throw new AnalysisBuildAbandoned();
    return actualVisits;
  };
  await step(
    'visits',
    async () => {
      if (hasVisits) await writeRows(visitTable, visitColumns, stagedVisits?.select ?? visitSelect);
      return true;
    },
    async () => {
      await step('visit-verified', verifyVisits);
      return true;
    },
  );
  const visits = await step('visit-verified', verifyVisits);
  const fragments = new Map(visits.map(r => [Number(r.hour), Number(r.rows)]));
  const counts = new Map(actual.map(r => [Number(r.hour), Number(r.rows)]));
  const next = structuredClone(result),
    replaced = new Set(coveredHours);
  next[kind] = [
    ...next[kind].filter(b => !replaced.has(b[0])),
    ...coveredHours.map(
      h => [h, state.id, counts.get(h) ?? 0, fragments.get(h) ?? 0] as AnalysisBucket,
    ),
  ].sort((a, b) => a[0] - b[0]);
  const hoursWithCounts: NonNullable<AnalysisRead['logCounts']>['hours'] = {};
  const sourceCounts = new Map(expected.map(r => [Number(r.hour), r]));
  const targetCounts = new Map(actual.map(r => [Number(r.hour), r]));
  for (const [h, build, rows] of next.log) {
    const saved = result.logCounts?.version === logCountVersion && result.logCounts.hours[h];
    if (saved && saved[0] === build) hoursWithCounts[h] = saved;
    if (kind === 'log' && build === state.id && rows > 0) {
      const s = sourceCounts.get(h), t = targetCounts.get(h);
      if (s?.countVersion === logCountVersion && t?.countVersion === logCountVersion &&
        s.requests !== undefined && s.abnormal !== undefined && s.requests === t.requests && s.abnormal === t.abnormal)
        hoursWithCounts[h] = [build, Number(s.requests), Number(s.abnormal)];
    }
  }
  next.logCounts = { version: logCountVersion, hours: hoursWithCounts };
  const coverageParams = {
    modelControl: next.control,
    modelCheckpoint: state.checkpoint,
    modelBrowser: JSON.stringify(next.browser),
    modelLog: JSON.stringify(next.log),
    modelLogCounts: JSON.stringify(next.logCounts),
    modelBrowserPublication: next.publication.browser,
    modelLogPublication: next.publication.log,
  };
  const publish = async () => {
    await warehouseReportCommand(
      site,
      `INSERT INTO warehouse_analysis_coverage_v1 (website_id,epoch,control,publication,checkpoint,browser,log,browser_publication,log_publication,log_counts)
       SELECT {wh_site:UUID},{wh_epoch:UInt64},{modelControl:String},{wh_publication:UInt64},{modelCheckpoint:UUID},{modelBrowser:String},{modelLog:String},{modelBrowserPublication:UInt64},{modelLogPublication:UInt64},{modelLogCounts:String}`,
      coverageParams,
      55,
    );
    return true;
  };
  await step('coverage', publish, async () => {
    const found = await warehouseReportQuery(
      site,
      `SELECT 1 FROM warehouse_analysis_coverage_v1 WHERE ${scope} AND control={modelControl:String}
       AND publication={wh_publication:UInt64} AND checkpoint={modelCheckpoint:UUID}
       AND browser={modelBrowser:String} AND log={modelLog:String} AND log_counts={modelLogCounts:String} LIMIT 1`,
      coverageParams,
    );
    // Identical manifest retries do not add facts or change counts.
    return found.length ? true : publish();
  });
  await checkpoint?.(next);
  Object.assign(result, next);
}
