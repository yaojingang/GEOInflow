// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RevenueMetricType } from '@/queries/sql/revenue/getRevenueMetrics';

type Plan = Record<string, any> & { Plans?: Plan[] };
const enabled = process.env.LIEKAN_ANALYSIS_ROLLUPS_TEST === '1';
const actor = randomUUID(),
  sites: string[] = [];
let client: Client, prisma: typeof import('@/lib/prisma').default;
let getRevenueMetrics: typeof import('@/queries/sql/revenue/getRevenueMetrics').getRevenueMetrics;
let withinQuerySnapshot: typeof import('./query-snapshot').withinQuerySnapshot;
const parameters = {
  startDate: new Date('2025-10-23T20:01Z'),
  endDate: new Date('2026-10-23T20:02:40Z'),
  currency: 'CNY',
  unit: 'day',
  timezone: 'Asia/Shanghai',
};
const save = (name: string, value: unknown) =>
  writeFile(
    `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/${name}.json`,
    JSON.stringify(value, null, 2),
    { mode: 0o600 },
  );
const nodes = (node: Plan): Plan[] => [node, ...(node.Plans || []).flatMap(nodes)];
const normalized = (rows: any[]) =>
  rows
    .map(row => ({ ...row, value: Number(row.value).toFixed(4) }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
async function website() {
  const id = randomUUID();
  sites.push(id);
  await client.query(
    "INSERT INTO website(website_id,name,domain,user_id)VALUES($1,'Synthetic revenue regression','revenue.invalid',$2)",
    [id, actor],
  );
  await client.query("UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id=$1", [id]);
  return id;
}
async function metrics(
  site: string,
  input: typeof parameters,
  filters: Record<string, unknown>,
  type: RevenueMetricType,
  explain = false,
) {
  let captured: { sql: string; values: unknown[] };
  let failed: { sql: string; values: unknown[]; code?: string };
  const executor = {
    async $executeRawUnsafe(sql: string, ...values: unknown[]) {
      return (await client.query(sql, values)).rowCount;
    },
    async $queryRawUnsafe(sql: string, ...values: unknown[]) {
      if (sql.includes('filtered_revenue') && sql.includes('revenue_event'))
        captured = { sql, values };
      try {
        return (await client.query(sql, values)).rows;
      } catch (error) {
        failed = {
          sql,
          values,
          code:
            error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
        };
        throw error;
      }
    },
  };
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await client.query("SET LOCAL statement_timeout='5s'");
    const value = await withinQuerySnapshot(executor, () =>
      getRevenueMetrics(site, input, filters, type),
    );
    if (!captured) throw new Error('native-revenue-sql-not-captured');
    const plan: Plan = explain
      ? (
          await client.query(
            'EXPLAIN(ANALYZE,BUFFERS,VERBOSE,TIMING OFF,FORMAT JSON)' + captured.sql,
            captured.values,
          )
        ).rows[0]['QUERY PLAN'][0].Plan
      : undefined;
    return { value, captured, plan };
  } catch (error) {
    await client.query('ROLLBACK');
    if (failed) {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL statement_timeout='5s'");
        const plan = (
          await client.query('EXPLAIN(VERBOSE,FORMAT JSON)' + failed.sql, failed.values)
        ).rows[0]['QUERY PLAN'];
        await save(`revenue-failed-${type}`, { failed, captured, plan });
      } finally {
        await client.query('ROLLBACK');
      }
    }
    throw error;
  } finally {
    await client.query('ROLLBACK');
  }
}

