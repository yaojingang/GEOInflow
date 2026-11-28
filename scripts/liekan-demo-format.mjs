import { createHash, createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { v5 } from 'uuid';

export const DEMO_ID = 'b880cb21-e65a-4fdf-9c0e-3da5aed4e0fa';
const spec = (table, fields, refs = {}, dates = [], extra = {}) => ({
  table,
  fields: fields.split(' '),
  refs,
  dates,
  ...extra,
});
export const demoSpecs = {
  range: spec(
    'liekan_crawler_range_snapshot',
    'source_id version source_url parser_version names crawler_ids prefixes address_families published_at observed_at created_at',
    {},
    [],
    { global: true },
  ),
  source: spec(
    'liekan_log_source',
    'id website_id kind domain created_by owner_id state health created_at',
    { id: 'source' },
    ['created_at'],
  ),
  interval: spec(
    'liekan_log_interval',
    'id website_id source_id starts_at ends_at',
    { id: 'interval', source_id: 'source' },
    ['starts_at', 'ends_at'],
  ),
  coverage: spec(
    'liekan_crawler_quality',
    'website_id source_id starts_at ends_at state evidence recorded_at',
    { source_id: 'source' },
    ['starts_at', 'ends_at', 'recorded_at'],
  ),
  rule: spec(
    'liekan_crawler_rule_version',
    'website_id version matcher_version rules catalog_version crawler_configuration created_at',
    {},
    ['created_at'],
  ),
  import: spec(
    'liekan_import',
    'id website_id digest imported_at accepted rejected kind source_id inserted',
    { id: 'import', source_id: 'source' },
    ['imported_at'],
  ),
  session: spec(
    'session',
    'session_id website_id browser os device screen language country region city created_at',
    { session_id: 'session' },
    ['created_at'],
  ),
  'session-source': spec(
    'liekan_session_source',
    'website_id session_id source scope identity_version identity_available',
    { session_id: 'session' },
  ),
  event: spec(
    'website_event',
    'event_id website_id session_id visit_id created_at url_path page_title hostname referrer_domain referrer_path referrer_query event_type event_name utm_source utm_medium utm_campaign utm_term utm_content tag cls fcp inp lcp ttfb',
    { event_id: 'event', session_id: 'session', visit_id: 'visit' },
    ['created_at'],
  ),
  quality: spec(
    'liekan_event_quality',
    'event_id website_id classification source reasons rule_version range_status hostname catalog_version created_at',
    { event_id: 'event' },
    ['created_at'],
  ),
  environment: spec(
    'liekan_event_environment',
    'event_id website_id scope identity_version identity_available browser os device screen language origin_hostname created_at',
    { event_id: 'event' },
    ['created_at'],
  ),
  geography: spec(
    'liekan_event_geography',
    'event_id website_id country region city source trust ip_family precision reason rule_version data_version city_id country_basis processed_at',
    { event_id: 'event' },
    ['processed_at'],
  ),
  'session-data': spec(
    'session_data',
    'session_data_id website_id session_id data_key string_value number_value date_value data_type created_at',
    { session_data_id: 'session-data', session_id: 'session' },
    ['date_value', 'created_at'],
    { extras: ['proof'] },
  ),
  'event-data': spec(
    'event_data',
    'event_data_id website_id website_event_id data_key string_value number_value date_value data_type created_at',
    { event_data_id: 'event-data', website_event_id: 'event' },
    ['date_value', 'created_at'],
  ),
  revenue: spec(
    'revenue',
    'revenue_id website_id session_id event_id event_name currency revenue created_at',
    { revenue_id: 'revenue', session_id: 'session', event_id: 'event' },
    ['created_at'],
  ),
  heatmap: spec(
    'heatmap_event',
    'heatmap_event_id website_id session_id visit_id url_path event_type x y page_x page_y page_w viewport_w viewport_h page_h scroll_pct created_at',
    { heatmap_event_id: 'heatmap', session_id: 'session', visit_id: 'visit' },
    ['created_at'],
  ),
  replay: spec(
    'session_replay',
    'replay_id website_id session_id visit_id chunk_index events event_count started_at ended_at created_at',
    { replay_id: 'replay', session_id: 'session', visit_id: 'visit' },
    ['started_at', 'ended_at', 'created_at'],
  ),
  'saved-replay': spec(
    'session_replay_saved',
    'saved_replay_id website_id visit_id name created_at updated_at',
    { saved_replay_id: 'saved-replay', visit_id: 'visit' },
    ['created_at', 'updated_at'],
  ),
  log: spec(
    'liekan_log',
    'id website_id import_id created_at path method status bytes bot vendor bot_type verification source_id verification_version ai_eligible recognition_state verification_observed_at verification_reason ip_masked ip_hash user_agent location',
    { id: 'log', import_id: 'import', source_id: 'source' },
    ['created_at', 'verification_observed_at'],
  ),
  evidence: spec(
    'liekan_crawler_evidence',
    'website_id log_id classification_version crawler_id catalog_version cache_status duration_ms measurement identity_evidence edge_observation',
    { log_id: 'log' },
  ),
  catalog: spec(
    'liekan_catalog',
    'website_id path title content_type word_count published_at structured structure_score content_updated_at link_depth evidence_source',
    {},
    ['published_at', 'content_updated_at'],
  ),
  'catalog-snapshot': spec('liekan_crawler_catalog_snapshot', 'website_id snapshot_at paths', {}, [
    'snapshot_at',
  ]),
  report: spec(
    'report',
    'report_id user_id website_id type name description parameters created_at updated_at',
    { report_id: 'report' },
    ['created_at', 'updated_at'],
  ),
  annotation: spec(
    'annotation',
    'annotation_id website_id user_id date all_day note created_at updated_at',
    { annotation_id: 'annotation' },
    ['date', 'created_at', 'updated_at'],
  ),
};
export const demoKinds = Object.keys(demoSpecs);
const privateFields = new Set([
  'website_id',
  'user_id',
  'created_by',
  'owner_id',
  'digest',
  'ip_masked',
  'ip_hash',
  'user_agent',
  'location',
  'health',
]);
export const exportedFields = kind =>
  demoSpecs[kind].fields.filter(field => !privateFields.has(field));
export const demoUuid = (group, reference) => v5(`${group}:${reference}`, DEMO_ID);
const logId = reference =>
  createHash('sha256').update(`liekan-demo:log:${reference}`).digest('hex');

const privateKeys =
  /^(?:password|token|secret|distinct_id|ip|ip_hash|ip_masked|user_agent|user_id|owner_id|created_by|headers|authorization|cookie)$/i;
export function assertDemoPrivacy(kind, value, field = '') {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) throw new Error('Credential URL in official demo');
  }
  if (typeof value === 'string' && kind !== 'range') {
    if (/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(value) || /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(value))
      throw new Error('Private address in official demo');
    if (field !== 'catalog_version' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))
      throw new Error('Unmapped identity in official demo');
  }
  if (value && typeof value === 'object')
    for (const [key, nested] of Object.entries(value)) {
      if (privateKeys.test(key)) throw new Error('Private field in official demo');
      assertDemoPrivacy(kind, nested, key);
    }
}

