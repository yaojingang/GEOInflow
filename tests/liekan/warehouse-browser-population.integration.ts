import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testClickHouseURL } from './warehouse-test-target';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
import { storedFact } from '../../src/lib/liekan/warehouse/candidate';
import { factDDL, journalDDL } from '../../src/lib/liekan/warehouse/schema';
import { reportingParameters } from '../../src/lib/liekan/warehouse/reporting-relations';
import { warehouseBrowserPopulationSql } from '../../src/lib/liekan/upstream/warehouse-browser-population';
import { populationFromRow } from '../../src/lib/liekan/upstream/browser-population';
import { identityEncodingChanged } from '../../src/lib/liekan/contracts/browser-population';

// Only this synthetic CH database is created. No PG database is opened.
assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_population_${Date.now()}`;
const admin = createWarehouseClient({ url: testClickHouseURL });
const ch = createWarehouseClient({
  url: testClickHouseURL,
  database: run,
  clickhouse_settings: {
    join_use_nulls: 1,
    max_threads: 1,
    max_execution_time: 10,
    max_memory_usage: '268435456',
    max_query_size: '1048576',
  },
});
const site = randomUUID(),
  session = randomUUID(),
  other = randomUUID(),
  otherSession = randomUUID();
const start = '2026-10-01 00:00:00.000000',
  end = '2026-11-01 00:00:00.000000';
const at = '2026-10-27 00:00:00.000000';
const oldVersion = 'cookieless-trusted-input-v3',
  currentVersion = 'cookieless-trusted-input-v4';
const families = [
  'session',
  'website_event',
  'liekan_event_quality',
  'liekan_event_environment',
  'liekan_history_repair_result',
  'liekan_traffic_exclusion_member',
];
const publications: Record<string, unknown>[] = [];
let ordinal = 0,
  created = false;

async function put(family: string, fields: Record<string, unknown>, publication = 1) {
  const row = factInput(family, fields),
    attempt = randomUUID(),
    candidate = randomUUID();
  const record = storedFact(family, row, {
    _website_id: String(fields.website_id),
    _epoch: '0',
    _version: '1',
    _ordinal: ordinal++,
    _record_time: at,
    _session_id: String(fields.session_id ?? session),
    _attempt_id: attempt,
    _candidate_id: candidate,
    _topic_id: 'synthetic-population',
    _partition: 0,
    _offset: '0',
    _deleted: false,
  });
  // Retry duplicates must not multiply identity populations before background merges.
  await ch.insert({
    table: `warehouse_${family}`,
    values: [record, record],
    format: 'JSONEachRow',
  });
  publications.push({
    website_id: fields.website_id,
    epoch: '0',
    publication,
    attempt_id: attempt,
    family,
    candidate_id: candidate,
    row_count: 1,
    digest: 'a'.repeat(64),
    published_at: at,
  });
}

async function event(options: {
  version: string;
  available?: boolean;
  sessionId?: string;
  type?: number;
  publication?: number;
}) {
  const id = randomUUID(),
    sessionId = options.sessionId ?? session;
  await put(
    'website_event',
    {
      website_id: site,
      event_id: id,
      session_id: sessionId,
      visit_id: randomUUID(),
      event_type: options.type ?? 1,
      created_at: at,
      url_path: '/synthetic-population',
    },
    options.publication,
  );
  await put(
    'liekan_event_quality',
    {
      website_id: site,
      event_id: id,
      source: 'browser',
      classification: 'browser',
      reasons: [],
      rule_version: 'synthetic-v1',
      range_status: 'missing',
      created_at: at,
    },
    options.publication,
  );
  await put(
    'liekan_event_environment',
    {
      website_id: site,
      event_id: id,
      scope: options.available === false ? 'browser_unresolved' : 'browser',
      identity_available: options.available ?? true,
      identity_version: options.version,
      created_at: at,
    },
    options.publication,
  );
}

async function population(
  resourceId = site,
  resourceKind: 'website' | 'link' | 'pixel' = 'website',
  publication = '1',
) {
  const result = await ch.query({
    query: warehouseBrowserPopulationSql(),
    format: 'JSONEachRow',
    query_params: {
      ...reportingParameters({
        boundary: { websiteId: resourceId, epoch: '0', publication, deletionRevision: '0' },
        resourceKind,
        controlRevision: '0',
        population: {},
        reports: [],
        policyMode: 'standard',
        allowedHostnames: [],
        hostnames: [],
        intervals: [],
        repairRunId: null,
        repairGeneration: null,
        exclusions: [],
      }),
      start,
      end,
    },
  });
  const [row] = await result.json<Record<string, unknown>>();
  return populationFromRow(
    { ...row, metricScope: 'qualified-browser', resourceKind },
    {
      startAt: Date.parse(start.replace(' ', 'T') + 'Z'),
      endAt: Date.parse(end.replace(' ', 'T') + 'Z'),
      timezone: 'UTC',
    },
  );
}

try {
  await admin.command({ query: `CREATE DATABASE "${run}"` });
  created = true;
  for (const family of families) await ch.command({ query: factDDL(family) });
  for (const ddl of journalDDL.filter(sql =>
    /EXISTS warehouse_(publication|deletion|control_projection) \(/.test(sql),
  ))
    await ch.command({ query: ddl });
  await put('session', { website_id: site, session_id: session, created_at: at });
  await put('session', { website_id: other, session_id: otherSession, created_at: at });
  await event({ version: currentVersion });
  await event({ version: oldVersion, available: false });
  await event({ version: oldVersion, type: 2 });
  await event({ version: oldVersion, sessionId: randomUUID() });
  await event({ version: oldVersion, sessionId: otherSession });
  await event({ version: oldVersion, publication: 2 });
  const link = randomUUID(),
    pixel = randomUUID();
  for (const [resourceId, type] of [
    [link, 3],
    [pixel, 4],
  ] as const)
    await put('website_event', {
      website_id: resourceId,
      event_id: randomUUID(),
      session_id: randomUUID(),
      visit_id: randomUUID(),
      event_type: type,
      created_at: at,
      url_path: '/synthetic-link-pixel',
    });
  await ch.insert({ table: 'warehouse_publication', values: publications, format: 'JSONEachRow' });
  const first = await population();
  assert.equal(first.identity.eligibleEvents, 5);
  assert.equal(first.identity.eligiblePV, 4);
  assert.equal(first.identity.qualifiedPV, 1);
  assert.equal(first.identity.qualifiedVisitors, 1);
  assert.deepEqual(first.identity.qualifiedVersions, [currentVersion]);
  assert.equal(identityEncodingChanged(first), false);
  const mixed = await population(site, 'website', '2');
  assert.equal(mixed.identity.qualifiedPV, 2);
  assert.deepEqual(mixed.identity.qualifiedVersions, [oldVersion, currentVersion]);
  assert.equal(identityEncodingChanged(mixed), true);
  for (const [id, kind] of [
    [link, 'link'],
    [pixel, 'pixel'],
  ] as const) {
    const compatible = await population(id, kind);
    assert.equal(compatible.identity.qualifiedPV, 1);
    assert.equal(compatible.identity.status, 'complete');
  }
  console.log(
    JSON.stringify({
      run,
      passed: 4,
      checks: [
        'qualified-pv-versions-exclude-unqualified-and-custom-events',
        'same-site-session-and-retry-boundary',
        'mixed-version-publication-boundary',
        'link-pixel-compatibility',
      ],
      originalDatabaseTouched: false,
    }),
  );
} finally {
  await ch.close();
  if (created) await admin.command({ query: `DROP DATABASE "${run}" SYNC` });
  await admin.close();
}
