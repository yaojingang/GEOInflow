/**
 * Direct PostgreSQL -> ClickHouse v2 Bulk Importer & Lifecycle Maintenance
 *
 * Replaces v1's 10-step barrier/freeze/snapshot/clone/transition-coordinator ceremony with
 * clean keyset-paginated streaming straight into ch_v2_* (which automatically populates
 * all 4 native ClickHouse Materialized Views).
 */
import type { ClickHouseClient } from '@clickhouse/client';
import type pg from 'pg';
import { ensureV2Schema, insertV2Rows } from './client';
import {
  buildV2LogRow,
  computeObservationMask,
  normalizeHost,
  toV2Timestamp,
  type V2BrowserEventRow,
} from './ingest';
import { v2Tables } from './schema';

export type PgImportStats = {
  logsImported: number;
  browserEventsImported: number;
  eventDataImported: number;
  revenueImported: number;
  durationMs: number;
};

export async function importPgToWarehouseV2(
  pgPool: pg.Pool,
  ch: ClickHouseClient,
  options: {
    websiteId?: string;
    batchSize?: number;
    onProgress?: (stage: string, count: number) => void;
  } = {},
): Promise<PgImportStats> {
  const started = performance.now();
  const batchSize = options.batchSize ?? 5000;
  await ensureV2Schema(ch);

  // Build site epoch map from PG
  const { rows: stateRows } = await pgPool.query<{ website_id: string; epoch: string }>(
    'SELECT website_id::text, epoch::text FROM liekan_log_state',
  );
  const epochBySite = new Map<string, string>(
    stateRows.map(r => [String(r.website_id), String(r.epoch)]),
  );

  const siteFilter = options.websiteId ? 'AND l.website_id = $1::uuid' : '';
  const baseArgs = options.websiteId ? [options.websiteId] : [];

  // 1. Stream liekan_log + liekan_crawler_evidence + liekan_log_geography -> ch_v2_logs
  let logsImported = 0;
  let lastLogSite = '00000000-0000-0000-0000-000000000000';
  let lastLogId = '';
  for (;;) {
    const args = [...baseArgs, lastLogSite, lastLogId, batchSize];
    const p1 = baseArgs.length + 1;
    const p2 = baseArgs.length + 2;
    const p3 = baseArgs.length + 3;
    const { rows } = await pgPool.query<Record<string, any>>(
      `SELECT l.*,
        e.classification_version, e.crawler_id, e.security_action, e.terminating_rule_id,
        e.matched_rule_ids, e.cache_status, e.duration_ms, e.measurement,
        e.edge_observation, e.catalog_version, e.identity_evidence,
        g.country, g.region, g.city
      FROM liekan_log l
      LEFT JOIN liekan_crawler_evidence e ON e.website_id = l.website_id AND e.log_id = l.id
      LEFT JOIN liekan_log_geography g ON g.website_id = l.website_id AND g.log_id = l.id
      WHERE (l.website_id, l.id) > ($${p1}::uuid, $${p2}::text) ${siteFilter}
      ORDER BY l.website_id, l.id
      LIMIT $${p3}`,
      args,
    );
    if (!rows.length) break;

    const batch = rows.map(r =>
      buildV2LogRow({
        websiteId: String(r.website_id),
        epoch: epochBySite.get(String(r.website_id)) ?? '1',
        id: r.id,
        importId: r.import_id,
        sourceId: r.source_id,
        createdAt: r.created_at,
        path: r.path,
        method: r.method,
        status: Number(r.status),
        bytes: r.bytes ?? 0,
        ipMasked: r.ip_masked ?? '',
        ipHash: r.ip_hash ?? '',
        userAgent: r.user_agent ?? '',
        location: r.location ?? '',
        bot: r.bot ?? '',
        vendor: r.vendor ?? '',
        botType: r.bot_type ?? '',
        verification: r.verification ?? '',
        eventDigest: r.event_digest ?? null,
        verificationVersion: r.verification_version ?? null,
        verificationReason: r.verification_reason ?? null,
        verificationObservedAt: r.verification_observed_at ?? null,
        aiEligible: Boolean(r.ai_eligible),
        recognitionState: r.recognition_state ?? 'recognized',
        recognitionCandidates: r.recognition_candidates
          ? JSON.stringify(r.recognition_candidates)
          : null,
        crawlerId: r.crawler_id ?? null,
        classificationVersion: r.classification_version ?? null,
        catalogVersion: r.catalog_version ?? null,
        securityAction: r.security_action ?? null,
        terminatingRuleId: r.terminating_rule_id ?? null,
        matchedRuleIds: r.matched_rule_ids ? JSON.stringify(r.matched_rule_ids) : null,
        cacheStatus: r.cache_status ?? null,
        durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
        identityEvidence: r.identity_evidence ? JSON.stringify(r.identity_evidence) : null,
        measurement: r.measurement ?? null,
        edgeObservation: r.edge_observation ?? null,
        country: r.country ?? null,
        region: r.region ?? null,
        city: r.city ?? null,
        version: 1,
      }),
    );

    await insertV2Rows(ch, v2Tables.logs, batch);
    logsImported += batch.length;
    lastLogSite = rows[rows.length - 1].website_id;
    lastLogId = rows[rows.length - 1].id;
    options.onProgress?.('logs', logsImported);
    if (rows.length < batchSize) break;
  }

  // 2. Stream website_event + session + quality + env + obs + geo -> ch_v2_browser_events
  let browserEventsImported = 0;
  let lastEventId = '00000000-0000-0000-0000-000000000000';
  const evSiteFilter = options.websiteId ? 'AND e.website_id = $1::uuid' : '';
  for (;;) {
    const args = [...baseArgs, lastEventId, batchSize];
    const p1 = baseArgs.length + 1;
    const p2 = baseArgs.length + 2;
    const { rows } = await pgPool.query<Record<string, any>>(
      `SELECT e.*,
        s.browser AS s_browser, s.os AS s_os, s.device AS s_device, s.screen AS s_screen,
        s.language AS s_language, s.country AS s_country, s.region AS s_region,
        s.city AS s_city, s.distinct_id AS s_distinct_id, s.created_at AS s_created_at,
        q.classification AS q_classification, q.source AS q_source, q.reasons AS q_reasons,
        q.rule_version AS q_rule_version, q.range_status AS q_range_status,
        q.range_version AS q_range_version, q.hostname AS q_hostname,
        q.catalog_version AS q_catalog_version, q.repair_scope_id AS q_repair_scope_id,
        q.created_at AS q_created_at,
        env.scope AS env_scope, env.identity_version AS env_identity_version,
        env.identity_available AS env_identity_available, env.browser AS env_browser,
        env.os AS env_os, env.device AS env_device, env.screen AS env_screen,
        env.language AS env_language, env.origin_hostname AS env_origin_hostname,
        env.distinct_id AS env_distinct_id,
        o.version AS o_version, o.received_at AS o_received_at, o.features AS o_features,
        g.country AS g_country, g.region AS g_region, g.city AS g_city
      FROM website_event e
      LEFT JOIN session s ON s.session_id = e.session_id AND s.website_id = e.website_id
      LEFT JOIN liekan_event_quality q ON q.event_id = e.event_id AND q.website_id = e.website_id
      LEFT JOIN liekan_event_environment env ON env.event_id = e.event_id AND env.website_id = e.website_id
      LEFT JOIN liekan_event_observation o ON o.event_id = e.event_id AND o.website_id = e.website_id
      LEFT JOIN liekan_event_geography g ON g.event_id = e.event_id AND g.website_id = e.website_id
      WHERE e.event_id > $${p1}::uuid ${evSiteFilter}
      ORDER BY e.event_id
      LIMIT $${p2}`,
      args,
    );
    if (!rows.length) break;

    const batch: V2BrowserEventRow[] = rows.map(r => {
      const reasons = Array.isArray(r.q_reasons) ? (r.q_reasons as string[]) : [];
      const source = String(r.q_source ?? 'browser');
      const classification = String(r.q_classification ?? 'browser');
      const identityScope = String(r.env_scope ?? 'browser');
      const identityAvailable = Boolean(r.env_identity_available ?? true);
      const featuresObj = r.o_features && typeof r.o_features === 'object' ? r.o_features : null;
      const isEligible =
        source === 'browser' &&
        classification === 'browser' &&
        identityScope === 'browser' &&
        identityAvailable &&
        !reasons.includes('bot_check_disabled');
      const createdAt = toV2Timestamp(r.created_at ?? new Date());
      return {
        website_id: String(r.website_id),
        epoch: epochBySite.get(String(r.website_id)) ?? '1',
        event_id: r.event_id,
        session_id: r.session_id,
        visit_id: r.visit_id,
        created_at: createdAt,
        received_at: toV2Timestamp(r.o_received_at ?? r.q_created_at ?? r.created_at ?? new Date()),
        session_created_at: toV2Timestamp(r.s_created_at ?? r.created_at ?? new Date()),
        event_type: Number(r.event_type ?? 1),
        event_name: r.event_name ?? null,
        url_path: r.url_path ?? '/',
        url_query: r.url_query ?? null,
        hostname: normalizeHost(r.q_hostname ?? r.hostname ?? ''),
        normalized_hostname: r.q_hostname ? normalizeHost(r.q_hostname) : null,
        origin_hostname: r.env_origin_hostname ? normalizeHost(r.env_origin_hostname) : null,
        page_title: r.page_title ?? null,
        referrer_domain: r.referrer_domain ?? null,
        referrer_path: r.referrer_path ?? null,
        referrer_query: r.referrer_query ?? null,
        tag: r.tag ?? null,
        fbclid: r.fbclid ?? null,
        gclid: r.gclid ?? null,
        li_fat_id: r.li_fat_id ?? null,
        msclkid: r.msclkid ?? null,
        ttclid: r.ttclid ?? null,
        twclid: r.twclid ?? null,
        utm_source: r.utm_source ?? null,
        utm_medium: r.utm_medium ?? null,
        utm_campaign: r.utm_campaign ?? null,
        utm_content: r.utm_content ?? null,
        utm_term: r.utm_term ?? null,
        cls: r.cls != null ? String(r.cls) : null,
        fcp: r.fcp != null ? String(r.fcp) : null,
        inp: r.inp != null ? String(r.inp) : null,
        lcp: r.lcp != null ? String(r.lcp) : null,
        ttfb: r.ttfb != null ? String(r.ttfb) : null,
        browser: String(r.env_browser ?? r.s_browser ?? 'unknown'),
        os: r.env_os ?? r.s_os ?? null,
        device: r.env_device ?? r.s_device ?? null,
        screen: r.env_screen ?? r.s_screen ?? null,
        language: r.env_language ?? r.s_language ?? null,
        country: r.g_country ?? r.s_country ?? null,
        region: r.g_region ?? r.s_region ?? null,
        city: r.g_city ?? r.s_city ?? null,
        distinct_id: r.env_distinct_id ?? r.s_distinct_id ?? null,
        collection_source: source,
        classification,
        quality_reasons: reasons,
        rule_version: String(r.q_rule_version ?? ''),
        range_status: String(r.q_range_status ?? 'unknown'),
        range_version: r.q_range_version ?? null,
        repair_scope_id: r.q_repair_scope_id ?? null,
        catalog_version: r.q_catalog_version ?? null,
        is_eligible: isEligible,
        identity_scope: identityScope,
        identity_available: identityAvailable,
        identity_version: String(r.env_identity_version ?? ''),
        has_observation: Boolean(r.o_version),
        obs_version: String(r.o_version ?? 'not_collected'),
        obs_features: featuresObj ? JSON.stringify(featuresObj) : '',
        obs_mask: computeObservationMask(featuresObj),
        is_risk_flagged: false,
        _ver: '1',
        _deleted: 0,
      };
    });

    await insertV2Rows(ch, v2Tables.browserEvents, batch);
    browserEventsImported += batch.length;
    lastEventId = rows[rows.length - 1].event_id;
    options.onProgress?.('browser_events', browserEventsImported);
    if (rows.length < batchSize) break;
  }

  return {
    logsImported,
    browserEventsImported,
    eventDataImported: 0,
    revenueImported: 0,
    durationMs: Math.round(performance.now() - started),
  };
}

