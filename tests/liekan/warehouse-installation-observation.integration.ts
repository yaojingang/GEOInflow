import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testClickHouseURL } from './warehouse-test-target';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { factInput, warehouseTime } from '../../src/lib/liekan/warehouse/fact-input';
import { storedFact } from '../../src/lib/liekan/warehouse/candidate';
import { factDDL, journalDDL } from '../../src/lib/liekan/warehouse/schema';
import { boundaryParameters } from '../../src/lib/liekan/warehouse/read';
import {
  normalizeWarehouseInstallationObservation,
  warehouseInstallationObservationSql,
} from '../../src/lib/liekan/upstream/warehouse-installation-observation';

// Creates only its own synthetic CH database. No application or downloaded PG database is opened.
assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_observation_${Date.now()}`;
const admin = createWarehouseClient({ url: testClickHouseURL });
const ch = createWarehouseClient({ url: testClickHouseURL, database: run });
const site = randomUUID(),
  session = randomUUID();
const endAt = Date.parse('2026-10-27T09:30:00Z'),
  startAt = endAt - 1800000;
const at = (value: number) => warehouseTime(new Date(value));
const families = [
  'session',
  'website_event',
  'liekan_event_quality',
  'liekan_event_environment',
  'liekan_event_observation',
];
const publications: Record<string, unknown>[] = [];
let ordinal = 0;
let created = false;

async function put(family: string, fields: Record<string, unknown>, publication = 1) {
  const row = factInput(family, fields),
    attempt = randomUUID(),
    candidate = randomUUID();
  const record = storedFact(family, row, {
    _website_id: site,
    _epoch: '0',
    _version: '1',
    _ordinal: ordinal++,
    _record_time: String(row.created_at ?? row.event_at ?? at(startAt)),
    _session_id: session,
    _attempt_id: attempt,
    _candidate_id: candidate,
    _topic_id: 'synthetic-observation',
    _partition: 0,
    _offset: '0',
    _deleted: false,
  });
  // Retries before merges must not double the observed population.
  await ch.insert({
    table: `warehouse_${family}`,
    values: [record, record],
    format: 'JSONEachRow',
  });
  publications.push({
    website_id: site,
    epoch: '0',
    publication,
    attempt_id: attempt,
    family,
    candidate_id: candidate,
    row_count: 1,
    digest: 'a'.repeat(64),
    published_at: at(startAt),
  });
}

async function event(
  options: {
    receipt?: number;
    qualityAt?: number;
    observed?: boolean;
    environment?: boolean;
    available?: boolean;
    identityVersion?: string;
    source?: string;
    missingSession?: boolean;
    quality?: boolean;
    type?: number;
    publication?: number;
  } = {},
) {
  const eventId = randomUUID(),
    receipt = options.receipt ?? startAt + 60000;
  const publication = options.publication ?? 1;
  await put(
    'website_event',
    {
      website_id: site,
      event_id: eventId,
      session_id: options.missingSession ? randomUUID() : session,
      visit_id: session,
      created_at: '2000-01-01T00:00:00Z',
      event_type: options.type ?? 1,
      url_path: '/synthetic-observation',
    },
    publication,
  );
  if (options.quality !== false)
    await put(
      'liekan_event_quality',
      {
        website_id: site,
        event_id: eventId,
        source: options.source ?? 'browser',
        classification: 'browser',
        reasons: [],
        rule_version: 'synthetic-v1',
        range_status: 'missing',
        created_at: at(options.qualityAt ?? receipt),
      },
      publication,
    );
  if (options.environment !== false)
    await put(
      'liekan_event_environment',
      {
        website_id: site,
        event_id: eventId,
        scope: options.available === false ? 'browser_unresolved' : 'browser',
        identity_available: options.available ?? true,
        identity_version: options.identityVersion ?? 'synthetic-v1',
        created_at: at(receipt),
      },
      publication,
    );
  if (options.observed !== false)
    await put(
      'liekan_event_observation',
      {
        website_id: site,
        event_id: eventId,
        epoch: '1',
        version: 'synthetic-v1',
        event_at: '2000-01-01T00:00:00Z',
        received_at: at(receipt),
        features: {},
      },
      publication,
    );
}

async function counts(publication = '1', deletionRevision = '0') {
  const result = await ch.query({
    query: warehouseInstallationObservationSql(),
    query_params: {
      ...boundaryParameters({ websiteId: site, epoch: '0', publication, deletionRevision }),
      receivedStart: at(startAt),
      receivedEnd: at(endAt),
    },
    clickhouse_settings: { join_use_nulls: 1, max_threads: 1, max_execution_time: 5 },
    format: 'JSONEachRow',
  });
  const [raw] = await result.json<Record<string, unknown>>();
  const row = normalizeWarehouseInstallationObservation(raw);
  return {
    samples: row.samples,
    available: row.available,
    unknown: row.unknown,
    fallback: row.fallback,
  };
}

try {
  await admin.command({ query: `CREATE DATABASE "${run}"` });
  created = true;
  for (const family of families) await ch.command({ query: factDDL(family) });
  for (const ddl of journalDDL.filter(sql =>
    /EXISTS warehouse_(publication|deletion) \(/.test(sql),
  ))
    await ch.command({ query: ddl });
  await put('session', {
    website_id: site,
    session_id: session,
    created_at: '2000-01-01T00:00:00Z',
  });
  await event({ receipt: startAt });
  await event({ observed: false, environment: false, source: 'legacy_override' });
  await event({ available: false });
  await event({ identityVersion: '' });
  await event({ receipt: startAt - 1, qualityAt: startAt + 1 });
  await event({ receipt: endAt });
  await event({ missingSession: true });
  await event({ source: 'server' });
  await event({ type: 2 });
  await event({ quality: false });
  await event({ publication: 2 });
  await ch.insert({ table: 'warehouse_publication', values: publications, format: 'JSONEachRow' });
  assert.deepEqual(await counts(), { samples: 4, available: 1, unknown: 2, fallback: 1 });
  assert.deepEqual(await counts('2'), { samples: 5, available: 2, unknown: 2, fallback: 1 });
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
        topic_id: 'synthetic-observation',
        partitions: [],
        offsets: [],
        created_at: at(endAt),
      },
    ],
    format: 'JSONEachRow',
  });
  assert.deepEqual(await counts('2', '1'), { samples: 0, available: 0, unknown: 0, fallback: 0 });
  console.log(
    JSON.stringify({
      run,
      passed: 3,
      checks: [
        'raw-receipt-population-and-retry-parity',
        'accepted-publication-boundary',
        'session-deletion-boundary',
      ],
      originalDatabaseTouched: false,
    }),
  );
} finally {
  await ch.close();
  if (created) await admin.command({ query: `DROP DATABASE "${run}" SYNC` });
  await admin.close();
}
