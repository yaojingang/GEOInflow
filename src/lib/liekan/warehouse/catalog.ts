import { createHash } from 'node:crypto';
import source from '../../../../config/liekan/warehouse-source-schema.json';

export type Ownership = 'clickhouse' | 'postgres' | 'retire' | 'transform';
export type SourceColumn = { name: string; type: string; nullable: boolean };
export type SourceTable = {
  name: string;
  ownership: Ownership;
  primaryKey: string[];
  columns: SourceColumn[];
  transition?: string;
};

export const SOURCE_VERSION = source.version;
export const sourceTables = source.tables as SourceTable[];
export const factTables = sourceTables.filter(t => t.ownership === 'clickhouse');
export const sourceFingerprint = createHash('sha256').update(JSON.stringify(source)).digest('hex');

export function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Invalid warehouse identifier');
  return `"${value}"`;
}

export function factTable(name: string): SourceTable {
  const found = factTables.find(t => t.name === name);
  if (!found) throw new Error(`Unregistered fact family: ${name}`);
  return found;
}

export type ActualTable = Pick<SourceTable, 'name' | 'primaryKey' | 'columns'>;

// Fail closed: a new source table/column needs an explicit disposition before migration.
// Extensions must be placed in a separate schema; they are not silently skipped.
export function schemaDifferences(actual: ActualTable[]): string[] {
  const errors: string[] = [];
  const byName = new Map(actual.map(t => [t.name, t]));
  if (byName.size !== actual.length) errors.push('Duplicate table names');
  for (const expected of sourceTables) {
    const table = byName.get(expected.name);
    if (!table) {
      errors.push(`Missing table: ${expected.name}`);
      continue;
    }
    byName.delete(expected.name);
    if (JSON.stringify(table.primaryKey) !== JSON.stringify(expected.primaryKey)) {
      errors.push(`Primary key changed: ${table.name}`);
    }
    const columns = new Map(table.columns.map(c => [c.name, c]));
    for (const column of expected.columns) {
      const found = columns.get(column.name);
      if (!found || found.type !== column.type || found.nullable !== column.nullable) {
        errors.push(`Column changed or missing: ${table.name}.${column.name}`);
      }
      columns.delete(column.name);
    }
    for (const column of columns.keys()) errors.push(`Unmapped column: ${table.name}.${column}`);
  }
  for (const name of byName.keys()) errors.push(`Unmapped table: ${name}`);
  return errors;
}

export const sourceCatalogSQL = `
SELECT c.relname AS name,
  coalesce((SELECT json_agg(a.attname ORDER BY k.ordinality)
    FROM pg_index ix
    CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY k(attnum, ordinality)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE ix.indrelid = c.oid AND ix.indisprimary), '[]'::json) AS "primaryKey",
  (SELECT json_agg(json_build_object('name', a.attname,
      'type', format_type(a.atttypid, a.atttypmod), 'nullable', NOT a.attnotnull)
      ORDER BY a.attnum)
    FROM pg_attribute a
    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND c.relname NOT LIKE 'liekan_warehouse_%'
ORDER BY c.relname`;
