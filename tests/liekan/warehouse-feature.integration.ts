import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { testClickHouseURL } from './warehouse-test-target';

// Read-only diagnostics reuse one synthetic reporting fixture. They never attach
// to the downloaded production clone and do not rebuild large DBs on each fix.
assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const files = (await readdir('.local/ch-implementation'))
  .filter(f => /^warehouse_reporting_\d+\.json$/.test(f))
  .sort();
const run = process.env.WAREHOUSE_FEATURE_FIXTURE ?? files.at(-1)?.replace('.json', '');
assert.match(run, /^warehouse_(reporting|feature_data)_\d+$/);
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
  if (process.env.WAREHOUSE_FEATURE_CASE && process.env.WAREHOUSE_FEATURE_CASE !== name) return;
  if (
    process.env.WAREHOUSE_FEATURE_CASES &&
    !new RegExp(process.env.WAREHOUSE_FEATURE_CASES).test(name)
  )
    return;
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
const { featureAnalytics, featureJourney } = await import(
  '../../src/lib/liekan/upstream/feature-analytics'
);
const { withoutQueryCache } = await import('../../src/lib/liekan/upstream/cache-context');
const input = { startAt: +start, endAt: +end, timezone: 'UTC', page: 1 };
const normalized = (v: unknown) => JSON.parse(JSON.stringify(v));
async function parity(work: () => Promise<unknown>, performanceFloats = false) {
  let expected: unknown;
  process.env.LIEKAN_ANALYTICS_BACKEND = 'postgresql';
  try {
    expected = await withoutQueryCache(work);
  } finally {
    process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  }
  const actual = await withoutQueryCache(work);
  if (performanceFloats) {
    for (const key of Object.keys(actual as object))
      if (/P(?:50|75|95)$/.test(key)) {
        const a = (actual as any)[key],
          b = (expected as any)[key];
        if (a === null || b === null) assert.equal(a, b);
        else
          assert.ok(Math.abs(a - b) <= Math.max(1, Math.abs(b)) * 1e-12, `exact quantile ${key}`);
        // Both engines use exact R7 interpolation. Only binary floating roundoff
        // is tolerated here; counts, identities and all other fields stay exact.
        (actual as any)[key] = b;
      }
  }
  assert.deepEqual(normalized(actual), normalized(expected));
}
for (const item of [
  { kind: 'events' },
  { kind: 'utm' },
  { kind: 'utm', dimension: 'source' },
  { kind: 'sources' },
  { kind: 'session', sessionId: session },
  { kind: 'session', sessionId: '00000000-0000-0000-0000-000000000000' },
  { kind: 'sessions' },
  { kind: 'session-properties' },
  { kind: 'performance' },
  { kind: 'revenue', currency: 'USD' },
  { kind: 'events', propertyName: 'price' },
  { kind: 'heatmap-scroll', urlPath: '/feature/start' },
  { kind: 'attribution', model: 'first-click', type: 'path', step: '/8' },
  { kind: 'attribution', model: 'last-click', type: 'path', step: '/8' },
  { kind: 'realtime' },
  { kind: 'heatmap-scroll', urlPath: '/0' },
  { kind: 'replays' },
  { kind: 'replays', saved: '1' },
  { kind: 'sessions', retentionDate: '2026-11-03', retentionDay: 1 },
  {
    kind: 'sessions',
    attributionStep: '/8',
    attributionModel: 'first-click',
    attributionType: 'path',
    attributionSource: 'google.com',
  },
])
  await check(JSON.stringify(item), () =>
    parity(() => featureAnalytics(site, { ...input, ...item }), item.kind === 'performance'),
  );
for (const extra of [
  {},
  { steps: 2 },
  { steps: 2, sequence: JSON.stringify(['/0', '/8']) },
  { startStep: '/missing' },
  { endStep: '/8' },
  { type: 'events' },
])
  await check('journey ' + JSON.stringify(extra), () =>
    parity(() => featureJourney(site, { ...input, ...extra })),
  );
