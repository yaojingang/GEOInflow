import { createHash } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { LiekanError } from '../upstream/errors';
import { queryV2Json } from './client';
import { humanPathFromEncoded, normalizeHost, toV2Timestamp } from './ingest';
import { browserPathStates, logPathStates, v2Tables } from './schema';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const HOUR_MS = 3_600_000;
const OBSERVATION_FIELDS = ['accept', 'language', 'site', 'mode', 'dest'] as const;

export type PgReadClient = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type V2ControlContext = {
  websiteId: string;
  domain: string;
  epoch: string;
  policyMode: string;
  policyRevision: string;
  allowedHostnames: string[];
  catalogVersion: string;
  sources: { id: string; kind: string; domain: string; state: string }[];
  browserConnected: boolean;
};

/**
 * Stateless single-query PG control snapshot:
 * - Zero row locks (no FOR SHARE / FOR KEY SHARE / FOR NO KEY UPDATE)
 * - Zero PG writes (no read_reference INSERT/DELETE)
 * - Zero end-of-request REPEATABLE READ double-check
 */
export async function readV2ControlContext(
  pg: PgReadClient,
  websiteId: string,
  userId?: string | null,
  options?: { internalBypassAuth?: boolean },
): Promise<(V2ControlContext & { deletionRevision: string }) | null> {
  const bypassAuth = options?.internalBypassAuth === true;
  const normalizedUserId =
    typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
  if (!bypassAuth && !normalizedUserId) return null;

  const { rows } = await pg.query<{
    website_id: string;
    domain: string;
    epoch: string;
    deletion_revision: string;
    deletion_pending: boolean;
    policy_mode: string;
    policy_revision: string;
    allowed_hostnames: string[] | null;
    catalog_version: string;
    sources: { id: string; kind: string; domain: string; state: string }[] | null;
    authorized: boolean;
  }>(
    `SELECT
      w.website_id::text AS website_id,
      w.domain,
      coalesce(ls.epoch, 1)::text AS epoch,
      coalesce(d.revision, 0)::text AS deletion_revision,
      d.pending_kind IS NOT NULL AS deletion_pending,
      coalesce(cp.mode, 'standard') AS policy_mode,
      coalesce(cp.revision, 0)::text AS policy_revision,
      coalesce(cp.allowed_hostnames, ARRAY[]::text[]) AS allowed_hostnames,
      coalesce(
        (SELECT max(updated_at)::text || ':' || count(*)::text FROM liekan_catalog c WHERE c.website_id = w.website_id),
        'empty:0'
      ) AS catalog_version,
      coalesce(
        (SELECT json_agg(json_build_object('id', s.id, 'kind', s.kind, 'domain', s.domain, 'state', s.state) ORDER BY s.id)
         FROM liekan_log_source s WHERE s.website_id = w.website_id),
        '[]'::json
      ) AS sources,
      CASE
        WHEN $3::boolean THEN true
        WHEN $2::uuid IS NULL THEN false
        WHEN (w.user_id IS NULL) = (w.team_id IS NULL) THEN false
        WHEN NOT EXISTS (SELECT 1 FROM "user" u WHERE u.user_id = $2::uuid AND u.deleted_at IS NULL) THEN false
        WHEN w.user_id = $2::uuid THEN true
        WHEN EXISTS (SELECT 1 FROM "user" u WHERE u.user_id = $2::uuid AND u.deleted_at IS NULL AND u.role = 'admin') THEN true
        WHEN w.team_id IS NOT NULL AND EXISTS (
          SELECT 1
          FROM team_user tu
          JOIN team t ON t.team_id = tu.team_id AND t.deleted_at IS NULL
          JOIN "user" u ON u.user_id = tu.user_id AND u.deleted_at IS NULL
          WHERE tu.team_id = w.team_id AND tu.user_id = $2::uuid
        ) THEN true
        ELSE false
      END AS authorized
    FROM website w
    LEFT JOIN liekan_v2_evidence_deletion d ON d.website_id = w.website_id
    LEFT JOIN liekan_log_state ls ON ls.website_id = w.website_id
    LEFT JOIN liekan_collection_policy cp ON cp.website_id = w.website_id
    WHERE w.website_id = $1::uuid AND w.deleted_at IS NULL`,
    [websiteId, normalizedUserId, bypassAuth],
  );

  const row = rows[0];
  if (!row || !row.authorized) return null;
  if (row.deletion_pending) throw new LiekanError('站点统计正在清理，请稍后重试', 503);

  return {
    websiteId: row.website_id,
    domain: row.domain,
    epoch: row.epoch,
    deletionRevision: row.deletion_revision,
    policyMode: row.policy_mode,
    policyRevision: row.policy_revision,
    allowedHostnames: row.allowed_hostnames ?? [],
    catalogVersion: row.catalog_version,
    sources: row.sources ?? [],
    browserConnected: true,
  };
}

