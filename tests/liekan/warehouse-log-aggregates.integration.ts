// Real CH regression for projected log and GEO evidence reads. Only a new, random local
// database is written; existing facts and PostgreSQL are never modified.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { storedFact } from '../../src/lib/liekan/warehouse/candidate';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
import { warehouseDDL } from '../../src/lib/liekan/warehouse/schema';
import { factRelation } from '../../src/lib/liekan/warehouse/read';
import { crawlerAiSql, unknownCrawlerSql } from '../../src/lib/liekan/rules/population';

assert.equal(process.env.WAREHOUSE_LOG_QUERY_TEST, 'isolated');
const url = process.env.WAREHOUSE_TEST_CLICKHOUSE_URL ?? 'http://127.0.0.1:28139';
assert.match(url, /^http:\/\/127\.0\.0\.1:(28139|28149|28159)$/);
const auth = url.endsWith(':28149')
  ? {
      username: 'liekan_full_test',
      password: (await readFile('.local/ch-full-validation/ch-password', 'utf8')).trim(),
    }
  : {};
// Importing the upstream bridge initializes Prisma, but this test only builds
// SQL. A deliberately unreachable URL prevents accidental application DB use.
process.env.DATABASE_URL = 'postgresql://unused@127.0.0.1:1/unused';
process.env.DATABASE_TYPE = 'postgresql';
const { warehouseLogQuerySpec } = await import(
  '../../src/lib/liekan/upstream/warehouse-log-queries'
);
const run = `warehouse_log_aggregates_${randomUUID().replaceAll('-', '')}`;
const admin = createWarehouseClient({ url, ...auth });
const ch = createWarehouseClient({
  url,
  ...auth,
  database: run,
  clickhouse_settings: {
    max_threads: 1,
    max_execution_time: 20,
    max_memory_usage: '268435456',
    max_query_size: '1048576',
    join_use_nulls: 1,
  },
});
const site = randomUUID(),
  batch = randomUUID(),
  repair = randomUUID(),
  generation = randomUUID(),
  source = randomUUID();
