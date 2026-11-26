import { factTable, identifier } from './catalog';
import { recordKeyColumns } from './codec';
import { factMetadata } from './schema';
import { v2EventDetailRelation } from '../warehouse-v2/relations';
import { v2Tables, warehouseV2Enabled } from '../warehouse-v2/index';

export type ReadBoundary = {
  websiteId: string;
  epoch: string;
  publication: string;
  deletionRevision: string;
};

export function boundaryParameters(boundary: ReadBoundary) {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(boundary.websiteId)) {
    throw new Error('Invalid warehouse website boundary');
  }
  for (const value of [boundary.epoch, boundary.publication, boundary.deletionRevision]) {
    if (!/^\d+$/.test(value) || BigInt(value) > 9223372036854775807n) {
      throw new Error('Invalid warehouse revision boundary');
    }
  }
  return {
    wh_site: boundary.websiteId,
    wh_epoch: boundary.epoch,
    wh_publication: boundary.publication,
    wh_deletion: boundary.deletionRevision,
  };
}

type FactTimeWindow = {
  start: string;
  end: string;
  endExclusive?: boolean;
  hours?: string;
  // Only immutable log event time may exclude already published model hours.
  excludedHours?: string;
};
const validParameterName = (name: string) => /^[a-z][a-zA-Z0-9_]*$/.test(name);

export function acceptedCandidates(name: string, prefilter = '') {
  return `SELECT attempt_id, argMax(candidate_id, publication)
    FROM warehouse_publication
    WHERE website_id = {wh_site:UUID} AND epoch = {wh_epoch:UInt64}
      AND family = '${name}' AND publication <= {wh_publication:UInt64}
      ${prefilter}
    GROUP BY attempt_id`;
}

export function exactTimeFilter(window: FactTimeWindow) {
  return `_record_time >= {${window.start}:DateTime64(6,'UTC')} AND _record_time ${window.endExclusive ? '<' : '<='} {${window.end}:DateTime64(6,'UTC')}`;
}

export function datePruning(window: FactTimeWindow) {
  const end = `{${window.end}:DateTime64(6,'UTC')}`;
  return `toDate32(_record_time) BETWEEN toDate32({${window.start}:DateTime64(6,'UTC')}) AND toDate32(${window.endExclusive ? `subtractMicroseconds(${end},1)` : end})`;
}

