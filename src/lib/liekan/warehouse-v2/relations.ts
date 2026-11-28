/**
 * Single-table ClickHouse SQL relation builders for Warehouse v2.
 *
 * Drop-in replacements for v1's 8-table JOIN + warehouse_publication + argMax relations.
 * Powers all 13 statistics pages, realtime, logs, traffic quality, and native Umami queries
 * directly over ch_v2_logs and ch_v2_browser_events with zero JOINs and zero publication subqueries.
 */
import type { FactReadOptions } from '../warehouse/read';
import { v2Tables } from './schema';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

// Older imports and events without client UUIDs retain their detail-table representation.
export function v2EventDetailRelation(kind: 'event_data' | 'revenue'): string {
  const filter = 'website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64}';
  if (kind === 'event_data') {
    return `(SELECT website_id, epoch, event_data_id, website_event_id, created_at,
        data_key, string_value, number_value, date_value, data_type, _ver FROM ${v2Tables.eventData}
      WHERE ${filter}
      UNION ALL
      SELECT website_id, epoch, property.1 AS event_data_id, event_id AS website_event_id,
        created_at, property.2 AS data_key, property.3 AS string_value,
        property.4 AS number_value, property.5 AS date_value, property.6 AS data_type, _ver
      FROM ${v2Tables.browserEvents} ARRAY JOIN event_properties AS property
      WHERE ${filter} AND _deleted=0)`;
  }
  return `(SELECT website_id, epoch, revenue_id, session_id, event_id, event_name,
      currency, revenue, created_at, _ver FROM ${v2Tables.revenue} WHERE ${filter}
    UNION ALL
    SELECT website_id, epoch, purchase.1 AS revenue_id, session_id, event_id,
      coalesce(event_name,'') AS event_name, purchase.2 AS currency,
      purchase.3 AS revenue, created_at, _ver
    FROM ${v2Tables.browserEvents} ARRAY JOIN event_revenue AS purchase
    WHERE ${filter} AND _deleted=0)`;
}

function timeWindowClause(options: FactReadOptions = {}, col = 'created_at'): string {
  const w = options.immutableTimeWindow;
  if (!w) return '';
  const op = w.endExclusive ? '<' : '<=';
  const parts = [
    `AND ${col} >= {${w.start}:DateTime64(6,'UTC')} AND ${col} ${op} {${w.end}:DateTime64(6,'UTC')}`,
  ];
  if (w.hours) {
    parts.push(`AND toUnixTimestamp(toStartOfHour(${col})) IN {${w.hours}:Array(UInt32)}`);
  }
  if (w.excludedHours) {
    parts.push(`AND toUnixTimestamp(toStartOfHour(${col})) NOT IN {${w.excludedHours}:Array(Int64)}`);
  }
  return parts.join(' ');
}

function logIntervalFilter(alias = 'l'): string {
  const interval = `arrayExists(i -> toUnixTimestamp64Micro(${alias}.created_at)>=toInt64(i.2) AND toUnixTimestamp64Micro(${alias}.created_at)<toInt64(i.3)
    AND (isNull(${alias}.source_id) OR ${alias}.source_id=i.1),arrayZip({wh_interval_source:Array(UUID)},{wh_interval_start:Array(String)},{wh_interval_end:Array(String)}))`;
  return `((isNull(${alias}.source_id) AND NOT ${interval}) OR (isNotNull(${alias}.source_id) AND ${interval}))`;
}

export const v2GeoEvidenceColumns = `nullIf(request_host, '') AS _geo_host,
    nullIf(host_basis, '') AS _geo_basis,
    JSONExtract(coalesce(nullIf(JSONExtractRaw(evidence_json,'measurement'),''),'{}'),'samplingTimeBasis','Nullable(String)') AS _geo_sampling_time,
    JSONExtract(coalesce(nullIf(JSONExtractRaw(evidence_json,'measurement'),''),'{}'),'samplingBasis','Nullable(String)') AS _geo_sampling_basis,
    sampling_rate AS _geo_sampling_rate,
    JSONExtract(coalesce(identity_evidence,'{}'),'reason','Nullable(String)') AS _geo_reason,
    nullIf(content_type_state, '') AS _geo_mime_state,
    nullIf(content_type_value, '') AS _geo_mime`;

