import { computeWebsiteSummary } from './warehouse-website-summary';
import { readBrowserPresence } from './warehouse-browser-presence';
import type { WebsiteSummary } from '../contracts/website-summary';
import { traceSummarySnapshot } from './report-read-diagnostics';
import { WarehouseBackgroundDeferred } from './warehouse-background-budget';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { ACCOUNT_DEFAULT_TIMEZONE, validateTimezone } from '../contracts/account-preferences';
import { calendarDayRange } from '../contracts/calendar';
import type { AnalysisJob } from '../contracts/analysis-acceleration';
import type { LiekanPageReport } from '../contracts/page-report';
import {
  overviewVersionConflict,
  overviewVersionSchema,
  parseReportQuery,
  type ReportQuery,
} from '../contracts/query';
import { isScheduledReport, scheduledReportResources } from '../contracts/scheduled-reports';
import { getPublishedCatalog } from '../crawlers/published';
import { warehouseReportNoValidSnapshot } from '../contracts/report-status';
import { reportLogRange } from '../report-log-tables';
import { WarehouseConflict } from '../warehouse/control-db';
import { warehouseReader } from '../warehouse/reader-runtime';
import { readReportingMetadataForSites } from '../warehouse/reporting-context';
import type { ReportingMetadata } from '../warehouse/reporting-relations';
import {
  analysisErrorReason,
  captureReportTimings,
  noteBackgroundInterval,
  type ReportTimings,
  timeReportQuery,
} from './analysis-diagnostics';
import { analysisResponse } from './analysis-query-api';
import { analysisQueryLimits } from './analysis-query-model';
import { AnalyticsRestart, AnalyticsUnavailable } from './analytics-budget';
import { noteBrowserPopulation } from './cache-context';
import { loadPublishedRegistry, withPublishedRegistry } from './crawler-registry-context';
import { withDashboardClock } from './dashboard-clock';
import { dashboardWarmRanges } from './dashboard-snapshot-model';
import { LiekanError } from './errors';
import { computeWarehouseOverview, type WarehouseOverviewResult } from './page-report';
import {
  captureReportRankings,
  prefillReportRankings,
  readReportRanking,
  rankingPageReady,
} from './report-ranking-artifact';
import type { authorize } from './server';
import { collectAnalysisArtifacts } from './warehouse-analysis-gc';
import {
  analysisModelDays,
  prepareAnalysisModel,
  withVerifiedAnalysisRead,
} from './warehouse-analysis-model';
import { warehouseLogWindowHasFacts } from './warehouse-log-queries';
import { prepareWarehouseOverviewLogSegments } from './warehouse-overview-log-segments';
import {
  acquireReportRound,
  canJoinReportRound,
  liveRoundProgress,
  finishReportRound,
  offlineReportCutoff,
  offlineReportLagMs,
  type ReportRound,
  reportAnalysisKinds,
  saveRoundPreparation,
  reportRoundMetrics,
  reportRoundBuild,
  reportRoundVersion,
} from './warehouse-report-round';
import {
  warehouseBackgroundClaimAfter,
  warehouseFairClaimDue,
  withWarehouseReportClaim,
  warehouseControlFingerprint,
  warehouseReportCheckpoint,
  warehouseReportMetadata,
  withinWarehouseReport,
} from './warehouse-report-snapshot';
import { computeWarehouseRetention, type RetentionSnapshot } from './warehouse-retention-result';
import { withRoundMetrics } from './warehouse-round-metrics';
import {
  adaptPreviousRetention,
  adaptPreviousSnapshot,
  currentSnapshotFormat,
  readableSnapshotFormats,
} from './warehouse-snapshot-compatibility';

// Change when persisted results can no longer be read with the current report semantics.
const formatVersion = currentSnapshotFormat;
const intervalMs = 30 * 60 * 1000;
const minimumPresetRefreshGap = '5 seconds';
const presetIntervals = {
  today: 10 * 60 * 1000,
  '7d': 6 * 60 * 60 * 1000,
  '30d': 12 * 60 * 60 * 1000,
};
function refreshInterval(row: Pick<Snapshot, 'preset' | 'parameters'>) {
  if (!row.preset) return intervalMs;
  const p = row.parameters;
  // The native month-retention preset uses chartPeriod=today as a transport
  // default, but is not a Today window. Preserve its existing cadence.
  if (p.nativeRetention && p.chartPeriod === 'today') {
    const day = calendarDayRange(p.startAt, p.timezone);
    if (p.startAt !== day.startAt || p.endAt !== day.endAt) return intervalMs;
  }
  return presetIntervals[p.chartPeriod] ?? intervalMs;
}
const discoveryIntervalMs = 30000;
const discoveryBatch = 48;
const claimsBetweenBackfills = 4;
const controlScanIntervalMs = 10000;
const presetPriorityWindowMs = 2 * 60 * 1000;
const presetFailureRetryMs = 5 * 60 * 1000;
const withoutTablePages = "coalesce(parameters->'tablePages','{}'::jsonb)='{}'::jsonb";
let nextDiscoveryAt = 0;
let scheduledCatalog: string | undefined;
let nextControlScanAt = 0;
let lastScannedSite: string | null = null;
// Alternate pressure slots between overdue Today overviews and the normal
// aged queue. Both groups retain persisted eligibility order across sites.
let favorToday = true;
let lastBackfillSnapshot: string | null = null;
type Access = Awaited<ReturnType<typeof authorize>>;
type Snapshot = {
  format_version: number;
  id: string;
  website_id: string;
  query_key: string;
  preset: boolean;
  catalog_version: string;
  parameters: ReportQuery & {
    nativeRetention?: Record<string, unknown>;
    siteSummary?: 'day' | 'range';
  };
  control_version: string;
  publication: string | null;
  result:
    | WarehouseOverviewResult
    | RetentionSnapshot
    | {
        kind: 'site-summary';
        row: Omit<WebsiteSummary[number], 'received' | 'lastAt'>;
        dataThrough: number;
      }
    | null;
  generated_at: Date | null;
  generated_version?: string | null;
  queued_at: Date;
  started_at: Date | null;
  next_attempt_at: Date;
  lease_until: Date | null;
  error_code: string | null;
};
type OverviewClaim = { row: Snapshot & { saved_through: number | null }; token: string };
function overviewKey(p: ReportQuery, catalogVersion: string) {
  return createHash('sha256')
    .update(JSON.stringify([formatVersion, catalogVersion, p]))
    .digest('hex');
}

function presetRefreshPhase(websiteId: string) {
  // Keep a site's timezones and preset ranges on the same recurring schedule.
  return createHash('sha256').update(websiteId).digest().readUInt32BE() % presetIntervals.today;
}

