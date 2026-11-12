import { createHash, randomUUID } from 'node:crypto';
import { ACCOUNT_DEFAULT_TIMEZONE, validateTimezone } from '../contracts/account-preferences';
import type { AnalysisJob } from '../contracts/analysis-acceleration';
import type { LiekanPageReport } from '../contracts/page-report';
import { parseReportQuery, type ReportQuery } from '../contracts/query';
import { getPublishedCatalog } from '../crawlers/published';
import { reportLogRange } from '../report-log-tables';
import { warehouseReader } from '../warehouse/reader-runtime';
import { readReportingMetadataForSites } from '../warehouse/reporting-context';
import type { ReportingMetadata } from '../warehouse/reporting-relations';
import {
  analysisErrorReason,
  captureReportTimings,
  type ReportTimings,
} from './analysis-diagnostics';
import { analysisQueryLimits } from './analysis-query-model';
import { analysisResponse } from './analysis-query-api';
import { AnalyticsUnavailable } from './analytics-budget';
import { noteBrowserPopulation } from './cache-context';
import { loadPublishedRegistry, withPublishedRegistry } from './crawler-registry-context';
import { withDashboardClock } from './dashboard-clock';
import { dashboardWarmRanges } from './dashboard-snapshot-model';
import { LiekanError } from './errors';
import { computeWarehouseOverview } from './page-report';
import type { authorize } from './server';
import { warehouseLogWindowHasFacts } from './warehouse-log-queries';
import { prepareWarehouseOverviewLogSegments } from './warehouse-overview-log-segments';
import {
  warehouseControlFingerprint,
  warehouseReportMetadata,
  withinWarehouseReport,
} from './warehouse-report-snapshot';

// Change when persisted results can no longer be read with the current report semantics.
const formatVersion = 1;
const intervalMs = 30 * 60 * 1000;
const minimumPresetRefreshGap = '10 minutes';
const discoveryIntervalMs = 30000;
const discoveryBatch = 48;
const claimsBetweenBackfills = 4;
const controlScanIntervalMs = 10000;
const withoutTablePages = "coalesce(parameters->'tablePages','{}'::jsonb)='{}'::jsonb";
let nextDiscoveryAt = 0;
let scheduledCatalog: string | undefined;
let nextControlScanAt = 0;
let lastScannedSite: string | null = null;
let lastBackfillSnapshot: string | null = null;
type Access = Awaited<ReturnType<typeof authorize>>;
type Snapshot = {
  id: string;
  website_id: string;
  query_key: string;
  preset: boolean;
  catalog_version: string;
  parameters: ReportQuery;
  control_version: string;
  publication: string | null;
  result: LiekanPageReport | null;
  generated_at: Date | null;
  queued_at: Date;
  started_at: Date | null;
  next_attempt_at: Date;
  lease_until: Date | null;
  error_code: string | null;
};
type OverviewClaim = { row: Snapshot; token: string };
function overviewKey(p: ReportQuery, catalogVersion: string) {
  return createHash('sha256')
    .update(JSON.stringify([formatVersion, catalogVersion, p]))
    .digest('hex');
}

function presetRefreshPhase(websiteId: string) {
  // Keep a site's timezones and preset ranges on the same recurring schedule.
  return createHash('sha256').update(websiteId).digest().readUInt32BE() % intervalMs;
}

function presetParameters(timezone: string, now: number) {
  return dashboardWarmRanges(timezone, now).map((range, i) => {
    const parsed = parseReportQuery({
      resource: 'overview',
      chartPeriod: ['today', '7d', '30d'][i],
      ...range,
      timezone,
    });
    if (!parsed.success) throw new Error('Invalid overview preset');
    return parsed.data;
  });
}

