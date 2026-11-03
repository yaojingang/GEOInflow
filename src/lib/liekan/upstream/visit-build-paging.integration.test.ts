// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as database from './analysis-rollups-db';
import { analysisVisitRowsSql } from './analysis-rollups-db';
import { createAnalysisBuild, runOneAnalysisWorkUnit } from './analysis-rollups';
import { readBrowserDetailFacts } from './browser-detail-facts';
import { withPublishedRegistry } from './crawler-registry-context';

const enabled = process.env.LIEKAN_ANALYSIS_ROLLUPS_TEST === '1';
const actor = randomUUID(),
  sites: string[] = [];
const from = new Date('2026-01-01T00:00:00Z'),
  until = new Date('2026-01-01T01:00:00Z');
const q = (sql: string, ...values: unknown[]) =>
  database.analysisTransaction(tx => tx.$queryRawUnsafe<any[]>(sql, ...values));
const execute = (sql: string, ...values: unknown[]) =>
  database.analysisTransaction(tx => tx.$executeRawUnsafe(sql, ...values));
const unit = (id: string) => withPublishedRegistry(() => runOneAnalysisWorkUnit(id));
async function build(site: string, startDate = from, endDate = until) {
  return createAnalysisBuild(
    site,
    { userId: actor },
    {
      startDate,
      endDate,
      timezone: 'UTC',
      locale: 'en-US',
      requestId: randomUUID(),
    },
  );
}
async function finish(id: string) {
  for (let i = 0; i < 20; i++) {
    const [row] = await q(
      'SELECT status,error_code FROM liekan_analysis_build WHERE id=$1::uuid',
      id,
    );
    if (row.status === 'completed') return;
    expect(row.error_code).toBeNull();
    await unit(id);
  }
  throw new Error('Synthetic visit paging build did not finish');
}
const ordered = (facts: any) =>
  Object.fromEntries(
    Object.entries(facts).map(([key, rows]) => [
      key,
      [...(rows as any[])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ]),
  );

describe.skipIf(!enabled)('physical visit build pages in owned PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || 'http://invalid');
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '15462' ||
      url.pathname !== '/liekan_analysis_rollups_test' ||
      !/^analysis_[a-f0-9]+$/.test(url.searchParams.get('schema') || '')
    )
      throw new Error('Owned analysis fixture required');
    await execute(
      `INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$1,'synthetic','user')`,
      actor,
    );
  });
  afterAll(async () => {
    if (!enabled) return;
    await execute('DELETE FROM website WHERE website_id=ANY($1::uuid[])', sites);
    await execute('DELETE FROM "user" WHERE user_id=$1::uuid', actor);
  });
  it.each([false, true])(
    'advances a full physical page with qualified boundary=%s and matches the complete oracle',
    async boundary => {
      const site = randomUUID(),
        parent = randomUUID(),
        missingParent = randomUUID(),
        futureVisit = randomUUID();
      sites.push(site);
      await execute(
        `INSERT INTO website(website_id,user_id,name,domain) VALUES($1::uuid,$2::uuid,'Synthetic physical paging','paging.invalid')`,
        site,
        actor,
      );
      await execute(
        `INSERT INTO session(session_id,website_id,created_at,browser,country) VALUES($1::uuid,$2::uuid,$3,'Chrome','US')`,
        parent,
        site,
        from,
      );
      await execute(
        `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,event_type,url_path,hostname)
      SELECT gen_random_uuid(),$1::uuid,$2::uuid,$2::uuid,$3::timestamptz+n*interval '1 millisecond',1,'/synthetic/excluded','paging.invalid'
      FROM generate_series(1,$4::int)n`,
        site,
        parent,
        from,
        boundary ? 1999 : 2000,
      );
      await execute(
        `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status,hostname)
      SELECT event_id,website_id,'automated','browser','{}','synthetic-paging','missing','paging.invalid'
      FROM website_event WHERE website_id=$1::uuid`,
        site,
      );
      async function event(
        ms: number,
        type = 1,
        visit = parent,
        available = true,
        session = parent,
      ) {
        const id = randomUUID();
        await execute(
          `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,event_type,url_path,hostname)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,'/synthetic/qualified','paging.invalid')`,
          id,
          site,
          session,
          visit,
          new Date(+from + ms),
          type,
        );
        await execute(
          `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status,hostname)
        VALUES($1::uuid,$2::uuid,'browser','browser','{}','synthetic-paging','missing','paging.invalid')`,
          id,
          site,
        );
        await execute(
          `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser,os,device)
        VALUES($1::uuid,$2::uuid,'browser','synthetic-paging',$3,'Firefox','synthetic','desktop')`,
          id,
          site,
          available,
        );
        await execute(
          `INSERT INTO liekan_event_geography(event_id,website_id,country,source,trust,ip_family,precision,reason,rule_version,country_basis,processed_at)
        VALUES($1::uuid,$2::uuid,$3,'synthetic','synthetic','missing','country','synthetic','synthetic','synthetic',clock_timestamp())`,
          id,
          site,
          ms > 3600000 ? 'GB' : 'CN',
        );
        return id;
      }
      if (boundary) await event(2000, 2);
      await event(3000);
      await event(4000, 2);
      await event(5000, 1, randomUUID(), false);
      await event(6000, 1, randomUUID(), true, missingParent);
      await event(7000, 5, futureVisit);
      await event(3600001, 1, futureVisit);
      // A separate tuple on the same parent must not provide the future visit's geography.
      await event(-1000, 1, randomUUID());
      const condition =
        'e.website_id=$1::uuid AND e.created_at>=$3::timestamptz AND e.created_at<$4::timestamptz';
      const oracle = await q(
        `WITH observed AS (${analysisVisitRowsSql(condition)})
      SELECT session_id,visit_id,hostname,dimensions,count(*)::bigint AS eligible_events,
      count(*) FILTER(WHERE event_type NOT IN(2,5))::bigint AS pageviews,bool_or(event_type=2) AS has_custom,
      min(created_at) FILTER(WHERE event_type NOT IN(2,5)) AS min_time,max(created_at) FILTER(WHERE event_type NOT IN(2,5)) AS max_time
      FROM observed CROSS JOIN(SELECT $2::uuid) unused GROUP BY session_id,visit_id,hostname,dimensions ORDER BY session_id,visit_id,hostname,dimensions::text`,
        site,
        null,
        from,
        until,
      );
      expect(oracle.some(row => row.dimensions.identityAvailable === false)).toBe(true);
      expect(
        oracle.some(
          row =>
            row.visit_id === futureVisit && row.dimensions.country === 'GB' && row.pageviews === 0n,
        ),
      ).toBe(true);
      const fields = ['daily', 'geo', 'sources', 'pages'];
      const task = await build(site);
      await execute(
        `UPDATE liekan_analysis_build SET family='visit',work_total=1,checkpoint=$2::jsonb WHERE id=$1::uuid`,
        task.id,
        JSON.stringify({ hour: from.toISOString(), family: 'visit' }),
      );
      const beforeJit = await q('SHOW jit');
      const compilation: string[] = [];
      const original = database.analysisTransaction;
      const spy = vi.spyOn(database, 'analysisTransaction').mockImplementation(((
        work: any,
        isolation: any,
      ) =>
        original(
          async tx =>
            work({
              $executeRawUnsafe: (statement: string, ...values: unknown[]) =>
                tx.$executeRawUnsafe(statement, ...values),
              $queryRawUnsafe: async (statement: string, ...values: unknown[]) => {
                if (
                  statement.includes('INSERT INTO liekan_analysis_visit') ||
                  statement.includes('INSERT INTO liekan_analysis_browser_visit')
                ) {
                  const [setting] = await tx.$queryRawUnsafe<{ jit: string }[]>('SHOW jit');
                  compilation.push(setting.jit);
                }
                return tx.$queryRawUnsafe(statement, ...values);
              },
            }),
          isolation,
        )) as any);
      try {
        await unit(task.id);
      } finally {
        spy.mockRestore();
      }
      expect(compilation).toEqual(['off', 'off']);
      expect(await q('SHOW jit')).toEqual(beforeJit);
      const [first] = await q(
        'SELECT status,checkpoint FROM liekan_analysis_build WHERE id=$1::uuid',
        task.id,
      );
      expect(first.status).toBe('running');
      expect(first.checkpoint.afterId).not.toBe('__publish__');
      expect(+new Date(first.checkpoint.afterTime)).toBe(+from + 2000);
      expect(first.checkpoint.rows).toBe(boundary ? '1' : '0');
      expect(
        (
          await q(
            'SELECT complete FROM liekan_analysis_browser_detail WHERE website_id=$1::uuid AND generation=$2::uuid',
            site,
            first.checkpoint.generation,
          )
        )[0].complete,
      ).toBe(false);
      await finish(task.id);
      const facts = await q(
        `SELECT session_id,visit_id,hostname,dimensions,eligible_events,pageviews,has_custom,min_time,max_time
      FROM liekan_analysis_visit v JOIN liekan_analysis_manifest m USING(website_id,generation)
      WHERE v.website_id=$1::uuid AND m.family='visit' AND m.bucket=$2 ORDER BY session_id,visit_id,hostname,dimensions::text`,
        site,
        from,
      );
      expect(facts).toEqual(oracle);
      const [manifest] = await q(
        `SELECT row_count FROM liekan_analysis_manifest WHERE website_id=$1::uuid AND family='visit' AND bucket=$2`,
        site,
        from,
      );
      expect(manifest.row_count).toBe(oracle.reduce((sum, row) => sum + row.eligible_events, 0n));
      const coveredDetail = await readBrowserDetailFacts(site, from, until, 'UTC', fields, {
        halfOpen: true,
      });
      const [published] = await q(
        `SELECT versions FROM liekan_analysis_manifest WHERE website_id=$1::uuid AND family='visit' AND bucket=$2`,
        site,
        from,
      );
      let rawDetail: any;
      try {
        await execute(
          `UPDATE liekan_analysis_manifest SET versions=jsonb_set(versions,'{engine}','"synthetic-uncovered-oracle"') WHERE website_id=$1::uuid`,
          site,
        );
        rawDetail = await readBrowserDetailFacts(site, from, until, 'UTC', fields, {
          halfOpen: true,
        });
      } finally {
        await execute(
          `UPDATE liekan_analysis_manifest SET versions=$2::jsonb WHERE website_id=$1::uuid`,
          site,
          JSON.stringify(published.versions),
        );
      }
      expect(coveredDetail).not.toBeNull();
      expect(rawDetail).not.toBeNull();
      expect(ordered(coveredDetail)).toEqual(ordered(rawDetail));
    },
  );
});
