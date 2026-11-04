import { testClickHouseURL } from './warehouse-test-target';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createClient } from '@clickhouse/client';
import pg from 'pg';
import { type StoredFact, storedFact } from '../../src/lib/liekan/warehouse/candidate';
import {
  factTables,
  identifier,
  schemaDifferences,
  sourceCatalogSQL,
} from '../../src/lib/liekan/warehouse/catalog';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import type { WireRow } from '../../src/lib/liekan/warehouse/codec';
import {
  exportColumns,
  recordKey,
  rowDigest,
  validateWireRow,
} from '../../src/lib/liekan/warehouse/codec';
import { initializeWarehouse } from '../../src/lib/liekan/warehouse/initialize';
import { boundaryParameters, factRelation } from '../../src/lib/liekan/warehouse/read';

// Deliberately has no DATABASE_URL fallback. Only the existing isolated schema-only
// catalog and a fresh ClickHouse database are reachable through this test entrypoint.
assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_schema_${Date.now()}`;
const password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const source = new pg.Client({
  host: '127.0.0.1',
  port: 25459,
  user: 'liekan_ch_proto',
  password,
  database: 'liekan_ch_catalog_20261103',
});
const admin = createClient({ url: testClickHouseURL, request_timeout: 30000 });
const ch = createWarehouseClient({
  url: testClickHouseURL,
  database: run,
  request_timeout: 30000,
  clickhouse_settings: { max_threads: 1, max_memory_usage: '268435456' },
});
const site = '11111111-1111-1111-1111-111111111111';
const session = '22222222-2222-2222-2222-222222222222';
const cases: object[] = [];
const fixtures = new Map<string, WireRow>();
const start = performance.now();

function sample(type: string): unknown {
  if (type === 'uuid') return site;
  if (type.startsWith('timestamp')) return '2026-10-26 14:40:14.123456+00';
  if (type === 'boolean') return false;
  if (type === 'bigint') return '9223372036854775807';
  if (type === 'integer') return '-2147483648';
  if (type === 'smallint') return '-32768';
  if (type === 'double precision') return '1.2345678901234567';
  if (type.startsWith('numeric(19')) return '999999999999999.1234';
  if (type === 'numeric(10,4)') return '999999.1234';
  if (type === 'numeric(10,1)') return '999999999.1';
  if (type === 'jsonb') return '{"large":9223372036854775807,"null":null,"nested":["中",false]}';
  if (type === 'text[]') return ['中文', null, 'a"b\\c'];
  if (type === 'bytea') return Buffer.from([0, 255, 128, 1, 10]);
  if (type === 'character(2)') return 'CN';
  const width = /^character(?: varying)?\((\d+)\)$/.exec(type);
  return '中文/Exact?x=1#段'.slice(0, width ? Number(width[1]) : undefined);
}

try {
  await source.connect();
  assert.equal(
    (await source.query('SELECT current_database() AS db')).rows[0].db,
    'liekan_ch_catalog_20261103',
  );
  assert.deepEqual(schemaDifferences((await source.query(sourceCatalogSQL)).rows), []);
  await admin.command({ query: `CREATE DATABASE ${identifier(run)}` });
  const initialized = await initializeWarehouse(ch);
  assert.deepEqual(await initializeWarehouse(ch), initialized);
  const boundary = { websiteId: site, epoch: '0', publication: '1', deletionRevision: '0' };
  const params = boundaryParameters(boundary);

  for (const table of factTables) {
    const temp = `fixture_${table.name}`;
    await source.query(
      `CREATE TEMP TABLE ${identifier(temp)} (${table.columns.map(c => `${identifier(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join(',')})`,
    );
    await source.query(
      `INSERT INTO ${identifier(temp)} VALUES (${table.columns.map((_, i) => `$${i + 1}`).join(',')})`,
      table.columns.map(c => sample(c.type)),
    );
    const raw = (
      await source.query(`SELECT ${exportColumns(table.name)} FROM ${identifier(temp)} AS src`)
    ).rows[0];
    const row = validateWireRow(table.name, raw);
    fixtures.set(table.name, row);
    const attempt = randomUUID(),
      candidate = randomUUID();
    const meta = {
      _website_id: site,
      _record_key: recordKey(table.name, row),
      _record_time: '2026-10-26 14:40:14.123456',
      _session_id: session,
      _epoch: '0',
      _version: '1',
      _ordinal: 0,
      _attempt_id: attempt,
      _candidate_id: candidate,
      _topic_id: 'fixture-topic',
      _partition: 0,
      _offset: '5',
      _deleted: false,
      _row_hash: rowDigest(table.name, row),
    };
    await ch.insert({
      table: `warehouse_${table.name}`,
      values: [{ ...row, ...meta }],
      format: 'JSONEachRow',
    });
    const read = () =>
      ch
        .query({
          query: `SELECT * FROM ${factRelation(table.name)}`,
          query_params: params,
          format: 'JSONEachRow',
        })
        .then(r => r.json<Record<string, unknown>>());
    const readProjected = () =>
      ch
        .query({
          query: `SELECT * FROM ${factRelation(table.name, { columns: table.columns.map(c => c.name) })}`,
          query_params: params,
          format: 'JSONEachRow',
        })
        .then(r => r.json<Record<string, unknown>>());
    assert.equal((await read()).length, 0, 'unpublished rows must stay invisible');
    assert.equal((await readProjected()).length, 0, 'projected unpublished rows stay invisible');
    await ch.insert({
      table: 'warehouse_publication',
      values: [
        {
          website_id: site,
          epoch: '0',
          publication: '1',
          attempt_id: attempt,
          family: table.name,
          candidate_id: candidate,
          row_count: '1',
          digest: meta._row_hash,
          published_at: meta._record_time,
        },
      ],
      format: 'JSONEachRow',
    });
    const result = await read();
    assert.equal(result.length, 1);
    assert.equal(result[0]._row_hash, meta._row_hash);
    const projected = await readProjected();
    assert.equal(projected.length, 1);
    for (const c of table.columns) assert.deepEqual(projected[0][c.name], result[0][c.name]);
    // Compare the actual typed values, not only the stored checksum column.
    for (const column of table.columns) {
      let actual = result[0][column.name];
      if (column.type === 'boolean') actual = !!actual;
      else if (column.type.startsWith('numeric')) {
        // CH JSON numeric output can lose precision; read exact decimal text explicitly.
        const exact = await ch
          .query({
            query: `SELECT toString(${identifier(column.name)}) AS v FROM ${factRelation(table.name)}`,
            query_params: params,
            format: 'JSONEachRow',
          })
          .then(r => r.json<Record<string, unknown>>());
        actual = exact[0].v;
      } else if (['integer', 'smallint', 'bigint', 'double precision'].includes(column.type))
        actual = String(actual);
      assert.deepEqual(actual, row[column.name], `${table.name}.${column.name}`);
    }
    // An unaccepted replacement must not supersede the published value, even after merge.
    await ch.insert({
      table: `warehouse_${table.name}`,
      values: [{ ...row, ...meta, _candidate_id: randomUUID(), _version: '2', _deleted: true }],
      format: 'JSONEachRow',
    });
    await ch.command({ query: `OPTIMIZE TABLE ${identifier(`warehouse_${table.name}`)} FINAL` });
    assert.equal((await read()).length, 1);
    assert.deepEqual(
      await readProjected(),
      projected,
      'projection ignores rejected candidate after merge',
    );
    cases.push({ family: table.name, columns: table.columns.length, status: 'pass' });
  }
  // A staged deletion is invisible until PG advances its revision; resetting the
  // epoch hides all prior families without touching any original source rows.
  await ch.insert({
    table: 'warehouse_deletion',
    values: [
      {
        website_id: site,
        epoch: '0',
        revision: '1',
        operation_id: randomUUID(),
        session_id: session,
        version: '2',
        topic_id: 'fixture-topic',
        partitions: [0],
        offsets: ['6'],
        created_at: '2026-10-26 15:00:00.000000',
      },
    ],
    format: 'JSONEachRow',
  });
  for (const revision of ['0', '1']) {
    const rows = await ch
      .query({
        query: `SELECT count() AS n FROM ${factRelation('website_event')}`,
        query_params: boundaryParameters({ ...boundary, deletionRevision: revision }),
        format: 'JSONEachRow',
      })
      .then(r => r.json<Record<string, unknown>>());
    assert.equal(Number(rows[0].n), revision === '0' ? 1 : 0);
  }
  cases.push({ scenario: 'deletion publication boundary', status: 'pass' });
  const appendVersion = async (
    family: string,
    row: WireRow,
    version: number,
    retainCreated = false,
    deleted = false,
  ) => {
    const record = storedFact(family, row, {
      _website_id: site,
      _record_time: '2026-10-26 14:40:14.123456',
      _session_id: session,
      _epoch: '0',
      _version: String(version),
      _ordinal: 0,
      _attempt_id: randomUUID(),
      _candidate_id: randomUUID(),
      _topic_id: 'fixture-topic',
      _partition: 0,
      _offset: String(version),
      _deleted: deleted,
      _retain_created_at: retainCreated,
    });
    await ch.insert({ table: `warehouse_${family}`, values: [record], format: 'JSONEachRow' });
    await ch.insert({
      table: 'warehouse_publication',
      values: [
        {
          website_id: site,
          epoch: '0',
          publication: String(version),
          attempt_id: record._attempt_id,
          family,
          candidate_id: record._candidate_id,
          row_count: '1',
          digest: record._row_hash,
          published_at: record._record_time,
        },
      ],
      format: 'JSONEachRow',
    });
  };
  const entitySession = randomUUID();
  const sessionRow = {
    ...fixtures.get('session'),
    session_id: entitySession,
    distinct_id: null,
    browser: 'initial',
  };
  await appendVersion('session', sessionRow, 10);
  await appendVersion('session', { ...sessionRow, distinct_id: 'first', browser: 'later' }, 11);
  await appendVersion('session', { ...sessionRow, distinct_id: 'second', browser: 'last' }, 12);
  const readEntity = async (family: string, publication: number) =>
    ch
      .query({
        query: `SELECT * FROM ${factRelation(family)} WHERE session_id={session:UUID}`,
        query_params: {
          ...boundaryParameters({
            websiteId: site,
            epoch: '0',
            publication: String(publication),
            deletionRevision: '0',
          }),
          session: entitySession,
        },
        format: 'JSONEachRow',
      })
      .then(r => r.json<StoredFact>());
  const [s] = await readEntity('session', 12);
  assert.equal(s.browser, 'initial');
  assert.equal(s.distinct_id, 'first');
  cases.push({
    scenario: 'session first creation and first nonempty identity survive later versions',
    status: 'pass',
  });
  const originalID = randomUUID();
  const property: WireRow = {
    ...fixtures.get('session_data'),
    session_id: entitySession,
    session_data_id: originalID,
    string_value: 'first',
  };
  await appendVersion('session_data', property, 10);
  await appendVersion(
    'session_data',
    {
      ...property,
      session_data_id: randomUUID(),
      string_value: 'second',
      created_at: '2026-10-27 00:00:00.000000',
    },
    11,
    true,
  );
  const [v2] = await readEntity('session_data', 11);
  assert.equal(v2.session_data_id, originalID);
  assert.equal(v2.string_value, 'second');
  assert.equal(v2.created_at, property.created_at);
  await appendVersion(
    'session_data',
    {
      ...property,
      session_data_id: randomUUID(),
      string_value: null,
      number_value: null,
      date_value: null,
      created_at: null,
    },
    12,
  );
  const v3 = await readEntity('session_data', 12);
  assert.equal(v3.length, 1);
  assert.equal(v3[0].session_data_id, originalID);
  assert.equal(v3[0].string_value, null);
  assert.equal(v3[0].created_at, null);
  cases.push({
    scenario: 'property natural-key upsert retains original ID, implicit time and explicit null',
    status: 'pass',
  });
  await appendVersion('session_data', property, 13, false, true);
  await ch.command({ query: 'OPTIMIZE TABLE warehouse_session_data FINAL' });
  assert.equal((await readEntity('session_data', 13)).length, 0);
  assert.equal((await readEntity('session_data', 12)).length, 1);
  cases.push({
    scenario:
      'accepted tombstone does not resurrect old property, old publication remains readable',
    status: 'pass',
  });
  const repair: WireRow = {
    ...fixtures.get('liekan_history_repair_result'),
    run_id: randomUUID(),
    generation: randomUUID(),
    kind: 'event',
    record_id: randomUUID(),
    after_value: JSON.stringify({ classification: 'browser', aiEligible: true }),
    proof: JSON.stringify({ catalogVersion: site }),
  };
  await appendVersion('liekan_history_repair_result', repair, 20);
  await appendVersion(
    'liekan_history_repair_result',
    {
      ...repair,
      after_value: JSON.stringify({ classification: null, aiEligible: null }),
      proof: JSON.stringify({ catalogVersion: null }),
    },
    21,
  );
  const relation = factRelation('liekan_history_repair_result', {
    repairFields: [
      {
        name: '_repair_classification',
        column: 'after_value',
        key: 'classification',
        type: 'String',
      },
      { name: '_repair_ai', column: 'after_value', key: 'aiEligible', type: 'Bool' },
      { name: '_repair_catalog', column: 'proof', key: 'catalogVersion', type: 'UUID' },
      { name: '_repair_has_catalog', column: 'proof', key: 'catalogVersion', type: 'Has' },
    ],
  });
  for (const publication of [20, 21]) {
    const rows = await ch
      .query({
        query: `SELECT _repair_classification AS classification,_repair_ai AS ai,
        _repair_catalog AS catalog,_repair_has_catalog AS has_catalog
        FROM ${relation} WHERE run_id={repair:UUID}`,
        query_params: {
          ...boundaryParameters({
            websiteId: site,
            epoch: '0',
            publication: String(publication),
            deletionRevision: '0',
          }),
          repair: repair.run_id,
        },
        format: 'JSONEachRow',
      })
      .then(r => r.json());
    assert.deepEqual(rows, [
      publication === 20
        ? { classification: 'browser', ai: true, catalog: site, has_catalog: 1 }
        : { classification: null, ai: null, catalog: null, has_catalog: 1 },
    ]);
  }
  cases.push({
    scenario:
      'compact repair projections preserve latest explicit nulls and old publication identity',
    status: 'pass',
  });
  assert.throws(() =>
    factRelation('liekan_log', {
      repairFields: [{ name: '_repair_bad', column: 'proof', key: 'catalogVersion', type: 'UUID' }],
    }),
  );
  assert.throws(() =>
    factRelation('liekan_history_repair_result', {
      repairFields: [{ name: '_repair_bad', column: 'proof', key: "x' OR true", type: 'String' }],
    }),
  );
  cases.push({
    scenario: 'repair projection family and JSON key validation reject invalid SQL inputs',
    status: 'pass',
  });
  console.log(`PASS ${cases.length} warehouse schema and publication cases`);
} catch (error) {
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
  // Error objects from drivers may contain connection settings or visitor content.
  console.error(error instanceof Error ? error.message : 'Warehouse schema test failed');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([source.end(), ch.close(), admin.close()]);
  await mkdir('.local/ch-implementation', { recursive: true, mode: 0o700 });
  const report = {
    run,
    cases,
    elapsedMs: Math.round(performance.now() - start),
    fullUpgradeValidated: false,
  };
  await writeFile(`.local/ch-implementation/${run}.json`, JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
}
