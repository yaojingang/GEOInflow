import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { storedFact } from '../../src/lib/liekan/warehouse/candidate';
import { factTable, identifier } from '../../src/lib/liekan/warehouse/catalog';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
import { testClickHouseURL } from './warehouse-test-target';

// Own small synthetic clone only. Never writes the production download or the
// existing reporting fixture. A failed run stays available for diagnosis.
assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const files = (await readdir('.local/ch-implementation'))
  .filter(f => /^warehouse_feature_data_\d+\.json$/.test(f))
  .sort();
const source = files.at(-1)?.replace('.json', '');
assert.match(source, /^warehouse_feature_data_\d+$/);
const resume = process.env.WAREHOUSE_EVIDENCE_FIXTURE;
const run = resume ?? `warehouse_contracts_${Date.now()}`;
assert.match(run, /^warehouse_contracts_\d+$/);
const password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const connection = { host: '127.0.0.1', port: 25459, user: 'liekan_ch_proto', password };
const admin = new pg.Client({ ...connection, database: 'liekan_ch_proto' });
await admin.connect();
const url = new URL(`postgresql://127.0.0.1:25459/${run}`);
url.username = connection.user;
url.password = password;
const db = new ControlDatabase(url.toString());
const chAdmin = createWarehouseClient({ url: testClickHouseURL });
const ch = createWarehouseClient({ url: testClickHouseURL, database: run });
if (!resume) {
  await admin.query(`CREATE DATABASE ${identifier(run)} TEMPLATE ${identifier(source)}`);
  await chAdmin.command({ query: `CREATE DATABASE ${identifier(run)}` });
  const tables = await chAdmin
    .query({
      query: 'SELECT name FROM system.tables WHERE database={database:String}',
      query_params: { database: source },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ name: string }>());
  for (const { name } of tables) {
    await ch.command({
      query: `CREATE TABLE ${identifier(name)} AS ${identifier(source)}.${identifier(name)}`,
    });
    await ch.command({
      query: `INSERT INTO ${identifier(name)} SELECT * FROM ${identifier(source)}.${identifier(name)}`,
    });
  }
}
const [{ website_id: site }] = await db.read<any>(
  "SELECT website_id FROM website WHERE name='Isolated reporting fixture'",
);
const [{ user_id: owner }] = await db.read<any>(
  `SELECT user_id FROM "user" WHERE role='admin' AND username LIKE 'isolated-%' LIMIT 1`,
);
const [{ id: batch }] = await db.read<any>(
  'SELECT id FROM liekan_import WHERE website_id=$1 LIMIT 1',
  [site],
);
const session = randomUUID(),
  visit = randomUUID();
