import { testClickHouseURL } from './warehouse-test-target';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { getBundledPublishedCatalog } from '../../src/lib/liekan/crawlers/catalog-seed';
import type { AiTx } from '../../src/lib/liekan/upstream/ai-db';
import { storedFact } from '../../src/lib/liekan/warehouse/candidate';
import { factTable, identifier } from '../../src/lib/liekan/warehouse/catalog';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
import { initializeWarehouse } from '../../src/lib/liekan/warehouse/initialize';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_geo_${Date.now()}`;
const password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const connection = { host: '127.0.0.1', port: 25459, user: 'liekan_ch_proto', password };
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' });
const url = new URL(`postgresql://127.0.0.1:25459/${run}`);
url.username = connection.user;
url.password = password;
const db = new ControlDatabase(url.toString());
const chAdmin = createWarehouseClient({ url: testClickHouseURL });
const ch = createWarehouseClient({
  url: testClickHouseURL,
  database: run,
  request_timeout: 30000,
  clickhouse_settings: {
    max_threads: 1,
    max_memory_usage: '268435456',
    join_use_nulls: 1,
    max_query_size: '1048576',
  },
});
const site = randomUUID(),
  session = randomUUID(),
  visit = randomUUID(),
  batch = randomUUID();
const at = '2026-11-03T00:00:00Z';
const cases: object[] = [];
let boss: PgBoss | undefined;
let ordinal = 0;
async function put(family: string, fields: Record<string, unknown>) {
  const row = factInput(family, fields),
    cols = factTable(family).columns;
  await db.transaction(tx =>
    tx.query(
      `INSERT INTO ${identifier(family)}(${cols.map(c => identifier(c.name)).join(',')}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')})`,
      cols.map(c =>
        c.type === 'bytea' && row[c.name] !== null
          ? Buffer.from(String(row[c.name]), 'hex')
          : row[c.name],
      ),
    ),
  );
  const attempt = randomUUID(),
    candidate = randomUUID();
  await ch.insert({
    table: `warehouse_${family}`,
    values: [
      storedFact(family, row, {
        _website_id: site,
        _record_time:
          typeof row.created_at === 'string' ? row.created_at : '2026-11-03 00:00:00.000000',
        _session_id: family === 'liekan_log' ? null : session,
        _epoch: '0',
        _version: '0',
        _ordinal: ordinal++,
        _attempt_id: attempt,
        _candidate_id: candidate,
        _topic_id: 'fixture',
        _partition: 0,
        _offset: '0',
        _deleted: false,
      }),
    ],
    format: 'JSONEachRow',
  });
  await ch.insert({
    table: 'warehouse_publication',
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
        published_at: '2026-11-03 00:00:00.000000',
      },
    ],
    format: 'JSONEachRow',
  });
  return row;
}
const catalog = getBundledPublishedCatalog();
const measurement = {
  host: 'fixture.invalid',
  hostBasis: 'request_host',
  samplingRate: 1,
  samplingBasis: 'observed_provider_config',
  samplingTimeBasis: 'event_time',
};
async function log(overrides: Record<string, unknown> = {}) {
  const { evidence = {}, ...fields } = overrides,
    id = createHash('sha256').update(randomUUID()).digest('hex');
  await put('liekan_log', {
    id,
    website_id: site,
    import_id: batch,
    created_at: at,
    path: '/article',
    method: 'GET',
    status: 200,
    bytes: 123,
    ip_masked: 'masked',
    ip_hash: 'a'.repeat(64),
    user_agent: 'IsolatedTestBot',
    location: 'unknown',
    bot: '其他',
    vendor: '其他',
    bot_type: '其他',
    ai_eligible: true,
    recognition_state: 'recognized',
    verification: 'verified_range',
    verification_version: 'snapshot-1',
    verification_observed_at: at,
    verification_reason: 'verified_range',
    ...fields,
  });
  await put('liekan_crawler_evidence', {
    website_id: site,
    log_id: id,
    crawler_id: 'oai-searchbot',
    catalog_version: catalog.version,
    classification_version: 'class-1',
    identity_evidence: {},
    measurement,
    edge_observation: {
      fields: { EdgeResponseContentType: { state: 'present', value: 'text/html' } },
    },
    ...(evidence as object),
  });
}
const window = {
  asOf: '2026-11-04',
  startAt: +new Date('2026-10-05T00:00:00Z'),
  endAt: +new Date('2026-11-05T00:00:00Z'),
};
async function compare(name: string) {
  const { geoWeightAggregate, geoWeightFirstEvidence } = await import(
    '../../src/lib/liekan/upstream/geo-weight-sql'
  );
  const tx: AiTx = {
    query: (sql, ...params) => db.read(sql, params),
    execute: () => {
      throw new Error('No product writes in aggregate test');
    },
  };
  process.env.LIEKAN_ANALYTICS_BACKEND = 'postgresql';
  const windows = [0, 7, 14, 21, 28, 30].map(days => ({
    asOf: new Date(Date.parse(window.asOf) - days * 86400000).toISOString().slice(0, 10),
    startAt: window.startAt - days * 86400000,
    endAt: window.endAt - days * 86400000,
  }));
  const expected = await geoWeightAggregate(tx, site, 'fixture.invalid', 'Asia/Shanghai', windows);
  const first = await geoWeightFirstEvidence(
    tx,
    site,
    'fixture.invalid',
    'Asia/Shanghai',
    window.endAt,
  );
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  const actual = await geoWeightAggregate(tx, site, 'fixture.invalid', 'Asia/Shanghai', windows);
  const byDate = (a: Record<string, any>, b: Record<string, any>) => a.asOf.localeCompare(b.asOf);
  assert.deepEqual(actual.map((value: Record<string, any>) => {
    const { qualityVersions: _quality, ...row } = value;
    return row;
  }).sort(byDate), [...expected].sort(byDate), name);
  const { warehouseCrawlerWindowVersions } = await import('../../src/lib/liekan/upstream/warehouse-geo-weight');
  for (const window of windows) {
    const projected = actual.find(row => row.asOf === window.asOf).qualityVersions;
    assert.deepEqual(projected, await warehouseCrawlerWindowVersions(site, window.startAt, window.endAt), name + ' quality versions');
  }
  assert.equal(
    await geoWeightFirstEvidence(tx, site, 'fixture.invalid', 'Asia/Shanghai', window.endAt),
    first,
    name + ' first evidence',
  );
  cases.push({ name, status: 'pass' });
  console.log('PASS ' + name);
  return actual[0];
}
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${run}" TEMPLATE liekan_ch_catalog_20261103`);
  for (const file of (await readdir('db/liekan/migrations'))
    .filter(f => /^\d{3}_/.test(f) && /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) >= 57)
    .sort())
    await db.transaction(async tx => {
      const sql = await readFile(`db/liekan/migrations/${file}`, 'utf8');
      await tx.query(sql);
      await tx.query('INSERT INTO liekan_migration(name,checksum) VALUES($1,$2)', [
        file,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    });
  await chAdmin.command({ query: `CREATE DATABASE "${run}"` });
  await initializeWarehouse(ch);

  process.env.DATABASE_URL = url.toString();
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  process.env.LIEKAN_CLICKHOUSE_URL = testClickHouseURL;
  process.env.LIEKAN_CLICKHOUSE_DATABASE = run;
  delete process.env.CLICKHOUSE_URL;
  delete process.env.LIEKAN_QUEUE_BROKERS;
  await db.transaction(async tx => {
    await tx.query(
      "INSERT INTO website(website_id,name,domain) VALUES($1,'Isolated GEO fixture','fixture.invalid')",
      [site],
    );
    await tx.query('INSERT INTO liekan_warehouse_site(website_id,publication) VALUES($1,1)', [
      site,
    ]);
    await tx.query(
      'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1,$2,$3,0,0)',
      [batch, site, 'a'.repeat(64)],
    );
    await tx.query(
      "INSERT INTO liekan_crawler_registry_version(version,revision,content_hash,payload,action) VALUES($1,1,$2,$3,'seed')",
      [catalog.version, catalog.contentHash, JSON.stringify(catalog.payload)],
    );
    await tx.query(
      "INSERT INTO liekan_crawler_rule_version(website_id,version,matcher_version,rules,catalog_version,crawler_configuration) VALUES($1,'class-1','fixture','[]',$2,'{}')",
      [site, catalog.version],
    );
    const range = catalog.payload.rangeSources.find(r => r.crawlerIds.includes('oai-searchbot'));
    await tx.query(
      "INSERT INTO liekan_crawler_range_snapshot(source_id,version,source_url,parser_version,names,crawler_ids,prefixes,address_families,observed_at) VALUES($1,'snapshot-1',$2,'fixture','[]',$3,'[]','[]',now())",
      [range.id, range.url, JSON.stringify(range.crawlerIds)],
    );
  });
  await compare('empty evidence stays missing');
  await log();
  await log({ status: 304 });
  await log({ path: '/another' });
  const base = await compare('verified 200 and 304 duplicate path/day units');
  assert.equal(base.stats.accepted, 3);
  assert.equal(base.factors[0].units, 2);
  for (let i = 0; i < 8; i++)
    await log({
      path: '/extra-' + i,
      created_at: i % 2 ? '2026-11-02T00:00:00Z' : '2026-11-01T00:00:00Z',
    });
  const breadth = await compare('operator breadth requires ten units across three days');
  assert.equal(breadth.factors[0].operators, 1);
  await log({ user_agent: 'Liekan-Crawler-Check/1', status: 500 });
  await log({ evidence: { measurement: { host: 'fixture.invalid' } } });
  await log({ recognition_state: 'ambiguous' });
  await log({ evidence: { crawler_id: 'bytespider' } });
  await log({ evidence: { catalog_version: randomUUID() } });
  await log({ verification_observed_at: '2026-01-01T00:00:00Z' });
  await log({ method: 'HEAD' });
  await log({ path: '/sitemap-index.xml' });
  const rejected = await compare('exclusive reasons preserve source evidence');
  assert.deepEqual(rejected.exclusions, {
    self_check: 1,
    host: 1,
    ambiguous: 1,
    outside_scope: 1,
    history: 1,
    verification: 1,
    response: 1,
    content: 1,
  });
  await log({ path: '/article.json' });
  await log({ path: '/article.pdf', evidence: { edge_observation: null } });
  await log({ path: '/static.css', evidence: { edge_observation: null } });
  await log({
    path: '/invalid',
    evidence: { edge_observation: { fields: { EdgeResponseContentType: { state: 'invalid' } } } },
  });
  await log({ evidence: { measurement: JSON.stringify({ ...measurement, samplingRate: 1.0 }) } });
  await compare('MIME evidence and unknown metadata use the same classification');
  await log({ evidence: { crawler_id: 'chatgpt-agent' } });
  await log({
    evidence: {
      crawler_id: 'chatgpt-agent',
      measurement: { host: 'other.invalid', hostBasis: 'request_host' },
    },
  });
  await log({
    ai_eligible: false,
    recognition_state: 'unknown',
    verification: 'not_applicable',
    created_at: '2026-08-01T00:00:00Z',
    evidence: { crawler_id: null },
  });
  await compare('personal agents and archived ordinary input preserve observation span');
  await db.transaction(tx =>
    tx.query("UPDATE liekan_crawler_range_snapshot SET source_url='https://unbound.invalid/list'"),
  );
  await compare('unbound historical range evidence never becomes verified');
  await db.transaction(tx =>
    tx.query('UPDATE liekan_crawler_rule_version SET crawler_configuration=NULL'),
  );
  await compare('missing historical rule configuration stays unknown');
  const actor = { id: randomUUID(), role: 'user' };
  await db.transaction(async tx => {
    await tx.query(
      `INSERT INTO "user"(user_id,username,password,role) VALUES($1,$2,'isolated-unused-password','user')`,
      [actor.id, actor.id],
    );
    await tx.query('UPDATE website SET user_id=$2 WHERE website_id=$1', [site, actor.id]);
    await tx.query(
      `INSERT INTO liekan_warehouse_installation(id,installation_id,schema_version,routing_version,topic_name,topic_id,partition_count,authority,transition)
      VALUES(1,$1,2,1,'isolated-geo-no-ingestion','isolated-geo-no-ingestion',1,'clickhouse','none')`,
      [randomUUID()],
    );
    assert.equal((await tx.query('SELECT 1 FROM liekan_jobs.job LIMIT 1')).rowCount, 0);
    await tx.query('DROP SCHEMA liekan_jobs CASCADE');
  });
  const installer = new PgBoss({
    connectionString: url.toString(),
    schema: 'liekan_jobs',
    migrate: true,
    schedule: false,
    supervise: false,
    max: 2,
  });
  installer.on('error', () => {});
  await installer.start();
  await installer.createQueue('liekan-geo-weight-snapshot');
  await installer.stop();
  const { getQueue } = await import('../../src/lib/liekan/log-ingestion/queue');
  boss = await getQueue();
  const { readGeoWeightSnapshot, processGeoSnapshotJob, readGeoWeightForExport } = await import(
    '../../src/lib/liekan/upstream/geo-weight-snapshots'
  );
  // Exceed the old 500-head product quota using explicitly isolated history.
  await db.transaction(tx =>
    tx.query(
      `INSERT INTO liekan_geo_weight_head(website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,task_status,actor_id,ownership)
    SELECT $1,'fixture.invalid','UTC','2020-01-01'::date+i,1,'isolated-fixture','isolated-fixture',i::text,'failed',$2,'isolated-fixture' FROM generate_series(1,501)i`,
      [site, actor.id],
    ),
  );
  const request = {
    mode: 'historical',
    asOf: '2026-11-02',
    timezone: 'Asia/Shanghai',
    view: 'detail',
  };
  const queued = await readGeoWeightSnapshot(actor, site, request);
  assert.equal(queued.taskStatus, 'queued');
  assert.ok(queued.taskId);
  let busy = 0;
  const monitor = setInterval(() => {
    void db
      .read<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='idle in transaction' AND xact_start<clock_timestamp()-interval '1 second'`)
      .then(rows => {
        busy += rows[0].n;
      });
  }, 100);
  try {
    await processGeoSnapshotJob({ headId: queued.taskId }, boss);
  } finally {
    clearInterval(monitor);
  }
  const completed = await readGeoWeightSnapshot(
    actor,
    site,
    { ...request, taskId: queued.taskId },
    { statusOnly: true },
  );
  assert.equal(
    completed.taskStatus,
    'ready',
    JSON.stringify({ status: completed.taskStatus, error: completed.errorCode }),
  );
  assert.ok(completed.snapshotId);
  const [proof] = await db.read<any>(
    'SELECT input_boundary,result_bytes FROM liekan_geo_weight_snapshot WHERE id=$1',
    [completed.snapshotId],
  );
  assert.equal(proof.input_boundary.warehouse.publication, '1');
  assert.equal(proof.input_boundary.warehouse.websiteId, site);
  assert.equal(
    (
      await db.read("SELECT 1 FROM liekan_warehouse_reference WHERE kind='geo' AND owner_id=$1", [
        completed.snapshotId,
      ])
    ).length,
    1,
  );
  assert.equal(busy, 0, 'CH computation must not keep a PG transaction open');
  cases.push({
    name: 'full GEO queue/calculation/publication passes beyond old head quota, retains CH proof reference and holds no long PG transaction',
    status: 'pass',
  });
  console.log('PASS full GEO workflow');
  const exported = await readGeoWeightForExport(actor, site, { snapshotId: completed.snapshotId });
  assert.equal(exported.snapshotId, completed.snapshotId);
  const { warehouseControlRead } = await import(
    '../../src/lib/liekan/upstream/warehouse-control-read'
  );
  await assert.rejects(
    () =>
      warehouseControlRead(async tx => {
        await tx.query('SELECT name FROM website WHERE website_id=$1', site);
        await db.transaction(write =>
          write.query("UPDATE website SET name='Changed during CH read' WHERE website_id=$1", [
            site,
          ]),
        );
        return true;
      }),
    e => (e as Error).constructor.name === 'AnalyticsRestart',
  );
  cases.push({
    name: 'GEO export keeps its published proof and control revalidation rejects an interleaved business change',
    status: 'pass',
  });
  await db.transaction(async tx => {
    await tx.query(
      `INSERT INTO liekan_catalog(website_id,path,title,content_type) SELECT $1,'/catalog-'||i,'Isolated catalog','text/html' FROM generate_series(1,1005)i`,
      [site],
    );
    await tx.query(
      `INSERT INTO liekan_catalog(website_id,path,title,content_type) VALUES($1,'/extra-0','Isolated observed catalog','text/html'),($1,'/extra-1','Isolated observed catalog','text/html'),($1,'/中文','Isolated Unicode catalog','text/html')`,
      [site],
    );
  });
  const { crawlerAnalysis } = await import('../../src/lib/liekan/crawlers/analysis');
  const { warehouseCrawlerHours, warehouseCrawlerHourMetadata, warehouseCrawlerExpected } =
    await import('../../src/lib/liekan/upstream/warehouse-crawler-queries');
  const reportRange = {
    startAt: +new Date('2026-10-20T00:00:00Z'),
    // The eight historical requests are on Nov 1–2; the other classification
    // fixtures start on Nov 3. Wall-clock time must not change this population.
    endAt: +new Date('2026-11-03T00:00:00Z'),
    timezone: 'UTC',
  };
  const plain = (v: any) => JSON.parse(JSON.stringify(v));
  process.env.LIEKAN_ANALYTICS_BACKEND = 'postgresql';
  const originalReport = await crawlerAnalysis(actor, site, reportRange);
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  const warehouseReport = await crawlerAnalysis(actor, site, reportRange);
  for (const key of ['bots', 'pages', 'quality', 'platforms', 'previous']) {
    if (key === 'previous') {
      assert.deepEqual(plain(warehouseReport.previous.bots), plain(originalReport.previous.bots));
      assert.deepEqual(
        plain(warehouseReport.previous.quality),
        plain(originalReport.previous.quality),
      );
    } else assert.deepEqual(plain(warehouseReport[key]), plain(originalReport[key]), key);
  }
  const projected = await ch
    .query({
      query: `SELECT uniqExact(key) AS n FROM warehouse_control_projection WHERE kind='catalog-path-v1'`,
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ n: string }>());
  assert.equal(Number(projected[0].n), 1008);
  const tx: AiTx = {
    query: (sql, ...params) => db.read(sql, params),
    execute: async () => {
      throw new Error('Read-only test control');
    },
  };
  const hours = await warehouseCrawlerHours(tx, site, reportRange.startAt, reportRange.endAt);
  const metadata = await warehouseCrawlerHourMetadata(site, reportRange.startAt, reportRange.endAt);
  assert.equal(
    hours.reduce((n, r) => n + Number((r as any).requests), 0),
    8,
  );
  assert.equal(
    metadata.reduce((n, r) => n + Number(r.legacy), 0),
    0,
  );
  const expected = await warehouseCrawlerExpected(
    tx,
    site,
    reportRange.startAt,
    reportRange.endAt,
    ['/extra-1'],
  );
  assert.equal(expected.length, 1);
  assert.equal(expected[0].denied, 0);
  cases.push({
    name: 'crawler page/bot/quality/referral reports match PG; 1008 catalog paths project in resumable bounded pages; hourly and critical-path risk inputs read CH',
    status: 'pass',
  });
  console.log('PASS crawler reports and risk inputs');
  await db.transaction(tx =>
    tx.query(
      `INSERT INTO liekan_crawler_registry_current(id,version,revision,seed_hash,seed_payload) VALUES(1,$1,1,$2,$3)
    ON CONFLICT(id) DO NOTHING`,
      [catalog.version, catalog.contentHash, JSON.stringify(catalog.payload)],
    ),
  );
  const { recomputeCrawlerRisks } = await import('../../src/lib/liekan/crawlers/worker');
  await recomputeCrawlerRisks(site);
  const risk = await db.read<any>(
    'SELECT quality,error_code FROM liekan_crawler_analysis_state WHERE website_id=$1',
    [site],
  );
  assert.equal(risk.length, 1);
  assert.equal(risk[0].error_code, null);
  assert.equal(risk[0].quality.warehouse.publication, '1');
  cases.push({
    name: 'full crawler risk computation publishes PG findings against a pinned CH publication',
    status: 'pass',
  });
  const { warehouseCrawlerCoverage } = await import(
    '../../src/lib/liekan/upstream/warehouse-crawler-queries'
  );
  const coverage = await warehouseCrawlerCoverage(
    site,
    reportRange.startAt,
    reportRange.endAt,
    +new Date('2026-11-01T00:00:00Z'),
    ['/extra-0', '/extra-1'],
  );
  assert.equal(coverage.length, 2);
  assert.equal(
    coverage.reduce((n, r) => n + Number(r.current), 0),
    2,
  );
  const { warehouseCatalogProjection } = await import(
    '../../src/lib/liekan/upstream/warehouse-catalog'
  );
  const { warehouseReader } = await import('../../src/lib/liekan/warehouse/reader-runtime');
  const { withinWarehouseReport } = await import(
    '../../src/lib/liekan/upstream/warehouse-report-snapshot'
  );
  await db.transaction(write =>
    write.query(
      `INSERT INTO liekan_catalog(website_id,path,title,content_type) VALUES($1,'/resume','Isolated projection recovery','text/html')`,
      [site],
    ),
  );
  const reader = warehouseReader(),
    insert = reader.ch.insert.bind(reader.ch);
  let injected = false;
  reader.ch.insert = (async (args: any) => {
    const response = await insert(args);
    if (!injected && args.values?.[0]?.kind === 'catalog-path-v1') {
      injected = true;
      throw new Error('isolated catalog interrupted after first page');
    }
    return response;
  }) as typeof reader.ch.insert;
  try {
    await assert.rejects(
      () => withinWarehouseReport(() => warehouseCatalogProjection(site)),
      /isolated catalog interrupted/,
    );
  } finally {
    reader.ch.insert = insert;
  }
  const resumed = await withinWarehouseReport(() => warehouseCatalogProjection(site));
  const manifests = await ch
    .query({
      query: `SELECT DISTINCT value FROM warehouse_control_projection WHERE kind='catalog-manifest-v1' AND revision={rev:UInt64}`,
      query_params: { rev: resumed.wh_catalog_revision },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ value: string }>());
  assert.equal(manifests.length, 1);
  assert.equal(JSON.parse(manifests[0].value).count, 1009);
  cases.push({
    name: 'coverage reads only common catalog paths; interrupted catalog projection resumes with exact distinct membership and verified digest',
    status: 'pass',
  });
} catch (error) {
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : 'unknown');
} finally {
  await boss?.stop();
  await db.close();
  await admin.end();
  await ch.close();
  await chAdmin.close();
  if (process.env.LIEKAN_CLICKHOUSE_DATABASE === run)
    await (await import('../../src/lib/liekan/warehouse/reader-runtime')).warehouseReader().close();
  await writeFile(`.local/ch-implementation/${run}.json`, JSON.stringify({ cases }, null, 2), {
    mode: 0o600,
  });
}
