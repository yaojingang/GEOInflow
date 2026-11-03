// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HumanFact } from './analytics';
import { getQuerySnapshot, withinQuerySnapshot } from './query-snapshot';

const enabled = process.env.LIEKAN_ANALYSIS_ROLLUPS_TEST === '1';
const actor = { userId: randomUUID() };
const sites: string[] = [];
let site: string, session: string, secondSession: string;
let db: typeof import('./analysis-rollups-db'), rollups: typeof import('./analysis-rollups');
let detail: typeof import('./browser-detail-facts'), analytics: typeof import('./analytics');
let server: typeof import('./server');
const q = <T = any[]>(sql: string, ...values: unknown[]) =>
  db.analysisTransaction(tx => tx.$queryRawUnsafe<T>(sql, ...values));
const execute = (sql: string, ...values: unknown[]) =>
  db.analysisTransaction(tx => tx.$executeRawUnsafe(sql, ...values));
const start = new Date('2026-01-01T23:00Z'),
  end = new Date('2026-01-02T02:00Z');
const fields: HumanFact[] = [
  'daily',
  'geo',
  'sources',
  'environment',
  'pages',
  'heatmap',
  'newVisitors',
  'goals',
  'converted',
  'dailySources',
  'dailyConversions',
];
const pick = (value: any) =>
  Object.fromEntries([...fields, 'conversionEvents'].map(key => [key, value[key]]));
const facts = (from = start, until = end, timezone = 'UTC') =>
  server.reportSnapshot(() => analytics.getHumanFacts(site, from, until, timezone, fields));

async function event(
  at: string,
  path: string,
  options: {
    session?: string;
    visit?: string;
    type?: number;
    name?: string;
    browser?: string;
    country?: string;
    referrer?: string;
    excluded?: boolean;
    available?: boolean;
  } = {},
) {
  const id = randomUUID(),
    owner = options.session || session;
  await db.analysisTransaction(async tx => {
    await tx.$executeRawUnsafe(
      'SELECT website_id FROM website WHERE website_id=$1::uuid FOR UPDATE',
      site,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,event_type,url_path,event_name,hostname,referrer_domain,utm_source)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,'detail.invalid',$9,$10)`,
      id,
      site,
      owner,
      options.visit || owner,
      new Date(at),
      options.type || 1,
      path,
      options.name || null,
      options.referrer || '',
      options.referrer ? 'entry-source' : null,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status,hostname)
     VALUES($1::uuid,$2::uuid,$3,'browser','{}','detail-fixture','missing','detail.invalid')`,
      id,
      site,
      options.excluded ? 'automated' : 'browser',
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser,os,device)
     VALUES($1::uuid,$2::uuid,'browser','detail-fixture',$4,$3,'event-os','event-device')`,
      id,
      site,
      options.browser || 'Firefox',
      options.available !== false,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO liekan_event_geography(event_id,website_id,country,region,city,source,trust,ip_family,precision,reason,rule_version,country_basis,processed_at)
     VALUES($1::uuid,$2::uuid,$3,NULL,NULL,'synthetic','synthetic','missing','country','synthetic','fixture','synthetic',clock_timestamp())`,
      id,
      site,
      options.country || 'CN',
    );
  });
  return id;
}
async function build(from = start, until = end, chunkSize = 2) {
  const job = await rollups.createAnalysisBuild(site, actor, {
    startDate: from,
    endDate: until,
    timezone: 'UTC',
    locale: 'zh-CN',
    requestId: randomUUID(),
  });
  await execute(
    `UPDATE liekan_analysis_build SET family='visit',checkpoint=$2::jsonb,work_total=extract(epoch FROM range_end-range_start)::bigint/3600 WHERE id=$1::uuid`,
    job.id,
    JSON.stringify({ hour: from.toISOString(), family: 'visit', chunkSize }),
  );
  for (let i = 0; i < 150; i++) {
    const [row] = await q(
      'SELECT status,error_code FROM liekan_analysis_build WHERE id=$1::uuid',
      job.id,
    );
    if (row.status === 'completed') return job;
    if (['failed', 'invalidated', 'capacity_limited'].includes(row.status))
      throw new Error(`detail fixture ${JSON.stringify(row)}`);
    await rollups.runOneAnalysisWorkUnit(job.id);
  }
  throw new Error('detail fixture did not finish');
}

