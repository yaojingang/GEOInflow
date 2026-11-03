import { factTable, identifier } from './catalog';
import { boundaryParameters, type FactReadOptions, factRelation, type ReadBoundary } from './read';

export type ReportingMetadata = {
  boundary: ReadBoundary;
  resourceKind: 'website' | 'link' | 'pixel';
  controlRevision: string;
  catalogRevision?: string;
  bookmarkRevision?: string;
  population: Record<string, unknown>;
  reports: { id: string; name: string; type: string; parameters: Record<string, any> }[];
  policyMode: string;
  allowedHostnames: string[];
  hostnames: { reported_hash: string; hostname: string }[];
  intervals: { source_id: string; starts_us: string; ends_us: string | null }[];
  repairRunId: string | null;
  repairGeneration: string | null;
  exclusions: string[];
};
const zeroUUID = '00000000-0000-0000-0000-000000000000';
export function reportingParameters(m: ReportingMetadata) {
  return {
    ...boundaryParameters(m.boundary),
    wh_resource: m.resourceKind,
    wh_policy_mode: m.policyMode,
    wh_allowed_hosts: m.allowedHostnames,
    wh_host_hashes: m.hostnames.map(h => h.reported_hash),
    wh_host_values: m.hostnames.map(h => h.hostname),
    wh_interval_source: m.intervals.map(i => i.source_id),
    wh_interval_start: m.intervals.map(i => i.starts_us),
    wh_interval_end: m.intervals.map(i => i.ends_us ?? '9223372036854775807'),
    wh_repair_run: m.repairRunId ?? zeroUUID,
    wh_repair_generation: m.repairGeneration ?? zeroUUID,
    wh_exclusions: m.exclusions,
  };
}
// Extract only requested repair fields before version aggregation. Keeping the
// entire JSON document in every argMax/join state makes wide historical reports
// retain unrelated proof payloads. These projections preserve missing/null and
// select the same accepted version as every ordinary fact column.
const repairFields: NonNullable<FactReadOptions['repairFields']> = [
  ...[
    'classification',
    'ruleVersion',
    'bot',
    'vendor',
    'botType',
    'verification',
    'recognitionState',
    'verificationVersion',
    'verificationReason',
    'crawlerId',
  ].map(key => ({
    name: `_repair_${key.toLowerCase()}`,
    column: 'after_value' as const,
    key,
    type: 'String' as const,
  })),
  { name: '_repair_reasons', column: 'after_value', key: 'reasons', type: 'Strings' },
  { name: '_repair_aieligible', column: 'after_value', key: 'aiEligible', type: 'Bool' },
  {
    name: '_repair_recognitioncandidates',
    column: 'after_value',
    key: 'recognitionCandidates',
    type: 'Raw',
  },
  {
    name: '_repair_verificationobservedat',
    column: 'after_value',
    key: 'verificationObservedAt',
    type: 'Time',
  },
  { name: '_repair_catalogversion', column: 'proof', key: 'catalogVersion', type: 'UUID' },
  { name: '_repair_hascatalogversion', column: 'proof', key: 'catalogVersion', type: 'Has' },
  { name: '_repair_rulepack', column: 'proof', key: 'rulepack', type: 'String' },
];
const repairRelation = () => factRelation('liekan_history_repair_result', { repairFields });
const columns = (name: string, alias: string, overrides: Record<string, string> = {}) =>
  factTable(name)
    .columns.map(
      c => `${overrides[c.name] ?? `${alias}.${identifier(c.name)}`} AS ${identifier(c.name)}`,
    )
    .join(',');

export function repairedQualityRelation(original = false, options: FactReadOptions = {}) {
  return `(SELECT ${columns('liekan_event_quality', 'q', {
    classification: `coalesce(r._repair_classification,q.classification)`,
    reasons: `if(isNull(r.record_id),q.reasons,r._repair_reasons)`,
    rule_version: `coalesce(r._repair_ruleversion,q.rule_version)`,
    catalog_version: `if(r._repair_hascatalogversion,r._repair_catalogversion,q.catalog_version)`,
  })}${original ? ',q.classification AS original_classification,q.reasons AS original_reasons,q.rule_version AS original_rule_version' : ''} FROM ${factRelation('liekan_event_quality', options)} q
  LEFT JOIN ${repairRelation()} r ON r.record_id=toString(q.event_id) AND r.website_id=q.website_id
    AND r.run_id={wh_repair_run:UUID} AND r.generation={wh_repair_generation:UUID} AND r.kind='event' AND isNull(r.issue))`;
}

