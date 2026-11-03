// @vitest-environment node
import { ANALYSIS_ROLLUP_VERSION } from './analysis-rollups-model';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserPopulation } from '../contracts/browser-population';
import type { AnalysisBuildDto } from './analysis-rollups-model';

const enabled = process.env.LIEKAN_ANALYSIS_ROLLUPS_TEST === '1';
const actor = { userId: randomUUID() };
const startDate = new Date('2026-01-01T00:00Z'),
  endDate = new Date('2026-01-01T02:00Z');
let client: Client, site: string, session: string;
let api: typeof import('./analysis-rollups'), db: typeof import('./analysis-rollups-db');
let population: typeof import('./browser-population');
let prisma: typeof import('@/lib/prisma').default;
const sites: string[] = [];
const q = <T = any[]>(sql: string, ...values: unknown[]) =>
  db.analysisTransaction(tx => tx.$queryRawUnsafe<T>(sql, ...values));
const execute = (sql: string, ...values: unknown[]) =>
  db.analysisTransaction(tx => tx.$executeRawUnsafe(sql, ...values));
const save = (name: string, value: unknown) =>
  writeFile(
    `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/${name}.json`,
    JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v), 2),
    { mode: 0o600 },
  );
type Plan = Record<string, any> & { Plans?: Plan[] };
const nodes = (node: Plan): Plan[] => [node, ...(node.Plans || []).flatMap(nodes)];