function logHourFilter(window: FactTimeWindow) {
  return [
    window.hours
      ? `AND toUnixTimestamp(toStartOfHour(_record_time)) IN {${window.hours}:Array(UInt32)}`
      : '',
    window.excludedHours
      ? `AND toUnixTimestamp(toStartOfHour(_record_time)) NOT IN {${window.excludedHours}:Array(Int64)}`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

// Callers apply business filters OUTSIDE this relation. Filtering a mutable field
// before selecting its latest accepted version could resurrect an older value.
// Explicit manifest selection also makes retry remnants invisible before any merge.
export type FactReadOptions = {
  // A report with a known projection can keep one compact aggregate state per
  // record. Without a projection, separate states allow CH to prune columns.
  columns?: readonly string[];
  recordKeysParameter?: string;
  sessionIdsParameter?: string;
  immutableTimeWindow?: FactTimeWindow;
  // A build may reuse the complete set of physical attempts from its hour probe.
  // The manifest still decides which candidate, if any, is accepted at the cut.
  logAttemptIdsParameter?: string;
  // Log ingestion deduplicates IDs instead of changing their event time. Use
  // their physical day/key order for version aggregation in large overviews.
  orderedLogVersions?: true;
  // The overview has verified this window contains a bounded set of log IDs.
  narrowLogWindow?: true;
  // The run, generation and kind are part of each repair result's primary key.
  activeLogRepair?: true;
  // Restrict evidence by the immutable log ID, using log time on the logs.
  // Evidence timestamps and versions can be independent of the log window.
  evidenceLogWindow?: FactTimeWindow;
  repairLogWindow?: FactTimeWindow;
  // A materialized repair batch exposes the exact evidence keys. Physical
  // evidence timestamps can differ from the parent log timestamp.
  evidenceLogBatch?: true;
  // GEO needs small, nullable evidence fields, not the complete proof documents
  // in each latest-version aggregate and join. No evidence-time filter is added.
  geoEvidence?: true;
  repairFields?: {
    name: string;
    column: 'after_value' | 'proof';
    key: string;
    type: 'String' | 'Bool' | 'UUID' | 'Time' | 'Raw' | 'Strings' | 'Has';
  }[];
};
export function factRelation(name: string, options: FactReadOptions = {}): string {
  if (warehouseV2Enabled()) {
    const timeFilter = options.immutableTimeWindow
      ? ` AND ${exactTimeFilter(options.immutableTimeWindow).replaceAll('_record_time', 'created_at')}`
      : '';
    if (name === 'liekan_log') {
      return `(SELECT id, website_id, import_id, created_at, path, method, status, bytes,
        ip_masked, ip_hash, user_agent, location, bot, vendor, bot_type, verification,
        source_id, event_digest, verification_version, ai_eligible, recognition_state,
        recognition_candidates, verification_observed_at, verification_reason
      FROM ${v2Tables.logs} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND _deleted=0${timeFilter})`;
    }
    if (name === 'liekan_crawler_evidence') {
      const geoCols = options.geoEvidence
        ? `,
        nullIf(request_host, '') AS _geo_host,
        nullIf(host_basis, '') AS _geo_basis,
        JSONExtract(coalesce(nullIf(JSONExtractRaw(evidence_json,'measurement'),''),'{}'),'samplingTimeBasis','Nullable(String)') AS _geo_sampling_time,
        JSONExtract(coalesce(nullIf(JSONExtractRaw(evidence_json,'measurement'),''),'{}'),'samplingBasis','Nullable(String)') AS _geo_sampling_basis,
        sampling_rate AS _geo_sampling_rate,
        JSONExtract(coalesce(identity_evidence,'{}'),'reason','Nullable(String)') AS _geo_reason,
        nullIf(content_type_state, '') AS _geo_mime_state,
        nullIf(content_type_value, '') AS _geo_mime`
        : '';
      return `(SELECT website_id, id AS log_id, classification_version, crawler_id, security_action,
        terminating_rule_id, matched_rule_ids, cache_status, duration_ms,
        JSONExtractRaw(evidence_json,'measurement') AS measurement,
        JSONExtractRaw(evidence_json,'edgeObservation') AS edge_observation,
        catalog_version, identity_evidence${geoCols}
      FROM ${v2Tables.logs} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND _deleted=0)`;
    }
    if (name === 'website_event') {
      return `(SELECT event_id, website_id, session_id, created_at, url_path, url_query,
        referrer_path, referrer_query, referrer_domain, page_title, event_type, event_name,
        visit_id, tag, fbclid, gclid, li_fat_id, msclkid, ttclid, twclid, utm_campaign,
        utm_content, utm_medium, utm_source, utm_term, hostname, cls, fcp, inp, lcp, ttfb
      FROM ${v2Tables.browserEvents} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND _deleted=0${timeFilter})`;
    }
    if (name === 'session') {
      return `(SELECT website_id, session_id, any(nullIf(browser,'')) AS browser, any(os) AS os,
        any(device) AS device, any(screen) AS screen, any(language) AS language,
        any(country) AS country, any(region) AS region, any(city) AS city,
        min(session_created_at) AS created_at, any(distinct_id) AS distinct_id
      FROM ${v2Tables.browserEvents} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND _deleted=0
      GROUP BY website_id, session_id)`;
    }
    if (name === 'liekan_event_quality') {
      return `(SELECT event_id, website_id, classification, collection_source AS source,
        quality_reasons AS reasons, rule_version, range_version, range_status,
        normalized_hostname AS hostname, received_at AS created_at, catalog_version, repair_scope_id
      FROM ${v2Tables.browserEvents} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND _deleted=0)`;
    }
    if (name === 'liekan_event_environment') {
      return `(SELECT event_id, website_id, identity_scope AS scope, identity_version,
        identity_available, nullIf(browser,'') AS browser, os, device, screen, language,
        origin_hostname, distinct_id, received_at AS created_at
      FROM ${v2Tables.browserEvents} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND _deleted=0)`;
    }
    if (name === 'liekan_event_observation') {
      return `(SELECT event_id, website_id, toInt32(epoch) AS epoch, obs_version AS version,
        created_at AS event_at, received_at, obs_features AS features
      FROM ${v2Tables.browserEvents} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND _deleted=0 AND has_observation)`;
    }
    if (name === 'event_data' || name === 'revenue') return v2EventDetailRelation(name);
    if (name === 'heatmap_event') {
      return `(SELECT * FROM ${v2Tables.heatmap} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64})`;
    }
    if (name === 'session_replay') {
      return `(SELECT * FROM ${v2Tables.sessionReplay} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64})`;
    }
    if (name === 'session_data') {
      return `(SELECT * FROM ${v2Tables.sessionData} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64})`;
    }
    if (name === 'session_link') {
      return `(SELECT * FROM ${v2Tables.sessionLink} WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64})`;
    }
  }
  if (
    options.logAttemptIdsParameter !== undefined &&
    (name !== 'liekan_log' ||
      !options.immutableTimeWindow?.hours ||
      !validParameterName(options.logAttemptIdsParameter))
  )
    throw new Error('Invalid warehouse log build attempts');
  if (options.orderedLogVersions && (name !== 'liekan_log' || !options.immutableTimeWindow))
    throw new Error('Invalid warehouse ordered log read');
  if (options.narrowLogWindow && (!options.orderedLogVersions || options.immutableTimeWindow.hours))
    throw new Error('Invalid warehouse narrow log window');
  if (options.activeLogRepair && name !== 'liekan_history_repair_result')
    throw new Error('Invalid warehouse active log repair read');
  if (options.evidenceLogBatch && name !== 'liekan_crawler_evidence')
    throw new Error('Invalid warehouse evidence batch read');
  for (const [window, family] of [
    [options.evidenceLogWindow, 'liekan_crawler_evidence'],
    [options.repairLogWindow, 'liekan_history_repair_result'],
  ] as const) {
    if (
      window &&
      (name !== family ||
        ![window.start, window.end, window.hours, window.excludedHours]
          .filter(Boolean)
          .every(validParameterName))
    )
      throw new Error('Invalid warehouse evidence log window');
  }
  if (options.sessionIdsParameter && !validParameterName(options.sessionIdsParameter))
    throw new Error('Invalid warehouse session parameter');
  if (options.recordKeysParameter && !validParameterName(options.recordKeysParameter))
    throw new Error('Invalid warehouse record-key parameter');
  if (
    options.immutableTimeWindow &&
    ((options.immutableTimeWindow.excludedHours && name !== 'liekan_log') ||
      !['website_event', 'liekan_log', 'liekan_event_quality', 'liekan_browser_risk'].includes(
        name,
      ) ||
      [
        options.immutableTimeWindow.start,
        options.immutableTimeWindow.end,
        ...(options.immutableTimeWindow.hours ? [options.immutableTimeWindow.hours] : []),
        ...(options.immutableTimeWindow.excludedHours
          ? [options.immutableTimeWindow.excludedHours]
          : []),
      ].some(p => !validParameterName(p)))
  )
    throw new Error('Invalid warehouse immutable-time filter');
  const table = factTable(name);
  const keys = recordKeyColumns(name);
  const expressions: Record<string, string> = {};
  const fields = options.repairFields ?? [];
  const names = new Set<string>();
  const types = {
    String: 'Nullable(String)',
    Bool: 'Nullable(Bool)',
    UUID: 'Nullable(String)',
    Time: 'Nullable(String)',
    Strings: 'Array(Nullable(String))',
  };
  const tuples = new Map<string, Map<string, string>>();
  for (const field of fields) {
    if (
      name !== 'liekan_history_repair_result' ||
      !/^_repair_[a-z0-9_]+$/.test(field.name) ||
      !/^[a-zA-Z][a-zA-Z0-9]*$/.test(field.key) ||
      !['after_value', 'proof'].includes(field.column) ||
      !['String', 'Bool', 'UUID', 'Time', 'Raw', 'Strings', 'Has'].includes(field.type) ||
      names.has(field.name)
    )
      throw new Error('Invalid warehouse repair field');
    names.add(field.name);
    const type = types[field.type as keyof typeof types];
    if (type) {
      const tuple = tuples.get(field.column) ?? new Map<string, string>();
      if (tuple.has(field.key) && tuple.get(field.key) !== type)
        throw new Error('Conflicting warehouse repair field type');
      tuple.set(field.key, type);
      tuples.set(field.column, tuple);
    }
  }
  for (const field of fields) {
    const json = `coalesce(${identifier(field.column)},'{}')`;
    const tuple = tuples.get(field.column);
    // Identical JSONExtract tuple expressions share one parse per source row in
    // the CH expression DAG. Separate extracts would repeatedly parse the full
    // proof document for every small field used by a wide report.
    const scalar = tuple
      ? `tupleElement(JSONExtract(${json},'Tuple(${[...tuple].map(([key, type]) => `${key} ${type}`).join(',')})'),${[...tuple.keys()].indexOf(field.key) + 1})`
      : '';
    const expression = {
      String: scalar,
      Bool: scalar,
      Strings: scalar,
      UUID: `toUUIDOrNull(${scalar})`,
      Time: `parseDateTime64BestEffortOrNull(${scalar},6,'UTC')`,
      Raw: `nullIf(JSONExtractRaw(${json},'${field.key}'),'null')`,
      Has: `JSONHas(${json},'${field.key}')`,
    }[field.type];
    expressions[field.name] = expression;
  }
  if (options.geoEvidence) {
    if (name !== 'liekan_crawler_evidence')
      throw new Error('Invalid warehouse GEO evidence projection');
    const measurement = `JSONExtract(coalesce(measurement,'{}'),'Tuple(host Nullable(String),hostBasis Nullable(String),samplingTimeBasis Nullable(String),samplingBasis Nullable(String),samplingRate Nullable(Float64))')`;
    const mime = `JSONExtract(coalesce(edge_observation,'{}'),'fields','EdgeResponseContentType','Tuple(state Nullable(String),value Nullable(String))')`;
    Object.assign(expressions, {
      _geo_host: `tupleElement(${measurement},1)`,
      _geo_basis: `tupleElement(${measurement},2)`,
      _geo_sampling_time: `tupleElement(${measurement},3)`,
      _geo_sampling_basis: `tupleElement(${measurement},4)`,
      _geo_sampling_rate: `tupleElement(${measurement},5)`,
      _geo_reason: "JSONExtract(coalesce(identity_evidence,'{}'),'reason','Nullable(String)')",
      _geo_mime_state: `tupleElement(${mime},1)`,
      _geo_mime: `tupleElement(${mime},2)`,
    });
  }
  const availableColumns = [
    ...table.columns.map(c => c.name),
    ...factMetadata.map(([key]) => key),
    ...Object.keys(expressions),
  ];
  if (options.columns?.some(column => !availableColumns.includes(column)))
    throw new Error('Invalid warehouse fact projection');
  const columns = options.columns
    ? [...new Set([...options.columns, '_deleted'])]
    : availableColumns;
  const values = columns.filter(column => !keys.includes(column));
  // Separate aggregate states let ClickHouse prune unused columns through the
  // report joins. A single argMax(tuple(all columns)) reads and holds every
  // payload even for count/date/path reports. The accepted candidate makes
  // (_record_key, _version, _ordinal) unique apart from byte-identical retries;
  // each column therefore selects the same row. A tuple preserves SQL NULL.
  const latest = (column: string) =>
    keys.includes(column)
      ? identifier(column)
      : options.columns
        ? `tupleElement(latest_values,${values.indexOf(column) + 1})`
        : `tupleElement(${identifier(`latest_${column}`)},1)`;
  const extras: string[] = [];
  const overrides: Record<string, string> = {};
  const counters =
    name === 'liekan_collection_diagnostic'
      ? ['written', 'with_uuid', 'duplicate']
      : name === 'liekan_geography_ingress'
        ? ['count']
        : [];
  for (const counter of counters) {
    extras.push(`sum(${identifier(counter)}) AS ${identifier(`total_${counter}`)}`);
    overrides[counter] = identifier(`total_${counter}`);
  }
  if (name === 'liekan_collection_diagnostic') {
    extras.push('min(first_at) AS diagnostic_first', 'max(last_at) AS diagnostic_last');
    overrides.first_at = 'diagnostic_first';
    overrides.last_at = 'diagnostic_last';
  }
  const first = (column: string) =>
    keys.includes(column) ? identifier(column) : `tupleElement(${identifier(`first_${column}`)},1)`;
  if (
    [
      'session',
      'session_data',
      'session_link',
      'liekan_session_source',
      'liekan_session_link_source',
    ].includes(name)
  ) {
    extras.push(
      ...values.map(
        column =>
          `argMin(tuple(${identifier(column)}),tuple(_version,_ordinal)) AS ${identifier(`first_${column}`)}`,
      ),
    );
  }
  if (name === 'session' || name === 'session_link') {
    for (const c of table.columns) overrides[c.name] = first(c.name);
  }
  if (name === 'session') {
    extras.push(
      "argMinIf(tuple(distinct_id),tuple(_version,_ordinal),coalesce(distinct_id,'')!='') AS first_identity",
      "countIf(coalesce(distinct_id,'')!='') AS identities",
    );
    overrides.distinct_id = `if(identities>0,tupleElement(first_identity,1),${first('distinct_id')})`;
  }
  if (name === 'session_data') {
    overrides.session_data_id = first('session_data_id');
    extras.push(
      'argMaxIf(tuple(created_at),tuple(_version,_ordinal),NOT _retain_created_at) AS explicit_created',
      'countIf(NOT _retain_created_at) AS explicit_creations',
    );
    overrides.created_at = `if(explicit_creations>0,tupleElement(explicit_created,1),${first('created_at')})`;
  }
  if (name === 'liekan_session_source') {
    for (const c of table.columns.filter(c => c.name !== 'updated_at'))
      overrides[c.name] = first(c.name);
  }
  if (name === 'liekan_session_link_source') {
    overrides.scope = first('scope');
    overrides.created_at = first('created_at');
  }
  const selected = columns
    .map(column => `${overrides[column] ?? latest(column)} AS ${identifier(column)}`)
    .join(', ');
  const narrowWindow = options.narrowLogWindow ? options.immutableTimeWindow : undefined;
  const evidenceWindow = options.evidenceLogWindow ?? options.repairLogWindow;
  const boundedFilter = [
    options.recordKeysParameter
      ? `AND _record_key IN {${options.recordKeysParameter}:Array(String)}`
      : '',
    options.sessionIdsParameter
      ? `AND _session_id IN {${options.sessionIdsParameter}:Array(UUID)}`
      : '',
    options.immutableTimeWindow ? `AND ${exactTimeFilter(options.immutableTimeWindow)}` : '',
    options.immutableTimeWindow?.hours
      ? `AND toDate32(_record_time) IN arrayMap(h -> toDate32(toDateTime(h,'UTC')),{${options.immutableTimeWindow.hours}:Array(UInt32)})
        AND toUnixTimestamp(toStartOfHour(_record_time)) IN {${options.immutableTimeWindow.hours}:Array(UInt32)}`
      : '',
    options.immutableTimeWindow?.excludedHours
      ? `AND toUnixTimestamp(toStartOfHour(_record_time)) NOT IN {${options.immutableTimeWindow.excludedHours}:Array(Int64)}`
      : '',
    narrowWindow ? `AND ${datePruning(narrowWindow)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const attemptPrefilter = options.logAttemptIdsParameter
    ? `AND attempt_id IN {${options.logAttemptIdsParameter}:Array(UUID)}`
    : boundedFilter && !narrowWindow
      ? `AND attempt_id IN (SELECT _attempt_id FROM ${identifier(`warehouse_${name}`)}
         WHERE _website_id={wh_site:UUID} AND _epoch={wh_epoch:UInt64} ${boundedFilter})`
      : '';
  return `(
    SELECT ${selected}
    FROM (
      SELECT ${keys.map(key => (options.orderedLogVersions ? `any(${identifier(key)}) AS ${identifier(key)}` : identifier(key))).join(', ')}, ${
        options.columns
          ? `argMax(tuple(${values.map(column => expressions[column] ?? identifier(column)).join(', ')}),tuple(_version,_ordinal)) AS latest_values`
          : values
              .map(
                column =>
                  `argMax(tuple(${expressions[column] ?? identifier(column)}),tuple(_version,_ordinal)) AS ${identifier(`latest_${column}`)}`,
              )
              .join(', ')
      }
        ${extras.length ? `, ${extras.join(', ')}` : ''}
      FROM ${counters.length ? `(SELECT DISTINCT * FROM ${identifier(`warehouse_${name}`)} WHERE _website_id={wh_site:UUID} AND _epoch={wh_epoch:UInt64})` : identifier(`warehouse_${name}`)} AS fact
      ${options.evidenceLogBatch ? 'PREWHERE _record_key IN (SELECT _record_key FROM repair_log_batch)' : ''}
      WHERE _website_id = {wh_site:UUID} AND _epoch = {wh_epoch:UInt64}
        ${options.activeLogRepair ? `AND "run_id"={wh_repair_run:UUID} AND "generation"={wh_repair_generation:UUID} AND "kind"='log'` : ''}
        ${boundedFilter}
        AND (_attempt_id, _candidate_id) IN (${acceptedCandidates(name, attemptPrefilter)})
        ${
          evidenceWindow
            ? `AND "${options.repairLogWindow ? 'record_id' : 'log_id'}" IN (
                SELECT id FROM warehouse_liekan_log
                PREWHERE _website_id={wh_site:UUID} AND _epoch={wh_epoch:UInt64} AND ${datePruning(evidenceWindow)}
                WHERE ${exactTimeFilter(evidenceWindow)} ${logHourFilter(evidenceWindow)}
                  AND (_attempt_id,_candidate_id) IN (${acceptedCandidates('liekan_log')})
              )`
            : ''
        }
        AND NOT arrayExists(d ->
          (isNull(tupleElement(d, 1)) OR tupleElement(d, 1) = _session_id)
          AND (_version < tupleElement(d, 2) OR
            (_topic_id = tupleElement(d, 3) AND arrayExists(
              p -> tupleElement(p, 1) = _partition AND _offset < tupleElement(p, 2),
              arrayZip(tupleElement(d, 4), tupleElement(d, 5))))),
          (SELECT groupArray(tuple(session_id, version, topic_id, partitions, offsets))
            FROM warehouse_deletion
            WHERE website_id = {wh_site:UUID} AND epoch = {wh_epoch:UInt64}
              AND revision <= {wh_deletion:UInt64}))
      GROUP BY ${options.orderedLogVersions ? 'toDate32(_record_time),_record_key' : keys.map(identifier).join(', ')}
    )
    WHERE NOT ${latest('_deleted')}
  )`;
}
