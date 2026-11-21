import { createHash } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { factTable, identifier } from './catalog';
import { recordKey, rowDigest, validateWireRow, type WireRow } from './codec';
import {
  flushOutsidePublicationSpan,
  linkPublicationQuery,
  type PublicationTrace,
  tracePublication,
} from './publication-timing';
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

const insertRows = 5000;
const insertBytes = 8 * 1024 * 1024;
function verifyRows(name: string, rows: StoredFact[], expectedCount: number, digest: string) {
  if (rows.length !== expectedCount || candidateDigest(name, rows) !== digest)
    throw new Error(`Warehouse candidate verification failed: ${name}`);
  return {
    rowCount: String(rows.length),
    digest,
    attempts: [...new Set(rows.map(r => r._attempt_id))],
    versions: [...new Set(rows.map(r => r._version))],
  };
}
function verificationColumns(name: string) {
  return [...factTable(name).columns.map(c => c.name), ...factMetadata.map(([key]) => key)]
    .map(identifier)
    .join(',');
}
type PendingInsert = {
  queryId?: string;
  rows: StoredFact[];
  bytes: number;
  receipts: { resolve: () => void; reject: (error: unknown) => void }[];
};

export class CandidateWriter {
  private readonly pending?: Map<string, PendingInsert>;

  constructor(
    private readonly client: ClickHouseClient,
    private readonly options?: { coalesce: boolean; ingestionLogFlushLimitMs?: number },
  ) {
    if (options?.coalesce) this.pending = new Map();
  }

  private async insert(name: string, rows: StoredFact[], queryId?: string) {
    const maxWait = this.options?.ingestionLogFlushLimitMs;
    const ingestionLog = name === 'liekan_log' || name === 'liekan_log_geography';
    await this.client.insert({
      ...(ingestionLog && maxWait !== undefined && {
        clickhouse_settings: { async_insert_busy_timeout_max_ms: maxWait },
      }),
      table: `warehouse_${name}`,
      values: rows,
      ...(queryId && { query_id: queryId }),
      format: 'JSONEachRow',
    });
  }

  private flush(name: string, batch: PendingInsert) {
    if (this.pending.get(name) !== batch) return;
    this.pending.delete(name);
    // An acknowledgement or ambiguous failure belongs to every insert caller.
    // Publication still independently verifies each candidate from storage.
    void flushOutsidePublicationSpan(() => this.insert(name, batch.rows, batch.queryId)).then(
      () => batch.receipts.forEach(request => request.resolve()),
      error => batch.receipts.forEach(request => request.reject(error)),
    );
  }

  private write(name: string, rows: StoredFact[], bytes: number) {
    if (!this.pending) return this.insert(name, rows);
    return new Promise<void>((resolve, reject) => {
      let batch = this.pending.get(name);
      if (
        batch &&
        (batch.rows.length + rows.length > insertRows || batch.bytes + bytes > insertBytes)
      ) {
        this.flush(name, batch);
        batch = undefined;
      }
      if (!batch) {
        const next: PendingInsert = { rows: [], bytes: 0, receipts: [] };
        this.pending.set(name, next);
        // Share writes already ready in this turn. No timed wait for more work.
        setImmediate(() => this.flush(name, next));
        batch = next;
      }
      batch.queryId = linkPublicationQuery(batch.queryId);
      batch.rows.push(...rows);
      batch.bytes += bytes;
      batch.receipts.push({ resolve, reject });
    });
  }

  async append(name: string, rows: StoredFact[]) {
    factTable(name);
    if (!rows.length) return;
    // Validate before the first write. A partly written candidate is never published.
    candidateDigest(name, rows);
    let batch: StoredFact[] = [],
      bytes = 0;
    const flush = async () => {
      if (batch.length) await this.write(name, batch, bytes);
      batch = [];
      bytes = 0;
    };
    for (const row of rows) {
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (batch.length && (batch.length >= insertRows || bytes + size > insertBytes)) await flush();
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
    recoveryRows?: StoredFact[],
    trace?: PublicationTrace,
  ) {
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || expectedCount > 15000)
      throw new Error('Invalid candidate verification bound');
    const columns = verificationColumns(name);
    const read = () =>
      this.client
        .query({
          query: `SELECT DISTINCT ${columns}
      FROM ${identifier(`warehouse_${name}`)} WHERE _website_id={site:UUID} AND _epoch={epoch:UInt64}
        AND _candidate_id={candidate:UUID} LIMIT {limit:UInt32}`,
          query_params: {
            site: websiteId,
            epoch,
            candidate: candidateId,
            limit: expectedCount + 1,
          },
          format: 'JSONEachRow',
        })
        .then(r => r.json<StoredFact>());
    const rows = recoveryRows
      ? await tracePublication(trace, 'recovery.read.' + name, read)
      : await read();
    if (recoveryRows && rows.length < expectedCount) {
      // Compare the entire persisted subset (including metadata) to sealed input.
      // A short or timed-out response alone never establishes which rows are missing.
      const present = new Set(rows.map(row => row._ordinal));
      const expectedSubset = recoveryRows.filter(row => present.has(row._ordinal));
      verifyRows(name, rows, expectedSubset.length, candidateDigest(name, expectedSubset));
      const missing = recoveryRows.filter(row => !present.has(row._ordinal));
      await tracePublication(
        trace,
        'recovery.append.' + name,
        () => this.append(name, missing),
        missing.length,
      );
      return tracePublication(trace, 'recovery.recheck.' + name, async () =>
        verifyRows(name, await read(), expectedCount, expectedDigest),
      );
    }
    return verifyRows(name, rows, expectedCount, expectedDigest);
  }
}
