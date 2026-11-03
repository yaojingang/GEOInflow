import { factTable, identifier } from './catalog';
import { recordKeyColumns } from './codec';
import { factMetadata } from './schema';

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

// Callers apply business filters OUTSIDE this relation. Filtering a mutable field
// before selecting its latest accepted version could resurrect an older value.
// Explicit manifest selection also makes retry remnants invisible before any merge.
export type FactReadOptions = {
  // A report with a known projection can keep one compact aggregate state per
  // record. Without a projection, separate states allow CH to prune columns.
  columns?: readonly string[];
  recordKeysParameter?: string;
  sessionIdsParameter?: string;
  immutableTimeWindow?: { start: string; end: string; endExclusive?: boolean };
  repairFields?: {
    name: string;
    column: 'after_value' | 'proof';
    key: string;
    type: 'String' | 'Bool' | 'UUID' | 'Time' | 'Raw' | 'Strings' | 'Has';
  }[];
};
export function factRelation(name: string, options: FactReadOptions = {}): string {
  if (options.sessionIdsParameter && !/^[a-z][a-zA-Z0-9_]*$/.test(options.sessionIdsParameter))
    throw new Error('Invalid warehouse session parameter');
  if (options.recordKeysParameter && !/^[a-z][a-zA-Z0-9_]*$/.test(options.recordKeysParameter))
    throw new Error('Invalid warehouse record-key parameter');
  if (
    options.immutableTimeWindow &&
    (!['website_event', 'liekan_log', 'liekan_event_quality', 'liekan_browser_risk'].includes(
      name,
    ) ||
      [options.immutableTimeWindow.start, options.immutableTimeWindow.end].some(
        p => !/^[a-z][a-zA-Z0-9_]*$/.test(p),
      ))
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
  const boundedFilter = [
    options.recordKeysParameter
      ? `AND _record_key IN {${options.recordKeysParameter}:Array(String)}`
      : '',
    options.sessionIdsParameter
      ? `AND _session_id IN {${options.sessionIdsParameter}:Array(UUID)}`
      : '',
    options.immutableTimeWindow
      ? `AND _record_time >= {${options.immutableTimeWindow.start}:DateTime64(6,'UTC')} AND _record_time ${options.immutableTimeWindow.endExclusive ? '<' : '<='} {${options.immutableTimeWindow.end}:DateTime64(6,'UTC')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  return `(
    SELECT ${selected}
    FROM (
      SELECT ${keys.map(identifier).join(', ')}, ${
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
      WHERE _website_id = {wh_site:UUID} AND _epoch = {wh_epoch:UInt64}
        ${boundedFilter}
        AND (_attempt_id, _candidate_id) IN (
          SELECT attempt_id, argMax(candidate_id, publication)
          FROM warehouse_publication
          WHERE website_id = {wh_site:UUID} AND epoch = {wh_epoch:UInt64}
            AND family = '${name}' AND publication <= {wh_publication:UInt64}
            ${
              boundedFilter
                ? `AND attempt_id IN (SELECT _attempt_id FROM ${identifier(`warehouse_${name}`)}
              WHERE _website_id={wh_site:UUID} AND _epoch={wh_epoch:UInt64} ${boundedFilter})`
                : ''
            }
          GROUP BY attempt_id
        )
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
      GROUP BY ${keys.map(identifier).join(', ')}
    )
    WHERE NOT ${latest('_deleted')}
  )`;
}
