import { createHash } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { factTable, identifier } from './catalog';
import { recordKey, rowDigest, validateWireRow, type WireRow } from './codec';
import { factMetadata } from './schema';

export type FactPosition = {
  _website_id: string;
  _record_key: string;
  _record_time: string;
  _session_id: string | null;
  _epoch: string;
  _version: string;
  _ordinal: number;
  _attempt_id: string;
  _candidate_id: string;
  _topic_id: string;
  _partition: number;
  _offset: string;
  _deleted: boolean;
  _retain_created_at: boolean;
  _row_hash: string;
};
export type StoredFact = Record<string, unknown> & FactPosition;

function normalizeFloat(value: string) {
  if (/^[+]?nan$/i.test(value)) return 'NaN';
  if (/^[+]?(inf|infinity)$/i.test(value)) return 'Infinity';
  if (/^-(inf|infinity)$/i.test(value)) return '-Infinity';
  const n = Number(value);
  return Object.is(n, -0) ? '-0' : String(n);
}

// One canonical wire representation is used on both sides of verification.
// JSON text stays text: parsing and serializing it would round large JSON numbers.
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
    // 64-bit integers and Decimal must have been quoted by the warehouse client.
    else if (c.type === 'boolean' && (value === 0 || value === 1)) values[c.name] = !!value;
  }
  return validateWireRow(name, values);
}

export function storedFact(
  name: string,
  row: WireRow,
  position: Omit<FactPosition, '_record_key' | '_row_hash' | '_retain_created_at'> & {
    _retain_created_at?: boolean;
  },
): StoredFact {
  const canonical = canonicalWireRow(name, row);
  return {
    ...canonical,
    ...position,
    _retain_created_at: position._retain_created_at ?? false,
    _record_key: recordKey(name, canonical),
    _row_hash: rowDigest(name, canonical),
  } as StoredFact;
}

export function candidateDigest(name: string, rows: StoredFact[]): string {
  const hash = createHash('sha256');
  const ordered = [...rows].sort(
    (a, b) =>
      a._ordinal - b._ordinal ||
      Buffer.compare(Buffer.from(a._record_key), Buffer.from(b._record_key)),
  );
  for (const record of ordered) {
    const row = canonicalWireRow(name, record);
    if (recordKey(name, row) !== record._record_key || rowDigest(name, row) !== record._row_hash)
      throw new Error('Warehouse candidate content mismatch');
    hash
      .update(
        JSON.stringify([
          factTable(name).columns.map(c => row[c.name]),
          factMetadata.map(([key]) => record[key]),
        ]),
      )
      .update('\n');
  }
  return hash.digest('hex');
}

export class CandidateWriter {
  constructor(private readonly client: ClickHouseClient) {}

  async append(name: string, rows: StoredFact[]) {
    factTable(name);
    if (!rows.length) return;
    // Validate before the first write. A partly written candidate is never published.
    candidateDigest(name, rows);
    let batch: StoredFact[] = [],
      bytes = 0;
    const flush = async () => {
      if (batch.length)
        await this.client.insert({
          table: `warehouse_${name}`,
          values: batch,
          format: 'JSONEachRow',
        });
      batch = [];
      bytes = 0;
    };
    for (const row of rows) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (batch.length && (batch.length >= 5000 || bytes + size > 8 * 1024 * 1024)) await flush();
      batch.push(row);
      bytes += size;
    }
    await flush();
  }

  async verify(
    name: string,
    websiteId: string,
    epoch: string,
    candidateId: string,
    expectedCount: number,
    expectedDigest: string,
  ) {
    const table = factTable(name);
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || expectedCount > 15000)
      throw new Error('Invalid candidate verification bound');
    const columns = [...table.columns.map(c => c.name), ...factMetadata.map(([key]) => key)]
      .map(identifier)
      .join(',');
    const rows = await this.client
      .query({
        query: `SELECT DISTINCT ${columns}
      FROM ${identifier(`warehouse_${name}`)} WHERE _website_id={site:UUID} AND _epoch={epoch:UInt64}
        AND _candidate_id={candidate:UUID} LIMIT {limit:UInt32}`,
        query_params: { site: websiteId, epoch, candidate: candidateId, limit: expectedCount + 1 },
        format: 'JSONEachRow',
      })
      .then(r => r.json<StoredFact>());
    if (rows.length !== expectedCount || candidateDigest(name, rows) !== expectedDigest)
      throw new Error('Warehouse candidate verification failed');
    return {
      rowCount: String(rows.length),
      digest: expectedDigest,
      attempts: [...new Set(rows.map(r => r._attempt_id))],
      versions: [...new Set(rows.map(r => r._version))],
    };
  }
}