/**
 * Lock-free single-query website/team authorization recheck on the dedicated v2 PG read pool.
 * Guards against mid-query team removal, account deletion, or website deletion without
 * contending on Prisma interactive transaction slots.
 */
export async function verifyV2WebsiteAccess(
  pg: PgReadClient,
  websiteId: string,
  userId: string,
  initial: { epoch: string; deletionRevision: string },
): Promise<boolean> {
  const normalizedUserId = typeof userId === 'string' && userId.trim() ? userId.trim() : null;
  if (!normalizedUserId) return false;
  const { rows } = await pg.query<{
    authorized: boolean;
    epoch: string;
    deletion_revision: string;
    deletion_pending: boolean;
  }>(
    `SELECT
      coalesce(ls.epoch, 1)::text AS epoch,
      coalesce(d.revision, 0)::text AS deletion_revision,
      d.pending_kind IS NOT NULL AS deletion_pending,
      CASE
        WHEN (w.user_id IS NULL) = (w.team_id IS NULL) THEN false
        WHEN NOT EXISTS (SELECT 1 FROM "user" u WHERE u.user_id = $2::uuid AND u.deleted_at IS NULL) THEN false
        WHEN w.user_id = $2::uuid THEN true
        WHEN EXISTS (SELECT 1 FROM "user" u WHERE u.user_id = $2::uuid AND u.deleted_at IS NULL AND u.role = 'admin') THEN true
        WHEN w.team_id IS NOT NULL AND EXISTS (
          SELECT 1
          FROM team_user tu
          JOIN team t ON t.team_id = tu.team_id AND t.deleted_at IS NULL
          JOIN "user" u ON u.user_id = tu.user_id AND u.deleted_at IS NULL
          WHERE tu.team_id = w.team_id AND tu.user_id = $2::uuid
        ) THEN true
        ELSE false
      END AS authorized
    FROM website w
    LEFT JOIN liekan_log_state ls ON ls.website_id = w.website_id
    LEFT JOIN liekan_v2_evidence_deletion d ON d.website_id = w.website_id
    WHERE w.website_id = $1::uuid AND w.deleted_at IS NULL`,
    [websiteId, normalizedUserId],
  );
  const row = rows[0];
  if (!row?.authorized) return false;
  if (row.deletion_pending) throw new LiekanError('站点统计正在清理，请稍后重试', 503);
  if (row.epoch !== initial.epoch || row.deletion_revision !== initial.deletionRevision) {
    throw new LiekanError('站点统计已清理，请重新读取', 409);
  }
  return true;
}

type CachedCatalog = {
  key: string;
  paths: string[];
  mappings: {
    humanPath: string;
    encodedPaths: string[];
    ambiguous: boolean;
  }[];
  hash: string;
};

const catalogCache = new Map<string, CachedCatalog>();
const MAX_CATALOG_CACHE = 256;

export function buildCatalogMappings(paths: readonly string[]) {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const human = humanPathFromEncoded(path);
    const list = groups.get(human);
    if (!list) groups.set(human, [path]);
    else if (!list.includes(path)) list.push(path);
  }
  return [...groups.entries()].map(([humanPath, encodedPaths]) => ({
    humanPath,
    encodedPaths,
    ambiguous: encodedPaths.length > 1,
  }));
}

export async function readV2CatalogCached(
  pg: PgReadClient,
  websiteId: string,
  catalogVersion: string,
): Promise<CachedCatalog> {
  const key = `${websiteId}:${catalogVersion}`;
  const hit = catalogCache.get(key);
  if (hit) return hit;

  const { rows } = await pg.query<{ path: string; updated_at: Date }>(
    'SELECT path, updated_at FROM liekan_catalog WHERE website_id = $1::uuid ORDER BY path',
    [websiteId],
  );
  const paths = rows.map(r => r.path);
  const mappings = buildCatalogMappings(paths);
  const hash = createHash('sha256')
    .update(JSON.stringify(rows.map(r => ({ path: r.path, updatedAt: r.updated_at }))))
    .digest('hex');

  const entry: CachedCatalog = { key, paths, mappings, hash };
  if (catalogCache.size >= MAX_CATALOG_CACHE) {
    const firstKey = catalogCache.keys().next().value;
    if (firstKey) catalogCache.delete(firstKey);
  }
  catalogCache.set(key, entry);
  return entry;
}

