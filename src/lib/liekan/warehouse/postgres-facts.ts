import { canonicalWireRow } from './candidate';
import { factTable, identifier } from './catalog';
import { exportColumns, recordKey, rowDigest, type WireRow } from './codec';
import type { ControlSQL } from './control-db';
import type { FactMutation, LandedDecision } from './landing';

const parents = ['session', 'website_event', 'liekan_log', 'session_data', 'session_link'];
const counters = (family: string) =>
  family === 'liekan_collection_diagnostic'
    ? ['written', 'with_uuid', 'duplicate']
    : family === 'liekan_geography_ingress'
      ? ['count']
      : [];
const keys = (family: string) =>
  family === 'session_data' ? ['session_id', 'data_key'] : factTable(family).primaryKey;
type Pending = { mutation: FactMutation; removeFirst: boolean };

function merge(old: FactMutation, next: FactMutation): FactMutation {
  const name = next.family;
  if (old.deleted || next.deleted) return next;
  const row = { ...next.row };
  if (name === 'session' || name === 'session_link') {
    Object.assign(row, old.row);
    if (name === 'session' && !old.row.distinct_id && next.row.distinct_id)
      row.distinct_id = next.row.distinct_id;
  } else if (name === 'liekan_session_source')
    Object.assign(row, old.row, { updated_at: next.row.updated_at });
  else if (name === 'liekan_session_link_source')
    Object.assign(row, { scope: old.row.scope, created_at: old.row.created_at });
  else if (name === 'session_data') {
    row.session_data_id = old.row.session_data_id;
    if (next.retainCreatedAt) row.created_at = old.row.created_at;
  }
  for (const c of counters(name))
    row[c] = String(BigInt(String(old.row[c])) + BigInt(String(next.row[c])));
  if (name === 'liekan_collection_diagnostic') {
    row.first_at =
      String(old.row.first_at) < String(next.row.first_at) ? old.row.first_at : next.row.first_at;
    row.last_at =
      String(old.row.last_at) > String(next.row.last_at) ? old.row.last_at : next.row.last_at;
  }
  return {
    ...next,
    row,
    ...(name === 'session_data'
      ? { retainCreatedAt: !!old.retainCreatedAt && !!next.retainCreatedAt }
      : {}),
  };
}
function pgValue(type: string, value: WireRow[string]) {
  if (value === null) return null;
  if (type === 'bytea') return Buffer.from(String(value), 'hex');
  if (type.startsWith('timestamp')) return `${value}+00`;
  return value;
}
function conflictSQL(family: string, retain: boolean) {
  const table = factTable(family),
    primary = keys(family),
    columns = table.columns;
  const first = new Set<string>(primary);
  if (family === 'session' || family === 'session_link') for (const c of columns) first.add(c.name);
  if (family === 'liekan_session_source')
    for (const c of columns.filter(c => c.name !== 'updated_at')) first.add(c.name);
  if (family === 'liekan_session_link_source') {
    first.add('scope');
    first.add('created_at');
  }
  if (family === 'session_data') {
    first.add('session_data_id');
    if (retain) first.add('created_at');
  }
  const updates = columns.map(c => {
    const column = identifier(c.name),
      current = `present.${column}`,
      incoming = `EXCLUDED.${column}`;
    let value = first.has(c.name) ? current : incoming;
    if (family === 'session' && c.name === 'distinct_id')
      value = `CASE WHEN coalesce(${current},'')='' THEN coalesce(nullif(${incoming},''),${current}) ELSE ${current} END`;
    if (counters(family).includes(c.name)) value = `${current}+${incoming}`;
    if (family === 'liekan_collection_diagnostic' && c.name === 'first_at')
      value = `least(${current},${incoming})`;
    if (family === 'liekan_collection_diagnostic' && c.name === 'last_at')
      value = `greatest(${current},${incoming})`;
    return `${column}=${value}`;
  });
  return `ON CONFLICT(${primary.map(identifier).join(',')}) DO UPDATE SET ${updates.join(',')}`;
}
function pageBatches<T>(rows: T[], columns: number) {
  const batches: T[][] = [];
  let batch: T[] = [],
    bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (
      batch.length &&
      (batch.length >= Math.min(1000, Math.floor(60000 / columns)) ||
        bytes + size > 8 * 1024 * 1024)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(row);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

// Used only by the temporary PG authority/rollback applier, in its confirmation
// transaction. Group by family and natural key so a hot session does not cause
// hundreds of row-by-row statements or duplicate-key ON CONFLICT errors.
export async function applyPostgresFacts(
  tx: ControlSQL,
  site: string,
  decisions: LandedDecision[],
  role: 'authority' | 'replica' = 'authority',
) {
  await tx.query("SELECT set_config('liekan.warehouse_writer',$1,true)", [`postgres-${role}`]);
  const groups = new Map<string, Map<string, Pending>>();
  for (const decision of decisions)
    for (const input of decision.facts) {
      const mutation = { ...input, row: canonicalWireRow(input.family, input.row) };
      if (mutation.row.website_id !== site) throw new Error('warehouse-postgres-cross-site-fact');
      const group = groups.get(mutation.family) ?? new Map<string, Pending>(),
        key = recordKey(mutation.family, mutation.row),
        previous = group.get(key);
      group.set(key, {
        mutation: previous ? merge(previous.mutation, mutation) : mutation,
        removeFirst: !!mutation.deleted || !!previous?.removeFirst,
      });
      groups.set(mutation.family, group);
    }
  const families = [...groups.keys()].sort((a, b) => {
    const rank = (f: string) => (parents.includes(f) ? parents.indexOf(f) : parents.length);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  for (const family of [...families].reverse()) {
    const primary = keys(family),
      rows = [...groups.get(family).values()].filter(p => p.removeFirst).map(p => p.mutation.row);
    for (const page of pageBatches(rows, primary.length)) {
      const parameters: unknown[] = [site];
      const tuples = page.map(
        row =>
          `(${primary
            .map(k => {
              const column = factTable(family).columns.find(c => c.name === k);
              parameters.push(pgValue(column.type, row[k]));
              return `$${parameters.length}::${column.type}`;
            })
            .join(',')})`,
      );
      await tx.query(
        `DELETE FROM ${identifier(family)} WHERE website_id=$1 AND (${primary.map(identifier).join(',')}) IN(${tuples.join(',')})`,
        parameters,
      );
    }
  }
  const finalRows = new Map<string, Map<string, WireRow>>();
  for (const family of families) {
    const table = factTable(family),
      rows = [...groups.get(family).values()].filter(p => !p.mutation.deleted).map(p => p.mutation);
    const found = new Map<string, WireRow>();
    finalRows.set(family, found);
    for (const retain of [false, true])
      for (const page of pageBatches(
        rows.filter(m => !!m.retainCreatedAt === retain),
        table.columns.length,
      )) {
        const values: unknown[] = [];
        const tuples = page.map(
          m =>
            `(${table.columns
              .map(c => {
                values.push(pgValue(c.type, m.row[c.name]));
                return `$${values.length}::${c.type}`;
              })
              .join(',')})`,
        );
        const result = await tx.query<Record<string, unknown>>(
          `INSERT INTO ${identifier(family)} AS present(${table.columns.map(c => identifier(c.name)).join(',')})
        VALUES ${tuples.join(',')} ${conflictSQL(family, retain)} RETURNING ${exportColumns(family, 'present')}`,
          values,
        );
        for (const raw of result.rows) {
          const row = canonicalWireRow(family, raw);
          found.set(recordKey(family, row), row);
        }
      }
  }
  // PG's native property eligibility compares its own jsonb/Decimal digest.
  // Capture the exact committed digest plus the matching canonical CH row hash.
  const proofs = new Map<string, { sourceHash: string; dataHash: string }>();
  const sources = finalRows.get('liekan_session_data_source');
  if (sources?.size) {
    const rows = [...sources.values()];
    for (const page of pageBatches(rows, 2)) {
      const ids = page.map(r => r.session_id),
        dataKeys = page.map(r => r.data_key);
      const updated = await tx.query<Record<string, unknown>>(
        `UPDATE liekan_session_data_source AS src SET row_digest=liekan_session_data_digest(d)
        FROM session_data d WHERE src.website_id=$1 AND d.website_id=src.website_id AND d.session_id=src.session_id AND d.data_key=src.data_key
          AND (src.session_id,src.data_key) IN(SELECT * FROM unnest($2::uuid[],$3::text[])) RETURNING ${exportColumns('liekan_session_data_source')}`,
        [site, ids, dataKeys],
      );
      for (const raw of updated.rows) {
        const row = canonicalWireRow('liekan_session_data_source', raw),
          key = recordKey('liekan_session_data_source', row);
        const data = finalRows.get('session_data')?.get(recordKey('session_data', row));
        if (!data) throw new Error('warehouse-postgres-property-source-incomplete');
        sources.set(key, row);
        proofs.set(key, {
          sourceHash: rowDigest('liekan_session_data_source', row),
          dataHash: rowDigest('session_data', data),
        });
      }
    }
  }
  return decisions.map(decision => ({
    ...decision,
    facts: decision.facts.map(m => {
      if (m.deleted || counters(m.family).length) return m;
      const key = recordKey(m.family, m.row),
        row = finalRows.get(m.family)?.get(key);
      if (!row && groups.get(m.family)?.get(key)?.mutation.deleted) return m;
      if (!row) throw new Error('warehouse-postgres-result-incomplete');
      return {
        ...m,
        row,
        retainCreatedAt: false,
        ...(m.family === 'liekan_session_data_source' ? { propertyProof: proofs.get(key) } : {}),
      };
    }),
  }));
}
