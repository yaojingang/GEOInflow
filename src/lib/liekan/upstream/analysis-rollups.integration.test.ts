import { getQuerySnapshot, withinQuerySnapshot } from './query-snapshot';
// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_REPAIR_ENGINE } from '../contracts/history-repair';
import type { AnalysisBuildDto, AnalysisLogInput } from './analysis-rollups-model';
import { ANALYSIS_ROLLUP_VERSION } from './analysis-rollups-model';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
import { CRAWLER_POPULATION_VERSION } from '../rules/population';
import { staticRequestExtensionPattern } from './log-content-boundary';
let api: typeof import('./analysis-rollups');
let db: typeof import('./analysis-rollups-db');
let prisma: typeof import('@/lib/prisma').default;
const enabled = process.env.LIEKAN_ANALYSIS_ROLLUPS_TEST === '1';
const actor = { userId: randomUUID() },
  other = { userId: randomUUID() };
let site: string, session: string, imported: string;
const q = <T = Record<string, unknown>[]>(sql: string, ...values: unknown[]) =>
  db.analysisTransaction(tx => tx.$queryRawUnsafe<T>(sql, ...values));
const execute = (sql: string, ...values: unknown[]) =>
  db.analysisTransaction(tx => tx.$executeRawUnsafe(sql, ...values));
const nativeExecute = async (sql: string, ...values: unknown[]) => {
  const { Client } = await import('pg');
  const url = new URL(process.env.DATABASE_URL);
  const schema = url.searchParams.get('schema');
  url.searchParams.delete('schema');
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    return await client.query(sql, values);
  } finally {
    await client.end();
  }
};
const from = new Date('2026-01-01T00:00:00Z'),
  until = new Date('2026-01-03T00:00:00Z');
const input = (options: Partial<AnalysisLogInput> = {}): AnalysisLogInput => ({
  websiteId: site,
  startDate: from,
  endDate: until,
  timezone: 'Asia/Shanghai',
  crawlerMetricsVersion: 1,
  allowRawOnly: true,
  ...options,
});
const readVisits = (value: Parameters<typeof api.readAnalysisVisitTotals>[0]) =>
  api.readAnalysisVisitTotals({ ...value, allowRawOnly: true });
const readMetrics = (value: Parameters<typeof api.readAnalysisVisitMetrics>[0]) =>
  api.readAnalysisVisitMetrics({ ...value, allowRawOnly: true });
const withoutCoverage = (value: Awaited<ReturnType<typeof api.readAnalysisLogRollup>>) =>
  value && Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'coverage'));
async function build(startDate = from, endDate = until) {
  return api.createAnalysisBuild(site, actor, {
    startDate,
    endDate,
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    requestId: randomUUID(),
  });
}
async function finish(value: AnalysisBuildDto) {
  for (let i = 0; i < 150; i++) {
    const [current] = await q<
      { status: string; checkpoint: unknown; work_done: bigint; work_total: bigint }[]
    >(
      'SELECT status,checkpoint,work_done,work_total FROM liekan_analysis_build WHERE id=$1::uuid',
      value.id,
    );
    if (current.status === 'completed') return current;
    if (['failed', 'invalidated', 'capacity_limited'].includes(current.status))
      throw new Error(
        `Unexpected worker status ${JSON.stringify(current, (_, v) => (typeof v === 'bigint' ? String(v) : v))}`,
      );
    await api.runOneAnalysisWorkUnit(value.id);
  }
  throw new Error('Bounded worker did not finish');
}
async function shortLogBuild(start: Date, end: Date) {
  const id = randomUUID();
  await execute(
    `INSERT INTO liekan_analysis_build(id,website_id,actor_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total)
   SELECT $1::uuid,$2::uuid,$3::uuid,epoch,'log',300,$4,$5,'UTC','en-US',$1::uuid,'today-short-recovery','queued',$6::bigint
   FROM liekan_analysis_site WHERE website_id=$2::uuid`,
    id,
    site,
    actor.userId,
    start,
    end,
    Math.ceil((+end - +start) / 300000),
  );
  return { id } as AnalysisBuildDto;
}
async function log(
  at: string,
  options: {
    path?: string;
    status?: number;
    selfCheck?: boolean;
    verification?: string;
    ai?: boolean | null;
    bot?: string;
    state?: string | null;
  } = {},
) {
  const id = randomUUID();
  await execute(
    `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
   VALUES($1,$2::uuid,$3::uuid,$4::timestamptz,$5,'GET',$11,0,'','',$6,'',$7,'OpenAI','训练',$8,$9::boolean,$10)`,
    id,
    site,
    imported,
    at,
    options.path || '/a%2Fb',
    options.selfCheck ? 'Liekan-Crawler-Check/fixture' : 'GPTBot/1.0',
    options.bot || 'GPTBot',
    options.verification || 'verified_range',
    options.ai === undefined ? true : options.ai,
    options.state === undefined ? 'recognized' : options.state,
    options.status ?? 200,
  );
  return id;
}
async function event(
  at: string,
  options: {
    visit?: string;
    type?: number;
    hostname?: string;
    source?: string;
    classification?: string;
  } = {},
) {
  const id = randomUUID();
  await execute(
    `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type,hostname) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::timestamptz,'/test',$6,$7)`,
    id,
    site,
    session,
    options.visit || session,
    at,
    options.type || 1,
    options.hostname || 'example.test',
  );
  await execute(
    `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status,hostname) VALUES($1::uuid,$2::uuid,$3,$4,'{}','fixture','missing',$5)`,
    id,
    site,
    options.classification || 'browser',
    options.source || 'browser',
    options.hostname || 'example.test',
  );
  await execute(
    `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser,os,device,screen,language)
     SELECT $1::uuid,$2::uuid,'browser','synthetic-fixture',true,s.browser,s.os,s.device,s.screen,s.language
     FROM session s WHERE s.website_id=$2::uuid AND s.session_id=$3::uuid`,
    id,
    site,
    session,
  );
  return id;
}