export function clearV2CatalogCache(websiteId?: string) {
  if (!websiteId) {
    catalogCache.clear();
    return;
  }
  const prefix = `${websiteId}:`;
  for (const key of catalogCache.keys()) {
    if (key.startsWith(prefix)) catalogCache.delete(key);
  }
}

export type V2ObservationParams = {
  startAt: number;
  endAt: number;
  subset: 'raw' | 'eligible';
  observationVersion: string;
  page?: number;
  pageSize?: number;
  abortSignal?: AbortSignal;
};

export type V2ObservationResult = {
  totals: {
    pv: number;
    uv: number | null;
    visits: number | null;
    observed: number;
    notCollected: number;
    currentVersion: number;
    flaggedPv: number;
    flaggedUv: number | null;
    identityQualifiedPv: number;
    identityQualifiedVisitors: number;
    identityVersions: string[];
  };
  coverage: Record<string, { value: number | null; samples: number; total: number; state: string }>;
  rows: {
    browser: string;
    source: string;
    classification: string;
    version: string;
    features: Record<string, unknown> | null;
    pv: number;
    uv: number | null;
    smallSample: boolean;
    firstEventAt: string | null;
    lastEventAt: string | null;
  }[];
  totalGroups: number;
  lastReceivedAt: string | null;
  fingerprint: string;
};

function isHourAligned(ms: number): boolean {
  return ms % HOUR_MS === 0;
}

/**
 * Single ClickHouse query for Observation Evidence using native AggregatingMergeTree (ch_v2_observation_hour_agg).
 * Whole-hour queries scan only hundreds of pre-aggregated rows instead of hundreds of thousands of raw events.
 */
