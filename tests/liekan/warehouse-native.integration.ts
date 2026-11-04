import { testClickHouseURL } from './warehouse-test-target';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';

// Read-only diagnostics reuse one synthetic reporting fixture. They never attach
// to the downloaded production clone and do not rebuild large DBs on each fix.
assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const files = (await readdir('.local/ch-implementation'))
  .filter(f => /^warehouse_reporting_\d+\.json$/.test(f))
  .sort();
const run = process.env.WAREHOUSE_NATIVE_FIXTURE ?? files.at(-1)?.replace('.json', '');
assert.match(run, /^warehouse_reporting_\d+$/);
const url = new URL(`postgresql://127.0.0.1:25459/${run}`);
url.username = 'liekan_ch_proto';
url.password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const pgReader = new pg.Client({
  connectionString: url.toString(),
  options: '-c default_transaction_read_only=on',
});
await pgReader.connect();
const [{ website_id: site }] = (
  await pgReader.query("SELECT website_id FROM website WHERE name='Isolated reporting fixture'")
).rows;
const [{ session_id: session }] = (
  await pgReader.query('SELECT session_id FROM session WHERE website_id=$1', [site])
).rows;
await pgReader.end();
process.env.DATABASE_URL = url.toString();
process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
process.env.LIEKAN_CLICKHOUSE_URL = testClickHouseURL;
process.env.LIEKAN_CLICKHOUSE_DATABASE = run;
delete process.env.CLICKHOUSE_URL;
delete process.env.LIEKAN_QUEUE_BROKERS;
const start = new Date('2026-11-03T00:00:00Z'),
  end = new Date('2026-11-03T09:00:00Z');