export function v2EffectiveLogRelation(options: FactReadOptions = {}): string {
  const timeClause = timeWindowClause(options, 'l.created_at');
  const evidence = options.geoEvidence
    ? `, l.crawler_id, l.catalog_version, l.classification_version, ${v2GeoEvidenceColumns}`
    : '';
  return `(SELECT
    l.id, l.website_id, l.import_id, l.created_at, l.path, l.method, l.status, l.bytes,
    l.ip_masked, l.ip_hash, l.user_agent, l.location, l.bot, l.vendor, l.bot_type,
    l.verification, l.source_id, l.event_digest, l.verification_version, l.ai_eligible,
    l.recognition_state, l.recognition_candidates, l.verification_observed_at, l.verification_reason${evidence}
  FROM ${v2Tables.logs} l
  WHERE l.website_id = {wh_site:UUID} AND l.epoch = {wh_epoch:UInt64} AND l._deleted = 0
    ${timeClause}
    AND ${logIntervalFilter('l')})`;
}

export function v2ReportingLogRelation(
  options: FactReadOptions = {},
  projection?: readonly string[],
): string {
  const timeClause = timeWindowClause(options, 'l.created_at');
  const allCols: Record<string, string> = {
    id: 'l.id',
    website_id: 'l.website_id',
    import_id: 'l.import_id',
    created_at: 'l.created_at',
    path: 'l.path',
    ...(projection?.includes('human_path') ? { human_path: 'l.human_path' } : {}),
    method: 'l.method',
    status: 'l.status',
    bytes: 'l.bytes',
    ip_masked: 'l.ip_masked',
    ip_hash: 'l.ip_hash',
    user_agent: 'l.user_agent',
    location: 'l.location',
    bot: 'l.bot',
    vendor: 'l.vendor',
    bot_type: 'l.bot_type',
    verification: 'l.verification',
    source_id: 'l.source_id',
    event_digest: 'l.event_digest',
    verification_version: 'l.verification_version',
    ai_eligible: 'l.ai_eligible',
    recognition_state: 'l.recognition_state',
    recognition_candidates: 'l.recognition_candidates',
    verification_observed_at: 'l.verification_observed_at',
    verification_reason: 'l.verification_reason',
    reporting_crawler_id: 'l.crawler_id',
    reporting_catalog_version: 'l.catalog_version',
    reporting_classification_version: 'l.classification_version',
    reporting_identity_evidence: 'l.identity_evidence',
    reporting_generation: `nullIf({wh_repair_generation:UUID},toUUID('${ZERO_UUID}'))`,
  };
  const selected = projection?.length ? [...new Set(projection)] : Object.keys(allCols);
  const exprs = selected
    .filter(c => Object.hasOwn(allCols, c))
    .map(c => `${allCols[c]} AS "${c}"`)
    .join(',');

  return `(SELECT ${exprs}
  FROM ${v2Tables.logs} l
  WHERE l.website_id = {wh_site:UUID} AND l.epoch = {wh_epoch:UInt64} AND l._deleted = 0
    ${timeClause}
    AND ${logIntervalFilter('l')})`;
}

function v2BrowserEligibility(alias = 'e'): string {
  const effHost = `coalesce(${alias}.normalized_hostname, nullIf(${alias}.hostname, ''))`;
  return `{wh_resource:String}='website' AND ${alias}.event_type IN(1,2,5) AND ${alias}.collection_source='browser'
    AND ${alias}.classification<>'automated'
    AND NOT has(${alias}.quality_reasons,'bot_check_disabled')
    AND ({wh_policy_mode:String}<>'strict' OR ${alias}.classification<>'suspected')
    AND (empty({wh_allowed_hosts:Array(String)}) OR (has({wh_allowed_hosts:Array(String)},${effHost})
      AND (isNull(${alias}.origin_hostname) OR has({wh_allowed_hosts:Array(String)},${alias}.origin_hostname))))`;
}

const WEBSITE_EVENT_SELECT = (alias = 'e') =>
  `${alias}.event_id, ${alias}.website_id, ${alias}.session_id, ${alias}.created_at,
  ${alias}.url_path, ${alias}.url_query, ${alias}.referrer_path, ${alias}.referrer_query,
  ${alias}.referrer_domain, ${alias}.page_title, ${alias}.event_type, ${alias}.event_name,
  ${alias}.visit_id, ${alias}.tag, ${alias}.fbclid, ${alias}.gclid, ${alias}.li_fat_id,
  ${alias}.msclkid, ${alias}.ttclid, ${alias}.twclid, ${alias}.utm_campaign, ${alias}.utm_content,
  ${alias}.utm_medium, ${alias}.utm_source, ${alias}.utm_term, ${alias}.hostname,
  ${alias}.cls, ${alias}.fcp, ${alias}.inp, ${alias}.lcp, ${alias}.ttfb`;