describe.skipIf(!enabled)('exact rollups in an owned isolated PostgreSQL schema', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || 'http://invalid');
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '15462' ||
      url.pathname !== '/liekan_analysis_rollups_test' ||
      !/^analysis_[a-f0-9]+$/.test(url.searchParams.get('schema') || '')
    )
      throw new Error('Only owned PostgreSQL15462 analysis schema is allowed');
    api = await import('./analysis-rollups');
    db = await import('./analysis-rollups-db');
    ({ default: prisma } = await import('@/lib/prisma'));
    for (const user of [actor, other])
      await execute(
        'INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$1,$2,\'user\')',
        user.userId,
        'fixture',
      );
  });
  afterAll(async () => {
    if (enabled && prisma) await prisma.client.$disconnect();
  });
  afterEach(async () => {
    if (enabled)
      await execute(
        "UPDATE liekan_history_repair_run SET status='cancelled' WHERE actor_id=$1::uuid AND status IN('queued','scanning','preparing','running','validating')",
        actor.userId,
      );
  });
  beforeEach(async () => {
    site = randomUUID();
    session = randomUUID();
    imported = randomUUID();
    await execute(
      "INSERT INTO website(website_id,name,domain,user_id) VALUES($1::uuid,'Exact rollup fixture','example.test',$2::uuid)",
      site,
      actor.userId,
    );
    await execute(
      "INSERT INTO session(session_id,website_id,browser,country) VALUES($1::uuid,$2::uuid,'Chrome','CN')",
      session,
      site,
    );
    await execute(
      'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$1,1,0)',
      imported,
      site,
    );
  });
  it('preserves the existing five-minute trend labels through a historical midnight fold', async () => {
    await log('2009-11-01T03:00:30Z');
    await log('2009-11-01T03:01:30Z');
    const rows = await api.readAnalysisLogSeries({
      ...input(), startDate: new Date('2009-11-01T03:00Z'), endDate: new Date('2009-11-01T04:00Z'),
      timezone: 'America/Goose_Bay', grain: 'day',
    });
    expect(rows).toEqual([{ day: '2009-11-01', bot: 'GPTBot', type: '训练', count: 2, aiRequests: 2 }]);
  });
  it('keeps crawler context exact across raw gaps, covered visits and late identity corrections', async () => {
    await event('2026-01-01T00:01:00Z');
    await event('2026-01-01T00:10:00Z', { type: 2 });
    await event('2026-01-01T01:20:00Z', { visit: randomUUID() });
    const changed = await event('2026-01-01T01:30:00Z');
    const missing = await event('2026-01-01T01:31:00Z');
    await execute('UPDATE liekan_event_environment SET identity_available=false WHERE event_id=$1::uuid', missing);
    await event('2026-01-01T01:40:00Z', { type: 5 });
    const { getHumanFacts } = await import('./analytics');
    const { reportSnapshot } = await import('./server');
    const ranges = [
      [from, new Date(+from + 7200000)],
      [new Date(+from + 1234567), new Date(+from + 6543210)],
      [from, new Date('2026-01-01T01:30:00Z')],
    ];
    const verify = async () => {
      for (const [starts, ends] of ranges) {
        const expected = await reportSnapshot(() => getHumanFacts(site, starts, ends, 'Asia/Shanghai', ['daily']));
        const actual = await reportSnapshot(() => getHumanFacts(site, starts, ends, 'Asia/Shanghai', ['daily'], undefined, { crawlerContext: true }));
        expect(actual.totals).toEqual(expected.totals);
        expect(actual.population).toEqual(expected.population);
        expect(actual.daily.map(row => row.day)).toEqual(expected.daily.map(row => row.day));
      }
    };
    await verify();
    await finish(await build(from, new Date(+from + 3600000)));
    await verify();
    await finish(await build(from, new Date(+from + 7200000)));
    await verify();
    await execute('UPDATE liekan_event_environment SET identity_available=false WHERE event_id=$1::uuid', changed);
    await verify();
  });
  it.each([
    ['Asia/Kolkata', '2026-01-01T18:40:00Z'],
    ['Asia/Kathmandu', '2026-01-01T18:20:00Z'],
    ['Australia/Lord_Howe', '2026-06-01T13:40:00Z'],
    ['America/Goose_Bay', '2009-11-01T03:10:00Z'],
  ])('keeps crawler local date labels across covered UTC hours in %s', async (timezone, at) => {
    await event(at);
    const hour = new Date(Math.floor(+new Date(at) / 3600000) * 3600000);
    const starts = new Date(+hour - 86400000), ends = new Date(+hour + 86400000);
    const { getHumanFacts } = await import('./analytics');
    const { reportSnapshot } = await import('./server');
    const expected = await reportSnapshot(() => getHumanFacts(site, starts, ends, timezone, ['daily']));
    await finish(await api.createAnalysisBuild(site, actor, {
      startDate: hour, endDate: new Date(+hour + 3600000), timezone, locale: 'zh-CN', requestId: randomUUID(),
    }));
    const actual = await reportSnapshot(() => getHumanFacts(site, starts, ends, timezone, ['daily'], undefined, { crawlerContext: true }));
    expect(actual.totals).toEqual(expected.totals);
    expect(actual.daily.map(row => row.day)).toEqual(expected.daily.map(row => row.day));
  });
  it('shares crawler context with exact content preference page facts', async () => {
    await event('2026-01-01T00:01:00Z');
    await event('2026-01-01T00:02:00Z');
    await event('2026-01-01T01:03:00Z', { type: 2 });
    const { getHumanFacts } = await import('./analytics');
    const { reportSnapshot } = await import('./server');
    const expected = await reportSnapshot(() => getHumanFacts(site, from, until, 'Asia/Shanghai', ['pages']));
    const factual: string[] = [];
    const actual = await reportSnapshot(() => {
      const snapshot = getQuerySnapshot();
      return withinQuerySnapshot({
        $executeRawUnsafe: (sql, ...values) => snapshot.$executeRawUnsafe(sql, ...values),
        $queryRawUnsafe: async (sql, ...values) => {
          const rows = await snapshot.$queryRawUnsafe(sql, ...values) as any[];
          if (rows[0] && ['facts', 'pageviews', 'qualifiedVisitors'].some(key => Object.hasOwn(rows[0], key))) factual.push(sql);
          return rows;
        },
      }, () => getHumanFacts(site, from, until, 'Asia/Shanghai', ['pages'], undefined, { crawlerContext: true }));
    });
    expect(actual.pages).toEqual(expected.pages);
    expect(actual.totals).toEqual(expected.totals);
    expect(actual.population).toEqual(expected.population);
    expect(factual).toHaveLength(2);
  });
  it('reads crawler date labels, real totals and population in one factual statement', async () => {
    await event('2026-01-01T00:01:00Z');
    await event('2026-01-02T00:02:00Z', { visit: randomUUID() });
    const unknown = await event('2026-01-02T00:03:00Z');
    await execute('UPDATE liekan_event_environment SET identity_available=false WHERE event_id=$1::uuid', unknown);
    const { getHumanFacts } = await import('./analytics');
    const { reportSnapshot } = await import('./server');
    const expected = await reportSnapshot(() => getHumanFacts(site, from, until, 'Asia/Shanghai', ['daily']));
    const factual: string[] = [];
    const actual = await reportSnapshot(() => {
      const snapshot = getQuerySnapshot();
      return withinQuerySnapshot({
        $executeRawUnsafe: (sql, ...values) => snapshot.$executeRawUnsafe(sql, ...values),
        $queryRawUnsafe: async (sql, ...values) => {
          const rows = await snapshot.$queryRawUnsafe(sql, ...values) as any[];
          if (rows[0] && ['facts', 'pageviews', 'qualifiedVisitors'].some(key => Object.hasOwn(rows[0], key))) factual.push(sql);
          return rows;
        },
      }, () => Reflect.apply(getHumanFacts, undefined, [site, from, until, 'Asia/Shanghai', ['daily'], undefined, { crawlerContext: true }]));
    });
    expect(actual.totals).toEqual(expected.totals);
    expect(actual.daily.map(row => row.day)).toEqual(expected.daily.map(row => row.day));
    expect(actual.population.identity).toMatchObject({ eligiblePV: 3, qualifiedPV: 2, status: 'partial' });
    expect(factual.length).toBeGreaterThan(0);
    expect(factual).toHaveLength(1);
  });
  it('recovers a capacity-limited automatic unit after space returns without replacing its receipt', async () => {
    const start = new Date(Math.floor((Date.now() - 7200000) / 3600000) * 3600000);
    await log(new Date(+start + 60000).toISOString());
    await api.reconcileAnalysisRollups();
    const [unit] = await q<{ id: string }[]>(
      "SELECT id FROM liekan_analysis_build WHERE website_id=$1::uuid AND actor_id IS NULL AND request_hash='live' ORDER BY range_start DESC LIMIT 1",
      site,
    );
    expect(unit).toBeDefined();
    await execute(
      "UPDATE liekan_analysis_build SET status='capacity_limited',error_code='analysis-capacity-limited',attempts=1,next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",
      unit.id,
    );
    await execute(
      'UPDATE liekan_analysis_site SET derived_bytes=1073741824 WHERE website_id=$1::uuid',
      site,
    );
    await api.reconcileAnalysisRollups();
    expect(
      (await q('SELECT status FROM liekan_analysis_build WHERE id=$1::uuid', unit.id))[0].status,
    ).toBe('capacity_limited');
    await execute(
      'UPDATE liekan_analysis_site SET derived_bytes=0 WHERE website_id=$1::uuid',
      site,
    );
    await api.reconcileAnalysisRollups();
    expect(
      (
        await q(
          'SELECT status,attempts,error_code FROM liekan_analysis_build WHERE id=$1::uuid',
          unit.id,
        )
      )[0],
    ).toMatchObject({ status: 'queued', attempts: 0, error_code: null });
    expect(
      (
        await q(
          "SELECT count(*)::int AS n FROM liekan_analysis_build WHERE website_id=$1::uuid AND request_hash='live' AND range_start=$2",
          site,
          start,
        )
      )[0].n,
    ).toBe(1);
    await finish({ id: unit.id } as AnalysisBuildDto);
  });
  it('restores recent uncovered capacity work ahead of an old discovery cursor and skips covered receipts', async () => {
    const start = new Date(Math.floor((Date.now() - 6 * 3600000) / 3600000) * 3600000);
    await log(new Date(+start + 60000).toISOString());
    const recent = randomUUID(),
      covered = randomUUID(),
      old = randomUUID();
    await execute(
      `INSERT INTO liekan_analysis_manifest(website_id,epoch,family,bucket,bucket_end,generation,fingerprint,versions,row_count,path_complete)
      SELECT $1::uuid,1,'log',at,at+interval '5 minutes',gen_random_uuid(),liekan_analysis_fingerprint($1::uuid,1,'log',at,at+interval '5 minutes'),
       liekan_analysis_versions($1::uuid,$3,$4,$5),0,true
      FROM (SELECT $2::timestamptz+interval '2 hours'+n*interval '5 minutes' AS at FROM generate_series(0,31) n) leaves`,
      site,
      start,
      ANALYSIS_ROLLUP_VERSION,
      TRAFFIC_POLICY_VERSION,
      CRAWLER_POPULATION_VERSION,
    );
    for (const [id, at, status] of [
      [recent, start, 'capacity_limited'],
      [covered, new Date(+start + 7200000), 'capacity_limited'],
      [old, from, 'queued'],
    ] as const) {
      await execute(
        `INSERT INTO liekan_analysis_build(id,website_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total,error_code)
       VALUES($1::uuid,$2::uuid,1,'log',300,$3,$4,'UTC','zh-CN',$1::uuid,'live',$5,1,'analysis-capacity-limited')`,
        id,
        site,
        at,
        new Date(+at + 300000),
        status,
      );
    }
    await execute(
      `UPDATE liekan_analysis_site SET discovery_cursors='{"finite-log":"2026-02-01T00:00:00.000Z","stale-log":"2026-02-01T00:00:00.000Z"}'::jsonb WHERE website_id=$1::uuid`,
      site,
    );
    await api.reconcileAnalysisRollups();
    expect(
      (await q('SELECT status,checkpoint FROM liekan_analysis_build WHERE id=$1::uuid', recent))[0],
    ).toEqual({ status: 'queued', checkpoint: {} });
    expect(
      (await q('SELECT status FROM liekan_analysis_build WHERE id=$1::uuid', covered))[0].status,
    ).toBe('capacity_limited');
    const { processAnalysisBuild } = await import('./analysis-build-queue');
    const result = await processAnalysisBuild('', 'incremental', { shouldStop: () => false });
    expect(result.completedUnits).toBeGreaterThan(0);
    expect(
      (await q('SELECT status FROM liekan_analysis_build WHERE id=$1::uuid', recent))[0].status,
    ).toBe('completed');
  });
  it('starts trusted sites live with uncovered history and explicit unsupported-filter fallbacks', async () => {
    const status = await api.getAnalysisStatus(site, actor);
    expect(status.mode).toBe('live');
    await expect(
      api.createAnalysisBuild(site, actor, {
        startDate: '2026-01-01T00:59:00Z',
        endDate: '2026-01-01T00:01:00Z',
        timezone: 'UTC',
        locale: 'en-US',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'analysis-invalid-range' });
    expect(await api.readAnalysisLogRollup(input({ allowRawOnly: false }))).toBeNull();
    expect(
      await api.readAnalysisVisitTotals({ websiteId: site, startDate: from, endDate: until }),
    ).toBeNull();
    expect(status.coverage).toEqual([]);
    expect(
      await readVisits({
        websiteId: site,
        startDate: from,
        endDate: until,
        filters: { url: '/a' },
      }),
    ).toBeNull();
    expect(await api.readAnalysisLogRollup(input({ filters: { search: 'secret' } }))).toBeNull();
    await expect(api.getAnalysisStatus(site, other)).rejects.toMatchObject({ status: 403 });
  });
  it.each([
    ['failed', 'management'],
    ['capacity_limited', 'management'],
    ['failed', 'reconciliation'],
    ['capacity_limited', 'reconciliation'],
  ])(
    'releases an unreachable %s checkpoint after an epoch change through %s',
    async (status, transition) => {
      const { previewGenerations, collectGenerationBatch } = await import(
        './storage-generation-gc'
      );
      const { lockWritableWebsite } = await import('./server');
      await log('2026-01-01T00:01:00Z');
      await finish(await build(from, new Date(+from + 3600000)));
      const before = withoutCoverage(await api.readAnalysisLogRollup(input()));
      const interrupted = await build(from, new Date(+from + 3600000));
      const generation = randomUUID();
      await execute(
        "INSERT INTO liekan_analysis_generation(website_id,generation,estimated_bytes,updated_at) VALUES($1::uuid,$2::uuid,17,'2026-01-01')",
        site,
        generation,
      );
      await execute(
        'UPDATE liekan_analysis_site SET derived_bytes=derived_bytes+17 WHERE website_id=$1::uuid',
        site,
      );
      await execute(
        "UPDATE liekan_analysis_build SET status=$2,checkpoint=checkpoint||jsonb_build_object('generation',$3::text) WHERE id=$1::uuid",
        interrupted.id,
        status,
        generation,
      );
      const cutoff = new Date(Date.now() + 3600000);
      expect(
        (await db.analysisTransaction(tx => previewGenerations(tx, site, cutoff))).candidateCount,
      ).toBe(0);
      if (transition === 'management') {
        await api.actionAnalysisBuild(site, actor, { action: 'disable', requestId: randomUUID() });
      } else {
        await execute(
          "UPDATE liekan_analysis_site SET mode='disabled',epoch=epoch+1 WHERE website_id=$1::uuid",
          site,
        );
        await api.reconcileAnalysisRollups();
      }
      expect(
        (await q('SELECT status FROM liekan_analysis_build WHERE id=$1::uuid', interrupted.id))[0]
          .status,
      ).toBe('invalidated');
      await api.actionAnalysisBuild(site, actor, { action: 'enable', requestId: randomUUID() });
      const collected = await db.analysisTransaction(async tx => {
        await lockWritableWebsite(tx, site, actor);
        await tx.$queryRawUnsafe(
          'SELECT website_id FROM liekan_analysis_site WHERE website_id=$1::uuid FOR UPDATE',
          site,
        );
        return collectGenerationBatch(tx, site, cutoff);
      });
      expect(collected.generationsDeleted).toBe(1);
      expect(
        await q(
          'SELECT generation FROM liekan_analysis_generation WHERE website_id=$1::uuid AND generation=$2::uuid',
          site,
          generation,
        ),
      ).toHaveLength(0);
      expect(
        (
          await q(
            'SELECT count(*)::int AS n FROM liekan_analysis_manifest WHERE website_id=$1::uuid',
            site,
          )
        )[0].n,
      ).toBeGreaterThan(0);
      expect(withoutCoverage(await api.readAnalysisLogRollup(input()))).toEqual(before);
    },
  );
  it('indexes disjoint uncovered gaps without scanning the covered middle', async () => {
    await log('2026-01-01T00:03:00Z');
    await log('2026-01-01T00:08:00Z');
    const window = {
      ...input(),
      startDate: new Date('2025-12-31T00:00Z'),
      endDate: new Date('2026-01-02T00:00Z'),
      grain: 'hour' as const,
    };
    const raw = await api.readAnalysisLogSeries(window);
    await finish(await shortLogBuild(from, new Date(+from + 3600000)));
    const rawScans: any[] = [];
    const actual = await db.analysisTransaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan=off');
      return withinQuerySnapshot(
        new Proxy(tx, {
          get(target, key) {
            if (key !== '$queryRawUnsafe') return Reflect.get(target, key);
            return async (statement: string, ...values: unknown[]) => {
              if (statement.includes('reporting_bounds AS MATERIALIZED')) {
                const [row] = await target.$queryRawUnsafe<any[]>(
                  `EXPLAIN(ANALYZE,FORMAT JSON) ${statement}`,
                  ...values,
                );
                const visit = (node: any) => {
                  if (node['Relation Name'] === 'liekan_log') rawScans.push(node);
                  for (const child of node.Plans || []) visit(child);
                };
                visit(row['QUERY PLAN'][0].Plan);
              }
              return target.$queryRawUnsafe(statement, ...values);
            };
          },
        }),
        () => api.readAnalysisLogSeries(window),
      );
    });
    expect(actual).toEqual(raw);
    expect(actual.reduce((sum, row) => sum + row.count, 0)).toBe(2);
    expect(rawScans.length).toBeGreaterThan(0);
    expect(rawScans.every(node => !node['Actual Rows'] && !node['Rows Removed by Filter'])).toBe(
      true,
    );
  });
  it('preserves cursor versions and prior-period form metrics across covered and raw populations', async () => {
    const first = await log('2026-01-01T00:03:00Z');
    const second = await log('2026-01-01T01:03:00Z', { verification: 'verified_dns' });
    const excluded = await log('2026-01-01T01:04:00Z', { selfCheck: true });
    for (const [id, version] of [
      [first, 'rules-a'],
      [second, 'rules-z'],
      [excluded, 'excluded'],
    ])
      await execute(
        `INSERT INTO liekan_crawler_evidence(website_id,log_id,classification_version) VALUES($1::uuid,$2,$3)`,
        site,
        id,
        version,
      );
    await log('2026-01-01T01:05:00Z', { ai: null, state: null });
    const { getLogFacts } = await import('./logs');
    const read = () =>
      getLogFacts(
        site,
        new Date('2026-01-01T01:00Z'),
        new Date('2026-01-01T02:00Z'),
        'UTC',
        1,
        '',
        '',
        '',
        'after',
        ['summary', 'bots', 'previousBots', 'recent'],
        { crawlerIdentityScope: 'all', crawlerMetricsVersion: 1, resource: 'ai/bots' },
      );
    const raw = await read();
    await finish(await shortLogBuild(from, new Date(+from + 7200000)));
    expect(await read()).toEqual(raw);
    expect(
      (await api.readAnalysisLogRollup(input({ fields: ['classificationSet'] }))).classificationSet,
    ).toBe('rules-a,rules-z');
    expect(
      (
        await api.readAnalysisLogRollup(
          input({ fields: ['classificationSet'], crawlerIdentityScope: 'verified_range' }),
        )
      ).classificationSet,
    ).toBe('rules-a');
    expect(raw.previousBots[0].requests).toBe(1);
    expect(raw.recent).toHaveLength(2);
  });
  it('matches exact raw log populations, encoded paths and all verification scopes', async () => {
    await log('2026-01-01T00:03:00Z');
    await log('2026-01-01T00:08:00Z', { verification: 'verified_dns', path: '/space%20here' });
    await log('2026-01-02T00:03:00Z', { ai: null, state: null });
    await log('2026-01-01T01:00:00Z', { selfCheck: true });
    await log('2026-01-03T00:00:00Z', { path: '/inclusive' });
    const raw = await api.readAnalysisLogRollup(input());
    const rawSeries = await api.readAnalysisLogSeries({ ...input(), grain: 'hour' });
    const legacy = await api.readAnalysisLogRollup(input({ crawlerMetricsVersion: undefined }));
    const dns = await api.readAnalysisLogRollup(
      input({ crawlerIdentityScope: 'verified_identity' }),
    );
    await finish(await build());
    const accelerated = await api.readAnalysisLogRollup(input());
    expect(withoutCoverage(accelerated)).toEqual(withoutCoverage(raw));
    expect(
      withoutCoverage(await api.readAnalysisLogRollup(input({ crawlerMetricsVersion: undefined }))),
    ).toEqual(withoutCoverage(legacy));
    expect(
      withoutCoverage(
        await api.readAnalysisLogRollup(input({ crawlerIdentityScope: 'verified_identity' })),
      ),
    ).toEqual(withoutCoverage(dns));
    expect(accelerated.summary.requests).toBe(3);
    expect(accelerated.pages.some(row => row.path === '/a%2Fb')).toBe(true);
    expect(accelerated.coverage.manifests).toBeGreaterThan(0);
    expect(accelerated.coverage.rawFallback).toBe(false);
    const rawScans: Record<string, unknown>[] = [];
    await db.analysisTransaction(
      async tx =>
        withinQuerySnapshot(
          {
            $executeRawUnsafe: (sql, ...values) => tx.$executeRawUnsafe(sql, ...values),
            $queryRawUnsafe: async (sql, ...values) => {
              if (sql.includes('raw_gaps_edges')) {
                const [explain] = await tx.$queryRawUnsafe<any[]>(
                  `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,
                  ...values,
                );
                const visit = (node: any) => {
                  if (node['Relation Name'] === 'liekan_log') rawScans.push(node);
                  for (const child of node.Plans || []) visit(child);
                };
                visit(explain['QUERY PLAN'][0].Plan);
              }
              return tx.$queryRawUnsafe(sql, ...values);
            },
          },
          () => api.readAnalysisLogRollup(input({ allowRawOnly: false })),
        ),
      'RepeatableRead',
    );
    expect(rawScans.length).toBeGreaterThan(0);
    expect(rawScans.every(node => node['Actual Loops'] === 0)).toBe(true);

    expect(await api.readAnalysisLogSeries({ ...input(), grain: 'hour' })).toEqual(rawSeries);
    const limited = await api.readAnalysisLogRollup({ ...input(), fields: ['hours'] });
    expect(limited.hours).toEqual(accelerated.hours);
    expect(limited.bots).toBeUndefined();
    expect(
      (await api.readAnalysisLogRollup(input({ crawlerIdentityScope: 'verified_range' }))).summary
        .requests,
    ).toBe(2);
  });
  it('keeps today static errors, case/path/query boundaries and import time exact through partial v4 coverage', async () => {
    const end = new Date('2026-01-01T00:15:00.123Z');
    const paths = [
      '/app.css',
      '/app.CSS?x=1',
      '/app.js#hash',
      '/app.js/guide',
      '/index.js-extra',
      '/report.pdf',
      '/data.json',
      '/asset.SvG',
      '/nested.css/path',
      '/x?file=app.js',
    ];
    for (const [index, path] of paths.entries())
      await log(`2026-01-01T00:0${Math.floor(index / 2)}:00Z`, {
        path,
        status: index === 0 ? 400 : 200,
        selfCheck: index === 4,
        verification: index === 6 ? 'unverified' : 'verified_range',
      });
    await log('2026-01-01T00:05:00Z', { path: '/edge' });
    await log('2026-01-01T00:15:00.123Z', { path: '/inclusive', status: 503 });
    await log('2026-01-01T00:15:00.124Z', { path: '/outside', status: 500 });
    await log('2025-12-31T23:59:59.999Z', { path: '/imported-today-event-yesterday' });
    await execute(
      "UPDATE liekan_import SET imported_at='2026-01-01T00:06Z',accepted=91 WHERE id=$1::uuid",
      imported,
    );
    const todayInput = { websiteId: site, startDate: from, endDate: end };
    const raw = await api.readAnalysisLogToday({ ...todayInput, allowRawOnly: true });
    expect(raw).toMatchObject({
      requests: 7,
      abnormal: 2,
      coverage: { manifests: 0, rawFallback: true },
    });
    await finish(await shortLogBuild(from, new Date('2026-01-01T00:05Z')));
    const partial = await api.readAnalysisLogToday(todayInput);
    expect(partial).toMatchObject({ requests: raw.requests, abnormal: raw.abnormal });
    expect(partial.coverage.manifests).toBeGreaterThan(0);
    const { getLogToday } = await import('./logs');
    expect(await getLogToday(site, from, end)).toEqual({ requests: 7, abnormal: 2, accepted: 91 });
    await finish(await shortLogBuild(new Date('2026-01-01T00:05Z'), new Date('2026-01-01T00:15Z')));
    expect(await api.readAnalysisLogToday(todayInput)).toMatchObject({ requests: 7, abnormal: 2 });
    for (const [startDate, endDate] of [
      [from, new Date('2026-01-01T00:05Z')],
      [new Date('2026-01-01T00:05Z'), new Date('2026-01-01T00:05Z')],
      [new Date('2026-01-01T00:00:00.001Z'), new Date('2026-01-01T00:15:00.122Z')],
    ]) {
      const value = { websiteId: site, startDate, endDate };
      const expected = await api.readAnalysisLogToday({ ...value, allowRawOnly: true });
      expect(await api.readAnalysisLogToday(value)).toMatchObject({
        requests: expected.requests,
        abnormal: expected.abnormal,
      });
    }
    const dimensions = await q<{ missing: bigint; variants: bigint }[]>(
      "SELECT count(*) FILTER(WHERE NOT(dimensions ? 'staticResource')) AS missing,count(DISTINCT dimensions->'staticResource') AS variants FROM liekan_analysis_log WHERE website_id=$1::uuid",
      site,
    );
    expect(dimensions[0]).toEqual({ missing: 0n, variants: 2n });
  });
  it('rejects the old global coverage vector for both families and reuses one pinned metadata read', async () => {
    await log('2026-01-01T00:01Z', { path: '/style.CSS', status: 404 });
    await event('2026-01-01T00:01Z');
    await finish(await build(from, new Date('2026-01-01T01:00Z')));
    await execute(
      `UPDATE liekan_analysis_manifest SET versions=jsonb_set(versions,'{engine}','"analysis-rollups-v3"') WHERE website_id=$1::uuid`,
      site,
    );
    const value = { websiteId: site, startDate: from, endDate: new Date('2026-01-01T01:00Z') };
    expect(await api.readAnalysisLogToday(value)).toMatchObject({
      requests: 0,
      abnormal: 1,
      coverage: { manifests: 0, rawFallback: true },
    });
    expect(await api.readAnalysisVisitTotals(value)).toBeNull();
    let metadataReads = 0;
    await db.analysisTransaction(
      tx =>
        withinQuerySnapshot(
          {
            $executeRawUnsafe: (statement: string, ...values: unknown[]) =>
              tx.$executeRawUnsafe(statement, ...values),
            $queryRawUnsafe: (statement: string, ...values: unknown[]) => {
              if (statement.startsWith('SELECT liekan_analysis_versions')) metadataReads++;
              return tx.$queryRawUnsafe(statement, ...values);
            },
          },
          async () => {
            await api.readAnalysisLogToday(value);
            await api.readAnalysisLogToday(value);
            await api.readAnalysisVisitTotals(value);
          },
        ),
      'RepeatableRead',
    );
    expect(metadataReads).toBe(1);
    await finish(await build(from, new Date('2026-01-01T01:00Z')));
    expect(await api.readAnalysisLogToday(value)).toMatchObject({ requests: 0, abnormal: 1 });
    expect(await api.readAnalysisVisitTotals(value)).not.toBeNull();
  });
  it('invalidates today coverage for late, corrected and deleted logs, mode and epoch changes', async () => {
    const end = new Date('2026-01-01T01:00Z');
    const id = await log('2026-01-01T00:01Z', { path: '/style.css', status: 404 });
    await finish(await build(from, end));
    const value = { websiteId: site, startDate: from, endDate: end };
    const check = async (requests: number, abnormal: number) => {
      expect(await api.readAnalysisLogToday(value)).toMatchObject({ requests, abnormal });
      expect(await api.readAnalysisLogToday({ ...value, allowRawOnly: true })).toMatchObject({
        requests,
        abnormal,
      });
    };
    await check(0, 1);
    await log('2026-01-01T00:02Z', { path: '/late' });
    await check(1, 1);
    await execute(
      "UPDATE liekan_log SET path='/corrected',status=200 WHERE website_id=$1::uuid AND id=$2",
      site,
      id,
    );
    await check(2, 0);
    await execute('DELETE FROM liekan_log WHERE website_id=$1::uuid AND id=$2', site, id);
    await check(1, 0);
    await finish(await build(from, end));
    await execute(
      "UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id=$1::uuid",
      site,
    );
    expect((await api.readAnalysisLogToday(value)).coverage.manifests).toBe(0);
    await check(1, 0);
    await execute(
      "UPDATE liekan_analysis_site SET mode='live',epoch=epoch+1 WHERE website_id=$1::uuid",
      site,
    );
    expect((await api.readAnalysisLogToday(value)).coverage.manifests).toBe(0);
    await check(1, 0);
  });
  it('merges visitor/visit IDs, custom events and fractional duration across hours and days', async () => {
    await event('2026-01-01T23:59:59.900Z');
    await event('2026-01-02T00:00:00.100Z');
    await event('2026-01-02T00:20:00Z', { type: 2 });
    await event('2026-01-02T02:00:00Z', { visit: randomUUID() });
    const args = { websiteId: site, startDate: from, endDate: until };
    const raw = await readVisits(args);
    expect(raw).toEqual({ pageviews: 3, visitors: 1, visits: 2, bounces: 1, totaltime: 0 });
    await finish(await build());
    expect(await readVisits(args)).toEqual(raw);
    expect(await readVisits({ ...args, startDate: new Date('2026-01-02T00:00:00Z') })).toEqual({
      pageviews: 2,
      visitors: 1,
      visits: 2,
      bounces: 1,
      totaltime: 0,
    });
  });
  it('preserves full-window custom presence for hostname filters and exact session distributions', async () => {
    await event('2026-01-01T00:00:01Z', { hostname: 'one.test' });
    await event('2026-01-01T01:00:01Z', { hostname: 'two.test', type: 2 });
    await event('2026-01-02T00:00:01Z', { hostname: 'two.test', visit: randomUUID() });
    const args = {
      websiteId: site,
      startDate: from,
      endDate: until,
      filters: { hostname: 'eq.one.test' },
    };
    const expected = { pageviews: 1, visitors: 1, visits: 1, bounces: 0, totaltime: 0 };
    expect(await readVisits(args)).toEqual(expected);
    expect(await readVisits({ ...args, filters: { hostname: 'c.one' } })).toBeNull();
    const rawCountry = await readMetrics({
      ...args,
      filters: {},
      type: 'country',
    });
    const rawBrowser = await readMetrics({
      ...args,
      filters: {},
      type: 'browser',
    });
    expect(rawCountry).toEqual([{ x: 'CN', y: 1 }]);
    expect(rawBrowser).toEqual([{ x: 'Chrome', y: 1 }]);
    await finish(await build());
    expect(await readVisits(args)).toEqual(expected);
    expect(await readMetrics({ ...args, filters: {}, type: 'country' })).toEqual(rawCountry);
    expect(await readMetrics({ ...args, filters: {}, type: 'browser' })).toEqual(rawBrowser);
    const [partitions] = await q<{ n: bigint }[]>(
      "SELECT count(*) AS n FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhparent JOIN pg_class child ON child.oid=i.inhrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname IN('liekan_analysis_log','liekan_analysis_path','liekan_analysis_visit') AND child.relname LIKE '%_2026_01'",
    );
    expect(partitions.n).toBe(3n);
    const status = await api.getAnalysisStatus(site, actor);
    expect(BigInt(status.capacity.siteBytes)).toBeGreaterThan(16n * 1024n * 1024n);
    expect(BigInt(status.capacity.globalBytes)).toBeGreaterThan(0n);
  });
  it('marks both event-time buckets for UPDATE and detects late facts in compressed empty spans', async () => {
    const id = await log('2026-01-01T00:00:00Z');
    await finish(await build());
    const before = await api.readAnalysisLogRollup(input());
    expect(before.summary.requests).toBe(1);
    await execute(
      "UPDATE liekan_log SET created_at='2026-01-02T12:34:00Z' WHERE website_id=$1::uuid AND id=$2",
      site,
      id,
    );
    const marked = await q<{ bucket: Date }[]>(
      "SELECT DISTINCT bucket FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND family='log' AND isfinite(bucket) ORDER BY bucket",
      site,
    );
    expect(marked.map(row => row.bucket.toISOString())).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T12:30:00.000Z',
    ]);
    await log('2026-01-02T13:00:00Z', { path: '/late' });
    const changed = await api.readAnalysisLogRollup(input());
    expect(changed.summary.requests).toBe(2);
    expect(changed.coverage.rawFallback).toBe(true);
    await finish(await build());
    expect(withoutCoverage(await api.readAnalysisLogRollup(input()))).toEqual(
      withoutCoverage(changed),
    );
    await execute('DELETE FROM liekan_log WHERE website_id=$1::uuid AND id=$2', site, id);
    expect((await api.readAnalysisLogRollup(input())).summary.requests).toBe(1);
  });
  it('invalidates visit coverage when quality and policy change while preserving missing inputs', async () => {
    const id = await event('2026-01-01T00:01:00Z');
    await finish(await build());
    const args = { websiteId: site, startDate: from, endDate: until };
    expect((await readVisits(args)).pageviews).toBe(1);
    await execute(
      "UPDATE liekan_event_quality SET classification='automated' WHERE event_id=$1::uuid",
      id,
    );
    expect((await readVisits(args)).pageviews).toBe(0);
    await execute(
      "INSERT INTO liekan_collection_policy(website_id,mode) VALUES($1::uuid,'raw')",
      site,
    );
    const [population] = await q<{ raw: bigint; eligible: bigint }[]>(
      `SELECT (SELECT count(*) FROM website_event WHERE website_id=$1::uuid) AS raw,
       (SELECT count(*) FROM liekan_geographic_website_event WHERE website_id=$1::uuid) AS eligible`,
      site,
    );
    expect(population).toEqual({ raw: 1n, eligible: 0n });
    expect((await readVisits(args)).pageviews).toBe(Number(population.eligible));
  });
  it('keeps capture while paused, fences disabled generations and replays management receipts', async () => {
    const task = await build();
    const request = {
      action: 'pause' as const,
      buildId: task.id,
      requestId: randomUUID(),
      expectedRevision: task.revision,
    };
    const response = await api.actionAnalysisBuild(site, actor, request);
    expect(await api.actionAnalysisBuild(site, actor, request)).toEqual(response);
    await log('2026-01-01T00:01:00Z');
    const [count] = await q<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM liekan_analysis_dirty WHERE website_id=$1::uuid',
      site,
    );
    expect(count.n).toBeGreaterThan(0n);
    expect((await api.runOneAnalysisWorkUnit(task.id)).worked).toBe(false);
    await api.actionAnalysisBuild(site, actor, {
      action: 'resume',
      buildId: task.id,
      requestId: randomUUID(),
    });
    await finish(task);
    const old = await api.getAnalysisStatus(site, actor);
    await api.actionAnalysisBuild(site, actor, { action: 'disable', requestId: randomUUID() });
    const [disabled] = await q<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM liekan_analysis_dirty WHERE website_id=$1::uuid',
      site,
    );
    await log('2026-01-02T01:00:00Z');
    const [after] = await q<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM liekan_analysis_dirty WHERE website_id=$1::uuid',
      site,
    );
    expect(after.n).toBe(disabled.n);
    await api.actionAnalysisBuild(site, actor, { action: 'enable', requestId: randomUUID() });
    const next = await api.getAnalysisStatus(site, actor);
    expect(BigInt(next.epoch)).toBeGreaterThan(BigInt(old.epoch));
    expect(next.coverage).toEqual([]);
    expect((await api.readAnalysisLogRollup(input())).summary.requests).toBe(2);
  });
  it('bounds dense work at 2000 rows, hides partial candidates and discards mutated candidates', async () => {
    await execute(
      `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
     SELECT lpad(n::text,64,'0'),$1::uuid,$2::uuid,timestamptz '2026-01-01Z'+n*interval '1 microsecond','/dense','GET',200,0,'','','GPTBot/1.0','','GPTBot','OpenAI','训练','verified_range',true,'recognized' FROM generate_series(1,2001) n`,
      site,
      imported,
    );
    const task = await build(from, new Date(+from + 3600000));
    await api.runOneAnalysisWorkUnit(task.id);
    const [checkpoint] = await q<{ checkpoint: { rows: string }; work_done: bigint }[]>(
      'SELECT checkpoint,work_done FROM liekan_analysis_build WHERE id=$1::uuid',
      task.id,
    );
    expect(checkpoint.checkpoint.rows).toBe('2000');
    expect(checkpoint.work_done).toBe(0n);
    expect((await api.readAnalysisLogRollup(input())).coverage.manifests).toBe(0);
    await execute(
      'UPDATE liekan_analysis_site SET path_expansion=false WHERE website_id=$1::uuid',
      site,
    );
    await api.runOneAnalysisWorkUnit(task.id);
    const [stoppedPath] = await q<{ checkpoint: { generation?: string } }[]>(
      'SELECT checkpoint FROM liekan_analysis_build WHERE id=$1::uuid',
      task.id,
    );
    expect(stoppedPath.checkpoint.generation).toBeUndefined();
    await execute(
      'UPDATE liekan_analysis_site SET path_expansion=true WHERE website_id=$1::uuid',
      site,
    );
    await api.runOneAnalysisWorkUnit(task.id);
    await execute(
      "UPDATE liekan_log SET path='/changed' WHERE website_id=$1::uuid AND id=lpad('1',64,'0')",
      site,
    );
    await api.runOneAnalysisWorkUnit(task.id);
    const [reset] = await q<{ checkpoint: { generation?: string } }[]>(
      'SELECT checkpoint FROM liekan_analysis_build WHERE id=$1::uuid',
      task.id,
    );
    expect(reset.checkpoint.generation).toBeUndefined();
    await finish(task);
    const result = await api.readAnalysisLogRollup(input());
    expect(result.summary.requests).toBe(2001);
    expect(result.pages.find(row => row.path === '/changed').requests).toBe(1);
  });
  it('compresses empty ranges and freezes total work units while finishing all logical buckets', async () => {
    const task = await build(from, new Date(+from + 100 * 86400000));
    expect(task.totalUnits).toBe('4800');
    const done = await finish(task);
    expect(done.work_total).toBe(4800n);
    expect(done.work_done).toBe(4800n);
    const [manifests] = await q<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM liekan_analysis_manifest WHERE website_id=$1::uuid',
      site,
    );
    expect(manifests.n).toBeLessThanOrEqual(6n);
  });
  it('fences transfer/reset/domain changes and excludes revoked historical managers', async () => {
    const task = await build();
    await execute(
      'UPDATE website SET user_id=$2::uuid WHERE website_id=$1::uuid',
      site,
      other.userId,
    );
    const [current] = await q<{ status: string }[]>(
      'SELECT status FROM liekan_analysis_build WHERE id=$1::uuid',
      task.id,
    );
    expect(current.status).toBe('invalidated');
    await expect(api.listAnalysisBuilds(site, actor)).rejects.toMatchObject({ status: 403 });
    expect((await api.runOneAnalysisWorkUnit(task.id)).worked).toBe(false);
  });
  it('captures closed live five-minute leaves with a 30-second buffer and fences expired global leases', async () => {
    const now = Date.now(),
      closed = new Date(Math.floor((now - 330000) / 300000) * 300000);
    await log(new Date(+closed + 1000).toISOString());
    await api.reconcileAnalysisRollups();
    const [live] = await q<
      { id: string; unit_seconds: number; family: string; range_start: Date; range_end: Date }[]
    >(
      "SELECT id,unit_seconds,family,range_start,range_end FROM liekan_analysis_build WHERE website_id=$1::uuid AND actor_id IS NULL AND family='log' ORDER BY created_at LIMIT 1",
      site,
    );
    expect(live.unit_seconds).toBe(300);
    expect(live.family).toBe('log');
    const token = randomUUID();
    await execute(
      "UPDATE liekan_analysis_background_lease SET token=$1::uuid,epoch=epoch+1,lease_until=clock_timestamp()-interval '1 second' WHERE id",
      token,
    );
    const [permit] = await q<{ epoch: bigint }[]>(
      'SELECT epoch FROM liekan_analysis_background_lease WHERE id',
    );
    await api.runOneAnalysisWorkUnit(live.id, { token, epoch: String(permit.epoch) });
    const [hidden] = await q<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM liekan_analysis_manifest WHERE website_id=$1::uuid',
      site,
    );
    expect(hidden.n).toBe(0n);
    await execute(
      'UPDATE liekan_analysis_build SET next_attempt_at=clock_timestamp() WHERE id=$1::uuid',
      live.id,
    );
    await finish({ id: live.id } as AnalysisBuildDto);
    const current = await api.readAnalysisLogRollup({
      ...input(),
      startDate: live.range_start,
      endDate: live.range_end,
    });
    expect(current.coverage.manifests).toBe(1);
    expect(current.coverage.rawFallback).toBe(live.unit_seconds === 300);
    expect(current.summary.requests).toBe(1);
    expect(
      (
        await api.readAnalysisLogRollup({
          ...input(),
          startDate: live.range_start,
          endDate: live.range_end,
          fields: ['statuses'],
        })
      ).coverage.rawFallback,
    ).toBe(false);
  });
  it('binds product forms to archived identity/catalog evidence and preserves other-category filters', async () => {
    const base = await (await import('./crawler-registry-context')).loadPublishedRegistry();
    const oldVersion = randomUUID(),
      newVersion = randomUUID();
    const [current] = await q<{ revision: bigint }[]>(
      'SELECT revision FROM liekan_crawler_registry_current WHERE id=1',
    );
    const revision = Number(current?.revision || 0n) + 1;
    for (const [version, form, number] of [
      [oldVersion, 'general', revision],
      [newVersion, 'workbench', revision + 1],
    ] as const) {
      const payload = structuredClone(base.payload);
      payload.identities.find(identity => identity.id === 'gptbot').productForm = form;
      await execute(
        "INSERT INTO liekan_crawler_registry_version(version,revision,content_hash,payload,action) VALUES($1::uuid,$2::bigint,$3,$4::jsonb,'publish')",
        version,
        number,
        createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        JSON.stringify(payload),
      );
    }
    if (!current) {
      await execute(
        "INSERT INTO liekan_crawler_registry_current(id,version,revision,seed_hash,seed_payload) VALUES(1,$1::uuid,$2::bigint,$3,'{}')",
        oldVersion,
        revision,
        'a'.repeat(64),
      );
    } else {
      await execute(
        'UPDATE liekan_crawler_registry_current SET version=$1::uuid,revision=$2::bigint WHERE id=1',
        oldVersion,
        revision,
      );
    }
    const oldLog = await log('2026-01-01T00:01:00Z'),
      newLog = await log('2026-01-01T00:02:00Z');
    for (const [id, version] of [
      [oldLog, oldVersion],
      [newLog, newVersion],
    ])
      await execute(
        "INSERT INTO liekan_crawler_evidence(website_id,log_id,crawler_id,catalog_version,classification_version,identity_evidence) VALUES($1::uuid,$2,'gptbot',$3::uuid,'fixture','{\"status\":\"verified_range\"}'::jsonb)",
        site,
        id,
        version,
      );
    await execute(
      'UPDATE liekan_crawler_registry_current SET version=$1::uuid,revision=$2::bigint WHERE id=1',
      newVersion,
      revision + 1,
    );
    const filtered = input({ filters: { resource: 'ai/bots', botProductForm: 'general' } });
    const raw = await api.readAnalysisLogRollup(filtered);
    expect(raw.bots).toHaveLength(1);
    expect(raw.bots[0].requests).toBe(1);
    expect(raw.bots[0].productForm).toBe('general');
    await finish(await build());
    const covered = await api.readAnalysisLogRollup(filtered);
    expect(withoutCoverage(covered)).toEqual(withoutCoverage(raw));
    expect(covered.coverage.rawFallback).toBe(false);
    expect(
      (
        await api.readAnalysisLogRollup(
          input({ filters: { resource: 'ai/bots', botCategory: 'other' } }),
        )
      ).bots,
    ).toEqual([]);
    // New evidence affects its own leaf while a disjoint historical leaf remains covered.
    await log('2026-01-02T15:00:01Z');
    const oldWindow = await api.readAnalysisLogRollup({
      ...filtered,
      endDate: new Date('2026-01-01T01:00:00Z'),
    });
    expect(oldWindow.coverage.manifests).toBe(1);
    expect(oldWindow.coverage.rawFallback).toBe(false);
  });
  it('bounds reporting joins and archived identity expansion after source eligibility without changing repaired facts', async () => {
    const legacyLogDimensionsSql =
      db.analysisLogDimensionsSql(`(SELECT identity->>'productForm' FROM liekan_crawler_registry_version v
   CROSS JOIN LATERAL jsonb_array_elements(v.payload->'identities') identity
   WHERE v.version=l.reporting_catalog_version AND identity->>'id'=l.reporting_crawler_id LIMIT 1)`);
    try {
      expect(
        createHash('sha256')
          .update(
            legacyLogDimensionsSql.replace(
              ` 'staticResource',l.path ~* '${staticRequestExtensionPattern}',\n`,
              '',
            ),
          )
          .digest('hex'),
      ).toBe('fd88430e483bf16cdded464f0233a5ca30b1c500e456cc5105617ebd6602ca61');
      const source = randomUUID(),
        version = randomUUID(),
        secondVersion = randomUUID(),
        run = randomUUID(),
        generation = randomUUID();
      const base = await (await import('./crawler-registry-context')).loadPublishedRegistry();
      const identity = base.payload.identities.find(value => value.id === 'gptbot');
      const [revision] = await q<{ value: bigint }[]>(
        'SELECT coalesce(max(revision),0) AS value FROM liekan_crawler_registry_version',
      );
      for (const [index, archived] of [version, secondVersion].entries()) {
        const payload = {
          ...base.payload,
          identities: [
            { ...identity, productForm: index ? 'general' : null },
            { ...identity, productForm: 'workbench' },
            { ...identity, id: 'alternate', productForm: 'workbench' },
          ],
        };
        await execute(
          "INSERT INTO liekan_crawler_registry_version(version,revision,content_hash,payload,action) VALUES($1::uuid,$2::bigint,$3,$4::jsonb,'publish')",
          archived,
          String(revision.value + BigInt(index + 1)),
          createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
          JSON.stringify(payload),
        );
      }
      await execute('INSERT INTO liekan_log_state(website_id) VALUES($1::uuid)', site);
      await execute(
        "INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by,owner_id,state) VALUES($1::uuid,$2::uuid,'server','example.test',$3::uuid,$3::uuid,'active')",
        source,
        site,
        actor.userId,
      );
      await execute(
        "INSERT INTO liekan_log_interval(id,website_id,source_id,starts_at,ends_at) VALUES($1::uuid,$2::uuid,$3::uuid,'2026-01-01T00:01Z','2026-01-01T01:00Z')",
        randomUUID(),
        site,
        source,
      );
      // Earlier automatic rows have no source interval; a raw LIMIT would stop before eligible rows.
      await execute(
        `INSERT INTO liekan_log(id,website_id,import_id,source_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
       SELECT gen_random_uuid()::text,$1::uuid,$2::uuid,$3::uuid,CASE WHEN n<4000 THEN timestamptz '2026-01-01T00:00:01Z' ELSE timestamptz '2026-01-01T00:02Z' END,
       '/encoded%2F'||(n%4),CASE WHEN n%3=0 THEN 'HEAD' ELSE 'GET' END,200+n%2,0,'','','Synthetic','','GPTBot','OpenAI','训练','verified_range',true,'recognized' FROM generate_series(0,8000)n`,
        site,
        imported,
        source,
      );
      await log('2026-01-01T00:00:30Z', { path: '/eligible-manual' });
      await log('2026-01-01T00:03Z', { path: '/excluded-manual' });
      // Match collector batch bounds while retaining the complete large query fixture.
      for (let offset = 0; offset < 4500; offset += 500)
        await execute(
          `INSERT INTO liekan_crawler_evidence(website_id,log_id,crawler_id,catalog_version,classification_version)
       SELECT website_id,id,CASE path WHEN '/encoded%2F0' THEN 'gptbot' WHEN '/encoded%2F1' THEN 'alternate' WHEN '/encoded%2F2' THEN 'missing' ELSE NULL END,
       CASE WHEN path='/encoded%2F3' THEN NULL WHEN method='HEAD' THEN $2::uuid ELSE $3::uuid END,'archived-fixture'
       FROM liekan_log WHERE website_id=$1::uuid AND created_at='2026-01-01T00:02Z' ORDER BY id LIMIT $4::int OFFSET $5::int`,
          site,
          version,
          secondVersion,
          500,
          offset,
        );
      const [repair] = await q<{ id: string }[]>(
        "SELECT min(id) AS id FROM liekan_log WHERE website_id=$1::uuid AND created_at='2026-01-01T00:02Z' AND path='/encoded%2F0'",
        site,
      );
      await execute(
        `INSERT INTO liekan_history_repair_run(id,website_id,campaign_id,actor_id,status,generation,active_generation,active_revision,repair_scope_id,snapshot,locale)
       VALUES($1::uuid,$2::uuid,'traffic-quality-repair-20261022-v1',$3::uuid,'completed',$4::uuid,$4::uuid,1,$5::uuid,'{}','en-US')`,
        run,
        site,
        actor.userId,
        generation,
        randomUUID(),
      );
      await execute(
        `INSERT INTO liekan_history_repair_result(run_id,website_id,generation,kind,record_id,before_value,after_value,proof)
       VALUES($1::uuid,$2::uuid,$3::uuid,'log',$4,'{}',$5::jsonb,$6::jsonb)`,
        run,
        site,
        generation,
        repair.id,
        JSON.stringify({ bot: 'Repaired identity', crawlerId: 'alternate', aiEligible: null }),
        JSON.stringify({ catalogVersion: version, rulepack: 'repair-fixture' }),
      );
      const end = new Date('2026-01-01T01:00Z');
      const oracle = await q(
        `SELECT * FROM(SELECT ${legacyLogDimensionsSql} AS dimensions,count(*)::text AS requests,min(l.created_at) AS first_at,max(l.created_at) AS last_at
       FROM liekan_reporting_log l WHERE l.website_id=$1::uuid AND l.created_at>=$2 AND l.created_at<$3 GROUP BY 1) oracle ORDER BY dimensions::text`,
        site,
        from,
        end,
      );
      const raw = await api.readAnalysisLogRollup(input({ endDate: end }));
      const rawToday = await api.readAnalysisLogToday({
        websiteId: site,
        startDate: from,
        endDate: end,
        allowRawOnly: true,
      });
      expect(raw.summary.requests).toBe(4002);
      let savedPlan: any;
      const original = db.analysisTransaction;
      const spy = vi.spyOn(db, 'analysisTransaction').mockImplementation(((work: any, level: any) =>
        original(
          async tx =>
            work({
              $executeRawUnsafe: (statement: string, ...values: unknown[]) =>
                tx.$executeRawUnsafe(statement, ...values),
              $queryRawUnsafe: async (statement: string, ...values: unknown[]) => {
                if (!savedPlan && statement.includes('INSERT INTO liekan_analysis_log')) {
                  await tx.$executeRawUnsafe('SAVEPOINT bounded_log_plan');
                  const [plan] = await tx.$queryRawUnsafe<any[]>(
                    `EXPLAIN(ANALYZE,BUFFERS,VERBOSE,FORMAT JSON) ${statement}`,
                    ...values,
                  );
                  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT bounded_log_plan');
                  savedPlan = plan['QUERY PLAN'][0];
                  await writeFile(
                    `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/bounded-log-chunk-plan.json`,
                    JSON.stringify(savedPlan),
                    { mode: 0o600 },
                  );
                }
                return tx.$queryRawUnsafe(statement, ...values);
              },
            }),
          level,
        )) as any);
      try {
        await finish(await build(from, end));
      } finally {
        spy.mockRestore();
      }
      const facts = await q(
        `SELECT l.dimensions,l.requests::text,l.first_at,l.last_at FROM liekan_analysis_log l JOIN liekan_analysis_manifest m
       ON m.website_id=l.website_id AND m.generation=l.generation AND m.family='log'
       WHERE l.website_id=$1::uuid AND l.grain='hour' ORDER BY l.dimensions::text`,
        site,
      );
      await writeFile(
        `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/bounded-log-chunk-facts.json`,
        JSON.stringify({ oracle, facts }),
        { mode: 0o600 },
      );
      expect(facts).toEqual(oracle);
      expect(facts.some(row => (row.dimensions as any).productForm === null)).toBe(true);
      expect(facts.some(row => (row.dimensions as any).bot === 'Repaired identity')).toBe(true);
      const covered = await api.readAnalysisLogRollup(input({ endDate: end }));
      expect(withoutCoverage(covered)).toEqual(withoutCoverage(raw));
      expect(covered.coverage.rawFallback).toBe(false);
      const nodes: any[] = [];
      const walk = (node: any) => {
        nodes.push(node);
        for (const child of node.Plans || []) walk(child);
      };
      expect(savedPlan).toBeDefined();
      expect(
        await api.readAnalysisLogToday({ websiteId: site, startDate: from, endDate: end }),
      ).toMatchObject({
        requests: rawToday.requests,
        abnormal: rawToday.abnormal,
      });
      walk(savedPlan.Plan);
      const evidence = nodes.filter(node => node['Relation Name'] === 'liekan_crawler_evidence');
      expect(evidence.length).toBeGreaterThan(0);
      expect
        .soft(Math.max(...evidence.map(node => node['Actual Rows'] * node['Actual Loops'])))
        .toBeLessThanOrEqual(2000);
      const catalogs = nodes.filter(node => node['Function Name'] === 'jsonb_array_elements');
      expect(catalogs.length).toBeGreaterThan(0);
      expect.soft(Math.max(...catalogs.map(node => node['Actual Loops']))).toBeLessThanOrEqual(2);
    } finally {
      await api.actionAnalysisBuild(site, actor, { action: 'disable', requestId: randomUUID() });
    }
  }, 30000);
  it('publishes the recent complete-day canary first and keeps low logs exact after path expansion stops', async () => {
    const task = await build();
    const [start] = await q<{ checkpoint: { stage: string; hour: string; canaryUntil: string } }[]>(
      'SELECT checkpoint FROM liekan_analysis_build WHERE id=$1::uuid',
      task.id,
    );
    expect(start.checkpoint.stage).toBe('canary');
    expect(+new Date(start.checkpoint.hour)).toBeGreaterThan(+from);
    await api.runOneAnalysisWorkUnit(task.id);
    const [first] = await q<{ bucket: Date; bucket_end: Date }[]>(
      'SELECT bucket,bucket_end FROM liekan_analysis_manifest WHERE website_id=$1::uuid ORDER BY created_at LIMIT 1',
      site,
    );
    expect(first.bucket.toISOString()).toBe(start.checkpoint.hour);
    expect(first.bucket_end.toISOString()).toBe(start.checkpoint.canaryUntil);
    await finish(task);
    await log('2026-01-01T00:01:00Z');
    await execute(
      'UPDATE liekan_analysis_site SET path_expansion=false WHERE website_id=$1::uuid',
      site,
    );
    await finish(await build());
    const low = await api.readAnalysisLogRollup({ ...input(), fields: ['hours'] });
    expect(low.coverage.rawFallback).toBe(false);
    expect(low.hours.reduce((n, row) => n + row.count, 0)).toBe(1);
    const paths = await api.readAnalysisLogRollup({ ...input(), fields: ['pages'] });
    expect(paths.coverage.rawFallback).toBe(true);
    expect(paths.pages[0].requests).toBe(1);
    await execute(
      'UPDATE liekan_analysis_site SET visit_expansion=false WHERE website_id=$1::uuid',
      site,
    );
    const stopped = await build(from, new Date(+from + 3600000));
    for (let i = 0; i < 3; i++) await api.runOneAnalysisWorkUnit(stopped.id);
    const [state] = await q<{ status: string; error_code: string }[]>(
      'SELECT status,error_code FROM liekan_analysis_build WHERE id=$1::uuid',
      stopped.id,
    );
    expect(state.status).toBe('capacity_limited');
    expect(state.error_code).toBe('analysis-visit-expansion-stopped');
    await expect(
      q('SELECT liekan_analysis_merge_count(\'{"a":1}\'::jsonb,\'{"a":2}\'::jsonb,1,1)'),
    ).rejects.toThrow('analysis-dimension-collision');
  });
  it('limits derived capacity without deleting raw facts and invalidates TRUNCATE coverage', async () => {
    await log('2026-01-01T00:01:00Z');
    const task = await build();
    await execute(
      'UPDATE liekan_analysis_site SET derived_bytes=$2::bigint WHERE website_id=$1::uuid',
      site,
      String(1024 ** 3),
    );
    await api.runOneAnalysisWorkUnit(task.id);
    const [limited] = await q<{ status: string }[]>(
      'SELECT status FROM liekan_analysis_build WHERE id=$1::uuid',
      task.id,
    );
    expect(limited.status).toBe('capacity_limited');
    expect((await api.readAnalysisLogRollup(input())).summary.requests).toBe(1);
    await execute(
      'UPDATE liekan_analysis_site SET derived_bytes=0 WHERE website_id=$1::uuid',
      site,
    );
    await api.actionAnalysisBuild(site, actor, {
      action: 'retry',
      buildId: task.id,
      requestId: randomUUID(),
    });
    await finish(task);
    await execute('TRUNCATE liekan_log CASCADE');
    const empty = await api.readAnalysisLogRollup(input());
    expect(empty.summary.requests).toBe(0);
    expect(empty.coverage.manifests).toBe(0);
  });
  it('meters new marker rows and preserves published epoch references while pruning obsolete markers', async () => {
    const id = await log('2026-01-01T00:01:00Z');
    const [before] = await q<{ bytes: string }[]>(
      'SELECT sum(bytes)::text AS bytes FROM liekan_analysis_meter WHERE website_id=$1::uuid',
      site,
    );
    await execute('UPDATE liekan_log SET status=201 WHERE website_id=$1::uuid AND id=$2', site, id);
    const [after] = await q<{ bytes: string }[]>(
      'SELECT sum(bytes)::text AS bytes FROM liekan_analysis_meter WHERE website_id=$1::uuid',
      site,
    );
    expect(after.bytes).toBe(before.bytes);
    await finish(await build());
    await api.actionAnalysisBuild(site, actor, { action: 'disable', requestId: randomUUID() });
    await api.actionAnalysisBuild(site, actor, { action: 'enable', requestId: randomUUID() });
    await execute(
      "UPDATE liekan_analysis_site SET updated_at=clock_timestamp()-interval '8 days' WHERE website_id=$1::uuid",
      site,
    );
    await api.reconcileAnalysisRollups();
    const [obsolete] = await q<{ dirty: bigint; manifests: bigint }[]>(
      `SELECT
      (SELECT count(*) FROM liekan_analysis_dirty d JOIN liekan_analysis_site s USING(website_id) WHERE d.website_id=$1::uuid AND d.epoch<>s.epoch) AS dirty,
      (SELECT count(*) FROM liekan_analysis_manifest m JOIN liekan_analysis_site s USING(website_id) WHERE m.website_id=$1::uuid AND m.epoch<>s.epoch) AS manifests`,
      site,
    );
    expect(obsolete.dirty).toBe(0n);
    expect(obsolete.manifests).toBeGreaterThan(0n);
    expect((await api.readAnalysisLogRollup(input())).summary.requests).toBe(1);
  });
  it('matches native SQL for missing session metadata and raw city aliases', async () => {
    const originalSession = session;
    await execute(
      "UPDATE session SET country=NULL,region=NULL,city='Beijing' WHERE session_id=$1::uuid",
      session,
    );
    await event('2026-01-01T00:01:00Z');
    session = randomUUID();
    const orphan = await event('2026-01-01T00:02:00Z');
    await execute(
      `INSERT INTO liekan_event_geography(event_id,website_id,country,region,city,source,trust,ip_family,precision,reason,rule_version,processed_at,country_basis)
      VALUES($1::uuid,$2::uuid,'CN','CN-11','Beijing','fixture','fixture','missing','city','fixture','fixture',clock_timestamp(),'fixture')`,
      orphan,
      site,
    );
    const normalizeNative = (value: unknown) => {
      const result = JSON.parse(
        JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? Number(v) : v)),
      );
      if (result?.population) {
        expect(['complete', 'empty', 'partial']).toContain(result.population.identity.status);
        if (result.population.identity.status === 'partial')
          expect(result.population).toMatchObject({
            metricScope: 'qualified-browser',
            identity: { eligiblePV: 2, qualifiedPV: 1, qualifiedVisitors: 1 },
          });
        const { population: _population, ...counts } = result;
        return counts;
      }
      return result;
    };
    const nativeStats = (filters: Record<string, unknown> = {}) =>
      import('@/queries/sql/getWebsiteStats').then(m =>
        m
          .getWebsiteStats(site, {
            startDate: from,
            endDate: until,
            ...filters,
            __nativeOracle: true,
          } as any)
          .then(normalizeNative),
      );
    const nativeMetrics = (type: string, filters: Record<string, unknown> = {}) =>
      import('@/queries/sql/sessions/getSessionMetrics').then(m =>
        m
          .getSessionMetrics(site, { type }, {
            startDate: from,
            endDate: until,
            ...filters,
            __nativeOracle: true,
          } as any)
          .then(normalizeNative),
      );
    const expected = await nativeStats();
    expect(expected).toMatchObject({ pageviews: 1, visitors: 1, visits: 1 });
    for (const filters of [
      {},
      { city: 'eq.Beijing' },
      { country: 'eq.CN' },
      { hostname: 'eq.example.test' },
    ])
      expect(
        await readVisits({ websiteId: site, startDate: from, endDate: until, filters }),
      ).toEqual(await nativeStats(filters));
    await finish(await build());
    for (const filters of [
      {},
      { city: 'eq.Beijing' },
      { country: 'eq.CN' },
      { hostname: 'eq.example.test' },
    ])
      expect(
        await readVisits({ websiteId: site, startDate: from, endDate: until, filters }),
      ).toEqual(await nativeStats(filters));
    for (const type of ['country', 'hostname', 'city'])
      expect(await readMetrics({ websiteId: site, startDate: from, endDate: until, type })).toEqual(
        await nativeMetrics(type),
      );
    expect((await api.getAnalysisStatus(site, actor)).coverage.some(row => row.current)).toBe(true);
    await execute(
      "INSERT INTO session(session_id,website_id,browser,country) VALUES($1::uuid,$2::uuid,'Firefox','CN')",
      session,
      site,
    );
    await execute(
      `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser)
      VALUES($1::uuid,$2::uuid,'browser','synthetic-fixture',true,'Firefox')`,
      orphan,
      site,
    );
    expect(
      await readVisits({
        websiteId: site,
        startDate: from,
        endDate: until,
        filters: { country: 'eq.CN' },
      }),
    ).toEqual(await nativeStats({ country: 'eq.CN' }));
    session = originalSession;
  });
  it('registers missing analysis metadata atomically through capture and bounded reconciliation', async () => {
    await execute('DELETE FROM liekan_analysis_site WHERE website_id=$1::uuid', site);
    await log('2026-01-01T00:01:00Z');
    const [capture] = await q<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM liekan_analysis_dirty WHERE website_id=$1::uuid',
      site,
    );
    expect(capture.n).toBeGreaterThan(0n);
    await execute('DELETE FROM liekan_analysis_site WHERE website_id=$1::uuid', site);
    expect((await api.getAnalysisStatus(site, actor)).mode).toBe('live');
    await execute('DELETE FROM liekan_analysis_site WHERE website_id=$1::uuid', site);
    await api.reconcileAnalysisRollups();
    const [registered] = await q<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM liekan_analysis_site WHERE website_id=$1::uuid',
      site,
    );
    expect(registered.n).toBe(1n);
  });
  it('recovers sentinel-only historical invalidation with current internal authority and origin provenance', async () => {
    await log('2026-01-01T00:01:00Z');
    await event('2026-01-01T00:01:00Z');
    const original = await build();
    await finish(original);
    await execute(
      'DELETE FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND isfinite(bucket)',
      site,
    );
    await execute(
      'UPDATE liekan_analysis_manifest SET fingerprint=liekan_analysis_fingerprint(website_id,epoch,family,bucket,bucket_end) WHERE website_id=$1::uuid',
      site,
    );
    await execute(
      "INSERT INTO liekan_collection_policy(website_id,mode) VALUES($1::uuid,'raw')",
      site,
    );
    const [finite] = await q<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND isfinite(bucket)',
      site,
    );
    expect(finite.n).toBe(0n);
    let recovered = false,
      actors: (string | null)[] = [];
    const origins: string[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      await api.reconcileAnalysisRollups();
      const jobs = await q<
        { id: string; actor_id: string | null; origin_build_id: string | null }[]
      >(
        "SELECT id,actor_id,origin_build_id FROM liekan_analysis_build WHERE website_id=$1::uuid AND status IN('queued','running')",
        site,
      );
      actors.push(...jobs.map(row => row.actor_id));
      origins.push(...jobs.map(row => row.origin_build_id).filter(Boolean));
      for (const job of jobs) await finish({ id: job.id } as AnalysisBuildDto);
      const current = await api.readAnalysisLogRollup(input({ allowRawOnly: false }));
      if (current && !current.coverage.rawFallback) {
        recovered = true;
        break;
      }
    }
    expect(actors.length).toBeGreaterThan(0);
    expect(actors.every(value => value === null)).toBe(true);
    expect(origins).toContain(original.id);
    expect(recovered).toBe(true);
  });
  it('splits compressed empty spans during live late-data repair without a manual range rebuild', async () => {
    await finish(await build(from, new Date(+from + 10 * 86400000)));
    await log('2026-01-05T12:01:00Z');
    for (let attempt = 0; attempt < 12; attempt++) {
      await api.reconcileAnalysisRollups();
      const jobs = await q<{ id: string }[]>(
        "SELECT id FROM liekan_analysis_build WHERE website_id=$1::uuid AND status IN('queued','running')",
        site,
      );
      for (const job of jobs) await finish({ id: job.id } as AnalysisBuildDto);
      const status = await api.getAnalysisStatus(site, actor);
      const logCoverage = status.coverage.filter(row => row.family === 'log' && row.current);
      if (
        logCoverage.some(row => row.rangeStart <= from.toISOString()) &&
        logCoverage.some(row => row.rangeEnd >= new Date(+from + 10 * 86400000).toISOString()) &&
        !(
          await api.readAnalysisLogRollup({
            ...input(),
            allowRawOnly: false,
            endDate: new Date(+from + 10 * 86400000),
          })
        ).coverage.rawFallback
      )
        break;
    }
    const current = await api.readAnalysisLogRollup({
      ...input(),
      allowRawOnly: false,
      endDate: new Date(+from + 10 * 86400000),
    });
    expect(current.coverage.rawFallback).toBe(false);
    expect(current.summary.requests).toBe(1);
  });
  it('rejects a real concurrent commit after the final candidate snapshot and before publication', async () => {
    const id = await log('2026-01-01T00:01:00Z');
    const task = await build(from, new Date(+from + 3600000));
    let races = 0;
    await api.runOneAnalysisWorkUnit(task.id, undefined, {
      beforeCandidateCommit: async () => {
        races++;
        await execute(
          "UPDATE liekan_log SET path='/concurrent' WHERE website_id=$1::uuid AND id=$2",
          site,
          id,
        );
      },
    });
    expect(races).toBe(1);
    const [manifest] = await q<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM liekan_analysis_manifest WHERE website_id=$1::uuid',
      site,
    );
    expect(manifest.n).toBe(0n);
    await finish(task);
    expect(
      (await api.readAnalysisLogRollup({ ...input(), endDate: new Date(+from + 3600000) })).pages[0]
        .path,
    ).toBe('/concurrent');
  });
  it('keeps an older covered day current through real ingestion, heartbeats and repair progress', async () => {
    const { processBatch, heartbeat } = await import('../log-ingestion/service');
    const { tokenHash } = await import('../log-ingestion/secrets');
    const { withPublishedRegistry } = await import('./crawler-registry-context');
    await withPublishedRegistry(async () => {
      const source = randomUUID(),
        token = randomUUID(),
        run = randomUUID(),
        generation = randomUUID();
      await execute('INSERT INTO liekan_log_state(website_id) VALUES($1::uuid)', site);
      await execute(
        `INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by,owner_id,state,credential_hash)
       VALUES($1::uuid,$2::uuid,'server','example.test',$3::uuid,$3::uuid,'active',$4)`,
        source,
        site,
        actor.userId,
        tokenHash(token),
      );
      await execute(
        `INSERT INTO liekan_log_interval(id,website_id,source_id,starts_at) VALUES($1::uuid,$2::uuid,$3::uuid,'2026-01-03Z')`,
        randomUUID(),
        site,
        source,
      );
      await execute(
        `INSERT INTO liekan_history_repair_run(id,website_id,campaign_id,actor_id,status,generation,repair_scope_id,snapshot,locale)
       VALUES($1::uuid,$2::uuid,'traffic-quality-repair-20261022-v1',$3::uuid,'scanning',$4::uuid,$5::uuid,$6::jsonb,'en-US')`,
        run,
        site,
        actor.userId,
        generation,
        randomUUID(),
        JSON.stringify({ rulepack: { engine: HISTORY_REPAIR_ENGINE } }),
      );
      await log('2026-01-01T00:01:00Z');
      await finish(await build(from, new Date('2026-01-02Z')));
      const coveredInput = { ...input(), endDate: new Date('2026-01-02Z'), allowRawOnly: false };
      expect((await api.readAnalysisLogRollup(coveredInput)).coverage.rawFallback).toBe(false);
      const before = await q<{ fingerprint: string }[]>(
        "SELECT fingerprint FROM liekan_analysis_manifest WHERE website_id=$1::uuid AND family='log' ORDER BY bucket",
        site,
      );
      const batch = randomUUID();
      const record = {
        id: randomUUID(),
        eventDigest: 'fixture',
        time: '2026-01-04T00:01:00Z',
        path: '/new-ingestion',
        method: 'GET',
        status: 200,
        bytes: 0,
        ipMasked: '',
        ipHash: '',
        userAgent: 'GPTBot/fixture',
        location: '',
        bot: 'GPTBot',
        vendor: 'OpenAI',
        type: '训练',
        verification: 'unverified',
        aiEligible: true,
        recognitionState: 'recognized',
      };
      await execute(
        `INSERT INTO liekan_ingest_batch(id,website_id,source_id,epoch,digest,payload,received,valid,rejected)
       VALUES($1::uuid,$2::uuid,$3::uuid,1,$1,$4::jsonb,1,1,0)`,
        batch,
        site,
        source,
        JSON.stringify([record]),
      );
      await processBatch(batch);
      await heartbeat(source, token, {
        version: 'fixture',
        pending: 0,
        bytes: 0,
        gap: false,
        errorCode: 'none',
      });
      await execute(
        `UPDATE liekan_log_source SET last_received_at=clock_timestamp(),last_permission_check_at=clock_timestamp(),
       provider_lease=$2::uuid,provider_lease_until=clock_timestamp()+interval '1 minute',last_maintenance_at=clock_timestamp(),provider_config='fixture',provider_job_id='fixture',error_code='fixture' WHERE id=$1::uuid`,
        source,
        randomUUID(),
      );
      await execute(
        "UPDATE liekan_history_repair_run SET phase='events',cursor='{\"page\":1}',counts='{\"rows\":1}',lease_token=$2::uuid,lease_until=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp() WHERE id=$1::uuid",
        run,
        randomUUID(),
      );
      await execute(
        `INSERT INTO liekan_history_repair_result(run_id,website_id,generation,kind,record_id,before_value,after_value,proof)
       VALUES($1::uuid,$2::uuid,$3::uuid,'log','unpublished','{}','{}','{}')`,
        run,
        site,
        generation,
      );
      await execute('UPDATE session SET browser=browser WHERE website_id=$1::uuid', site);
      await execute(
        'UPDATE liekan_log_interval SET starts_at=starts_at WHERE website_id=$1::uuid',
        site,
      );
      const after = await q<{ fingerprint: string }[]>(
        "SELECT fingerprint FROM liekan_analysis_manifest WHERE website_id=$1::uuid AND family='log' ORDER BY bucket",
        site,
      );
      expect(after).toEqual(before);
      const current = await api.readAnalysisLogRollup(coveredInput);
      expect(current.coverage.rawFallback).toBe(false);
      expect(current.summary.requests).toBe(1);
      await api.reconcileAnalysisRollups();
      const [recovery] = await q<{ n: bigint }[]>(
        "SELECT count(*) AS n FROM liekan_analysis_build WHERE website_id=$1::uuid AND request_hash='manifest-recovery'",
        site,
      );
      expect(recovery.n).toBe(0n);
      const [state] = await q<{ data_revision: bigint }[]>(
        'SELECT data_revision FROM liekan_log_state WHERE website_id=$1::uuid',
        site,
      );
      expect(state.data_revision).toBe(1n);
      // Semantic source and policy changes retain conservative family fencing.
      for (const mutation of [
        'UPDATE liekan_log_state SET policy_revision=policy_revision+1 WHERE website_id=$1::uuid',
        'UPDATE liekan_log_state SET epoch=epoch+1 WHERE website_id=$1::uuid',
        "UPDATE liekan_log_source SET owner_id='" +
          other.userId +
          "'::uuid WHERE website_id=$1::uuid",
        'UPDATE liekan_history_repair_run SET active_generation=generation,active_revision=active_revision+1 WHERE website_id=$1::uuid',
      ]) {
        const [prior] = await q<{ revision: bigint }[]>(
          "SELECT revision FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND family='log' AND bucket='-infinity'",
          site,
        );
        await execute(mutation, site);
        const [next] = await q<{ revision: bigint }[]>(
          "SELECT revision FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND family='log' AND bucket='-infinity'",
          site,
        );
        expect(next.revision).toBeGreaterThan(prior?.revision || 0n);
      }
    });
  });
  it('recovers the remainder of a nonempty historical hour after a smaller live leaf publishes', async () => {
    const id = await log('2026-01-01T00:01:00Z');
    await log('2026-01-01T00:21:00Z');
    await log('2026-01-01T00:51:00Z');
    await finish(await build(from, new Date(+from + 3600000)));
    await execute(
      'DELETE FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND isfinite(bucket)',
      site,
    );
    await execute(
      'UPDATE liekan_analysis_manifest SET fingerprint=liekan_analysis_fingerprint(website_id,epoch,family,bucket,bucket_end) WHERE website_id=$1::uuid',
      site,
    );
    for (let generation = 0; generation < 2; generation++) {
      if (generation) await finish(await build(from, new Date(+from + 3600000)));
      await execute(
        'UPDATE liekan_log SET path=$3 WHERE website_id=$1::uuid AND id=$2',
        site,
        id,
        `/late-fix-${generation}`,
      );
      const leaf = randomUUID();
      await execute(
        `INSERT INTO liekan_analysis_build(id,website_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total)
       VALUES($1::uuid,$2::uuid,1,'log',300,$3,$4,'UTC','en-US',$1::uuid,'fixture-leaf','queued',1)`,
        leaf,
        site,
        from,
        new Date(+from + 300000),
      );
      await finish({ id: leaf } as AnalysisBuildDto);
      const partial = await api.readAnalysisLogRollup({
        ...input(),
        endDate: new Date(+from + 3600000),
        allowRawOnly: false,
      });
      expect(partial.summary.requests).toBe(3);
      expect(partial.coverage.rawFallback).toBe(true);
      expect(
        (
          await api.readAnalysisLogSeries({
            ...input(),
            endDate: new Date(+from + 3600000),
            grain: 'hour',
          })
        ).reduce((n, row) => n + row.count, 0),
      ).toBe(3);
      const [residual] = await q<{ n: bigint }[]>(
        "SELECT count(*) AS n FROM liekan_analysis_build WHERE website_id=$1::uuid AND request_hash='overlap-recovery' AND status='queued'",
        site,
      );
      expect(residual.n).toBe(1n);
      for (let round = 0; round < 12; round++) {
        await api.reconcileAnalysisRollups();
        const jobs = await q<{ id: string }[]>(
          "SELECT id FROM liekan_analysis_build WHERE website_id=$1::uuid AND status IN('queued','running')",
          site,
        );
        for (const job of jobs) await finish({ id: job.id } as AnalysisBuildDto);
      }
      const current = await api.readAnalysisLogRollup({
        ...input(),
        endDate: new Date(+from + 3600000),
        allowRawOnly: false,
      });
      expect(current.coverage.rawFallback).toBe(false);
      expect(current.summary.requests).toBe(3);
    }
  });
  it('serializes publication and management with website and site locks before the build lock', async () => {
    await log('2026-01-01T00:01:00Z');
    const task = await build(from, new Date(+from + 3600000));
    let management: ReturnType<typeof api.actionAnalysisBuild>;
    await api.runOneAnalysisWorkUnit(task.id, undefined, {
      afterPublicationAuthority: async () => {
        management = api.actionAnalysisBuild(site, actor, {
          action: 'pause',
          buildId: task.id,
          requestId: randomUUID(),
        });
        await new Promise(resolve => setTimeout(resolve, 30));
      },
    });
    await expect(management).resolves.toMatchObject({ mode: 'live' });
    const [state] = await q<{ status: string; error_code: string | null }[]>(
      'SELECT status,error_code FROM liekan_analysis_build WHERE id=$1::uuid',
      task.id,
    );
    expect(state).toMatchObject({ status: 'paused', error_code: null });
    expect(
      (
        await api.readAnalysisLogRollup({
          ...input(),
          endDate: new Date(+from + 3600000),
          allowRawOnly: false,
        })
      ).summary.requests,
    ).toBe(1);
  });
  it('uses exact hourly facts for integral offsets and five-minute facts for Kathmandu and partial hours', async () => {
    const startDate = new Date('2026-01-01T18:00Z'),
      endDate = new Date('2026-01-01T20:00Z');
    for (const at of ['18:10', '18:20', '18:40']) await log(`2026-01-01T${at}:00Z`);
    const logs = await import('./logs');
    const expected = new Map<string, unknown>();
    for (const timezone of ['UTC', 'Asia/Shanghai', 'Asia/Kathmandu'])
      for (const start of [startDate, new Date('2026-01-01T18:15Z')]) {
        const facts = await logs.getLogFacts(
          site,
          start,
          endDate,
          timezone,
          1,
          '',
          '',
          '',
          'after',
          ['summary', 'daily', 'statuses', 'hours'],
          { crawlerMetricsVersion: 1, crawlerIdentityScope: 'all' },
        );
        const series = await logs.getPlotLogs(site, start, endDate, timezone, false, {
          crawlerMetricsVersion: 1,
          crawlerIdentityScope: 'all',
        });
        expected.set(`${timezone}/${start.toISOString()}`, {
          summary: facts.summary,
          daily: facts.daily,
          statuses: facts.statuses,
          hours: facts.hours,
          series,
        });
      }
    await finish(await build(startDate, endDate));
    for (const timezone of ['UTC', 'Asia/Shanghai', 'Asia/Kathmandu'])
      for (const start of [startDate, new Date('2026-01-01T18:15Z')]) {
        const args = {
          ...input(),
          startDate: start,
          endDate,
          timezone,
          allowRawOnly: false,
          fields: ['summary', 'daily', 'statuses', 'hours'],
        };
        let lowRows: number;
        const facts = await db.analysisTransaction(
          tx =>
            withinQuerySnapshot(
              {
                $executeRawUnsafe: (sql, ...values) => tx.$executeRawUnsafe(sql, ...values),
                $queryRawUnsafe: async (sql, ...values) => {
                  if (sql.includes('raw_gaps_edges')) {
                    const [plan] = await tx.$queryRawUnsafe<any[]>(
                      `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,
                      ...values,
                    );
                    const walk = (node: any) => {
                      if (node['Subplan Name'] === 'CTE low') lowRows = node['Actual Rows'];
                      for (const child of node.Plans || []) walk(child);
                    };
                    walk(plan['QUERY PLAN'][0].Plan);
                  }
                  return tx.$queryRawUnsafe(sql, ...values);
                },
              },
              () => api.readAnalysisLogRollup(args),
            ),
          'RepeatableRead',
        );
        const series = await api.readAnalysisLogSeries({ ...args, grain: 'day' });
        expect({
          summary: facts.summary,
          daily: facts.daily,
          statuses: facts.statuses,
          hours: facts.hours,
          series,
        }).toEqual(expected.get(`${timezone}/${start.toISOString()}`));
        if (+start === +startDate) expect(lowRows).toBe(timezone === 'Asia/Kathmandu' ? 3 : 1);
        else expect(facts.coverage.rawFallback).toBe(true);
      }
  });
  it('prunes unrelated derived month partitions with real bucket bounds', async () => {
    const january = new Date('2026-01-31T23:00Z'),
      february = new Date('2026-02-01T00:00Z'),
      endDate = new Date('2026-02-01T01:00Z');
    await log('2026-01-31T23:55:00Z');
    await log('2026-02-01T00:05:00Z');
    await finish(await build(january, endDate));
    const scans: any[] = [];
    await db.analysisTransaction(
      tx =>
        withinQuerySnapshot(
          {
            $executeRawUnsafe: (sql, ...values) => tx.$executeRawUnsafe(sql, ...values),
            $queryRawUnsafe: async (sql, ...values) => {
              if (sql.includes('raw_gaps_edges') || sql.includes('series_gaps_edges')) {
                const [plan] = await tx.$queryRawUnsafe<any[]>(
                  `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,
                  ...values,
                );
                const walk = (node: any) => {
                  if (/^liekan_analysis_(log|path)_/.test(node['Relation Name'] || ''))
                    scans.push(node);
                  for (const child of node.Plans || []) walk(child);
                };
                walk(plan['QUERY PLAN'][0].Plan);
              }
              return tx.$queryRawUnsafe(sql, ...values);
            },
          },
          async () => {
            const args = {
              ...input(),
              startDate: february,
              endDate,
              timezone: 'UTC',
              allowRawOnly: false,
            };
            expect((await api.readAnalysisLogRollup(args)).summary.requests).toBe(1);
            expect(
              (await api.readAnalysisLogSeries({ ...args, grain: 'day' })).reduce(
                (n, row) => n + row.count,
                0,
              ),
            ).toBe(1);
          },
        ),
      'RepeatableRead',
    );
    expect(
      scans.some(node => node['Relation Name'].endsWith('_2026_02') && node['Actual Loops'] > 0),
    ).toBe(true);
    expect(
      scans
        .filter(node => !node['Relation Name'].endsWith('_2026_02'))
        .every(node => node['Actual Loops'] === 0),
    ).toBe(true);
  });
  it('keeps raw IP and full UA absent from every derived table', async () => {
    const columns = await q<{ column_name: string }[]>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name LIKE 'liekan_analysis_%'",
    );
    expect(
      columns.some(row =>
        /^(ip|ip_masked|ip_hash|user_agent|raw_ip|full_ua)$/.test(row.column_name),
      ),
    ).toBe(false);
  });
  it('marks an event leaf once per statement and preserves evidence revisions and rollback', async () => {
    const id = randomUUID();
    await expect(
      db.analysisTransaction(async tx => {
        await tx.$executeRawUnsafe(
          `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type)
        VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,$4,'/capture',1)`,
          id,
          site,
          session,
          from,
        );
        const revision = async () =>
          (
            await tx.$queryRawUnsafe<{ revision: bigint }[]>(
              "SELECT revision FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND family='visit' AND bucket=$2",
              site,
              from,
            )
          )[0].revision;
        expect(await revision()).toBe(1n);
        await tx.$executeRawUnsafe(
          `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status)
        VALUES($1::uuid,$2::uuid,'browser','browser','{}','fixture','missing')`,
          id,
          site,
        );
        expect(await revision()).toBe(2n);
        await tx.$executeRawUnsafe(
          `INSERT INTO liekan_event_geography(event_id,website_id,source,trust,ip_family,precision,reason,rule_version,country_basis,processed_at)
        VALUES($1::uuid,$2::uuid,'synthetic','unverified','missing','city','synthetic','fixture','missing',clock_timestamp())`,
          id,
          site,
        );
        expect(await revision()).toBe(3n);
        await tx.$executeRawUnsafe(
          'UPDATE liekan_event_quality SET classification=classification WHERE event_id=$1::uuid',
          id,
        );
        expect(await revision()).toBe(3n);
        throw new Error('fixture-atomic-rollback');
      }),
    ).rejects.toThrow('fixture-atomic-rollback');
    expect(
      (
        await q<{ n: bigint }[]>(
          'SELECT count(*) AS n FROM website_event WHERE event_id=$1::uuid',
          id,
        )
      )[0].n,
    ).toBe(0n);
    expect(
      (
        await q<{ n: bigint }[]>(
          "SELECT count(*) AS n FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND family='visit'",
          site,
        )
      )[0].n,
    ).toBe(0n);
  });
  it('keeps every direct leaf for large transition statements and bounds single-event visit neighbors', async () => {
    await execute(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type)
      SELECT md5(n::text)::uuid,$1::uuid,$2::uuid,$2::uuid,$3::timestamptz+n*interval '1 hour','/large-transition',1
      FROM generate_series(0,2001) n`,
      site,
      session,
      from,
    );
    const [large] = await q<{ leaves: bigint; overflow: bigint }[]>(
      `SELECT count(DISTINCT bucket) FILTER(WHERE isfinite(bucket)) AS leaves,
      count(*) FILTER(WHERE NOT isfinite(bucket)) AS overflow FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND family='visit'`,
      site,
    );
    expect(large).toEqual({ leaves: 2002n, overflow: 1n });
    const id = randomUUID(),
      at = new Date(+from + 3000 * 3600000);
    await execute(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type)
      VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,$4,'/bounded-neighbors',1)`,
      id,
      site,
      session,
      at,
    );
    expect(
      (
        await q<{ revision: bigint }[]>(
          `SELECT revision FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND family='visit' AND bucket='-infinity'::timestamptz`,
          site,
        )
      )[0].revision,
    ).toBe(2n);
    expect(
      (
        await q<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND family='visit' AND bucket=$2`,
          site,
          at,
        )
      )[0].n,
    ).toBe(1n);
    await execute(
      `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status)
      SELECT event_id,website_id,'browser','browser','{}','fixture','missing' FROM website_event WHERE website_id=$1::uuid`,
      site,
    );
    expect(
      (
        await q<{ revision: bigint }[]>(
          `SELECT revision FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND family='visit' AND bucket='-infinity'::timestamptz`,
          site,
        )
      )[0].revision,
    ).toBe(3n);
    await api.actionAnalysisBuild(site, actor, { action: 'disable', requestId: randomUUID() });
  });
  it('consolidates twelve low-only leaves into one closed UTC hourly path generation', async () => {
    for (let n = 0; n < 12; n++) {
      await log(new Date(+from + n * 300000 + 60000).toISOString(), { path: '/hourly' });
      const id = randomUUID();
      await execute(
        `INSERT INTO liekan_analysis_build(id,website_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total)
        VALUES($1::uuid,$2::uuid,1,'log',300,$3,$4,'UTC','en-US',$1::uuid,'leaf-fixture','queued',1)`,
        id,
        site,
        new Date(+from + n * 300000),
        new Date(+from + (n + 1) * 300000),
      );
      await finish({ id } as AnalysisBuildDto);
    }
    const args = { ...input(), endDate: new Date(+from + 3600000), allowRawOnly: false };
    expect((await api.readAnalysisLogRollup(args)).coverage.rawFallback).toBe(true);
    expect(
      (await api.readAnalysisLogRollup({ ...args, fields: ['statuses'] })).coverage.rawFallback,
    ).toBe(false);
    const [old] = await q<{ n: bigint }[]>(
      "SELECT count(*) AS n FROM liekan_analysis_manifest WHERE website_id=$1::uuid AND family='log' AND path_complete",
      site,
    );
    expect(old.n).toBe(0n);
    await api.reconcileAnalysisRollups();
    const [merge] = await q<{ id: string; unit_seconds: number }[]>(
      "SELECT id,unit_seconds FROM liekan_analysis_build WHERE website_id=$1::uuid AND status='queued' AND family='log'",
      site,
    );
    expect(merge?.unit_seconds).toBe(3600);
    await finish({ id: merge.id } as AnalysisBuildDto);
    const current = await api.readAnalysisLogRollup(args);
    expect(current.summary.requests).toBe(12);
    expect(current.summary.pages).toBe(1);
    expect(current.coverage.rawFallback).toBe(false);
    const [facts] = await q<{ n: bigint; requests: bigint }[]>(
      `SELECT count(*) AS n,sum(p.requests)::bigint AS requests FROM liekan_analysis_path p
      JOIN liekan_analysis_manifest m ON m.website_id=p.website_id AND m.generation=p.generation WHERE p.website_id=$1::uuid`,
      site,
    );
    expect(facts).toEqual({ n: 1n, requests: 12n });
    await api.reconcileAnalysisRollups();
    expect(
      (
        await q<{ n: bigint }[]>(
          "SELECT count(*) AS n FROM liekan_analysis_build WHERE website_id=$1::uuid AND status IN('queued','running')",
          site,
        )
      )[0].n,
    ).toBe(0n);
  });
  it('splits legacy nonaligned hours while retaining frozen progress and a covered middle hour', async () => {
    const start = new Date('2026-01-01T18:15Z'),
      end = new Date('2026-01-01T20:15Z'),
      id = randomUUID();
    for (const at of ['18:20', '19:20', '20:10']) {
      await log(`2026-01-01T${at}:00Z`);
      await event(`2026-01-01T${at}:00Z`);
    }
    await execute(
      `INSERT INTO liekan_analysis_build(id,website_id,actor_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total)
      VALUES($1::uuid,$2::uuid,$3::uuid,1,'both',3600,$4,$5,'Asia/Kathmandu','en-US',$1::uuid,'legacy-boundary','queued',4)`,
      id,
      site,
      actor.userId,
      start,
      end,
    );
    const done = await finish({ id } as AnalysisBuildDto);
    expect(done.work_done).toBe(4n);
    expect(done.work_total).toBe(4n);
    const value = await api.readAnalysisLogRollup({
      ...input(),
      startDate: new Date('2026-01-01T19:00Z'),
      endDate: new Date('2026-01-01T20:00Z'),
      timezone: 'Asia/Kathmandu',
      allowRawOnly: false,
    });
    expect(value?.summary.requests).toBe(1);
    expect(value?.coverage.rawFallback).toBe(false);
    const rows = await q<{ bucket: Date; at: Date }[]>(
      `SELECT f.bucket,f.min_time AS at FROM liekan_analysis_visit f JOIN liekan_analysis_manifest m
      ON m.website_id=f.website_id AND m.generation=f.generation WHERE f.website_id=$1::uuid AND f.min_time IS NOT NULL`,
      site,
    );
    expect(rows.length).toBe(3);
    expect(rows.every(r => +r.bucket === Math.floor(+r.at / 3600000) * 3600000)).toBe(true);
  });
  it('serializes a raw update blocked at capture with a concurrent disable', async () => {
    const id = await log(from.toISOString());
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve)),
      ready = new Promise<void>(resolve => (locked = resolve));
    const holder = db.analysisTransaction(async tx => {
      await tx.$queryRawUnsafe(
        "SELECT 1 FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND family='log' FOR UPDATE",
        site,
      );
      locked();
      await gate;
    });
    await ready;
    const writer = execute(
      "UPDATE liekan_log SET path='/epoch-race' WHERE website_id=$1::uuid AND id=$2",
      site,
      id,
    );
    let blocked = false;
    for (let n = 0; n < 30 && !blocked; n++) {
      blocked =
        (
          await q<{ n: bigint }[]>(
            "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE liekan_log SET path=%'",
          )
        )[0].n > 0n;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    let finished = false;
    const disable = api
      .actionAnalysisBuild(site, actor, { action: 'disable', requestId: randomUUID() })
      .then(v => {
        finished = true;
        return v;
      });
    try {
      expect(blocked).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(finished).toBe(false);
    } finally {
      release();
      await Promise.all([holder, writer, disable]);
    }
    expect(
      (
        await q<{ path: string }[]>(
          'SELECT path FROM liekan_log WHERE website_id=$1::uuid AND id=$2',
          site,
          id,
        )
      )[0].path,
    ).toBe('/epoch-race');
  });
  it('rolls back inverse capture order and captures its retry in the enabled epoch', async () => {
    const id = await log(from.toISOString());
    let release!: () => void, locked!: () => void;
    const wait = new Promise<void>(r => (release = r)),
      ready = new Promise<void>(r => (locked = r));
    const control = db.analysisTransaction(async tx => {
      await tx.$queryRawUnsafe(
        'SELECT website_id FROM website WHERE website_id=$1::uuid FOR UPDATE',
        site,
      );
      await tx.$queryRawUnsafe(
        'SELECT website_id FROM liekan_analysis_site WHERE website_id=$1::uuid FOR UPDATE',
        site,
      );
      await tx.$executeRawUnsafe(
        "UPDATE liekan_analysis_site SET mode='disabled',epoch=epoch+1 WHERE website_id=$1::uuid",
        site,
      );
      locked();
      await wait;
    });
    await ready;
    try {
      await expect(
        nativeExecute(
          "UPDATE liekan_log SET path='/epoch-retry' WHERE website_id=$1::uuid AND id=$2",
          site,
          id,
        ),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      release();
      await control;
    }
    expect(
      (
        await q<{ path: string }[]>(
          'SELECT path FROM liekan_log WHERE website_id=$1::uuid AND id=$2',
          site,
          id,
        )
      )[0].path,
    ).toBe('/a%2Fb');
    await api.actionAnalysisBuild(site, actor, { action: 'enable', requestId: randomUUID() });
    await execute(
      "UPDATE liekan_log SET path='/epoch-retry' WHERE website_id=$1::uuid AND id=$2",
      site,
      id,
    );
    expect(
      (
        await q<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM liekan_analysis_dirty d JOIN liekan_analysis_site s USING(website_id,epoch)
      WHERE d.website_id=$1::uuid AND d.family='log' AND isfinite(d.bucket)`,
          site,
        )
      )[0].n,
    ).toBeGreaterThan(0n);
  });
  it('holds the epoch fence for a disabled raw writer until enable can start its baseline', async () => {
    const id = await log(from.toISOString());
    await api.actionAnalysisBuild(site, actor, { action: 'disable', requestId: randomUUID() });
    let release!: () => void, locked!: () => void;
    const wait = new Promise<void>(r => (release = r)),
      ready = new Promise<void>(r => (locked = r));
    const writer = db.analysisTransaction(async tx => {
      await tx.$executeRawUnsafe(
        "UPDATE liekan_log SET path='/disabled-commit' WHERE website_id=$1::uuid AND id=$2",
        site,
        id,
      );
      locked();
      await wait;
    });
    await ready;
    let enabled = false;
    const control = api
      .actionAnalysisBuild(site, actor, { action: 'enable', requestId: randomUUID() })
      .then(v => {
        enabled = true;
        return v;
      });
    try {
      await new Promise(r => setTimeout(r, 100));
      expect(enabled).toBe(false);
    } finally {
      release();
      await Promise.all([writer, control]);
    }
    await finish(await build(from, new Date(+from + 3600000)));
    expect(
      (await api.readAnalysisLogRollup({ ...input(), endDate: new Date(+from + 3600000) })).pages[0]
        .path,
    ).toBe('/disabled-commit');
  });
  it('allows real collection while a builder holds shared authority and non-key byte accounting locks', async () => {
    await log(from.toISOString());
    const task = await build(from, new Date(+from + 3600000));
    let collected = false;
    await api.runOneAnalysisWorkUnit(task.id, undefined, {
      beforeCandidateCommit: async () => {
        await event(from.toISOString());
        collected = true;
      },
    });
    expect(collected).toBe(true);
    expect(
      (
        await q<{ n: bigint }[]>(
          'SELECT count(*) AS n FROM website_event WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(1n);
  });
  it.each(['reset', 'delete'] as const)(
    'orders %s before raw child mutation while a writer owns its capture fence',
    async action => {
      const id = await log(from.toISOString());
      let release!: () => void, locked!: () => void;
      const wait = new Promise<void>(r => (release = r)),
        ready = new Promise<void>(r => (locked = r));
      const writer = db.analysisTransaction(async tx => {
        await tx.$executeRawUnsafe(
          "UPDATE liekan_log SET path='/lifecycle-writer' WHERE website_id=$1::uuid AND id=$2",
          site,
          id,
        );
        locked();
        await wait;
      });
      await ready;
      const lifecycle = await import('./lifecycle');
      let finished = false;
      const control = db
        .analysisTransaction(async tx => {
          if (action === 'reset') {
            await lifecycle.resetLiekanStatistics(tx, site, actor);
            await tx.$executeRawUnsafe(
              'UPDATE website SET reset_at=clock_timestamp() WHERE website_id=$1::uuid',
              site,
            );
          } else {
            await lifecycle.stopWebsiteSources(tx, site, true);
            await tx.$executeRawUnsafe('DELETE FROM website WHERE website_id=$1::uuid', site);
          }
        })
        .then(() => {
          finished = true;
        });
      try {
        await new Promise(r => setTimeout(r, 100));
        expect(finished).toBe(false);
      } finally {
        release();
        await Promise.all([writer, control]);
      }
      expect(
        (
          await q<{ n: bigint }[]>(
            'SELECT count(*) AS n FROM liekan_log WHERE website_id=$1::uuid',
            site,
          )
        )[0].n,
      ).toBe(0n);
    },
  );
  it('rejects missing-site registration without waiting on a lifecycle parent and allows hard-delete cascade', async () => {
    const id = await log(from.toISOString());
    await execute('DELETE FROM liekan_analysis_site WHERE website_id=$1::uuid', site);
    let release!: () => void, locked!: () => void;
    const wait = new Promise<void>(r => (release = r)),
      ready = new Promise<void>(r => (locked = r));
    const control = db.analysisTransaction(async tx => {
      await tx.$queryRawUnsafe(
        'SELECT website_id FROM website WHERE website_id=$1::uuid FOR UPDATE',
        site,
      );
      locked();
      await wait;
      await tx.$executeRawUnsafe('DELETE FROM website WHERE website_id=$1::uuid', site);
    });
    await ready;
    try {
      await expect(
        nativeExecute(
          "UPDATE liekan_log SET path='/missing-site-race' WHERE website_id=$1::uuid AND id=$2",
          site,
          id,
        ),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      release();
      await control;
    }
    expect(
      (
        await q<{ n: bigint }[]>(
          'SELECT count(*) AS n FROM liekan_analysis_site WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(0n);
  });
  it('pins an in-flight session insertion before enable can publish orphan-event dimensions', async () => {
    await api.actionAnalysisBuild(site, actor, { action: 'disable', requestId: randomUUID() });
    const late = randomUUID(),
      eventId = randomUUID();
    let release!: () => void, locked!: () => void;
    const wait = new Promise<void>(r => (release = r)),
      ready = new Promise<void>(r => (locked = r));
    const writer = db.analysisTransaction(async tx => {
      await tx.$executeRawUnsafe(
        "INSERT INTO session(session_id,website_id,browser) VALUES($1::uuid,$2::uuid,'LateBrowser')",
        late,
        site,
      );
      locked();
      await wait;
    });
    await ready;
    let enabled = false,
      prebuilt = false;
    let control: Promise<unknown>;
    try {
      await execute(
        "INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type) VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,$4,'/orphan-race',1)",
        eventId,
        site,
        late,
        from,
      );
      await execute(
        "INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status) VALUES($1::uuid,$2::uuid,'browser','browser','{}','fixture','missing')",
        eventId,
        site,
      );
      await execute(
        "INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser) VALUES($1::uuid,$2::uuid,'browser','fixture-event-environment',true,'Event browser')",
        eventId,
        site,
      );
      control = api
        .actionAnalysisBuild(site, actor, { action: 'enable', requestId: randomUUID() })
        .then(v => {
          enabled = true;
          return v;
        });
      await new Promise(r => setTimeout(r, 100));
      if (enabled) {
        await finish(await build(from, new Date(+from + 3600000)));
        prebuilt = true;
      }
    } finally {
      release();
      await writer;
      await control;
    }
    if (!prebuilt) await finish(await build(from, new Date(+from + 3600000)));
    const metrics = await api.readAnalysisVisitMetrics({
      websiteId: site,
      startDate: from,
      endDate: new Date(+from + 3600000),
      type: 'browser',
    });
    const expected = await q<{ x: string; y: bigint }[]>(
      `SELECT e.liekan_browser AS x,count(DISTINCT e.session_id) AS y
       FROM liekan_geographic_website_event e JOIN session s ON s.website_id=e.website_id AND s.session_id=e.session_id
       WHERE e.website_id=$1::uuid AND e.event_id=$2::uuid GROUP BY 1`,
      site,
      eventId,
    );
    expect(expected).toEqual([{ x: 'Event browser', y: 1n }]);
    expect(metrics).toEqual(expected.map(row => ({ ...row, y: Number(row.y) })));
    expect(prebuilt).toBe(false);
  });
  it('continues closed five-minute maintenance inside a paused manual history range', async () => {
    const history = await build();
    await api.actionAnalysisBuild(site, actor, {
      action: 'pause',
      buildId: history.id,
      requestId: randomUUID(),
    });
    await log('2026-01-01T00:56:00Z');
    await api.reconcileAnalysisRollups();
    const [live] = await q<{ id: string; unit_seconds: number }[]>(
      "SELECT id,unit_seconds FROM liekan_analysis_build WHERE website_id=$1::uuid AND actor_id IS NULL AND status='queued' ORDER BY range_start",
      site,
    );
    expect(live?.unit_seconds).toBe(300);
    await finish({ id: live.id } as AnalysisBuildDto);
    const value = await api.readAnalysisLogRollup({
      ...input(),
      startDate: new Date('2026-01-01T00:55Z'),
      endDate: new Date('2026-01-01T01:00Z'),
      fields: ['statuses'],
      allowRawOnly: false,
    });
    expect(value?.statuses).toEqual([{ status: 200, count: 1 }]);
    expect(value?.coverage.rawFallback).toBe(false);
    expect(
      (
        await q<{ status: string }[]>(
          'SELECT status FROM liekan_analysis_build WHERE id=$1::uuid',
          history.id,
        )
      )[0].status,
    ).toBe('paused');
  });
  it('prioritizes the last low-cardinality leaf and proves sparse gaps before hourly paths', async () => {
    await log('2026-01-01T00:01:00Z');
    const id = randomUUID();
    await execute(
      `INSERT INTO liekan_analysis_build(id,website_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total)
      VALUES($1::uuid,$2::uuid,1,'log',300,$3,$4,'UTC','en-US',$1::uuid,'sparse-hour-leaf','queued',1)`,
      id,
      site,
      from,
      new Date(+from + 300000),
    );
    await finish({ id } as AnalysisBuildDto);
    await log('2026-01-01T00:56:00Z');
    await api.reconcileAnalysisRollups();
    const first = await q<{ id: string; unit_seconds: number }[]>(
      "SELECT id,unit_seconds FROM liekan_analysis_build WHERE website_id=$1::uuid AND status='queued'",
      site,
    );
    expect(first.length).toBeGreaterThan(0);
    expect(first.every(j => j.unit_seconds === 300)).toBe(true);
    for (let round = 0; round < 10; round++) {
      const jobs = await q<{ id: string }[]>(
        "SELECT id FROM liekan_analysis_build WHERE website_id=$1::uuid AND status IN('queued','running')",
        site,
      );
      for (const job of jobs) await finish({ id: job.id } as AnalysisBuildDto);
      await api.reconcileAnalysisRollups();
    }
    const value = await api.readAnalysisLogRollup({
      ...input(),
      endDate: new Date(+from + 3600000),
      allowRawOnly: false,
    });
    expect(value?.summary.requests).toBe(2);
    expect(value?.coverage.rawFallback).toBe(false);
  });
  it.each(['finite', 'stale', 'hours'] as const)(
    'discovers %s work across sites when one site has many newer buckets',
    async kind => {
      const second = randomUUID(),
        secondImport = randomUUID();
      await execute(
        "INSERT INTO website(website_id,name,user_id) VALUES($1::uuid,'Synthetic discovery fairness',$2::uuid)",
        second,
        actor.userId,
      );
      await execute(
        'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$1,1,0)',
        secondImport,
        second,
      );
      const start = new Date(Math.floor((Date.now() - 12 * 3600000) / 3600000) * 3600000),
        older = new Date(+start - 12 * 3600000);
      try {
        for (let n = 0; n < 10; n++)
          await log(
            new Date(+start + n * (kind === 'finite' ? 300000 : 3600000) + 60000).toISOString(),
          );
        await execute(
          `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification)
        VALUES($1,$2::uuid,$3::uuid,$4,'/discovery','GET',200,0,'','','Synthetic','','其他','','其他','unverified')`,
          randomUUID(),
          second,
          secondImport,
          new Date(+older + 60000),
        );
        if (kind === 'stale') {
          await finish(await build(start, new Date(+start + 10 * 3600000)));
          await finish(
            await api.createAnalysisBuild(second, actor, {
              startDate: older,
              endDate: new Date(+older + 3600000),
              timezone: 'UTC',
              locale: 'en-US',
              requestId: randomUUID(),
            }),
          );
          await execute(
            'DELETE FROM liekan_analysis_dirty WHERE website_id=ANY($1::uuid[]) AND isfinite(bucket)',
            [site, second],
          );
          await execute(
            'UPDATE liekan_analysis_manifest SET fingerprint=liekan_analysis_fingerprint(website_id,epoch,family,bucket,bucket_end) WHERE website_id=ANY($1::uuid[])',
            [site, second],
          );
          await execute(
            "INSERT INTO liekan_collection_policy(website_id,mode) SELECT unnest($1::uuid[]),'raw'",
            [site, second],
          );
        } else if (kind === 'hours') {
          for (const [website, at] of [
            ...Array.from(
              { length: 10 },
              (_, n) => [site, new Date(+start + n * 3600000)] as const,
            ),
            [second, older] as const,
          ]) {
            const id = randomUUID();
            await execute(
              `INSERT INTO liekan_analysis_build(id,website_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total)
           VALUES($1::uuid,$2::uuid,1,'log',300,$3,$4,'UTC','en-US',$1::uuid,'discovery-hour-leaf','queued',1)`,
              id,
              website,
              at,
              new Date(+at + 300000),
            );
            await finish({ id } as AnalysisBuildDto);
          }
        }
        await api.reconcileAnalysisRollups();
        const jobs = await q<{ website_id: string }[]>(
          "SELECT DISTINCT website_id FROM liekan_analysis_build WHERE website_id=ANY($1::uuid[]) AND actor_id IS NULL AND status='queued'",
          [site, second],
        );
        expect(jobs.map(row => row.website_id)).toContain(site);
        expect(jobs.map(row => row.website_id)).toContain(second);
      } finally {
        for (const website of [site, second])
          await api.actionAnalysisBuild(website, actor, {
            action: 'disable',
            requestId: randomUUID(),
          });
      }
    },
  );
  it('rotates discovery past failed and capacity-limited sites across independent reconciliations', async () => {
    const websites: string[] = [],
      start = new Date(Math.floor((Date.now() - 12 * 3600000) / 3600000) * 3600000);
    const seed = async (website: string, at: Date, count: number) => {
      const imported = randomUUID();
      await execute(
        "INSERT INTO website(website_id,name,user_id) VALUES($1::uuid,'Synthetic terminal discovery',$2::uuid)",
        website,
        actor.userId,
      );
      await execute(
        'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$1,1,0)',
        imported,
        website,
      );
      await execute(
        `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification)
       SELECT gen_random_uuid()::text,$1::uuid,$2::uuid,$3::timestamptz+n*interval '5 minutes'+interval '1 minute','/terminal','GET',200,0,'','','Synthetic','','其他','','其他','unverified' FROM generate_series(0,$4::int-1)n`,
        website,
        imported,
        at,
        count,
      );
    };
    const terminal = async () => {
      for (const [n, website] of websites.entries())
        await execute(
          "UPDATE liekan_analysis_build SET status=$2 WHERE website_id=$1::uuid AND actor_id IS NULL AND status IN('queued','running')",
          website,
          n % 2 ? 'capacity_limited' : 'failed',
        );
    };
    const second = randomUUID();
    try {
      for (let n = 0; n < 8; n++) {
        const website = randomUUID();
        websites.push(website);
        await seed(website, new Date(+start + n * 3600000), 10);
        await api.reconcileAnalysisRollups();
        await terminal();
      }
      expect(
        (
          await q<{ n: bigint }[]>(
            "SELECT count(DISTINCT website_id) AS n FROM liekan_analysis_build WHERE website_id=ANY($1::uuid[]) AND status IN('failed','capacity_limited')",
            websites,
          )
        )[0].n,
      ).toBe(8n);
      await seed(second, new Date(+start - 12 * 3600000), 1);
      await execute(
        'UPDATE liekan_analysis_site SET incremental_served_at=clock_timestamp() WHERE website_id=$1::uuid',
        second,
      );
      for (let n = 0; n < 3; n++) {
        await api.reconcileAnalysisRollups();
        await terminal();
      }
      expect(
        (
          await q<{ n: bigint }[]>(
            'SELECT count(*) AS n FROM liekan_analysis_build WHERE website_id=$1::uuid AND actor_id IS NULL',
            second,
          )
        )[0].n,
      ).toBeGreaterThan(0n);
    } finally {
      for (const website of [...websites, second])
        await api.actionAnalysisBuild(website, actor, {
          action: 'disable',
          requestId: randomUUID(),
        });
    }
  });
  it.each(['finite', 'stale', 'hours'] as const)(
    'finds %s head work while advancing past over 32 pages of covered history',
    async kind => {
      const count = 1056,
        oldStart = new Date(Math.floor((Date.now() - 10 * 86400000) / 3600000) * 3600000),
        oldEnd = new Date(+oldStart + count * 300000);
      let planSaved = false;
      let restore: (() => void) | undefined;
      try {
        await execute(
          `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification)
       SELECT gen_random_uuid()::text,$1::uuid,$2::uuid,$3::timestamptz+n*interval '5 minutes'+interval '1 second','/covered-history','GET',200,0,'','','Synthetic','','其他','','其他','unverified' FROM generate_series(0,$4::int-1)n`,
          site,
          imported,
          oldStart,
          count,
        );
        await execute('DELETE FROM liekan_log WHERE website_id=$1::uuid', site);
        const id = randomUUID();
        await execute(
          `INSERT INTO liekan_analysis_build(id,website_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total,actor_id)
       VALUES($1::uuid,$2::uuid,1,'log',300,$3,$4,'UTC','en-US',$1::uuid,'covered-discovery-history','queued',$5::bigint,$6::uuid)`,
          id,
          site,
          oldStart,
          oldEnd,
          count,
          actor.userId,
        );
        await finish({ id } as AnalysisBuildDto);
        await execute(
          `WITH original AS(DELETE FROM liekan_analysis_manifest WHERE website_id=$1::uuid AND family='log' RETURNING *)
       INSERT INTO liekan_analysis_manifest(website_id,epoch,family,bucket,bucket_end,generation,previous_generation,build_id,fingerprint,versions,row_count,path_complete)
       SELECT m.website_id,m.epoch,m.family,$2::timestamptz+n*interval '5 minutes',$2::timestamptz+(n+1)*interval '5 minutes',m.generation,m.previous_generation,m.build_id,
        liekan_analysis_fingerprint(m.website_id,m.epoch,m.family,$2::timestamptz+n*interval '5 minutes',$2::timestamptz+(n+1)*interval '5 minutes'),m.versions,0,false FROM original m CROSS JOIN generate_series(0,$3::int-1)n`,
          site,
          oldStart,
          count,
        );
        const previous = new Date(+oldEnd - 300000),
          closed = new Date(Math.floor((Date.now() - 600000) / 300000) * 300000);
        await execute(
          'UPDATE liekan_analysis_site SET discovery_cursors=jsonb_build_object($3::text,$2::text) WHERE website_id=$1::uuid',
          site,
          previous.toISOString(),
          kind === 'finite' ? 'finite-log' : kind === 'stale' ? 'stale-log' : 'hour-log',
        );
        const target =
          kind === 'finite'
            ? closed
            : new Date(Math.floor((Date.now() - 2 * 3600000) / 3600000) * 3600000);
        await log(new Date(+target + 1000).toISOString());
        if (kind !== 'finite') {
          const id = randomUUID();
          await execute(
            `INSERT INTO liekan_analysis_build(id,website_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total,actor_id)
         VALUES($1::uuid,$2::uuid,1,'log',$3,$4,$5,'UTC','en-US',$1::uuid,'head-manifest','queued',$6::bigint,$7::uuid)`,
            id,
            site,
            kind === 'hours' ? 300 : 3600,
            target,
            new Date(+target + 3600000),
            kind === 'hours' ? 12 : 1,
            actor.userId,
          );
          await finish({ id } as AnalysisBuildDto);
          if (kind === 'stale') {
            // A retained manifest from an older engine is stale even when raw collection has no remaining finite markers.
            await execute(
              'DELETE FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND bucket>=$2 AND bucket<$3',
              site,
              target,
              new Date(+target + 3600000),
            );
            await execute(
              "UPDATE liekan_analysis_manifest SET fingerprint=liekan_analysis_fingerprint(website_id,epoch,family,bucket,bucket_end),versions=jsonb_set(versions,'{engine}','\"older-engine\"') WHERE website_id=$1::uuid AND bucket=$2",
              site,
              target,
            );
          }
        }
        const original = db.analysisTransaction;
        const spy = vi.spyOn(db, 'analysisTransaction').mockImplementation(((
          work: any,
          level: any,
        ) =>
          original(
            async tx =>
              work({
                $executeRawUnsafe: (sql: string, ...values: unknown[]) =>
                  tx.$executeRawUnsafe(sql, ...values),
                $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
                  if (!planSaved && sql.includes('s.discovery_checked_at NULLS FIRST')) {
                    planSaved = true;
                    const plan = await tx.$queryRawUnsafe(
                      `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,
                      ...values,
                    );
                    await writeFile(
                      `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/discovery-head-${kind}-plan.json`,
                      JSON.stringify(plan),
                      { mode: 0o600 },
                    );
                  }
                  return tx.$queryRawUnsafe(sql, ...values);
                },
              }),
            level,
          )) as any);
        restore = () => spy.mockRestore();
        await api.reconcileAnalysisRollups();
        expect(
          (
            await q<{ n: bigint }[]>(
              "SELECT count(*) AS n FROM liekan_analysis_build WHERE website_id=$1::uuid AND actor_id IS NULL AND status='queued' AND range_start=$2 AND unit_seconds=$3",
              site,
              target,
              kind === 'hours' ? 3600 : 300,
            )
          )[0].n,
        ).toBeGreaterThan(0n);
        const [state] = await q<{ discovery_cursors: Record<string, string> }[]>(
          'SELECT discovery_cursors FROM liekan_analysis_site WHERE website_id=$1::uuid',
          site,
        );
        expect(
          +new Date(
            state.discovery_cursors[
              kind === 'finite' ? 'finite-log' : kind === 'stale' ? 'stale-log' : 'hour-log'
            ],
          ),
        ).toBeLessThan(+previous);
      } finally {
        restore?.();
        await api.actionAnalysisBuild(site, actor, { action: 'disable', requestId: randomUUID() });
      }
    },
    30000,
  );
  it('advances backlog after a terminal head conflict and serves log and visit families together', async () => {
    for (let n = 0; n < 10; n++) await log(new Date(+from + n * 300000 + 1000).toISOString());
    await event(from.toISOString());
    for (let n = 0; n < 3; n++) await api.reconcileAnalysisRollups();
    const families = await q<{ family: string }[]>(
      'SELECT DISTINCT family FROM liekan_analysis_build WHERE website_id=$1::uuid AND actor_id IS NULL',
      site,
    );
    expect(families.map(row => row.family)).toEqual(expect.arrayContaining(['log', 'visit']));
    await execute(
      "UPDATE liekan_analysis_build SET status='failed' WHERE website_id=$1::uuid AND actor_id IS NULL AND status IN('queued','running')",
      site,
    );
    const [before] = await q<{ n: bigint; oldest: Date }[]>(
      "SELECT count(*) AS n,min(range_start) AS oldest FROM liekan_analysis_build WHERE website_id=$1::uuid AND actor_id IS NULL AND family='log'",
      site,
    );
    await execute(
      "UPDATE liekan_analysis_site SET discovery_cursors=jsonb_build_object('finite-log',$2::text) WHERE website_id=$1::uuid",
      site,
      before.oldest.toISOString(),
    );
    await api.reconcileAnalysisRollups();
    const [after] = await q<{ n: bigint }[]>(
      "SELECT count(*) AS n FROM liekan_analysis_build WHERE website_id=$1::uuid AND actor_id IS NULL AND family='log'",
      site,
    );
    expect(after.n).toBeGreaterThan(before.n);
    const [state] = await q<{ discovery_cursors: Record<string, string> }[]>(
      'SELECT discovery_cursors FROM liekan_analysis_site WHERE website_id=$1::uuid',
      site,
    );
    expect(+new Date(state.discovery_cursors['finite-log'])).toBeLessThan(+before.oldest);
    await api.actionAnalysisBuild(site, actor, { action: 'disable', requestId: randomUUID() });
  });
  it('pins discovery compatibly with capture, preserves the GC clock and resets finite cursors at epoch changes', async () => {
    const [before] = await q<{ updated_at: Date }[]>(
      'SELECT updated_at FROM liekan_analysis_site WHERE website_id=$1::uuid',
      site,
    );
    let release!: () => void, locked!: () => void;
    const wait = new Promise<void>(r => (release = r)),
      ready = new Promise<void>(r => (locked = r));
    const lock = db.analysisTransaction(async tx => {
      await tx.$queryRawUnsafe(
        'SELECT website_id FROM liekan_analysis_site WHERE website_id=$1::uuid FOR NO KEY UPDATE',
        site,
      );
      locked();
      await wait;
    });
    await ready;
    try {
      await event(from.toISOString());
    } finally {
      release();
      await lock;
    }
    await api.reconcileAnalysisRollups();
    const [state] = await q<
      { updated_at: Date; discovery_checked_at: Date; discovery_cursors: Record<string, string> }[]
    >(
      'SELECT updated_at,discovery_checked_at,discovery_cursors FROM liekan_analysis_site WHERE website_id=$1::uuid',
      site,
    );
    expect(state.updated_at).toEqual(before.updated_at);
    expect(state.discovery_checked_at).toBeInstanceOf(Date);
    expect(
      Object.values(state.discovery_cursors).every(value => Number.isFinite(+new Date(value))),
    ).toBe(true);
    await expect(
      nativeExecute(
        'UPDATE liekan_analysis_site SET discovery_cursors=\'{"unknown":"2026-01-01T00:00:00.000Z"}\' WHERE website_id=$1::uuid',
        site,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      nativeExecute(
        'UPDATE liekan_analysis_site SET discovery_cursors=\'{"finite-log":"-infinity"}\' WHERE website_id=$1::uuid',
        site,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await api.actionAnalysisBuild(site, actor, { action: 'disable', requestId: randomUUID() });
    expect(
      (
        await q(
          'SELECT discovery_checked_at,discovery_cursors FROM liekan_analysis_site WHERE website_id=$1::uuid',
          site,
        )
      )[0],
    ).toEqual({ discovery_checked_at: null, discovery_cursors: {} });
  });
  it('does not spend discovery slots on empty websites or fully current empty coverage', async () => {
    const empty = Array.from({ length: 30 }, () => randomUUID());
    await execute(
      "INSERT INTO website(website_id,name,user_id) SELECT unnest($1::uuid[]),'Synthetic empty discovery',$2::uuid",
      empty,
      actor.userId,
    );
    await finish(await build());
    await api.reconcileAnalysisRollups();
    expect(
      (
        await q<{ n: bigint }[]>(
          'SELECT count(*) AS n FROM liekan_analysis_site WHERE website_id=ANY($1::uuid[]) AND discovery_checked_at IS NOT NULL',
          [...empty, site],
        )
      )[0].n,
    ).toBe(0n);
    await execute('DELETE FROM website WHERE website_id=ANY($1::uuid[])', empty);
  });
  it('serves another site before draining one site with many older queued jobs', async () => {
    const second = randomUUID();
    await execute(
      "INSERT INTO website(website_id,name,user_id) VALUES($1::uuid,'Synthetic fair queue',$2::uuid)",
      second,
      actor.userId,
    );
    const ids = Array.from({ length: 40 }, () => randomUUID()),
      secondJob = randomUUID();
    for (const [index, id] of ids.entries())
      await execute(
        `INSERT INTO liekan_analysis_build(id,website_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total,updated_at)
      VALUES($1::uuid,$2::uuid,1,'log',300,$3,$4,'UTC','en-US',$1::uuid,'fair-queue','queued',1,timestamptz '1970-01-01Z'+$5::int*interval '1 second')`,
        id,
        site,
        new Date(+from + index * 300000),
        new Date(+from + (index + 1) * 300000),
        index,
      );
    await execute(
      `INSERT INTO liekan_analysis_build(id,website_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total,updated_at)
      VALUES($1::uuid,$2::uuid,1,'log',300,$3,$4,'UTC','en-US',$1::uuid,'fair-queue','queued',1,timestamptz '1970-01-02Z')`,
      secondJob,
      second,
      from,
      new Date(+from + 300000),
    );
    const { processAnalysisBuild } = await import('./analysis-build-queue');
    let checks = 0;
    await processAnalysisBuild(ids[0], 'incremental', { shouldStop: () => ++checks > 9 });
    expect(
      (
        await q<{ status: string }[]>(
          'SELECT status FROM liekan_analysis_build WHERE id=$1::uuid',
          secondJob,
        )
      )[0].status,
    ).toBe('completed');
    expect(
      (
        await q<{ n: bigint }[]>(
          "SELECT count(*) AS n FROM liekan_analysis_build WHERE website_id=$1::uuid AND status='queued'",
          site,
        )
      )[0].n,
    ).toBeGreaterThan(30n);
  });
  it('prioritizes current closed log and visit units within a site while old recovery remains queued', async () => {
    const { pumpAnalysisBuilds } = await import('./analysis-build-queue');
    const now = Date.now(),
      closedLog = Math.floor((now - 60000) / 300000) * 300000,
      closedVisit = Math.floor((now - 60000) / 3600000) * 3600000;
    const old = randomUUID(),
      recentLog = randomUUID(),
      recentVisit = randomUUID();
    for (const [id, family, unit, start, order] of [
      [old, 'log', 300, +from, 0],
      [recentLog, 'log', 300, closedLog - 300000, 1],
      [recentVisit, 'visit', 3600, closedVisit - 3600000, 2],
    ] as const)
      await execute(
        `INSERT INTO liekan_analysis_build(id,website_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total,updated_at)
      VALUES($1::uuid,$2::uuid,1,$3,$4,$5,$6,'UTC','en-US',$1::uuid,'current-unit-priority','queued',1,timestamptz '1960-01-01Z'+$7::int*interval '1 second')`,
        id,
        site,
        family,
        unit,
        new Date(start),
        new Date(start + unit * 1000),
        order,
      );
    const selected = async () => {
      const ids: string[] = [];
      await pumpAnalysisBuilds({
        send: async (_queue: string, data: { id: string }) => {
          ids.push(data.id);
          return randomUUID();
        },
      } as any);
      const owned = new Set<string>([old, recentLog, recentVisit]);
      return ids.filter(id => owned.has(id));
    };
    // Both recent families belong to the same incremental lane. The newer completed boundary wins.
    const first = (await selected())[0];
    expect([recentLog, recentVisit]).toContain(first);
    await api.runOneAnalysisWorkUnit(first);
    const second = (await selected())[0];
    expect(second).toBe(first === recentLog ? recentVisit : recentLog);
    await api.runOneAnalysisWorkUnit(second);
    expect((await selected())[0]).toBe(old);
    const [state] = await q<{ status: string }[]>(
      'SELECT status FROM liekan_analysis_build WHERE id=$1::uuid',
      old,
    );
    expect(state.status).toBe('queued');
    await api.actionAnalysisBuild(site, actor, { action: 'disable', requestId: randomUUID() });
  });
  it('dispatches both kinds when eight incremental sites have continuously pending work', async () => {
    await build(from, new Date(+from + 3600000));
    for (let n = 0; n < 8; n++) {
      const website = randomUUID(),
        id = randomUUID();
      await execute(
        "INSERT INTO website(website_id,name,user_id) VALUES($1::uuid,'Synthetic kind dispatch',$2::uuid)",
        website,
        actor.userId,
      );
      await execute(
        `INSERT INTO liekan_analysis_build(id,website_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total)
       VALUES($1::uuid,$2::uuid,1,'log',300,$3,$4,'UTC','en-US',$1::uuid,'kind-queue','queued',1)`,
        id,
        website,
        from,
        new Date(+from + 300000),
      );
    }
    const { pumpAnalysisBuilds } = await import('./analysis-build-queue');
    const messages: { id: string; kind: string }[] = [];
    await pumpAnalysisBuilds({
      send: async (_name: unknown, data?: any) => {
        messages.push(data);
        return randomUUID();
      },
    });
    expect(messages).toHaveLength(8);
    expect(messages.some(m => m.kind === 'incremental')).toBe(true);
    expect(messages.some(m => m.kind === 'history')).toBe(true);
  });
  it('keeps interactive admission available while history is paused by an active repair', async () => {
    // Isolate the history wait condition from deliberately aged incremental fairness fixtures.
    const suspended = await q<{ id: string; status: string }[]>(
      "SELECT id,status FROM liekan_analysis_build WHERE actor_id IS NULL AND status IN('queued','running')",
    );
    let task: AnalysisBuildDto;
    try {
      await execute(
        "UPDATE liekan_analysis_build SET status='paused' WHERE actor_id IS NULL AND status IN('queued','running')",
      );
      task = await build(from, new Date(+from + 3600000));
      await execute(
        `INSERT INTO liekan_history_repair_run(id,website_id,campaign_id,actor_id,status,generation,repair_scope_id,snapshot,locale)
      VALUES($1::uuid,$2::uuid,'traffic-quality-repair-20261022-v1',$3::uuid,'running',$4::uuid,$5::uuid,$6::jsonb,'en-US')`,
        randomUUID(),
        site,
        actor.userId,
        randomUUID(),
        randomUUID(),
        JSON.stringify({ rulepack: { engine: HISTORY_REPAIR_ENGINE } }),
      );
      await execute(
        'UPDATE liekan_analysis_background_lease SET token=NULL,lease_until=NULL,interactive_turns=5 WHERE id',
      );
      const { pumpAnalysisBuilds } = await import('./analysis-build-queue');
      const messages: { id: string; kind: string }[] = [];
      await pumpAnalysisBuilds({
        send: async (_name: unknown, data?: any) => {
          messages.push(data);
          return randomUUID();
        },
      });
      expect(messages.some(m => m.kind === 'history')).toBe(false);
      const { withAnalysisPermit } = await import('./analysis-background');
      const permit = await withAnalysisPermit('interactive', async () => true);
      expect(permit.acquired).toBe(true);
    } finally {
      await execute(
        "UPDATE liekan_history_repair_run SET status='cancelled' WHERE website_id=$1::uuid",
        site,
      );
      if (task)
        await execute(
          "UPDATE liekan_analysis_build SET status='paused' WHERE id=$1::uuid",
          task.id,
        );
      for (const status of ['queued', 'running']) {
        const ids = suspended.filter(row => row.status === status).map(row => row.id);
        if (ids.length)
          await execute(
            'UPDATE liekan_analysis_build SET status=$1 WHERE id=ANY($2::uuid[])',
            status,
            ids,
          );
      }
      await execute(
        'UPDATE liekan_analysis_background_lease SET incremental_waiting_at=NULL,history_waiting_at=NULL,interactive_turns=0 WHERE id',
      );
    }
  });
  it('deletes a session through the actual standalone Prisma transaction in the owned schema', async () => {
    await event(from.toISOString());
    await prisma.client.$disconnect();
    expect(await prisma.client.$queryRawUnsafe('SHOW search_path')).toEqual([
      { search_path: '"$user", public' },
    ]);
    const { deleteSession } = await import('@/queries/prisma/session');
    expect(await deleteSession(site, session)).toEqual({ id: session });
    expect(
      (
        await q<{ n: bigint }[]>(
          'SELECT count(*) AS n FROM website_event WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(0n);
  });
  it('registers a website created by the actual Prisma adapter without an outer schema transaction', async () => {
    await prisma.client.$disconnect();
    expect(await prisma.client.$queryRawUnsafe('SHOW search_path')).toEqual([
      { search_path: '"$user", public' },
    ]);
    const settings = await q<
      { proname: string; proconfig: string[] | null }[]
    >(`SELECT p.proname,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=current_schema() AND p.proname IN('liekan_analysis_fingerprint','liekan_analysis_versions') ORDER BY p.proname`);
    expect(settings).toEqual([
      { proname: 'liekan_analysis_fingerprint', proconfig: null },
      { proname: 'liekan_analysis_versions', proconfig: null },
    ]);
    const id = randomUUID();
    await prisma.client.website.create({
      data: { id, name: 'Synthetic ORM capture fixture', userId: actor.userId },
    });
    expect(
      (
        await q<{ mode: string }[]>(
          'SELECT mode FROM liekan_analysis_site WHERE website_id=$1::uuid',
          id,
        )
      )[0]?.mode,
    ).toBe('live');
  });
});
