import { createHash } from 'node:crypto';
import { factTable, identifier, type SourceColumn } from './catalog';

export type WireValue = string | boolean | null | (string | null)[];
export type WireRow = Record<string, WireValue>;

// PG returns timestamptz as JS Date and JSON numeric values as JS Number by default.
// Export every precision-sensitive value as text at the server, before those parsers run.
export function exportExpression(c: SourceColumn, alias = 'src'): string {
  const column = `${identifier(alias)}.${identifier(c.name)}`;
  if (c.type.startsWith('timestamp')) {
    return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;
  }
  if (c.type === 'bytea') return `encode(${column}, 'hex')`;
  if (c.type === 'boolean') return column;
  if (c.type === 'text[]') return `to_json(${column})`;
  return `${column}::text`;
}

export function exportColumns(name: string, alias = 'src'): string {
  return factTable(name)
    .columns.map(c => `${exportExpression(c, alias)} AS ${identifier(c.name)}`)
    .join(', ');
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const timestamp =
  /^(19\d{2}|2[0-2]\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}$/;

function validValue(c: SourceColumn, value: unknown): boolean {
  if (value === null) return c.nullable;
  if (c.type === 'boolean') return typeof value === 'boolean';
  if (c.type === 'text[]') {
    return Array.isArray(value) && value.every(v => v === null || typeof v === 'string');
  }
  if (typeof value !== 'string') return false;
  if (c.type === 'uuid') return uuid.test(value);
  if (c.type === 'bytea') return /^(?:[0-9a-f]{2})*$/.test(value);
  if (c.type.startsWith('timestamp')) {
    if (!timestamp.test(value)) return false;
    const date = new Date(`${value.replace(' ', 'T')}Z`);
    return (
      Number.isFinite(date.valueOf()) &&
      date.toISOString().slice(0, 19) === value.slice(0, 19).replace(' ', 'T')
    );
  }
  if (['smallint', 'integer', 'bigint'].includes(c.type)) {
    if (!/^-?(0|[1-9]\d*)$/.test(value)) return false;
    const bits = c.type === 'bigint' ? 64n : c.type === 'integer' ? 32n : 16n;
    const n = BigInt(value);
    return n >= -(1n << (bits - 1n)) && n < 1n << (bits - 1n);
  }
  const decimal = /^numeric\((\d+),(\d+)\)$/.exec(c.type);
  if (decimal) {
    const match = /^-?(\d+)(?:\.(\d+))?$/.exec(value);
    return (
      !!match &&
      match[1].replace(/^0+/, '').length <= +decimal[1] - +decimal[2] &&
      (match[2]?.length ?? 0) <= +decimal[2]
    );
  }
  if (c.type === 'double precision') {
    return (
      ['NaN', 'Infinity', '-Infinity'].includes(value) ||
      (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) &&
        Number.isFinite(Number(value)))
    );
  }
  if (c.type === 'jsonb') {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

export function validateWireRow(name: string, input: Record<string, unknown>): WireRow {
  const table = factTable(name);
  if (Object.keys(input).length !== table.columns.length) {
    throw new Error(`Unexpected field set for ${name}`);
  }
  const row: WireRow = {};
  for (const column of table.columns) {
    const value = input[column.name];
    if (!validValue(column, value)) {
      // Never include a rejected visitor value in logs or CLI errors.
      throw new Error(`Unrepresentable source value: ${name}.${column.name}`);
    }
    row[column.name] = value as WireValue;
  }
  return row;
}

export function recordKeyColumns(name: string): string[] {
  // PostgreSQL upserts session properties on (session_id, data_key), retaining
  // the first session_data_id. Versions must therefore share this natural key.
  return name === 'session_data'
    ? ['website_id', 'session_id', 'data_key']
    : factTable(name).primaryKey;
}

export function recordKey(name: string, row: WireRow): string {
  const keys = recordKeyColumns(name);
  if (!keys.length || keys.some(k => row[k] === null || row[k] === undefined)) {
    throw new Error(`Missing source primary key: ${name}`);
  }
  return JSON.stringify(keys.map(k => row[k]));
}

export function rowDigest(name: string, row: WireRow): string {
  return createHash('sha256')
    .update(JSON.stringify(factTable(name).columns.map(c => row[c.name])))
    .digest('hex');
}