export function v2BrowserEventRelation(
  population: 'admissible' | 'observed' | 'qualified' = 'qualified',
): string {
  const qualified =
    population === 'qualified'
      ? "AND e.identity_scope='browser' AND e.identity_available AND e.classification='browser'"
      : '';
  return `(SELECT ${WEBSITE_EVENT_SELECT('e')}
  FROM ${v2Tables.browserEvents} e
  WHERE e.website_id = {wh_site:UUID} AND e.epoch = {wh_epoch:UInt64} AND e._deleted = 0
    AND ${v2BrowserEligibility('e')} ${qualified})`;
}

export function v2WebsiteEventRelation(
  population: 'observed' | 'qualified' = 'qualified',
): string {
  const qualified =
    population === 'qualified'
      ? "AND e.identity_scope='browser' AND e.identity_available AND e.classification='browser'"
      : '';
  return `(SELECT ${WEBSITE_EVENT_SELECT('e')}
  FROM ${v2Tables.browserEvents} e
  WHERE e.website_id = {wh_site:UUID} AND e.epoch = {wh_epoch:UInt64} AND e._deleted = 0
    AND ((${v2BrowserEligibility('e')} ${qualified})
      OR ({wh_resource:String}='link' AND e.event_type=3)
      OR ({wh_resource:String}='pixel' AND e.event_type=4)))`;
}

export function v2GeographicEventRelation(relevantVisits = false, includeEntry = false): string {
  const visitFilter = relevantVisits ? 'AND (e.session_id, e.visit_id) IN report_visit_keys' : '';
  const entrySelect = includeEntry
    ? `e.referrer_domain AS _entry_referrer_domain, e.utm_source AS _entry_utm_source,
       e.utm_medium AS _entry_utm_medium, e.utm_campaign AS _entry_utm_campaign,
       e.referrer_path AS _entry_referrer_path, e.referrer_query AS _entry_referrer_query,
       e.utm_term AS _entry_utm_term,`
    : '';
  return `(SELECT ${WEBSITE_EVENT_SELECT('e')},
    ${entrySelect}
    e.country AS liekan_country, e.region AS liekan_region, e.city AS liekan_city,
    nullIf(e.browser, '') AS liekan_browser, e.os AS liekan_os, e.device AS liekan_device,
    e.screen AS liekan_screen, e.language AS liekan_language,
    e.identity_available AS liekan_identity_available,
    e.distinct_id AS liekan_distinct_id,
    e.session_created_at AS liekan_session_created_at
  FROM ${v2Tables.browserEvents} e
  WHERE e.website_id = {wh_site:UUID} AND e.epoch = {wh_epoch:UInt64} AND e._deleted = 0
    AND ((${v2BrowserEligibility('e')} AND e.identity_scope='browser' AND e.identity_available AND e.classification='browser')
      OR ({wh_resource:String}='link' AND e.event_type=3)
      OR ({wh_resource:String}='pixel' AND e.event_type=4))
    ${visitFilter})`;
}

export function v2AnalyticsEventRelation(relevantVisits = false): string {
  return v2GeographicEventRelation(relevantVisits, false);
}

export function v2WebsiteSummaryEventRelation(): string {
  return `(SELECT
    e.created_at, e.session_id, e.visit_id, e.event_type,
    e.utm_source, e.utm_medium, e.referrer_domain,
    (e.identity_scope='browser' AND e.identity_available AND e.classification='browser') AS qualified,
    nullIf(e.identity_version, '') AS identity_version,
    nullIf(e.rule_version, '') AS rule_version,
    toString(e.catalog_version) AS catalog_version
  FROM ${v2Tables.browserEvents} e
  WHERE e.website_id = {wh_site:UUID} AND e.epoch = {wh_epoch:UInt64} AND e._deleted = 0
    AND e.created_at >= {previousStart:DateTime64(6,'UTC')} AND e.created_at <= {end:DateTime64(6,'UTC')}
    AND ${v2BrowserEligibility('e')})`;
}