export async function queryV2Observations(
  ch: ClickHouseClient,
  control: V2ControlContext,
  params: V2ObservationParams,
): Promise<V2ObservationResult> {
  const startMs = params.startAt;
  const endMs = params.endAt;
  const aligned = isHourAligned(startMs) && isHourAligned(endMs);
  const eligibleClause = params.subset === 'eligible' ? 'AND is_eligible = true' : '';

  type RawRow = {
    is_total: string | number;
    browser: string;
    collection_source: string;
    classification: string;
    obs_version: string;
    obs_features: string;
    out_pv: string;
    out_uv: string;
    out_visits: string;
    observed: string;
    not_collected: string;
    current_version: string;
    flagged_pv: string;
    flagged_uv: string;
    id_pv: string;
    id_uv: string;
    id_versions: string[];
    f_accept: string;
    f_language: string;
    f_site: string;
    f_mode: string;
    f_dest: string;
    out_first_event_at: string | null;
    out_last_event_at: string | null;
    out_last_received_at: string | null;
  };

  let sql: string;
  const queryParams: Record<string, unknown> = {
    site: control.websiteId,
    epoch: control.epoch,
    start_ts: toV2Timestamp(startMs),
    end_ts: toV2Timestamp(endMs),
    obs_ver: params.observationVersion,
  };

  if (aligned) {
    sql = `
      SELECT
        grouping(browser) AS is_total,
        browser,
        collection_source,
        classification,
        obs_version,
        obs_features,
        toString(countMerge(pv)) AS out_pv,
        toString(uniqExactMerge(uv)) AS out_uv,
        toString(uniqExactMerge(visits)) AS out_visits,
        toString(countMergeIf(pv, has_observation)) AS observed,
        toString(countMergeIf(pv, NOT has_observation)) AS not_collected,
        toString(countMergeIf(pv, obs_version = {obs_ver:String})) AS current_version,
        toString(countMergeIf(pv, is_risk_flagged)) AS flagged_pv,
        toString(uniqExactMergeIf(uv, is_risk_flagged)) AS flagged_uv,
        toString(countMergeIf(pv, identity_qualified)) AS id_pv,
        toString(uniqExactMergeIf(uv, identity_qualified)) AS id_uv,
        arraySort(arrayFilter(x -> x != '', groupUniqArray(identity_version))) AS id_versions,
        toString(countMergeIf(pv, bitAnd(obs_mask, 1) > 0)) AS f_accept,
        toString(countMergeIf(pv, bitAnd(obs_mask, 2) > 0)) AS f_language,
        toString(countMergeIf(pv, bitAnd(obs_mask, 4) > 0)) AS f_site,
        toString(countMergeIf(pv, bitAnd(obs_mask, 8) > 0)) AS f_mode,
        toString(countMergeIf(pv, bitAnd(obs_mask, 16) > 0)) AS f_dest,
        minMerge(first_event_at) AS out_first_event_at,
        maxMerge(last_event_at) AS out_last_event_at,
        maxMerge(last_received_at) AS out_last_received_at
      FROM ${v2Tables.observationHourAgg}
      WHERE website_id = {site:UUID}
        AND epoch = {epoch:UInt64}
        AND received_hour >= toStartOfHour(parseDateTime64BestEffort({start_ts:String}, 6, 'UTC'))
        AND received_hour < toStartOfHour(parseDateTime64BestEffort({end_ts:String}, 6, 'UTC'))
        ${eligibleClause}
      GROUP BY GROUPING SETS (
        (),
        (browser, collection_source, classification, obs_version, obs_features)
      )
      ORDER BY is_total DESC, browser ASC, collection_source ASC, classification ASC, obs_version ASC, obs_features ASC
    `;
  } else {
    // Sub-hour boundary fallback: query flat browser events directly (still single-table, zero JOINs)
    sql = `
      SELECT
        grouping(browser) AS is_total,
        browser,
        collection_source,
        classification,
        obs_version,
        obs_features,
        toString(count()) AS out_pv,
        toString(uniqExact(session_id)) AS out_uv,
        toString(uniqExact(tuple(visit_id, session_id))) AS out_visits,
        toString(countIf(has_observation)) AS observed,
        toString(countIf(NOT has_observation)) AS not_collected,
        toString(countIf(obs_version = {obs_ver:String})) AS current_version,
        toString(countIf(is_risk_flagged)) AS flagged_pv,
        toString(uniqExactIf(session_id, is_risk_flagged)) AS flagged_uv,
        toString(countIf(identity_scope = 'browser' AND identity_available)) AS id_pv,
        toString(uniqExactIf(session_id, identity_scope = 'browser' AND identity_available)) AS id_uv,
        arraySort(arrayFilter(x -> x != '', groupUniqArray(identity_version))) AS id_versions,
        toString(countIf(bitAnd(obs_mask, 1) > 0)) AS f_accept,
        toString(countIf(bitAnd(obs_mask, 2) > 0)) AS f_language,
        toString(countIf(bitAnd(obs_mask, 4) > 0)) AS f_site,
        toString(countIf(bitAnd(obs_mask, 8) > 0)) AS f_mode,
        toString(countIf(bitAnd(obs_mask, 16) > 0)) AS f_dest,
        min(created_at) AS out_first_event_at,
        max(created_at) AS out_last_event_at,
        max(received_at) AS out_last_received_at
      FROM ${v2Tables.browserEvents}
      WHERE website_id = {site:UUID}
        AND epoch = {epoch:UInt64}
        AND _deleted = 0
        AND event_type = 1
        AND collection_source IN ('browser', 'legacy_override')
        AND received_at >= parseDateTime64BestEffort({start_ts:String}, 6, 'UTC')
        AND received_at < parseDateTime64BestEffort({end_ts:String}, 6, 'UTC')
        ${eligibleClause}
      GROUP BY GROUPING SETS (
        (),
        (browser, collection_source, classification, obs_version, obs_features)
      )
      ORDER BY is_total DESC, browser ASC, collection_source ASC, classification ASC, obs_version ASC, obs_features ASC
    `;
  }

  const rawRows = await queryV2Json<RawRow>(ch, sql, queryParams, {
    abortSignal: params.abortSignal,
    maxThreads: 4,
  });

  const totalRow = rawRows.find(r => Number(r.is_total) === 1);
  const groupRows = rawRows.filter(r => Number(r.is_total) === 0);

  const pv = Number(totalRow?.out_pv ?? 0);
  const idPv = Number(totalRow?.id_pv ?? 0);
  const identityReady = pv === 0 || idPv === pv;

  const totals = {
    pv,
    uv: identityReady ? Number(totalRow?.out_uv ?? 0) : null,
    visits: identityReady ? Number(totalRow?.out_visits ?? 0) : null,
    observed: Number(totalRow?.observed ?? 0),
    notCollected: Number(totalRow?.not_collected ?? 0),
    currentVersion: Number(totalRow?.current_version ?? 0),
    flaggedPv: Number(totalRow?.flagged_pv ?? 0),
    flaggedUv: identityReady ? Number(totalRow?.flagged_uv ?? 0) : null,
    identityQualifiedPv: idPv,
    identityQualifiedVisitors: Number(totalRow?.id_uv ?? 0),
    identityVersions: (totalRow?.id_versions ?? []).slice(0, 32),
  };

  const sampleCounts: Record<(typeof OBSERVATION_FIELDS)[number], number> = {
    accept: Number(totalRow?.f_accept ?? 0),
    language: Number(totalRow?.f_language ?? 0),
    site: Number(totalRow?.f_site ?? 0),
    mode: Number(totalRow?.f_mode ?? 0),
    dest: Number(totalRow?.f_dest ?? 0),
  };

  const coverage = Object.fromEntries(
    OBSERVATION_FIELDS.map(field => {
      const samples = sampleCounts[field];
      return [
        field,
        {
          value: pv ? samples / pv : null,
          samples,
          total: pv,
          state: !pv ? 'unknown' : samples === pv ? 'available' : 'partial',
        },
      ];
    }),
  );

  const allMapped = groupRows.map(r => {
    const rowPv = Number(r.out_pv);
    let features: Record<string, unknown> | null = null;
    if (r.obs_features && r.obs_features !== 'null') {
      try {
        features = JSON.parse(r.obs_features);
      } catch {
        features = null;
      }
    }
    return {
      browser: r.browser || 'unknown',
      source: r.collection_source,
      classification: r.classification,
      version: r.obs_version || 'not_collected',
      features,
      pv: rowPv,
      uv: identityReady ? Number(r.out_uv) : null,
      smallSample: rowPv < 20,
      firstEventAt: r.out_first_event_at,
      lastEventAt: r.out_last_event_at,
    };
  });

  const pageSize = params.pageSize ?? 20;
  const page = Math.max(1, params.page ?? 1);
  const pagedRows = allMapped.slice((page - 1) * pageSize, page * pageSize);

  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ totals, coverage, groups: allMapped }))
    .digest('hex');

  return {
    totals,
    coverage,
    rows: pagedRows,
    totalGroups: allMapped.length,
    lastReceivedAt: totalRow?.out_last_received_at ?? null,
    fingerprint,
  };
}

