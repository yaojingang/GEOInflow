import { canonicalWireRow } from './candidate';
import { factTable } from './catalog';
import type { WireRow } from './codec';

export function warehouseTime(value: string | Date) {
  const normalized =
    typeof value === 'string' && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
  const date = normalized instanceof Date ? normalized : new Date(normalized);
  if (!Number.isFinite(date.valueOf())) throw new Error('Invalid warehouse time');
  const fraction =
    typeof value === 'string'
      ? /[T ]\d{2}:\d{2}:\d{2}\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value)?.[1]
      : undefined;
  if (fraction && fraction.length > 6) throw new Error('Unsupported warehouse timestamp precision');
  const utc = date.toISOString();
  return `${utc.slice(0, 19).replace('T', ' ')}.${fraction?.padEnd(6, '0') ?? utc.slice(20, 23) + '000'}`;
}

// PostgreSQL numeric rounds decimal ties away from zero. Avoid binary toFixed()
// differences when converting the same public JS-number input to CH Decimal.
export function decimalInput(value: number | string, scale: number): string {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match || !Number.isFinite(Number(value))) throw new Error('Invalid decimal input');
  const exponent = Number(match[4] ?? 0),
    position = match[2].length + exponent + scale;
  if (Math.abs(exponent) > 400) throw new Error('Decimal input out of range');
  const digits = match[2] + (match[3] ?? '');
  const kept = position > 0 ? digits.slice(0, position).padEnd(position, '0') : '0';
  const rounding = position >= 0 && position < digits.length && digits[position] >= '5';
  const scaled = (BigInt(kept || '0') + (rounding ? 1n : 0n)).toString().padStart(scale + 1, '0');
  return `${match[1] === '-' && BigInt(scaled) !== 0n ? '-' : ''}${scale ? `${scaled.slice(0, -scale)}.${scaled.slice(-scale)}` : scaled}`;
}

export function factInput(family: string, fields: Record<string, unknown>): WireRow {
  const values: Record<string, unknown> = {};
  for (const column of factTable(family).columns) {
    let value = fields[column.name];
    if (value === undefined) value = null;
    if (value !== null) {
      if (column.type.startsWith('timestamp')) value = warehouseTime(value as string | Date);
      else if (column.type === 'jsonb')
        value = typeof value === 'string' ? value : JSON.stringify(value);
      else if (column.type === 'bytea')
        value = Buffer.isBuffer(value) ? value.toString('hex') : value;
      else if (/^numeric/.test(column.type))
        value = decimalInput(value as string | number, Number(/,(\d+)\)/.exec(column.type)[1]));
      else if (['integer', 'smallint', 'bigint', 'double precision'].includes(column.type))
        value = String(value);
      else if (column.type !== 'boolean' && column.type !== 'text[]') {
        value = String(value);
        const width = /^character(?: varying)?\((\d+)\)$/.exec(column.type);
        if (width) value = (value as string).slice(0, Number(width[1]));
      }
    }
    values[column.name] = value;
  }
  return canonicalWireRow(family, values);
}