const filters = { startDate: start, endDate: end, timezone: 'UTC', unit: 'day' };
const cases: object[] = [];
async function check(name: string, work: () => Promise<void>) {
  if (process.env.WAREHOUSE_NATIVE_CASE && process.env.WAREHOUSE_NATIVE_CASE !== name) return;
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
await check('overview', async () => {
  const { getWebsiteStats } = await import('../../src/queries/sql/getWebsiteStats');
  const r = await getWebsiteStats(site, filters);
  assert.equal(r.pageviews, 2);
  assert.equal(r.visitors, 1);
  assert.equal(r.visits, 1);
  assert.equal(r.bounces, 0);
  assert.equal(r.totaltime, 28800);
});
await check('series', async () => {
  const { getPageviewStats } = await import('../../src/queries/sql/pageviews/getPageviewStats');
  const { getSessionStats } = await import('../../src/queries/sql/sessions/getSessionStats');
  assert.equal((await getPageviewStats(site, filters))[0].y, 2);
  assert.equal((await getSessionStats(site, filters))[0].y, 1);
});
await check('sessions', async () => {
  const { getWebsiteSessions } = await import('../../src/queries/sql/sessions/getWebsiteSessions');
  const r = await getWebsiteSessions(site, { ...filters, page: 1, pageSize: 1 });
  assert.equal(r.count, 1);
  assert.equal(r.data[0].views, 2);
});
await check('profile', async () => {
  const { getWebsiteSession } = await import('../../src/queries/sql/sessions/getWebsiteSession');
  assert.equal((await getWebsiteSession(site, session)).views, 2);
});
await check('events', async () => {
  const { getWebsiteEvents } = await import('../../src/queries/sql/events/getWebsiteEvents');
  const r = await getWebsiteEvents(site, { ...filters, page: 1, pageSize: 1 });
  assert.equal(r.count, 3);
  assert.equal(r.data.length, 1);
});
await check('funnel', async () => {
  const { getFunnel } = await import('../../src/queries/sql/funnels/getFunnel');
  const r = await getFunnel(
    site,
    {
      startDate: start,
      endDate: end,
      window: 86400,
      steps: [
        { type: 'path', value: '/0' },
        { type: 'path', value: '/8' },
      ],
    },
    filters,
  );
  assert.equal(r[0].visitors, 1);
  assert.equal(r[1].visitors, 1);
});
await check('charts', async () => {
  const { getWebsiteListCharts } = await import('../../src/queries/sql/getWebsiteListCharts');
  assert.equal((await getWebsiteListCharts([site], filters))[site].total, 1);
});
await check('quality-audit', async () => {
  const { trafficQualityAudit, parseQualityRange, qualityTotals, qualityReadTransaction } =
    await import('../../src/lib/liekan/upstream/traffic-quality');
  const { warehouseQualityTotals, warehouseTrafficGovernanceState } = await import(
    '../../src/lib/liekan/upstream/warehouse-traffic-quality'
  );
  const params = new URLSearchParams({
    startAt: String(+start),
    endAt: String(+end),
    timezone: 'UTC',
  });
  process.env.LIEKAN_ANALYTICS_BACKEND = 'postgresql';
  let expected: any;
  try {
    expected = await trafficQualityAudit(site, params);
  } finally {
    process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  }
  const actual: any = await trafficQualityAudit(site, params);
  for (const key of ['totals', 'summary', 'partition', 'domainAudit', 'rows']) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(actual[key])),
      JSON.parse(JSON.stringify(expected[key])),
      key,
    );
  }
  assert.deepEqual(actual.governance.collections, expected.governance.collections);
  assert.equal(actual.totals.rawPV, 8);
  assert.equal(actual.totals.includedPV, 2);
  assert.equal(actual.totals.rawUV, null);
  const repaired = actual.rows.find((r: any) => r.path === '/8');
  assert.equal(repaired.classification, 'automated');
  assert.equal(repaired.currentClassification, 'browser');
  assert.equal(repaired.included, true);
  assert.equal(actual.rows.find((r: any) => r.path === '/6').classification, 'unknown');
  const range = parseQualityRange(params);
  const proposed = { mode: 'strict' as const, allowedHostnames: ['wrong.invalid'] };
  const pg = await qualityReadTransaction(tx => qualityTotals(tx, site, range, proposed));
  assert.deepEqual(await warehouseQualityTotals(site, range, proposed), pg);
  assert.deepEqual(
    (await warehouseTrafficGovernanceState(site)).collections,
    expected.governance.collections,
  );
});
await check('geo-empty-evidence', async () => {
  const { geoWeightAggregate, geoWeightFirstEvidence } = await import(
    '../../src/lib/liekan/upstream/geo-weight-sql'
  );
  const { aiTransaction } = await import('../../src/lib/liekan/upstream/ai-db');
  const windows = [{ asOf: '2026-11-03', startAt: +start, endAt: +end }];
  process.env.LIEKAN_ANALYTICS_BACKEND = 'postgresql';
  const expected = await aiTransaction(
    tx => geoWeightAggregate(tx, site, 'fixture.invalid', 'UTC', windows),
    { readOnly: true },
  );
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  const actual = await aiTransaction(
    tx => geoWeightAggregate(tx, site, 'fixture.invalid', 'UTC', windows),
    { readOnly: true, timeout: 30000 },
  );
  assert.deepEqual(actual, expected);
  assert.equal(
    await aiTransaction(tx => geoWeightFirstEvidence(tx, site, 'fixture.invalid', 'UTC', +end), {
      readOnly: true,
      timeout: 30000,
    }),
    undefined,
  );
});
await check('browser-risk-report', async () => {
  const { browserRiskReport } = await import('../../src/lib/liekan/upstream/browser-risk');
  const params = new URLSearchParams({
    startAt: String(+start),
    endAt: String(+end),
    timezone: 'UTC',
  });
  process.env.LIEKAN_ANALYTICS_BACKEND = 'postgresql';
  let expected: any;
  try {
    expected = await browserRiskReport(site, params);
  } finally {
    process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  }
  const actual = await browserRiskReport(site, params);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
});
await check('batch-key-transport', async () => {
  const { warehouseReader } = await import('../../src/lib/liekan/warehouse/reader-runtime');
  const keys = Array.from({ length: 10001 }, (_, i) =>
    JSON.stringify([`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`]),
  );
  const result = await warehouseReader()
    .ch.query({
      query: 'SELECT length({keys:Array(String)}) AS n',
      query_params: { keys },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ n: string }>());
  assert.equal(Number(result[0].n), 10001);
});
await (await import('../../src/lib/liekan/warehouse/reader-runtime')).warehouseReader().close();
await writeFile(
  `.local/ch-implementation/warehouse_native_${Date.now()}.json`,
  JSON.stringify({ fixture: run, cases }, null, 2),
  { mode: 0o600 },
);