/**
 * Site reset / deletion in v2:
 * PG increments epoch immediately (blocking old epoch reads instantly), and ClickHouse
 * asynchronously removes old epoch data without blocking active reads or writes.
 */
export async function purgeV2SiteEpoch(
  ch: ClickHouseClient,
  websiteId: string,
  beforeEpoch: string | number,
): Promise<void> {
  const tables = [
    v2Tables.logs,
    v2Tables.browserEvents,
    v2Tables.eventData,
    v2Tables.revenue,
    v2Tables.heatmap,
    v2Tables.sessionReplay,
    v2Tables.sessionData,
    v2Tables.sessionLink,
    v2Tables.logHourAgg,
    v2Tables.logPathHourAgg,
    v2Tables.observationHourAgg,
    v2Tables.browserPathHourAgg,
    'warehouse_control_projection',
  ];
  for (const table of tables) {
    await ch.command({
      query: `ALTER TABLE ${table} DELETE WHERE website_id = {site:UUID} AND epoch < {epoch:UInt64}`,
      query_params: { site: websiteId, epoch: String(beforeEpoch) },
    });
  }
}

/**
 * Rebuilds the native AggregatingMergeTree summaries for a specific hour after late spider
 * evidence or history repair updates ch_v2_logs. Keeps 99.9% hot path completely untouched.
 */
