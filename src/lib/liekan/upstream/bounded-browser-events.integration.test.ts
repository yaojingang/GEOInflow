// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boundedBrowserEventsSql } from './bounded-browser-events';
import { withTrafficPolicy } from './traffic-query';

const enabled = !!process.env.LIEKAN_C2_DATABASE_URL;
const site = randomUUID(),
  otherSite = randomUUID(),
  actor = randomUUID();
const start = '2026-10-01T00:00:00Z',
  end = '2026-10-01T01:00:00Z';
let db: any;
const condition =
  'e.website_id=$1::uuid AND e.created_at BETWEEN $2::timestamptz AND $3::timestamptz';
const args = [site, start, end];
const prefix = () =>
  `WITH ${boundedBrowserEventsSql(condition, { geography: true, environment: true, entryBefore: '$3::timestamptz' })}`;
const read = async (sql: string, values = args) => (await db.query(sql, values)).rows;

async function event(
  session: string,
  visit: string,
  at: string,
  type = 1,
  owner = site,
  available = true,
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,event_type,url_path,hostname)
    VALUES($1,$2,$3,$4,$5,$6,'/synthetic/bounded','bounded.invalid')`,
    [id, owner, session, visit, at, type],
  );
  await db.query(
    `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status,hostname)
    VALUES($1,$2,'browser','browser','{}','synthetic-bounded','missing','bounded.invalid')`,
    [id, owner],
  );
  await db.query(
    `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser,os,device)
    VALUES($1,$2,'browser','synthetic-bounded',$3,$4,'synthetic-os','desktop')`,
    [id, owner, available, at > end ? 'Safari' : 'Firefox'],
  );
  await db.query(
    `INSERT INTO liekan_event_geography(event_id,website_id,country,source,trust,ip_family,precision,reason,rule_version,country_basis,processed_at)
    VALUES($1,$2,$3,'synthetic','synthetic','missing','country','synthetic','synthetic','synthetic',clock_timestamp())`,
    [id, owner, at > end ? 'GB' : 'CN'],
  );
  return id;
}
async function session(owner = site) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO session(session_id,website_id,created_at,browser,country) VALUES($1,$2,$3,'Chrome','US')`,
    [id, owner, start],
  );
  return id;
}

