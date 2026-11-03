// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client, types } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlStatements } from '../../../../scripts/liekan-sql-statements.mjs';

const target = process.env.LIEKAN_HUMAN_TEST_DATABASE_URL;
const schema = `liekan_human_metrics_${randomUUID().replaceAll('-', '')}`;
const site = randomUUID();
const actor = randomUUID();
const range = {
  startDate: new Date('2026-10-26T00:00:00Z'),
  endDate: new Date('2026-10-26T23:59:59.999Z'),
  timezone: 'UTC',
};
let client: Client;
let stats: typeof import('@/queries/sql/getWebsiteStats').getWebsiteStats;
let human: typeof import('./analytics').getHumanFacts;
let population: typeof import('./browser-population').readBrowserPopulation;
let snapshot: typeof import('./query-snapshot').withinQuerySnapshot;
let totals: typeof import('./traffic-quality').qualityTotals;
const executor = {
  $queryRawUnsafe: async (sql: string, ...values: any[]) => (await client.query(sql, values)).rows,
  $executeRawUnsafe: async (sql: string, ...values: any[]) =>
    (await client.query(sql, values)).rowCount,
};

describe.skipIf(!target)('human metrics use one evidence-qualified browser population', () => {
  beforeAll(async () => {
    const url = new URL(target);
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('Local test database required');
    url.searchParams.set('schema', schema);
    process.env.DATABASE_URL = url.toString();
    client = new Client({
      connectionString: target,
      types: {
        getTypeParser: (oid, format) => (oid === 20 ? BigInt : types.getTypeParser(oid, format)),
      },
    });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    for (const path of ['prisma/migrations', 'db/liekan/migrations']) {
      for (const file of (await readdir(path))
        .filter(f => (path.startsWith('prisma') ? /^\d/.test(f) : f.endsWith('.sql')))
        .sort()) {
        const source = await readFile(
          `${path}/${file}${path.startsWith('prisma') ? '/migration.sql' : ''}`,
          'utf8',
        );
        await client.query('BEGIN');
        for (const statement of sqlStatements(source)) await client.query(statement);
        await client.query('COMMIT');
      }
    }
    await client.query(
      `INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$1::text,'fixture','admin')`,
      [actor],
    );
    await client.query('INSERT INTO website(website_id,name,domain,user_id) VALUES($1,$2,$3,$4)', [
      site,
      'Isolated human regression',
      'human.invalid',
      actor,
    ]);
    const add = async (
      count: number,
      classification: string,
      source: string,
      scope: string | null,
      available: boolean,
      offset: number,
      type = 1,
      sessionId = randomUUID(),
    ) => {
      await client.query(
        `INSERT INTO session(session_id,website_id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [sessionId, site, range.startDate],
      );
      for (let index = 0; index < count; index++) {
        const id = randomUUID();
        await client.query(
          `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,event_type,url_path,event_name,hostname)
          VALUES($1,$2,$3,$3,$4,$5,'/',CASE WHEN $5=2 THEN 'signup' ELSE NULL END,'human.invalid')`,
          [id, site, sessionId, new Date(+range.startDate + offset + index * 10000), type],
        );
        await client.query(
          `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status,hostname)
          VALUES($1,$2,$3,$4,'{}','traffic-quality-v4','missing','human.invalid')`,
          [id, site, classification, source],
        );
        if (scope)
          await client.query(
            `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser,os,device)
          VALUES($1,$2,$3,'cookieless-trusted-input-v2',$4,'Chrome','Windows','desktop')`,
            [id, site, scope, available],
          );
      }
      return sessionId;
    };
    const first = await add(2, 'browser', 'browser', 'browser', true, 0);
    await add(1, 'browser', 'browser', 'browser', true, 20000, 2, first);
    const second = await add(1, 'browser', 'browser', 'browser', true, 30000);
    // A legacy custom event sharing a session must not erase a real bounce or all UV.
    await add(1, 'browser', 'browser', null, false, 40000, 2, second);
    await add(50, 'browser', 'browser', 'browser_unresolved', false, 60000);
    await add(20, 'unknown', 'browser', 'browser', true, 120000);
    await add(10, 'browser', 'browser', null, false, 180000);
    await add(30, 'automated', 'browser', 'browser_automated', false, 240000);
    await add(10, 'browser', 'authenticated_server', 'authenticated_server', false, 300000);
    await add(10, 'suspected', 'legacy_override', 'legacy_override', false, 360000);
    ({ getWebsiteStats: stats } = await import('@/queries/sql/getWebsiteStats'));
    ({ getHumanFacts: human } = await import('./analytics'));
    ({ readBrowserPopulation: population } = await import('./browser-population'));
    ({ withinQuerySnapshot: snapshot } = await import('./query-snapshot'));
    ({ qualityTotals: totals } = await import('./traffic-quality'));
  }, 60000);

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
    const { default: prisma } = await import('@/lib/prisma');
    await prisma.client.$disconnect();
  });

  it('matches Umami whole-window visitor, visit, bounce and first/last-PV formulas on qualified events', async () => {
    const result = await snapshot({ ...executor }, () => stats(site, range));
    expect(Number(result.pageviews)).toBe(3);
    expect(Number(result.visitors)).toBe(2);
    expect(Number(result.visits)).toBe(2);
    expect(Number(result.bounces)).toBe(1);
    expect(Number(result.totaltime)).toBe(10);
  });

  it('keeps source, trend, environment, page and new-visitor facts on that same population', async () => {
    const result = await snapshot({ ...executor }, () =>
      human(site, range.startDate, range.endDate, 'UTC', [
        'daily',
        'sources',
        'pages',
        'environment',
        'newVisitors',
      ]),
    );
    expect(result.daily).toMatchObject([{ pv: 3, uv: 2, sessions: 2, bounces: 1 }]);
    expect(result.pages).toMatchObject([{ pv: 3, uv: 2 }]);
    expect(result.sources).toMatchObject([{ pv: 3, sessions: 2, bounces: 1 }]);
    expect(result.environment).toMatchObject([{ sessions: 2 }]);
    expect(result.newVisitors).toBe(2);
  });

it('returns trend coverage for its own window, including unavailable event ranges', async () => {
  const { getHumanDays } = await import('./analytics');
  const actual = await snapshot({ ...executor }, () =>
    getHumanDays(site, range.startDate, range.endDate, 'UTC'),
  );
  expect(actual.rows).toMatchObject([{ pv: 3, uv: 2 }]);
  expect(actual.population.identity.qualifiedVersions).toEqual(['cookieless-trusted-input-v2']);
  const missingStart = new Date(+range.startDate + 60000);
  const missing = await snapshot({ ...executor }, () =>
    getHumanDays(site, missingStart, range.endDate, 'UTC'),
  );
  expect(missing.rows).toEqual([]);
  expect(missing.population.identity.status).toBe('unavailable');
  expect(missing.population.identity.qualifiedVersions).toEqual([]);
  expect(missing.population.range.startAt).toBe(+missingStart);
});
  it('retains missing-input coverage while allowing explicitly scoped qualified metrics', async () => {
    const result = await population(site, range.startDate, range.endDate, 'UTC', { ...executor });
    expect(result).toMatchObject({
      metricScope: 'qualified-browser',
      identity: { status: 'partial', eligiblePV: 83, qualifiedPV: 3, qualifiedVisitors: 2 },
    });
    const { identityUsable } = await import('../contracts/browser-population');
    expect(identityUsable(result)).toBe(true);
  });

  it('preserves every raw event and reconciles policy preview with the report population', async () => {
    const current = await totals(executor, site, {
      startAt: +range.startDate,
      endAt: +range.endDate,
      timezone: 'UTC',
      page: 1,
    });
    const preview = await totals(
      executor,
      site,
      { startAt: +range.startDate, endAt: +range.endDate, timezone: 'UTC', page: 1 },
      { mode: 'standard', allowedHostnames: [] },
    );
    expect(current).toMatchObject({ rawPV: 133, includedPV: 3, includedUV: 2 });
    expect(preview).toMatchObject({ rawPV: 133, includedPV: 3, includedUV: 2 });
  });

  it('distinguishes identity-unavailable collected events from an empty window', async () => {
    const unavailable = await snapshot({ ...executor }, () =>
      stats(site, { ...range, startDate: new Date(+range.startDate + 60000) }),
    );
    expect(unavailable).toMatchObject({
      visitors: null,
      visits: null,
      bounces: null,
      totaltime: null,
      population: {
        metricScope: 'qualified-browser',
        identity: { status: 'unavailable', qualifiedPV: 0 },
      },
    });
    const empty = await snapshot({ ...executor }, () =>
      stats(site, {
        ...range,
        startDate: new Date(+range.endDate + 1),
        endDate: new Date(+range.endDate + 86400000),
      }),
    );
    expect(Number(empty.pageviews)).toBe(0);
    expect(Number(empty.visitors)).toBe(0);
    expect(empty.population.identity.status).toBe('empty');
  });

  it.each(['link', 'pixel'] as const)(
    'retains native %s counting without website identity requirements',
    async resource => {
      const id = randomUUID(),
        session = randomUUID(),
        event = randomUUID();
      if (resource === 'link')
        await client.query(
          `INSERT INTO link(link_id,name,url,slug) VALUES($1::uuid,'Fixture link','https://human.invalid/',$1::text)`,
          [id],
        );
      else
        await client.query(
          `INSERT INTO pixel(pixel_id,name,slug) VALUES($1::uuid,'Fixture pixel',$1::text)`,
          [id],
        );
      await client.query(`INSERT INTO session(session_id,website_id,created_at) VALUES($1,$2,$3)`, [
        session,
        id,
        range.startDate,
      ]);
      await client.query(
        `INSERT INTO website_event(event_id,website_id,session_id,visit_id,event_type,created_at,url_path) VALUES($1,$2,$3,$3,$4,$5,'/')`,
        [event, id, session, resource === 'link' ? 3 : 4, range.startDate],
      );
      const result = await snapshot({ ...executor }, () => stats(id, range));
      expect(Number(result.pageviews)).toBe(1);
      expect(Number(result.visitors)).toBe(1);
      expect(result.population.resourceKind).toBe(resource);
      expect(result.population.metricScope).toBeUndefined();
    },
  );

  it('keeps persisted and raw-gap reads identical, including missing-input coverage', async () => {
    const api = await import('./analysis-rollups');
    const expected = await population(site, range.startDate, range.endDate, 'UTC', { ...executor });
    const build = await api.createAnalysisBuild(
      site,
      { userId: actor },
      {
        startDate: range.startDate,
        endDate: new Date(+range.startDate + 3600000),
        timezone: 'UTC',
        locale: 'zh-CN',
        requestId: randomUUID(),
      },
    );
    let completed = false;
    for (let index = 0; index < 20; index++) {
      await api.runOneAnalysisWorkUnit(build.id);
      const {
        rows: [row],
      } = await client.query(`SELECT status,error_code FROM liekan_analysis_build WHERE id=$1`, [
        build.id,
      ]);
      if (row.status === 'completed') {
        completed = true;
        break;
      }
      if (['failed', 'invalidated', 'capacity_limited'].includes(row.status))
        throw new Error(`Fixture build failed: ${row.status}/${row.error_code}`);
    }
    expect(completed).toBe(true);
    const covered = await api.readAnalysisVisitPopulation(
      { websiteId: site, ...range },
      { ...executor },
    );
    expect(covered).not.toBeNull();
    expect(covered.identity).toEqual(expected.identity);
    expect(covered.metricScope).toBe('qualified-browser');
    const accelerated = await api.readAnalysisVisitTotals({ websiteId: site, ...range });
    expect(accelerated).toMatchObject({
      pageviews: 3,
      visitors: 2,
      visits: 2,
      bounces: 1,
      totaltime: 10,
    });
    const actual = await snapshot({ ...executor }, () =>
      human(site, range.startDate, range.endDate, 'UTC', ['daily', 'pages', 'newVisitors']),
    );
    expect(actual.daily).toMatchObject([{ pv: 3, uv: 2, sessions: 2, bounces: 1 }]);
    expect(actual.newVisitors).toBe(2);
    await client.query(
      `UPDATE liekan_analysis_manifest SET versions=jsonb_set(versions,'{traffic}','"traffic-quality-browser-population-v4"') WHERE website_id=$1`,
      [site],
    );
    expect(await api.readAnalysisVisitTotals({ websiteId: site, ...range })).toBeNull();
  }, 30000);
});
