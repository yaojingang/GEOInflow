import { factTable, factTables, identifier, type SourceColumn } from './catalog';

export const WAREHOUSE_SCHEMA_VERSION = 2;

export function clickhouseType(column: SourceColumn): string {
  let type: string;
  const decimal = /^numeric\((\d+),(\d+)\)$/.exec(column.type);
  if (decimal) {
    const precision = Number(decimal[1]);
    const scale = Number(decimal[2]);
    if (precision < 1 || precision > 76 || scale > precision) {
      throw new Error(`Unsupported decimal type: ${column.type}`);
    }
    type = `Decimal(${precision}, ${scale})`;
  } else if (/^timestamp(?:\(6\))? with time zone$/.test(column.type)) {
    type = "DateTime64(6, 'UTC')";
  } else if (/^character(?: varying)?\(\d+\)$/.test(column.type)) {
    type = 'String';
  } else {
    const types: Record<string, string> = {
      uuid: 'UUID',
      bigint: 'Int64',
      integer: 'Int32',
      smallint: 'Int16',
      boolean: 'Bool',
      'double precision': 'Float64',
      text: 'String',
      jsonb: 'String',
      bytea: 'String',
      'text[]': 'Array(Nullable(String))',
    };
    type = types[column.type];
    if (!type) throw new Error(`Unsupported source type: ${column.type}`);
  }
  if (column.nullable && type.startsWith('Array(')) {
    throw new Error('Nullable arrays require an explicit null-presence mapping');
  }
  return column.nullable ? `Nullable(${type})` : type;
}

export const factMetadata = [
  ['_website_id', 'UUID'],
  ['_record_key', 'String'],
  ['_record_time', "DateTime64(6, 'UTC')"],
  ['_session_id', 'Nullable(UUID)'],
  ['_epoch', 'UInt64'],
  ['_version', 'UInt64'],
  ['_ordinal', 'UInt32'],
  ['_attempt_id', 'UUID'],
  ['_candidate_id', 'UUID'],
  ['_topic_id', 'String'],
  ['_partition', 'UInt32'],
  ['_offset', 'UInt64'],
  ['_deleted', 'Bool'],
  ['_retain_created_at', 'Bool'],
  ['_row_hash', 'FixedString(64)'],
] as const;

export function factDDL(name: string): string {
  const table = factTable(name);
  const columns = table.columns.map(c => `${identifier(c.name)} ${clickhouseType(c)}`);
  columns.push(...factMetadata.map(([key, type]) => `${identifier(key)} ${type}`));
  return `CREATE TABLE IF NOT EXISTS ${identifier(`warehouse_${name}`)} (
  ${columns.join(',\n  ')}
) ENGINE = MergeTree
PARTITION BY toYYYYMM(_record_time)
ORDER BY (_website_id, _epoch, toDate32(_record_time), _record_key, _version, _ordinal, _candidate_id)
SETTINGS index_granularity = 8192, fsync_after_insert = 1, fsync_part_directory = 1`;
}

// These are immutable journals. Visibility always uses the PG publication pointer.
// In particular, background merges must never replace an accepted older candidate.
export const journalDDL = [
  `CREATE TABLE IF NOT EXISTS warehouse_landing (
    website_id UUID, epoch UInt64, attempt_id UUID, input_id UUID,
    topic_id String, partition UInt32, offset UInt64,
    identity_key String, payload_hash FixedString(64),
    decision LowCardinality(String), original_session Nullable(UUID),
    original_visit Nullable(UUID), envelope String,
    received_at DateTime64(6, 'UTC')
  ) ENGINE = MergeTree PARTITION BY toYYYYMM(received_at)
  ORDER BY (website_id, epoch, identity_key, attempt_id, input_id)
  SETTINGS fsync_after_insert = 1, fsync_part_directory = 1`,
  `CREATE TABLE IF NOT EXISTS warehouse_decision (
    website_id UUID, epoch UInt64, attempt_id UUID, version UInt64,
    input_count UInt32, digest FixedString(64), confirmed_at DateTime64(6, 'UTC')
  ) ENGINE = MergeTree PARTITION BY toYYYYMM(confirmed_at)
  ORDER BY (website_id, epoch, attempt_id, version)
  SETTINGS fsync_after_insert = 1, fsync_part_directory = 1`,
  `CREATE TABLE IF NOT EXISTS warehouse_publication (
    website_id UUID, epoch UInt64, publication UInt64,
    attempt_id UUID, family LowCardinality(String), candidate_id UUID,
    row_count UInt64, digest FixedString(64), published_at DateTime64(6, 'UTC')
  ) ENGINE = MergeTree PARTITION BY toYYYYMM(published_at)
  ORDER BY (website_id, epoch, family, attempt_id, publication)
  SETTINGS fsync_after_insert = 1, fsync_part_directory = 1`,
  `CREATE TABLE IF NOT EXISTS warehouse_deletion (
    website_id UUID, epoch UInt64, revision UInt64, operation_id UUID,
    session_id Nullable(UUID), version UInt64, topic_id String,
    partitions Array(UInt32), offsets Array(UInt64), created_at DateTime64(6, 'UTC')
  ) ENGINE = MergeTree ORDER BY (website_id, epoch, revision, operation_id)
  SETTINGS fsync_after_insert = 1, fsync_part_directory = 1`,
  `CREATE TABLE IF NOT EXISTS warehouse_control_projection (
    website_id UUID, epoch UInt64, kind LowCardinality(String),
    revision UInt64, key String, value String, created_at DateTime64(6, 'UTC')
  ) ENGINE = MergeTree ORDER BY (website_id, epoch, kind, key, revision)
  SETTINGS fsync_after_insert = 1, fsync_part_directory = 1`,
];

// Destructive retention is opt-in and requires separate validation of proof/lease references.
// A fresh installation and a historical import never add an implicit 90-day TTL.
export const warehouseDDL = () => [...journalDDL, ...factTables.map(t => factDDL(t.name))];