function presetParameters(timezone: string, now: number, includeOnDemandRetention = false) {
  const ranges = scheduledReportResources
    .flatMap(resource =>
      dashboardWarmRanges(timezone, now).map((range, i) => {
        const parsed = parseReportQuery({
          resource,
          chartPeriod: ['today', '7d', '30d'][i],
          ...range,
          timezone,
          ...(resource.startsWith('ai/')
            ? { crawlerMetricsVersion: 1, endAt: range.endAt + 1 }
            : {}),
          ...(resource === 'human/geo' ? { direction: 'desc' } : {}),
        });
        if (!parsed.success) throw new Error('Invalid report preset');
        return parsed.data;
      }),
    )
    .flatMap(parameters =>
      includeOnDemandRetention && parameters.resource === 'human/overview'
        ? [parameters, { ...parameters, nativeRetention: {} }]
        : [parameters],
    );
  if (!scheduledReportResources.includes('human/overview')) return ranges;
  const month = formatInTimeZone(now, timezone, 'yyyy-MM');
  const next = new Date(`${month}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const monthly = parseReportQuery({
    resource: 'human/overview',
    chartPeriod: 'today',
    timezone,
    startAt: +fromZonedTime(`${month}-01T00:00:00`, timezone),
    endAt: +fromZonedTime(`${next.toISOString().slice(0, 10)}T00:00:00`, timezone) - 1,
  });
  if (!monthly.success) throw new Error('Invalid retention preset');
  return [...ranges, { ...monthly.data, nativeRetention: {} }];
}

type SummaryRange = { startAt: number; endAt: number; timezone: string };
function summaryParameters({ startAt, endAt, timezone }: SummaryRange): Snapshot['parameters'] {
  const day = calendarDayRange(startAt, timezone);
  const parsed = parseReportQuery({
    resource: 'human/overview',
    chartPeriod: 'today',
    startAt,
    endAt,
    timezone,
  });
  if (!parsed.success) throw new LiekanError('统计参数无效');
  return {
    ...parsed.data,
    siteSummary: day.startAt === startAt && day.endAt === endAt ? 'day' : 'range',
  };
}
function dailySummary(timezone: string, now: number) {
  return summaryParameters({ timezone, ...calendarDayRange(now, timezone) });
}

function isCurrentPreset(p: ReportQuery, catalog: string, key: string, now = Date.now()) {
  if ('siteSummary' in p) return overviewKey(dailySummary(p.timezone, now), catalog) === key;
  return presetParameters(p.timezone, now).some(params => overviewKey(params, catalog) === key);
}

// The default is scheduled for every site. Other timezones follow saved account preferences.
function presetTimezoneForSite(timezone: string) {
  return `(${timezone}=$1 OR EXISTS (
    SELECT 1 FROM liekan_account_preferences pref JOIN "user" u USING (user_id)
    WHERE pref.timezone=${timezone} AND u.deleted_at IS NULL AND (
      u.role='admin' OR u.user_id=w.user_id OR (
        w.user_id IS NULL AND EXISTS (
          SELECT 1 FROM team_user m JOIN team t USING (team_id)
          WHERE m.user_id=u.user_id AND t.team_id=w.team_id AND t.deleted_at IS NULL
        )
      )
    )
  ))`;
}

async function scheduleOverviewPresets(now: number) {
  if (now < nextDiscoveryAt) return scheduledCatalog;
  const db = warehouseReader().db;
  const { version } = await loadPublishedRegistry();
  const zones = await db.read<{ timezone: string }>(
    `SELECT DISTINCT timezone FROM liekan_account_preferences`,
  );
  const presets = [...new Set([ACCOUNT_DEFAULT_TIMEZONE, ...zones.map(zone => zone.timezone)])]
    .filter(validateTimezone)
    .flatMap(timezone =>
      [...presetParameters(timezone, now), dailySummary(timezone, now)].map(parameters => ({
        timezone,
        query_key: overviewKey(parameters, version),
        parameters,
      })),
    );
  const scheduled = await db.read(
    `WITH presets AS (
       SELECT * FROM jsonb_to_recordset($2::jsonb)
         AS p(timezone text, query_key text, parameters jsonb)
     ), missing AS (
       SELECT w.website_id,p.query_key,p.parameters
       FROM website w JOIN liekan_warehouse_site s USING (website_id) CROSS JOIN presets p
       WHERE w.deleted_at IS NULL AND s.resource_type='website' AND s.state='active'
         AND ${presetTimezoneForSite('p.timezone')}
         AND NOT EXISTS (SELECT 1 FROM liekan_warehouse_overview_snapshot snapshot
           WHERE snapshot.website_id=w.website_id AND snapshot.query_key=p.query_key AND snapshot.preset)
       ORDER BY (s.publication=0),w.website_id,p.query_key LIMIT $5
     )
     INSERT INTO liekan_warehouse_overview_snapshot AS snapshot
       (id,website_id,query_key,parameters,catalog_version,format_version,preset,control_version)
     SELECT gen_random_uuid(),website_id,query_key,parameters,$3,$4,true,'' FROM missing
     ON CONFLICT (website_id,query_key) DO UPDATE SET preset=true
       WHERE NOT snapshot.preset
     RETURNING id`,
    [ACCOUNT_DEFAULT_TIMEZONE, JSON.stringify(presets), version, formatVersion, discoveryBatch],
  );
  // Older schedulers registered all three rolling retention ranges. The native
  // calendar month also uses chartPeriod=today; distinguish it by its duration.
  // Leave the result and lease available to readers and in-flight computations.
  await db.read(
    `UPDATE liekan_warehouse_overview_snapshot SET preset=false,
       last_requested_at=CASE WHEN generated_at IS NULL AND lease_token IS NULL
         THEN least(last_requested_at,now()-interval '1 day') ELSE last_requested_at END
     WHERE preset AND id IN (
      SELECT id FROM liekan_warehouse_overview_snapshot
      WHERE preset AND parameters ? 'nativeRetention' AND format_version=$1
        AND (parameters->>'chartPeriod' IN ('7d','30d') OR
          (parameters->>'chartPeriod'='today' AND
           (parameters->>'endAt')::bigint-(parameters->>'startAt')::bigint < 2*86400000))
      ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    [formatVersion, discoveryBatch],
  );
  scheduledCatalog = version;
  nextDiscoveryAt = scheduled.length < discoveryBatch ? now + discoveryIntervalMs : now;
  return version;
}

async function readSnapshot(
  websiteId: string,
  selector: { queryKey: string } | { id: string },
  includeResult: boolean | 'today-card',
  format = formatVersion,
) {
  const [row] = await warehouseReader().db.read<Snapshot>(
    `SELECT id,website_id,parameters,preset,format_version,catalog_version,control_version,publication,generated_at,queued_at,started_at,
      extract(epoch FROM generated_at)::text AS generated_version,next_attempt_at,lease_until,error_code,
      CASE WHEN $4 THEN
        ${
          includeResult === 'today-card' && format === formatVersion
            ? "jsonb_build_object('cards',result->'cards','meta',jsonb_build_object('snapshot',result->'meta'->'snapshot'))"
            : 'result'
        }
      END AS result
      FROM liekan_warehouse_overview_snapshot WHERE website_id=$1 AND
      ${'id' in selector ? 'id=$2' : 'query_key=$2'} AND format_version=$3`,
    [websiteId, 'id' in selector ? selector.id : selector.queryKey, format, !!includeResult],
  );
  if (row?.result && row.format_version !== formatVersion) {
    const adapted = row.parameters.nativeRetention
      ? adaptPreviousRetention(row.format_version, row.result)
      : adaptPreviousSnapshot(row.format_version, row.result, row.parameters, row.website_id);
    if (!adapted) return;
    row.result = adapted;
  }
  return row;
}

// SQL jsonb numbers compare numerically. A missing or malformed cutoff must
// never outrank a verified timestamp, even in an archived format.
function cutoffSql(result: string) {
  const value = `coalesce(${result}#>'{meta,snapshot,dataThrough}',${result}->'dataThrough')`;
  return `(CASE WHEN jsonb_typeof(${value})='number' THEN ${value} END)`;
}

function dataThrough(row: Snapshot) {
  const result = row.result;
  if (!result) return;
  return 'kind' in result ? result.dataThrough : result.meta?.snapshot?.dataThrough;
}

/** Prefer the exact requested range. During an upgrade, a compatible result
 * for that range stays visible until its replacement covers at least as much. */
async function readPublished(
  site: string,
  parameters: Snapshot['parameters'],
  catalog: string,
  control: Awaited<ReturnType<typeof readOverviewControl>>,
  options: { current?: Snapshot; exact?: boolean; todayCard?: boolean } = {},
) {
  const { exact, todayCard } = options;
  const current =
    options.current && Number.isFinite(dataThrough(options.current)) ? options.current : undefined;
  const cutoff = current && dataThrough(current);
  const sameRange = "parameters - 'tablePages' = $6::jsonb - 'tablePages'";
  const sameFilters = `parameters - ARRAY['startAt','endAt','chartPeriod','tablePages']::text[] =
    $6::jsonb - ARRAY['startAt','endAt','chartPeriod','tablePages']::text[]`;
  const todayOnly = `AND parameters->>'chartPeriod'='today'
    AND (parameters->>'startAt')::bigint<=($6::jsonb->>'startAt')::bigint`;
  // Read metadata in small batches. An unreadable archived format entry must
  // not hide an older valid publication. Only load bodies until one validates.
  const rejected: string[] = [];
  for (;;) {
    const candidates = await warehouseReader().db.read<{ id: string; format_version: number }>(
      `SELECT id,format_version FROM liekan_warehouse_overview_snapshot
       WHERE website_id=$1 AND format_version=ANY($2::integer[]) AND catalog_version=$3
         AND control_version=$4 AND publication<=$5 AND generated_at IS NOT NULL AND result IS NOT NULL
         AND NOT (id=ANY($7::uuid[])) AND ${withoutTablePages}
         AND ${current || exact || parameters.nativeRetention ? sameRange : sameFilters}
         ${todayCard ? todayOnly : ''}
         ${parameters.siteSummary === 'day' ? "AND (parameters->>'startAt')::bigint<=($6::jsonb->>'startAt')::bigint" : ''}
         ${current ? `AND ${cutoffSql('result')} > to_jsonb($8::double precision)` : ''}
       ORDER BY (${sameRange}) DESC,
         (parameters->>'chartPeriod'=$6::jsonb->>'chartPeriod') DESC,
         ${cutoffSql('result')} DESC NULLS LAST,format_version DESC,generated_at DESC,id DESC LIMIT 8`,
      [
        site,
        current
          ? readableSnapshotFormats.filter(format => format !== formatVersion)
          : readableSnapshotFormats,
        catalog,
        control.version,
        control.publication,
        JSON.stringify(parameters),
        rejected,
        ...(current ? [cutoff] : []),
      ],
    );
    for (const candidate of candidates) {
      rejected.push(candidate.id);
      const row = await readSnapshot(
        site,
        candidate,
        todayCard ? 'today-card' : true,
        candidate.format_version,
      );
      if (!row || !hasCurrentResult(row, control)) continue;
      const through = dataThrough(row);
      if (!Number.isFinite(through) || (current && through <= cutoff)) continue;
      if (todayCard) {
        // A calendar day's published data outlives its scheduling registration.
        // An arbitrary custom interval can also carry chartPeriod=today.
        const day = calendarDayRange(through, parameters.timezone);
        if (day.startAt !== row.parameters.startAt || day.endAt !== row.parameters.endAt) continue;
      }
      return row;
    }
    if (candidates.length < 8) return current;
  }
}

async function readOverviewControl(websiteId: string) {
  const [metadata, settings] = await Promise.all([
    warehouseReportMetadata(websiteId),
    readOverviewSettings([websiteId]),
  ]);
  return overviewControl(metadata, settings.get(websiteId));
}

async function readOverviewSettings(websiteIds: string[]) {
  const rows = await warehouseReader().db.read<{ website_id: string; version: string }>(
    `SELECT website_id,concat_ws(':',updated_at::text,rules_revision,ai_crawler_enabled,is_demo) AS version
     FROM liekan_setting WHERE website_id=ANY($1::uuid[])`,
    [websiteIds],
  );
  return new Map(rows.map(row => [row.website_id, row.version]));
}

function overviewControl(metadata: ReportingMetadata, settings?: string) {
  return {
    version: `${warehouseControlFingerprint(metadata)}:${settings ?? ''}`,
    publication: metadata.boundary.publication,
  };
}

async function reconcileOverviewControls(catalog: string, signal: AbortSignal) {
  const now = Date.now();
  if (now < nextControlScanAt) return;
  const db = warehouseReader().db;
  const sites = await db.read<{ website_id: string }>(
    `SELECT DISTINCT job.website_id FROM liekan_warehouse_overview_snapshot job
     JOIN liekan_warehouse_site s USING (website_id)
     WHERE job.preset AND job.format_version=$1 AND job.catalog_version=$2
       AND s.state='active' AND job.queued_at<=job.generated_at
       AND (job.parameters->>'endAt')::bigint>=extract(epoch FROM now())*1000
       AND ($3::uuid IS NULL OR job.website_id>$3)
     ORDER BY job.website_id LIMIT $4`,
    [formatVersion, catalog, lastScannedSite, discoveryBatch],
  );
  if (sites.length) {
    const ids = sites.map(site => site.website_id);
    const [metadata, settings] = await Promise.all([
      readReportingMetadataForSites(db, ids),
      readOverviewSettings(ids),
    ]);
    signal.throwIfAborted();
    const versions = metadata.map(m => ({
      website_id: m.boundary.websiteId,
      ...overviewControl(m, settings.get(m.boundary.websiteId)),
    }));
    // Mark a previously published result due once. Its original fence stays in place
    // until the worker publishes a replacement against the current control state.
    await db.read(
      `UPDATE liekan_warehouse_overview_snapshot job
       SET queued_at=greatest(now(),job.generated_at+interval '1 millisecond'),
           next_attempt_at=least(now(),job.next_attempt_at),error_code=NULL
       FROM jsonb_to_recordset($1::jsonb) AS control(website_id uuid,version text,publication bigint)
       WHERE job.website_id=control.website_id AND job.preset AND job.format_version=$2
         AND job.catalog_version=$3 AND job.queued_at<=job.generated_at
         AND (job.lease_until IS NULL OR job.lease_until<=now())
         AND (job.parameters->>'endAt')::bigint>=extract(epoch FROM now())*1000
         AND (job.control_version<>control.version OR job.publication>control.publication)`,
      [JSON.stringify(versions), formatVersion, catalog],
    );
  }
  lastScannedSite = sites.length === discoveryBatch ? sites.at(-1).website_id : null;
  nextControlScanAt = lastScannedSite ? now : now + controlScanIntervalMs;
}

function hasCurrentResult(row: Snapshot, control: Awaited<ReturnType<typeof readOverviewControl>>) {
  return (
    row.generated_at !== null &&
    row.publication !== null &&
    row.control_version === control.version &&
    BigInt(row.publication) <= BigInt(control.publication)
  );
}

function snapshotExpiry(row: Snapshot) {
  if (!row.generated_at) return null;
  return row.preset ? +row.next_attempt_at : +row.generated_at + intervalMs;
}

function overviewVersion(row: Snapshot) {
  return createHash('sha256')
    .update(JSON.stringify([row.id, row.control_version, row.publication, row.generated_version]))
    .digest('hex');
}

function presented(row: Snapshot, access: Access, updating: boolean, requested?: ReportQuery) {
  const {
    overviewRanking: _overviewRanking,
    rankings: _rankings,
    ...result
  } = row.result as WarehouseOverviewResult;
  return {
    ...result,
    website: access.website,
    meta: {
      ...result.meta,
      canManage: access.canManage,
      expiresAt: updating || row.error_code ? Date.now() : snapshotExpiry(row),
      snapshot: {
        ...result.meta.snapshot,
        version: overviewVersion(row),
        intervalMs: refreshInterval(row),
        state: updating ? ('updating' as const) : ('ready' as const),
        ...(row.error_code ? { updateError: true } : {}),
        ...(requested && {
          fallback: {
            requestedRange: {
              startAt: requested.startAt,
              endAt: requested.endAt,
              timezone: requested.timezone,
            },
            sourceRange: {
              startAt: row.parameters.startAt,
              endAt: row.parameters.endAt,
              timezone: row.parameters.timezone,
            },
            chartPeriod: row.parameters.chartPeriod,
          },
        }),
      },
    },
  };
}

/** Today's content-request card is site-wide (getLogToday has no report filters).
 * Keep a single authority in the canonical Today preset, independently of the
 * selected range. Only project this small published part; never aggregate on HTTP. */
async function attachTodayRequests(
  value: LiekanPageReport,
  row: Snapshot,
  control: Awaited<ReturnType<typeof readOverviewControl>>,
) {
  if (row.parameters.resource !== 'overview') return;
  const canonical = presetParameters(row.parameters.timezone, Date.now()).find(
    p => p.resource === 'overview' && p.chartPeriod === 'today',
  );
  const pending = await readSnapshot(
    row.website_id,
    { queryKey: overviewKey(canonical, row.catalog_version) },
    'today-card',
  );
  const source = await readPublished(row.website_id, canonical, row.catalog_version, control, {
    current: pending?.preset && hasCurrentResult(pending, control) ? pending : undefined,
    todayCard: true,
  });
  const saved = source?.result as WarehouseOverviewResult | undefined;
  const card = Array.isArray(saved?.cards)
    ? saved.cards.find(card => card.label === '今日总请求')
    : undefined;
  const dataThrough = saved?.meta.snapshot?.dataThrough;
  const usable = card && Number.isFinite(dataThrough);
  const updateError = !!(pending?.control_version === row.control_version && pending.error_code);
  const today = calendarDayRange(Date.now(), row.parameters.timezone);
  const range = usable ? calendarDayRange(dataThrough, row.parameters.timezone) : today;
  const outdated =
    usable &&
    (source.format_version !== formatVersion ||
      range.startAt !== today.startAt ||
      !!activeLease(source) ||
      source.queued_at > source.generated_at ||
      snapshotExpiry(source) <= Date.now() ||
      !!source.error_code ||
      updateError);
  value.cards = value.cards.filter(card => card.label !== '今日总请求');
  value.cards.unshift(
    usable
      ? { ...card }
      : {
          key: 'today-requests',
          label: '今日总请求',
          value: null,
          state: 'unavailable',
          detail: updateError ? '后台统计计算失败，请稍后重试' : '数据准备中，请稍后查看',
        },
  );
  value.meta.todayRequests = {
    state: usable ? (outdated ? 'updating' : 'ready') : updateError ? 'failed' : 'preparing',
    range: { ...range, timezone: row.parameters.timezone },
    intervalMs: presetIntervals.today,
    ...(usable && {
      dataThrough,
      generatedAt: +source.generated_at,
      updateError: !!source.error_code || updateError,
    }),
  };
  // A six/twelve-hour report cannot keep the ten-minute card fresh in browser caches.
  value.meta.expiresAt = Math.min(
    value.meta.expiresAt,
    !usable || outdated ? Date.now() : snapshotExpiry(source),
  );
  return usable ? source : undefined;
}

async function checkPinnedVersion(
  row: Snapshot,
  control: Awaited<ReturnType<typeof readOverviewControl>>,
  expectedVersion: string,
  requested?: ReportQuery,
) {
  // An exact result or another format can take over while the old row still exists.
  const winner = await readPublished(
    row.website_id,
    requested ?? row.parameters,
    row.catalog_version,
    control,
    { exact: !requested },
  );
  if (!winner || overviewVersion(winner) !== expectedVersion) throw invalidOverviewVersion();
}

async function ready(
  row: Snapshot,
  access: Access,
  control: Awaited<ReturnType<typeof readOverviewControl>>,
  tablePages: ReportQuery['tablePages'] = {},
  signal?: AbortSignal,
  expectedVersion?: string,
  fallbackRequest?: ReportQuery,
) {
  if (expectedVersion && expectedVersion !== overviewVersion(row)) throw invalidOverviewVersion();
  if ('kind' in row.result && row.result.kind === 'retention') {
    const control = await readOverviewControl(row.website_id);
    if (!hasCurrentResult(row, control)) throw invalidOverviewVersion();
    if (expectedVersion) await checkPinnedVersion(row, control, expectedVersion, fallbackRequest);
    noteBrowserPopulation(row.website_id, row.result.population);
    return Response.json(row.result.rows, {
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Liekan-Read-Path': 'published',
        'X-Liekan-Data-Through': String(row.result.dataThrough),
        'X-Liekan-Report-Version': overviewVersion(row),
        'X-Liekan-Generated-At': String(+row.generated_at),
        'X-Liekan-Report-State':
          fallbackRequest || activeLease(row) || snapshotExpiry(row) <= Date.now()
            ? 'updating'
            : 'ready',
      },
    });
  }
  const result = row.result as WarehouseOverviewResult;
  const value = presented(
    row,
    access,
    !!fallbackRequest ||
      !!activeLease(row) ||
      row.queued_at > row.generated_at ||
      snapshotExpiry(row) <= Date.now(),
    fallbackRequest,
  );
  let rankingSource: 'snapshot' | undefined;
  let rankingPending = false;
  const requested = Object.entries(tablePages).filter(
    ([table, page]) => value.meta.tablePages?.[table] && value.meta.tablePages[table].page !== page,
  );
  if (requested.length) {
    if (!result.rankings) {
      for (const [table, page] of requested) {
        const current = value.meta.tablePages[table],
          inline = result.overviewRanking;
        const begin = (page - 2) * current.pageSize;
        const end = Math.min((page - 1) * current.pageSize, current.total - current.pageSize);
        if (
          row.format_version !== 2 ||
          !inline ||
          inline.table !== table ||
          page < 2 ||
          page > 3 ||
          inline.rows.length < end
        )
          throw invalidOverviewVersion();
        value.tables = { ...value.tables, [table]: inline.rows.slice(begin, end) };
        value.meta.tablePages = { ...value.meta.tablePages, [table]: { ...current, page } };
      }
    } else {
      await withinWarehouseReport(
        async () => {
          if (!hasCurrentResult(row, await readOverviewControl(row.website_id)))
            throw invalidOverviewVersion();
          for (const [table, page] of requested) {
            const current = value.meta.tablePages[table];
            if (!rankingPageReady(result.rankings, table, page, current.pageSize, current.total)) {
              rankingPending = true;
              continue;
            }
            const slice = await readReportRanking(
              row.website_id,
              row.id,
              result.rankings,
              table,
              page,
              current.pageSize,
              current.total,
            );
            value.tables = { ...value.tables, [table]: slice.rows };
            value.meta.tablePages = { ...value.meta.tablePages, [table]: { ...current, page } };
            if (value.meta.geography?.tables?.[table])
              value.meta.geography = {
                ...value.meta.geography,
                tables: { ...value.meta.geography.tables, [table]: slice.geography },
              };
          }
        },
        {
          publication: { websiteId: row.website_id, publication: row.publication },
          signal,
          deadline: Date.now() + 5000,
        },
      );
    }
    rankingSource = 'snapshot';
  }
  const todaySource = await attachTodayRequests(value, row, control);
  // Revalidate after reading the artifact. No page can silently switch to a
  // freshly published ranking while preserving cards from an older version.
  const currentControl = await readOverviewControl(row.website_id);
  if (
    !hasCurrentResult(row, currentControl) ||
    (todaySource && !hasCurrentResult(todaySource, currentControl))
  )
    throw invalidOverviewVersion();
  if (expectedVersion)
    await checkPinnedVersion(row, currentControl, expectedVersion, fallbackRequest);
  for (const population of [value.meta.population, value.meta.trendPopulation])
    if (population) noteBrowserPopulation(access.website.id, population);
  if (rankingPending) return accepted(row);
  const response = analysisResponse({
    ready: true,
    value,
    generatedAt: value.meta.generatedAt,
    expiresAt: value.meta.expiresAt,
  });
  response.headers.set('X-Liekan-Read-Path', 'published');
  response.headers.set('X-Liekan-Data-Through', String(value.meta.snapshot.dataThrough));
  response.headers.set('X-Liekan-Warehouse-Publication', row.publication);
  if (rankingSource) response.headers.set('X-Liekan-Overview-Ranking', rankingSource);
  return response;
}

