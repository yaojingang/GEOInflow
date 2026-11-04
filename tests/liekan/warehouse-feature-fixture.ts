import { testClickHouseURL } from './warehouse-test-target';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { storedFact } from '../../src/lib/liekan/warehouse/candidate';
import { factTable, identifier } from '../../src/lib/liekan/warehouse/catalog';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const files = (await readdir('.local/ch-implementation'))
  .filter(f => /^warehouse_reporting_\d+\.json$/.test(f))
  .sort();
const source = files.at(-1).replace('.json', ''),
  run = `warehouse_feature_data_${Date.now()}`;
const sourceReport = JSON.parse(await readFile(`.local/ch-implementation/${source}.json`, 'utf8'));
assert.ok(sourceReport.cases.every(c => c.status === 'pass'));
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
await admin.query(`CREATE DATABASE "${run}" TEMPLATE "${source}"`);
await chAdmin.command({ query: `CREATE DATABASE "${run}"` });
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
const [{ website_id: site }] = await db.read<{ website_id: string }>(
  "SELECT website_id FROM website WHERE name='Isolated reporting fixture'",
);
const session = randomUUID(),
  visit = randomUUID(),
  at = '2026-11-03T00:20:00Z';
let ordinal = 1000;
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

try {
  await put('session', {
    website_id: site,
    session_id: session,
    created_at: at,
    country: 'US',
    browser: 'Chrome',
    os: 'Mac OS',
    device: 'desktop',
  });
  for (let i = 0; i < 6; i++) {
    const event = randomUUID(),
      created = `2026-11-03T00:${20 + i}:00Z`,
      type = i < 2 ? 1 : i < 4 ? 2 : 5;
    await put('website_event', {
      website_id: site,
      event_id: event,
      session_id: session,
      visit_id: visit,
      event_type: type,
      created_at: created,
      url_path: i === 0 ? '/feature/start' : '/feature/finish',
      event_name: type === 2 ? 'purchase' : null,
      hostname: 'fixture.invalid',
      referrer_domain: i === 0 ? 'www.google.com' : null,
      referrer_path: i === 0 ? '/search' : null,
      referrer_query: i === 0 ? 'q=isolated+fixture' : null,
      utm_source: 'fixture-campaign',
      utm_medium: 'test',
      utm_campaign: 'isolated',
      utm_term: 'safe fixture',
      ...(type === 5
        ? {
            lcp: i === 4 ? '100.1' : '300.3',
            inp: i === 4 ? '20.1' : '30.5',
            cls: i === 4 ? '0.0100' : '0.0900',
            fcp: i === 4 ? '15.1' : '40.9',
            ttfb: i === 4 ? '10.2' : '20.6',
          }
        : {}),
    });
    await put('liekan_event_quality', {
      website_id: site,
      event_id: event,
      classification: 'browser',
      source: 'browser',
      reasons: [],
      rule_version: 'fixture-v1',
      range_status: 'missing',
      hostname: 'fixture.invalid',
      created_at: created,
    });
    await put('liekan_event_environment', {
      website_id: site,
      event_id: event,
      scope: 'browser',
      identity_version: 'fixture-v1',
      identity_available: true,
      browser: 'Chrome',
      os: 'Mac OS',
      device: 'desktop',
      origin_hostname: 'fixture.invalid',
      created_at: created,
    });
    if (type === 2) {
      await put('event_data', {
        event_data_id: randomUUID(),
        website_id: site,
        website_event_id: event,
        data_key: i === 2 ? 'plan' : 'price',
        data_type: i === 2 ? 1 : 2,
        string_value: i === 2 ? 'premium' : null,
        number_value: i === 2 ? null : '42.1250',
        created_at: created,
      });
      await put('revenue', {
        revenue_id: randomUUID(),
        website_id: site,
        session_id: session,
        event_id: event,
        event_name: 'purchase',
        currency: 'USD',
        revenue: i === 2 ? '42.1250' : '12.3400',
        created_at: created,
      });
    }
  }
  await put('session_data', {
    session_data_id: randomUUID(),
    website_id: site,
    session_id: session,
    data_key: 'plan',
    data_type: 1,
    string_value: 'premium',
    created_at: at,
  });
  await put('heatmap_event', {
    heatmap_event_id: randomUUID(),
    website_id: site,
    session_id: session,
    visit_id: visit,
    url_path: '/feature/start',
    event_type: 2,
    scroll_pct: 75,
    page_w: 1000,
    page_h: 2000,
    viewport_w: 1000,
    viewport_h: 800,
    created_at: at,
  });
  const [replay] = await db.read<{ visit_id: string }>(
    'SELECT visit_id FROM session_replay WHERE visit_id IN(SELECT visit_id FROM website_event) LIMIT 1',
  );
  await db.transaction(tx =>
    tx.query(
      "INSERT INTO session_replay_saved(saved_replay_id,website_id,visit_id,name) VALUES($1,$2,$3,'Isolated bookmark')",
      [randomUUID(), site, replay.visit_id],
    ),
  );
  const owner = randomUUID();
  await db.transaction(tx =>
    tx.query(`INSERT INTO "user"(user_id,username,password,role) VALUES($1,$2,$3,'admin')`, [
      owner,
      `isolated-${owner}`,
      '$2b$10$' + '0'.repeat(53),
    ]),
  );
  const goal = randomUUID();
  await db.transaction(tx =>
    tx.query(
      "INSERT INTO report(report_id,user_id,website_id,type,name,description,parameters) VALUES($1,$2,$3,'goal','Isolated conversion','Isolated feature regression',$4)",
      [goal, owner, site, JSON.stringify({ type: 'path', value: '/feature/finish' })],
    ),
  );
  await writeFile(
    `.local/ch-implementation/${run}.json`,
    JSON.stringify({ run, source, site, session, visit, goal, isolated: true }),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ run, seeded: 6, isolated: true }));
} finally {
  await Promise.allSettled([admin.end(), db.close(), ch.close(), chAdmin.close()]);
}