export function effectiveLogRelation(options: FactReadOptions = {}) {
  const interval = `arrayExists(i -> toUnixTimestamp64Micro(l.created_at)>=toInt64(i.2) AND toUnixTimestamp64Micro(l.created_at)<toInt64(i.3)
    AND (isNull(l.source_id) OR l.source_id=i.1),arrayZip({wh_interval_source:Array(UUID)},{wh_interval_start:Array(String)},{wh_interval_end:Array(String)}))`;
  return `(SELECT l.* FROM ${factRelation('liekan_log', options)} l WHERE (isNull(l.source_id) AND NOT ${interval}) OR (isNotNull(l.source_id) AND ${interval}))`;
}
export const logSummaryColumns = [
  'path',
  'status',
  'ai_eligible',
  'bot_type',
  'bot',
  'recognition_state',
  'reporting_classification_version',
] as const;
export function reportingLogRelation(
  options: FactReadOptions = {},
  projection?: readonly string[],
) {
  const overrides: Record<string, string> = {};
  for (const [column, key] of Object.entries({
    bot: 'bot',
    vendor: 'vendor',
    bot_type: 'botType',
    verification: 'verification',
    recognition_state: 'recognitionState',
  }))
    overrides[column] = `coalesce(r._repair_${key.toLowerCase()},l.${column})`;
  for (const [column, value] of Object.entries({
    verification_version: 'r._repair_verificationversion',
    ai_eligible: 'r._repair_aieligible',
    recognition_candidates: 'r._repair_recognitioncandidates',
    verification_observed_at: 'r._repair_verificationobservedat',
    verification_reason: 'r._repair_verificationreason',
  }))
    overrides[column] = `if(isNull(r.record_id),l.${column},${value})`;
  const outputs: Record<string, string> = Object.fromEntries(
    factTable('liekan_log').columns.map(c => [
      c.name,
      overrides[c.name] ?? `l.${identifier(c.name)}`,
    ]),
  );
  Object.assign(outputs, {
    reporting_crawler_id: 'if(isNull(r.record_id),e.crawler_id,r._repair_crawlerid)',
    reporting_catalog_version: 'if(isNull(r.record_id),e.catalog_version,r._repair_catalogversion)',
    reporting_classification_version:
      'if(isNull(r.record_id),e.classification_version,r._repair_rulepack)',
    reporting_identity_evidence: 'e.identity_evidence',
    reporting_generation: `nullIf({wh_repair_generation:UUID},toUUID('${zeroUUID}'))`,
  });
  const selected = projection ? [...new Set(projection)] : Object.keys(outputs);
  if (!selected.length || selected.some(column => !Object.hasOwn(outputs, column)))
    throw new Error('Invalid warehouse log projection');
  const needed = {
    l: new Set(['source_id', 'created_at']),
    e: new Set<string>(),
    r: new Set<string>(),
  };
  // These are locally generated expressions, never user SQL. Record each
  // column dependency before packing the accepted row into one aggregate state.
  for (const column of selected)
    for (const match of outputs[column].matchAll(/\b([ler])\.(?:"([^"]+)"|([a-z_][a-z0-9_]*))/g))
      needed[match[1] as keyof typeof needed].add(match[2] ?? match[3]);
  for (const alias of ['e', 'r'] as const) {
    if (!needed[alias].size) continue;
    needed.l.add('website_id');
    needed.l.add('id');
    needed[alias].add('website_id');
    needed[alias].add(alias === 'e' ? 'log_id' : 'record_id');
  }
  if (needed.r.size) for (const c of ['run_id', 'generation', 'kind']) needed.r.add(c);
  const logOptions = projection ? { ...options, columns: [...needed.l] } : options;
  // Evidence and repairs use independent timestamps. Scan their narrow accepted
  // columns and join the windowed logs directly: constructing a log-ID set for
  // each family/publication branch multiplies scans and aggregate memory for
  // ordinary weekly reports.
  const evidence = projection ? { columns: [...needed.e] } : {};
  const repair = factRelation('liekan_history_repair_result', {
    ...(projection ? { columns: [...needed.r] } : {}),
    repairFields: projection ? repairFields.filter(f => needed.r.has(f.name)) : repairFields,
  });
  return `(SELECT ${selected.map(c => `${outputs[c]} AS ${identifier(c)}`).join(',')}
    FROM ${effectiveLogRelation(logOptions)} l
    ${needed.e.size ? `LEFT JOIN ${factRelation('liekan_crawler_evidence', evidence)} e ON e.website_id=l.website_id AND e.log_id=l.id` : ''}
    ${
      needed.r.size
        ? `LEFT JOIN ${repair} r ON r.website_id=l.website_id AND r.record_id=l.id
      AND r.run_id={wh_repair_run:UUID} AND r.generation={wh_repair_generation:UUID} AND r.kind='log'`
        : ''
    })`;
}

export function normalizedHostnameRelation() {
  return `(SELECT key,any(JSONExtractString(value,'value')) AS hostname FROM warehouse_control_projection
    WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND kind='event-host-v1' AND revision=0
      AND toUUIDOrNull(JSONExtractString(value,'candidateId')) IN (SELECT argMax(candidate_id,publication) FROM warehouse_publication
        WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND family='website_event' AND publication<={wh_publication:UInt64} GROUP BY attempt_id)
    GROUP BY key)`;
}
export function browserEventRelation(
  population: 'admissible' | 'observed' | 'qualified' = 'qualified',
) {
  const hostname = `coalesce(q.hostname,nullIf(arrayElement({wh_host_values:Array(String)},indexOf({wh_host_hashes:Array(String)},lower(hex(SHA256(coalesce(e.hostname,'')))))),''),nullIf(host.hostname,''))`;
  const excluded =
    population === 'admissible'
      ? ''
      : `AND e.event_id NOT IN (SELECT event_id FROM ${factRelation('liekan_traffic_exclusion_member')} WHERE collection_id IN {wh_exclusions:Array(UUID)})`;
  const qualified =
    population === 'qualified'
      ? "AND env.scope='browser' AND env.identity_available AND q.classification='browser'"
      : '';
  return `(SELECT ${columns('website_event', 'e')} FROM ${factRelation('website_event')} e
    INNER JOIN ${repairedQualityRelation()} q ON q.website_id=e.website_id AND q.event_id=e.event_id
    LEFT JOIN ${factRelation('liekan_event_environment')} env ON env.website_id=e.website_id AND env.event_id=e.event_id
    LEFT JOIN ${normalizedHostnameRelation()} host ON host.key=lower(hex(SHA256(coalesce(e.hostname,''))))
    WHERE {wh_resource:String}='website' AND e.event_type IN(1,2,5) AND q.source='browser' AND q.classification<>'automated'
      AND NOT has(q.reasons,'bot_check_disabled') AND ({wh_policy_mode:String}<>'strict' OR q.classification<>'suspected')
      AND (empty({wh_allowed_hosts:Array(String)}) OR (has({wh_allowed_hosts:Array(String)},${hostname})
        AND (isNull(env.origin_hostname) OR has({wh_allowed_hosts:Array(String)},env.origin_hostname)))) ${excluded} ${qualified})`;
}
export function websiteEventRelation(population: 'observed' | 'qualified' = 'qualified') {
  return `(SELECT * FROM ${browserEventRelation(population)} UNION ALL SELECT ${columns('website_event', 'e')} FROM ${factRelation('website_event')} e
    WHERE ({wh_resource:String}='link' AND event_type=3) OR ({wh_resource:String}='pixel' AND event_type=4))`;
}

// The anchor is selected from the complete eligible visit, independently of the
// caller's report window. A custom event cannot invent a page-view location.
export function geographicEventRelation() {
  const events = websiteEventRelation();
  return `(WITH wh_eligible AS ${events}, wh_anchored AS (
    SELECT *,if(countIf(event_type NOT IN(2,5)) OVER visit>0,
      tupleElement(argMinIf(tuple(event_id),tuple(created_at,event_id),event_type NOT IN(2,5)) OVER visit,1),NULL) AS anchor_id
    FROM wh_eligible WINDOW visit AS (PARTITION BY session_id,visit_id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
  ) SELECT ${columns('website_event', 'e')},
    ${['country', 'region', 'city'].map(c => `if(isNotNull(g.event_id),g.${c},s.${c}) AS liekan_${c}`).join(',')},
    ${['browser', 'os', 'device', 'screen', 'language'].map(c => `if(e.event_type IN(3,4),s.${c},env.${c}) AS liekan_${c}`).join(',')},
    coalesce(env.identity_available,e.event_type IN(3,4)) AS liekan_identity_available
    ,if(e.event_type IN(3,4),s.distinct_id,env.distinct_id) AS liekan_distinct_id
    ,s.created_at AS liekan_session_created_at
    FROM wh_anchored e INNER JOIN ${factRelation('session')} s ON s.session_id=e.session_id AND s.website_id=e.website_id
    LEFT JOIN ${factRelation('liekan_event_geography')} g ON g.website_id=e.website_id AND g.event_id=e.anchor_id
    LEFT JOIN ${factRelation('liekan_event_environment')} env ON env.website_id=e.website_id AND env.event_id=e.event_id)`;
}

export function sessionPropertyRelation() {
  return `(SELECT ${columns('session_data', 'd')} FROM ${factRelation('session_data')} d
    INNER JOIN ${factRelation('liekan_session_data_source')} src ON src.website_id=d.website_id
      AND src.session_id=d.session_id AND src.data_key=d.data_key
    WHERE src.scope='browser' AND (
      (src._version>0 AND src.row_digest=d._row_hash) OR
      ((src._row_hash,d._row_hash,toString(src._candidate_id),src._version) IN (SELECT key,JSONExtractString(value,'value'),JSONExtractString(value,'candidateId'),revision FROM warehouse_control_projection
        WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND kind='pg-session-property-v2')))
      AND ({wh_policy_mode:String}<>'strict' OR src.classification<>'suspected')
      AND (empty({wh_allowed_hosts:Array(String)}) OR (has({wh_allowed_hosts:Array(String)},coalesce(src.hostname,''))
        AND (isNull(src.origin_hostname) OR has({wh_allowed_hosts:Array(String)},src.origin_hostname))))
      AND d.session_id IN (SELECT session_id FROM ${browserEventRelation()}))`;
}

export function sessionLinkRelation() {
  return `(SELECT ${columns('session_link', 'l')} FROM ${factRelation('session_link')} l
    INNER JOIN ${factRelation('liekan_session_link_source')} src ON src.website_id=l.website_id
      AND src.session_id=l.session_id AND src.distinct_id=l.distinct_id
    WHERE src.scope='browser' AND ({wh_policy_mode:String}<>'strict' OR src.classification<>'suspected')
      AND (empty({wh_allowed_hosts:Array(String)}) OR (has({wh_allowed_hosts:Array(String)},coalesce(src.hostname,''))
        AND (isNull(src.origin_hostname) OR has({wh_allowed_hosts:Array(String)},src.origin_hostname))))
      AND l.session_id IN (SELECT session_id FROM ${browserEventRelation()}))`;
}

/** Raw audit evidence and effective policy are kept separate in the same scan. */
export function qualityAuditRelation(
  options: FactReadOptions = { immutableTimeWindow: { start: 'auditStart', end: 'auditEnd' } },
) {
  return `(SELECT ${columns('website_event', 'e')},q.event_id AS verdict_id,q.hostname AS normalized_hostname,
    q.original_classification AS classification,q.original_reasons AS reasons,q.original_rule_version AS rule_version,
    q.classification AS current_classification,q.reasons AS current_reasons,q.source AS source,
    q.rule_version AS current_rule_version,q.repair_scope_id AS repair_scope_id,
    q.range_status AS range_status,q.range_version AS range_version,q.created_at AS received_at,
    coalesce(env.identity_available,false) AS identity_available,env.scope AS identity_scope,
    coalesce(q.hostname,nullIf(host.hostname,'')) AS policy_hostname,env.origin_hostname AS origin_hostname,
    e.event_id IN (SELECT event_id FROM ${factRelation('liekan_traffic_exclusion_member')} WHERE collection_id IN {wh_exclusions:Array(UUID)}) AS excluded
    FROM ${factRelation('website_event', options)} e
    LEFT JOIN ${repairedQualityRelation(true, options.recordKeysParameter ? { recordKeysParameter: options.recordKeysParameter } : {})} q ON q.website_id=e.website_id AND q.event_id=e.event_id
    LEFT JOIN ${factRelation('liekan_event_environment')} env ON env.website_id=e.website_id AND env.event_id=e.event_id
    LEFT JOIN ${normalizedHostnameRelation()} host ON host.key=lower(hex(SHA256(coalesce(e.hostname,'')))))`;
}
export function qualityIncludedPredicate(mode = 'wh_policy_mode', hosts = 'wh_allowed_hosts') {
  return `coalesce(source='browser' AND event_type IN(1,2,5) AND current_classification='browser'
    AND identity_scope='browser' AND identity_available AND NOT has(current_reasons,'bot_check_disabled')
    AND ({${mode}:String}<>'strict' OR current_classification<>'suspected')
    AND (empty({${hosts}:Array(String)}) OR (has({${hosts}:Array(String)},policy_hostname)
      AND (isNull(origin_hostname) OR has({${hosts}:Array(String)},origin_hostname)))) AND NOT excluded,false)`;
}