function job(row: Snapshot, status: AnalysisJob['status']): AnalysisJob {
  return {
    id: row.id,
    websiteId: row.website_id,
    status,
    queuedAt: row.queued_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.generated_at?.toISOString() ?? null,
    generatedAt: row.generated_at?.getTime() ?? null,
    expiresAt: snapshotExpiry(row),
    errorCode: status === 'failed' ? row.error_code : null,
    retryAfterMs: 3000,
    resultUrl: `/liekan/websites/${row.website_id}/overview-jobs/${row.id}/result`,
  };
}

function activeLease(row: Snapshot) {
  return row.lease_until && +row.lease_until > Date.now();
}

function accepted(row: Snapshot, previousResult?: LiekanPageReport) {
  const response = Response.json(
    {
      status: 'preparing',
      analysisJob: job(row, activeLease(row) ? 'running' : 'queued'),
      ...(previousResult ? { previousResult } : {}),
    },
    { status: 202, headers: { 'Cache-Control': 'private, no-store' } },
  );
  response.headers.set('X-Liekan-Read-Path', 'queued');
  return response;
}

export function warehouseOverviewAsyncRequested(_request: Request, query: URLSearchParams) {
  return isScheduledReport(query.get('resource') ?? '');
}

function invalidOverviewVersion() {
  return new LiekanError('总览快照已更新，请重新读取第一页', 409, overviewVersionConflict);
}

