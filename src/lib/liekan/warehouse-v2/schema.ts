/**
 * GEOInflow Warehouse v2 — Native ClickHouse Schema
 *
 * Design principles:
 * 1. Flat analytical fact tables (ch_v2_logs, ch_v2_browser_events) instead of 26 OLTP-normalized tables.
 * 2. Standard ClickHouse MergeTree durability (no per-insert fsync_after_insert=1 / fsync_part_directory=1).
 * 3. Native ClickHouse Materialized Views -> AggregatingMergeTree for sub-second freshness without
 *    manual manifest/piece/9-segment compaction loops or post-write full-table SHA-256 readbacks.
 * 4. Neutral attributes stored on facts so policy/hostname filtering runs at query time without rebuilds.
 */

export const WAREHOUSE_V2_SCHEMA_VERSION = 1;

export const v2Tables = {
  logs: 'ch_v2_logs',
  browserEvents: 'ch_v2_browser_events',
  eventData: 'ch_v2_event_data',
  revenue: 'ch_v2_revenue',
  heatmap: 'ch_v2_heatmap',
  sessionReplay: 'ch_v2_session_replay',
  sessionData: 'ch_v2_session_data',
  sessionLink: 'ch_v2_session_link',
  logHourAgg: 'ch_v2_log_hour_agg',
  logPathHourAgg: 'ch_v2_log_path_hour_agg',
  observationHourAgg: 'ch_v2_observation_hour_agg',
  browserPathHourAgg: 'ch_v2_browser_path_hour_agg',
} as const;

export const v2Views = {
  logHourAgg: 'mv_v2_log_hour_agg',
  logPathHourAgg: 'mv_v2_log_path_hour_agg',
  observationHourAgg: 'mv_v2_observation_hour_agg',
  browserPathHourAgg: 'mv_v2_browser_path_hour_agg',
} as const;

export const geoHistoryRowHash = `reinterpretAsUInt128(sipHash128(tuple(
  id,created_at,source_id,path,method,status,user_agent,verification,verification_version,
  verification_reason,verification_observed_at,ai_eligible,recognition_state,crawler_id,
  catalog_version,classification_version,request_host,host_basis,content_type_state,
  content_type_value,sampling_rate,identity_evidence,evidence_json)))`;
export const geoLogFingerprint = 'sumWithOverflow(geo_history_row_hash)';

export const logPathStates = `countState() AS requests,
      sumState(toUInt64(method = 'GET' AND status >= 200 AND status <= 299)) AS get2xx,
      sumState(toUInt64(method = 'GET' AND status >= 200 AND status <= 299 AND NOT is_unknown_crawler)) AS crawler,
      sumState(toUInt64(method = 'GET' AND status >= 200 AND status <= 299 AND is_unknown_crawler)) AS candidate,
      sumState(toUInt64(recognition_state = 'ambiguous')) AS ambiguous,
      sumState(toUInt64(content_type_state = 'present')) AS content_type_samples,
      sumState(toUInt64(method = 'GET' AND status >= 200 AND status <= 299 AND content_type_value IN ('text/html', 'application/xhtml+xml'))) AS confirmed_html,
      sumState(toUInt64(source_config_version != '')) AS config_samples,
      sumState(toUInt64(ifNull(sampling_rate = 1, 0))) AS unsampled_requests,
      uniqExactStateIf(source_config_version, source_config_version != '') AS config_versions,
      maxState(created_at) AS last_at`;

export const browserPathStates = `countState() AS pv,
      uniqExactState(session_id) AS uv,
      uniqExactState(tuple(visit_id, session_id)) AS visits,
      maxState(created_at) AS last_at`;