export async function rebuildV2LogHourAggregates(
  ch: ClickHouseClient,
  websiteId: string,
  epoch: string | number,
  hourUtc: Date | string,
): Promise<void> {
  const hourTs = toV2Timestamp(hourUtc);
  const params = { site: websiteId, epoch: String(epoch), hour_ts: hourTs };

  await ch.command({
    query: `ALTER TABLE ${v2Tables.logHourAgg} DELETE WHERE website_id = {site:UUID} AND epoch = {epoch:UInt64} AND hour = toStartOfHour(parseDateTime64BestEffort({hour_ts:String}, 6, 'UTC')) SETTINGS mutations_sync = 1`,
    query_params: params,
  });
  await ch.command({
    query: `ALTER TABLE ${v2Tables.logPathHourAgg} DELETE WHERE website_id = {site:UUID} AND epoch = {epoch:UInt64} AND hour = toStartOfHour(parseDateTime64BestEffort({hour_ts:String}, 6, 'UTC')) SETTINGS mutations_sync = 1`,
    query_params: params,
  });

  await ch.command({
    query: `INSERT INTO ${v2Tables.logHourAgg}
      SELECT
        website_id, epoch, toStartOfHour(created_at) AS hour,
        coalesce(source_id, toUUID('00000000-0000-0000-0000-000000000000')) AS source_id,
        isNotNull(source_id) AS has_source,
        bot, vendor, bot_type, ai_eligible, recognition_state,
        coalesce(classification_version, '') AS classification_version,
        is_self_check, is_unknown_crawler, source_config_version, source_interval_version,
        countState() AS requests,
        sumState(toUInt64(method = 'GET' AND status >= 200 AND status <= 299)) AS get2xx,
        sumState(toUInt64(status >= 400)) AS abnormal,
        uniqExactState(path) AS pages,
        maxState(created_at) AS last_at
      FROM ${v2Tables.logs} FINAL
      WHERE website_id = {site:UUID} AND epoch = {epoch:UInt64}
        AND toStartOfHour(created_at) = toStartOfHour(parseDateTime64BestEffort({hour_ts:String}, 6, 'UTC'))
        AND _deleted = 0
      GROUP BY website_id, epoch, hour, source_id, has_source,
        bot, vendor, bot_type, ai_eligible, recognition_state,
        classification_version, is_self_check, is_unknown_crawler,
        source_config_version, source_interval_version`,
    query_params: params,
  });

  await ch.command({
    query: `INSERT INTO ${v2Tables.logPathHourAgg}
      SELECT
        website_id, epoch, toStartOfHour(created_at) AS hour,
        coalesce(source_id, toUUID('00000000-0000-0000-0000-000000000000')) AS source_id,
        isNotNull(source_id) AS has_source,
        path, request_host, host_basis,
        countState() AS requests,
        sumState(toUInt64(method = 'GET' AND status >= 200 AND status <= 299)) AS get2xx,
        sumState(toUInt64(method = 'GET' AND status >= 200 AND status <= 299 AND NOT is_unknown_crawler)) AS crawler,
        sumState(toUInt64(method = 'GET' AND status >= 200 AND status <= 299 AND is_unknown_crawler)) AS candidate,
        sumState(toUInt64(recognition_state = 'ambiguous')) AS ambiguous,
        sumState(toUInt64(content_type_state = 'present')) AS content_type_samples,
        sumState(toUInt64(method = 'GET' AND status >= 200 AND status <= 299 AND content_type_value IN ('text/html', 'application/xhtml+xml'))) AS confirmed_html,
        sumState(toUInt64(source_config_version != '')) AS config_samples,
        sumState(toUInt64(ifNull(sampling_rate = 1, 0))) AS unsampled_requests,
        uniqExactStateIf(source_config_version, source_config_version != '') AS config_versions,
        maxState(created_at) AS last_at
      FROM ${v2Tables.logs} FINAL
      WHERE website_id = {site:UUID} AND epoch = {epoch:UInt64}
        AND toStartOfHour(created_at) = toStartOfHour(parseDateTime64BestEffort({hour_ts:String}, 6, 'UTC'))
        AND _deleted = 0 AND NOT is_self_check
      GROUP BY website_id, epoch, hour, source_id, has_source, path, request_host, host_basis`,
    query_params: params,
  });
}
