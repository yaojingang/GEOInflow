import { testClickHouseURL } from './warehouse-test-target';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { storedFact } from '../../src/lib/liekan/warehouse/candidate';
import { factTable, identifier } from '../../src/lib/liekan/warehouse/catalog';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
import { initializeWarehouse } from '../../src/lib/liekan/warehouse/initialize';
import { readReportingMetadata } from '../../src/lib/liekan/warehouse/reporting-context';
import {
  browserEventRelation,
  geographicEventRelation,
  reportingLogRelation,
  reportingParameters,
} from '../../src/lib/liekan/warehouse/reporting-relations';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = `warehouse_reporting_${Date.now()}`;
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
  source = randomUUID(),
  batch = randomUUID(),
  repair = randomUUID(),
  generation = randomUUID(),
  excluded = randomUUID();
const at = '2026-11-03T00:00:00Z';
const cases: object[] = [];
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
async function compare(view: string, relation: string, selection: string) {
  const params = reportingParameters(await readReportingMetadata(db, site));
  const expected = await db.read(`SELECT ${selection} FROM ${view} WHERE website_id=$1::uuid`, [
    site,
  ]);
  const actual = await ch
    .query({
      query: `SELECT ${selection} FROM ${relation}`,
      query_params: params,
      format: 'JSONEachRow',
    })
    .then(r => r.json());
  const order = (v: unknown[]) => v.map(r => JSON.stringify(r)).sort();
  assert.deepEqual(order(actual), order(expected), view);
  cases.push({ name: view, rows: actual.length, status: 'pass' });
}
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${run}" TEMPLATE liekan_ch_catalog_20261103`);
  for (const file of (await readdir('db/liekan/migrations'))
    .filter(f => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) >= 57)
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
  await db.transaction(async tx => {
    await tx.query(
      "INSERT INTO website(website_id,name,domain) VALUES($1::uuid,'Isolated reporting fixture','fixture.invalid')",
      [site],
    );
    await tx.query('INSERT INTO liekan_warehouse_site(website_id,publication) VALUES($1::uuid,1)', [
      site,
    ]);
    await tx.query(
      "INSERT INTO liekan_collection_policy(website_id,allowed_hostnames) VALUES($1::uuid,ARRAY['fixture.invalid'])",
      [site],
    );
    await tx.query(
      "INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by) VALUES($1::uuid,$2::uuid,'server','fixture.invalid',$2::uuid)",
      [source, site],
    );
    await tx.query(
      "INSERT INTO liekan_log_interval(id,website_id,source_id,starts_at,ends_at) VALUES($1::uuid,$2::uuid,$3::uuid,'2026-11-03T01:00:00Z','2026-11-03T02:00:00Z')",
      [randomUUID(), site, source],
    );
    await tx.query(
      'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$3,0,0)',
      [batch, site, 'a'.repeat(64)],
    );
    await tx.query(
      "INSERT INTO liekan_history_repair_campaign(id,eligible_websites,engine_version) VALUES('traffic-quality-repair-20261022-v1',ARRAY[$1::uuid],'history-repair-v1.2')",
      [site],
    );
    await tx.query(
      `INSERT INTO liekan_history_repair_run(id,website_id,campaign_id,actor_id,status,generation,active_generation,repair_scope_id,snapshot,locale)
      VALUES($1::uuid,$2::uuid,'traffic-quality-repair-20261022-v1',$2::uuid,'completed',$3::uuid,$3::uuid,$4::uuid,'{}','zh-CN')`,
      [repair, site, generation, randomUUID()],
    );
    await tx.query(
      `INSERT INTO liekan_traffic_exclusion(id,website_id,epoch,actor_id,state,base_revision,policy_revision,rule_version,window_end,received_cutoff,membership_digest,evidence,expires_at)
      VALUES($1::uuid,$2::uuid,1,$2::uuid,'active',0,1,'fixture',now(),now(),$3,'{}',now()+interval '1 day')`,
      [excluded, site, 'b'.repeat(64)],
    );
  });
  for (const [i, sourceId, time] of [
    [0, null, '00:30'],
    [1, null, '01:30'],
    [2, source, '01:30'],
    [3, source, '02:30'],
    [4, null, '02:30'],
  ] as const) {
    await put('liekan_log', {
      id: `fixture-${i}`,
      website_id: site,
      import_id: batch,
      created_at: `2026-11-03T${time}:00Z`,
      path: `/article/${i}`,
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
      verification: 'unverified',
      source_id: sourceId,
    });
    await put('liekan_crawler_evidence', {
      website_id: site,
      log_id: `fixture-${i}`,
      classification_version: 'fixture-v1',
    });
  }
  await put('liekan_history_repair_result', {
    run_id: repair,
    website_id: site,
    generation,
    kind: 'log',
    record_id: 'fixture-4',
    before_value: {},
    after_value: {
      bot: 'RepairedBot',
      botType: '搜索',
      aiEligible: true,
      verificationVersion: null,
    },
    proof: { rulepack: 'fixture-v2', catalogVersion: null },
    created_at: at,
  });
  await compare(
    'liekan_reporting_log',
    reportingLogRelation(),
    'id,bot,bot_type,verification_version,ai_eligible,reporting_crawler_id,reporting_catalog_version,reporting_classification_version',
  );
  for (const fields of [
    ['id', 'path', 'status'],
    [
      'id',
      'bot',
      'bot_type',
      'verification_version',
      'ai_eligible',
      'reporting_crawler_id',
      'reporting_catalog_version',
      'reporting_classification_version',
    ],
    [
      'id',
      'recognition_state',
      'verification_observed_at',
      'verification_reason',
    ],
  ]) {
    await compare('liekan_reporting_log', reportingLogRelation({}, fields), fields.join(','));
  }
  // Evidence is narrowed by immutable raw log keys only. The upper boundary is
  // exclusive and the effective-source interval still selects the same rows.
  const params = {
    ...reportingParameters(await readReportingMetadata(db, site)),
    narrowStart: '2026-11-03 01:00:00.000000',
    narrowEnd: '2026-11-03 02:30:00.000000',
  };
  const narrowFields = ['id', 'bot', 'ai_eligible', 'reporting_classification_version'];
  const narrow = await ch
    .query({
      query: `SELECT ${narrowFields.join(',')} FROM ${reportingLogRelation({ immutableTimeWindow: { start: 'narrowStart', end: 'narrowEnd', endExclusive: true } }, narrowFields)}`,
      query_params: params,
      format: 'JSONEachRow',
    })
    .then(r => r.json());
  const narrowExpected = await db.read(
    `SELECT ${narrowFields.join(',')} FROM liekan_reporting_log
    WHERE website_id=$1 AND created_at>=$2::timestamptz AND created_at<$3::timestamptz`,
    [site, `${params.narrowStart}Z`, `${params.narrowEnd}Z`],
  );
  assert.equal(narrow.length, 1);
  assert.deepEqual(narrow, narrowExpected);
  cases.push({
    name: 'projected log window preserves evidence/source boundaries',
    rows: narrow.length,
    status: 'pass',
  });
  await put('session', {
    website_id: site,
    session_id: session,
    created_at: at,
    country: 'US',
    city: 'session fallback',
  });
  for (let i = 0; i < 9; i++) {
    const event = randomUUID();
    await put('website_event', {
      website_id: site,
      event_id: event,
      session_id: session,
      visit_id: visit,
      event_type: i === 1 ? 2 : 1,
      created_at: `2026-11-03T0${i}:00:00Z`,
      url_path: `/${i}`,
      hostname: 'fixture.invalid',
    });
    if (i === 6) continue;
    await put('liekan_event_quality', {
      website_id: site,
      event_id: event,
      classification:
        i === 2 ? 'unknown' : [3, 8].includes(i) ? 'automated' : i === 4 ? 'suspected' : 'browser',
      source: 'browser',
      reasons: [],
      rule_version: 'fixture-v1',
      range_status: 'missing',
      hostname: 'fixture.invalid',
      created_at: at,
    });
    await put('liekan_event_environment', {
      website_id: site,
      event_id: event,
      scope: i === 2 ? 'browser_unresolved' : 'browser',
      identity_version: 'fixture-v1',
      identity_available: i !== 2,
      browser: 'Chrome',
      origin_hostname: i === 5 ? 'wrong.invalid' : 'fixture.invalid',
      created_at: at,
    });
    if (i === 0)
      await put('liekan_event_geography', {
        website_id: site,
        event_id: event,
        country: 'CN',
        region: 'CN-11',
        city: 'Beijing',
        source: 'none',
        trust: 'unknown',
        ip_family: 'missing',
        precision: 'missing',
        reason: 'unavailable',
        country_basis: 'unknown',
        rule_version: 'fixture',
        processed_at: at,
      });
    if (i === 7)
      await put('liekan_traffic_exclusion_member', {
        website_id: site,
        collection_id: excluded,
        event_id: event,
      });
    if (i === 8)
      await put('liekan_history_repair_result', {
        run_id: repair,
        website_id: site,
        generation,
        kind: 'event',
        record_id: event,
        before_value: {},
        after_value: { classification: 'browser', reasons: [], ruleVersion: 'fixture-v2' },
        proof: {},
        created_at: at,
      });
  }
  await compare('liekan_admissible_browser_event', browserEventRelation('admissible'), 'event_id');
  await compare('liekan_observed_browser_event', browserEventRelation('observed'), 'event_id');
  await compare('liekan_effective_browser_event', browserEventRelation(), 'event_id');
  await compare(
    'liekan_geographic_website_event',
    geographicEventRelation(),
    'event_id,liekan_country,liekan_region,liekan_city,liekan_browser',
  );
  await db.transaction(tx =>
    tx.query("UPDATE liekan_collection_policy SET mode='strict' WHERE website_id=$1::uuid", [site]),
  );
  await compare('liekan_observed_browser_event', browserEventRelation('observed'), 'event_id');
  process.env.DATABASE_URL = url.toString();
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  process.env.LIEKAN_CLICKHOUSE_URL = testClickHouseURL;
  process.env.LIEKAN_CLICKHOUSE_DATABASE = run;
  delete process.env.LIEKAN_QUEUE_BROKERS;
  const { getLogFacts, getLogToday, getPlotLogs, getMonthlyAiShare } = await import(
    '../../src/lib/liekan/upstream/logs'
  );
  const start = new Date('2026-11-03T00:00:00Z'),
    end = new Date('2026-11-03T03:00:00Z');
  const logs = await getLogFacts(
    site,
    start,
    end,
    'Asia/Shanghai',
    1,
    '',
    '',
    '',
    'after',
    [
      'summary',
      'daily',
      'bots',
      'pages',
      'statuses',
      'hours',
      'recent',
      'count',
      'previousBots',
      'latest',
    ],
    { crawlerIdentityScope: 'all' },
  );
  assert.equal(logs.summary.requests, 3);
  assert.equal(logs.summary.ai, 1);
  assert.equal(logs.totalLogs, 3);
  assert.equal(logs.recent.length, 3);
  assert.equal(logs.pages.length, 1);
  assert.equal(logs.bots[0].name, 'RepairedBot');
  assert.equal((await getLogToday(site, start, end)).requests, 3);
  assert.equal(
    (await getPlotLogs(site, start, end, 'UTC')).reduce((n, r) => n + r.count, 0),
    3,
  );
  assert.equal((await getMonthlyAiShare(site, end, 'UTC')).at(-1).total, 3);
  const halfOpen = await getLogFacts(
    site,
    start,
    new Date('2026-11-03T02:30:00Z'),
    'UTC',
    1,
    '',
    '',
    '',
    'after',
    ['summary'],
    { crawlerIdentityScope: 'all', crawlerMetricsVersion: 1 },
  );
  assert.equal(halfOpen.summary.requests, 2);
  const { readBrowserPopulation } = await import(
    '../../src/lib/liekan/upstream/browser-population'
  );
  const browserEnd = new Date('2026-11-03T09:00:00Z');
  const population = await readBrowserPopulation(site, start, browserEnd, 'UTC');
  assert.equal(population.identity.status, 'partial');
  assert.equal(population.identity.eligiblePV, 3);
  assert.equal(population.identity.qualifiedPV, 2);
  const { getHumanFacts, getHumanDays } = await import('../../src/lib/liekan/upstream/analytics');
  const human = await getHumanFacts(site, start, browserEnd, 'UTC', [
    'daily',
    'geo',
    'sources',
    'environment',
    'pages',
    'heatmap',
    'goals',
    'converted',
    'journeys',
    'exits',
    'dailySources',
    'newVisitors',
    'dailyConversions',
    'previousSources',
    'previousGoals',
  ]);
  assert.equal(human.totals.pageviews, 2);
  assert.equal(human.totals.visitors, 1);
  assert.equal(human.totals.visits, 1);
  assert.equal(human.totals.bounces, 0);
  assert.equal(human.totals.totaltime, 28800);
  assert.equal(human.pages.length, 2);
  assert.equal(human.pages.find(p => p.path === '/0').duration, 28800);
  assert.equal(human.pages.find(p => p.path === '/8').duration, null);
  assert.equal(human.geo[0].country, 'CN');
  assert.equal(human.journeys[0].path, '/0 → /8');
  assert.equal(human.exits[0].path, '/8');
  assert.equal(human.newVisitors, 1);
  assert.equal((await getHumanDays(site, start, browserEnd, 'UTC'))[0].pv, 2);
  cases.push({
    name: 'product browser population and human report preserve unknown identity, complete-visit geography, dwell and custom-event bounce semantics',
    status: 'pass',
  });
  const nativeFilters = { startDate: start, endDate: browserEnd, timezone: 'UTC', unit: 'day' };
  const { getWebsiteStats } = await import('../../src/queries/sql/getWebsiteStats');
  const nativeTotals = await getWebsiteStats(site, nativeFilters);
  assert.equal(nativeTotals.pageviews, 2);
  assert.equal(nativeTotals.visitors, 1);
  assert.equal(nativeTotals.visits, 1);
  assert.equal(nativeTotals.bounces, 0);
  assert.equal(nativeTotals.totaltime, 28800);
  const { getPageviewStats } = await import('../../src/queries/sql/pageviews/getPageviewStats');
  const { getSessionStats } = await import('../../src/queries/sql/sessions/getSessionStats');
  assert.equal((await getPageviewStats(site, nativeFilters))[0].y, 2);
  assert.equal((await getSessionStats(site, nativeFilters))[0].y, 1);
  const { getWebsiteSessions } = await import('../../src/queries/sql/sessions/getWebsiteSessions');
  const sessions = await getWebsiteSessions(site, { ...nativeFilters, page: 1, pageSize: 1 });
  assert.equal(sessions.count, 1);
  assert.equal(sessions.data[0].views, 2);
  const { getWebsiteSession } = await import('../../src/queries/sql/sessions/getWebsiteSession');
  assert.equal((await getWebsiteSession(site, session)).views, 2);
  const { getWebsiteEvents } = await import('../../src/queries/sql/events/getWebsiteEvents');
  const eventsPage = await getWebsiteEvents(site, { ...nativeFilters, page: 1, pageSize: 1 });
  assert.equal(eventsPage.count, 3);
  assert.equal(eventsPage.data.length, 1);
  const { getFunnel } = await import('../../src/queries/sql/funnels/getFunnel');
  const funnel = await getFunnel(
    site,
    {
      startDate: start,
      endDate: browserEnd,
      window: 86400,
      steps: [
        { type: 'path', value: '/0' },
        { type: 'path', value: '/8' },
      ],
    },
    nativeFilters,
  );
  assert.equal(funnel[0].visitors, 1);
  assert.equal(funnel[1].visitors, 1);
  const { getWebsiteListCharts } = await import('../../src/queries/sql/getWebsiteListCharts');
  const charts = await getWebsiteListCharts([site], nativeFilters);
  assert.equal(charts[site].total, 1);
  cases.push({
    name: 'native overview, page/visitor series, profiles, events, funnels and multi-site charts use CH accepted facts with exact counts',
    status: 'pass',
  });
  for (const currentVisit of [visit, randomUUID()]) {
    await put('heatmap_event', {
      heatmap_event_id: randomUUID(),
      website_id: site,
      session_id: session,
      visit_id: currentVisit,
      url_path: '/0',
      event_type: 1,
      x: 10,
      y: 20,
      page_x: 10,
      page_y: 20,
      page_w: 1000,
      page_h: 2000,
      viewport_w: 1000,
      viewport_h: 800,
      created_at: at,
    });
    await put('session_replay', {
      replay_id: randomUUID(),
      website_id: site,
      session_id: session,
      visit_id: currentVisit,
      chunk_index: 1,
      event_count: 1,
      events: gzipSync(Buffer.from(JSON.stringify([{ type: 2, timestamp: Date.parse(at) }]))),
      started_at: at,
      ended_at: at,
      created_at: at,
    });
  }
  const { getHeatmap } = await import('../../src/queries/sql/heatmap/getHeatmap');
  const heatmap = await getHeatmap(site, {
    startDate: start,
    endDate: browserEnd,
    timezone: 'UTC',
    urlPath: '/0',
  });
  assert.equal(heatmap.pages.length, 1);
  assert.equal(heatmap.pages[0].count, 1);
  assert.equal(heatmap.pages[0].sessions, 1);
  assert.equal(heatmap.points[0].count, 1);
  assert.ok(heatmap.population);
  const { getReplayChunks } = await import('../../src/queries/sql/replays/getReplayChunks');
  const chunks = await getReplayChunks(site, visit);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startedAt.toISOString(), new Date(at).toISOString());
  assert.deepEqual(chunks[0].events, [{ type: 2, timestamp: Date.parse(at) }]);
  const { getSessionReplays } = await import('../../src/queries/sql/replays/getSessionReplays');
  const replays = await getSessionReplays(site, {
    startDate: start,
    endDate: browserEnd,
    timezone: 'UTC',
    page: 1,
    pageSize: 1,
  });
  assert.equal(replays.count, 1);
  assert.equal(replays.data.length, 1);
  assert.equal(replays.data[0].chunkCount, 1);
  assert.equal(
    (
      await getSessionReplays(site, {
        startDate: start,
        endDate: browserEnd,
        timezone: 'UTC',
        search: 'does-not-match',
      })
    ).count,
    0,
  );
  cases.push({
    name: 'product heatmap and replay use qualified complete visits and preserve compressed historical bytes',
    status: 'pass',
  });
  await (await import('../../src/lib/liekan/warehouse/reader-runtime')).warehouseReader().close();
  cases.push({
    name: 'product log queries, exact aggregates, previous window and half-open boundary work without queue configuration',
    status: 'pass',
  });
  console.log(`PASS ${cases.length} PostgreSQL / ClickHouse reporting parity cases`);
} catch (error) {
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
  console.error(error instanceof Error ? error.stack : 'Reporting parity failed');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([admin.end(), db.close(), ch.close(), chAdmin.close()]);
  await writeFile(`.local/ch-implementation/${run}.json`, JSON.stringify({ run, cases }, null, 2), {
    mode: 0o600,
  });
}