let ordinal = 20000;
async function put(family: string, fields: Record<string, unknown>, postgres = true) {
  const row = factInput(family, fields),
    cols = factTable(family).columns;
  if (postgres)
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
    format: 'JSONEachRow',
    values: [
      storedFact(family, row, {
        _website_id: site,
        _record_time:
          typeof row.created_at === 'string' ? row.created_at : '2026-11-03 03:00:00.000000',
        _session_id:
          family.startsWith('liekan_log') || family === 'liekan_crawler_evidence' ? null : session,
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
  });
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
        published_at: '2026-11-03 03:00:00.000000',
      },
    ],
  });
  return row;
}
const cases: { name: string; status: string; error?: string }[] = [];
async function check(name: string, work: () => Promise<void>) {
  if (process.env.WAREHOUSE_EVIDENCE_CASE && process.env.WAREHOUSE_EVIDENCE_CASE !== name) return;
  try {
    await work();
    cases.push({ name, status: 'pass' });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({
      name,
      status: 'failed',
      error: error instanceof Error ? error.message : 'unknown',
    });
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : 'unknown'}`);
    process.exitCode = 1;
  }
}
try {
  if (!resume) {
    await db.transaction(async tx => {
      await tx.query("UPDATE website SET created_at='2026-11-01',user_id=$2 WHERE website_id=$1", [
        site,
        owner,
      ]);
      await tx.query(
        "INSERT INTO liekan_catalog(website_id,path,title,content_type) VALUES($1,'/evidence','Synthetic evidence','article') ON CONFLICT DO NOTHING",
        [site],
      );
    });
    for (let i = 0; i < 4; i++) {
      const log = `evidence-${i}`;
      await put('liekan_log', {
        id: log,
        website_id: site,
        import_id: batch,
        created_at: `2026-11-03T03:0${i}:30Z`,
        path: '/evidence',
        method: 'GET',
        status: i === 3 ? 403 : 200,
        bytes: 120 + i,
        ip_masked: 'synthetic',
        ip_hash: 'c'.repeat(64),
        user_agent: 'SyntheticEvidenceBot',
        location: 'unknown',
        bot: i === 3 ? '其他' : 'GPTBot',
        vendor: 'OpenAI',
        bot_type: '训练',
        verification: i === 3 ? 'unverified' : 'verified_range',
        source_id: null,
        ai_eligible: i !== 3,
        recognition_state: i === 3 ? 'unknown' : 'recognized',
      });
      await put('liekan_crawler_evidence', {
        website_id: site,
        log_id: log,
        crawler_id: i === 3 ? null : 'gptbot',
        classification_version: 'fixture-v1',
        security_action: i === 3 ? 'block' : null,
        terminating_rule_id: i === 3 ? 'synthetic-rule' : null,
        matched_rule_ids: i === 3 ? ['synthetic-rule'] : [],
        cache_status: i === 0 ? 'hit' : i === 1 ? 'miss' : null,
        duration_ms: i === 2 ? 50 : null,
        measurement: {
          version: 'log-measurement-v1',
          host: 'fixture.invalid',
          hostBasis: 'request_host',
          sourceConfigVersion: 'fixture',
          sourceIntervalVersion: 'fixture',
          samplingRate: 1,
          samplingBasis: 'observed_provider_config',
          samplingTimeBasis: 'event_time',
          bytesAvailability: i === 3 ? 'missing' : 'present',
          bytesUnit: i === 2 ? 'combined_response' : 'edge_body',
        },
        edge_observation: {
          fields: {
            edgeDurationMs: {
              state: i < 2 ? 'present' : 'unknown',
              value: i < 2 ? 20 + i * 80.2 : null,
            },
            OriginResponseDurationMs: {
              state: i < 2 ? 'present' : 'unknown',
              value: i < 2 ? 10 + i * 30 : null,
            },
            OriginResponseStatus: { state: 'present', value: i < 2 ? 200 : 0 },
            EdgeResponseContentType: { state: 'present', value: 'text/html' },
            BotScore: { state: 'present', value: 10 + i },
          },
        },
      });
    }
    await put('session', {
      website_id: site,
      session_id: session,
      created_at: '2026-11-03T03:00:00Z',
      browser: 'Chrome',
    });
    for (let i = 0; i < 2; i++) {
      const event = randomUUID();
      await put('website_event', {
        website_id: site,
        event_id: event,
        session_id: session,
        visit_id: visit,
        event_type: 1,
        created_at: `2026-11-03T03:0${i}:00Z`,
        url_path: '/evidence',
        hostname: 'fixture.invalid',
      });
      await put('liekan_event_quality', {
        website_id: site,
        event_id: event,
        classification: i ? 'unknown' : 'browser',
        source: 'browser',
        reasons: [],
        rule_version: 'fixture',
        range_status: 'missing',
        hostname: 'fixture.invalid',
        created_at: `2026-11-03T03:0${i}:00Z`,
      });
      await put('liekan_event_environment', {
        website_id: site,
        event_id: event,
        scope: i ? 'browser_unresolved' : 'browser',
        identity_version: 'fixture',
        identity_available: !i,
        browser: 'Chrome',
        origin_hostname: 'fixture.invalid',
        created_at: '2026-11-03T03:00:00Z',
      });
      await put('liekan_event_observation', {
        website_id: site,
        event_id: event,
        epoch: 1,
        version: 'fixture',
        event_at: `2026-11-03T03:0${i}:00Z`,
        received_at: `2026-11-03T03:0${i}:00Z`,
        features: { accept: { state: 'present', value: 'text/html' } },
      });
    }
  }
  process.env.DATABASE_URL = url.toString();
  process.env.LIEKAN_CLICKHOUSE_URL = testClickHouseURL;
  process.env.LIEKAN_CLICKHOUSE_DATABASE = run;
  process.env.LIEKAN_EXPORT_DIRECTORY = `.local/ch-final-review/exports-${run}`;
  delete process.env.CLICKHOUSE_URL;
  delete process.env.LIEKAN_WAREHOUSE_TRANSITION;
  delete process.env.LIEKAN_QUEUE_BROKERS;
  const { withoutQueryCache } = await import('../../src/lib/liekan/upstream/cache-context');
  const { queryEvidence, parseEvidenceQuery, readCrawlerEvidence, readReconciliation } =
    await import('../../src/lib/liekan/crawlers/evidence-read');
  const { readPerformance } = await import('../../src/lib/liekan/crawlers/performance-read');
  const { readOutcomes } = await import('../../src/lib/liekan/crawlers/outcomes-read');
  const { readObservations, parseObservationQuery } = await import(
    '../../src/lib/liekan/crawlers/observation-read'
  );
  const { readReportEvidence } = await import('../../src/lib/liekan/crawlers/report-evidence');
  const { collectionPresence } = await import('../../src/lib/liekan/upstream/collection-presence');
  const { warehouseInstallationLogs } = await import(
    '../../src/lib/liekan/upstream/warehouse-presence'
  );
  const actor = { id: owner, role: 'admin' },
    startAt = +new Date('2026-11-03T00:00:00Z'),
    endAt = +new Date('2026-11-03T08:00:00Z');
  const normalize = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (key, v) =>
        [
          'readAt',
          'snapshot',
          'policySnapshot',
          'warehouse',
          'sectionPages',
          'sectionTotals',
        ].includes(key)
          ? undefined
          : typeof v === 'string' && /^-?\d+\.\d+$/.test(v)
            ? String(Number(v))
            : v,
      ),
    );
  async function parity(name: string, p: any, reader: any, kind: string) {
    await check(name, async () => {
      process.env.LIEKAN_ANALYTICS_BACKEND = 'postgresql';
      const expected = await withoutQueryCache(() =>
        queryEvidence(actor, site, p, kind, reader, true),
      );
      process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
      const actual = await withoutQueryCache(() =>
        queryEvidence(actor, site, p, kind, reader, true),
      );
      const align = (a: any, b: any, path = '') => {
        if (a && b && typeof a === 'object' && typeof b === 'object')
          for (const key of Object.keys(a)) {
            const next = path + '.' + key;
            if (
              typeof a[key] === 'number' &&
              typeof b[key] === 'number' &&
              /(?:edge|origin)P(?:50|95)/.test(next)
            ) {
              assert.ok(Math.abs(a[key] - b[key]) <= Math.max(1, Math.abs(b[key])) * 1e-12, next);
              a[key] = b[key];
            } else align(a[key], b[key], next);
          }
      };
      align(actual, expected);
      assert.deepEqual(normalize(actual), normalize(expected));
    });
  }
  const base = {
    startAt,
    endAt,
    timezone: 'UTC',
    sourceId: 'manual',
    population: 'all_logs',
    crawlerIdentityScope: 'all',
  };
  for (const view of ['summary', 'requests', 'matrix'])
    await parity(
      `evidence-${view}`,
      parseEvidenceQuery({ ...base, view }),
      readCrawlerEvidence,
      'evidence',
    );
  await parity('performance-nonempty', parseEvidenceQuery(base), readPerformance, 'performance');
  await parity('outcomes-nonempty', parseEvidenceQuery(base), readOutcomes, 'outcomes');
  await parity(
    'reconciliation-nonempty',
    parseEvidenceQuery(
      { startAt, endAt, timezone: 'UTC', sourceId: 'manual', hostname: 'fixture.invalid' },
      true,
    ),
    readReconciliation,
    'reconciliation',
  );
  for (const subset of ['raw', 'eligible'])
    await parity(
      `observations-${subset}`,
      parseObservationQuery({ startAt, endAt, timezone: 'UTC', subset }),
      readObservations,
      'observations',
    );
  await parity(
    'report-evidence',
    parseEvidenceQuery({ ...base, sourceId: undefined, reportResource: 'logs', view: 'requests' }),
    readReportEvidence,
    'report-evidence',
  );
  for (const resource of ['ai/pages', 'ai/bots'] as const) {
    await parity(
      'report-evidence-' + resource.replace('/', '-'),
      parseEvidenceQuery({ ...base, sourceId: undefined, reportResource: resource }),
      readReportEvidence,
      'report-evidence',
    );
    await parity(
      'report-display-' + resource.replace('/', '-'),
      parseEvidenceQuery({
        ...base,
        sourceId: undefined,
        reportResource: resource,
        reportDisplay: {
          filter: '全部',
          sort: { label: resource === 'ai/pages' ? '抓取次数' : '所选期间抓取', direction: -1 },
          search: resource === 'ai/pages' ? 'evidence' : 'GPT',
        },
      }),
      readReportEvidence,
      'report-evidence',
    );
  }
  await check('raw-browser-presence', async () => {
    process.env.LIEKAN_ANALYTICS_BACKEND = 'postgresql';
    const expected = await collectionPresence(site);
    process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
    assert.deepEqual(await collectionPresence(site), expected);
    assert.ok(expected.pageviews > 0);
  });
  await check('installation-log-presence', async () => {
    const [expected] = await db.read<any>(
      'SELECT count(*)::float8 AS total,max(created_at) AS latest FROM liekan_reporting_log WHERE website_id=$1',
      [site],
    );
    const actual = await warehouseInstallationLogs(site);
    assert.equal(actual.total, expected.total);
    assert.equal(+actual.latestAt, +expected.latest);
  });
  await check('historical-impact', async () => {
    const { warehouseHistoricalImpact } = await import(
      '../../src/lib/liekan/upstream/warehouse-evidence-queries'
    );
    const result = await warehouseHistoricalImpact(site, {
      botIds: ['gptbot'],
      paths: [{ value: '/evidence', match: 'prefix' }],
    });
    assert.equal(result.requests, 3);
    assert.ok(result.observedRequests >= 4);
  });
  await check('evidence-csv-and-report-comparison', async () => {
    process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
    process.env.APP_SECRET = 'isolated-contracts-' + run;
    const { createSecureToken } = await import('../../src/lib/jwt');
    const { secret } = await import('../../src/lib/crypto');
    const token = createSecureToken({ userId: owner }, secret(), { expiresIn: 300 });
    const { exportEvidence } = await import('../../src/lib/liekan/crawlers/evidence-export');
    for (const kind of ['evidence', 'observations', 'performance'] as const) {
      const conditions =
        kind === 'observations'
          ? parseObservationQuery({ startAt, endAt, timezone: 'UTC', subset: 'raw' })
          : parseEvidenceQuery({
              ...base,
              ...(kind === 'evidence'
                ? { sourceId: undefined, reportResource: 'logs', view: 'requests' }
                : {}),
            });
      const reader =
        kind === 'observations'
          ? readObservations
          : kind === 'performance'
            ? readPerformance
            : readReportEvidence;
      const result = await queryEvidence(
        actor,
        site,
        conditions,
        kind === 'evidence' ? 'report-evidence' : kind,
        reader,
        true,
      );
      const request = new Request(
        `http://127.0.0.1/api/liekan/websites/${site}/traffic-quality/export-evidence`,
        { method: 'POST', headers: { authorization: `Bearer ${token}` } },
      );
      const response = await exportEvidence(
        actor,
        site,
        {
          kind,
          query: kind === 'performance' ? base : conditions,
          locale: 'en-US',
          policySnapshot: result.meta.policySnapshot,
          ...(kind === 'evidence'
            ? {
                viewReportQuery: {
                  resource: 'logs',
                  startAt,
                  endAt,
                  timezone: 'UTC',
                  crawlerMetricsVersion: 1,
                  crawlerIdentityScope: 'all',
                  filter: '',
                  search: '',
                },
              }
            : {}),
        },
        request,
        [kind],
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Type'), /text\/csv/);
      assert.match(await response.text(), /Export metadata/);
    }
  });
  await check('CH-only-new-input-does-not-read-PG-facts', async () => {
    process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
    const beforeBrowser = await collectionPresence(site),
      beforeLogs = await warehouseInstallationLogs(site);
    const [{ session_id: existingSession, visit_id: existingVisit }] = await db.read<any>(
      "SELECT session_id,visit_id FROM website_event WHERE website_id=$1 AND url_path='/evidence' LIMIT 1",
      [site],
    );
    const log = 'ch-only-' + randomUUID(),
      event = randomUUID(),
      path = '/ch-only-' + event;
    await put(
      'liekan_log',
      {
        id: log,
        website_id: site,
        import_id: batch,
        created_at: '2026-11-03T03:05:00Z',
        path,
        method: 'GET',
        status: 200,
        bytes: 1,
        ip_masked: 'synthetic',
        ip_hash: 'd'.repeat(64),
        user_agent: 'SyntheticCHOnly',
        location: 'unknown',
        bot: 'GPTBot',
        vendor: 'OpenAI',
        bot_type: '训练',
        verification: 'verified_range',
        source_id: null,
        ai_eligible: true,
        recognition_state: 'recognized',
      },
      false,
    );
    await put(
      'liekan_crawler_evidence',
      { website_id: site, log_id: log, crawler_id: 'gptbot', classification_version: 'fixture-v1' },
      false,
    );
    await put(
      'website_event',
      {
        website_id: site,
        event_id: event,
        session_id: existingSession,
        visit_id: existingVisit,
        event_type: 1,
        created_at: '2026-11-03T03:05:00Z',
        url_path: path,
        hostname: 'fixture.invalid',
      },
      false,
    );
    await put(
      'liekan_event_quality',
      {
        website_id: site,
        event_id: event,
        classification: 'automated',
        source: 'browser',
        reasons: [],
        rule_version: 'fixture',
        range_status: 'missing',
        hostname: 'fixture.invalid',
        created_at: '2026-11-03T03:05:00Z',
      },
      false,
    );
    const actual = await queryEvidence(
      actor,
      site,
      parseEvidenceQuery({ ...base, path, view: 'requests' }),
      'evidence',
      readCrawlerEvidence,
      true,
    );
    assert.equal(actual.rows.length, 1);
    assert.equal(actual.rows[0].id, log);
    assert.equal(
      (await collectionPresence(site)).pageviews,
      beforeBrowser.pageviews + 1,
      'raw presence includes disqualified browser input',
    );
    assert.equal((await warehouseInstallationLogs(site)).total, beforeLogs.total + 1);
    const [pgFacts] = await db.read<any>(
      'SELECT (SELECT count(*) FROM website_event WHERE event_id=$1) AS events,(SELECT count(*) FROM liekan_log WHERE id=$2) AS logs',
      [event, log],
    );
    assert.equal(Number(pgFacts.events), 0);
    assert.equal(Number(pgFacts.logs), 0);
  });
  await check('local-policy-preview-uses-CH-only-history', async () => {
    await db.transaction(tx =>
      tx.query(
        'INSERT INTO liekan_crawler_instance(singleton) VALUES(true) ON CONFLICT DO NOTHING',
      ),
    );
    const { createCrawlerPolicy } = await import('../../src/lib/liekan/crawler-control/service');
    const { previewCrawlerPolicy } = await import(
      '../../src/lib/liekan/crawler-control/deployments'
    );
    const path = '/preview-' + randomUUID(),
      log = 'preview-' + randomUUID();
    await put(
      'liekan_log',
      {
        id: log,
        website_id: site,
        import_id: batch,
        created_at: '2026-11-03T03:06:00Z',
        path,
        method: 'GET',
        status: 200,
        bytes: 1,
        ip_masked: 'synthetic',
        ip_hash: 'e'.repeat(64),
        user_agent: 'SyntheticCHPreview',
        location: 'unknown',
        bot: 'GPTBot',
        vendor: 'OpenAI',
        bot_type: '训练',
        verification: 'verified_range',
        source_id: null,
        ai_eligible: true,
        recognition_state: 'recognized',
      },
      false,
    );
    await put(
      'liekan_crawler_evidence',
      { website_id: site, log_id: log, crawler_id: 'gptbot', classification_version: 'fixture-v1' },
      false,
    );
    process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
    const policy = await createCrawlerPolicy(actor, site, {
      name: 'Isolated CH impact',
      botIds: ['gptbot'],
      paths: [{ value: path, match: 'exact' }],
      action: 'observe',
      expectedAccess: 'allow',
    });
    const preview = await previewCrawlerPolicy(actor, site, policy.id, { operation: 'deploy' });
    assert.equal(preview.localOnly, true);
    assert.equal(preview.impact.historicalRequests7d.requests, 1);
  });
  await check('server-heartbeat-CH-coverage-and-fences', async () => {
    process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
    const { heartbeat, validateSource } = await import(
      '../../src/lib/liekan/log-ingestion/service'
    );
    const { recordCrawlerCoverage } = await import(
      '../../src/lib/liekan/log-ingestion/crawler-quality'
    );
    const { prepareWarehouseCrawlerCoverage } = await import(
      '../../src/lib/liekan/upstream/warehouse-crawler-coverage'
    );
    const { getSettings } = await import('../../src/lib/liekan/store');
    const { transaction } = await import('../../src/lib/liekan/upstream/server');
    const { tokenHash } = await import('../../src/lib/liekan/log-ingestion/secrets');
    const { crawlerClassificationVersion } = await import(
      '../../src/lib/liekan/log-ingestion/crawler-evidence'
    );
    const sourceId = randomUUID(),
      firstBatch = randomUUID(),
      lastBatch = randomUUID(),
      token = randomUUID();
    const startsAt = +new Date('2026-11-03T04:00:00Z'),
      endsAt = startsAt + 3600000;
    await db.transaction(tx =>
      tx.query('INSERT INTO liekan_log_state(website_id) VALUES($1) ON CONFLICT DO NOTHING', [
        site,
      ]),
    );
    const [{ epoch }] = await db.read<any>(
      'SELECT epoch FROM liekan_log_state WHERE website_id=$1',
      [site],
    );
    await db.transaction(async tx => {
      await tx.query(
        `INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by,owner_id,state,credential_hash)
        SELECT $1,$2,'server',domain,user_id,user_id,'active',$3 FROM website WHERE website_id=$2`,
        [sourceId, site, tokenHash(token)],
      );
      await tx.query(
        'INSERT INTO liekan_log_interval(id,website_id,source_id,starts_at) VALUES($1,$2,$3,$4)',
        [randomUUID(), site, sourceId, new Date(startsAt - 1000)],
      );
      for (const id of [firstBatch, lastBatch]) {
        await tx.query(
          `INSERT INTO liekan_import(id,website_id,digest,accepted,rejected,kind,source_id,inserted)
          VALUES($1,$2,$3,1,0,'automatic',$4,1)`,
          [id, site, id.replaceAll('-', '').padEnd(64, '0'), sourceId],
        );
        await tx.query(
          `INSERT INTO liekan_ingest_batch(id,website_id,source_id,epoch,digest,received,valid,rejected,state)
          VALUES($1,$2,$3,$4,$5,1,1,0,'processed')`,
          [id, site, sourceId, epoch, id.replaceAll('-', '').padEnd(64, '0')],
        );
      }
    });
    const settings = await getSettings(site),
      version = crawlerClassificationVersion(settings.rules, settings.crawlerRules);
    const log = async (id: string, importId: string, time: number, classification = version) => {
      await put(
        'liekan_log',
        {
          id,
          website_id: site,
          import_id: importId,
          created_at: new Date(time).toISOString(),
          path: '/server-coverage',
          method: 'GET',
          status: 200,
          bytes: 1,
          ip_masked: 'synthetic',
          ip_hash: 'f'.repeat(64),
          user_agent: 'SyntheticCoverage',
          location: 'unknown',
          bot: 'GPTBot',
          vendor: 'OpenAI',
          bot_type: '训练',
          verification: 'verified_range',
          source_id: sourceId,
          ai_eligible: true,
          recognition_state: 'recognized',
        },
        false,
      );
      await put(
        'liekan_crawler_evidence',
        {
          website_id: site,
          log_id: id,
          crawler_id: 'gptbot',
          classification_version: classification,
        },
        false,
      );
    };
    await log('coverage-' + randomUUID(), firstBatch, startsAt);
    await log('coverage-' + randomUUID(), lastBatch, endsAt);
    const proof = {
      epoch,
      startsAt,
      endsAt,
      fromBatchId: firstBatch,
      toBatchId: lastBatch,
      cursors: [{ generation: randomUUID(), confirmed: 100, read: 100 }],
    };
    const health = {
      version: 'synthetic-test',
      pending: 0,
      bytes: 0,
      gap: false,
      errorCode: 'none' as const,
      coverage: proof,
    };
    const recorded = () =>
      db.read<any>(
        'SELECT state,evidence FROM liekan_crawler_quality WHERE source_id=$1 ORDER BY starts_at',
        [sourceId],
      );
    const clear = () =>
      db.transaction(tx =>
        tx.query('DELETE FROM liekan_crawler_quality WHERE source_id=$1', [sourceId]),
      );
    assert.equal((await heartbeat(sourceId, token, health)).state, 'active');
    assert.equal(
      (await recorded())[0]?.state,
      'complete',
      'CH-only nonempty batch proves observed coverage',
    );
    assert.equal(
      Number(
        (
          await db.read<any>('SELECT count(*) AS n FROM liekan_log WHERE source_id=$1', [sourceId])
        )[0].n,
      ),
      0,
    );
    await clear();
    await db.transaction(tx =>
      tx.query("UPDATE liekan_ingest_batch SET state='pending' WHERE id=$1", [lastBatch]),
    );
    await heartbeat(sourceId, token, health);
    assert.equal((await recorded()).length, 0, 'pending batches cannot establish proof');
    await db.transaction(tx =>
      tx.query("UPDATE liekan_ingest_batch SET state='processed' WHERE id=$1", [lastBatch]),
    );
    await heartbeat(sourceId, token, { ...health, coverage: { ...proof, startsAt: startsAt - 1 } });
    assert.equal(
      (await recorded()).length,
      0,
      'collector cannot claim time outside accepted event bounds',
    );
    const prepared = await prepareWarehouseCrawlerCoverage(site, sourceId, epoch, proof, version);
    await db.transaction(tx =>
      tx.query('UPDATE liekan_warehouse_site SET publication=publication+1 WHERE website_id=$1', [
        site,
      ]),
    );
    await transaction(async tx => {
      const live = await validateSource(tx, sourceId, token, true);
      await recordCrawlerCoverage(
        tx,
        live.source,
        live.epoch,
        health,
        settings.rules,
        Date.now(),
        settings.crawlerRules,
        prepared,
      );
    });
    assert.equal((await recorded()).length, 0, 'a publication change fences precomputed coverage');
    await heartbeat(sourceId, token, health);
    assert.equal((await recorded())[0]?.state, 'complete');
    const late = 'coverage-late-' + randomUUID();
    await log(late, lastBatch, startsAt + 1000, 'outdated-classification');
    const stale = await prepareWarehouseCrawlerCoverage(site, sourceId, epoch, proof, version);
    assert.equal(
      stale.changed,
      true,
      'late historical input is rechecked even after complete proof',
    );
    await clear();
    await heartbeat(sourceId, token, health);
    assert.equal((await recorded()).length, 0, 'unclassified late data cannot establish proof');
    await put(
      'liekan_crawler_evidence',
      { website_id: site, log_id: late, crawler_id: 'gptbot', classification_version: version },
      false,
    );
    await heartbeat(sourceId, token, health);
    assert.equal(
      (await recorded())[0]?.state,
      'complete',
      'accepted classification repair permits a fresh proof',
    );
    await clear();
    await ch.command({
      query: 'RENAME TABLE warehouse_liekan_log TO warehouse_liekan_log_offline',
    });
    try {
      assert.equal(
        (await heartbeat(sourceId, token, health)).state,
        'active',
        'CH failure does not break collector heartbeat',
      );
      assert.equal((await recorded()).length, 0);
    } finally {
      await ch.command({
        query: 'RENAME TABLE warehouse_liekan_log_offline TO warehouse_liekan_log',
      });
    }
    await heartbeat(sourceId, token, health);
    const gap = await heartbeat(sourceId, token, {
      ...health,
      gap: true,
      errorCode: 'rotation-gap',
    });
    assert.equal(gap.coverageGapRecorded, true);
    assert.equal(
      (await recorded()).at(-1)?.state,
      'partial',
      'reported gap is recorded without CH proof',
    );
  });
  await check('rendered-report-export-comparison', async () => {
    process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
    process.env.APP_SECRET = 'isolated-comparison-' + run;
    const { createSecureToken } = await import('../../src/lib/jwt');
    const { secret } = await import('../../src/lib/crypto');
    const { createHash } = await import('node:crypto');
    const { buildReport } = await import('../../src/lib/liekan/report');
    const { attachReportEvidenceView } = await import(
      '../../src/lib/liekan/upstream/report-evidence-view'
    );
    const { reportEvidenceViewPayload } = await import(
      '../../src/lib/liekan/contracts/report-evidence-view'
    );
    const { parseReportQuery } = await import('../../src/lib/liekan/contracts/query');
    const { withinWarehouseReport } = await import(
      '../../src/lib/liekan/upstream/warehouse-report-snapshot'
    );
    const { exportEvidence } = await import('../../src/lib/liekan/crawlers/evidence-export');
    const [website] = await db.read<any>(
      'SELECT website_id AS id,name,domain FROM website WHERE website_id=$1',
      [site],
    );
    const token = createSecureToken({ userId: owner }, secret(), { expiresIn: 900 });
    const { withPublishedRegistry } = await import(
      '../../src/lib/liekan/upstream/crawler-registry-context'
    );
    for (const vendor of ['Vendor Z', 'Vendor A']) {
      const id = 'render-tie-' + randomUUID();
      await put('liekan_log', {
        id,
        website_id: site,
        import_id: batch,
        created_at: '2026-11-03T03:05:00Z',
        path: '/evidence',
        method: 'GET',
        status: 200,
        bytes: 1,
        ip_masked: 'synthetic',
        ip_hash: '4'.repeat(64),
        user_agent: 'SyntheticComparison',
        location: 'unknown',
        bot: 'GPTBot',
        vendor,
        bot_type: '训练',
        verification: 'verified_range',
        source_id: null,
        ai_eligible: true,
        recognition_state: 'recognized',
      });
      await put('liekan_crawler_evidence', {
        website_id: site,
        log_id: id,
        classification_version: 'fixture',
        crawler_id: 'gptbot',
      });
    }
    for (const resource of ['ai/pages', 'ai/bots'] as const) {
      const raw = {
        resource,
        startAt,
        endAt,
        timezone: 'UTC',
        crawlerMetricsVersion: 1,
        crawlerIdentityScope: 'all',
        filter: '',
        search: '',
      };
      const parsed = parseReportQuery(raw);
      assert.equal(parsed.success, true);
      if (!parsed.success) throw new Error('fixture-query');
      for (const display of [
        { filter: '全部', sort: { label: '', direction: 1 }, search: '' },
        {
          filter: '全部',
          sort: { label: resource === 'ai/pages' ? '抓取次数' : '所选期间抓取', direction: -1 },
          search: resource === 'ai/pages' ? 'evidence' : 'GPT',
        },
      ]) {
        const digest = await withPublishedRegistry(() =>
          withinWarehouseReport(async () => {
            const page = await attachReportEvidenceView(
              await buildReport(website, false, raw, true, false),
              parsed.data,
            );
            return createHash('sha256')
              .update(reportEvidenceViewPayload(page, display))
              .digest('hex');
          }),
        );
        const conditions = parseEvidenceQuery({
          ...base,
          sourceId: undefined,
          reportResource: resource,
          reportDisplay: display,
        });
        const result = await queryEvidence(
          actor,
          site,
          conditions,
          'report-evidence',
          readReportEvidence,
          true,
        );
        const response = await exportEvidence(
          actor,
          site,
          {
            kind: 'evidence',
            query: conditions,
            locale: 'en-US',
            policySnapshot: result.meta.policySnapshot,
            viewSnapshot: digest,
            viewReportQuery: raw,
          },
          new Request('http://localhost/evidence', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + token },
          }),
          ['evidence'],
        );
        assert.equal(
          response.headers.get('X-Liekan-Export-Changed'),
          'false',
          resource + ' rendered ' + JSON.stringify(display),
        );
        await response.text();
      }
    }
  });
  await check('outcome-referrals-authority', async () => {
    const { verifyOutcomeReferralAuthority } = await import(
      './warehouse-outcome-referrals.fixture'
    );
    await verifyOutcomeReferralAuthority({ db, put, site, owner });
  });
  await check('evidence-content-snapshot', async () => {
    const { verifyEvidenceSnapshot } = await import('./warehouse-evidence-snapshot.fixture');
    await verifyEvidenceSnapshot({ db, ch, site, batch, owner });
  });
  await check('reconciliation-mapping-snapshot', async () => {
    process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
    const { withinWarehouseReport } = await import(
      '../../src/lib/liekan/upstream/warehouse-report-snapshot'
    );
    const { withWarehouseEvidenceResources } = await import(
      '../../src/lib/liekan/upstream/warehouse-evidence-table'
    );
    const { warehouseReconciliationFacts } = await import(
      '../../src/lib/liekan/upstream/warehouse-evidence-queries'
    );
    const { evidenceInputs } = await import('../../src/lib/liekan/crawlers/evidence-read');
    const { crawlerTransaction } = await import('../../src/lib/liekan/upstream/crawler-access');
    const p = parseEvidenceQuery(
      {
        startAt: +new Date('2026-11-03T03:00:00Z'),
        endAt: +new Date('2026-11-03T03:05:00Z'),
        timezone: 'UTC',
        sourceId: 'manual',
        hostname: 'fixture.invalid',
      },
      true,
    );
    await withWarehouseEvidenceResources(() =>
      withinWarehouseReport(async () => {
        const input = await crawlerTransaction(tx => evidenceInputs(tx, actor, site, p));
        const read = (state: 'partial' | 'complete') =>
          warehouseReconciliationFacts(
            site,
            p as any,
            'fixture.invalid',
            {
              ...input,
              measurement: {
                requests: 4,
                versions: 1,
                samples: 4,
                intervals: 1,
                interval: 'fixture',
                intervalSamples: 4,
              },
              quality: { ...input.quality, state, sourceVersion: 'fixture' },
            },
            false,
          );
        const a = await read('partial'),
          b = await read('complete');
        const first = (await a.table.page(0, 20)).find(row => row.humanPath === '/evidence');
        const changed = (await b.table.page(0, 20)).find(row => row.humanPath === '/evidence');
        assert.equal(first.difference.reasonCode, 'source_coverage');
        assert.equal(changed.difference.state, 'available');
        assert.notEqual(await a.table.fingerprint(), await b.table.fingerprint());
      }),
    );
  });
  if (process.env.WAREHOUSE_REALTIME_EVIDENCE === '1')
    await check('warehouse-realtime-identity', async () => {
      const { verifyWarehouseRealtime } = await import('./warehouse-realtime.fixture');
      await verifyWarehouseRealtime({ site, put });
    });
  if (process.env.WAREHOUSE_BROWSER_PAGE_EVIDENCE === '1')
    await check('warehouse-browser-page-report', async () => {
      const { verifyWarehouseBrowserPages } = await import(
        './warehouse-browser-page-parity.fixture'
      );
      await verifyWarehouseBrowserPages({ db, ch, site, run, put });
    });
  if (process.env.WAREHOUSE_AI_PAGE_EVIDENCE === '1')
    await check('warehouse-ai-page-report', async () => {
      const { verifyWarehouseAiPages } = await import('./warehouse-ai-page-report.fixture');
      await verifyWarehouseAiPages({ db, site, batch, put, run });
    });
  if (process.env.WAREHOUSE_KEYWORDS_EVIDENCE === '1')
    await check('warehouse-keywords-complete-evidence', async () => {
      const { verifyWarehouseKeywords } = await import('./warehouse-keywords.fixture');
      await verifyWarehouseKeywords({ db, ch, site, owner, run, put });
    });
  if (process.env.WAREHOUSE_PERFORMANCE_EVIDENCE_LARGE === '1')
    await check('large-performance-evidence', async () => {
      const { verifyLargePerformanceEvidence } = await import(
        './warehouse-evidence-performance-large.fixture'
      );
      await verifyLargePerformanceEvidence({ db, ch, site, batch, owner, run });
    });
  if (process.env.WAREHOUSE_CATALOG_EVIDENCE_LARGE === '1')
    await check('large-catalog-evidence', async () => {
      const { verifyLargeEvidenceCatalog } = await import('./warehouse-evidence-catalog.fixture');
      await verifyLargeEvidenceCatalog({ db, site, owner, run });
    });
  if (process.env.WAREHOUSE_REPORT_EVIDENCE_LARGE === '1')
    await check('large-report-evidence-pagination-csv', async () => {
      const { runLargeReportEvidence } = await import('./warehouse-report-evidence-large');
      await runLargeReportEvidence({ db, ch, site, batch, owner, run });
    });
  if (process.env.WAREHOUSE_EVIDENCE_LARGE === '1')
    await check('large-evidence-pagination-csv', async () => {
      process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
      process.env.APP_SECRET = 'isolated-contracts-' + run;
      const { createSecureToken } = await import('../../src/lib/jwt');
      const { secret } = await import('../../src/lib/crypto');
      const { exportEvidence } = await import('../../src/lib/liekan/crawlers/evidence-export');
      const { withinWarehouseReport, warehouseReportMetadata } = await import(
        '../../src/lib/liekan/upstream/warehouse-report-snapshot'
      );
      const { warehouseEvidenceRows } = await import(
        '../../src/lib/liekan/upstream/warehouse-evidence-table'
      );
      const { warehouseCrawlerEvidence } = await import(
        '../../src/lib/liekan/upstream/warehouse-evidence-queries'
      );
      const { evidenceInputs } = await import('../../src/lib/liekan/crawlers/evidence-read');
      const { crawlerTransaction } = await import('../../src/lib/liekan/upstream/crawler-access');
      const token = createSecureToken({ userId: owner }, secret(), { expiresIn: 900 });
      const prefix = 'bulk-' + randomUUID(),
        total = 100005,
        attempt = randomUUID(),
        candidate = randomUUID();
      const [{ epoch, publication }] = await db.read<any>(
        'SELECT epoch::text,publication::text FROM liekan_warehouse_site WHERE website_id=$1',
        [site],
      );
      const version = String(BigInt(publication) + 1n);
      let template: any;
      for (let start = 0; start < total; start += 1000) {
        const values = Array.from({ length: Math.min(1000, total - start) }, (_, offset) => {
          const i = start + offset,
            id = prefix + '-' + String(i).padStart(6, '0');
          const row = factInput('liekan_log', {
            id,
            website_id: site,
            import_id: batch,
            created_at: '2026-11-03T02:00:00Z',
            path: '/' + prefix + '/' + String(i).padStart(6, '0') + '-' + 'x'.repeat(600),
            method: 'GET',
            status: 200,
            bytes: 1,
            ip_masked: 'synthetic',
            ip_hash: '9'.repeat(64),
            user_agent: 'SyntheticLargeEvidence',
            location: 'unknown',
            bot: 'GPTBot',
            vendor: 'OpenAI',
            bot_type: '训练',
            verification: 'verified_range',
            source_id: null,
            ai_eligible: true,
            recognition_state: 'recognized',
          });
          return storedFact('liekan_log', row, {
            _website_id: site,
            _record_time: '2026-11-03 02:00:00.000000',
            _session_id: null,
            _epoch: epoch,
            _version: version,
            _ordinal: i,
            _attempt_id: attempt,
            _candidate_id: candidate,
            _topic_id: 'fixture-large',
            _partition: 0,
            _offset: String(i),
            _deleted: false,
          });
        });
        await ch.insert({ table: 'warehouse_liekan_log', format: 'JSONEachRow', values });
        template = values[0];
      }
      await ch.insert({
        table: 'warehouse_publication',
        format: 'JSONEachRow',
        values: [
          {
            website_id: site,
            epoch,
            publication: version,
            attempt_id: attempt,
            family: 'liekan_log',
            candidate_id: candidate,
            row_count: total,
            digest: 'a'.repeat(64),
            published_at: '2026-11-03 03:00:00.000000',
          },
        ],
      });
      await db.transaction(tx =>
        tx.query('UPDATE liekan_warehouse_site SET publication=$2 WHERE website_id=$1', [
          site,
          version,
        ]),
      );
      const conditions = parseEvidenceQuery({
        ...base,
        view: 'requests',
        search: prefix,
        sort: 'path',
        direction: 'asc',
      });
      const first = await queryEvidence(
        actor,
        site,
        conditions,
        'evidence',
        readCrawlerEvidence,
        true,
      );
      assert.equal(first.meta.total, total);
      assert.equal(first.rows.length, 20);
      assert.equal(first.rows[0].id, prefix + '-000000');
      const second = await queryEvidence(
        actor,
        site,
        { ...conditions, page: 2, snapshot: first.meta.snapshot },
        'evidence',
        readCrawlerEvidence,
        true,
      );
      assert.equal(second.meta.snapshot, first.meta.snapshot);
      assert.equal(second.meta.reset, false);
      assert.equal(second.rows[0].id, prefix + '-000020');
      const last = await queryEvidence(
        actor,
        site,
        { ...conditions, page: 5001, snapshot: first.meta.snapshot },
        'evidence',
        readCrawlerEvidence,
        true,
      );
      assert.equal(last.rows.length, 5);
      assert.equal(last.rows.at(-1).id, prefix + '-100004');
      const summary = await queryEvidence(
        actor,
        site,
        parseEvidenceQuery({ ...conditions, view: 'summary', dimension: 'path' }),
        'evidence',
        readCrawlerEvidence,
        true,
      );
      assert.equal(summary.meta.total, total);
      assert.equal(summary.rows.length, 20);
      assert.equal(summary.rows[0].requests, 1);
      const request = new Request(
        `http://127.0.0.1/api/liekan/websites/${site}/traffic-quality/export-evidence`,
        { method: 'POST', headers: { authorization: `Bearer ${token}` } },
      );
      const response = await exportEvidence(
        actor,
        site,
        {
          kind: 'evidence',
          query: conditions,
          locale: 'en-US',
          policySnapshot: first.meta.policySnapshot,
          viewSnapshot: first.meta.snapshot,
        },
        request,
        ['evidence'],
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Type'), /text\/csv/);
      let bytes = 0,
        countRows = 0,
        tail = '',
        maxChunk = 0;
      for await (const chunk of response.body as any) {
        bytes += chunk.length;
        maxChunk = Math.max(maxChunk, chunk.length);
        const text = tail + Buffer.from(chunk).toString('utf8'),
          lines = text.split('\r\n');
        tail = lines.pop();
        countRows += lines.filter(line => line.startsWith('"rows","' + prefix)).length;
      }
      assert.equal(countRows, total);
      assert.ok(bytes > 50 * 1024 * 1024);
      assert.ok(maxChunk < 2 * 1024 * 1024);
      // A descriptor created at an accepted boundary must keep that same boundary
      // when a new publication appears before its complete export stream starts.
      await withinWarehouseReport(async () => {
        const pinned = await warehouseReportMetadata(site);
        const input = await crawlerTransaction(tx => evidenceInputs(tx, actor, site, conditions));
        const result = await warehouseCrawlerEvidence(null, site, conditions as any, input);
        const table = result[warehouseEvidenceRows];
        const next = String(BigInt(pinned.boundary.publication) + 1n),
          nextAttempt = randomUUID(),
          nextCandidate = randomUUID();
        const row = storedFact(
          'liekan_log',
          factInput('liekan_log', { ...template, id: prefix + '-new-publication' }),
          {
            _website_id: site,
            _epoch: epoch,
            _record_time: template._record_time,
            _session_id: null,
            _topic_id: 'fixture-large',
            _partition: 0,
            _offset: String(total),
            _deleted: false,
            _version: next,
            _attempt_id: nextAttempt,
            _candidate_id: nextCandidate,
            _ordinal: 0,
          },
        );
        await ch.insert({ table: 'warehouse_liekan_log', format: 'JSONEachRow', values: [row] });
        await ch.insert({
          table: 'warehouse_publication',
          format: 'JSONEachRow',
          values: [
            {
              website_id: site,
              epoch,
              publication: next,
              attempt_id: nextAttempt,
              family: 'liekan_log',
              candidate_id: nextCandidate,
              row_count: 1,
              digest: 'a'.repeat(64),
              published_at: '2026-11-03 03:00:00.000000',
            },
          ],
        });
        await db.transaction(tx =>
          tx.query(
            'UPDATE liekan_warehouse_site SET publication=publication+1 WHERE website_id=$1',
            [site],
          ),
        );
        assert.equal(
          (await warehouseReportMetadata(site)).boundary.publication,
          pinned.boundary.publication,
        );
        let n = 0;
        await table.stream(async rows => {
          n += rows.length;
        });
        assert.equal(n, total);
      });
      assert.equal(
        (await queryEvidence(actor, site, conditions, 'evidence', readCrawlerEvidence, true)).meta
          .total,
        total + 1,
      );
      console.log(
        JSON.stringify({
          largeEvidenceRows: countRows,
          csvBytes: bytes,
          maxTransportChunk: maxChunk,
        }),
      );
    });
} finally {
  await writeFile(
    `.local/ch-final-review/${run}${process.env.WAREHOUSE_EVIDENCE_CASE ? '-' + process.env.WAREHOUSE_EVIDENCE_CASE.replace(/[^a-z0-9-]/g, '_') : ''}.json`,
    JSON.stringify({ run, source, cases }, null, 2),
    { mode: 0o600 },
  );
  const { closeWarehouseProcessResources } = await import(
    '../../src/lib/liekan/warehouse/process-resources'
  );
  await closeWarehouseProcessResources();
  const { default: prisma } = await import('../../src/lib/prisma');
  await prisma.client.$disconnect();
  await Promise.allSettled([admin.end(), db.close(), ch.close(), chAdmin.close()]);
}