export function v2QualityAuditRelation(options: FactReadOptions = {}): string {
  const timeClause = timeWindowClause(options, 'e.created_at');
  return `(SELECT ${WEBSITE_EVENT_SELECT('e')},
    e.event_id AS verdict_id,
    e.normalized_hostname AS normalized_hostname,
    e.classification AS classification,
    e.quality_reasons AS reasons,
    e.rule_version AS rule_version,
    e.classification AS current_classification,
    e.quality_reasons AS current_reasons,
    e.collection_source AS source,
    e.rule_version AS current_rule_version,
    e.repair_scope_id AS repair_scope_id,
    e.range_status AS range_status,
    e.range_version AS range_version,
    e.received_at AS received_at,
    e.identity_available AS identity_available,
    e.identity_scope AS identity_scope,
    coalesce(e.normalized_hostname, nullIf(e.hostname, '')) AS policy_hostname,
    e.origin_hostname AS origin_hostname,
    false AS excluded
  FROM ${v2Tables.browserEvents} e
  WHERE e.website_id = {wh_site:UUID} AND e.epoch = {wh_epoch:UInt64} AND e._deleted = 0
    ${timeClause})`;
}

export function v2NativeRelations(hourly?: string): string[] {
  const arrays = [
    'hostname',
    'url_path',
    'url_query',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'referrer_domain',
    'page_title',
    'gclid',
    'fbclid',
    'msclkid',
    'ttclid',
    'li_fat_id',
    'twclid',
    'event_name',
    'tag',
  ];
  return [
    `website_event AS (SELECT *, liekan_country AS country, liekan_region AS region, liekan_city AS city,
      liekan_browser AS browser, liekan_os AS os, liekan_device AS device, liekan_screen AS screen,
      liekan_language AS language, liekan_distinct_id AS distinct_id FROM ${v2GeographicEventRelation()})`,
    `heatmap_event AS (SELECT * FROM ${v2Tables.heatmap} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64})`,
    `session_replay AS (SELECT * FROM ${v2Tables.sessionReplay} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64})`,
    `event_data AS (SELECT d.*, d.website_event_id AS event_id, e.session_id, e.event_name, e.url_path
      FROM ${v2EventDetailRelation('event_data')} d
      INNER JOIN website_event e ON e.website_id=d.website_id AND e.event_id=d.website_event_id
      WHERE d.website_id={wh_site:UUID} AND d.epoch={wh_epoch:UInt64})`,
    `session_data AS (SELECT * FROM ${v2Tables.sessionData} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64})`,
    `session_link AS (SELECT * FROM ${v2Tables.sessionLink} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64})`,
    `website_revenue AS (SELECT r.*, e.url_path, e.visit_id
      FROM ${v2EventDetailRelation('revenue')} r
      INNER JOIN website_event e ON e.website_id=r.website_id AND e.event_id=r.event_id
      WHERE r.website_id={wh_site:UUID} AND r.epoch={wh_epoch:UInt64})`,
    hourly
      ? `website_event_stats_hourly AS ${hourly}`
      : `website_event_stats_hourly AS (SELECT e.* EXCEPT(${arrays.join(',')}),
      ${arrays.map(c => `${c === 'event_name' ? "if(e.event_type=2,[coalesce(e.event_name,'')],[])" : `arrayFilter(v->v!=''${c === 'referrer_domain' ? " AND v!=coalesce(e.hostname,'')" : ''},[coalesce(e.${c},'')])`} AS ${c}`).join(',')},
      toUInt64(event_type NOT IN(2,5)) AS views,created_at AS min_time,created_at AS max_time,
      arrayReduce('argMinState',[coalesce(e.url_path,'')],[e.created_at]) AS entry_url,
      arrayReduce('argMaxState',[coalesce(e.url_path,'')],[e.created_at]) AS exit_url FROM website_event e)`,
    `event_data_pivot AS (SELECT website_id,session_id,event_id,event_name,url_path,created_at,
      groupArrayState(data_key) AS property_keys,
      groupArrayState(multiIf(data_type IN(1,3,5),coalesce(string_value,''),data_type=2,toString(coalesce(number_value,0)),data_type=4,toString(coalesce(date_value,toDateTime64(0,6))),'')) AS property_values,
      groupArrayState(toUInt32(data_type)) AS property_types FROM event_data
      GROUP BY website_id,session_id,event_id,event_name,url_path,created_at)`,
  ];
}
