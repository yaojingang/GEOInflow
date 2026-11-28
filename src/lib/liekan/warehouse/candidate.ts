import { factTable } from './catalog';
import { validateWireRow, type WireRow } from './codec';

function normalizeFloat(value: string) {
  if (/^[+]?nan$/i.test(value)) return 'NaN';
  if (/^[+]?(inf|infinity)$/i.test(value)) return 'Infinity';
  if (/^-(inf|infinity)$/i.test(value)) return '-Infinity';
  const n = Number(value);
  return Object.is(n, -0) ? '-0' : String(n);
}

export function canonicalWireRow(name: string, input: Record<string, unknown>): WireRow {
  const table = factTable(name);
  const values: Record<string, unknown> = {};
  for (const c of table.columns) {
    const value = input[c.name];
    values[c.name] = value;
    if (value === null || value === undefined) continue;
    if (c.type === 'double precision') values[c.name] = normalizeFloat(String(value));
    else if (['integer', 'smallint'].includes(c.type) && typeof value === 'number')
      values[c.name] = String(value);
  }
  validateWireRow(name, values);
  return values as WireRow;
}