describe.skipIf(!enabled)('exact persisted browser detail facts', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || 'http://invalid');
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '15462' ||
      url.pathname !== '/liekan_analysis_rollups_test' ||
      !/^analysis_[a-f0-9]+$/.test(url.searchParams.get('schema') || '')
    )
      throw new Error('Owned browser detail database required');
    db = await import('./analysis-rollups-db');
    rollups = await import('./analysis-rollups');
    detail = await import('./browser-detail-facts');
    analytics = await import('./analytics');
    server = await import('./server');
    await execute(
      `INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$2,'synthetic','user')`,
      actor.userId,
      `detail-${actor.userId}`,
    );
  });
  beforeEach(async () => {
    site = randomUUID();
    session = randomUUID();
    secondSession = randomUUID();
    sites.push(site);
    await execute(
      `INSERT INTO website(website_id,user_id,name,domain) VALUES($1::uuid,$2::uuid,'Synthetic detail fixture','detail.invalid')`,
      site,
      actor.userId,
    );
    await execute(
      `INSERT INTO session(session_id,website_id,created_at,browser,country) VALUES($1::uuid,$3::uuid,'2026-01-01T22:00Z','stale-browser','US'),($2::uuid,$3::uuid,'2026-01-02T00:00Z','stale-browser','US')`,
      session,
      secondSession,
      site,
    );
    await execute(
      `INSERT INTO report(report_id,website_id,user_id,name,description,type,parameters) VALUES($1::uuid,$2::uuid,$3::uuid,'Signup','Synthetic goal fixture','goal','{"type":"event","value":"sign*"}')`,
      randomUUID(),
      site,
      actor.userId,
    );
  });
  afterAll(async () => {
    if (!enabled || !db) return;
    for (const id of sites) await execute('DELETE FROM website WHERE website_id=$1::uuid', id);
    await execute('DELETE FROM "user" WHERE user_id=$1::uuid', actor.userId);
    const { default: prisma } = await import('@/lib/prisma');
    await prisma.client.$disconnect();
  });
  it('joins the first-entry projection once for multiple uncovered visits', async () => {
    await event('2026-01-01T23:01Z', '/covered');
    await event('2026-01-02T01:00Z', '/a', { session: secondSession, referrer: 'google.com' });
    await event('2026-01-02T01:01Z', '/b', { visit: randomUUID(), referrer: 'example.org' });
    await event('2026-01-02T01:02Z', '/c', { visit: randomUUID(), referrer: 'another.test' });
    const expected = pick(await facts());
    await build(start, new Date('2026-01-02T00:00Z'));
    const scans: any[] = [];
    const actual = await server.reportSnapshot(async () => {
      const tx = getQuerySnapshot();
      // Small fixtures still prove that the entry relation permits one shared hash scan.
      await tx.$executeRawUnsafe('SET LOCAL enable_nestloop=off');
      return withinQuerySnapshot(
        {
          $executeRawUnsafe: (statement, ...values) => tx.$executeRawUnsafe(statement, ...values),
          $queryRawUnsafe: async (statement, ...values) => {
            if (statement.includes('detail_entries AS MATERIALIZED')) {
              const [row] = (await tx.$queryRawUnsafe(
                'EXPLAIN(ANALYZE,FORMAT JSON) ' + statement,
                ...values,
              )) as any[];
              const walk = (node: any) => {
                if (node['CTE Name'] === 'bounded_entry') scans.push(node);
                for (const child of node.Plans || []) walk(child);
              };
              walk(row['QUERY PLAN'][0].Plan);
            }
            return tx.$queryRawUnsafe(statement, ...values);
          },
        },
        () => facts(),
      );
    });
    expect(pick(actual)).toEqual(expected);
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every(node => node['Actual Loops'] <= 1)).toBe(true);
  });
  it.each(['daily', 'overview', 'conversions'])(
    'omits unused raw source projections for %s while preserving exact facts',
    async kind => {
      await event('2026-01-01T22:30Z', '/entry', { referrer: 'google.com' });
      await event('2026-01-01T23:01Z', '/first');
      await event('2026-01-02T00:10Z', '/signup', { type: 2, name: 'signup' });
      await event('2026-01-02T01:00Z', '/second', { session: secondSession });
      await event('2026-01-02T02:00Z', '/inclusive', { session: secondSession });
      await event('2026-01-02T02:00:00.001Z', '/outside', { session: secondSession });
      await event('2026-01-02T01:10Z', '/excluded', { excluded: true });
      const expected = await facts();
      const plans: any[] = [],
        entryReads: any[] = [],
        geographyReads: any[] = [];
      const actual = await server.reportSnapshot(() => {
        const tx = getQuerySnapshot();
        return withinQuerySnapshot(
          {
            $executeRawUnsafe: (statement, ...values) => tx.$executeRawUnsafe(statement, ...values),
            $queryRawUnsafe: async (statement, ...values) => {
              if (statement.includes('visit_totals AS')) {
                const [row] = (await tx.$queryRawUnsafe(
                  'EXPLAIN(ANALYZE,FORMAT JSON) ' + statement,
                  ...values,
                )) as any[];
                const plan = row['QUERY PLAN'][0];
                plans.push(plan);
                const walk = (node: any) => {
                  if (
                    node['Actual Loops'] > 0 &&
                    ['bounded_entry', 'bounded_history', 'bounded_history_candidates'].includes(
                      node['CTE Name'],
                    )
                  )
                    entryReads.push(node);
                  if (
                    node['Actual Loops'] > 0 &&
                    node['Relation Name'] === 'liekan_event_geography'
                  )
                    geographyReads.push(node);
                  for (const child of node.Plans || []) walk(child);
                };
                walk(plan.Plan);
              }
              return tx.$queryRawUnsafe(statement, ...values);
            },
          },
          () =>
            kind === 'daily'
              ? analytics.getHumanDays(site, start, end, 'UTC')
              : kind === 'conversions'
                ? analytics.getHumanConversions(site, start, end, 'UTC')
                : analytics.getHumanFacts(site, start, end, 'UTC', [
                    'environment',
                    'heatmap',
                    'newVisitors',
                  ]),
        );
      });
      if (kind === 'daily') expect((actual as any).rows).toEqual(expected.daily);
      else if (kind === 'conversions') expect(actual).toBe(1);
      else
        for (const key of ['environment', 'heatmap', 'newVisitors'])
          expect((actual as any)[key]).toEqual(expected[key]);
      expect(plans.length).toBeGreaterThan(0);
      await writeFile(
        `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/raw-projection-${kind}-plan.json`,
        JSON.stringify(plans),
        { mode: 0o600 },
      );
      expect(entryReads).toHaveLength(0);
      expect(geographyReads).toHaveLength(0);
    },
  );
  it('reads qualified raw metrics once while retaining unknown population evidence', async () => {
    await event('2026-01-01T23:01Z', '/first');
    await event('2026-01-02T01:00Z', '/second', { session: secondSession });
    await event('2026-01-02T01:30Z', '/unknown', { session: secondSession, available: false });
    await event('2026-01-02T02:00Z', '/inclusive', { session: secondSession });
    const scans: any[] = [];
    const input = { websiteId: site, startDate: start, endDate: end, allowRawOnly: true };
    const totals = await server.reportSnapshot(() => {
      const tx = getQuerySnapshot();
      return withinQuerySnapshot(
        {
          $executeRawUnsafe: (statement, ...values) => tx.$executeRawUnsafe(statement, ...values),
          $queryRawUnsafe: async (statement, ...values) => {
            if (
              statement.includes('raw_scope AS MATERIALIZED') &&
              statement.includes('count(DISTINCT visit_id)')
            ) {
              const [row] = (await tx.$queryRawUnsafe(
                'EXPLAIN(ANALYZE,FORMAT JSON) ' + statement,
                ...values,
              )) as any[];
              const walk = (node: any) => {
                if (node['CTE Name'] === 'bounded_keys' && node['Actual Loops'] > 0)
                  scans.push(node);
                for (const child of node.Plans || []) walk(child);
              };
              walk(row['QUERY PLAN'][0].Plan);
            }
            return tx.$queryRawUnsafe(statement, ...values);
          },
        },
        () => rollups.readAnalysisVisitTotals(input),
      );
    });
    expect(totals).toMatchObject({ pageviews: 3, visitors: 2, visits: 2 });
    expect(scans.length).toBeGreaterThan(0);
    expect(scans).toHaveLength(1);
    await build(start, new Date('2026-01-02T00:00Z'));
    const population = await rollups.readAnalysisVisitPopulation(input);
    expect(population?.identity).toMatchObject({
      eligiblePV: 4,
      qualifiedPV: 3,
      status: 'partial',
    });
    expect(await rollups.readAnalysisVisitTotals(input)).toEqual(totals);
  });
  it('reads identity population without expanding geography for uncovered visits', async () => {
    await event('2026-01-01T23:01Z', '/covered');
    await event('2026-01-02T01:00Z', '/raw', { session: secondSession });
    await build(start, new Date('2026-01-02T00:00Z'));
    const geography: any[] = [];
    const population = await server.reportSnapshot(() => {
      const tx = getQuerySnapshot();
      return withinQuerySnapshot(
        {
          $executeRawUnsafe: (statement, ...values) => tx.$executeRawUnsafe(statement, ...values),
          $queryRawUnsafe: async (statement, ...values) => {
            if (statement.includes('population_facts AS MATERIALIZED')) {
              const [row] = (await tx.$queryRawUnsafe(
                'EXPLAIN(ANALYZE,FORMAT JSON) ' + statement,
                ...values,
              )) as any[];
              const walk = (node: any) => {
                if (node['Relation Name'] === 'liekan_event_geography') geography.push(node);
                for (const child of node.Plans || []) walk(child);
              };
              walk(row['QUERY PLAN'][0].Plan);
            }
            return tx.$queryRawUnsafe(statement, ...values);
          },
        },
        () =>
          rollups.readAnalysisVisitPopulation({ websiteId: site, startDate: start, endDate: end }),
      );
    });
    expect(population?.identity).toMatchObject({
      eligiblePV: 2,
      qualifiedPV: 2,
      qualifiedVisitors: 2,
    });
    expect(geography.every(node => node['Actual Loops'] === 0)).toBe(true);
  });
  it('keeps qualified detail events within the observed batch cursor when missing identities precede them', async () => {
    await event('2026-01-01T23:00Z', '/missing-one', { available: false });
    await event('2026-01-01T23:01Z', '/missing-two', { available: false });
    await execute(
      `WITH missing AS (INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,event_type,url_path,hostname)
      SELECT gen_random_uuid(),$1::uuid,$2::uuid,$2::uuid,timestamptz '2026-01-01T23:00:01Z'+n*interval '1 millisecond',1,'/missing-batch','detail.invalid'
      FROM generate_series(1,1998) n RETURNING event_id,website_id)
      INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status,hostname)
      SELECT event_id,website_id,'browser','browser','{}','detail-fixture','missing','detail.invalid' FROM missing`,
      site,
      session,
    );
    await event('2026-01-01T23:02Z', '/qualified');
    const expected = pick(await facts());
    expect(expected.daily.reduce((sum, day) => sum + Number(day.pv), 0)).toBe(1);
    await build(start, end, 2000);
    expect(
      (
        await q(
          `SELECT coalesce(sum(v.pageviews),0)::int AS pv FROM liekan_analysis_browser_visit v WHERE v.website_id=$1 AND EXISTS(SELECT 1 FROM liekan_analysis_manifest m WHERE m.website_id=v.website_id AND m.generation=v.generation AND m.family='visit')`,
          site,
        )
      )[0].pv,
    ).toBe(1);
    expect(pick(await facts())).toEqual(expected);
    expect(
      await rollups.readAnalysisVisitTotals({ websiteId: site, startDate: start, endDate: end }),
    ).toMatchObject({ pageviews: 1, visitors: 1 });
  });
  it('matches the original raw contract across chunks, buckets, days, identities, entry and dwell', async () => {
    await event('2026-01-01T22:59:00Z', '/entry', { referrer: 'google.com' });
    await event('2026-01-01T23:59:58Z', '/a', { country: 'CN' });
    await event('2026-01-02T00:00:00Z', '/b', { country: 'GB', browser: 'Safari' });
    await event('2026-01-02T00:01:00Z', '/a');
    await event('2026-01-02T00:03:00Z', '/goal', { type: 2, name: 'signup' });
    await event('2026-01-02T00:04:59Z', '/a');
    await event('2026-01-02T00:05:00Z', '/c');
    await event('2026-01-02T00:05:00Z', '/d');
    await event('2026-01-02T00:59:59Z', '/c');
    await event('2026-01-02T01:00:00Z', '/d');
    await event('2026-01-02T00:10:00Z', '/bounce', { visit: randomUUID(), session: secondSession });
    await event('2026-01-02T00:12:00Z', '/repeat-session', { visit: randomUUID() });
    await event('2026-01-02T00:13:00Z', '/shared-visit-id', {
      visit: session,
      session: secondSession,
    });
    await event('2026-01-02T00:11:00Z', '/excluded', { excluded: true });
    const oracle = pick(
      await server.reportSnapshot(async () => {
        await getQuerySnapshot().$executeRawUnsafe('SET LOCAL enable_hashagg=off');
        return facts();
      }),
    );
    await build();
    const actual = pick(await facts());
    try {
      expect(actual).toEqual(oracle);
    } catch (error) {
      await writeFile(
        `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/browser-detail-diff.json`,
        JSON.stringify({ actual, oracle }, null, 2),
        { mode: 0o600 },
      );
      throw error;
    }
    const [counts] = await q(
      `SELECT (SELECT count(*) FROM liekan_analysis_browser_visit WHERE website_id=$1::uuid)::int AS visits,(SELECT count(*) FROM liekan_analysis_browser_detail WHERE website_id=$1::uuid AND complete)::int AS complete`,
      site,
    );
    expect(counts.visits).toBeGreaterThan(1);
    expect(counts.complete).toBeGreaterThan(0);
    expect((await facts()).environment.every(row => row.browser !== 'stale-browser')).toBe(true);
  });
  it('merges proved history with raw gaps and preserves inclusive and half-open millisecond boundaries', async () => {
    await event('2026-01-01T23:59:59.999Z', '/before');
    await event('2026-01-02T00:00:00.000Z', '/at');
    await event('2026-01-02T00:04:59.999Z', '/before-five');
    await event('2026-01-02T00:05:00.000Z', '/five');
    await event('2026-01-02T01:00:00.000Z', '/raw-tail');
    const windowStart = new Date('2026-01-01T23:59:59.999Z'),
      windowEnd = new Date('2026-01-02T01:00:00.000Z');
    const oracle = pick(await facts(windowStart, windowEnd, 'Asia/Kathmandu'));
    const exclusiveOracle = pick(
      await facts(windowStart, new Date(+windowEnd - 1), 'Asia/Kathmandu'),
    );
    await build(start, new Date('2026-01-02T01:00Z'));
    expect(pick(await facts(windowStart, windowEnd, 'Asia/Kathmandu'))).toEqual(oracle);
    const halfOpen = await detail.readBrowserDetailFacts(
      site,
      windowStart,
      windowEnd,
      'Asia/Kathmandu',
      fields,
      { halfOpen: true },
    );
    expect(halfOpen?.pages).toEqual(exclusiveOracle.pages);
    expect(halfOpen?.daily).toEqual(exclusiveOracle.daily);
  });
  it('falls back from a changed generation and publishes corrected first entry and dwell', async () => {
    await event('2026-01-02T00:01Z', '/a', { referrer: 'google.com' });
    await event('2026-01-02T00:07Z', '/b');
    await build();
    await event('2026-01-01T23:59Z', '/earlier', { referrer: 'bing.com' });
    const stale = await facts();
    const oracle = pick(stale);
    await build();
    expect(pick(await facts())).toEqual(oracle);
    expect((await facts()).sourceEvidence[0].referrer).toBe('bing.com');
  });
  it('keeps native reporting snapshots free of compilation and restores pooled session policy', async () => {
    await event('2026-01-02T00:01Z', '/native-jit');
    await event('2026-01-02T00:04Z', '/native-next');
    const { executeNativeAnalysis } = await import('./analysis-native-execution');
    const { withoutQueryCache } = await import('./cache-context');
    expect((await q("SELECT current_setting('jit') AS mode"))[0].mode).toBe('on');
    await server.reportSnapshot(async () => {
      const tx = getQuerySnapshot();
      expect(await tx.$queryRawUnsafe("SELECT current_setting('jit') AS mode")).toEqual([
        { mode: 'off' },
      ]);
      await tx.$executeRawUnsafe('SET LOCAL jit_above_cost=0');
      const plans = await tx.$queryRawUnsafe(
        'EXPLAIN (ANALYZE,FORMAT JSON) SELECT sum(x) FROM generate_series(1,2) x',
      );
      if (!Array.isArray(plans)) throw new Error('Missing reporting plan');
      expect(plans[0]['QUERY PLAN'][0].JIT).toBeUndefined();
      for (const [target, extra] of [
        ['retention', {}],
        ['journeys', { steps: 3 }],
        [
          'funnels/stats',
          {
            window: 60,
            steps: JSON.stringify([
              { type: 'path', value: '/native-jit' },
              { type: 'path', value: '/native-next' },
            ]),
          },
        ],
      ] as const) {
        expect(
          await withoutQueryCache(() =>
            executeNativeAnalysis(site, target, {
              startAt: +start,
              endAt: +end,
              timezone: 'UTC',
              ...extra,
            }),
          ),
        ).toBeDefined();
      }
    });
    await expect(
      server.reportSnapshot(async () => {
        throw new Error('synthetic rollback');
      }),
    ).rejects.toThrow('synthetic rollback');
    expect((await q("SELECT current_setting('jit') AS mode"))[0].mode).toBe('on');
  });
  it('avoids JIT compilation for covered detail reads while preserving exact facts', async context => {
    const [support] = await q('SELECT pg_jit_available() AS available');
    if (!support.available) return context.skip();
    await event('2026-01-02T00:01Z', '/jit-fixture');
    await event('2026-01-02T00:04Z', '/jit-fixture');
    await build();
    const oracle = (await facts()).pages;
    let checked = false;
    await db.analysisTransaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL jit=on');
      await tx.$executeRawUnsafe('SET LOCAL jit_above_cost=0');
      await tx.$executeRawUnsafe('SET LOCAL jit_inline_above_cost=-1');
      await tx.$executeRawUnsafe('SET LOCAL jit_optimize_above_cost=-1');
      const [control] = await tx.$queryRawUnsafe<any[]>(
        'EXPLAIN (ANALYZE,FORMAT JSON) SELECT sum(x) FROM generate_series(1,2) x',
      );
      expect(control['QUERY PLAN'][0].JIT).toBeDefined();
      const value = await withinQuerySnapshot(
        {
          $executeRawUnsafe: (sql: string, ...values: unknown[]) =>
            tx.$executeRawUnsafe(sql, ...values),
          $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
            if (sql.startsWith('WITH original_coverage AS MATERIALIZED')) {
              const [plan] = await tx.$queryRawUnsafe<any[]>(
                'EXPLAIN (ANALYZE,FORMAT JSON) ' + sql,
                ...values,
              );
              checked = true;
              expect(plan['QUERY PLAN'][0].JIT).toBeUndefined();
            }
            return tx.$queryRawUnsafe(sql, ...values);
          },
        },
        () => detail.readBrowserDetailFacts(site, start, end, 'UTC', ['pages']),
      );
      expect(value?.pages).toEqual(oracle);
    });
    expect(checked).toBe(true);
    expect((await q("SELECT current_setting('jit') AS mode"))[0].mode).toBe('on');
  });
  it('reads fully covered historical pages without executing historical event scans', async () => {
    await event('2026-01-02T00:01Z', '/a');
    await event('2026-01-02T00:04Z', '/b');
    await build();
    let captured: { sql: string; values: unknown[] };
    await db.analysisTransaction(tx =>
      withinQuerySnapshot(
        {
          $executeRawUnsafe: (sql: string, ...values: unknown[]) =>
            tx.$executeRawUnsafe(sql, ...values),
          $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
            if (sql.startsWith('WITH original_coverage AS MATERIALIZED'))
              captured = { sql, values };
            return tx.$queryRawUnsafe(sql, ...values);
          },
        },
        () => detail.readBrowserDetailFacts(site, start, end, 'UTC', ['pages']),
      ),
    );
    expect(captured).toBeDefined();
    const [row] = await q(`EXPLAIN (ANALYZE,FORMAT JSON) ${captured.sql}`, ...captured.values);
    const nodes = (node: any): any[] => [node, ...(node.Plans || []).flatMap(nodes)];
    const reads = nodes(row['QUERY PLAN'][0].Plan).filter(
      node => node['Relation Name'] === 'website_event',
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(node => !node['Actual Loops'] || node['Actual Rows'] === 0)).toBe(true);
  });
  it('matches original content paths across inclusive boundaries and coverage without expanding dimensions', async () => {
    await event(new Date(+start - 1).toISOString(), '/outside-left');
    await event(start.toISOString(), '/included-start');
    await event('2026-01-02T00:00:00Z', '/tie-a');
    await event('2026-01-02T00:00:00Z', '/tie-b');
    await event('2026-01-02T00:01:00Z', '/other-session', {
      visit: session,
      session: secondSession,
    });
    await event(end.toISOString(), '/included-end');
    await event(new Date(+end + 1).toISOString(), '/outside-right');
    await event('2026-01-02T00:02:00Z', '/custom-only', {
      visit: randomUUID(),
      type: 2,
      name: 'synthetic-custom',
    });
    await event('2026-01-02T00:03:00Z', '/excluded', { excluded: true });
    await event('2026-01-02T00:04:00Z', '/performance', { type: 5 });
    await event('2026-01-02T00:05:00Z', '', { visit: randomUUID() });
    const foreignSite = randomUUID(),
      foreignSession = randomUUID(),
      foreignVisit = randomUUID();
    sites.push(foreignSite);
    await execute(
      `INSERT INTO website(website_id,user_id,name,domain) VALUES($1::uuid,$2::uuid,'Synthetic foreign session fixture','foreign-detail.invalid')`,
      foreignSite,
      actor.userId,
    );
    await execute(
      `INSERT INTO session(session_id,website_id,created_at) VALUES($1::uuid,$2::uuid,'2026-01-01')`,
      foreignSession,
      foreignSite,
    );
    for (const [at, path] of [
      ['2026-01-02T00:06:00Z', '/foreign-session-start'],
      ['2026-01-02T00:07:00Z', '/foreign-session-end'],
    ])
      await event(at, path, { session: foreignSession, visit: foreignVisit });
    const [ownership] = await q(
      `SELECT
        (SELECT count(*)::int FROM liekan_effective_website_event WHERE website_id=$1::uuid AND session_id=$2::uuid) AS admissible,
        (SELECT count(*)::int FROM liekan_geographic_website_event WHERE website_id=$1::uuid AND session_id=$2::uuid) AS owned`,
      site,
      foreignSession,
    );
    expect(ownership).toEqual({ admissible: 2, owned: 0 });
    const original = async (from = start, until = end) =>
      server.reportSnapshot(async () => {
        const [row] = await server.query(
          analytics.humanVisitsSql() +
            ` SELECT jsonb_build_object(
            'journeys',(SELECT coalesce(jsonb_agg(to_jsonb(fact)),'[]'::jsonb) FROM (
              WITH paths AS (SELECT visit_id,(array_agg(url_path ORDER BY created_at,event_id))[1:6] AS path
                FROM events WHERE event_type=1 GROUP BY visit_id)
              SELECT array_to_string(path,' → ') AS path,count(*)::int AS count FROM paths
                GROUP BY 1 ORDER BY count DESC,path LIMIT 6) fact),
            'exits',(SELECT coalesce(jsonb_agg(to_jsonb(fact)),'[]'::jsonb) FROM (
              WITH lasts AS (SELECT DISTINCT ON(visit_id,session_id) url_path AS path FROM events WHERE event_type=1
                ORDER BY visit_id,session_id,created_at DESC,event_id DESC)
              SELECT path,count(*)::int AS count FROM lasts GROUP BY 1 ORDER BY count DESC,path LIMIT 1) fact)) AS facts`,
          site,
          from,
          until,
          'UTC',
        );
        return row.facts;
      });
    let checked = 0;
    const read = (selected: HumanFact[], from = start, until = end) =>
      server.reportSnapshot(() => {
        const tx = getQuerySnapshot();
        return withinQuerySnapshot(
          {
            $executeRawUnsafe: (sql: string, ...values: unknown[]) =>
              tx.$executeRawUnsafe(sql, ...values),
            $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
              if (sql.includes("'journeys',") && sql.includes("'exits',")) {
                const explain = await tx.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) ${sql}`, ...values);
                if (!Array.isArray(explain)) throw new Error('Expected a browser path query plan');
                expect(explain).toHaveLength(1);
                const [plan] = explain;
                const nodes = (node: any): any[] => [node, ...(node.Plans || []).flatMap(nodes)];
                const relations = nodes(plan['QUERY PLAN'][0].Plan).map(
                  node => node['Relation Name'],
                );
                expect(relations).not.toContain('liekan_event_geography');
                checked++;
              }
              return tx.$queryRawUnsafe(sql, ...values);
            },
          },
          () => analytics.getHumanFacts(site, from, until, 'UTC', selected),
        );
      });
    const paths = (value: any) => ({ journeys: value.journeys, exits: value.exits });
    const oracle = await original();
    expect(oracle.journeys.length).toBeGreaterThan(0);
    expect(oracle.journeys.some(row => row.path === '')).toBe(true);
    expect(oracle.exits.length).toBeGreaterThan(0);
    expect(oracle.journeys.every(row => !row.path.includes('/foreign-session-'))).toBe(true);
    expect(paths(await read(['journeys', 'exits']))).toEqual(oracle);
    await build();
    const covered = await read(['pages', 'journeys', 'exits']);
    expect(covered.pages.length).toBeGreaterThan(0);
    expect(paths(covered)).toEqual(oracle);
    const emptyStart = new Date(+end + 86400000),
      emptyEnd = new Date(+emptyStart + 1000);
    expect(paths(await read(['journeys', 'exits'], emptyStart, emptyEnd))).toEqual(
      await original(emptyStart, emptyEnd),
    );
    expect(checked).toBe(3);
  });
});