export function warehouseV2DDL(): string[] {
  return [
    // 1. Flat Log Fact Table (merges liekan_log + liekan_log_geography + liekan_crawler_evidence)
    `CREATE TABLE IF NOT EXISTS ${v2Tables.logs} (
      website_id UUID,
      epoch UInt64,
      id String,
      import_id Nullable(UUID),
      source_id Nullable(UUID),
      created_at DateTime64(6, 'UTC'),
      hour DateTime('UTC') MATERIALIZED toStartOfHour(created_at),
      path String,
      human_path String,
      method LowCardinality(String),
      status Int32,
      bytes Int64,
      ip_masked String,
      ip_hash String,
      user_agent String,
      location LowCardinality(String),
      bot LowCardinality(String),
      vendor LowCardinality(String),
      bot_type LowCardinality(String),
      verification LowCardinality(String),
      event_digest Nullable(String),
      verification_version LowCardinality(Nullable(String)),
      verification_reason LowCardinality(Nullable(String)),
      verification_observed_at Nullable(DateTime64(6, 'UTC')),
      ai_eligible Bool,
      recognition_state LowCardinality(String),
      recognition_candidates Nullable(String),
      crawler_id LowCardinality(Nullable(String)),
      is_self_check Bool,
      is_unknown_crawler Bool,
      classification_version LowCardinality(Nullable(String)),
      catalog_version Nullable(UUID),
      security_action LowCardinality(Nullable(String)),
      terminating_rule_id LowCardinality(Nullable(String)),
      matched_rule_ids Nullable(String),
      cache_status LowCardinality(Nullable(String)),
      duration_ms Nullable(Float64),
      identity_evidence Nullable(String),
      request_host LowCardinality(String),
      host_basis LowCardinality(String),
      content_type_state LowCardinality(String),
      content_type_value LowCardinality(String),
      source_config_version LowCardinality(String),
      source_interval_version LowCardinality(String),
      sampling_rate Nullable(Float64),
      country LowCardinality(Nullable(String)),
      region LowCardinality(Nullable(String)),
      city Nullable(String),
      evidence_json String,
      _ver UInt64,
      _deleted UInt8 DEFAULT 0
    ) ENGINE = ReplacingMergeTree(_ver)
    PARTITION BY toYYYYMM(created_at)
    ORDER BY (website_id, epoch, toStartOfHour(created_at), id)
    SETTINGS index_granularity = 8192`,

    `ALTER TABLE ${v2Tables.logs} MODIFY SETTING deduplicate_merge_projection_mode='rebuild', lightweight_mutation_projection_mode='rebuild'`,

    // 2. Flat Browser Event Fact Table (merges website_event + session + quality + env + observation + geo + risk)
    `CREATE TABLE IF NOT EXISTS ${v2Tables.browserEvents} (
      website_id UUID,
      epoch UInt64,
      event_id UUID,
      session_id UUID,
      visit_id UUID,
      created_at DateTime64(6, 'UTC'),
      received_at DateTime64(6, 'UTC'),
      session_created_at DateTime64(6, 'UTC'),
      event_type Int32,
      event_name LowCardinality(Nullable(String)),
      url_path String,
      url_query Nullable(String),
      hostname LowCardinality(String),
      normalized_hostname LowCardinality(Nullable(String)),
      origin_hostname LowCardinality(Nullable(String)),
      page_title Nullable(String),
      referrer_domain LowCardinality(Nullable(String)),
      referrer_path Nullable(String),
      referrer_query Nullable(String),
      tag LowCardinality(Nullable(String)),
      fbclid Nullable(String),
      gclid Nullable(String),
      li_fat_id Nullable(String),
      msclkid Nullable(String),
      ttclid Nullable(String),
      twclid Nullable(String),
      utm_source LowCardinality(Nullable(String)),
      utm_medium LowCardinality(Nullable(String)),
      utm_campaign Nullable(String),
      utm_content Nullable(String),
      utm_term Nullable(String),
      cls Nullable(Decimal(10, 4)),
      fcp Nullable(Decimal(10, 1)),
      inp Nullable(Decimal(10, 1)),
      lcp Nullable(Decimal(10, 1)),
      ttfb Nullable(Decimal(10, 1)),
      browser LowCardinality(String),
      os LowCardinality(Nullable(String)),
      device LowCardinality(Nullable(String)),
      screen LowCardinality(Nullable(String)),
      language LowCardinality(Nullable(String)),
      country LowCardinality(Nullable(String)),
      region LowCardinality(Nullable(String)),
      city Nullable(String),
      distinct_id Nullable(String),
      collection_source LowCardinality(String),
      classification LowCardinality(String),
      quality_reasons Array(LowCardinality(String)),
      rule_version LowCardinality(String),
      range_status LowCardinality(String),
      range_version LowCardinality(Nullable(String)),
      repair_scope_id Nullable(UUID),
      catalog_version Nullable(UUID),
      is_eligible Bool,
      identity_scope LowCardinality(String),
      identity_available Bool,
      identity_version LowCardinality(String),
      has_observation Bool,
      obs_version LowCardinality(String),
      obs_features String,
      obs_mask UInt8,
      is_risk_flagged Bool,
      _ver UInt64,
      _deleted UInt8 DEFAULT 0
    ) ENGINE = ReplacingMergeTree(_ver)
    PARTITION BY toYYYYMM(created_at)
    ORDER BY (website_id, epoch, toStartOfHour(created_at), event_id)
    SETTINGS index_granularity = 8192`,

    // Existing V2 volumes and newly created tables share the same additive upgrade.
    `ALTER TABLE ${v2Tables.browserEvents}
      ADD COLUMN IF NOT EXISTS client_event_id Nullable(UUID),
      ADD COLUMN IF NOT EXISTS receipt_hash String DEFAULT '',
      ADD COLUMN IF NOT EXISTS receipt_scope String DEFAULT '',
      ADD COLUMN IF NOT EXISTS event_properties Array(Tuple(UUID, String, Nullable(String), Nullable(Decimal(19,4)), Nullable(DateTime64(6,'UTC')), Int32)),
      ADD COLUMN IF NOT EXISTS event_revenue Array(Tuple(UUID, String, Decimal(19,4))),
      ADD INDEX IF NOT EXISTS v2_receipt_id client_event_id TYPE bloom_filter(0.01) GRANULARITY 1`,
    `ALTER TABLE ${v2Tables.logs}
      ADD INDEX IF NOT EXISTS v2_log_identity id TYPE bloom_filter(0.01) GRANULARITY 1`,

    // 3. Low-frequency detail tables (direct bulk append, queried only on dedicated screens)
    `CREATE TABLE IF NOT EXISTS ${v2Tables.eventData} (
      website_id UUID,
      epoch UInt64,
      event_data_id UUID,
      website_event_id UUID,
      created_at DateTime64(6, 'UTC'),
      data_key LowCardinality(String),
      string_value Nullable(String),
      number_value Nullable(Decimal(19, 4)),
      date_value Nullable(DateTime64(6, 'UTC')),
      data_type Int32,
      _ver UInt64
    ) ENGINE = ReplacingMergeTree(_ver)
    PARTITION BY toYYYYMM(created_at)
    ORDER BY (website_id, epoch, toDate(created_at), website_event_id, event_data_id)`,

    `CREATE TABLE IF NOT EXISTS ${v2Tables.revenue} (
      website_id UUID,
      epoch UInt64,
      revenue_id UUID,
      session_id UUID,
      event_id UUID,
      event_name LowCardinality(String),
      currency LowCardinality(String),
      revenue Decimal(19, 4),
      created_at DateTime64(6, 'UTC'),
      _ver UInt64
    ) ENGINE = ReplacingMergeTree(_ver)
    PARTITION BY toYYYYMM(created_at)
    ORDER BY (website_id, epoch, toDate(created_at), event_id, revenue_id)`,

    `CREATE TABLE IF NOT EXISTS ${v2Tables.heatmap} (
      website_id UUID,
      epoch UInt64,
      heatmap_event_id UUID,
      session_id UUID,
      visit_id UUID,
      url_path String,
      event_type Int32,
      x Nullable(Int32),
      y Nullable(Int32),
      page_x Nullable(Int32),
      page_y Nullable(Int32),
      page_w Nullable(Int32),
      page_h Nullable(Int32),
      viewport_w Nullable(Int32),
      viewport_h Nullable(Int32),
      scroll_pct Nullable(Int32),
      created_at DateTime64(6, 'UTC'),
      _ver UInt64
    ) ENGINE = ReplacingMergeTree(_ver)
    PARTITION BY toYYYYMM(created_at)
    ORDER BY (website_id, epoch, toDate(created_at), url_path, heatmap_event_id)`,

    `CREATE TABLE IF NOT EXISTS ${v2Tables.sessionReplay} (
      website_id UUID,
      epoch UInt64,
      replay_id UUID,
      session_id UUID,
      visit_id UUID,
      chunk_index Int32,
      events String,
      event_count Int32,
      started_at DateTime64(6, 'UTC'),
      ended_at DateTime64(6, 'UTC'),
      created_at DateTime64(6, 'UTC'),
      _ver UInt64
    ) ENGINE = ReplacingMergeTree(_ver)
    PARTITION BY toYYYYMM(created_at)
    ORDER BY (website_id, epoch, toDate(created_at), session_id, replay_id)`,

    `CREATE TABLE IF NOT EXISTS ${v2Tables.sessionData} (
      website_id UUID,
      epoch UInt64,
      session_data_id UUID,
      session_id UUID,
      data_key LowCardinality(String),
      string_value Nullable(String),
      number_value Nullable(Decimal(19, 4)),
      date_value Nullable(DateTime64(6, 'UTC')),
      data_type Int32,
      distinct_id Nullable(String),
      created_at DateTime64(6, 'UTC'),
      _ver UInt64
    ) ENGINE = ReplacingMergeTree(_ver)
    PARTITION BY toYYYYMM(created_at)
    ORDER BY (website_id, epoch, session_id, data_key, session_data_id)`,

    `CREATE TABLE IF NOT EXISTS ${v2Tables.sessionLink} (
      website_id UUID,
      epoch UInt64,
      distinct_id String,
      session_id UUID,
      created_at DateTime64(6, 'UTC'),
      _ver UInt64
    ) ENGINE = ReplacingMergeTree(_ver)
    PARTITION BY toYYYYMM(created_at)
    ORDER BY (website_id, epoch, distinct_id, session_id)`,

    // 4. Native AggregatingMergeTree: Hourly Log Summary (overview, AI bots, trends, measurement)
    `CREATE TABLE IF NOT EXISTS ${v2Tables.logHourAgg} (
      website_id UUID,
      epoch UInt64,
      hour DateTime('UTC'),
      source_id UUID,
      has_source Bool,
      bot LowCardinality(String),
      vendor LowCardinality(String),
      bot_type LowCardinality(String),
      ai_eligible Bool,
      recognition_state LowCardinality(String),
      classification_version LowCardinality(String),
      is_self_check Bool,
      is_unknown_crawler Bool,
      source_config_version LowCardinality(String),
      source_interval_version LowCardinality(String),
      requests AggregateFunction(count),
      get2xx AggregateFunction(sum, UInt64),
      abnormal AggregateFunction(sum, UInt64),
      pages AggregateFunction(uniqExact, String),
      last_at AggregateFunction(max, DateTime64(6, 'UTC'))
    ) ENGINE = AggregatingMergeTree()
    PARTITION BY toYYYYMM(hour)
    ORDER BY (
      website_id, epoch, hour, has_source, source_id, is_self_check,
      ai_eligible, bot_type, bot, vendor, recognition_state,
      classification_version, is_unknown_crawler,
      source_config_version, source_interval_version
    )`,

    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${v2Views.logHourAgg} TO ${v2Tables.logHourAgg} AS
    SELECT
      website_id,
      epoch,
      toStartOfHour(created_at) AS hour,
      coalesce(source_id, toUUID('00000000-0000-0000-0000-000000000000')) AS source_id,
      isNotNull(source_id) AS has_source,
      bot,
      vendor,
      bot_type,
      ai_eligible,
      recognition_state,
      coalesce(classification_version, '') AS classification_version,
      is_self_check,
      is_unknown_crawler,
      source_config_version,
      source_interval_version,
      countState() AS requests,
      sumState(toUInt64(method = 'GET' AND status >= 200 AND status <= 299)) AS get2xx,
      sumState(toUInt64(status >= 400)) AS abnormal,
      uniqExactState(path) AS pages,
      maxState(created_at) AS last_at
    FROM ${v2Tables.logs}
    WHERE _deleted = 0
    GROUP BY
      website_id, epoch, hour, source_id, has_source,
      bot, vendor, bot_type, ai_eligible, recognition_state,
      classification_version, is_self_check, is_unknown_crawler,
      source_config_version, source_interval_version`,

    // 5. Native AggregatingMergeTree: Hourly Log x Path Reconciliation & Top-Pages
    `CREATE TABLE IF NOT EXISTS ${v2Tables.logPathHourAgg} (
      website_id UUID,
      epoch UInt64,
      hour DateTime('UTC'),
      source_id UUID,
      has_source Bool,
      path String,
      request_host LowCardinality(String),
      host_basis LowCardinality(String),
      requests AggregateFunction(count),
      get2xx AggregateFunction(sum, UInt64),
      crawler AggregateFunction(sum, UInt64),
      candidate AggregateFunction(sum, UInt64),
      ambiguous AggregateFunction(sum, UInt64),
      content_type_samples AggregateFunction(sum, UInt64),
      confirmed_html AggregateFunction(sum, UInt64),
      config_samples AggregateFunction(sum, UInt64),
      unsampled_requests AggregateFunction(sum, UInt64),
      config_versions AggregateFunction(uniqExact, String),
      last_at AggregateFunction(max, DateTime64(6, 'UTC'))
    ) ENGINE = AggregatingMergeTree()
    PARTITION BY toYYYYMM(hour)
    ORDER BY (website_id, epoch, hour, has_source, source_id, path, request_host, host_basis)`,

    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${v2Views.logPathHourAgg} TO ${v2Tables.logPathHourAgg} AS
    SELECT
      website_id,
      epoch,
      toStartOfHour(created_at) AS hour,
      coalesce(fact.source_id, toUUID('00000000-0000-0000-0000-000000000000')) AS source_id,
      isNotNull(fact.source_id) AS has_source,
      path,
      request_host,
      host_basis,
      ${logPathStates}
    FROM ${v2Tables.logs} AS fact
    WHERE _deleted = 0 AND NOT is_self_check
    GROUP BY website_id, epoch, hour, source_id, has_source, path, request_host, host_basis`,

    // 6. Native AggregatingMergeTree: Hourly Browser Observation Summary (by received_at)
    `CREATE TABLE IF NOT EXISTS ${v2Tables.observationHourAgg} (
      website_id UUID,
      epoch UInt64,
      received_hour DateTime('UTC'),
      collection_source LowCardinality(String),
      classification LowCardinality(String),
      browser LowCardinality(String),
      obs_version LowCardinality(String),
      obs_features String,
      obs_mask UInt8,
      is_eligible Bool,
      has_observation Bool,
      identity_qualified Bool,
      identity_version LowCardinality(String),
      is_risk_flagged Bool,
      pv AggregateFunction(count),
      uv AggregateFunction(uniqExact, UUID),
      visits AggregateFunction(uniqExact, Tuple(UUID, UUID)),
      first_event_at AggregateFunction(min, DateTime64(6, 'UTC')),
      last_event_at AggregateFunction(max, DateTime64(6, 'UTC')),
      last_received_at AggregateFunction(max, DateTime64(6, 'UTC'))
    ) ENGINE = AggregatingMergeTree()
    PARTITION BY toYYYYMM(received_hour)
    ORDER BY (
      website_id, epoch, received_hour, is_eligible, collection_source,
      classification, browser, obs_version, obs_mask, has_observation,
      identity_qualified, identity_version, is_risk_flagged, obs_features
    )`,

    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${v2Views.observationHourAgg} TO ${v2Tables.observationHourAgg} AS
    SELECT
      website_id,
      epoch,
      toStartOfHour(received_at) AS received_hour,
      collection_source,
      classification,
      browser,
      obs_version,
      obs_features,
      obs_mask,
      is_eligible,
      has_observation,
      (identity_scope = 'browser' AND identity_available) AS identity_qualified,
      identity_version,
      is_risk_flagged,
      countState() AS pv,
      uniqExactState(session_id) AS uv,
      uniqExactState(tuple(visit_id, session_id)) AS visits,
      minState(created_at) AS first_event_at,
      maxState(created_at) AS last_event_at,
      maxState(received_at) AS last_received_at
    FROM ${v2Tables.browserEvents}
    WHERE _deleted = 0 AND event_type = 1 AND collection_source IN ('browser', 'legacy_override')
    GROUP BY
      website_id, epoch, received_hour, collection_source, classification, browser,
      obs_version, obs_features, obs_mask, is_eligible, has_observation,
      identity_qualified, identity_version, is_risk_flagged`,

    // 7. Native AggregatingMergeTree: Hourly Browser x Path (Reconciliation, Overview, Content)
    `CREATE TABLE IF NOT EXISTS ${v2Tables.browserPathHourAgg} (
      website_id UUID,
      epoch UInt64,
      hour DateTime('UTC'),
      hostname LowCardinality(String),
      url_path String,
      classification LowCardinality(String),
      is_eligible Bool,
      pv AggregateFunction(count),
      uv AggregateFunction(uniqExact, UUID),
      visits AggregateFunction(uniqExact, Tuple(UUID, UUID)),
      last_at AggregateFunction(max, DateTime64(6, 'UTC'))
    ) ENGINE = AggregatingMergeTree()
    PARTITION BY toYYYYMM(hour)
    ORDER BY (website_id, epoch, hour, is_eligible, hostname, url_path, classification)`,

    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${v2Views.browserPathHourAgg} TO ${v2Tables.browserPathHourAgg} AS
    SELECT
      website_id,
      epoch,
      toStartOfHour(created_at) AS hour,
      hostname,
      url_path,
      classification,
      is_eligible,
      ${browserPathStates}
    FROM ${v2Tables.browserEvents}
    WHERE _deleted = 0 AND event_type = 1
    GROUP BY website_id, epoch, hour, hostname, url_path, classification, is_eligible`,

    // 8. Lightweight control projection table for catalog & bookmark CH joins (no fsync)
    `CREATE TABLE IF NOT EXISTS warehouse_control_projection (
      website_id UUID,
      epoch UInt64,
      kind LowCardinality(String),
      revision UInt64,
      key String,
      value String,
      created_at DateTime64(6, 'UTC')
    ) ENGINE = MergeTree()
    ORDER BY (website_id, epoch, kind, revision, key)`,
  ];
}
