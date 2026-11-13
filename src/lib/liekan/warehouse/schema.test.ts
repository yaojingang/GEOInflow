import { describe, expect, it } from 'vitest';
import {
  factTable,
  factTables,
  identifier,
  previousSourceFingerprint,
  previousSourceTables,
  schemaDifferences,
  schemaFingerprint,
  sourceFingerprint,
  sourceTables,
  supportedSourceFingerprint,
} from './catalog';
import { exportColumns, recordKey, rowDigest, validateWireRow } from './codec';
import { clickhouseType, warehouseDDL } from './schema';

const receipt = {
  website_id: '00000000-0000-0000-0000-000000000001',
  client_event_id: '00000000-0000-0000-0000-000000000002',
  payload_hash: 'a'.repeat(64),
  event_id: null,
  created_at: '2026-10-26 14:40:14.123456',
  collection_source: null,
  collection_scope: null,
};

describe('complete historical source contract', () => {
  it('accounts for every table and rejects schema drift without exposing row values', () => {
    expect(sourceTables).toHaveLength(156);
    expect(factTables).toHaveLength(26);
    expect(schemaDifferences(sourceTables)).toEqual([]);
    const changed = structuredClone(sourceTables);
    const events = changed.find(t => t.name === 'website_event');
    if (!events) throw new Error('Missing test source schema');
    events.columns.push({ name: 'extra', type: 'text', nullable: true });
    changed.push({ name: 'unmapped', ownership: 'postgres', primaryKey: [], columns: [] });
    expect(schemaDifferences(changed)).toEqual([
      'Unmapped column: website_event.extra',
      'Unmapped table: unmapped',
    ]);
    expect(schemaDifferences(sourceTables.filter(t => t.name !== 'revenue'))).toContain(
      'Missing table: revenue',
    );
    expect(() => factTable('user')).toThrow('Unregistered fact family');
    expect(() => identifier('x;DROP TABLE x')).toThrow('Invalid warehouse identifier');
  });

  it('accepts complete source generations and preserves sealed 056 migration identity', () => {
    expect(previousSourceTables).toHaveLength(138);
    expect(previousSourceFingerprint).toBe(
      '02c662582ce25d5e208476327961fdf4920ff76e9819aea8f55c0f3ed22c9458',
    );
    expect(schemaFingerprint(previousSourceTables)).toBe(previousSourceFingerprint);
    expect(schemaFingerprint(sourceTables)).toBe(sourceFingerprint);
    expect(supportedSourceFingerprint(previousSourceFingerprint)).toBe(true);
    expect(supportedSourceFingerprint('0'.repeat(64))).toBe(false);
    expect(previousSourceTables.filter(t => t.ownership === 'clickhouse')).toEqual(factTables);
    const partial = sourceTables.filter(t => t.name !== 'liekan_robots_deployment');
    expect(schemaDifferences(partial)).toContain('Missing table: liekan_robots_deployment');
    const oldWithNewColumn = structuredClone(previousSourceTables);
    oldWithNewColumn
      .find(t => t.name === 'liekan_analysis_generation')
      .columns.push({
        name: 'gc_started_at',
        type: 'timestamp with time zone',
        nullable: true,
      });
    expect(schemaFingerprint(oldWithNewColumn)).toBeNull();
    const changed = structuredClone(sourceTables);
    changed.find(t => t.name === 'liekan_storage_candidate').primaryKey = [
      'run_id',
      'kind',
      'record_id',
    ];
    expect(schemaDifferences(changed)).toContain('Primary key changed: liekan_storage_candidate');
    for (const name of [
      'liekan_robots_state',
      'liekan_robots_deployment',
      'liekan_analytics_engine_site',
      'liekan_storage_cleanup',
    ])
      expect(sourceTables.find(t => t.name === name).ownership).toBe('postgres');
    expect(sourceTables.find(t => t.name === 'liekan_report_fragment').ownership).toBe('retire');
  });

  it('preserves nullable evidence, microseconds and column order in checksums', () => {
    const row = validateWireRow('liekan_collection_receipt', receipt);
    expect(row.created_at).toBe('2026-10-26 14:40:14.123456');
    expect(row.event_id).toBeNull();
    const reversed = Object.fromEntries(Object.entries(row).reverse());
    expect(rowDigest('liekan_collection_receipt', row)).toBe(
      rowDigest('liekan_collection_receipt', reversed),
    );
    expect(recordKey('liekan_collection_receipt', row)).toBe(
      JSON.stringify([row.website_id, row.client_event_id]),
    );
    for (const date of [
      '2026-02-30 12:00:00.000000',
      'infinity',
      '1800-01-01 00:00:00.000000',
      new Date(),
    ]) {
      expect(() =>
        validateWireRow('liekan_collection_receipt', { ...receipt, created_at: date }),
      ).toThrow('Unrepresentable source value');
    }
    expect(() =>
      validateWireRow('liekan_collection_receipt', { ...receipt, payload_hash: undefined }),
    ).toThrow();
    expect(() =>
      validateWireRow('liekan_collection_receipt', { ...receipt, extra: 'secret' }),
    ).toThrow('Unexpected field set');
  });

  it('never converts financial values or large integers through JS Number', () => {
    const query = exportColumns('event_data');
    expect(query).toContain('"number_value"::text');
    expect(query).toContain('HH24:MI:SS.US');
    expect(exportColumns('liekan_log')).toContain('"bytes"::text');
    expect(exportColumns('session_replay')).toContain('encode("src"."events", \'hex\')');
    expect(exportColumns('liekan_event_observation')).toContain('"features"::text');
    expect(clickhouseType({ name: 'n', type: 'numeric(19,4)', nullable: true })).toBe(
      'Nullable(Decimal(19, 4))',
    );
    expect(clickhouseType({ name: 'n', type: 'text[]', nullable: false })).toBe(
      'Array(Nullable(String))',
    );
    expect(() => clickhouseType({ name: 'n', type: 'text[]', nullable: true })).toThrow();
    expect(() => clickhouseType({ name: 'n', type: 'numeric', nullable: false })).toThrow();
  });

  it('builds all immutable families without implicit destructive retention', () => {
    const ddls = warehouseDDL();
    expect(ddls).toHaveLength(31);
    for (const ddl of ddls) {
      expect(ddl).toContain('ENGINE = MergeTree');
      expect(ddl).not.toMatch(/ReplacingMergeTree|\bTTL\b/);
      expect(ddl).toContain('fsync_after_insert = 1');
    }
    for (const table of factTables) {
      expect(table.primaryKey.length).toBeGreaterThan(0);
      for (const c of table.columns) expect(clickhouseType(c)).toBeTruthy();
    }
  });
});