function isCurrentPreset(p: ReportQuery, catalog: string, key: string, now = Date.now()) {
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
      presetParameters(timezone, now).map(parameters => ({
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
  scheduledCatalog = version;
  nextDiscoveryAt = scheduled.length < discoveryBatch ? now + discoveryIntervalMs : now;
  return version;
}

async function readSnapshot(
  websiteId: string,
  selector: { queryKey: string } | { id: string },
  includeResult: boolean,
) {
  const [row] = await warehouseReader().db.read<Snapshot>(
    `SELECT id,website_id,parameters,preset,catalog_version,control_version,publication,generated_at,queued_at,started_at,
      next_attempt_at,lease_until,error_code,CASE WHEN $4 THEN result END AS result
      FROM liekan_warehouse_overview_snapshot WHERE website_id=$1 AND
      ${'id' in selector ? 'id=$2' : 'query_key=$2'} AND format_version=$3`,
    [websiteId, 'id' in selector ? selector.id : selector.queryKey, formatVersion, includeResult],
  );
  return row;
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

function presented(row: Snapshot, access: Access, updating: boolean) {
  const { result } = row;
  return {
    ...result,
    website: access.website,
    meta: {
      ...result.meta,
      canManage: access.canManage,
      expiresAt: updating || row.error_code ? Date.now() : snapshotExpiry(row),
      snapshot: {
        ...result.meta.snapshot,
        intervalMs,
        state: updating ? ('updating' as const) : ('ready' as const),
        ...(row.error_code ? { updateError: true } : {}),
      },
    },
  };
}

async function ready(
  row: Snapshot,
  access: Access,
  tablePages: ReportQuery['tablePages'] = {},
  signal?: AbortSignal,
) {
  const value = presented(row, access, false);
  const table = value.meta.aiCrawlerEnabled === false ? 'visitorTopBody' : 'topBody';
  const current = value.meta.tablePages?.[table];
  const page = tablePages[table];
  if (current && page && page !== current.page) {
    const site = row.website_id;
    const cutoff = value.meta.snapshot.dataThrough;
    const rows =
      (page - 1) * current.pageSize >= current.total
        ? []
        : await withinWarehouseReport(
            async () => {
              if (!hasCurrentResult(row, await readOverviewControl(site)))
                throw new LiekanError('统计条件已变更，请重新读取', 410, 'analysis-invalidated');
              const { readWarehouseOverviewRankingPage } = await import(
                './warehouse-browser-page-report'
              );
              return withDashboardClock(cutoff, () =>
                readWarehouseOverviewRankingPage(site, row.parameters, value, table, page),
              );
            },
            {
              publication: { websiteId: site, publication: row.publication },
              deadline: Date.now() + 55000,
              signal,
            },
          );
    if (!hasCurrentResult(row, await readOverviewControl(site)))
      throw new LiekanError('统计条件已变更，请重新读取', 410, 'analysis-invalidated');
    value.tables = { ...value.tables, [table]: rows };
    value.meta.tablePages = { ...value.meta.tablePages, [table]: { ...current, page } };
  }
  for (const population of [value.meta.population, value.meta.trendPopulation])
    if (population) noteBrowserPopulation(access.website.id, population);
  const response = analysisResponse({
    ready: true,
    value,
    generatedAt: value.meta.generatedAt,
    expiresAt: value.meta.expiresAt,
  });
  response.headers.set('X-Liekan-Read-Path', 'published');
  response.headers.set('X-Liekan-Data-Through', String(value.meta.snapshot.dataThrough));
  response.headers.set('X-Liekan-Warehouse-Publication', row.publication);
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
  const response = analysisResponse({
    ready: false,
    analysisJob: job(row, activeLease(row) ? 'running' : 'queued'),
    ...(previousResult ? { previousResult } : {}),
  });
  response.headers.set('X-Liekan-Read-Path', 'queued');
  return response;
}

export function warehouseOverviewAsyncRequested(request: Request, query: URLSearchParams) {
  return (
    query.get('resource') === 'overview' &&
    request.headers
      .get('prefer')
      ?.split(',')
      .some(value => value.trim() === 'respond-async')
  );
}

export async function requestWarehouseOverview(
  access: Access,
  input: unknown,
  signal?: AbortSignal,
) {
  const parsed = parseReportQuery(input);
  if (!parsed.success || parsed.data.resource !== 'overview') throw new LiekanError('统计参数无效');
  const { refresh, ...requested } = parsed.data;
  const tablePages = requested.tablePages;
  const parameters = { ...requested, tablePages: {} };
  reportLogRange(parameters);
  if (parameters.startAt >= Date.now()) throw new LiekanError('日期范围无效');
  const catalogVersion = getPublishedCatalog()?.version;
  if (!catalogVersion) throw new LiekanError('统计目录暂不可用', 503);
  const queryKey = overviewKey(parameters, catalogVersion);
  const site = access.website.id;
  const db = warehouseReader().db;
  const existing = await readSnapshot(site, { queryKey }, true);
  // Read the authoritative control version after loading the candidate response.
  const control = await readOverviewControl(site);
  const previous = existing && hasCurrentResult(existing, control) ? existing : undefined;
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
    if (previous) return ready(previous, access, tablePages, signal);
    if ((await loadPublishedRegistry()).version !== catalogVersion)
      throw new LiekanError('统计任务已过期，请重新读取', 410, 'analysis-expired');
    return Response.json(
      { status: 'scheduled' },
      { status: 202, headers: { 'Retry-After': '5', 'X-Liekan-Read-Path': 'scheduled' } },
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
    return ready(previous, access, tablePages, signal);
  }
  const pending = await db.transaction(async tx => {
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
    )
      throw new AnalyticsUnavailable(
        '后台统计任务已达上限，请等待当前任务完成',
        5,
        429,
        'analysis-concurrency-limited',
      );
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
      [
        randomUUID(),
        site,
        queryKey,
        parameters,
        catalogVersion,
        formatVersion,
        false,
        control.version,
      ],
    );
    return rows[0];
  });
  // An old lease retains the global worker slot until its work settles, even after invalidation.
  if (pending.error_code && !previous)
    throw new LiekanError('后台统计计算失败，请稍后重试', 503, pending.error_code);
  return accepted(
    pending,
    previous && !(tablePages.topBody > 1 || tablePages.visitorTopBody > 1)
      ? presented(previous, access, true)
      : undefined,
  );
}

export async function readWarehouseOverviewJob(
  access: Access,
  id: string,
  result: boolean,
  query?: URLSearchParams,
  signal?: AbortSignal,
) {
  const row = await readSnapshot(access.website.id, { id }, result);
  if (
    !row ||
    row.catalog_version !== getPublishedCatalog()?.version ||
    Object.keys(row.parameters.tablePages ?? {}).length
  )
    throw new LiekanError('统计任务已过期，请重新读取', 410, 'analysis-expired');
  const control = await readOverviewControl(access.website.id);
  const sameControl = row.control_version === control.version;
  const readable =
    hasCurrentResult(row, control) && (row.error_code || row.queued_at <= row.generated_at);
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
  if (status === 'ready') {
    const topBody = query?.get('tp_topBody');
    const visitorTopBody = query?.get('tp_visitorTopBody');
    const input = parseReportQuery({
      ...row.parameters,
      ...(topBody == null ? {} : { tp_topBody: topBody }),
      ...(visitorTopBody == null ? {} : { tp_visitorTopBody: visitorTopBody }),
    });
    if (!input.success) throw new LiekanError('统计参数无效');
    return ready(row, access, input.data.tablePages, signal);
  }
  if (status === 'queued' || status === 'running') return accepted(row);
  throw new LiekanError(
    '统计结果暂不可读取，请重新查询',
    status === 'failed' ? 503 : 410,
    row.error_code ?? 'analysis-invalidated',
  );
}

export async function pumpWarehouseOverview(signal?: AbortSignal) {
  return Boolean(await pumpOverviewBatch(1, 1, signal));
}

export async function drainWarehouseOverview(signal: AbortSignal) {
  if (signal.aborted) return;
  const lanes = Math.min(2, warehouseReader().admission.concurrency);
  let nextBackfill = claimsBetweenBackfills;
  for (let processed = 0; processed < discoveryBatch && !signal.aborted; ) {
    const count = await pumpOverviewBatch(
      Math.min(nextBackfill - processed, discoveryBatch - processed),
      lanes,
      signal,
    );
    processed += count;
    if (!count || processed === nextBackfill) {
      await pumpOverviewLogBackfill(signal);
      nextBackfill += claimsBetweenBackfills;
    }
    if (!count) break;
  }
}

async function pumpOverviewBatch(limit: number, lanes: number, signal?: AbortSignal) {
  if (signal?.aborted) return 0;
  // Older workers and the backfill use the same key. Release it only after
  // every claimed computation has settled, even if its recovery lease expires.
  return warehouseReader().db.withAdvisoryLock(12800001, 92, lockSignal =>
    runOverviewBatch(limit, lanes, signal ? AbortSignal.any([signal, lockSignal]) : lockSignal),
  );
}

async function runOverviewBatch(limit: number, lanes: number, signal: AbortSignal) {
  const catalog = await prepareOverviewQueue(signal);
  const first = await claimOverview(catalog, signal, [], false);
  if (!first) return 0;
  if (lanes === 1 || !first.row.preset || first.row.generated_at) {
    await computeOverviewClaim(first, signal);
    return 1;
  }

  type Settlement = { token: string; failure?: { error: unknown } };
  const running = new Map<string, { claim: OverviewClaim; settled: Promise<Settlement> }>();
  const start = (claim: OverviewClaim) => {
    const { token } = claim;
    running.set(token, {
      claim,
      settled: computeOverviewClaim(claim, signal).then(
        () => ({ token }),
        error => ({ token, failure: { error } }),
      ),
    });
  };
  let claimed = 1;
  start(first);
  try {
    while (running.size) {
      if (!signal.aborted && claimed < limit && running.size < lanes) {
        const next = await claimOverview(
          catalog,
          signal,
          [...running.values()].map(entry => entry.claim),
          true,
        );
        if (next) {
          start(next);
          claimed++;
          continue;
        }
      }
      const settled = await Promise.race([...running.values()].map(entry => entry.settled));
      running.delete(settled.token);
      if (settled.failure) throw settled.failure.error;
    }
  } finally {
    await Promise.all([...running.values()].map(entry => entry.settled));
  }
  return claimed;
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
         AND job.parameters->>'chartPeriod'='30d'
         AND (job.parameters->>'endAt')::bigint >= extract(epoch FROM now())*1000
         AND NOT EXISTS (SELECT 1 FROM liekan_warehouse_overview_snapshot WHERE lease_until>now())
         AND s.resource_type='website' AND s.state='active' AND w.deleted_at IS NULL
         AND ${presetTimezoneForSite("job.parameters->>'timezone'")}
         AND ($4::uuid IS NULL OR job.id>$4) ORDER BY job.id LIMIT 1`,
      [ACCOUNT_DEFAULT_TIMEZONE, formatVersion, scheduledCatalog, lastBackfillSnapshot],
    );
    lastBackfillSnapshot = row?.id ?? null;
    const cutoff = Date.now();
    if (!row || !isCurrentPreset(row.parameters, row.catalog_version, row.query_key, cutoff))
      return;
    try {
      await withinWarehouseReport(
        () =>
          withDashboardClock(
            cutoff,
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
        { signal: workSignal, deadline: cutoff + 40000 },
      );
    } catch (error) {
      workSignal.throwIfAborted();
      if (analysisErrorReason(error) !== 'timeout') throw error;
      console.info(
        JSON.stringify({ event: 'warehouse-overview-backfill-deferred', reason: 'timeout' }),
      );
    }
  });
}

async function prepareOverviewQueue(signal: AbortSignal) {
  signal.throwIfAborted();
  const db = warehouseReader().db;
  const catalog = await scheduleOverviewPresets(Date.now());
  await db.read(`DELETE FROM liekan_warehouse_overview_snapshot WHERE id IN (
      SELECT id FROM liekan_warehouse_overview_snapshot
      WHERE last_requested_at<now()-interval '1 day'
        AND (NOT preset OR (parameters->>'endAt')::bigint < extract(epoch FROM now()-interval '1 day')*1000)
        AND (lease_until IS NULL OR lease_until<=now())
      ORDER BY last_requested_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
  return catalog;
}

async function claimOverview(
  catalog: string,
  signal: AbortSignal,
  running: OverviewClaim[],
  coldOnly: boolean,
) {
  signal.throwIfAborted();
  await reconcileOverviewControls(catalog, signal);
  signal.throwIfAborted();
  const db = warehouseReader().db;
  const token = randomUUID();
  const longRunning = running.some(claim => claim.row.parameters.chartPeriod === '30d');
  const [row] = await db.read<Snapshot>(
    `WITH due AS (
        SELECT job.id FROM liekan_warehouse_overview_snapshot job
        JOIN liekan_warehouse_site s USING (website_id)
        JOIN website w USING (website_id)
        WHERE format_version=$2 AND next_attempt_at<=now() AND ${withoutTablePages}
          AND s.state='active' AND w.deleted_at IS NULL
          AND (
            (preset AND catalog_version=$4 AND ${presetTimezoneForSite("job.parameters->>'timezone'")}
              AND (job.parameters->>'endAt')::bigint >= extract(epoch FROM now())*1000)
            OR (NOT preset AND error_code IS NULL AND last_requested_at>=now()-interval '1 day'
              AND (generated_at IS NULL OR queued_at>generated_at))
          )
          AND NOT (job.website_id=ANY($5::uuid[]))
          AND NOT ($8::boolean AND job.preset AND job.generated_at IS NULL
            AND job.parameters->>'chartPeriod'='30d')
          AND NOT EXISTS (
            SELECT 1 FROM liekan_warehouse_overview_snapshot active
            WHERE active.lease_until>now() AND (
              active.lease_token IS NULL OR NOT (active.lease_token=ANY($6::uuid[]))
            )
          )
        ORDER BY CASE
          WHEN preset AND generated_at IS NOT NULL AND queued_at>generated_at THEN 0
          WHEN preset AND generated_at IS NULL THEN 1
          WHEN preset THEN 2 ELSE 3 END,
          next_attempt_at,
          CASE WHEN $9::boolean AND preset AND generated_at IS NULL
            AND job.parameters->>'chartPeriod'='30d' THEN 0 ELSE 1 END,
          CASE WHEN $9::boolean AND preset AND generated_at IS NULL
            AND job.parameters->>'chartPeriod'='30d' THEN s.publication END DESC NULLS LAST,
          CASE WHEN preset THEN CASE job.parameters->>'chartPeriod'
            WHEN 'today' THEN 0 WHEN '7d' THEN 1 ELSE 2 END ELSE 0 END,
          job.website_id,
          job.id
        LIMIT 1 FOR UPDATE OF job SKIP LOCKED
      ) UPDATE liekan_warehouse_overview_snapshot snapshot
      SET started_at=now(),lease_token=$3,lease_until=now()+interval '3 minutes',error_code=NULL
      FROM due WHERE snapshot.id=due.id
        AND (NOT $7::boolean OR (snapshot.preset AND snapshot.generated_at IS NULL))
      RETURNING snapshot.*`,
    [
      ACCOUNT_DEFAULT_TIMEZONE,
      formatVersion,
      token,
      catalog,
      running.map(claim => claim.row.website_id),
      running.map(claim => claim.token),
      coldOnly,
      longRunning,
      running.length > 0 && !longRunning,
    ],
  );
  return row ? { row, token } : undefined;
}

async function computeOverviewClaim({ row, token }: OverviewClaim, signal: AbortSignal) {
  const db = warehouseReader().db;
  const cutoff = Date.now();
  const timings: ReportTimings = {};
  const started = performance.now();
  let outcome = 'discarded';
  const cleanup = async (errorCode: string | null, retire = false) =>
    db.read(
      `UPDATE liekan_warehouse_overview_snapshot SET lease_token=NULL,lease_until=NULL,
        error_code=CASE WHEN control_version=$3 THEN $4 ELSE error_code END,
        next_attempt_at=CASE WHEN control_version=$3 AND $4 IS NOT NULL
          THEN now()+interval '1 minute' ELSE next_attempt_at END,
        preset=CASE WHEN control_version=$3 AND $5 THEN false ELSE preset END
        WHERE id=$1 AND lease_token=$2`,
      [row.id, token, row.control_version, errorCode, retire],
    );
  try {
    const [site] = await db.read<{ id: string; name: string; domain: string }>(
      'SELECT website_id AS id,name,domain FROM website WHERE website_id=$1 AND deleted_at IS NULL',
      [row.website_id],
    );
    if (!site) {
      await cleanup('analysis-invalidated', true);
      return true;
    }
    const scheduled =
      row.preset && isCurrentPreset(row.parameters, row.catalog_version, row.query_key, cutoff);
    if (row.preset && !scheduled && row.generated_at && row.queued_at <= row.generated_at) {
      await cleanup(null, true);
      return true;
    }
    const { value, control } = await captureReportTimings(
      () =>
        withPublishedRegistry(
          () =>
            withinWarehouseReport(
              async () => {
                const control = await readOverviewControl(site.id);
                if (!scheduled && control.version !== row.control_version)
                  throw new LiekanError('统计条件已变更', 410, 'analysis-invalidated');
                const value = await withDashboardClock(
                  cutoff,
                  () => computeWarehouseOverview(site, row.parameters),
                  scheduled ? (row.generated_at ? 'refresh' : 'first') : undefined,
                );
                return { value, control };
              },
              { deadline: cutoff + 75000, signal },
            ),
          row.catalog_version,
        ),
      timings,
    );
    signal.throwIfAborted();
    if ((await readOverviewControl(site.id)).version !== control.version)
      throw new LiekanError('统计条件已变更', 410, 'analysis-invalidated');
    signal.throwIfAborted();
    const published = await db.read(
      `UPDATE liekan_warehouse_overview_snapshot
       SET result=$4,publication=$5,generated_at=greatest(now(),queued_at),
         control_version=$7,preset=$8,
         next_attempt_at=CASE WHEN $8 THEN
           date_bin($6::bigint*interval '1 millisecond',
             greatest(now(),queued_at)+$10::interval,to_timestamp($9::double precision/1000))
           ELSE now() END+$6::bigint*interval '1 millisecond',
         lease_token=NULL,lease_until=NULL,error_code=NULL
       WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND control_version=$3
       RETURNING id`,
      [
        row.id,
        token,
        row.control_version,
        value,
        control.publication,
        intervalMs,
        control.version,
        scheduled,
        presetRefreshPhase(row.website_id),
        minimumPresetRefreshGap,
      ],
    );
    // The publication fence can reject a result after a concurrent request invalidated it.
    if (!published.length) await cleanup(null);
    if (published.length) outcome = 'ready';
  } catch (error) {
    const invalidated = error instanceof LiekanError && error.code === 'analysis-invalidated';
    await cleanup(
      signal?.aborted
        ? null
        : invalidated
          ? 'analysis-invalidated'
          : 'warehouse-overview-unavailable',
      invalidated && !row.preset,
    );
    outcome = invalidated || signal?.aborted ? 'discarded' : 'failed';
  } finally {
    if (Object.keys(timings).length)
      console.info(
        JSON.stringify({
          event: 'warehouse-overview-compute',
          taskId: row.id,
          period: row.parameters.chartPeriod,
          outcome,
          wallMs: Math.round(performance.now() - started),
          queryGroups: timings,
        }),
      );
  }
  return true;
}