function parseOverviewVersion(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const version = overviewVersionSchema.safeParse(value);
  if (!version.success) throw new LiekanError('总览快照版本无效');
  return version.data;
}

export async function requestWarehouseOverview(
  access: Access,
  input: unknown,
  signal?: AbortSignal,
  nativeRetention?: Record<string, unknown>,
) {
  const parsed = parseReportQuery(input);
  if (!parsed.success || !isScheduledReport(parsed.data.resource))
    throw new LiekanError('统计参数无效');
  const expectedVersion = parseOverviewVersion(
    (input as { reportVersion?: unknown }).reportVersion ??
      (input as { overviewVersion?: unknown }).overviewVersion,
  );
  const { refresh, ...requested } = parsed.data;
  const tablePages = requested.tablePages;
  const parameters = {
    ...requested,
    tablePages: {},
    ...(nativeRetention ? { nativeRetention } : {}),
  };
  if (nativeRetention) {
    const latest = presetParameters(parameters.timezone, Date.now()).at(-1).endAt;
    if (parameters.endAt > latest || parameters.endAt - parameters.startAt > 1096 * 86400000)
      throw new LiekanError('日期范围无效');
    reportLogRange({ ...parameters, endAt: Math.min(parameters.endAt, Date.now()) });
  } else reportLogRange(parameters);
  if (parameters.startAt >= Date.now()) throw new LiekanError('日期范围无效');
  const catalogVersion = getPublishedCatalog()?.version;
  if (!catalogVersion) throw new LiekanError('统计目录暂不可用', 503);
  const queryKey = overviewKey(parameters, catalogVersion);
  const site = access.website.id;
  const db = warehouseReader().db;
  const existing = await readSnapshot(site, { queryKey }, true);
  // Read the authoritative control version after loading the candidate response.
  const control = await readOverviewControl(site);
  const previous =
    existing && hasCurrentResult(existing, control) && Number.isFinite(dataThrough(existing))
      ? existing
      : undefined;
  const selected = await readPublished(site, parameters, catalogVersion, control, {
    current: previous,
  });
  const respond = (updates?: Partial<Pick<Snapshot, 'error_code' | 'queued_at'>>) =>
    ready(
      {
        ...selected,
        error_code:
          (existing?.control_version === control.version ? existing.error_code : null) ??
          selected.error_code,
        ...updates,
      },
      access,
      control,
      tablePages,
      signal,
      expectedVersion,
      selected === previous ? undefined : parameters,
    );
  if (expectedVersion) {
    if (selected) return respond();
    throw invalidOverviewVersion();
  }
  if (
    isCurrentPreset(parameters, catalogVersion, queryKey) &&
    (parameters.timezone === ACCOUNT_DEFAULT_TIMEZONE ||
      (
        await db.read(
          `SELECT 1 FROM website w WHERE w.website_id=$2 AND ${presetTimezoneForSite('$3')}`,
          [ACCOUNT_DEFAULT_TIMEZONE, site, parameters.timezone],
        )
      ).length > 0)
  ) {
    if (selected) return respond();
    if (existing?.error_code && existing.control_version === control.version)
      throw new LiekanError('后台统计计算失败，请稍后重试', 503, warehouseReportNoValidSnapshot);
    if ((await loadPublishedRegistry()).version !== catalogVersion)
      throw new LiekanError('统计任务已过期，请重新读取', 410, 'analysis-expired');
    return Response.json(
      { status: 'preparing' },
      {
        status: 202,
        headers: { 'Cache-Control': 'private, no-store', 'X-Liekan-Read-Path': 'scheduled' },
      },
    );
  }
  const current = previous && +previous.generated_at + intervalMs > Date.now();
  const inBackoff = previous?.error_code && +previous.next_attempt_at > Date.now();
  if (previous && ((current && refresh !== '1') || inBackoff)) {
    await db.read(
      `UPDATE liekan_warehouse_overview_snapshot SET last_requested_at=now()
       WHERE id=$1 AND last_requested_at < now()-interval '5 minutes'`,
      [previous.id],
    );
    return respond();
  }
  const pending = await enqueueSnapshot(
    site,
    queryKey,
    parameters,
    catalogVersion,
    control.version,
    !!selected,
  );
  if (!pending) return respond({ error_code: 'analysis-concurrency-limited' });
  // An old lease retains the global worker slot until its work settles, even after invalidation.
  if (pending.error_code && !selected)
    throw new LiekanError('后台统计计算失败，请稍后重试', 503, warehouseReportNoValidSnapshot);
  if (selected)
    return respond(previous === selected ? { queued_at: pending.queued_at } : undefined);
  return accepted(pending);
}

