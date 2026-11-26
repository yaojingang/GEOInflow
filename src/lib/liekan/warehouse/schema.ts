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

export const analysisVisitEntryFields = [
  'referrer_domain',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'referrer_path',
  'referrer_query',
  'utm_term',
] as const;

export const analysisBrowserFields: ReadonlyArray<readonly [string, string]> = [
  ...[
    'country',
    'region',
    'city',
    'browser',
    'os',
    'device',
    'screen',
    'language',
    'distinct_id',
  ].map(c => [`liekan_${c}`, 'Nullable(String)'] as const),
  ['liekan_identity_available', 'Nullable(Bool)'],
  ['liekan_session_created_at', "Nullable(DateTime64(6,'UTC'))"],
  ...analysisVisitEntryFields.map(c => [`_entry_${c}`, 'Nullable(String)'] as const),
  ['_qualified', 'Bool'],
  ['_qualified_event', 'Bool'],
  ['_identity_version', 'Nullable(String)'],
  ['_rule_version', 'Nullable(String)'],
  ['_catalog_version', 'Nullable(String)'],
] as const;

export const analysisLogFields: ReadonlyArray<readonly [string, string]> = [
  ['reporting_crawler_id', 'Nullable(String)'],
  ['reporting_catalog_version', 'Nullable(UUID)'],
  ['reporting_classification_version', 'Nullable(String)'],
  ['reporting_identity_evidence', 'Nullable(String)'],
  ['reporting_generation', 'Nullable(UUID)'],
] as const;