describe.skipIf(!enabled)('bounded authoritative browser cohort SQL', () => {
  beforeAll(async () => {
    const url = new URL(process.env.LIEKAN_C2_DATABASE_URL!);
    const schema = url.searchParams.get('schema');
    const rollupFixture =
      process.env.LIEKAN_ANALYSIS_ROLLUPS_TEST === '1' &&
      url.pathname === '/liekan_analysis_rollups_test' &&
      url.port === '15462' &&
      /^analysis_[a-f0-9]+$/.test(schema || '');
    if (url.hostname !== '127.0.0.1' || (!/^c2_/.test(url.pathname.slice(1)) && !rollupFixture))
      throw new Error('Owned C2 database required');
    const { Client } = createRequire(import.meta.url)('pg');
    db = new Client({ connectionString: url.toString(), application_name: 'owned-c2-regression' });
    await db.connect();
    if (schema) {
      if (!/^analysis_[a-f0-9]+$/.test(schema)) throw new Error('Owned C2 schema required');
      await db.query(`SET search_path TO "${schema}"`);
    }
    await db.query('SET jit=off');
    await db.query("SET statement_timeout='10s'");
    await db.query(
      `INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$1::text,'synthetic','user')`,
      [actor],
    );
    for (const id of [site, otherSite])
      await db.query(
        `INSERT INTO website(website_id,user_id,name,domain) VALUES($1,$2,'Synthetic bounded SQL','bounded.invalid')`,
        [id, actor],
      );
  });
  afterAll(async () => {
    if (!db) return;
    await db.query('DELETE FROM website WHERE website_id=ANY($1::uuid[])', [[site, otherSite]]);
    await db.query('DELETE FROM "user" WHERE user_id=$1', [actor]);
    await db.end();
  });
  it('retains custom/performance future geography, event environment, independent entry and native latest time', async () => {
    for (const type of [2, 5]) {
      const owner = await session(),
        visit = randomUUID();
      await event(owner, visit, '2026-10-01T00:10:00Z', type);
      await event(owner, visit, '2026-10-01T01:01:00Z');
    }
    const columns =
      'event_id,event_type,liekan_country,liekan_browser,liekan_os,liekan_device,liekan_identity_available';
    const actual = await read(
      `${prefix()} SELECT ${columns} FROM bounded_events ORDER BY event_id`,
    );
    const expected = await read(
      `SELECT ${columns} FROM liekan_geographic_website_event e WHERE ${condition} ORDER BY event_id`,
    );
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(2);
    expect(
      actual.every(row => row.liekan_country === 'GB' && row.liekan_browser === 'Firefox'),
    ).toBe(true);
    expect(await read(`${prefix()} SELECT event_id FROM bounded_entry`)).toEqual([]);
    expect(
      (
        await read('SELECT browser FROM liekan_effective_session WHERE website_id=$1', [site])
      ).every(row => row.browser === 'Safari'),
    ).toBe(true);
    // The policy wrapper must preserve physical fences and their schema-relative tables.
    expect(
      await read(
        withTrafficPolicy(`${prefix()} SELECT ${columns} FROM bounded_events ORDER BY event_id`),
      ),
    ).toEqual(expected);
  });
  it('bounds history to complete website/session/visit tuples as unrelated history grows', async () => {
    const owner = await session(),
      visit = randomUUID(),
      otherVisit = randomUUID();
    await event(owner, visit, '2026-09-30T23:00:00Z');
    await event(owner, visit, '2026-10-01T00:20:00Z');
    await event(owner, otherVisit, '2026-09-30T22:00:00Z');
    await event(owner, visit, '2026-09-30T21:00:00Z', 1, otherSite);
    const counts = `${prefix()} SELECT (SELECT count(*) FROM bounded_keys)::int AS window,
      (SELECT count(*) FROM bounded_cohort)::int AS cohort,(SELECT count(*) FROM bounded_history)::int AS history`;
    const before = await read(counts);
    const unrelated = await session();
    for (let i = 0; i < 10; i++) await event(unrelated, unrelated, '2026-09-30T20:00:00Z');
    expect(await read(counts)).toEqual(before);
    expect(before[0]).toEqual({ window: 3, cohort: 3, history: 6 });
    const plan = (await read(`EXPLAIN(ANALYZE,FORMAT JSON) ${counts}`))[0]['QUERY PLAN'][0].Plan;
    const nodes: any[] = [];
    const walk = (node: any) => {
      nodes.push(node);
      for (const child of node.Plans || []) walk(child);
    };
    walk(plan);
    for (const node of nodes.filter(node => /^CTE bounded_/.test(node['Subplan Name'] || '')))
      expect(node['Actual Loops']).toBeLessThanOrEqual(1);
    expect(
      nodes
        .filter(node => /^CTE bounded_/.test(node['Subplan Name'] || ''))
        .filter(node => node['Actual Loops'] === 1).length,
    ).toBeGreaterThan(3);
  });
  it('keeps inclusive/half-open microsecond bounds and re-evaluates corrected eligibility', async () => {
    const owner = await session(),
      visit = randomUUID();
    const at = await event(owner, visit, end);
    await event(owner, visit, '2026-10-01T01:00:00.000001Z');
    const select = (where: string) =>
      `WITH ${boundedBrowserEventsSql(where, { geography: true })} SELECT event_id,liekan_country FROM bounded_events WHERE session_id='${owner}'::uuid ORDER BY event_id`;
    expect(await read(select(condition))).toHaveLength(1);
    expect(
      await read(
        select(
          condition.replace(
            'BETWEEN $2::timestamptz AND $3::timestamptz',
            '>=$2::timestamptz AND e.created_at<$3::timestamptz',
          ),
        ),
      ),
    ).toHaveLength(0);
    await db.query("UPDATE liekan_event_quality SET classification='automated' WHERE event_id=$1", [
      at,
    ]);
    expect(await read(select(condition))).toHaveLength(0);
    await db.query("UPDATE liekan_event_quality SET classification='browser' WHERE event_id=$1", [
      at,
    ]);
    expect(await read(select(condition))).toHaveLength(1);
  });
  it('executes no physical event reads when proved coverage leaves no raw ranges', async () => {
    const sql = `WITH raw_gaps AS MATERIALIZED(SELECT $2::timestamptz AS starts,$3::timestamptz AS ends WHERE false),
      ${boundedBrowserEventsSql(condition, { geography: true, environment: true, ranges: 'raw_gaps' })}
      SELECT count(*)::int AS events FROM bounded_events`;
    expect(await read(sql)).toEqual([{ events: 0 }]);
    const plan = (await read(`EXPLAIN(ANALYZE,FORMAT JSON) ${sql}`))[0]['QUERY PLAN'][0].Plan;
    const nodes: any[] = [];
    const walk = (node: any) => {
      nodes.push(node);
      for (const child of node.Plans || []) walk(child);
    };
    walk(plan);
    const scans = nodes.filter(node => node['Relation Name'] === 'website_event');
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every(node => node['Actual Rows'] * node['Actual Loops'] === 0)).toBe(true);
  });
});