describe.skipIf(!enabled)('revenue event geography with actual PostgreSQL plans', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || 'http://invalid'),
      schema = url.searchParams.get('schema');
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '15462' ||
      url.pathname !== '/liekan_analysis_rollups_test' ||
      !/^analysis_[a-f0-9]+$/.test(schema || '')
    )
      throw new Error('owned-analysis-schema-required');
    url.searchParams.delete('schema');
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(`SET search_path TO "${schema}"`);
    ({ default: prisma } = await import('@/lib/prisma'));
    ({ getRevenueMetrics } = await import('@/queries/sql/revenue/getRevenueMetrics'));
    ({ withinQuerySnapshot } = await import('./query-snapshot'));
    await client.query(
      "INSERT INTO \"user\"(user_id,username,password,role)VALUES($1::uuid,$1::text,'fixture','user')",
      [actor],
    );
  });
  afterAll(async () => {
    if (!client) return;
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT website_id FROM website WHERE website_id=ANY($1::uuid[]) ORDER BY website_id FOR UPDATE',
        [sites],
      );
      await client.query(
        'SELECT website_id FROM liekan_analysis_site WHERE website_id=ANY($1::uuid[]) ORDER BY website_id FOR UPDATE',
        [sites],
      );
      await client.query('DELETE FROM revenue WHERE website_id=ANY($1::uuid[])', [sites]);
      await client.query('DELETE FROM website_event WHERE website_id=ANY($1::uuid[])', [sites]);
      await client.query('DELETE FROM session WHERE website_id=ANY($1::uuid[])', [sites]);
      await client.query('DELETE FROM website WHERE website_id=ANY($1::uuid[])', [sites]);
      await client.query('DELETE FROM "user" WHERE user_id=$1', [actor]);
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK');
      await client.end();
      await prisma?.client.$disconnect();
    }
  });

  it('bounds the final country and region projection to the selected revenue events', async () => {
    const population = await Promise.all(Array.from({ length: 10 }, () => website()));
    const end = +new Date('2026-10-23T20:01Z');
    await client.query(
      `CREATE TEMP TABLE revenue_regression_sessions AS SELECT i,gen_random_uuid() AS session_id,($1::uuid[])[1+((i-1)%10)] AS website_id FROM generate_series(1,10000)i`,
      [population],
    );
    await client.query(
      `INSERT INTO session(session_id,website_id,created_at,browser,os,device,country,city) SELECT session_id,website_id,to_timestamp($1/1000.0)-interval '365 days','chrome','mac','desktop','CN','合成城市' FROM revenue_regression_sessions`,
      [end],
    );
    await client.query(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type,hostname)
      SELECT gen_random_uuid(),s.website_id,s.session_id,s.session_id,date_trunc('hour',to_timestamp($1/1000.0)-(((e.i*97)%31536000)+60)*interval '1 second')+interval '30 minutes','/synthetic/'||(e.i%100),1,'revenue.invalid'
      FROM generate_series(1,100000)e(i) JOIN revenue_regression_sessions s ON s.i=1+((e.i-1)%10000)`,
      [end],
    );
    await client.query('ANALYZE website_event');
    await client.query(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type,event_name,hostname)
      SELECT gen_random_uuid(),s.website_id,s.session_id,s.session_id,to_timestamp($1/1000.0)-(((e.i*97)%2500000)+60)*interval '1 second','/synthetic/purchase',t.kind,CASE WHEN t.kind=2 THEN 'synthetic-purchase' END,'revenue.invalid'
      FROM generate_series(1,2000)e(i) JOIN revenue_regression_sessions s ON s.i=1+((e.i-1)%10000) CROSS JOIN(VALUES(2),(5))t(kind)`,
      [end],
    );
    await client.query(
      `INSERT INTO revenue(revenue_id,website_id,session_id,event_id,event_name,currency,revenue,created_at)
      SELECT gen_random_uuid(),website_id,session_id,event_id,event_name,'CNY',19.9900,created_at FROM website_event WHERE website_id=ANY($1::uuid[]) AND event_type=2`,
      [population],
    );
    await client.query('ANALYZE website_event');
    await client.query('ANALYZE revenue');
    await client.query(
      `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status,hostname,created_at)
      SELECT event_id,website_id,'browser','browser','{synthetic}','fixture','untrusted',hostname,created_at FROM website_event WHERE website_id=ANY($1::uuid[])`,
      [population],
    );
    await client.query('ANALYZE website_event');
    await client.query(
      `INSERT INTO liekan_session_source(website_id,session_id,source,scope,identity_version,identity_available)
      SELECT DISTINCT e.website_id,e.session_id,'browser','browser','synthetic-benchmark-identity-v1',true FROM website_event e
      WHERE e.website_id=ANY($1::uuid[]) ON CONFLICT DO NOTHING`,
      [population],
    );
    await client.query(
      `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser,os,device,screen,language)
      SELECT e.event_id,e.website_id,'browser','synthetic-benchmark-identity-v1',true,s.browser,s.os,s.device,s.screen,s.language
      FROM website_event e JOIN session s ON s.session_id=e.session_id AND s.website_id=e.website_id
      WHERE e.website_id=ANY($1::uuid[]) ON CONFLICT DO NOTHING`,
      [population],
    );
    await client.query('ANALYZE liekan_event_quality');
    await client.query('ANALYZE liekan_event_environment');
    await client.query('ANALYZE liekan_session_source');
    await client.query('ANALYZE session');
    const oracle = (
      await client.query(
        `SELECT count(*)::int AS n,sum(revenue)::text AS value FROM revenue WHERE website_id=$1 AND currency='CNY' AND created_at BETWEEN $2 AND $3`,
        [population[0], parameters.startDate, parameters.endDate],
      )
    ).rows[0];
    expect(oracle).toEqual({ n: 200, value: '3998.0000' });
    const results = [];
    for (const type of ['country', 'region'] as const) {
      const result = await metrics(population[0], parameters, {}, type, true);
      const expected =
        type === 'country'
          ? [{ name: 'CN', value: oracle.value }]
          : [{ country: 'CN', name: null, value: oracle.value }];
      expect(normalized(result.value)).toEqual(expected);
      // No geography filters are present: only the final projected visit needs the geography table.
      const geography = nodes(result.plan).filter(
        node => node['Relation Name'] === 'liekan_event_geography',
      );
      expect(geography).toHaveLength(1);
      const parent = nodes(result.plan).find(node => node.Plans?.includes(geography[0]));
      expect(parent).toBeTruthy();
      const point = nodes(parent).filter(
        node =>
          node['Index Name'] === 'website_event_pkey' &&
          /event_id\s*=\s*\w+\.event_id/.test(node['Index Cond'] || ''),
      );
      results.push({ type, ...result, geographyLoops: geography[0]['Actual Loops'], point });
    }
    await save('revenue-event-projection', { population, oracle, results });
    // Keep the cohort scans above intact; the bound applies only to the final revenue event projection.
    for (const result of results) {
      expect(result.geographyLoops).toBeLessThanOrEqual(oracle.n);
      expect(result.point.length).toBeGreaterThan(0);
      const eligibility = nodes(result.plan).filter(
        node =>
          String(node['Subplan Name'] || '').startsWith('SubPlan') &&
          nodes(node).some(
            child =>
              child['Index Name'] === 'website_event_pkey' &&
              /event_id\s*=\s*\w+\.event_id/.test(child['Index Cond'] || ''),
          ),
      );
      expect(eligibility).toHaveLength(1);
      expect(eligibility[0]['Actual Loops']).toBe(oracle.n);
      expect(
        nodes(result.plan).filter(
          node => node['Join Type'] === 'Semi' && /event_id/.test(node['Join Filter'] || ''),
        ),
      ).toHaveLength(0);
      let candidates = 0;
      for (const point of result.point) {
        expect(point['Actual Rows']).toBeLessThanOrEqual(1);
        expect(point['Actual Loops']).toBeLessThanOrEqual(oracle.n);
        // Main's browser/link/pixel branches each probe the unique event before type discrimination.
        const rows = point['Actual Rows'] + (point['Rows Removed by Filter'] || 0);
        expect(rows).toBeLessThanOrEqual(1);
        candidates += rows * point['Actual Loops'];
      }
      expect(candidates).toBeLessThanOrEqual(3 * oracle.n);
    }
  }, 60000);

  it('keeps session cohorts and each revenue event visit tuple across dates, websites and missing evidence', async () => {
    const site = await website(),
      other = await website(),
      session = randomUUID();
    await client.query(
      "INSERT INTO session(session_id,website_id,country,region,city)VALUES($1,$2,'DE','DE-BE','Berlin')",
      [session, site],
    );
    const explicit: Array<{
      country: string | null;
      region: string | null;
      amount: number;
      geography: boolean;
      quality: boolean;
    }> = [
      { country: 'CN', region: 'CN-44', amount: 100, geography: true, quality: true },
      { country: 'US', region: 'US-NY', amount: 200, geography: true, quality: true },
      { country: null, region: null, amount: 75, geography: true, quality: true },
      { country: 'DE', region: 'DE-BE', amount: 50, geography: false, quality: true },
      { country: 'FR', region: 'FR-75', amount: 999, geography: true, quality: false },
    ];
    for (const [index, item] of explicit.entries()) {
      const visit = randomUUID(),
        anchor = randomUUID(),
        selector = randomUUID(),
        purchase = randomUUID();
      for (const [id, kind, at, path] of [
        [anchor, 1, '2026-10-20T10:00Z', '/old-anchor'],
        [selector, 1, '2026-10-22T10:00Z', index === 0 ? '/cohort-qualifier' : '/other'],
        [purchase, 2, '2026-10-22T11:00Z', '/purchase-only'],
      ] as const) {
        await client.query(
          `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type,event_name)VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic')`,
          [id, site, session, visit, at, path, kind],
        );
        if (item.quality) {
          await client.query(
            "INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser)VALUES($1,$2,'browser','synthetic-fixture',true,'Chrome')",
            [id, site],
          );
          await client.query(
            "INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status)VALUES($1,$2,'browser','browser','{synthetic}','fixture','missing')",
            [id, site],
          );
        }
      }
      if (item.geography)
        await client.query(
          `INSERT INTO liekan_event_geography(event_id,website_id,country,region,source,trust,ip_family,precision,reason,rule_version,country_basis,processed_at)VALUES($1,$2,$3,$4,'synthetic','unverified','missing',$5,'synthetic','fixture',$6,now())`,
          [
            anchor,
            site,
            item.country,
            item.region,
            item.country === null ? 'missing' : 'province',
            item.country === null ? 'missing' : 'located',
          ],
        );
      await client.query(
        `INSERT INTO revenue(revenue_id,website_id,session_id,event_id,event_name,currency,revenue,created_at)VALUES($1,$2,$3,$4,'synthetic','USD',$5,'2026-10-22T11:00Z')`,
        [randomUUID(), site, session, purchase, item.amount],
      );
    }
    const foreignEvent = randomUUID();
    await client.query(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type)VALUES($1,$2,$3,$3,'2026-10-22T11:00Z','/cohort-qualifier',2)`,
      [foreignEvent, other, randomUUID()],
    );
    await client.query(
      `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status)VALUES($1,$2,'browser','browser','{synthetic}','fixture','missing')`,
      [foreignEvent, other],
    );
    await client.query(
      `INSERT INTO revenue(revenue_id,website_id,session_id,event_id,event_name,currency,revenue,created_at)SELECT gen_random_uuid(),website_id,session_id,event_id,'synthetic','USD',999,'2026-10-22T11:00Z' FROM website_event WHERE event_id=$1`,
      [foreignEvent],
    );
    const input = {
      startDate: new Date('2026-10-22T00:00Z'),
      endDate: new Date('2026-10-23T00:00Z'),
      currency: 'USD',
      unit: 'day',
      timezone: 'Asia/Shanghai',
    };
    const countries = explicit
      .filter(item => item.quality)
      .map(({ country, amount }) => ({ name: country, value: amount }));
    const regions = explicit
      .filter(item => item.quality)
      .map(({ country, region, amount }) => ({ country, name: region, value: amount }));
    const outcomes = [];
    for (const type of ['country', 'region'] as const)
      for (const filters of [
        {},
        { country: 'eq.CN' },
        {
          cohort_startDate: input.startDate,
          cohort_endDate: input.endDate,
          cohort_url: 'eq./cohort-qualifier',
        },
      ]) {
        const result = await metrics(site, input, filters, type);
        expect(normalized(result.value)).toEqual(
          normalized(type === 'country' ? countries : regions),
        );
        outcomes.push({ type, filters, ...result });
      }
    await save('revenue-event-cohorts', { site, other, explicit, outcomes });
  }, 30000);
});