export function validateDemoRow(kind, row, manifest) {
  assertDemoPrivacy(kind, row);
  const entry = demoSpecs[kind];
  if (!entry || !row || Array.isArray(row) || typeof row !== 'object')
    throw new Error('Invalid demo record');
  const allowed = new Set([...exportedFields(kind), ...(entry.extras || [])]);
  if (Object.keys(row).some(field => !allowed.has(field)))
    throw new Error(`Unexpected demo field: ${kind}`);
  for (const [field, group] of Object.entries(entry.refs)) {
    const value = row[field];
    if (value == null) continue;
    const size = group === 'visit' ? manifest.visits : manifest.counts[group];
    if (!Number.isSafeInteger(value) || value < 0 || value >= size)
      throw new Error(`Invalid demo reference: ${kind}.${field}`);
  }
  for (const field of entry.dates)
    if (row[field] != null && (!Number.isSafeInteger(row[field]) || row[field] > 0))
      throw new Error(`Invalid demo date: ${kind}.${field}`);
  if (row.catalog_version != null && row.catalog_version !== manifest.catalog.version)
    throw new Error('Unbundled demo catalog');
  if (kind === 'coverage' && !['partial', 'unknown'].includes(row.state))
    throw new Error('Demo file coverage cannot claim live observation');
  if (
    kind === 'replay' &&
    (!Array.isArray(row.events) ||
      row.events.some(e => !Number.isSafeInteger(e.timestamp) || e.timestamp > 0))
  )
    throw new Error('Invalid demo replay timeline');
}