let ordinal = 0;
let created = false;
const params = {
  wh_site: site,
  wh_epoch: '0',
  wh_publication: '1',
  wh_deletion: '0',
  wh_repair_run: repair,
  wh_repair_generation: generation,
  wh_interval_source: [] as string[],
  wh_interval_start: [] as string[],
  wh_interval_end: [] as string[],
};
async function put(
  family: string,
  fields: Record<string, unknown>,
  published = true,
  deleted = false,
) {
  const row = factInput(family, fields),
    attempt = randomUUID(),
    candidate = randomUUID();
  await ch.insert({
    table: `warehouse_${family}`,
    format: 'JSONEachRow',
    values: [
      storedFact(family, row, {
        _website_id: site,
        _epoch: '0',
        _version: '0',
        _ordinal: ordinal++,
        // Evidence deliberately arrives later than the log window.
        _record_time:
          family === 'liekan_log' ? String(row.created_at) : '2026-11-04 00:00:00.000000',
        _session_id: null,
        _attempt_id: attempt,
        _candidate_id: candidate,
        _topic_id: 'fixture',
        _partition: 0,
        _offset: '0',
        _deleted: deleted,
      }),
    ],
  });
  if (published)
    await ch.insert({
      table: 'warehouse_publication',
      format: 'JSONEachRow',
      values: [
        {
          website_id: site,
          epoch: '0',
          publication: '1',
          attempt_id: attempt,
          family,
          candidate_id: candidate,
          row_count: 1,
          digest: 'a'.repeat(64),
          published_at: '2026-11-04 00:00:00.000000',
        },
      ],
    });
}
const baseLog = {
  website_id: site,
  import_id: batch,
  created_at: '2026-11-01 12:00:00.000000',
  path: '/fixture',
  method: 'GET',
  status: 200,
  bytes: 10,
  ip_masked: 'fixture',
  ip_hash: 'a'.repeat(64),
  user_agent: 'IsolatedTestBot',
  location: 'unknown',
  bot: 'SameBot',
  vendor: 'Fixture',
  bot_type: '搜索',
  verification: 'verified_range',
  ai_eligible: true,
};
const checks: object[] = [];
async function compare(
  name: string,
  metrics: Parameters<typeof warehouseLogQuerySpec>[3] = { crawlerIdentityScope: 'all' },
) {
  const spec = await warehouseLogQuerySpec(
    new Date('2026-11-01T00:00:00Z'),
    new Date('2026-11-02T00:00:00Z'),
    'UTC',
    metrics,
    '',
    '',
    false,
    site,
  );
  const query = async (sql: string) =>
    (
      await ch.query({
        query: sql,
        query_params: { ...params, ...spec.params },
        format: 'JSONEachRow',
      })
    ).json<Record<string, any>>();
  const known = `NOT ${unknownCrawlerSql('l')}`,
    ai = crawlerAiSql('l');
  const expected = {
    summary: await query(spec.statements.summary),
    bots: await query(
      `SELECT bot AS name,vendor,bot_type AS type,reporting_crawler_id AS botId,count() AS requests,countIf(${ai}) AS aiRequests,uniqExact(path) AS pages,toString(max(created_at)) AS lastVisit ${spec.base} AND ${known} GROUP BY name,vendor,type,botId ORDER BY requests DESC,name,botId,vendor,type`,
    ),
  };
  assert.deepEqual(await query(spec.statements.bots), expected.bots, `${name}: narrow bots`);
  assert.deepEqual(
    await query(spec.statements.pages),
    await query(
      `SELECT path,bot,reporting_crawler_id AS botId,count() AS requests,toString(max(created_at)) AS lastCrawled ${spec.base} AND ${ai} GROUP BY path,bot,botId ORDER BY requests DESC,path,bot,botId`,
    ),
    `${name}: narrow pages`,
  );
  const shared = await warehouseLogQuerySpec(
    new Date('2026-11-01T00:00:00Z'),
    new Date('2026-11-02T00:00:00Z'),
    'UTC',
    { ...metrics, resource: 'overview' },
    '',
    '',
    false,
    site,
    true,
  );
  const reused = await query(shared.overview);
  for (const key of ['summary', 'bots', 'pages']) {
    assert.deepEqual(
      reused.filter(row => row.section === key).map(row => JSON.parse(row.row)),
      await query(spec.statements[key]),
      `${name}: materialized ${key} preserves values and ordering`,
    );
  }
  checks.push({ name, status: 'pass' });
  return expected;
}
try {
  await admin.command({ query: `CREATE DATABASE ${run}` });
  created = true;
  for (const ddl of warehouseDDL().filter(sql =>
    /^CREATE TABLE IF NOT EXISTS "?warehouse_(liekan_log|liekan_crawler_evidence|liekan_history_repair_result|publication|deletion)"?\s*\(/.test(
      sql,
    ),
  ))
    await ch.command({ query: ddl });
  const empty = await compare('empty population retains zero summary');
  assert.equal(empty.summary[0].requests, '0');
  for (const [id, changes] of Object.entries({
    known: { recognition_state: 'recognized' },
    unknown: { recognition_state: 'unknown', path: '/unknown', status: 404 },
    ambiguous: { recognition_state: 'ambiguous', path: '/ambiguous' },
    legacy: { bot: '其他', ai_eligible: null },
    repaired: { bot: '其他', ai_eligible: false },
    selfcheck: { user_agent: 'Liekan-Crawler-Check/test' },
    end: { created_at: '2026-11-02 00:00:00.000000' },
    automatic: { source_id: source },
    unverified: { verification: 'unverified' },
  })) {
    await put('liekan_log', { ...baseLog, id, ...changes });
    await put('liekan_crawler_evidence', {
      website_id: site,
      log_id: id,
      crawler_id: 'same-crawler',
      classification_version: 'fixture-v1',
    });
  }
  await put('liekan_log', { ...baseLog, id: 'unpublished', path: '/unpublished' }, false);
  await put('liekan_log', { ...baseLog, id: 'deleted', path: '/deleted' });
  await put('liekan_log', { ...baseLog, id: 'deleted', path: '/deleted' }, true, true);
  await put('liekan_history_repair_result', {
    website_id: site,
    run_id: repair,
    generation,
    kind: 'log',
    record_id: 'repaired',
    before_value: {},
    after_value: {
      bot: 'RepairedBot',
      aiEligible: true,
      recognitionState: 'recognized',
      crawlerId: 'repaired-crawler',
    },
    proof: { rulepack: 'fixture-v2', catalogVersion: null },
    created_at: '2026-11-04T00:00:00Z',
  });
  const legacy = await compare(
    'mixed identities, late evidence, repair, unpublished rows and tombstones',
  );
  assert.equal(legacy.summary[0].requests, '8'); // Unselected automatic source is excluded.
  assert.equal(legacy.summary[0].unclassifiedRequests, '3');
  assert.equal(legacy.bots.find(r => r.name === 'SameBot')?.requests, '4');
  await compare('metric v1 excludes self-check and exclusive end', {
    crawlerIdentityScope: 'all',
    crawlerMetricsVersion: 1,
  });
  await compare('verified population', {
    crawlerIdentityScope: 'verified_range',
    crawlerMetricsVersion: 1,
  });
  params.wh_interval_source = [source];
  params.wh_interval_start = ['1793491200000000'];
  params.wh_interval_end = ['1793577600000000'];
  await compare('effective source interval', {
    crawlerIdentityScope: 'all',
    crawlerMetricsVersion: 1,
  });
  // Compare each projected value against the original JSONExtract expressions,
  // including missing, explicit null, wrong types and latest null replacements.
  const jsonCases = [
    {},
    { measurement: null, identity_evidence: null, edge_observation: null },
    {
      measurement: {
        host: 'fixture.invalid',
        hostBasis: 'request_host',
        samplingRate: 1,
        samplingTimeBasis: 'event_time',
        samplingBasis: 'observed_provider_config',
      },
      identity_evidence: { reason: 'identity_conflict' },
      edge_observation: {
        fields: { EdgeResponseContentType: { state: 'present', value: 'text/html' } },
      },
    },
    { measurement: { host: null, samplingRate: null }, edge_observation: { fields: null } },
    {
      measurement: { host: 12, hostBasis: false, samplingRate: '1' },
      identity_evidence: { reason: [] },
      edge_observation: { fields: { EdgeResponseContentType: { state: false, value: [] } } },
    },
    { measurement: [], identity_evidence: 12, edge_observation: { fields: [] } },
  ];
  for (const [index, fields] of jsonCases.entries())
    await put('liekan_crawler_evidence', { website_id: site, log_id: `json-${index}`, ...fields });
  await put('liekan_crawler_evidence', {
    website_id: site,
    log_id: 'json-latest',
    ...jsonCases[2],
  });
  await put('liekan_crawler_evidence', {
    website_id: site,
    log_id: 'json-latest',
    ...jsonCases[1],
  });
  await put(
    'liekan_crawler_evidence',
    { website_id: site, log_id: 'json-latest', ...jsonCases[2] },
    false,
  );
  await put('liekan_crawler_evidence', {
    website_id: site,
    log_id: 'json-deleted',
    ...jsonCases[2],
  });
  await put(
    'liekan_crawler_evidence',
    { website_id: site, log_id: 'json-deleted', ...jsonCases[2] },
    true,
    true,
  );
  const jsonFields = {
    _geo_host: "JSONExtract(coalesce(measurement,'{}'),'host','Nullable(String)')",
    _geo_basis: "JSONExtract(coalesce(measurement,'{}'),'hostBasis','Nullable(String)')",
    _geo_sampling_time:
      "JSONExtract(coalesce(measurement,'{}'),'samplingTimeBasis','Nullable(String)')",
    _geo_sampling_basis:
      "JSONExtract(coalesce(measurement,'{}'),'samplingBasis','Nullable(String)')",
    _geo_sampling_rate:
      "JSONExtract(coalesce(measurement,'{}'),'samplingRate','Nullable(Float64)')",
    _geo_reason: "JSONExtract(coalesce(identity_evidence,'{}'),'reason','Nullable(String)')",
    _geo_mime_state:
      "JSONExtract(coalesce(edge_observation,'{}'),'fields','EdgeResponseContentType','state','Nullable(String)')",
    _geo_mime:
      "JSONExtract(coalesce(edge_observation,'{}'),'fields','EdgeResponseContentType','value','Nullable(String)')",
  };
  const read = async (sql: string) =>
    (await ch.query({ query: sql, query_params: params, format: 'JSONEachRow' })).json<
      Record<string, unknown>
    >();
  const projected = await read(
    `SELECT log_id,${Object.keys(jsonFields).join(',')} FROM ${factRelation('liekan_crawler_evidence', { columns: ['log_id', ...Object.keys(jsonFields)], geoEvidence: true })} ORDER BY log_id`,
  );
  assert.deepEqual(
    projected,
    await read(
      `SELECT log_id,${Object.entries(jsonFields)
        .map(([key, expr]) => `${expr} AS ${key}`)
        .join(',')} FROM ${factRelation('liekan_crawler_evidence')} ORDER BY log_id`,
    ),
  );
  assert.equal(projected.find(row => row.log_id === 'json-latest')?._geo_host, null);
  assert.ok(!projected.some(row => row.log_id === 'json-deleted'));
  assert.throws(
    () => factRelation('liekan_log', { geoEvidence: true }),
    /Invalid warehouse GEO evidence/,
  );
  checks.push({ name: 'GEO JSON field and accepted-version parity', status: 'pass' });
  console.log(JSON.stringify({ checks, database: run }));
} finally {
  await ch.close();
  if (created) await admin.command({ query: `DROP DATABASE IF EXISTS ${run} SYNC` });
  await admin.close();
}