async function enqueueSnapshot(
  site: string,
  queryKey: string,
  parameters: Snapshot['parameters'],
  catalogVersion: string,
  version: string,
  hasFallback: boolean,
) {
  return warehouseReader().db.transaction(async tx => {
    // A short, separate lock serializes admission across app replicas while the
    // worker holds its computation lock. Existing work can be joined at capacity.
    await tx.query('SELECT pg_advisory_xact_lock(12800001, 94)');
    const {
      rows: [count],
    } = await tx.query<{ total: number; site: number; alreadyQueued: boolean }>(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE website_id=$1)::int AS site,
         coalesce(bool_or(website_id=$1 AND query_key=$2),false) AS "alreadyQueued"
       FROM liekan_warehouse_overview_snapshot
       WHERE NOT preset AND format_version=$3 AND ${withoutTablePages} AND (
         lease_until>now() OR (last_requested_at>=now()-interval '1 day' AND error_code IS NULL
           AND (generated_at IS NULL OR queued_at>generated_at)))`,
      [site, queryKey, formatVersion],
    );
    if (
      !count.alreadyQueued &&
      (count.site >= analysisQueryLimits.site || count.total >= analysisQueryLimits.global)
    ) {
      if (hasFallback) return null;
      throw new AnalyticsUnavailable(
        '后台统计任务已达上限，请等待当前任务完成',
        5,
        429,
        warehouseReportNoValidSnapshot,
      );
    }
    const { rows } = await tx.query<Snapshot>(
      `INSERT INTO liekan_warehouse_overview_snapshot AS snapshot
      (id,website_id,query_key,parameters,catalog_version,format_version,preset,control_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (website_id,query_key) DO UPDATE SET last_requested_at=now(),
        control_version=excluded.control_version,preset=excluded.preset,
        queued_at=CASE WHEN snapshot.control_version<>excluded.control_version OR
          (snapshot.generated_at IS NOT NULL AND snapshot.queued_at<=snapshot.generated_at
            AND (snapshot.error_code IS NULL OR snapshot.next_attempt_at<=now()))
          THEN now() ELSE snapshot.queued_at END,
        next_attempt_at=CASE WHEN snapshot.control_version<>excluded.control_version OR
          snapshot.error_code IS NULL THEN LEAST(now(),snapshot.next_attempt_at)
          ELSE snapshot.next_attempt_at END,
        error_code=CASE WHEN snapshot.control_version<>excluded.control_version OR
          snapshot.next_attempt_at<=now() THEN NULL ELSE snapshot.error_code END,
        result=CASE WHEN snapshot.control_version=excluded.control_version THEN snapshot.result END,
        generated_at=CASE WHEN snapshot.control_version=excluded.control_version THEN snapshot.generated_at END,
        publication=CASE WHEN snapshot.control_version=excluded.control_version THEN snapshot.publication END,
        started_at=CASE WHEN snapshot.control_version=excluded.control_version THEN snapshot.started_at END
      RETURNING id,website_id,queued_at,started_at,generated_at,lease_until,error_code`,
      [randomUUID(), site, queryKey, parameters, catalogVersion, formatVersion, false, version],
    );
    return rows[0];
  });
}

export async function readPublishedWebsiteSummaries(sites: string[], range: SummaryRange) {
  if (!sites.length) return [];
  const catalog = getPublishedCatalog()?.version;
  if (!catalog) throw new LiekanError('统计目录暂不可用', 503);
  const controls = async () => {
    const [metadata, settings] = await Promise.all([
      readReportingMetadataForSites(warehouseReader().db, sites),
      readOverviewSettings(sites),
    ]);
    return new Map(
      metadata.map(m => [
        m.boundary.websiteId,
        overviewControl(m, settings.get(m.boundary.websiteId)),
      ]),
    );
  };
  const initial = await controls();
  const rows: WebsiteSummary = [];
  for (const site of sites) {
    const control = initial.get(site);
    if (!control) throw new LiekanError('网站不存在', 404);
    rows.push(await readSiteSummary(site, range, catalog, control));
  }
  // Revalidate all sites together, including the first row of a multi-site read.
  const current = await controls();
  for (const [site, control] of initial) {
    const fresh = current.get(site);
    if (
      fresh?.version !== control.version ||
      BigInt(fresh.publication) < BigInt(control.publication)
    )
      throw new AnalyticsRestart();
  }
  return rows;
}

async function readSiteSummary(
  site: string,
  range: SummaryRange,
  catalog: string,
  control: ReturnType<typeof overviewControl>,
): Promise<WebsiteSummary[number]> {
  const parameters = summaryParameters(range);
  const key = overviewKey(parameters, catalog);
  const row = await traceSummarySnapshot(() => readSnapshot(site, { queryKey: key }, true));
  const selected =
    row?.result && hasCurrentResult(row, control)
      ? row
      : await traceSummarySnapshot(() =>
          readPublished(site, parameters, catalog, control, {
            exact: parameters.siteSummary !== 'day',
          }),
        );
  const now = Date.now();
  const recurrent =
    isCurrentPreset(parameters, catalog, key, now) &&
    (range.timezone === ACCOUNT_DEFAULT_TIMEZONE ||
      (
        await warehouseReader().db.read(
          `SELECT 1 FROM website w WHERE website_id=$2 AND ${presetTimezoneForSite('$3')}`,
          [ACCOUNT_DEFAULT_TIMEZONE, site, range.timezone],
        )
      ).length > 0);
  const stale = !row || !hasCurrentResult(row, control) || snapshotExpiry(row) <= now;
  let failure = row?.control_version === control.version ? row.error_code : null;
  if (stale && !recurrent) {
    const queued = await enqueueSnapshot(
      site,
      key,
      parameters,
      catalog,
      control.version,
      !!selected,
    );
    failure = queued?.error_code;
  }
  const presence = await readBrowserPresence(site);
  if (selected?.result && 'kind' in selected.result && selected.result.kind === 'site-summary') {
    return {
      ...selected.result.row,
      received: presence?.received ?? false,
      lastAt: presence?.lastAt ?? null,
      collectionKnown: presence?.known ?? false,
      snapshot: {
        state:
          selected.id !== row?.id || stale || activeLease(row) || !!failure ? 'updating' : 'ready',
        startAt: selected.parameters.startAt,
        endAt: selected.parameters.endAt,
        dataThrough: selected.result.dataThrough,
      },
    };
  }
  if (failure)
    throw new LiekanError('后台统计计算失败，请稍后重试', 503, warehouseReportNoValidSnapshot);
  const empty = {
    pageviews: null,
    visitors: null,
    visits: null,
    bounces: null,
    totaltime: null,
    aiVisits: null,
  };
  return {
    id: site,
    ...empty,
    comparison: empty,
    views: null,
    received: presence?.received ?? false,
    lastAt: presence?.lastAt ?? null,
    collectionKnown: presence?.known ?? false,
    snapshot: { state: 'preparing', startAt: range.startAt, endAt: range.endAt, dataThrough: null },
  };
}

export async function readWarehouseOverviewJob(
  access: Access,
  id: string,
  result: boolean,
  query?: URLSearchParams,
  signal?: AbortSignal,
) {
  const expectedVersion = result
    ? parseOverviewVersion(query?.get('reportVersion') ?? query?.get('overviewVersion'))
    : undefined;
  const row = await readSnapshot(access.website.id, { id }, result);
  if (
    !row ||
    row.parameters.siteSummary ||
    row.catalog_version !== getPublishedCatalog()?.version ||
    Object.keys(row.parameters.tablePages ?? {}).length
  ) {
    if (expectedVersion) throw invalidOverviewVersion();
    throw new LiekanError('统计任务已过期，请重新读取', 410, 'analysis-expired');
  }
  const control = await readOverviewControl(access.website.id);
  const sameControl = row.control_version === control.version;
  const readable = hasCurrentResult(row, control);
  const status: AnalysisJob['status'] = !sameControl
    ? 'invalidated'
    : readable
      ? 'ready'
      : activeLease(row)
        ? 'running'
        : row.error_code
          ? 'failed'
          : 'queued';
  if (!result) return Response.json({ analysisJob: job(row, status) });
  const selected =
    sameControl &&
    (await readPublished(row.website_id, row.parameters, row.catalog_version, control, {
      current: readable ? row : undefined,
      exact: true,
    }));
  if (expectedVersion && !selected) throw invalidOverviewVersion();
  if (selected) {
    const input = parseReportQuery({
      ...row.parameters,
      ...Object.fromEntries(
        [...(query ?? new URLSearchParams())].filter(([key]) => key.startsWith('tp_')),
      ),
    });
    if (!input.success) throw new LiekanError('统计参数无效');
    return ready(
      selected,
      access,
      control,
      input.data.tablePages,
      signal,
      expectedVersion,
      selected === row ? undefined : row.parameters,
    );
  }
  if (status === 'queued' || status === 'running') return accepted(row);
  throw new LiekanError(
    '统计结果暂不可读取，请重新查询',
    status === 'failed' ? 503 : 410,
    status === 'failed' ? warehouseReportNoValidSnapshot : 'analysis-invalidated',
  );
}

export async function pumpWarehouseOverview(signal?: AbortSignal) {
  if (signal?.aborted || (await warehouseBackgroundClaimAfter(true))) return false;
  return pumpOverviewTask(signal);
}

export async function drainWarehouseOverview(signal: AbortSignal) {
  if (signal.aborted) return;
  let nextBackfill = claimsBetweenBackfills;
  for (let processed = 0; processed < discoveryBatch && !signal.aborted; ) {
    const claimAfter = await warehouseBackgroundClaimAfter(true);
    if (claimAfter) {
      // Check for an idle ingestion queue during a long debt. No report lease
      // or advisory lock is held while waiting for the next claim.
      const started = performance.now();
      try {
        await delay(Math.min(1000, Math.max(1, claimAfter - Date.now())), undefined, { signal });
      } finally {
        noteBackgroundInterval('claim-yield', performance.now() - started);
      }
      continue;
    }
    const completed = await pumpOverviewTask(signal);
    if (completed) processed++;
    if (!completed || processed === nextBackfill) {
      if (!(await warehouseBackgroundClaimAfter())) await pumpOverviewLogBackfill(signal);
      nextBackfill += claimsBetweenBackfills;
    }
    if (!completed) break;
  }
}

async function pumpOverviewTask(signal?: AbortSignal) {
  if (signal?.aborted) return false;
  // This installation lock also fences another analytics worker and backfill.
  return Boolean(
    await warehouseReader().db.withAdvisoryLock(12800001, 92, async lockSignal => {
      const workSignal = signal ? AbortSignal.any([signal, lockSignal]) : lockSignal;
      const fairSlot = warehouseFairClaimDue();
      const catalog = await prepareOverviewQueue(workSignal, fairSlot);
      const claim = await claimOverview(catalog, workSignal, fairSlot && favorToday);
      if (!claim) return false;
      if (fairSlot) favorToday = !favorToday;
      await withWarehouseReportClaim(() => computeOverviewClaim(claim, workSignal));
      return true;
    }),
  );
}

async function pumpOverviewLogBackfill(signal: AbortSignal) {
  if (signal.aborted || !scheduledCatalog) return;
  const db = warehouseReader().db;
  await db.withAdvisoryLock(12800001, 92, async lockSignal => {
    const workSignal = AbortSignal.any([signal, lockSignal]);
    const [row] = await db.read<Snapshot>(
      `SELECT job.id,job.website_id,job.parameters,job.catalog_version,job.query_key
       FROM liekan_warehouse_overview_snapshot job
       JOIN liekan_warehouse_site s USING (website_id) JOIN website w USING (website_id)
       WHERE job.preset AND job.format_version=$2 AND job.catalog_version=$3
         AND job.parameters->>'resource'='overview' AND job.parameters->>'chartPeriod'='30d'
         AND (job.parameters->>'endAt')::bigint >= extract(epoch FROM now())*1000
         AND NOT EXISTS (SELECT 1 FROM liekan_warehouse_overview_snapshot WHERE lease_until>now())
         AND NOT EXISTS (SELECT 1 FROM liekan_warehouse_report_round r
           JOIN liekan_warehouse_reference ref ON ref.reference_id=r.reference_id
           WHERE r.website_id=job.website_id AND ref.expires_at>clock_timestamp())
         AND s.resource_type='website' AND s.state='active' AND w.deleted_at IS NULL
         AND ${presetTimezoneForSite("job.parameters->>'timezone'")}
         AND ($4::uuid IS NULL OR job.id>$4) ORDER BY job.id LIMIT 1`,
      [ACCOUNT_DEFAULT_TIMEZONE, formatVersion, scheduledCatalog, lastBackfillSnapshot],
    );
    lastBackfillSnapshot = row?.id ?? null;
    const started = Date.now();
    if (!row || !isCurrentPreset(row.parameters, row.catalog_version, row.query_key, started))
      return;
    try {
      await withinWarehouseReport(
        () =>
          withDashboardClock(
            offlineReportCutoff(started),
            async () => {
              const { start, end, halfOpen } = reportLogRange(row.parameters);
              if (await warehouseLogWindowHasFacts(row.website_id, start, end, halfOpen))
                await prepareWarehouseOverviewLogSegments(
                  row.website_id,
                  start,
                  end,
                  row.parameters,
                  true,
                );
            },
            'refresh',
          ),
        { signal: workSignal, deadline: started + 40000, background: true },
      );
    } catch (error) {
      workSignal.throwIfAborted();
      if (error instanceof WarehouseBackgroundDeferred) return;
      if (analysisErrorReason(error) !== 'timeout') throw error;
      console.info(
        JSON.stringify({ event: 'warehouse-overview-backfill-deferred', reason: 'timeout' }),
      );
    }
  });
}

async function prepareOverviewQueue(signal: AbortSignal, fairSlot: boolean) {
  signal.throwIfAborted();
  const db = warehouseReader().db;
  const catalog = await scheduleOverviewPresets(Date.now());
  // Spend a pressure allowance only on reporting. In particular, artifact
  // collection can lock the publishing site's PG row while waiting for CH.
  if (fairSlot) return catalog;
  await db.read(`DELETE FROM liekan_warehouse_overview_snapshot WHERE id IN (
      SELECT id FROM liekan_warehouse_overview_snapshot
      WHERE last_requested_at<now()-interval '1 day'
        AND (NOT preset OR (parameters->>'endAt')::bigint < extract(epoch FROM now()-interval '1 day')*1000)
        AND (lease_until IS NULL OR lease_until<=now())
        AND (result IS NULL OR generated_at IS NULL OR format_version NOT IN (${readableSnapshotFormats.join(',')}) OR EXISTS (
          SELECT 1 FROM liekan_warehouse_overview_snapshot newer
          WHERE newer.website_id=liekan_warehouse_overview_snapshot.website_id
            AND newer.control_version=liekan_warehouse_overview_snapshot.control_version
            AND newer.catalog_version=liekan_warehouse_overview_snapshot.catalog_version
            AND newer.result IS NOT NULL AND newer.generated_at IS NOT NULL
            AND newer.format_version=${formatVersion} AND coalesce(newer.parameters->'tablePages','{}'::jsonb)='{}'::jsonb
            AND ${cutoffSql('newer.result')} >= ${cutoffSql('liekan_warehouse_overview_snapshot.result')}
            AND (newer.format_version=liekan_warehouse_overview_snapshot.format_version OR
              newer.parameters - 'tablePages'=liekan_warehouse_overview_snapshot.parameters - 'tablePages')
            AND (newer.generated_at,newer.id) >
              (liekan_warehouse_overview_snapshot.generated_at,liekan_warehouse_overview_snapshot.id)
            AND newer.parameters - ARRAY['startAt','endAt','tablePages']::text[] =
              liekan_warehouse_overview_snapshot.parameters - ARRAY['startAt','endAt','tablePages']::text[]))
      ORDER BY last_requested_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
  try {
    await collectAnalysisArtifacts(signal);
  } catch {
    signal.throwIfAborted();
    console.info(JSON.stringify({ event: 'warehouse-analysis-gc-deferred' }));
  }
  return catalog;
}

async function claimOverview(catalog: string, signal: AbortSignal, prioritizeToday: boolean) {
  signal.throwIfAborted();
  await reconcileOverviewControls(catalog, signal);
  signal.throwIfAborted();
  const db = warehouseReader().db;
  const token = randomUUID();
  const [row] = await db.read<OverviewClaim['row']>(
    `WITH due AS (
        SELECT job.id FROM liekan_warehouse_overview_snapshot job
        JOIN liekan_warehouse_site s USING (website_id)
        JOIN website w USING (website_id)
        WHERE format_version=$2 AND next_attempt_at<=now() AND ${withoutTablePages}
          AND (job.parameters->>'startAt')::bigint<$7
          AND s.state='active' AND w.deleted_at IS NULL
          AND (
            (preset AND catalog_version=$4 AND ${presetTimezoneForSite("job.parameters->>'timezone'")}
              AND (job.parameters->>'endAt')::bigint >= extract(epoch FROM now())*1000)
            OR (NOT preset AND error_code IS NULL AND last_requested_at>=now()-interval '1 day'
              AND (generated_at IS NULL OR queued_at>generated_at))
          )
          AND NOT EXISTS (
            SELECT 1 FROM liekan_warehouse_report_round round
            JOIN liekan_warehouse_reference ref ON ref.reference_id=round.reference_id
            WHERE round.website_id=job.website_id
              AND (round.control_version=job.control_version OR job.control_version='')
              AND round.catalog_version=job.catalog_version AND round.format_version=job.format_version
              AND round.model_version=$6 AND round.epoch=s.epoch
              AND round.deletion_revision=s.deletion_revision AND round.publication<=s.publication
              AND ref.expires_at>clock_timestamp()
              AND ${liveRoundProgress('round')}
              AND EXISTS (SELECT 1 FROM liekan_warehouse_overview_snapshot member
                WHERE member.id=ANY(round.pending))
              AND (round.next_eligible_at>clock_timestamp() OR
                (NOT job.id=ANY(round.pending) AND NOT ${canJoinReportRound}))
          )
          AND NOT EXISTS (
            SELECT 1 FROM liekan_warehouse_overview_snapshot active WHERE active.lease_until>now()
          )
        ORDER BY CASE WHEN $8 AND preset AND error_code IS NULL AND job.parameters->>'resource'='overview'
          AND job.parameters->>'chartPeriod'='today' THEN 0 ELSE 1 END, CASE
          -- Age out of priority classes using persisted eligibility, including after restart.
          WHEN next_attempt_at<=now()-$5::bigint*interval '1 millisecond' THEN 0
          WHEN error_code IS NOT NULL THEN 4
          WHEN NOT preset AND generated_at IS NULL THEN 1
          WHEN preset AND generated_at IS NOT NULL AND queued_at>generated_at THEN 1
          WHEN preset AND generated_at IS NULL THEN 2
          WHEN preset THEN 3 ELSE 4 END,
          next_attempt_at,
          CASE WHEN preset THEN CASE job.parameters->>'chartPeriod'
            WHEN 'today' THEN 0 WHEN '7d' THEN 1 ELSE 2 END ELSE 0 END,
          job.website_id,
          job.id
        LIMIT 1 FOR UPDATE OF job SKIP LOCKED
      ) UPDATE liekan_warehouse_overview_snapshot snapshot
      SET started_at=now(),lease_token=$3,lease_until=now()+interval '3 minutes',error_code=NULL
      FROM due WHERE snapshot.id=due.id
      RETURNING snapshot.id,snapshot.website_id,snapshot.query_key,snapshot.parameters,
        snapshot.preset,snapshot.catalog_version,snapshot.format_version,snapshot.control_version,
        snapshot.publication,snapshot.generated_at,snapshot.queued_at,snapshot.started_at,
        snapshot.next_attempt_at,snapshot.lease_until,snapshot.error_code,
        ${cutoffSql('snapshot.result')} AS saved_through,
        CASE WHEN snapshot.result->'rankings'->'pending'='true'::jsonb THEN snapshot.result END AS result`,
    [
      ACCOUNT_DEFAULT_TIMEZONE,
      formatVersion,
      token,
      catalog,
      presetPriorityWindowMs,
      reportRoundVersion,
      offlineReportCutoff(Date.now()),
      prioritizeToday,
    ],
  );
  return row ? { row, token } : undefined;
}

async function computeOverviewClaim({ row, token }: OverviewClaim, signal: AbortSignal) {
  const db = warehouseReader().db;
  const requestStartedAt = Date.now();
  let cutoff = offlineReportCutoff(requestStartedAt);
  let round: ReportRound | undefined;
  const timings: ReportTimings = {};
  const started = performance.now();
  let outcome = 'discarded';
  let reason: string | undefined;
  let committedAtMs: number | undefined;
  let rankingPending: boolean | undefined;
  const cleanup = async (
    errorCode: string | null,
    {
      retire = false,
      retryAt,
      covered = false,
    }: {
      retire?: boolean;
      retryAt?: number;
      covered?: boolean;
    } = {},
  ) =>
    db.transaction(async tx => {
      const {
        rows: [updated],
      } = await tx.query<Pick<Snapshot, 'control_version'>>(
        `UPDATE liekan_warehouse_overview_snapshot SET lease_token=NULL,lease_until=NULL,
        error_code=CASE WHEN control_version=$3 THEN $4 ELSE error_code END,
        next_attempt_at=CASE WHEN $6 THEN greatest(now(),to_timestamp($7::double precision/1000)) WHEN control_version=$3 AND $4 IS NOT NULL
          THEN now()+CASE WHEN preset THEN $8::bigint*interval '1 millisecond'
            ELSE interval '1 minute' END ELSE next_attempt_at END,
        preset=CASE WHEN control_version=$3 AND $5 THEN false ELSE preset END
        WHERE id=$1 AND lease_token=$2 RETURNING control_version`,
        [
          row.id,
          token,
          row.control_version,
          errorCode,
          retire,
          retryAt !== undefined,
          retryAt ?? null,
          presetFailureRetryMs,
        ],
      );
      // An unsuccessful report retries in a later round. A deferred report keeps
      // its current round and checkpoints for normal resource recovery.
      if (updated?.control_version === row.control_version && round && (errorCode || covered))
        await finishReportRound(round, row.id, tx);
    });
  try {
    const [site] = await db.read<{ id: string; name: string; domain: string; createdAt: Date }>(
      'SELECT website_id AS id,name,domain,created_at AS "createdAt" FROM website WHERE website_id=$1 AND deleted_at IS NULL',
      [row.website_id],
    );
    if (!site) {
      await cleanup('analysis-invalidated', { retire: true });
      return true;
    }
    const scheduled =
      row.preset &&
      isCurrentPreset(row.parameters, row.catalog_version, row.query_key, requestStartedAt);
    if (row.preset && !scheduled && row.generated_at && row.queued_at <= row.generated_at) {
      await cleanup(null, { retire: true });
      return true;
    }
    {
      const metadata = await warehouseReportMetadata(site.id);
      const settings = await readOverviewSettings([site.id]);
      const current = overviewControl(metadata, settings.get(site.id));
      round = await acquireReportRound(
        row,
        metadata,
        current.version,
        formatVersion,
        requestStartedAt,
      );
      cutoff = offlineReportCutoff(+round.cutoff_at);
      // The lease owns this row. A resumed older round or a clock adjustment
      // must not replace a valid published result with an earlier cutoff.
      if (
        row.saved_through !== null &&
        row.saved_through > cutoff &&
        hasCurrentResult(row, current)
      ) {
        await cleanup(null, {
          covered: true,
          retryAt: Math.max(requestStartedAt + 5000, row.saved_through + offlineReportLagMs),
        });
        return true;
      }
    }
    const savedRanking = row.result && 'rankings' in row.result ? row.result.rankings : undefined;
    const resumeRanking = !!(
      savedRanking?.pending &&
      round &&
      savedRanking.round === round.id &&
      String(row.publication) === String(round.publication) &&
      row.control_version === round.control_version
    );
    const { value, control } = await captureReportTimings(
      () =>
        withPublishedRegistry(
          () =>
            withinWarehouseReport(
              async () => {
                const control = await readOverviewControl(site.id);
                if (round && control.version !== round.control_version)
                  throw new LiekanError('统计条件已变更', 410, 'analysis-invalidated');
                if (!scheduled && control.version !== row.control_version)
                  throw new LiekanError('统计条件已变更', 410, 'analysis-invalidated');
                if (scheduled && control.version !== row.control_version) {
                  const claimed = await db.read(
                    `UPDATE liekan_warehouse_overview_snapshot SET control_version=$4,result=NULL,generated_at=NULL,publication=NULL
                    WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND control_version=$3 RETURNING id`,
                    [row.id, token, row.control_version, control.version],
                  );
                  if (!claimed.length)
                    throw new LiekanError('统计条件已变更', 410, 'analysis-invalidated');
                  row.control_version = control.version;
                }
                // Immutable analysis buckets are reusable across every page and range.
                // The existing worker lease owns construction; no HTTP reader builds.
                const end = new Date(Math.min(row.parameters.endAt, cutoff));
                const start = new Date(
                  Math.max(
                    row.parameters.startAt - (row.parameters.endAt - row.parameters.startAt + 1),
                    cutoff - analysisModelDays * 86400000,
                  ),
                );
                const kinds = reportAnalysisKinds(row.parameters);
                const store = round ? reportRoundBuild(round, { id: row.id, token }) : undefined;
                const prepared = await timeReportQuery('analysis-prepare', () =>
                  prepareAnalysisModel(site.id, start, end, {
                    kinds,
                    completeThrough: cutoff,
                    prepared: round?.prepared ?? undefined,
                    buildStore: store,
                    onCheckpoint: round ? value => saveRoundPreparation(round, value) : undefined,
                  }),
                );
                await warehouseReportCheckpoint(store);
                const captured = await withRoundMetrics(
                  round?.id,
                  () =>
                    withVerifiedAnalysisRead(
                      prepared && {
                        ...prepared,
                        browser: kinds.includes('browser') ? prepared.browser : [],
                        log: kinds.includes('log') ? prepared.log : [],
                      },
                      async () =>
                        row.parameters.siteSummary
                          ? computeWebsiteSummary(site, row.parameters, cutoff).then(row => ({
                              kind: 'site-summary' as const,
                              row,
                              dataThrough: Math.min(end.getTime(), cutoff),
                            }))
                          : row.parameters.nativeRetention
                            ? computeWarehouseRetention(
                                site.id,
                                row.parameters,
                                row.parameters.nativeRetention,
                                cutoff,
                              )
                            : captureReportRankings(
                                site.id,
                                row.id,
                                () =>
                                  withDashboardClock(
                                    cutoff,
                                    () => computeWarehouseOverview(site, row.parameters),
                                    scheduled
                                      ? row.generated_at
                                        ? 'refresh'
                                        : 'first'
                                      : undefined,
                                  ),
                                {
                                  round: round?.id,
                                  previous: resumeRanking ? savedRanking : undefined,
                                  shouldPause: async () =>
                                    !!(await warehouseBackgroundClaimAfter()),
                                },
                              ),
                    ),
                  round ? reportRoundMetrics(round) : undefined,
                );
                const value =
                  'kind' in captured
                    ? captured
                    : {
                        ...(resumeRanking ? row.result : captured.value),
                        rankings: captured.rankings,
                      };
                if (
                  'rankings' in value &&
                  'meta' in value &&
                  value.rankings &&
                  !value.rankings.pending
                )
                  await prefillReportRankings(
                    site.id,
                    row.id,
                    value.rankings,
                    value.meta.tablePages,
                  );
                return { value, control };
              },
              {
                deadline: requestStartedAt + 75000,
                background: true,
                signal,
                ...(round
                  ? { publication: { websiteId: site.id, publication: String(round.publication) } }
                  : {}),
              },
            ),
          row.catalog_version,
        ),
      timings,
    );
    signal.throwIfAborted();
    if ((await readOverviewControl(site.id)).version !== control.version)
      throw new LiekanError('统计条件已变更', 410, 'analysis-invalidated');
    signal.throwIfAborted();
    const published = await db.transaction(async tx => {
      const { rows } = await tx.query(
        `UPDATE liekan_warehouse_overview_snapshot
       SET result=$4,publication=$5,generated_at=CASE WHEN $12 THEN generated_at ELSE greatest(now(),queued_at) END,
         control_version=$7,preset=preset AND $8,
         next_attempt_at=CASE WHEN $13 THEN now()+interval '5 seconds' ELSE CASE WHEN preset AND $8 THEN
           date_bin($6::bigint*interval '1 millisecond',
             greatest(now(),queued_at)+$10::interval,to_timestamp($9::double precision/1000))
           ELSE now() END+$6::bigint*interval '1 millisecond' END,
         lease_token=NULL,lease_until=NULL,error_code=NULL
       WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND control_version=$3
         AND ($11::uuid IS NULL OR EXISTS (
           SELECT 1 FROM liekan_warehouse_report_round round JOIN liekan_warehouse_reference ref
             ON ref.reference_id=round.reference_id
           WHERE round.id=$11 AND round.control_version=$7 AND ref.expires_at>clock_timestamp()))
       RETURNING id`,
        [
          row.id,
          token,
          row.control_version,
          value,
          control.publication,
          refreshInterval(row),
          control.version,
          scheduled,
          presetRefreshPhase(row.website_id),
          minimumPresetRefreshGap,
          round?.id ?? null,
          resumeRanking,
          'rankings' in value && !!value.rankings?.pending,
        ],
      );
      if (rows.length && round && !('rankings' in value && value.rankings?.pending))
        await finishReportRound(round, row.id, tx);
      return rows;
    });
    // The publication fence can reject a result after a concurrent request invalidated it.
    if (!published.length) await cleanup(null);
    if (published.length) {
      committedAtMs = Date.now();
      rankingPending = 'rankings' in value && !!value.rankings?.pending;
      outcome = 'ready';
    }
  } catch (error) {
    const deferred =
      error instanceof WarehouseBackgroundDeferred ||
      (error instanceof WarehouseConflict &&
        ['warehouse-control-busy', 'warehouse-control-unavailable'].includes(error.code));
    const invalidated = error instanceof LiekanError && error.code === 'analysis-invalidated';
    if (!deferred) reason = analysisErrorReason(error);
    await cleanup(
      signal?.aborted || deferred
        ? null
        : invalidated
          ? 'analysis-invalidated'
          : 'warehouse-overview-unavailable',
      {
        retire: invalidated && !row.preset,
        retryAt: deferred
          ? ((error instanceof WarehouseBackgroundDeferred ? error.retryAt : undefined) ??
            Date.now() + 5000)
          : undefined,
      },
    );
    outcome = deferred ? 'deferred' : invalidated || signal?.aborted ? 'discarded' : 'failed';
  } finally {
    if (outcome === 'failed' || outcome === 'deferred' || Object.keys(timings).length)
      console.info(
        JSON.stringify({
          event: 'warehouse-overview-compute',
          taskId: row.id,
          roundId: round?.id,
          dataThrough: cutoff,
          resource: row.parameters.siteSummary ? 'website-summary' : row.parameters.resource,
          period: row.parameters.chartPeriod,
          attemptDueAtMs: +row.next_attempt_at,
          startedAtMs: requestStartedAt,
          committedAtMs,
          rankingPending,
          outcome,
          reason,
          queuedOverdueMs: Math.max(0, requestStartedAt - +row.next_attempt_at),
          wallMs: Math.round(performance.now() - started),
          queryGroups: timings,
        }),
      );
  }
  return true;
}

/** Same durable scheduler and lease as page reports; no foreground retention scan. */
export function requestWarehouseRetention(
  access: Access,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const { startAt, endAt, timezone, unit: _unit, refresh, ...raw } = input;
  const conditions = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''),
  );
  const retentionRanges = presetParameters(String(timezone || ACCOUNT_DEFAULT_TIMEZONE), Date.now(), true);
  // On a month end the rolling range may coincide with the native calendar
  // month. Prefer the scheduled month when both describe exactly the same data.
  const preset = retentionRanges.findLast(
    p => 'nativeRetention' in p && p.startAt === Number(startAt) && p.endAt === Number(endAt),
  );
  return requestWarehouseOverview(
    access,
    {
      resource: 'human/overview',
      startAt,
      endAt,
      timezone,
      refresh,
      chartPeriod: preset?.chartPeriod ?? 'today',
    },
    signal,
    conditions,
  );
}