export function materializeDemoRow(kind, row, index, anchor, secret, owner) {
  const entry = demoSpecs[kind],
    result = { ...row };
  if (!entry.global) result.website_id = DEMO_ID;
  for (const field of ['user_id', 'created_by', 'owner_id'])
    if (entry.fields.includes(field)) result[field] = owner;
  for (const [field, group] of Object.entries(entry.refs))
    if (result[field] != null)
      result[field] = group === 'log' ? logId(result[field]) : demoUuid(group, result[field]);
  for (const field of entry.dates)
    if (result[field] != null) result[field] = new Date(anchor + result[field]).toISOString();
  if (kind === 'source')
    Object.assign(result, {
      kind: 'server',
      state: 'paused',
      domain: 'www.liekan.com',
      health: { synthetic: true, description: '随系统分发的示例历史，无采集连接凭据' },
    });
  if (kind === 'import')
    result.digest = createHmac('sha256', secret).update(`demo-import:${index}`).digest('hex');
  if (kind === 'log')
    Object.assign(result, {
      ip_masked: '示例 IP 已遮蔽',
      ip_hash: createHmac('sha256', secret)
        .update(`demo-ip:${index % 200}`)
        .digest('hex'),
      user_agent: `Synthetic-Liekan-Demo/${result.bot || 'unknown'}`,
      location: '合成示例位置',
    });
  if (kind === 'replay')
    result.events =
      '\\x' +
      gzipSync(
        Buffer.from(
          JSON.stringify(
            result.events.map(event => ({ ...event, timestamp: anchor + event.timestamp })),
          ),
        ),
      ).toString('hex');
  return result;
}

export async function insertDemoBatch(client, kind, rows, { resume = false } = {}) {
  const { table, fields, global } = demoSpecs[kind];
  const sql = `INSERT INTO ${table}(${fields.join(',')}) SELECT ${fields.map(field => `r.${field}`).join(',')} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb) r${resume ? ' WHERE true ON CONFLICT DO NOTHING' : ''}`;
  if (global) {
    for (const row of rows) {
      const old = (
        await client.query(
          'SELECT source_url,parser_version,names,crawler_ids,prefixes,address_families FROM liekan_crawler_range_snapshot WHERE source_id=$1 AND version=$2',
          [row.source_id, row.version],
        )
      ).rows[0];
      if (old) {
        if (Object.keys(old).some(key => JSON.stringify(old[key]) !== JSON.stringify(row[key])))
          throw new Error('Conflicting archived crawler range');
      } else await client.query(sql, [JSON.stringify([row])]);
    }
    return;
  }
  await client.query(sql, [JSON.stringify(rows)]);
  if (kind === 'session-data' && rows.some(row => row.proof))
    await client.query(
      `INSERT INTO liekan_session_data_source(website_id,session_id,data_key,scope,hostname,classification,row_digest)
      SELECT d.website_id,d.session_id,d.data_key,'browser','www.liekan.com','browser',liekan_session_data_digest(d)
      FROM session_data d JOIN jsonb_to_recordset($1::jsonb) r(session_data_id uuid,proof boolean) ON r.session_data_id=d.session_data_id WHERE r.proof`,
      [JSON.stringify(rows)],
    );
}
