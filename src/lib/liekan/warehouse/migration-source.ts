import { createHash } from 'node:crypto';
import pg from 'pg';
import { normalizeCollectionHostname } from '../traffic-quality/hostname';
import { canonicalWireRow } from './candidate';
import {
  type ActualTable,
  factTable,
  identifier,
  schemaDifferences,
  sourceCatalogSQL,
} from './catalog';
import { exportColumns, recordKey, rowDigest, type WireRow } from './codec';
import { snapshotDigest, type SnapshotDescriptor } from './migration-snapshot';

export type MigrationRow = {
  row: WireRow;
  key: string;
  hash: string;
  websiteId: string;
  sessionId: string | null;
  visitId: string | null;
  recordTime: string;
  receipt?: { source: string | null; scope: string | null };
  propertyProof?: { sourceHash: string; dataHash: string };
  hostnameProof?: { sourceHash: string; normalized: string | null };
  riskProof?: { epoch: string; ruleVersion: string; coverage: string; computedAt: string };
  logScopeProof?: { present: boolean; repairScopeId: string | null };
};
export type MigrationPage = {
  family: string;
  before: string[] | null;
  after: string[];
  rows: MigrationRow[];
  digest: string;
};

function metadataSource(name: string) {
  const table = factTable(name);
  const columns = new Set(table.columns.map(c => c.name));
  let joins = '';
  let event: string | undefined;
  if (columns.has('event_id') && name !== 'website_event') event = 'event_id';
  if (columns.has('website_event_id')) event = 'website_event_id';
  if (event)
    joins += ` LEFT JOIN website_event e ON e.website_id=src.website_id AND e.event_id=src.${identifier(event)}`;
  if (name === 'liekan_log')
    joins += ' LEFT JOIN liekan_import i ON i.website_id=src.website_id AND i.id=src.import_id';
  const risk = name === 'liekan_browser_risk';
  if (risk)
    joins +=
      ' LEFT JOIN liekan_browser_risk_window risk_window ON risk_window.website_id=src.website_id AND risk_window.window_end=src.window_end';
  const receipt = name === 'liekan_collection_receipt';
  const property = name === 'liekan_session_data_source';
  if (property)
    joins += ` LEFT JOIN session_data d ON d.website_id=src.website_id AND d.session_id=src.session_id AND d.data_key=src.data_key`;
  if (receipt)
    joins += ` LEFT JOIN liekan_event_quality q ON q.website_id=src.website_id AND q.event_id=src.event_id
      LEFT JOIN liekan_event_environment env ON env.website_id=src.website_id AND env.event_id=src.event_id`;
  const log = ['liekan_crawler_evidence', 'liekan_log_geography'].includes(name);
  if (log) joins += ' LEFT JOIN liekan_log l ON l.website_id=src.website_id AND l.id=src.log_id';
  const session = columns.has('session_id')
    ? 'src.session_id'
    : event
      ? 'e.session_id'
      : 'NULL::uuid';
  const visit = columns.has('visit_id') ? 'src.visit_id' : event ? 'e.visit_id' : 'NULL::uuid';
  const ownTime =
    name === 'liekan_browser_risk'
      ? 'window_end'
      : columns.has('bucket')
        ? 'bucket'
        : name === 'liekan_event_observation'
          ? 'event_at'
          : columns.has('created_at')
            ? 'created_at'
            : columns.has('updated_at')
              ? 'updated_at'
              : columns.has('processed_at')
                ? 'processed_at'
                : null;
  const times = [
    name === 'liekan_event_quality' ? 'src.created_at' : null,
    log ? 'l.created_at' : null,
    event ? 'e.created_at' : null,
    ownTime ? `src.${identifier(ownTime)}` : null,
  ].filter(Boolean);
  // A missing parent must not silently drop historical evidence. This fallback is
  // only its physical partition timestamp; every original timestamp stays intact.
  times.push("'1970-01-01 00:00:00+00'::timestamptz");
  return {
    joins,
    columns: `src.website_id::text AS "__website", ${session}::text AS "__session", ${visit}::text AS "__visit",
      to_char(coalesce(${times.join(',')}) AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS "__time",
      ${receipt ? 'coalesce(src.collection_source,q.source)' : 'NULL::text'} AS "__receipt_source",
      ${receipt ? 'coalesce(src.collection_scope,env.scope,q.source)' : 'NULL::text'} AS "__receipt_scope",
      ${property ? `CASE WHEN src.row_digest=liekan_session_data_digest(d) THEN (SELECT row_to_json(property_wire) FROM (SELECT ${exportColumns('session_data', 'd')}) property_wire) ELSE NULL END` : 'NULL::json'} AS "__property",
      ${risk ? `json_build_object('epoch',risk_window.epoch::text,'ruleVersion',risk_window.rule_version,'coverage',risk_window.coverage,'computedAt',to_char(risk_window.computed_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US'))` : 'NULL::json'} AS "__risk",
      ${name === 'liekan_log' ? "json_build_object('present',i.id IS NOT NULL,'repairScopeId',i.repair_scope_id)" : 'NULL::json'} AS "__log_scope"`,
  };
}

export function pageSQL(name: string, cursor: string[] | null, limit: number) {
  const table = factTable(name);
  if (!Number.isInteger(limit) || limit < 1 || limit > 15000)
    throw new Error('Invalid migration page size');
  if (
    cursor &&
    (cursor.length !== table.primaryKey.length || cursor.some(v => typeof v !== 'string'))
  )
    throw new Error('Invalid migration cursor');
  const keys = table.primaryKey.map(k => `src.${identifier(k)}`);
  const casts = table.primaryKey.map((key, i) => {
    const column = table.columns.find(c => c.name === key);
    if (!column) throw new Error('Invalid migration primary key');
    return `$${i + 1}::${column.type}`;
  });
  const metadata = metadataSource(name);
  return {
    // Bound the primary-key page before metadata joins. A server cursor otherwise
    // may choose an all-source merge plan and spend minutes on a single FETCH.
    query: `WITH source_page AS MATERIALIZED (
      SELECT src.* FROM ${identifier(name)} AS src
      ${cursor ? `WHERE (${keys.join(',')}) > (${casts.join(',')})` : ''}
      ORDER BY ${keys.join(',')} LIMIT $${cursor ? cursor.length + 1 : 1})
      SELECT ${exportColumns(name)}, ${metadata.columns}
      FROM source_page AS src ${metadata.joins} ORDER BY ${keys.join(',')}`,
    values: [...(cursor ?? []), limit],
  };
}

export class MigrationSource {
  private readonly client: pg.Client;

  constructor(url: string) {
    this.client = new pg.Client({
      connectionString: url,
      application_name: 'liekan-warehouse-source-readonly',
      options:
        '-c default_transaction_read_only=on -c timezone=UTC -c statement_timeout=60000 -c lock_timeout=1000',
    });
    this.client.on('error', () => {});
  }

  async connect() {
    await this.client.connect();
    const result = await this.client.query('SHOW transaction_read_only');
    if (result.rows[0].transaction_read_only !== 'on') throw new Error('Source is not read-only');
  }

  async inspect() {
    const tables = (await this.client.query(sourceCatalogSQL)).rows as ActualTable[];
    const errors = schemaDifferences(tables);
    return { tables: tables.length, errors, compatible: errors.length === 0 };
  }

  async sealedSnapshot() {
    const rows = (
      await this.client.query<{ descriptor: SnapshotDescriptor; digest: string }>(
        'SELECT descriptor,digest FROM liekan_snapshot.manifest WHERE id=1',
      )
    ).rows;
    const [{ database }] = (
      await this.client.query<{ database: string }>('SELECT current_database() AS database')
    ).rows;
    if (
      rows.length !== 1 ||
      rows[0].descriptor.database !== database ||
      snapshotDigest(rows[0].descriptor) !== rows[0].digest
    )
      throw new Error('warehouse-source-snapshot-invalid');
    const missing = (
      await this.client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN('r','p') AND NOT EXISTS(
        SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='liekan_snapshot_write_fence' AND t.tgenabled='O') LIMIT 1`)
    ).rowCount;
    if (missing) throw new Error('warehouse-source-snapshot-write-fence-missing');
    return rows[0];
  }

  async resources(after: string | null = null) {
    const hasControl = (
      await this.client.query("SELECT to_regclass('public.liekan_warehouse_site') AS table")
    ).rows[0].table;
    return (
      await this.client.query<{
        website_id: string;
        resource_type: 'website' | 'link' | 'pixel';
        epoch: string;
      }>(
        `
      WITH resources AS (
        SELECT website_id,'website' AS resource_type FROM website
        UNION ALL SELECT link_id,'link' FROM link
        UNION ALL SELECT pixel_id,'pixel' FROM pixel
      ) SELECT r.website_id::text,r.resource_type,${hasControl ? 'coalesce(w.epoch,0)::text' : "'0'::text"} AS epoch
      FROM resources r ${hasControl ? 'LEFT JOIN liekan_warehouse_site w USING(website_id)' : ''}
      WHERE ($1::uuid IS NULL OR r.website_id>$1::uuid) ORDER BY r.website_id LIMIT 1000`,
        [after],
      )
    ).rows;
  }

  async page(
    name: string,
    cursor: string[] | null = null,
    limit = 5000,
  ): Promise<MigrationPage | null> {
    const table = factTable(name);
    const sql = pageSQL(name, cursor, limit);
    const rows: MigrationRow[] = [];
    let bytes = 0;
    await this.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await this.client.query(
        `DECLARE migration_page NO SCROLL CURSOR FOR ${sql.query}`,
        sql.values,
      );
      let done = false;
      while (!done) {
        const batch = await this.client.query('FETCH FORWARD 32 FROM migration_page');
        if (!batch.rows.length) break;
        for (const input of batch.rows) {
          const {
            __website,
            __session,
            __visit,
            __time,
            __receipt_source,
            __receipt_scope,
            __property,
            __risk,
            __log_scope,
            ...raw
          } = input;
          const row = canonicalWireRow(name, raw);
          const size = Buffer.byteLength(JSON.stringify(row));
          if (rows.length && bytes + size > 8 * 1024 * 1024) {
            done = true;
            break;
          }
          rows.push({
            row,
            key: recordKey(name, row),
            hash: rowDigest(name, row),
            websiteId: __website,
            sessionId: __session,
            visitId: __visit,
            recordTime: __time,
            ...(__risk ? { riskProof: __risk } : {}),
            ...(__log_scope ? { logScopeProof: __log_scope } : {}),
            ...(name === 'website_event' && typeof row.hostname === 'string'
              ? {
                  hostnameProof: {
                    sourceHash: createHash('sha256').update(row.hostname).digest('hex'),
                    normalized: normalizeCollectionHostname(row.hostname),
                  },
                }
              : {}),
            ...(name === 'liekan_collection_receipt'
              ? { receipt: { source: __receipt_source, scope: __receipt_scope } }
              : {}),
            ...(__property
              ? {
                  propertyProof: {
                    sourceHash: rowDigest(name, row),
                    dataHash: rowDigest(
                      'session_data',
                      canonicalWireRow('session_data', __property),
                    ),
                  },
                }
              : {}),
          });
          bytes += size;
        }
      }
      await this.client.query('CLOSE migration_page');
      await this.client.query('COMMIT');
    } catch (error) {
      try {
        await this.client.query('ROLLBACK');
      } catch {
        /* The readonly cursor has no committed effects. */
      }
      throw error;
    }
    if (!rows.length) return null;
    const last = rows.at(-1).row;
    const after = table.primaryKey.map(k => String(last[k]));
    const digest = createHash('sha256');
    for (const row of rows)
      digest
        .update(
          JSON.stringify([
            row.key,
            row.hash,
            row.websiteId,
            row.sessionId,
            row.visitId,
            row.recordTime,
            row.receipt ?? null,
            row.propertyProof ?? null,
            row.hostnameProof ?? null,
            row.riskProof ?? null,
            row.logScopeProof ?? null,
          ]),
        )
        .update('\n');
    return { family: name, before: cursor, after, rows, digest: digest.digest('hex') };
  }

  async close() {
    await this.client.end();
  }
}