export type V2ReconciliationParams = {
  startAt: number;
  endAt: number;
  hostname: string;
  sourceId?: string;
  path?: string;
  page?: number;
  pageSize?: number;
  sort?: 'requests' | 'visits' | 'path';
  direction?: 'asc' | 'desc';
  qualityState?: string;
  qualitySourceVersion?: string;
  abortSignal?: AbortSignal;
};

export type V2ReconciliationRow = {
  humanPath: string;
  encodedPaths: string[];
  ambiguous: boolean;
  requests: number;
  get2xx: number;
  crawler: number;
  candidate: number;
  ambiguousRequests: number;
  confirmedHtml: number;
  contentTypeSamples: number;
  hostSamples: number;
  unsampledRequests: number;
  observedPv: number | null;
  unknownHostPv: number;
  pv: number | null;
  uv: number | null;
  visits: number | null;
  difference: number | null;
  reason: string | null;
};

export type V2ReconciliationResult = {
  rawRequests: number;
  browserTotals: { pv: number; uv: number; visits: number } | null;
  rows: V2ReconciliationRow[];
  totalRows: number;
  logLastAt: string | null;
  browserLastAt: string | null;
  fingerprint: string;
};

/**
 * 2 parallel ClickHouse queries over native AggregatingMergeTree tables:
 * 1) ch_v2_log_path_hour_agg (pre-aggregated per hour x path — ~100k tiny rows instead of 5.7M raw logs)
 * 2) ch_v2_browser_path_hour_agg (pre-aggregated per hour x path with exact uniqExactState UV/visits)
 *
 * Zero analytics-worker polling, zero 9-segment compaction, sub-second visibility after INSERT.
 */