if (run.startsWith('warehouse_feature_data_')) {
  const fixture = JSON.parse(await readFile(`.local/ch-implementation/${run}.json`, 'utf8'));
  const { featureGoal } = await import('../../src/lib/liekan/upstream/feature-analytics');
  for (const unit of ['hour', 'week'])
    await check('goal ' + unit, () =>
      parity(() =>
        featureGoal(site, fixture.goal, { ...input, unit }, { user: { isAdmin: true } } as any),
      ),
    );
}
await check('website-list totals and raw collection presence', async () => {
  const { warehouseWebsiteSummaries } = await import(
    '../../src/lib/liekan/upstream/warehouse-website-summary'
  );
  const { warehouseReader } = await import('../../src/lib/liekan/warehouse/reader-runtime');
  const { db } = warehouseReader();
  const [business] = await db.read<{ created_at: Date }>(
    'SELECT created_at FROM website WHERE website_id=$1',
    [site],
  );
  const [expected] = await db.read<any>(
    `WITH visits AS(SELECT session_id,visit_id,count(*) FILTER(WHERE event_type NOT IN(2,5)) AS pv,min(created_at) FILTER(WHERE event_type NOT IN(2,5)) AS first_at,max(created_at) FILTER(WHERE event_type NOT IN(2,5)) AS last_at,count(*) FILTER(WHERE event_type=2) AS custom
  FROM liekan_geographic_website_event WHERE website_id=$1 AND created_at BETWEEN $2 AND $3 AND event_type!=5 GROUP BY session_id,visit_id HAVING count(*) FILTER(WHERE event_type NOT IN(2,5))>0)
  SELECT sum(pv) AS pageviews,count(DISTINCT session_id) AS visitors,count(DISTINCT visit_id) AS visits,count(*) FILTER(WHERE pv=1 AND custom=0) AS bounces,sum(floor(extract(epoch FROM last_at-first_at))) AS totaltime FROM visits`,
    [site, start, end],
  );
  const [actual] = await warehouseWebsiteSummaries(
    [{ id: site, createdAt: business.created_at }],
    input,
  );
  for (const k of Object.keys(expected)) assert.equal(actual[k], Number(expected[k]), k);
  const [presence] = await db.read<any>(
    'SELECT EXISTS(SELECT 1 FROM website_event WHERE website_id=$1 AND created_at BETWEEN $2 AND now() AND event_type NOT IN(2,5)) AS received',
    [site, business.created_at],
  );
  assert.equal(actual.received, presence.received);
});
await check('geography diagnostics', async () => {
  const { geographyDiagnostics } = await import(
    '../../src/lib/liekan/upstream/geography-diagnostics'
  );
  await parity(() =>
    geographyDiagnostics(
      site,
      new URLSearchParams({ startAt: String(+start), endAt: String(+end), timezone: 'UTC' }),
    ),
  );
});
await check('keywords', async () => {
  const { readKeywordFacts } = await import('../../src/lib/liekan/upstream/keywords');
  const { withWarehouseKeywords } = await import(
    '../../src/lib/liekan/upstream/warehouse-keywords'
  );
  await parity(async () => {
    if (process.env.LIEKAN_ANALYTICS_BACKEND === 'clickhouse')
      return withWarehouseKeywords(
        site,
        { ...input, keywordStatusVersion: '2' },
        async selected => {
          // This existing fixture is intentionally small. Production reads never
          // materialize complete keyword facts; the large fixture streams them.
          const rows: any[] = [];
          await selected.rows.stream(async batch => {
            rows.push(
              ...batch.map(row => ({
                ...row,
                share: null,
                bounceRate: null,
                conversionRate: null,
              })),
            );
          });
          rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          return { rows, hasGoals: selected.hasGoals, snapshot: selected.snapshot };
        },
      );
    const { readAt, ...facts } = await readKeywordFacts(site, input);
    facts.rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return facts;
  });
});
await (await import('../../src/lib/liekan/warehouse/reader-runtime')).warehouseReader().close();
await writeFile(
  `.local/ch-implementation/warehouse_feature_${Date.now()}.json`,
  JSON.stringify({ fixture: run, cases }, null, 2),
  { mode: 0o600 },
);