async function event(
  at: string,
  options: {
    type?: number;
    available?: boolean;
    browser?: string;
    identityVersion?: string;
    ruleVersion?: string;
    catalogVersion?: string | null;
    environment?: boolean;
    visit?: string;
  } = {},
) {
  const id = randomUUID();
  await client.query('BEGIN');
  try {
    await client.query('SELECT website_id FROM website WHERE website_id=$1 FOR UPDATE', [site]);
    await client.query(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,event_type,url_path,hostname)
      VALUES($1,$2,$3,$6,$4,$5,'/synthetic','population.invalid')`,
      [id, site, session, at, options.type || 1, options.visit || session],
    );
    if (options.environment !== false)
      await client.query(
        `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser,os,device,screen,language,origin_hostname)
        VALUES($1,$2,'browser',$3,$4,$5,'event-os','event-device','1280x720','zh-CN','population.invalid')`,
        [
          id,
          site,
          options.identityVersion || 'identity-fixture',
          options.available !== false,
          options.browser || 'Firefox',
        ],
      );
    await client.query(
      `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status,hostname,catalog_version)
      VALUES($1,$2,'browser','browser','{}',$3,'missing','population.invalid',$4)`,
      [id, site, options.ruleVersion || 'rule-fixture', options.catalogVersion || null],
    );
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
  }
  return id;
}
async function finish(build: AnalysisBuildDto) {
  for (let i = 0; i < 80; i++) {
    const [row] = await q('SELECT status FROM liekan_analysis_build WHERE id=$1', build.id);
    if (row.status === 'completed') return;
    if (['failed', 'capacity_limited', 'invalidated'].includes(row.status))
      throw new Error(`population-build-${row.status}`);
    await api.runOneAnalysisWorkUnit(build.id);
  }
  throw new Error('population-build-unfinished');
}
async function build(from = startDate, until = endDate) {
  const result = await api.createAnalysisBuild(site, actor, {
    startDate: from,
    endDate: until,
    timezone: 'Asia/Kathmandu',
    locale: 'en-US',
    requestId: randomUUID(),
  });
  await finish(result);
  return result;
}
/** Independent raw SQL deliberately avoids the new population reader and derived facts. */
async function oracle(start = startDate, end = endDate, halfOpen = true) {
  const [row] = await q(
    `WITH p AS MATERIALIZED (
    SELECT e.*,env.identity_version,q.rule_version,q.catalog_version,
     coalesce(e.event_type IN(3,4) OR (env.scope='browser' AND env.identity_available AND present.session_id IS NOT NULL AND q.source='browser' AND q.classification='browser'),false) AS liekan_identity_available
    FROM liekan_observed_website_event e
    LEFT JOIN session present ON present.session_id=e.session_id AND present.website_id=e.website_id
    LEFT JOIN liekan_event_environment env ON env.website_id=e.website_id AND env.event_id=e.event_id
    LEFT JOIN liekan_reporting_event_quality q ON q.website_id=e.website_id AND q.event_id=e.event_id
    WHERE e.website_id=$1 AND e.created_at>=$2 AND e.created_at${halfOpen ? '<' : '<='}$3
   ) SELECT count(*)::int AS events,count(*) FILTER(WHERE liekan_identity_available)::int AS qualified,
    count(*) FILTER(WHERE event_type IN(1,3,4))::int AS pv,
    count(*) FILTER(WHERE event_type IN(1,3,4) AND liekan_identity_available)::int AS qualified_pv,
    count(DISTINCT session_id) FILTER(WHERE event_type IN(1,3,4) AND liekan_identity_available)::int AS visitors,
    ARRAY(SELECT DISTINCT identity_version FROM p WHERE identity_version IS NOT NULL ORDER BY 1 LIMIT 33) AS identities,
    ARRAY(SELECT DISTINCT identity_version FROM p WHERE identity_version IS NOT NULL AND liekan_identity_available AND event_type IN(1,3,4) ORDER BY 1 LIMIT 33) AS qualified_identities,
    ARRAY(SELECT DISTINCT rule_version FROM p WHERE rule_version IS NOT NULL ORDER BY 1 LIMIT 33) AS rules,
    ARRAY(SELECT DISTINCT catalog_version::text FROM p WHERE catalog_version IS NOT NULL ORDER BY 1 LIMIT 33) AS catalogs
   FROM p`,
    site,
    start,
    end,
  );
  return row;
}
function expectPopulation(actual: BrowserPopulation, expected: Awaited<ReturnType<typeof oracle>>) {
  expect(actual.identity).toMatchObject({
    status: !expected.events
      ? 'empty'
      : expected.events === expected.qualified
        ? 'complete'
        : expected.qualified
          ? 'partial'
          : 'unavailable',
    eligibleEvents: expected.events,
    eligiblePV: expected.pv,
    qualifiedPV: expected.qualified_pv,
    qualifiedVisitors: expected.visitors,
    versions: expected.identities.slice(0, 32),
    qualifiedVersions: expected.qualified_identities.slice(0, 32),
    coverage: expected.pv ? expected.qualified_pv / expected.pv : null,
  });
  expect(actual.metricScope).toBe('qualified-browser');
  expect(actual.ruleVersions).toEqual(expected.rules.slice(0, 32));
  expect(actual.catalogVersions).toEqual(expected.catalogs.slice(0, 32));
  expect(actual.versionSetsTruncated).toBe(
    [expected.identities, expected.rules, expected.catalogs].some(v => v.length > 32),
  );
}

describe.skipIf(!enabled)('browser population facts in an owned PostgreSQL schema', () => {
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
    db = await import('./analysis-rollups-db');
    api = await import('./analysis-rollups');
    population = await import('./browser-population');
    ({ default: prisma } = await import('@/lib/prisma'));
    await execute(
      `INSERT INTO "user"(user_id,username,password,role)VALUES($1::uuid,$1::text,'fixture','user')`,
      actor.userId,
    );
  });
  beforeEach(async () => {
    site = randomUUID();
    session = randomUUID();
    sites.push(site);
    await execute(
      `INSERT INTO website(website_id,user_id,name,domain)VALUES($1,$2,'Synthetic population regression','population.invalid')`,
      site,
      actor.userId,
    );
    await execute(
      `INSERT INTO session(session_id,website_id,browser,os,device,country)VALUES($1,$2,'Session Chrome','session-os','session-device','CN')`,
      session,
      site,
    );
  });
  afterEach(async () => {
    if (site)
      await execute("UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id=$1", site);
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
      await client.query('DELETE FROM website_event WHERE website_id=ANY($1::uuid[])', [sites]);
      await client.query('DELETE FROM session WHERE website_id=ANY($1::uuid[])', [sites]);
      await client.query('DELETE FROM website WHERE website_id=ANY($1::uuid[])', [sites]);
      await client.query('DELETE FROM "user" WHERE user_id=$1', [actor.userId]);
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK');
      await client.end();
      await prisma?.client.$disconnect();
    }
  });

  it('returns event-owned dimensions through the existing covered metrics API', async () => {
    await event('2026-01-01T00:10Z', { browser: 'Firefox' });
    await event('2026-01-01T01:10Z', { browser: 'Safari' });
    await event('2026-01-01T01:20Z', { type: 5, available: false });
    await build();
    const native = await q(
      `SELECT e.liekan_browser AS x,count(DISTINCT e.session_id)::int AS y FROM liekan_geographic_website_event e
      WHERE e.website_id=$1 AND e.created_at BETWEEN $2 AND $3 AND e.event_type NOT IN(2,5) GROUP BY 1 ORDER BY 1`,
      site,
      startDate,
      endDate,
    );
    const covered = await api.readAnalysisVisitMetrics({
      websiteId: site,
      startDate,
      endDate,
      type: 'browser',
    });
    const expected = await oracle();
    await save('population-event-owned-metrics', { native, covered, expected });
    expect(expected).toMatchObject({ events: 3, qualified: 2, pv: 2, visitors: 1 });
    expect(covered?.sort((a, b) => a.x.localeCompare(b.x))).toEqual(native);
  });

  it.each([3, 4])(
    'preserves native link/pixel type %i values without a website rollup identity',
    async type => {
      const resource = randomUUID(),
        legacySession = randomUUID();
      try {
        await execute(
          type === 3
            ? "INSERT INTO link(link_id,name,url,slug) VALUES($1,'Synthetic compatible link','https://population.invalid/',$2)"
            : "INSERT INTO pixel(pixel_id,name,slug) VALUES($1,'Synthetic compatible pixel',$2)",
          resource,
          randomUUID(),
        );
        await execute(
          "INSERT INTO session(session_id,website_id,browser) VALUES($1,$2,'Compatible browser')",
          legacySession,
          resource,
        );
        await execute(
          "INSERT INTO website_event(event_id,website_id,session_id,visit_id,event_type,url_path,created_at) VALUES($1,$2,$3,$4,$5,'/synthetic-compatible','2026-01-01T00:10Z')",
          randomUUID(),
          resource,
          legacySession,
          randomUUID(),
          type,
        );
        const [raw] = await q(
          'SELECT count(*)::int AS events FROM liekan_geographic_website_event WHERE website_id=$1 AND created_at BETWEEN $2 AND $3',
          resource,
          startDate,
          endDate,
        );
        expect(raw.events).toBe(1);
        const { getWebsiteStats } = await import('@/queries/sql/getWebsiteStats');
        const { getSessionMetrics } = await import('@/queries/sql/sessions/getSessionMetrics');
        const stats = await getWebsiteStats(resource, { startDate, endDate });
        const metrics = await getSessionMetrics(
          resource,
          { type: 'browser' },
          { startDate, endDate },
        );
        await save(`population-compatible-${type}`, { raw, stats, metrics });
        expect(
          Object.fromEntries(
            ['pageviews', 'visitors', 'visits', 'bounces', 'totaltime'].map(key => [
              key,
              Number(stats[key]),
            ]),
          ),
        ).toEqual({ pageviews: 1, visitors: 1, visits: 1, bounces: 1, totaltime: 0 });
        expect(metrics.map(row => ({ ...row, y: Number(row.y) }))).toEqual([
          { x: 'Compatible browser', y: 1 },
        ]);
        const input = { websiteId: resource, startDate, endDate };
        expect(await api.readAnalysisVisitPopulation(input)).toBeNull();
        expect(await api.readAnalysisVisitTotals(input)).toBeNull();
        expect(await api.readAnalysisVisitMetrics({ ...input, type: 'browser' })).toBeNull();
        expect(await api.readAnalysisLogRollup(input)).toBeNull();
        expect(await api.readAnalysisLogSeries({ ...input, grain: 'hour' })).toBeNull();
        await expect(
          db.analysisTransaction(tx => db.analysisVersions(tx, resource)),
        ).rejects.toMatchObject({ status: 404 });
      } finally {
        await execute('DELETE FROM website_event WHERE website_id=$1', resource);
        await execute('DELETE FROM session WHERE session_id=$1', legacySession);
        await execute(
          type === 3 ? 'DELETE FROM link WHERE link_id=$1' : 'DELETE FROM pixel WHERE pixel_id=$1',
          resource,
        );
      }
    },
  );

  it.each(['missing', 'foreign'])('keeps %s session identities outside the qualified cohort before and after building', async kind => {
    const regular = session;
    session = randomUUID();
    if (kind === 'foreign') {
      const foreign = randomUUID();
      sites.push(foreign);
      await execute("INSERT INTO website(website_id,user_id,name,domain) VALUES($1,$2,'Foreign fixture','foreign.invalid')", foreign, actor.userId);
      await execute('INSERT INTO session(session_id,website_id) VALUES($1,$2)', session, foreign);
    }
    const orphanSession = session;
    const orphan = await event('2026-01-01T00:10Z', { identityVersion: 'orphan-identity' });
    const before = await population.readBrowserPopulation(site, startDate, endDate);
    expect(before.identity).toMatchObject({ status: 'unavailable', eligibleEvents: 1, eligiblePV: 1, qualifiedPV: 0, qualifiedVisitors: 0, coverage: 0, qualifiedVersions: [] });
    session = regular;
    await event('2026-01-01T00:20Z');
    const mixed = await population.readBrowserPopulation(site, startDate, endDate);
    expect(mixed.identity).toMatchObject({ status: 'partial', eligiblePV: 2, qualifiedPV: 1, qualifiedVisitors: 1, coverage: 0.5, qualifiedVersions: ['identity-fixture'] });
    await build();
    expect((await population.readBrowserPopulation(site, startDate, endDate)).identity).toEqual(mixed.identity);
    expect(await api.readAnalysisVisitTotals({ websiteId: site, startDate, endDate })).toMatchObject({ pageviews: 1, visitors: 1 });
    expect((await q('SELECT identity_available FROM liekan_event_environment WHERE event_id=$1', orphan))[0].identity_available).toBe(true);
    if (kind === 'missing') {
      await execute('INSERT INTO session(session_id,website_id) VALUES($1,$2)', orphanSession, site);
      expect((await population.readBrowserPopulation(site, startDate, endDate)).identity).toMatchObject({ status: 'complete', eligiblePV: 2, qualifiedPV: 2, qualifiedVisitors: 2, coverage: 1 });
    }
  });
  it('uses covered facts for the existing whole-window population API without executing raw scans', async () => {
    await event('2026-01-01T00:10Z');
    await event('2026-01-01T01:10Z', {
      type: 2,
      available: false,
      identityVersion: 'custom-identity',
    });
    await event('2026-01-01T01:20Z', {
      type: 5,
      available: false,
      identityVersion: 'performance-identity',
    });
    await build();
    const expected = await oracle();
    const captured: { sql: string; values: unknown[] }[] = [];
    const executor = {
      async $queryRawUnsafe(sql: string, ...values: unknown[]) {
        captured.push({ sql, values });
        return (await client.query(sql, values)).rows;
      },
      async $executeRawUnsafe(sql: string, ...values: unknown[]) {
        return (await client.query(sql, values)).rowCount;
      },
    };
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await client.query("SET LOCAL statement_timeout='5s'");
      const actual = await population.readBrowserPopulation(
        site,
        startDate,
        endDate,
        'Asia/Kathmandu',
        executor,
        { halfOpen: true },
      );
      expectPopulation(actual, expected);
      const plans: Plan[] = [];
      for (const item of captured)
        plans.push(
          (
            await client.query(
              'EXPLAIN(ANALYZE,BUFFERS,VERBOSE,TIMING OFF,FORMAT JSON)' + item.sql,
              item.values,
            )
          ).rows[0]['QUERY PLAN'][0].Plan,
        );
      const raw = plans.flatMap(nodes).filter(node => node['Relation Name'] === 'website_event');
      const rawVisits = raw.reduce(
        (sum, node) => sum + node['Actual Rows'] * node['Actual Loops'],
        0,
      );
      const derived = plans
        .flatMap(nodes)
        .filter(
          node =>
            String(node['Relation Name'] || '').startsWith('liekan_analysis_visit_') &&
            node['Actual Rows'] > 0 &&
            node['Actual Loops'] > 0,
        );
      await save('population-covered-plans', {
        expected,
        actual,
        captured,
        plans,
        rawVisits,
        derived,
      });
      expect(raw.length).toBeGreaterThan(0);
      expect(derived.length).toBeGreaterThan(0);
      expect(rawVisits).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('keeps half-open and inclusive microsecond edges separate with exact dirty gaps', async () => {
    await event('2026-01-01T00:10Z');
    await event('2026-01-01T02:00:00Z', { type: 2, available: false });
    await event('2026-01-01T02:00:00.000001Z', { type: 5, available: false });
    await build();
    const executor = {
      async $queryRawUnsafe(sql: string, ...values: unknown[]) {
        return (await client.query(sql, values)).rows;
      },
    };
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      const half = await population.readBrowserPopulation(
        site,
        startDate,
        endDate,
        'Asia/Kathmandu',
        executor,
        { halfOpen: true },
      );
      const inclusive = await population.readBrowserPopulation(
        site,
        startDate,
        endDate,
        'Asia/Kathmandu',
        executor,
      );
      expectPopulation(half, await oracle(startDate, endDate, true));
      expectPopulation(inclusive, await oracle(startDate, endDate, false));
      expect(half.identity.status).toBe('complete');
      expect(inclusive.identity.status).toBe('partial');
      expect(inclusive.identity.eligibleEvents).toBe(2);
      expect(half.range.endExclusive).toBe(true);
      expect(inclusive.range.endExclusive).toBeUndefined();
    } finally {
      await client.query('ROLLBACK');
    }
    await event('2026-01-01T01:00:00.000001Z', { type: 5, environment: false });
    const partial = await population.readBrowserPopulation(
      site,
      new Date('2026-01-01T00:15Z'),
      new Date('2026-01-01T01:30Z'),
      'Asia/Kathmandu',
    );
    expectPopulation(
      partial,
      await oracle(new Date('2026-01-01T00:15Z'), new Date('2026-01-01T01:30Z'), false),
    );
    expect(partial.identity).toMatchObject({
      status: 'unavailable',
      eligibleEvents: 1,
      eligiblePV: 0,
    });
  });

  it('counts custom-only and performance-only evidence before PV grouping and bounds all version sets', async () => {
    for (let index = 0; index < 32; index++)
      await event(`2026-01-01T00:${String(index).padStart(2, '0')}:00Z`, {
        type: index % 2 ? 2 : 5,
        available: true,
        identityVersion: `identity-${String(index).padStart(2, '0')}`,
        ruleVersion: `rule-${String(index).padStart(2, '0')}`,
        catalogVersion: randomUUID(),
      });
    await build();
    const exactly32 = await population.readBrowserPopulation(site, startDate, endDate);
    expect(exactly32.identity.versions).toHaveLength(32);
    expect(exactly32.ruleVersions).toHaveLength(32);
    expect(exactly32.catalogVersions).toHaveLength(32);
    expect(exactly32.versionSetsTruncated).toBe(false);
    await event('2026-01-01T00:32Z', {
      type: 5,
      available: false,
      identityVersion: 'identity-32',
      ruleVersion: 'rule-32',
      catalogVersion: randomUUID(),
    });
    await build();
    const expected = await oracle();
    const actual = await population.readBrowserPopulation(
      site,
      startDate,
      endDate,
      'UTC',
      undefined,
      { halfOpen: true },
    );
    expectPopulation(actual, expected);
    expect(actual.identity).toMatchObject({
      status: 'partial',
      eligibleEvents: 33,
      eligiblePV: 0,
      qualifiedPV: 0,
      qualifiedVisitors: 0,
      coverage: null,
    });
    expect(actual.versionSetsTruncated).toBe(true);
    expect(actual.identity.versions).toHaveLength(32);
    const [facts] = await q(
      `SELECT sum(f.eligible_events)::int AS events,sum(f.pageviews)::int AS pv
      FROM liekan_analysis_visit f JOIN liekan_analysis_manifest m ON m.website_id=f.website_id AND m.generation=f.generation
      WHERE f.website_id=$1 AND m.family='visit'`,
      site,
    );
    expect(facts).toEqual({ events: 33, pv: 0 });
    expect(
      await api.readAnalysisVisitTotals({ websiteId: site, startDate, endDate }),
    ).toMatchObject({ pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0 });
  });

  it('strongly fences environment corrections while normal new visits preserve closed coverage', async () => {
    const id = await event('2026-01-01T00:10Z');
    await build();
    const readState = async () =>
      (
        await q(
          `SELECT liekan_analysis_fingerprint($1,epoch,'visit',$2,$3) AS fingerprint,
      coalesce((SELECT revision FROM liekan_analytics_revision WHERE resource_type='website' AND resource_id=$1),0)::text AS revision
      FROM liekan_analysis_site WHERE website_id=$1`,
          site,
          startDate,
          endDate,
        )
      )[0];
    const before = await readState();
    await event(new Date().toISOString(), { visit: randomUUID() });
    expect(await readState()).toEqual(before);
    await execute(
      "UPDATE liekan_event_environment SET browser='Corrected',identity_available=false WHERE event_id=$1",
      id,
    );
    const after = await readState();
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
    expectPopulation(
      await population.readBrowserPopulation(site, startDate, endDate),
      await oracle(startDate, endDate, false),
    );
    const [leaf] = await q(
      "SELECT count(*)::int AS n FROM liekan_analysis_dirty WHERE website_id=$1 AND family='visit' AND NOT isfinite(bucket)",
      site,
    );
    expect(leaf.n).toBe(0);
    await build();
    await execute('DELETE FROM liekan_event_environment WHERE event_id=$1', id);
    expectPopulation(
      await population.readBrowserPopulation(site, startDate, endDate),
      await oracle(startDate, endDate, false),
    );
  });

  it('keeps previews inert and captures current-epoch exclusions and membership atomically', async () => {
    const first = await event('2026-01-01T00:10Z'),
      second = await event('2026-01-01T01:10Z');
    await build();
    const state = async () =>
      (
        await q(
          `SELECT liekan_analysis_fingerprint($1,epoch,'visit',$2,$3) AS fingerprint,
      liekan_analysis_versions($1,'test-engine','test-traffic','test-population') AS versions,
      coalesce((SELECT revision FROM liekan_analytics_revision WHERE resource_type='website' AND resource_id=$1),0)::text AS strong
      FROM liekan_analysis_site WHERE website_id=$1`,
          site,
          startDate,
          endDate,
        )
      )[0];
    const before = await state(),
      collection = randomUUID();
    await execute(`INSERT INTO liekan_traffic_governance(website_id)VALUES($1)`, site);
    await execute(
      `INSERT INTO liekan_traffic_exclusion(id,website_id,epoch,actor_id,state,base_revision,policy_revision,rule_version,window_end,received_cutoff,membership_digest,evidence,expires_at)
      VALUES($1,$2,1,$3,'preview',0,0,'fixture',$4,$4,repeat('0',64),'{}',clock_timestamp()+interval '1 hour')`,
      collection,
      site,
      actor.userId,
      endDate,
    );
    await execute(
      'INSERT INTO liekan_traffic_exclusion_member(website_id,collection_id,event_id)VALUES($1,$2,$3)',
      site,
      collection,
      first,
    );
    expect(await state()).toEqual(before);
    await execute("UPDATE liekan_traffic_exclusion SET state='active' WHERE id=$1", collection);
    const active = await state();
    expect(active.fingerprint).not.toBe(before.fingerprint);
    expect(BigInt(active.strong)).toBeGreaterThan(BigInt(before.strong));
    expectPopulation(
      await population.readBrowserPopulation(site, startDate, endDate),
      await oracle(startDate, endDate, false),
    );
    await build();
    await execute(
      'INSERT INTO liekan_traffic_exclusion_member(website_id,collection_id,event_id)VALUES($1,$2,$3)',
      site,
      collection,
      second,
    );
    expect((await population.readBrowserPopulation(site, startDate, endDate)).identity.status).toBe(
      'empty',
    );
    await execute(
      'DELETE FROM liekan_traffic_exclusion_member WHERE collection_id=$1 AND event_id=$2',
      collection,
      second,
    );
    expectPopulation(
      await population.readBrowserPopulation(site, startDate, endDate),
      await oracle(startDate, endDate, false),
    );
    await execute("UPDATE liekan_traffic_exclusion SET state='revoked' WHERE id=$1", collection);
    expect(
      (await population.readBrowserPopulation(site, startDate, endDate)).identity.eligibleEvents,
    ).toBe(2);
    await execute(
      'UPDATE liekan_traffic_governance SET revision=9007199254740993 WHERE website_id=$1',
      site,
    );
    expect((await state()).versions.governance).toBe('9007199254740993');
    const oldEpoch = await state();
    await execute(
      "UPDATE liekan_traffic_exclusion SET state='active',epoch=0 WHERE id=$1",
      collection,
    );
    expect(await state()).toEqual(oldEpoch);
    await execute(
      'INSERT INTO liekan_traffic_exclusion_member(website_id,collection_id,event_id)VALUES($1,$2,$3)',
      site,
      collection,
      second,
    );
    expect(await state()).toEqual(oldEpoch);
    expect(
      (await population.readBrowserPopulation(site, startDate, endDate)).governanceWatermark,
    ).toBeNull();
  });
  it('merges qualified visitors across a natural day and keeps the caller repeatable-read snapshot', async () => {
    const from = new Date('2026-01-01T23:00Z'),
      until = new Date('2026-01-02T01:00Z');
    await event('2026-01-01T23:59Z');
    const second = await event('2026-01-02T00:01Z');
    await build(from, until);
    const expected = await oracle(from, until);
    const executor = {
      async $queryRawUnsafe(sql: string, ...values: unknown[]) {
        return (await client.query(sql, values)).rows;
      },
    };
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      const actual = await population.readBrowserPopulation(
        site,
        from,
        until,
        'Asia/Kathmandu',
        executor,
        { halfOpen: true },
      );
      expectPopulation(actual, expected);
      expect(actual.identity).toMatchObject({
        eligiblePV: 2,
        qualifiedVisitors: 1,
        status: 'complete',
      });
      await execute(
        'UPDATE liekan_event_environment SET identity_available=false WHERE event_id=$1',
        second,
      );
      const sameSnapshot = await api.readAnalysisVisitPopulation(
        {
          websiteId: site,
          startDate: from,
          endDate: until,
          halfOpen: true,
          timezone: 'Asia/Kathmandu',
        },
        executor as any,
      );
      expectPopulation(sameSnapshot, expected);
    } finally {
      await client.query('ROLLBACK');
    }
    expectPopulation(
      await population.readBrowserPopulation(site, from, until),
      await oracle(from, until, false),
    );
  });

  it('rejects old-engine coverage and checkpoints before publishing new population facts', async () => {
    await event('2026-01-01T00:10Z');
    await build();
    await execute(
      `UPDATE liekan_analysis_manifest SET versions=jsonb_set(versions,'{engine}','"analysis-rollups-v1"') WHERE website_id=$1 AND family='visit'`,
      site,
    );
    expect(
      await api.readAnalysisVisitPopulation({
        websiteId: site,
        startDate,
        endDate,
        halfOpen: true,
      }),
    ).toBeNull();
    expectPopulation(
      await population.readBrowserPopulation(site, startDate, endDate),
      await oracle(startDate, endDate, false),
    );
    const task = await api.createAnalysisBuild(site, actor, {
      startDate,
      endDate,
      timezone: 'UTC',
      locale: 'en-US',
      requestId: randomUUID(),
    });
    const proof = await db.analysisTransaction(async tx => {
      const versions = await db.analysisVersions(tx, site);
      return {
        versions: { ...versions, engine: 'analysis-rollups-v1' },
        ...(
          await tx.$queryRawUnsafe<any[]>(
            `SELECT liekan_analysis_fingerprint($1,epoch,'visit',$2,$3) AS fingerprint FROM liekan_analysis_site WHERE website_id=$1`,
            site,
            startDate,
            new Date(+startDate + 3600000),
          )
        )[0],
      };
    });
    const generation = randomUUID();
    await execute(
      'UPDATE liekan_analysis_build SET checkpoint=$2::jsonb,work_done=1 WHERE id=$1',
      task.id,
      JSON.stringify({
        hour: startDate.toISOString(),
        family: 'visit',
        generation,
        spanEnd: new Date(+startDate + 3600000).toISOString(),
        fingerprint: proof.fingerprint,
        versions: proof.versions,
        afterId: '__publish__',
        rows: '0',
      }),
    );
    await api.runOneAnalysisWorkUnit(task.id);
    const [cleared] = await q('SELECT checkpoint FROM liekan_analysis_build WHERE id=$1', task.id);
    expect(cleared.checkpoint.generation).toBeUndefined();
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_manifest WHERE website_id=$1 AND generation=$2',
          site,
          generation,
        )
      )[0].n,
    ).toBe(0);
    await finish(task);
    expectPopulation(
      await population.readBrowserPopulation(site, startDate, endDate),
      await oracle(startDate, endDate, false),
    );
  });

  it('captures qualified environment writes on a fresh default-search-path Prisma connection', async () => {
    const id = await event('2026-01-01T00:10Z', { environment: false });
    await build();
    const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
    await prisma.client.$disconnect();
    expect(await prisma.client.$queryRawUnsafe('SHOW search_path')).toEqual([
      { search_path: '"$user", public' },
    ]);
    await prisma.client.$executeRawUnsafe(
      `INSERT INTO "${schema}".liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser)
      VALUES($1::uuid,$2::uuid,'browser','fresh-schema',true,'Fresh')`,
      id,
      site,
    );
    expectPopulation(
      await population.readBrowserPopulation(site, startDate, endDate),
      await oracle(startDate, endDate, false),
    );
    expect((await population.readBrowserPopulation(site, startDate, endDate)).identity.status).toBe(
      'complete',
    );
    const [marker] = await q(
      `SELECT count(*)::int AS n FROM liekan_analysis_dirty WHERE website_id=$1 AND family='visit' AND bucket=$2`,
      site,
      startDate,
    );
    expect(marker.n).toBeGreaterThan(0);
  });

  it('uses a verified compressed empty span for contained subwindows through existing readers', async () => {
    await build(startDate, new Date('2026-01-04T00:00Z'));
    const from = new Date('2026-01-01T06:00Z'),
      until = new Date('2026-01-01T12:00Z');
    const manifests = await q(
      'SELECT family,bucket,bucket_end,row_count FROM liekan_analysis_manifest WHERE website_id=$1 ORDER BY family,bucket',
      site,
    );
    expect(manifests.every(m => m.row_count === 0n)).toBe(true);
    expect(manifests.some(m => +m.bucket < +from && +m.bucket_end > +until)).toBe(true);
    const totals = await api.readAnalysisVisitTotals({
      websiteId: site,
      startDate: from,
      endDate: until,
    });
    const meta = await api.readAnalysisVisitPopulation({
      websiteId: site,
      startDate: from,
      endDate: until,
      halfOpen: true,
    });
    const logs = await api.readAnalysisLogRollup({
      websiteId: site,
      startDate: from,
      endDate: until,
      crawlerMetricsVersion: 1,
      fields: ['statuses'],
    });
    await save('population-empty-subwindow', { manifests, totals, meta, logs });
    expect(totals).toEqual({ pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0 });
    expect(meta?.identity.status).toBe('empty');
    expect(logs?.coverage.rawFallback).toBe(false);
  });

  it('remeasures a completed day after a same-version late correction and rebuild', async () => {
    const ids: string[] = [];
    for (const day of ['01', '02', '03'])
      for (let index = 0; index < 4; index++)
        ids.push(await event(`2026-01-${day}T00:${String(index).padStart(2, '0')}:00Z`));
    const until = new Date('2026-01-04T00:00Z');
    await build(startDate, until);
    const { probeAnalysisExpansion } = await import('./analysis-expansion');
    for (let index = 0; index < 3; index++) await probeAnalysisExpansion(site);
    const before = await q(
      "SELECT * FROM liekan_analysis_probe WHERE website_id=$1 AND family='visit' ORDER BY day",
      site,
    );
    expect(before).toHaveLength(3);
    expect(before.every(p => p.compared && p.input_rows === 4n && p.derived_rows === 1n)).toBe(
      true,
    );
    await execute(
      'UPDATE liekan_event_environment SET identity_available=false WHERE event_id=$1',
      ids[8],
    );
    await build(startDate, until);
    await probeAnalysisExpansion(site);
    const after = await q(
      "SELECT * FROM liekan_analysis_probe WHERE website_id=$1 AND family='visit' ORDER BY day",
      site,
    );
    await save('population-probe-late-correction', { before, after });
    expect(after[2].versions).toEqual(before[2].versions);
    expect(after[2].fingerprint).not.toBe(before[2].fingerprint);
    expect(after[2]).toMatchObject({ compared: true, input_rows: 4n, derived_rows: 2n });
    expect((await population.readBrowserPopulation(site, new Date('2026-01-03T00:00Z'), until)).identity).toMatchObject({ status: 'partial', eligibleEvents: 4, eligiblePV: 4, qualifiedPV: 3, qualifiedVisitors: 1, coverage: 0.75 });
    await build(startDate, until);
    await execute(
      'UPDATE liekan_event_environment SET identity_available=true WHERE event_id=$1',
      ids[8],
    );
    await probeAnalysisExpansion(site);
    const [unavailable] = await q(
      "SELECT * FROM liekan_analysis_probe WHERE website_id=$1 AND family='visit' ORDER BY day DESC LIMIT 1",
      site,
    );
    expect(unavailable).toMatchObject({
      status: 'unavailable',
      compared: false,
      input_rows: 0n,
      derived_rows: 0n,
      raw_ms: null,
      accelerated_ms: null,
    });
    expect(unavailable.fingerprint).not.toBe(after[2].fingerprint);
    await build(startDate, until);
    await probeAnalysisExpansion(site);
    const [recovered] = await q(
      "SELECT * FROM liekan_analysis_probe WHERE website_id=$1 AND family='visit' ORDER BY day DESC LIMIT 1",
      site,
    );
    await save('population-probe-unavailable-recovery', { unavailable, recovered });
    expect(recovered).toMatchObject({ status: 'ready', compared: true, input_rows: 4n });
    expect(recovered.fingerprint).not.toBe(unavailable.fingerprint);
  });

  it('merges a nonempty covered visit with a nonempty dirty gap before applying metric filters', async () => {
    await event('2026-01-01T00:10Z', { visit: randomUUID(), browser: 'Firefox' });
    const dirty = await event('2026-01-01T01:10Z', { visit: randomUUID(), browser: 'Safari' });
    await build();
    await execute(
      'UPDATE liekan_event_environment SET identity_available=false WHERE event_id=$1',
      dirty,
    );
    const expected = await oracle(),
      captured: { sql: string; values: unknown[] }[] = [];
    const executor = {
      async $queryRawUnsafe(sql: string, ...values: unknown[]) {
        captured.push({ sql, values });
        return (await client.query(sql, values)).rows;
      },
      async $executeRawUnsafe(sql: string, ...values: unknown[]) {
        return (await client.query(sql, values)).rowCount;
      },
    };
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      const actual = await population.readBrowserPopulation(
        site,
        startDate,
        endDate,
        'UTC',
        executor,
        { halfOpen: true },
      );
      expectPopulation(actual, expected);
      expect(actual.identity).toMatchObject({
        status: 'partial',
        eligiblePV: 2,
        qualifiedPV: 1,
        qualifiedVisitors: 1,
      });
      const statement = captured.find(
        c => c.sql.includes('"qualifiedEvents"') && c.sql.includes('FROM population_facts'),
      );
      expect(statement).toBeTruthy();
      const plan = (
        await client.query(
          'EXPLAIN(ANALYZE,BUFFERS,VERBOSE,TIMING OFF,FORMAT JSON)' + statement.sql,
          statement.values,
        )
      ).rows[0]['QUERY PLAN'][0].Plan;
      const derived = nodes(plan).filter(
        n =>
          String(n['Relation Name'] || '').startsWith('liekan_analysis_visit_') &&
          n['Actual Rows'] > 0 &&
          n['Actual Loops'] > 0,
      );
      const raw = nodes(plan).filter(
        n =>
          n['Relation Name'] === 'website_event' && n['Actual Rows'] > 0 && n['Actual Loops'] > 0,
      );
      expect(derived.length).toBeGreaterThan(0);
      expect(raw.length).toBeGreaterThan(0);
      const { withinQuerySnapshot } = await import('./query-snapshot');
      const { captureBrowserPopulations } = await import('./cache-context');
      const { getSessionMetrics } = await import('@/queries/sql/sessions/getSessionMetrics');
      const filtered = await withinQuerySnapshot(executor, () =>
        captureBrowserPopulations(() =>
          getSessionMetrics(
            site,
            { type: 'browser', limit: 1, offset: 0 },
            { startDate, endDate, browser: 'eq.Firefox' },
          ),
        ),
      );
      expect(filtered.value).toEqual([{ x: 'Firefox', y: 1 }]);
      expect(
        filtered.populations.some(
          p => p.identity.eligibleEvents === 2 && p.identity.status === 'partial',
        ),
      ).toBe(true);
      await save('population-mixed-covered-raw', {
        expected,
        actual,
        captured,
        plan,
        derived,
        raw,
        filtered,
      });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it.each(['dirty', 'old-engine'] as const)(
    'lets an available older day progress when the newest %s day cannot be measured',
    async kind => {
      const original = { site, session };
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const latest = new Date(+today - 86400000),
        older = new Date(+latest - 86400000);
      const first = await event(new Date(+latest + 600000).toISOString());
      await build(latest, today);
      if (kind === 'dirty') {
        await execute(
          'UPDATE liekan_event_environment SET identity_available=false WHERE event_id=$1',
          first,
        );
        const paused = await api.createAnalysisBuild(site, actor, {
          startDate: latest,
          endDate: today,
          timezone: 'UTC',
          locale: 'en-US',
          requestId: randomUUID(),
        });
        await api.actionAnalysisBuild(site, actor, {
          action: 'pause',
          buildId: paused.id,
          requestId: randomUUID(),
        });
      } else
        await execute(
          `UPDATE liekan_analysis_manifest SET versions=jsonb_set(versions,'{engine}','"analysis-rollups-v1"') WHERE website_id=$1`,
          site,
        );
      const available = { site: randomUUID(), session: randomUUID() };
      sites.push(available.site);
      try {
        site = available.site;
        session = available.session;
        await execute(
          `INSERT INTO website(website_id,user_id,name,domain)VALUES($1,$2,'Synthetic available probe','population.invalid')`,
          site,
          actor.userId,
        );
        await execute(
          `INSERT INTO session(session_id,website_id,browser,country)VALUES($1,$2,'Fixture','CN')`,
          session,
          site,
        );
        await event(new Date(+older + 600000).toISOString());
        await build(older, latest);
        const { probeAnalysisExpansion } = await import('./analysis-expansion');
        const plans: { sql: string; values: unknown[]; rows: unknown[]; plan: Plan }[] = [];
        const originalTransaction = db.analysisTransaction;
        const spy = vi.spyOn(db, 'analysisTransaction').mockImplementation(((
          work: any,
          level: any,
        ) =>
          originalTransaction(
            tx =>
              work({
                $executeRawUnsafe: (sql: string, ...values: unknown[]) =>
                  tx.$executeRawUnsafe(sql, ...values),
                $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
                  const rows = await tx.$queryRawUnsafe(sql, ...values);
                  if (sql.includes('current_days AS MATERIALIZED')) {
                    const [result] = await tx.$queryRawUnsafe<any[]>(
                      'EXPLAIN(ANALYZE,BUFFERS,VERBOSE,TIMING OFF,FORMAT JSON)' + sql,
                      ...values,
                    );
                    plans.push({ sql, values, rows, plan: result['QUERY PLAN'][0] });
                  }
                  return rows;
                },
              }),
            level,
          )) as any);
        let attempts;
        try {
          attempts = [await probeAnalysisExpansion(), await probeAnalysisExpansion()];
        } finally {
          spy.mockRestore();
        }
        const probes = await q(
          'SELECT website_id,status,versions,fingerprint FROM liekan_analysis_probe WHERE website_id=ANY($1::uuid[]) ORDER BY website_id',
          [original.site, available.site],
        );
        await save(`population-probe-progress-${kind}`, {
          original,
          available,
          attempts,
          probes,
          plans,
        });
        expect(attempts.every(attempt => attempt.acquired)).toBe(true);
        expect(plans).toHaveLength(2);
        for (const item of plans) {
          expect(item.sql).not.toContain('liekan_analysis_fingerprint(');
          expect(item.values[1]).toBe(ANALYSIS_ROLLUP_VERSION);
          expect(
            nodes(item.plan.Plan).some(node =>
              [
                'website_event',
                'liekan_log',
                'liekan_analysis_log',
                'liekan_analysis_path',
                'liekan_analysis_visit',
              ].includes(node['Relation Name']),
            ),
          ).toBe(false);
        }
        expect(probes.some(p => p.website_id === available.site && p.status === 'ready')).toBe(
          true,
        );
        if (kind === 'dirty')
          expect(
            probes.some(p => p.website_id === original.site && p.status === 'unavailable'),
          ).toBe(true);
        else expect(probes.some(p => p.website_id === original.site)).toBe(false);
      } finally {
        await execute(
          "UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id=$1",
          available.site,
        );
        site = original.site;
        session = original.session;
      }
    },
  );
});