export async function queryV2Reconciliation(
  ch: ClickHouseClient,
  control: V2ControlContext,
  catalog: CachedCatalog,
  params: V2ReconciliationParams,
): Promise<V2ReconciliationResult> {
  const normHost = normalizeHost(params.hostname);
  const firstHour = Math.ceil(params.startAt / HOUR_MS) * HOUR_MS;
  const endHour = Math.floor(params.endAt / HOUR_MS) * HOUR_MS;
  const hasHours = firstHour < endHour;
  const hasEdges = !hasHours || firstHour !== params.startAt || endHour !== params.endAt;
  const siteScope = 'website_id = {site:UUID} AND epoch = {epoch:UInt64}';
  const hourRange = `hour >= {first_hour:DateTime64(6, 'UTC')} AND hour < {end_hour:DateTime64(6, 'UTC')}`;
  const eventRange = `created_at >= {start_ts:DateTime64(6, 'UTC')} AND created_at < {end_ts:DateTime64(6, 'UTC')}`;
  const edgeRange = hasHours
    ? `${eventRange} AND (toStartOfHour(created_at) < {first_hour:DateTime64(6, 'UTC')} OR toStartOfHour(created_at) >= {end_hour:DateTime64(6, 'UTC')})`
    : eventRange;

  const sourceFilter =
    params.sourceId === 'manual'
      ? 'AND has_source = false'
      : params.sourceId
        ? 'AND has_source = true AND source_id = {source_id:UUID}'
        : '';

  // Older views applied isNotNull to the coalesced UUID. For a manual or zero-UUID
  // filter, reconstruct just the ambiguous full hours from their nullable source facts.
  const checkLegacySource =
    hasHours && (params.sourceId === 'manual' || params.sourceId === ZERO_UUID);
  const legacyHours = `SELECT hour FROM ${v2Tables.logPathHourAgg}
    WHERE ${siteScope} AND ${hourRange} AND has_source AND source_id = toUUID('${ZERO_UUID}')
    GROUP BY hour`;
  const logHourFilter = checkLegacySource ? 'AND hour NOT IN legacy_hours' : '';
  const logDetailRange = checkLegacySource
    ? `(${hasEdges ? edgeRange + ' OR ' : ''}toStartOfHour(created_at) IN legacy_hours)`
    : edgeRange;

  const mappings = params.path
    ? catalog.mappings
        .filter(m => m.encodedPaths.includes(params.path!))
        .map(m => ({ ...m, encodedPaths: m.encodedPaths.filter(ep => ep === params.path) }))
    : catalog.mappings;
  const browserPaths = Array.from(new Set(mappings.map(m => m.humanPath)));

  const pathFilterLog = params.path ? 'AND path = {filter_path:String}' : '';

  const baseQueryParams: Record<string, unknown> = {
    site: control.websiteId,
    epoch: control.epoch,
    first_hour: toV2Timestamp(firstHour),
    end_hour: toV2Timestamp(endHour),
    start_ts: toV2Timestamp(params.startAt),
    end_ts: toV2Timestamp(params.endAt),
    norm_host: normHost,
    source_id: params.sourceId && params.sourceId !== 'manual' ? params.sourceId : ZERO_UUID,
    filter_path: params.path ?? '',
  };

  // ClickHouse sends query_params in the HTTP URL query string, which overflows on large
  // catalogs (e.g. 8,192 paths). Use URL params for small lists and POST-body SQL literals
  // for large lists so reconciliation works reliably at 100x catalog scale.
  const useInlineBrowserPaths = browserPaths.length > 200;
  const escapeChLiteral = (s: string) =>
    `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\0/g, '\\0').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
  const browserPathPredicate = useInlineBrowserPaths
    ? `AND url_path IN (${browserPaths.map(escapeChLiteral).join(',')})`
    : 'AND url_path IN {browser_paths:Array(String)}';
  const browserQueryParams: Record<string, unknown> = useInlineBrowserPaths
    ? baseQueryParams
    : { ...baseQueryParams, browser_paths: browserPaths };

  type LogPathRow = {
    path: string;
    out_requests: string;
    out_get2xx: string;
    out_crawler: string;
    out_candidate: string;
    out_ambiguous: string;
    out_content_type_samples: string;
    out_confirmed_html: string;
    out_host_samples: string;
    out_config_samples: string;
    out_unsampled_requests: string;
    out_config_versions: string;
    out_last_at: string | null;
  };

  type BrowserPathRow = {
    is_total: string | number;
    url_path: string;
    out_pv: string;
    out_uv: string;
    out_visits: string;
    out_unknown_host_pv: string;
    out_last_at: string | null;
  };

  // Edge rows produce the same aggregate states as the materialized views.
  // Finalize only after combining both sources, including the cross-path browser total.
  const logSources: string[] = [];
  const browserSources: string[] = [];
  const browserScope = `${siteScope} AND is_eligible AND (hostname = {norm_host:String} OR hostname = '') ${browserPathPredicate}`;
  if (hasHours) {
    logSources.push(`SELECT path, request_host, host_basis, requests, get2xx, crawler, candidate,
      ambiguous, content_type_samples, confirmed_html, config_samples, unsampled_requests, config_versions, last_at
      FROM ${v2Tables.logPathHourAgg}
      WHERE ${siteScope} AND ${hourRange} ${sourceFilter} ${pathFilterLog} ${logHourFilter}`);
    browserSources.push(`SELECT url_path, hostname, pv, uv, visits, last_at FROM ${v2Tables.browserPathHourAgg}
      WHERE ${browserScope} AND ${hourRange}`);
  }
  if (hasEdges || checkLegacySource) {
    const rawSourceFilter =
      params.sourceId === 'manual'
        ? 'AND isNull(source_id)'
        : params.sourceId
          ? 'AND source_id = {source_id:UUID}'
          : '';
    logSources.push(`SELECT path, request_host, host_basis, ${logPathStates}
      FROM ${v2Tables.logs}
      WHERE ${siteScope} AND _deleted = 0 AND NOT is_self_check AND ${logDetailRange} ${rawSourceFilter} ${pathFilterLog}
      GROUP BY path, request_host, host_basis`);
  }
  if (hasEdges) {
    browserSources.push(`SELECT url_path, hostname, ${browserPathStates} FROM ${v2Tables.browserEvents}
      WHERE ${browserScope} AND _deleted = 0 AND event_type = 1 AND ${edgeRange}
      GROUP BY url_path, hostname`);
  }
  const logSql = `
      ${checkLegacySource ? `WITH legacy_hours AS (${legacyHours})` : ''}
      SELECT
        path,
        toString(countMerge(requests)) AS out_requests,
        toString(sumMerge(get2xx)) AS out_get2xx,
        toString(sumMerge(crawler)) AS out_crawler,
        toString(sumMerge(candidate)) AS out_candidate,
        toString(sumMerge(ambiguous)) AS out_ambiguous,
        toString(sumMerge(content_type_samples)) AS out_content_type_samples,
        toString(sumMerge(confirmed_html)) AS out_confirmed_html,
        toString(countMergeIf(requests, host_basis = 'request_host' AND request_host = {norm_host:String})) AS out_host_samples,
        toString(sumMerge(config_samples)) AS out_config_samples,
        toString(sumMerge(unsampled_requests)) AS out_unsampled_requests,
        toString(uniqExactMerge(config_versions)) AS out_config_versions,
        maxMerge(last_at) AS out_last_at
      FROM (${logSources.join(' UNION ALL ')})
      GROUP BY path`;
  const browserSql = `
      SELECT
        grouping(url_path) AS is_total,
        url_path,
        toString(countMergeIf(pv, hostname = {norm_host:String})) AS out_pv,
        toString(uniqExactMergeIf(uv, hostname = {norm_host:String})) AS out_uv,
        toString(uniqExactMergeIf(visits, hostname = {norm_host:String})) AS out_visits,
        toString(countMergeIf(pv, hostname = '')) AS out_unknown_host_pv,
        maxMerge(last_at) AS out_last_at
      FROM (${browserSources.join(' UNION ALL ')})
      GROUP BY GROUPING SETS ((), (url_path))`;

  const [logRows, browserRows] = await Promise.all([
    queryV2Json<LogPathRow>(ch, logSql, baseQueryParams, {
      abortSignal: params.abortSignal,
      maxThreads: 4,
    }),
    browserPaths.length > 0
      ? queryV2Json<BrowserPathRow>(ch, browserSql, browserQueryParams, {
          abortSignal: params.abortSignal,
          maxThreads: 4,
          maxQuerySize: useInlineBrowserPaths ? 4 * 1024 * 1024 : undefined,
        })
      : Promise.resolve<BrowserPathRow[]>([]),
  ]);

  const logByPath = new Map<string, LogPathRow>();
  let rawRequests = 0;
  let logLastAt: string | null = null;
  for (const r of logRows) {
    logByPath.set(r.path, r);
    rawRequests += Number(r.out_requests);
    if (r.out_last_at && (!logLastAt || r.out_last_at > logLastAt)) logLastAt = r.out_last_at;
  }

  const browserTotalRow = browserRows.find(r => Number(r.is_total) === 1);
  const browserByPath = new Map<string, BrowserPathRow>();
  let anyUnknownHost = false;
  for (const r of browserRows) {
    if (Number(r.is_total) === 0) {
      browserByPath.set(r.url_path, r);
      if (Number(r.out_unknown_host_pv) > 0) anyUnknownHost = true;
    }
  }

  const qualityState = params.qualityState ?? 'complete';

  const alignedRows: V2ReconciliationRow[] = mappings.map(mapping => {
    let requests = 0;
    let get2xx = 0;
    let crawler = 0;
    let candidate = 0;
    let ambiguousRequests = 0;
    let confirmedHtml = 0;
    let contentTypeSamples = 0;
    let hostSamples = 0;
    let configSamples = 0;
    let unsampledRequests = 0;
    let badConfigVersions = false;

    for (const ep of mapping.encodedPaths) {
      const lr = logByPath.get(ep);
      if (!lr) continue;
      requests += Number(lr.out_requests);
      get2xx += Number(lr.out_get2xx);
      crawler += Number(lr.out_crawler);
      candidate += Number(lr.out_candidate);
      ambiguousRequests += Number(lr.out_ambiguous);
      confirmedHtml += Number(lr.out_confirmed_html);
      contentTypeSamples += Number(lr.out_content_type_samples);
      hostSamples += Number(lr.out_host_samples);
      configSamples += Number(lr.out_config_samples);
      unsampledRequests += Number(lr.out_unsampled_requests);
      if (Number(lr.out_config_versions) !== 1) badConfigVersions = true;
    }

    const br = browserByPath.get(mapping.humanPath);
    const unknownHostPv = Number(br?.out_unknown_host_pv ?? 0);
    const brPv = Number(br?.out_pv ?? 0);
    const brUv = Number(br?.out_uv ?? 0);
    const brVisits = Number(br?.out_visits ?? 0);

    const reason = mapping.ambiguous
      ? 'ambiguous_path'
      : !requests
        ? 'measurement_missing'
        : !control.browserConnected
          ? 'browser_missing'
          : unknownHostPv > 0
            ? 'browser_host_unknown'
            : configSamples !== requests || badConfigVersions
              ? 'source_config_unknown'
              : qualityState !== 'complete'
                ? 'source_coverage'
                : hostSamples !== requests
                  ? 'host_evidence'
                  : unsampledRequests !== requests
                    ? 'sampling_unknown'
                    : null;

    return {
      humanPath: mapping.humanPath,
      encodedPaths: mapping.encodedPaths,
      ambiguous: mapping.ambiguous,
      requests,
      get2xx,
      crawler,
      candidate,
      ambiguousRequests,
      confirmedHtml,
      contentTypeSamples,
      hostSamples,
      unsampledRequests,
      observedPv: control.browserConnected ? brPv : null,
      unknownHostPv,
      pv: control.browserConnected && unknownHostPv === 0 ? brPv : null,
      uv: control.browserConnected && unknownHostPv === 0 ? brUv : null,
      visits: control.browserConnected && unknownHostPv === 0 ? brVisits : null,
      difference: reason ? null : candidate - brPv,
      reason,
    };
  });

  const sortKey = params.sort ?? 'requests';
  const dir = params.direction === 'asc' ? 1 : -1;
  alignedRows.sort((a, b) => {
    const primary =
      sortKey === 'path'
        ? a.humanPath.localeCompare(b.humanPath, 'en')
        : sortKey === 'visits'
          ? (a.visits ?? 0) - (b.visits ?? 0)
          : a.requests - b.requests;
    return primary * dir || a.humanPath.localeCompare(b.humanPath, 'en');
  });

  const pageSize = params.pageSize ?? 20;
  const page = Math.max(1, params.page ?? 1);
  const pagedRows = alignedRows.slice((page - 1) * pageSize, page * pageSize);

  const browserTotals =
    control.browserConnected && !anyUnknownHost
      ? {
          pv: Number(browserTotalRow?.out_pv ?? 0),
          uv: Number(browserTotalRow?.out_uv ?? 0),
          visits: Number(browserTotalRow?.out_visits ?? 0),
        }
      : null;

  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        catalogHash: catalog.hash,
        rawRequests,
        browserTotals,
        rows: alignedRows,
      }),
    )
    .digest('hex');

  return {
    rawRequests,
    browserTotals,
    rows: pagedRows,
    totalRows: alignedRows.length,
    logLastAt,
    browserLastAt: browserTotalRow?.out_last_at ?? null,
    fingerprint,
  };
}
