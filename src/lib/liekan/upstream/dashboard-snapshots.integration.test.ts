// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { PgBoss } from 'pg-boss';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestDashboardSnapshot,
  pumpDashboardSnapshots,
  publishDashboardSnapshot,
  seedDashboardSnapshots,
  pumpDashboardDemand,
} from './dashboard-snapshots';
import {
  processAnalysisQuery,
  processAnalysisQueryDelivery,
  requestAnalysisQuery,
  readAnalysisQuery,
  pumpAnalysisQueries,
} from './analysis-queries';
import { bootstrapAnalysisHistory } from './analysis-rollups-worker';
import { analysisCapacity, analysisTransaction } from './analysis-rollups-db';
import * as rollupDatabase from './analysis-rollups-db';
import { withPublishedRegistry } from './crawler-registry-context';
import { withAnalysisPermit } from './analysis-background';
import { ANALYSIS_QUERY_QUEUE } from './analysis-query-model';
import { pageReportParts } from '../contracts/page-report';
import { AnalyticsUnavailable } from './analytics-budget';

const warmResources = [
  'overview',
  'human/overview',
  ...Object.keys(pageReportParts).filter(
    resource => !['overview', 'human/overview', 'logs', 'human/keywords'].includes(resource),
  ),
];

const withBlockedLane = (
  kind: Parameters<typeof withAnalysisPermit>[0],
  work: () => Promise<unknown>,
) =>
  withAnalysisPermit(kind, async () => {
    if (kind === 'dashboard') await withAnalysisPermit(kind, work);
    else await work();
  });
const enabled = process.env.LIEKAN_ANALYSIS_ROLLUPS_TEST === '1';
const actor = { id: randomUUID(), role: 'user' };
const sites: string[] = [];
let site: string, session: string;
const p = {
  startAt: +new Date('2026-01-01T00:00Z'),
  endAt: +new Date('2026-01-03T00:00Z'),
  timezone: 'UTC',
};
const q = <T = any[]>(sql: string, ...values: unknown[]) =>
  analysisTransaction(tx => tx.$queryRawUnsafe<T>(sql, ...values));
const sql = (text: string, ...values: unknown[]) =>
  analysisTransaction(tx => tx.$executeRawUnsafe(text, ...values));
const read = (extra: Record<string, unknown> = {}) =>
  withPublishedRegistry(() =>
    requestDashboardSnapshot(site, actor, 'native:stats', { ...p, ...extra }),
  );
async function event(
  at = '2026-01-01T01:00Z',
  environment = true,
  visit = session,
  distinctId: string = null,
  environmentFirst = false,
) {
  const id = randomUUID();
  await analysisTransaction(async tx => {
    await tx.$executeRawUnsafe(
      'SELECT website_id FROM website WHERE website_id=$1::uuid FOR UPDATE',
      site,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,event_type,url_path,hostname)
      VALUES($1::uuid,$2::uuid,$3::uuid,$5::uuid,$4,1,'/synthetic-snapshot','snapshot.invalid')`,
      id,
      site,
      session,
      new Date(at),
      visit,
    );
    const quality = () =>
      tx.$executeRawUnsafe(
        `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status,hostname)
      VALUES($1::uuid,$2::uuid,'browser','browser','{}','snapshot-fixture','missing','snapshot.invalid')`,
        id,
        site,
      );
    const evidence = () =>
      tx.$executeRawUnsafe(
        `INSERT INTO liekan_event_environment(event_id,website_id,scope,identity_version,identity_available,browser,distinct_id)
      VALUES($1::uuid,$2::uuid,'browser','snapshot-fixture',true,'Firefox',$3)`,
        id,
        site,
        distinctId,
      );
    if (environment && environmentFirst) await evidence();
    await quality();
    if (environment && !environmentFirst) await evidence();
  });
}
async function finish(id: string) {
  const execution = await processAnalysisQuery(id);
  if (!execution.acquired) throw new Error('snapshot fixture did not acquire the worker');
  if (execution.value) throw execution.value;
  const [row] = await q(
    'SELECT status,error_code FROM liekan_analysis_query WHERE id=$1::uuid',
    id,
  );
  expect(row).toEqual({ status: 'ready', error_code: null });
}
async function aiLogs(times: number[], path = '/synthetic-ai-snapshot') {
  const imported = randomUUID();
  await sql(
    'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$1,$3,0)',
    imported,
    site,
    times.length,
  );
  const ids: string[] = [];
  for (const at of times) {
    const id = randomUUID();
    await sql(
      `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
       VALUES($1,$2::uuid,$3::uuid,$4,$5,'GET',200,0,'','','GPTBot/fixture','','GPTBot','OpenAI','训练','unverified',true,'recognized')`,
      id,
      site,
      imported,
      new Date(at),
      path,
    );
    ids.push(id);
  }
  return ids;
}
function aiSnapshotNow() {
  let now = Math.ceil(Date.now() / 30000) * 30000 + 5000;
  if (Math.floor(now / 86400000) !== Math.floor((now + 31000) / 86400000)) now += 30000;
  return now;
}
async function expectAiProducerClock(jobId: string, through: number) {
  const [timing] = await q(
    `SELECT pending_through,last_read_at,clock_timestamp() AS database_now
     FROM liekan_dashboard_snapshot WHERE job_id=$1::uuid`,
    jobId,
  );
  expect(+new Date(timing.pending_through), JSON.stringify(timing)).toBe(through);
}
describe.skipIf(!enabled)('persistent dashboard publications in PostgreSQL', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '15462' ||
      url.pathname !== '/liekan_analysis_rollups_test'
    )
      throw new Error('Owned snapshot fixture database required');
    await sql(
      `INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$2,'synthetic','user')`,
      actor.id,
      `snapshot-${actor.id}`,
    );
  });
  beforeEach(async () => {
    await sql('DELETE FROM liekan_analysis_query WHERE actor_id=$1::uuid', actor.id);
    site = randomUUID();
    session = randomUUID();
    sites.push(site);
    await sql(
      `INSERT INTO website(website_id,user_id,name,domain) VALUES($1::uuid,$2::uuid,'Synthetic dashboard fixture','snapshot.invalid')`,
      site,
      actor.id,
    );
    await sql(
      `INSERT INTO session(session_id,website_id,created_at) VALUES($1::uuid,$2::uuid,'2026-01-01')`,
      session,
      site,
    );
    await sql(
      'UPDATE liekan_analysis_background_lease SET token=NULL,lease_until=NULL,incremental_waiting_at=NULL,history_waiting_at=NULL,interactive_turns=0 WHERE id',
    );
    await event();
  });
  afterAll(async () => {
    for (const id of sites) await sql('DELETE FROM website WHERE website_id=$1::uuid', id);
    await sql('DELETE FROM "user" WHERE user_id=$1::uuid', actor.id);
  });
  it('coalesces simultaneous cold dashboard producers across authorized actors', async () => {
    const readers = [
      actor,
      ...Array.from({ length: 4 }, () => ({ id: randomUUID(), role: 'admin' })),
    ];
    try {
      for (const reader of readers.slice(1))
        await sql(
          `INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$1,'synthetic','admin')`,
          reader.id,
        );
      const pending = await Promise.all(
        readers.map(reader =>
          withPublishedRegistry(() => requestDashboardSnapshot(site, reader, 'native:stats', p)),
        ),
      );
      expect(pending.every(result => !result.ready)).toBe(true);
      expect(
        new Set(pending.map(result => (result.ready ? null : result.analysisJob.id))).size,
      ).toBe(1);
      const [count] = await q(
        `SELECT count(*)::int AS n FROM liekan_analysis_query WHERE website_id=$1::uuid`,
        site,
      );
      expect(count.n).toBe(1);
      const [consumers] = await q(
        `SELECT count(*)::int AS n FROM liekan_analysis_query_consumer c JOIN liekan_analysis_query q ON q.id=c.job_id WHERE q.website_id=$1::uuid`,
        site,
      );
      expect(consumers.n).toBe(5);
    } finally {
      await sql('DELETE FROM liekan_analysis_query WHERE website_id=$1::uuid', site);
      for (const reader of readers.slice(1))
        await sql('DELETE FROM "user" WHERE user_id=$1::uuid', reader.id);
    }
  });
  it.each(['same', 'other'])(
    'reuses a cold producer that finishes between snapshot read and registration: %s actor',
    async kind => {
      const first = await read();
      if (first.ready) throw new Error('expected a cold task');
      const reader = kind === 'same' ? actor : { id: randomUUID(), role: 'admin' };
      if (kind === 'other')
        await sql(
          `INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$1,'synthetic','admin')`,
          reader.id,
        );
      const original = rollupDatabase.analysisTransaction;
      let completed = false;
      const spy = vi.spyOn(rollupDatabase, 'analysisTransaction').mockImplementation((async (
        work: any,
        level: any,
      ) => {
        let stale = false;
        const result = await original(
          tx =>
            work(
              new Proxy(tx, {
                get(target, key) {
                  if (key !== '$queryRawUnsafe') return Reflect.get(target, key);
                  return async (statement: string, ...values: unknown[]) => {
                    const rows = await target.$queryRawUnsafe(statement, ...values);
                    if (
                      !completed &&
                      statement.includes('UPDATE liekan_dashboard_snapshot SET actor_id=')
                    )
                      stale = true;
                    return rows;
                  };
                },
              }),
            ),
          level,
        );
        if (stale && !completed) {
          completed = true;
          await finish(first.analysisJob.id);
        }
        return result;
      }) as any);
      try {
        const second = await withPublishedRegistry(() =>
          requestDashboardSnapshot(site, reader, 'native:stats', p),
        );
        expect(completed).toBe(true);
        expect(second.ready).toBe(true);
        expect(
          (
            await q(
              'SELECT count(*)::int AS n FROM liekan_analysis_query WHERE website_id=$1::uuid',
              site,
            )
          )[0].n,
        ).toBe(1);
      } finally {
        spy.mockRestore();
        if (kind === 'other') await sql('DELETE FROM "user" WHERE user_id=$1::uuid', reader.id);
      }
    },
  );
  it('stops automatic replacement of exhausted work until its input changes or a reader retries', async () => {
    const pending = await read();
    if (pending.ready === true) throw new Error('expected cold dashboard');
    await sql(
      "UPDATE liekan_analysis_query SET status='failed',attempts=4,queued_at=clock_timestamp()-interval '10 seconds',error_code='analysis-query-timeout' WHERE id=$1::uuid",
      pending.analysisJob.id,
    );
    await sql(
      "UPDATE liekan_dashboard_snapshot SET next_refresh_at=clock_timestamp()-interval '1 second' WHERE website_id=$1::uuid",
      site,
    );
    await pumpDashboardSnapshots();
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_query WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(1);
    await expect(read()).rejects.toMatchObject({ code: 'analysis-compute-blocked', status: 503 });
    await sql('DELETE FROM liekan_analysis_query WHERE id=$1::uuid', pending.analysisJob.id);
    await expect(read()).rejects.toMatchObject({ code: 'analysis-compute-blocked', status: 503 });
    const retried = await read({ refresh: '1' });
    expect(retried.ready).toBe(false);
    if (retried.ready === false) expect(retried.analysisJob.id).not.toBe(pending.analysisJob.id);
  });
  it('retries transient failures after a bounded cooldown without requiring a data mutation', async () => {
    const pending = await read();
    if (pending.ready === true) throw new Error('expected cold dashboard');
    await sql(
      "UPDATE liekan_analysis_query SET status='failed',attempts=4,queued_at=clock_timestamp()-interval '10 seconds',error_code='analysis-compute-failed' WHERE id=$1::uuid",
      pending.analysisJob.id,
    );
    await expect(read()).rejects.toMatchObject({ code: 'analysis-retry-deferred' });
    await sql(
      "UPDATE liekan_analysis_query SET updated_at=clock_timestamp()-interval '6 minutes' WHERE id=$1::uuid",
      pending.analysisJob.id,
    );
    const next = await read();
    if (next.ready === true) throw new Error('expected retried dashboard');
    expect(next.analysisJob.id).not.toBe(pending.analysisJob.id);
  });
  it.each(['authority', 'publication', 'computation-budget'])(
    'retains the retry policy for a failure during %s',
    async phase => {
      const pending = await read();
      if (pending.ready) throw new Error('expected a cold dashboard');
      const transaction = rollupDatabase.analysisTransaction;
      const execution = await import('./analysis-query-execution');
      const acquireError = Object.assign(
        new Error('Unable to start a transaction in the given time'),
        {
          code: 'P2028',
        },
      );
      let authorityChecks = 0;
      const run = vi.spyOn(execution, 'executeAnalysisQuery').mockImplementation(async () => {
        if (phase === 'computation-budget')
          throw new AnalyticsUnavailable(
            'Synthetic query budget exhausted',
            5,
            503,
            'analysis-query-timeout',
          );
        return { pageviews: 1, visitors: 1 };
      });
      const intercepted = vi
        .spyOn(rollupDatabase, 'analysisTransaction')
        .mockImplementation((work, isolation) =>
          transaction(
            tx =>
              work(
                new Proxy(tx, {
                  get(target, property) {
                    if (property !== '$queryRawUnsafe' && property !== '$executeRawUnsafe')
                      return Reflect.get(target, property);
                    return async (statement: string, ...values: unknown[]) => {
                      if (
                        phase === 'authority' &&
                        statement.includes('FROM website') &&
                        statement.includes('FOR SHARE')
                      ) {
                        authorityChecks++;
                        throw acquireError;
                      }
                      if (
                        phase === 'publication' &&
                        statement.includes("SET status='ready',result=")
                      )
                        throw acquireError;
                      return target[property](statement, ...values);
                    };
                  },
                }),
              ),
            isolation,
          ),
        );
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          await sql(
            'UPDATE liekan_analysis_query SET next_attempt_at=clock_timestamp() WHERE id=$1::uuid',
            pending.analysisJob.id,
          );
          expect((await processAnalysisQuery(pending.analysisJob.id)).acquired).toBe(true);
        }
      } finally {
        intercepted.mockRestore();
        run.mockRestore();
      }
      const [failure] = await q(
        'SELECT status,attempts,error_code FROM liekan_analysis_query WHERE id=$1::uuid',
        pending.analysisJob.id,
      );
      expect(failure.status).toBe('failed');
      expect(failure.attempts).toBe(4);
      if (phase === 'computation-budget') {
        expect(failure.error_code).toBe('analysis-query-timeout');
        await expect(read()).rejects.toMatchObject({ code: 'analysis-compute-blocked' });
      } else {
        if (phase === 'authority') expect(authorityChecks).toBe(4);
        expect(failure.error_code).toBe('analysis-compute-failed');
        await expect(read()).rejects.toMatchObject({ code: 'analysis-retry-deferred' });
        await sql(
          "UPDATE liekan_analysis_query SET updated_at=clock_timestamp()-interval '6 minutes',queued_at=clock_timestamp()-interval '10 seconds' WHERE id=$1::uuid",
          pending.analysisJob.id,
        );
        const retried = await read();
        if (retried.ready) throw new Error('expected a new computation after cooldown');
        expect(retried.analysisJob.id).not.toBe(pending.analysisJob.id);
      }
    },
  );
  it('holds website authority before locking an unchanged clock publication', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const parameters = { ...p, resource: 'overview', chartPeriod: '30d' };
    const initial = await withPublishedRegistry(() =>
      requestDashboardSnapshot(site, actor, 'feature:page-report', parameters),
    );
    if (initial.ready) throw new Error('expected a cold overview');
    await finish(initial.analysisJob.id);
    clock.mockReturnValue(now + 31000);
    const transaction = rollupDatabase.analysisTransaction;
    const observer = new Client({ connectionString: process.env.DATABASE_URL });
    await observer.connect();
    const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
    let inspected = false;
    vi.spyOn(rollupDatabase, 'analysisTransaction').mockImplementation((work, isolation) =>
      transaction(
        tx =>
          work(
            new Proxy(tx, {
              get(target, property) {
                if (property !== '$queryRawUnsafe') return Reflect.get(target, property);
                return async (statement: string, ...values: unknown[]) => {
                  if (
                    !inspected &&
                    statement.startsWith('SELECT * FROM liekan_dashboard_snapshot') &&
                    statement.endsWith('FOR UPDATE')
                  ) {
                    inspected = true;
                    await observer.query('BEGIN');
                    try {
                      await observer.query(`SET LOCAL search_path TO "${schema}"`);
                      await expect(
                        observer.query(
                          'SELECT website_id FROM website WHERE website_id=$1::uuid FOR UPDATE NOWAIT',
                          [site],
                        ),
                      ).rejects.toMatchObject({ code: '55P03' });
                    } finally {
                      await observer.query('ROLLBACK');
                    }
                  }
                  return target.$queryRawUnsafe(statement, ...values);
                };
              },
            }),
          ),
        isolation,
      ),
    );
    try {
      const reused = await withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'feature:page-report', parameters),
      );
      expect(reused.ready).toBe(true);
      expect(inspected).toBe(true);
    } finally {
      await observer.end();
    }
  });
  it('retains deterministic failure evidence when expiry maintenance runs before the next snapshot check', async () => {
    const pending = await read();
    if (pending.ready) throw new Error('expected cold dashboard');
    await sql(
      "UPDATE liekan_analysis_query SET status='failed',attempts=4,error_code='analysis-query-timeout',queued_at=clock_timestamp()-interval '1 day',retention_until=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",
      pending.analysisJob.id,
    );
    await pumpAnalysisQueries({ send: vi.fn(), update: vi.fn() } as any);
    expect(
      await q('SELECT id FROM liekan_analysis_query WHERE id=$1::uuid', pending.analysisJob.id),
    ).toHaveLength(0);
    await expect(read()).rejects.toMatchObject({ code: 'analysis-compute-blocked' });
  });
  it('joins a concurrent explicit retry when the failed-task marker has already changed', async () => {
    const pending = await read();
    if (pending.ready) throw new Error('expected cold dashboard');
    await sql(
      "UPDATE liekan_analysis_query SET status='failed',attempts=4,queued_at=clock_timestamp()-interval '10 seconds',error_code='analysis-query-timeout' WHERE id=$1::uuid",
      pending.analysisJob.id,
    );
    const transaction = rollupDatabase.analysisTransaction;
    let retried: Awaited<ReturnType<typeof read>>;
    let intercepted = false;
    vi.spyOn(rollupDatabase, 'analysisTransaction').mockImplementation(async callback =>
      transaction(async tx =>
        callback(
          new Proxy(tx, {
            get(target, property) {
              if (property !== '$executeRawUnsafe') return Reflect.get(target, property);
              return async (statement: string, ...values: unknown[]) => {
                if (
                  !intercepted &&
                  statement.includes("SET error_code='dashboard-compute-failed'")
                ) {
                  intercepted = true;
                  retried = await read({ refresh: '1' });
                }
                return target.$executeRawUnsafe(statement, ...values);
              };
            },
          }),
        ),
      ),
    );
    const joined = await read();
    expect(intercepted).toBe(true);
    expect(retried).toMatchObject({ ready: false });
    expect(joined).toMatchObject({ ready: false });
    if (!joined.ready && !retried.ready) expect(joined.analysisJob.id).toBe(retried.analysisJob.id);
  });
  it('preserves a deterministic first-attempt failure after the last reader leaves', async () => {
    const pending = await read();
    if (pending.ready) throw new Error('expected cold dashboard');
    await sql(
      "UPDATE liekan_analysis_query SET status='failed',attempts=1,error_code='analysis-count-overflow' WHERE id=$1::uuid",
      pending.analysisJob.id,
    );
    await sql(
      "UPDATE liekan_dashboard_snapshot SET last_read_at=clock_timestamp()-interval '1 day',next_refresh_at=clock_timestamp()-interval '1 second' WHERE website_id=$1::uuid",
      site,
    );
    await pumpDashboardSnapshots();
    expect(
      (
        await q(
          'SELECT error_code FROM liekan_analysis_query WHERE id=$1::uuid',
          pending.analysisJob.id,
        )
      )[0].error_code,
    ).toBe('analysis-count-overflow');
    await expect(read()).rejects.toMatchObject({ code: 'analysis-compute-blocked' });
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_query WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(1);
  });
  it('reuses unchanged overview facts across a new clock window and still observes late input', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const parameters = { ...p, resource: 'overview', chartPeriod: '30d' };
    const request = () =>
      withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'feature:page-report', parameters),
      );
    const pending = await request();
    if (pending.ready === true) throw new Error('expected cold overview');
    await finish(pending.analysisJob.id);
    clock.mockReturnValue(now + 31000);
    const reused = await request();
    expect(reused.ready).toBe(true);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_query WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(1);
    if (reused.ready)
      expect(reused.value.meta.snapshot.dataThrough).toBeGreaterThan(
        Math.floor(now / 30000) * 30000,
      );
    await event('2026-01-01T02:00Z');
    await request();
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_query WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(2);
  });
  it.each([
    ['ai/overview', 'zh-CN'],
    ['ai/bots', 'en-US'],
    ['ai/pages', 'zh-CN'],
    ['ai/preference', 'en-US'],
  ] as const)(
    'reuses unchanged %s with the same public projection as recomputation in %s',
    async (resource, locale) => {
      const now = aiSnapshotNow();
      const today = Math.floor(now / 86400000) * 86400000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      const [log] = await aiLogs([now - 60000]);
      await event(new Date(now - 60000).toISOString());
      await sql(
        `INSERT INTO liekan_catalog(website_id,path,title,content_type,content_updated_at)
         VALUES($1::uuid,'/synthetic-ai-snapshot','Snapshot page','article',$2)`,
        site,
        new Date(now - 2 * 3600000),
      );
      const parameters = {
        startAt: today - 2 * 86400000,
        endAt: today + 86400000,
        resource,
        chartPeriod: '30d',
        timezone: 'UTC',
        crawlerMetricsVersion: 1,
      };
      const request = (refresh = false) =>
        withPublishedRegistry(() =>
          requestDashboardSnapshot(
            site,
            actor,
            'feature:page-report',
            { ...parameters, ...(refresh ? { refresh: '1' } : {}) },
            locale,
          ),
        );
      const initial = await request();
      if (initial.ready) throw new Error('expected a cold AI page');
      await finish(initial.analysisJob.id);
      const before = await request();
      if (!before.ready) throw new Error('expected a published AI page');
      clock.mockReturnValue(now + 31000);
      const reused = await request();
      if (!reused.ready) throw new Error('expected a reused AI page');
      const nextEnd = Math.floor((now + 31000) / 30000) * 30000;
      expect(reused.value.range.endAt).toBe(nextEnd);
      expect(reused.value.meta.snapshot).toMatchObject({ dataThrough: nextEnd, state: 'ready' });
      expect(
        await q('SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid', site),
      ).toHaveLength(1);
      if (reused.value.meta.population)
        expect(reused.value.meta.population.range.endAt).toBe(nextEnd);
      const [saved] = await q(
        'SELECT result FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
        site,
      );
      if (['ai/overview', 'ai/preference'].includes(resource))
        expect(saved.result.populations.length).toBeGreaterThan(0);
      expect(saved.result.populations.every(population => population.range.endAt === nextEnd)).toBe(
        true,
      );
      if (['ai/bots', 'ai/pages'].includes(resource)) {
        expect(reused.value.meta.crawlerEvidenceView.query.endAt).toBe(nextEnd);
        expect(reused.value.meta.crawlerEvidenceView.snapshot).not.toBe(
          before.value.meta.crawlerEvidenceView.snapshot,
        );
      }
      const forced = await request(true);
      if (forced.ready) throw new Error('expected an explicit recomputation');
      await expectAiProducerClock(forced.analysisJob.id, nextEnd);
      await finish(forced.analysisJob.id);
      const recomputed = await request();
      if (!recomputed.ready) throw new Error('expected a recomputed AI page');
      const content = (value: any) => {
        const copy = structuredClone(value);
        delete copy.meta.generatedAt;
        delete copy.meta.expiresAt;
        return copy;
      };
      if (process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT)
        await writeFile(
          `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/snapshot-reuse-${resource.replace('/', '-')}.json`,
          JSON.stringify(
            { reused: content(reused.value), recomputed: content(recomputed.value) },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      expect(content(reused.value)).toEqual(content(recomputed.value));
      await sql('UPDATE liekan_log SET status=201 WHERE website_id=$1::uuid AND id=$2', site, log);
      clock.mockReturnValue(now + 62000);
      expect(await request()).toMatchObject({ ready: true, snapshotState: 'updating' });
      expect(
        await q('SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid', site),
      ).toHaveLength(3);
    },
  );
  it('recomputes bot trends when the moving previous interval admits an existing historical log', async () => {
    const now = aiSnapshotNow();
    const today = Math.floor(now / 86400000) * 86400000;
    const oldEnd = Math.floor(now / 30000) * 30000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const startAt = today - 86400000;
    await aiLogs([now - 60000, 2 * startAt - oldEnd - 10000]);
    const parameters = {
      startAt,
      endAt: today + 86400000,
      resource: 'ai/bots',
      timezone: 'UTC',
      crawlerMetricsVersion: 1,
    };
    const request = () =>
      withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'feature:page-report', parameters),
      );
    const pending = await request();
    if (pending.ready) throw new Error('expected cold bots');
    await finish(pending.analysisJob.id);
    const before = await request();
    if (!before.ready) throw new Error('expected published bots');
    expect(before.value.tables.botBody[0].trend).toBeNull();
    clock.mockReturnValue(now + 31000);
    await request();
    const jobs = await q(
      'SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid ORDER BY sequence',
      site,
    );
    expect(jobs).toHaveLength(2);
    await expectAiProducerClock(jobs[1].id, Math.floor((now + 31000) / 30000) * 30000);
    await finish(jobs[1].id);
    const after = await request();
    if (!after.ready) throw new Error('expected recomputed bots');
    expect(after.value.tables.botBody[0].trend).toBe(0);
  });
  it('recomputes page freshness when elapsed content age crosses a displayed day', async () => {
    const now = aiSnapshotNow();
    const today = Math.floor(now / 86400000) * 86400000;
    const oldEnd = Math.floor(now / 30000) * 30000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await aiLogs([now - 60000]);
    await sql(
      `INSERT INTO liekan_catalog(website_id,path,title,content_type,content_updated_at)
       VALUES($1::uuid,'/synthetic-ai-snapshot','Fresh page','article',$2)`,
      site,
      new Date(oldEnd - 86400000 + 15000),
    );
    const parameters = {
      startAt: today - 86400000,
      endAt: today + 86400000,
      resource: 'ai/pages',
      timezone: 'UTC',
      crawlerMetricsVersion: 1,
    };
    const request = () =>
      withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'feature:page-report', parameters),
      );
    const pending = await request();
    if (pending.ready) throw new Error('expected cold pages');
    await finish(pending.analysisJob.id);
    const before = await request();
    if (!before.ready) throw new Error('expected published pages');
    expect(before.value.tables.apBody[0].freshness).toBe('0 天');
    clock.mockReturnValue(now + 31000);
    await request();
    const jobs = await q(
      'SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid ORDER BY sequence',
      site,
    );
    expect(jobs).toHaveLength(2);
    await expectAiProducerClock(jobs[1].id, Math.floor((now + 31000) / 30000) * 30000);
    await finish(jobs[1].id);
    const after = await request();
    if (!after.ready) throw new Error('expected recomputed pages');
    expect(after.value.tables.apBody[0].freshness).toBe('1 天');
  });
  it('attaches advanced crawler evidence with the fingerprint transaction and its repeatable snapshot', async () => {
    const now = aiSnapshotNow();
    const today = Math.floor(now / 86400000) * 86400000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await aiLogs([now - 60000]);
    const parameters = {
      startAt: today,
      endAt: today + 86400000,
      resource: 'ai/bots',
      timezone: 'UTC',
      crawlerMetricsVersion: 1,
    };
    const request = () =>
      withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'feature:page-report', parameters),
      );
    const pending = await request();
    if (pending.ready) throw new Error('expected cold bots');
    await finish(pending.analysisJob.id);
    const transaction = rollupDatabase.analysisTransaction;
    let fingerprintTransaction: object | undefined;
    let evidenceTransaction: object | undefined;
    vi.spyOn(rollupDatabase, 'analysisTransaction').mockImplementation((work, isolation) =>
      transaction(
        tx =>
          work(
            new Proxy(tx, {
              get(target, property) {
                if (property !== '$queryRawUnsafe') return Reflect.get(target, property);
                return async (statement: string, ...values: unknown[]) => {
                  if (statement.includes('SELECT liekan_dashboard_fingerprint'))
                    fingerprintTransaction = tx;
                  if (statement.startsWith('SELECT path,updated_at AS "updatedAt"')) {
                    evidenceTransaction = tx;
                    expect(isolation).toBe('RepeatableRead');
                  }
                  return target.$queryRawUnsafe(statement, ...values);
                };
              },
            }),
          ),
        isolation,
      ),
    );
    clock.mockReturnValue(now + 31000);
    const reused = await request();
    expect(reused.ready).toBe(true);
    expect(evidenceTransaction).toBeDefined();
    expect(evidenceTransaction).toBe(fingerprintTransaction);
  });
  it('falls back to normal admission when an unchanged-clock transaction loses a serialization race', async () => {
    const now = aiSnapshotNow();
    const today = Math.floor(now / 86400000) * 86400000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const parameters = {
      startAt: today,
      endAt: today + 86400000,
      resource: 'ai/bots',
      timezone: 'UTC',
      crawlerMetricsVersion: 1,
    };
    const request = () =>
      withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'feature:page-report', parameters),
      );
    const pending = await request();
    if (pending.ready) throw new Error('expected cold bots');
    await finish(pending.analysisJob.id);
    const transaction = rollupDatabase.analysisTransaction;
    let rejected = false;
    vi.spyOn(rollupDatabase, 'analysisTransaction').mockImplementation((work, isolation) => {
      if (!rejected && isolation === 'RepeatableRead') {
        rejected = true;
        return Promise.reject(
          Object.assign(new Error('synthetic concurrent publication'), { code: 'P2034' }),
        );
      }
      return transaction(work, isolation);
    });
    clock.mockReturnValue(now + 31000);
    expect(await request()).toMatchObject({ ready: true, snapshotState: 'updating' });
    expect(rejected).toBe(true);
    expect(
      await q('SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid', site),
    ).toHaveLength(2);
  });
  it('invalidates a reused overview when import metadata changes without new logs', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const parameters = { ...p, resource: 'overview', chartPeriod: '30d' };
    const request = () =>
      withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'feature:page-report', parameters),
      );
    const pending = await request();
    if (pending.ready === true) throw new Error('expected cold overview');
    await finish(pending.analysisJob.id);
    await sql(
      'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$1,1,0)',
      randomUUID(),
      site,
    );
    clock.mockReturnValue(now + 31000);
    const stale = await request();
    expect(stale.ready).toBe(true);
    const jobs = await q(
      'SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid ORDER BY sequence',
      site,
    );
    expect(jobs).toHaveLength(2);
    await finish(jobs[1].id);
    const next = await request();
    if (!next.ready) throw new Error('expected a published overview');
    expect(next.value.meta.latestImportAt).not.toBeNull();
  });
  it('projects a reused live overview and its population evidence identically to a new computation', async () => {
    const now = Math.ceil(Date.now() / 3600000) * 3600000 + 300000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const startAt = Math.floor(now / 86400000) * 86400000;
    await event(new Date(now - 60000).toISOString());
    const parameters = {
      startAt,
      endAt: startAt + 86400000 - 1,
      timezone: 'UTC',
      resource: 'overview',
      chartPeriod: 'today',
    };
    const request = (refresh = false) =>
      withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'feature:page-report', {
          ...parameters,
          ...(refresh ? { refresh: '1' } : {}),
        }),
      );
    const pending = await request();
    if (pending.ready) throw new Error('expected cold overview');
    await finish(pending.analysisJob.id);
    clock.mockReturnValue(now + 31000);
    const reused = await request();
    if (!reused.ready) throw new Error('expected reused overview');
    const nextEnd = Math.floor((now + 31000) / 30000) * 30000 - 1;
    expect(reused.value.range.endAt).toBe(nextEnd);
    expect(reused.value.meta.population.range.endAt).toBe(nextEnd);
    expect(reused.value.meta.trendPopulation.range.endAt).toBe(nextEnd);
    const [snapshot] = await q(
      'SELECT result FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
      site,
    );
    expect(snapshot.result.populations.length).toBeGreaterThan(0);
    expect(
      snapshot.result.populations.every(population => population.range.endAt === nextEnd),
    ).toBe(true);
    const forced = await request(true);
    if (forced.ready) throw new Error('expected explicit fresh computation');
    await finish(forced.analysisJob.id);
    const recomputed = await request();
    if (!recomputed.ready) throw new Error('expected published result');
    const content = (value: any) => {
      const copy = structuredClone(value);
      delete copy.meta.generatedAt;
      delete copy.meta.expiresAt;
      return copy;
    };
    expect(content(reused.value)).toEqual(content(recomputed.value));
  });
  it('observes a log exactly at the next inclusive today cutoff', async () => {
    const now = Math.floor(Date.now() / 30000) * 30000 + 5000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const midnight = Math.floor(now / 86400000) * 86400000;
    const imported = randomUUID();
    await sql(
      'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$1,1,0)',
      imported,
      site,
    );
    const parameters = {
      startAt: midnight,
      endAt: midnight + 86400000 - 1,
      timezone: 'UTC',
      resource: 'overview',
      chartPeriod: 'today',
    };
    const request = () =>
      withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'feature:page-report', parameters),
      );
    const initial = await request();
    if (initial.ready) throw new Error('expected cold overview');
    await finish(initial.analysisJob.id);
    const cutoff = Math.floor((now + 31000) / 30000) * 30000;
    await sql(
      `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification)
      VALUES($1,$2::uuid,$3::uuid,$4,'/boundary','GET',200,10,'','synthetic','Synthetic fixture','','','','','unknown')`,
      randomUUID(),
      site,
      imported,
      new Date(cutoff),
    );
    clock.mockReturnValue(now + 31000);
    await request();
    const jobs = await q(
      'SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid ORDER BY sequence',
      site,
    );
    expect(jobs).toHaveLength(2);
    await finish(jobs[1].id);
    const result = await request();
    if (!result.ready) throw new Error('expected published overview');
    expect(result.value.cards.find(card => card.label === '今日总请求')?.value).toBe(1);
  });
  it('reuses a published overview through operational connection heartbeats', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const source = randomUUID();
    await sql(
      "INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by,state) VALUES($1::uuid,$2::uuid,'server','snapshot.invalid',$3::uuid,'active')",
      source,
      site,
      actor.id,
    );
    const parameters = { ...p, resource: 'overview', chartPeriod: '30d' };
    const request = () =>
      withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'feature:page-report', parameters),
      );
    const pending = await request();
    if (pending.ready) throw new Error('expected cold overview');
    await finish(pending.analysisJob.id);
    await sql(
      'UPDATE liekan_log_source SET last_permission_check_at=clock_timestamp(),last_heartbeat_at=clock_timestamp(),provider_lease=$2::uuid WHERE id=$1::uuid',
      source,
      randomUUID(),
    );
    clock.mockReturnValue(now + 31000);
    expect((await request()).ready).toBe(true);
    expect(
      await q('SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid', site),
    ).toHaveLength(1);
    await sql("UPDATE liekan_log_source SET state='disconnected' WHERE id=$1::uuid", source);
    clock.mockReturnValue(now + 62000);
    await request();
    expect(
      await q('SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid', site),
    ).toHaveLength(2);
    await sql('DELETE FROM liekan_log_source WHERE id=$1::uuid', source);
  });
  it.each(['risk processing', 'log connection'])(
    'invalidates an unchanged overview after %s metadata changes',
    async kind => {
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      const parameters = { ...p, resource: 'overview', chartPeriod: '30d' };
      const request = () =>
        withPublishedRegistry(() =>
          requestDashboardSnapshot(site, actor, 'feature:page-report', parameters),
        );
      const pending = await request();
      if (pending.ready) throw new Error('expected cold overview');
      await finish(pending.analysisJob.id);
      if (kind === 'risk processing') {
        await sql(
          "INSERT INTO liekan_browser_risk_state(website_id,epoch,next_window,rule_version) SELECT website_id,epoch,clock_timestamp(),'fixture' FROM liekan_analysis_site WHERE website_id=$1::uuid ON CONFLICT(website_id) DO UPDATE SET computed_at=clock_timestamp()",
          site,
        );
      } else {
        await sql(
          "INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by,state) VALUES($1::uuid,$2::uuid,'server','snapshot.invalid',$3::uuid,'active')",
          randomUUID(),
          site,
          actor.id,
        );
      }
      clock.mockReturnValue(now + 31000);
      expect((await request()).ready).toBe(true);
      expect(
        await q('SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid', site),
      ).toHaveLength(2);
      await sql('DELETE FROM liekan_log_source WHERE website_id=$1::uuid', site);
    },
  );
  it('keeps unviewed prewarming off the foreground dashboard permit', async () => {
    const seed = await withPublishedRegistry(() =>
      requestDashboardSnapshot(site, actor, 'native:stats', p, 'zh-CN', false),
    );
    if (seed.ready === true) throw new Error('expected cold seed');
    await withAnalysisPermit('dashboard', async () => {
      const result = await processAnalysisQuery(seed.analysisJob.id);
      expect(result.acquired).toBe(true);
      expect(result.value).toBeUndefined();
    });
    expect(await read()).toMatchObject({ ready: true, value: { pageviews: 1 } });
  });
  it('promotes a deferred midnight seed to the visible thirty-second window', async () => {
    const midnight = Math.floor((Date.now() + 28800000) / 86400000) * 86400000 - 28800000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(midnight + 10000);
    const parameters = {
      resource: 'overview',
      chartPeriod: 'today',
      startAt: midnight,
      endAt: midnight + 86400000 - 1,
      timezone: 'Asia/Shanghai',
    };
    const readSeed = (foreground: boolean) =>
      withPublishedRegistry(() =>
        requestDashboardSnapshot(
          site,
          actor,
          'feature:page-report',
          parameters,
          'zh-CN',
          foreground,
        ),
      );
    const seed = await readSeed(false);
    if (seed.ready === true) throw new Error('expected a deferred midnight seed');
    const [before] = await q(
      'SELECT pending_through FROM liekan_dashboard_snapshot WHERE job_id=$1::uuid',
      seed.analysisJob.id,
    );
    expect(+new Date(before.pending_through)).toBe(midnight + 300000);
    // Preserve the deferred-delivery state when this fixture runs later in the day.
    await sql(
      "UPDATE liekan_analysis_query SET next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE id=$1::uuid",
      seed.analysisJob.id,
    );
    clock.mockReturnValue(midnight + 120000);
    const visible = await readSeed(true);
    expect(visible).toMatchObject({ ready: false, analysisJob: { id: seed.analysisJob.id } });
    const [promoted] = await q(
      `SELECT q.attempts,q.next_attempt_at<=clock_timestamp() AS due,d.pending_through,d.dependency_end,
       d.pending_fingerprint IS NOT NULL AS fenced
       FROM liekan_analysis_query q JOIN liekan_dashboard_snapshot d ON d.job_id=q.id WHERE q.id=$1::uuid`,
      seed.analysisJob.id,
    );
    expect(promoted).toMatchObject({ attempts: 0, due: true, fenced: true });
    expect(+new Date(promoted.pending_through)).toBe(midnight + 120000);
    expect(+new Date(promoted.dependency_end)).toBe(midnight + 120001);
    clock.mockRestore();
    await finish(seed.analysisJob.id);
    expect(await readSeed(true)).toMatchObject({ ready: true });
    await sql('DELETE FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid', site);
  });
  it.each(['queued', 'running', 'shared'])(
    'preserves a %s producer boundary outside a single unstarted seed',
    async status => {
      const midnight = Math.floor((Date.now() + 28800000) / 86400000) * 86400000 - 28800000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(midnight + 10000);
      const parameters = {
        resource: 'overview',
        chartPeriod: 'today',
        startAt: midnight,
        endAt: midnight + 86400000 - 1,
        timezone: 'Asia/Shanghai',
      };
      const seed = await withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'feature:page-report', parameters, 'zh-CN', false),
      );
      if (seed.ready === true) throw new Error('expected a deferred midnight seed');
      await sql(
        `UPDATE liekan_analysis_query SET status=$2,attempts=$3,
         next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE id=$1::uuid`,
        seed.analysisJob.id,
        status === 'shared' ? 'queued' : status,
        status === 'shared' ? 0 : 1,
      );
      if (status === 'shared')
        await sql(
          `INSERT INTO liekan_dashboard_snapshot(website_id,query_key,actor_id,target,parameters,locale,strong_version,
           epoch,calendar_day,dependency_end,job_id,pending_fingerprint,pending_through)
           SELECT website_id,query_key||'-alias',actor_id,target,parameters,locale,strong_version,
           epoch,calendar_day,dependency_end,job_id,pending_fingerprint,pending_through
           FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid`,
          site,
        );
      const query = `SELECT q.status,q.attempts,q.next_attempt_at,d.pending_through,d.dependency_end,d.pending_fingerprint
        FROM liekan_analysis_query q JOIN liekan_dashboard_snapshot d ON d.job_id=q.id WHERE q.id=$1::uuid ORDER BY d.query_key`;
      const before = await q(query, seed.analysisJob.id);
      clock.mockReturnValue(midnight + 120000);
      await withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'feature:page-report', parameters, 'zh-CN', true),
      );
      expect(await q(query, seed.analysisJob.id)).toEqual(before);
      await sql('DELETE FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid', site);
    },
  );
  it('serves a short dashboard while the heavy analysis permit is occupied', async () => {
    const pending = await read();
    if (pending.ready === true) throw new Error('expected cold dashboard');
    await withAnalysisPermit('interactive', async () => {
      const executed = await processAnalysisQuery(pending.analysisJob.id);
      expect(executed.acquired).toBe(true);
      expect(executed.value).toBeUndefined();
    });
    expect(await read()).toMatchObject({ ready: true, value: { pageviews: 1 } });
  });
  it('parks an idle failed dashboard instead of starting another retry batch', async () => {
    // Earlier cases keep their publications; this maintenance scenario owns the current website.
    await sql(
      "UPDATE liekan_dashboard_snapshot SET next_refresh_at='9999-12-31' WHERE actor_id=$2::uuid AND website_id<>$1::uuid",
      site,
      actor.id,
    );
    const pending = await read();
    if (pending.ready === true) throw new Error('expected cold dashboard');
    await sql(
      "UPDATE liekan_analysis_query SET status='failed',attempts=4,queued_at=clock_timestamp()-interval '1 day' WHERE id=$1::uuid",
      pending.analysisJob.id,
    );
    await sql(
      "UPDATE liekan_dashboard_snapshot SET last_read_at=clock_timestamp()-interval '1 day',next_refresh_at=clock_timestamp()-interval '1 second' WHERE website_id=$1::uuid",
      site,
    );
    await pumpDashboardSnapshots();
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_query WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(1);
    expect(
      (
        await q(
          'SELECT error_code,job_id FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
          site,
        )
      )[0],
    ).toEqual({ error_code: 'dashboard-paused', job_id: null });
    expect(
      (
        await q(
          'SELECT error_code FROM liekan_analysis_query WHERE id=$1::uuid',
          pending.analysisJob.id,
        )
      )[0].error_code,
    ).toBe('analysis-idle');
    const resumed = await read();
    expect(resumed.ready).toBe(false);
    if (resumed.ready === false) expect(resumed.analysisJob.id).not.toBe(pending.analysisJob.id);
  });
  it('does not dispatch idle failed dashboard retries while preserving a first cold attempt', async () => {
    const pending = await read();
    if (pending.ready === true) throw new Error('expected cold dashboard');
    await sql(
      "UPDATE liekan_dashboard_snapshot SET last_read_at=clock_timestamp()-interval '1 day' WHERE website_id=$1::uuid",
      site,
    );
    const send = vi.fn(async () => 'synthetic-handoff'),
      update = vi.fn();
    await pumpAnalysisQueries({ send, update } as any);
    expect(send).toHaveBeenCalled();
    send.mockClear();
    await sql(
      'UPDATE liekan_analysis_query SET attempts=1 WHERE id=$1::uuid',
      pending.analysisJob.id,
    );
    await pumpAnalysisQueries({ send, update } as any);
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await q(
          'SELECT status FROM liekan_analysis_query WHERE id=$1::uuid',
          pending.analysisJob.id,
        )
      )[0].status,
    ).toBe('failed');
  });
  it('keeps a viewed retry active through authorized status reads', async () => {
    const pending = await read();
    if (pending.ready === true) throw new Error('expected cold dashboard');
    await sql(
      'UPDATE liekan_analysis_query SET attempts=1 WHERE id=$1::uuid',
      pending.analysisJob.id,
    );
    await sql(
      "UPDATE liekan_dashboard_snapshot SET last_read_at=clock_timestamp()-interval '1 day' WHERE website_id=$1::uuid",
      site,
    );
    await withPublishedRegistry(() => readAnalysisQuery(site, actor, pending.analysisJob.id));
    const send = vi.fn(async () => 'viewed-retry'),
      update = vi.fn();
    await pumpAnalysisQueries({ send, update } as any);
    expect(send.mock.calls.some((call: any[]) => call[1].id === pending.analysisJob.id)).toBe(true);
    expect(
      (
        await q(
          'SELECT status FROM liekan_analysis_query WHERE id=$1::uuid',
          pending.analysisJob.id,
        )
      )[0].status,
    ).toBe('queued');
  });
  it('keeps history eligible while only independent short dashboard jobs are waiting', async () => {
    const task = await read();
    if (task.ready === true) throw new Error('expected cold dashboard');
    expect((await withAnalysisPermit('history', async () => true)).acquired).toBe(true);
    await sql('UPDATE liekan_analysis_query SET attempts=1 WHERE id=$1::uuid', task.analysisJob.id);
    expect((await withAnalysisPermit('history', async () => true)).acquired).toBe(false);
  });
  it('uses remaining seed space without evicting and rebuilding a current seed', async () => {
    await sql("UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id<>$1::uuid", site);
    await sql(
      `INSERT INTO liekan_dashboard_snapshot(website_id,query_key,actor_id,target,parameters,locale,strong_version,epoch,calendar_day,dependency_end)
      SELECT website_id,'synthetic-front-'||n,$2::uuid,'native:stats','{}','zh-CN','synthetic',epoch,'','2026-01-01'
      FROM liekan_analysis_site CROSS JOIN generate_series(1,199) n WHERE website_id=$1::uuid`,
      site,
      actor.id,
    );
    await seedDashboardSnapshots();
    const [task] = await q('SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid', site);
    await finish(task.id);
    const [published] = await q(
      "SELECT query_key FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid AND target='feature:page-report'",
      site,
    );
    for (let pass = 0; pass < 3; pass++) await seedDashboardSnapshots();
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_query WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(1);
    expect(
      (
        await q(
          "SELECT query_key FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid AND target='feature:page-report'",
          site,
        )
      )[0],
    ).toEqual(published);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(200);
    await sql(
      "DELETE FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid AND query_key LIKE 'synthetic-front-%'",
      site,
    );
  });
  it('prewarms Today and seven-day results at full capacity and reuses them across an hour', async () => {
    await sql("UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id<>$1::uuid", site);
    const { dashboardWarmRanges } = await import('./dashboard-snapshot-model');
    // Future local noon keeps the hourly case independent of the machine's midnight boundary.
    const captured = Math.floor(Date.now() / 86400000) * 86400000 + 86400000 + 4 * 3600000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(captured);
    await sql(
      `INSERT INTO liekan_dashboard_snapshot(website_id,query_key,actor_id,target,parameters,locale,strong_version,epoch,calendar_day,dependency_end,last_read_at)
       SELECT website_id,'synthetic-idle-'||n,$2::uuid,'native:stats','{}','zh-CN','synthetic',epoch,'','2026-01-01',clock_timestamp()-interval '1 day'
       FROM liekan_analysis_site CROSS JOIN generate_series(1,199) n WHERE website_id=$1::uuid`,
      site,
      actor.id,
    );
    // A recently read result remains protected when the cache is full.
    await sql(
      "UPDATE liekan_dashboard_snapshot SET last_read_at=clock_timestamp() WHERE website_id=$1::uuid AND query_key='synthetic-idle-1'",
      site,
    );
    const seeded: any[] = [];
    for (
      let pass = 0;
      pass < warmResources.length + warmResources.indexOf('ai/pages') + 1;
      pass++
    ) {
      await seedDashboardSnapshots();
      const [task] = await q(
        "SELECT id,parameters FROM liekan_analysis_query WHERE website_id=$1::uuid AND status='queued'",
        site,
      );
      expect(task, `full cache must admit common selection ${pass}`).toBeDefined();
      await finish(task.id);
      seeded.push(task.parameters);
    }
    const ranges = dashboardWarmRanges('Asia/Shanghai', captured);
    for (let index = 0; index < 2; index++) {
      expect(seeded.filter(parameters => parameters.resource === 'ai/pages')[index]).toMatchObject({
        resource: 'ai/pages',
        startAt: ranges[index].startAt,
        endAt: ranges[index].endAt + 1,
      });
    }
    const [before] = await q(
      "SELECT query_key,generated_at FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid AND parameters->>'startAt'=$2 AND parameters->>'resource'='ai/pages'",
      site,
      String(ranges[1].startAt),
    );
    await sql(
      `INSERT INTO liekan_dashboard_snapshot(website_id,query_key,actor_id,target,parameters,locale,strong_version,epoch,calendar_day,dependency_end,last_read_at)
       SELECT website_id,'synthetic-refill-'||n,$2::uuid,'native:stats','{}','zh-CN','synthetic',epoch,'','2026-01-01',clock_timestamp()-interval '1 day'
       FROM liekan_analysis_site CROSS JOIN generate_series(1,
         (SELECT 200-count(*)::int FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid)) n
       WHERE website_id=$1::uuid`,
      site,
      actor.id,
    );
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(200);
    clock.mockReturnValue(Math.floor(captured / 3600000) * 3600000 + 3600000 + 1000);
    const currentRange = dashboardWarmRanges('Asia/Shanghai')[0];
    expect(currentRange).toEqual(ranges[0]);
    for (const [index, range] of [currentRange, ranges[1]].entries()) {
      expect(
        await withPublishedRegistry(() =>
          requestDashboardSnapshot(site, actor, 'feature:page-report', {
            ...range,
            chartPeriod: index === 0 ? 'today' : '7d',
            resource: 'ai/pages',
            endAt: range.endAt + 1,
            timezone: 'Asia/Shanghai',
            crawlerIdentityScope: 'all',
            crawlerMetricsVersion: 1,
          }),
        ),
      ).toMatchObject({ ready: true });
    }
    const [after] = await q(
      'SELECT query_key,generated_at FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid AND query_key=$2',
      site,
      before.query_key,
    );
    expect(after).toEqual(before);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBeLessThanOrEqual(200);
    expect(
      (
        await q(
          "SELECT query_key FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid AND query_key='synthetic-idle-1'",
          site,
        )
      )[0],
    ).toBeDefined();
  }, 20000);
  it('parks unviewed old selections and resumes their correction fence on a reader return', async () => {
    await sql("UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id<>$1::uuid", site);
    const first = await read();
    if (first.ready === true) throw new Error('expected cold fixture');
    await finish(first.analysisJob.id);
    await sql(
      "UPDATE liekan_dashboard_snapshot SET last_read_at=clock_timestamp()-interval '1 day',next_refresh_at=clock_timestamp()-interval '1 second' WHERE website_id=$1::uuid",
      site,
    );
    await pumpDashboardSnapshots();
    expect(
      (
        await q('SELECT error_code FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid', site)
      )[0].error_code,
    ).toBe('dashboard-idle');
    expect(
      (
        await q(
          "SELECT count(*)::int AS n FROM liekan_analysis_query WHERE website_id=$1::uuid AND status IN('queued','running')",
          site,
        )
      )[0].n,
    ).toBe(0);
    await event('2026-01-01T02:00Z');
    const resumed = await read();
    if (resumed.ready === true) throw new Error('reader must recheck the parked input fence');
    await finish(resumed.analysisJob.id);
    expect(await read()).toMatchObject({ ready: true, value: { pageviews: 2 } });
  });
  it('replaces unviewed prior-day seeds with the new day overview selections', async () => {
    await sql("UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id<>$1::uuid", site);
    const { dashboardWarmRanges } = await import('./dashboard-snapshot-model');
    const captured =
      Math.floor(Date.now() / 86400000) * 86400000 + 86400000 + 15 * 3600000 + 59 * 60000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(captured);
    const before = dashboardWarmRanges('Asia/Shanghai');
    for (let pass = 0; pass < 3; pass++) {
      await seedDashboardSnapshots();
      const [task] = await q(
        "SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid AND status='queued'",
        site,
      );
      await finish(task.id);
    }
    clock.mockReturnValue(captured + 7 * 60000);
    const after = dashboardWarmRanges('Asia/Shanghai');
    expect(after[1].startAt).toBe(before[1].startAt + 86400000);
    for (const resource of ['overview', 'human/overview']) {
      await seedDashboardSnapshots();
      const [task] = await q(
        "SELECT id,parameters FROM liekan_analysis_query WHERE website_id=$1::uuid AND status='queued'",
        site,
      );
      expect(task?.parameters).toMatchObject({
        resource,
        startAt: after[0].startAt,
        endAt: after[0].endAt,
      });
      await finish(task.id);
    }
    expect(
      (
        await q(
          "SELECT count(*)::int AS n FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid AND parameters->>'startAt'=$2",
          site,
          String(before[0].startAt),
        )
      )[0].n,
    ).toBe(0);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid AND result IS NOT NULL',
          site,
        )
      )[0].n,
    ).toBe(2);
  });
  it('reuses an unchanged parked historical result without starting another computation', async () => {
    await sql("UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id<>$1::uuid", site);
    const first = await read();
    if (first.ready === true) throw new Error('expected cold fixture');
    await finish(first.analysisJob.id);
    await sql(
      "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '10 seconds' WHERE website_id=$1::uuid",
      site,
    );
    const [before] = await q(
      'SELECT generated_at FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
      site,
    );
    await sql(
      "UPDATE liekan_dashboard_snapshot SET last_read_at=clock_timestamp()-interval '1 day',next_refresh_at=clock_timestamp()-interval '1 second' WHERE website_id=$1::uuid",
      site,
    );
    await pumpDashboardSnapshots();
    expect(await read()).toMatchObject({ ready: true, value: { pageviews: 1 } });
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_query WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(1);
    expect(
      (
        await q(
          'SELECT generated_at FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
          site,
        )
      )[0],
    ).toEqual(before);
  });
  it('keeps the current seed when a foreground selection enters a full cache', async () => {
    await sql("UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id<>$1::uuid", site);
    await seedDashboardSnapshots();
    const [seed] = await q(
      "SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid AND status='queued'",
      site,
    );
    await finish(seed.id);
    const [published] = await q(
      'SELECT query_key,generated_at FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
      site,
    );
    await sql(
      `INSERT INTO liekan_dashboard_snapshot(website_id,query_key,actor_id,target,parameters,locale,strong_version,epoch,calendar_day,dependency_end,last_read_at)
       SELECT website_id,'synthetic-foreground-lru-'||n,$2::uuid,'native:stats','{}','zh-CN','synthetic',epoch,'','2026-01-01',clock_timestamp()-interval '1 day'
       FROM liekan_analysis_site CROSS JOIN generate_series(1,199) n WHERE website_id=$1::uuid`,
      site,
      actor.id,
    );
    const foreground = await read();
    if (foreground.ready === true) throw new Error('expected a cold foreground selection');
    expect(
      (
        await q(
          'SELECT query_key,generated_at FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid AND query_key=$2',
          site,
          published.query_key,
        )
      )[0],
    ).toEqual(published);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(200);
    await finish(foreground.analysisJob.id);
  });
  it('keeps cold prewarming and correction of an existing idle common publication independent', async () => {
    await sql("UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id<>$1::uuid", site);
    const captured = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(captured);
    await seedDashboardSnapshots();
    const [seed] = await q(
      "SELECT id,parameters FROM liekan_analysis_query WHERE website_id=$1::uuid AND status='queued'",
      site,
    );
    await finish(seed.id);
    const delivered: string[] = [];
    for (let pass = 0; pass < 2; pass++) {
      // Model separate maintenance passes outside the existing five-second refresh cooldown.
      await sql(
        "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '10 seconds' WHERE website_id=$1::uuid",
        site,
      );
      await sql(
        "UPDATE liekan_dashboard_snapshot SET fingerprint=NULL,next_refresh_at=clock_timestamp()-interval '1 second' WHERE website_id=$1::uuid AND parameters->>'startAt'=$2",
        site,
        String(seed.parameters.startAt),
      );
      await pumpDashboardDemand();
      const tasks = await q(
        "SELECT id,parameters FROM liekan_analysis_query WHERE website_id=$1::uuid AND status='queued'",
        site,
      );
      expect(tasks).toHaveLength(2);
      for (const task of tasks) {
        delivered.push(task.parameters.resource);
        await finish(task.id);
      }
    }
    expect(delivered).toContain(seed.parameters.resource);
    expect(delivered.some(resource => resource !== seed.parameters.resource)).toBe(true);
  });
  it('follows an updated heavy publication to completion on pages without live polling', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const current = () =>
      withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'native:heatmaps', { ...p, endAt: now + 3600000 }),
      );
    const first = await current();
    if (first.ready === true) throw new Error('expected cold heatmap');
    await finish(first.analysisJob.id);
    clock.mockReturnValue(now + 300000);
    const updating = await current();
    expect(updating.ready).toBe(false);
    expect(updating).toHaveProperty('previousResult');
    if (updating.ready === false) await finish(updating.analysisJob.id);
    await event('2026-01-01T02:00Z', false);
    await sql(
      "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '10 seconds' WHERE website_id=$1::uuid",
      site,
    );
    await sql(
      "UPDATE liekan_dashboard_snapshot SET next_refresh_at=clock_timestamp()-interval '1 second' WHERE website_id=$1::uuid",
      site,
    );
    await pumpDashboardSnapshots();
    const corrected = await current();
    expect(corrected.ready).toBe(false);
    expect(corrected).toHaveProperty('previousResult');
    if (corrected.ready === false) await finish(corrected.analysisJob.id);
  });
  it('prewarms the exact Today, seven-day and thirty-day UI selections without reader demand', async () => {
    await sql("UPDATE liekan_analysis_site SET dashboard_seed_checked_at='9999-12-31'");
    await sql(
      'UPDATE liekan_analysis_site SET dashboard_seed_checked_at=NULL WHERE website_id=$1::uuid',
      site,
    );
    const { dashboardWarmRanges } = await import('./dashboard-snapshot-model');
    const ranges = dashboardWarmRanges('Asia/Shanghai');
    for (const [index, range] of ranges.entries()) {
      for (const resource of warmResources) {
        await seedDashboardSnapshots();
        const [cold] = await q(
          "SELECT * FROM liekan_analysis_query WHERE website_id=$1::uuid AND status='queued'",
          site,
        );
        expect(cold?.parameters).toMatchObject({
          resource,
          chartPeriod: ['today', '7d', '30d'][index],
          startAt: range.startAt,
          endAt: range.endAt + (resource.startsWith('ai/') ? 1 : 0),
          ...(resource.startsWith('ai/')
            ? { crawlerIdentityScope: 'all', crawlerMetricsVersion: 1 }
            : {}),
        });
        await finish(cold.id);
      }
    }
    const publications = await q(
      'SELECT parameters,last_read_at,result FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
      site,
    );
    expect(publications).toHaveLength(warmResources.length * 3);
    expect(publications.every(row => +new Date(row.last_read_at) === 0 && row.result != null)).toBe(
      true,
    );
    const selected = ranges[0];
    expect(
      await withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'feature:page-report', {
          ...selected,
          chartPeriod: 'today',
          endAt: selected.endAt + 1,
          timezone: 'Asia/Shanghai',
          resource: 'ai/pages',
          crawlerIdentityScope: 'all',
          crawlerMetricsVersion: 1,
        }),
      ),
    ).toMatchObject({ ready: true });
  }, 20000);
  it('reads a historical publication after transient task expiry without creating new computations', async () => {
    const first = await read();
    if (first.ready === true) throw new Error('fixture already published');
    await finish(first.analysisJob.id);
    await sql(
      "UPDATE liekan_analysis_query SET expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1::uuid",
      first.analysisJob.id,
    );
    const value = await read();
    expect(value.ready).toBe(true);
    if (value.ready) expect(value.value).toMatchObject({ pageviews: 1, visitors: 1, visits: 1 });
    for (let i = 0; i < 5; i++) expect((await read()).ready).toBe(true);
    expect((await read({ refresh: '1' })).ready).toBe(true);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_query WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(1);
  });
  it('invalidates an earlier publication when late qualified evidence changes the strong version', async () => {
    const first = await read();
    if (first.ready === true) throw new Error('fixture already published');
    await finish(first.analysisJob.id);
    expect(await read()).toMatchObject({ ready: true, value: { pageviews: 1, visitors: 1 } });
    await event('2026-01-01T01:02Z', true);
    const updated = await read();
    expect(updated.ready).toBe(false);
    expect(updated).not.toHaveProperty('previousResult');
    if (updated.ready === true) throw new Error('expected revised publication');
    expect(updated.analysisJob.id).not.toBe(first.analysisJob.id);
    await finish(updated.analysisJob.id);
    expect(await read()).toMatchObject({ ready: true, value: { pageviews: 2, visitors: 1 } });
  });
  it('retains qualified publication metrics while exposing missing identity observations', async () => {
    const first = await read();
    if (first.ready === true) throw new Error('expected cold fixture');
    await finish(first.analysisJob.id);
    await event('2026-01-01T01:04Z', false);
    await sql(
      "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '10 seconds' WHERE id=$1::uuid",
      first.analysisJob.id,
    );
    const refreshed = await read({ refresh: '1' });
    if (refreshed.ready === true) throw new Error('expected refreshed fixture');
    await finish(refreshed.analysisJob.id);
    const actual = await read();
    expect(actual).toMatchObject({ ready: true, value: { pageviews: 1, visitors: 1 } });
    if (actual.ready !== true) throw new Error('expected published fixture');
    expect(actual.value.population.identity).toMatchObject({
      status: 'partial',
      eligiblePV: 2,
      qualifiedPV: 1,
      qualifiedVisitors: 1,
    });
  });
  it('publishes newly collected current-day events on the next thirty-second window', async () => {
    const now = Date.now();
    const boundary = Math.floor(now / 30000) * 30000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const today = { ...p, endAt: now + 3600000 };
    const current = () =>
      withPublishedRegistry(() => requestDashboardSnapshot(site, actor, 'native:stats', today));
    const first = await current();
    if (first.ready === true) throw new Error('expected cold fixture');
    await finish(first.analysisJob.id);
    expect(await current()).toMatchObject({ ready: true, value: { pageviews: 1 } });
    await event(new Date(boundary).toISOString(), true);
    clock.mockReturnValue(now + 30000);
    const next = await current();
    expect(next).toMatchObject({ ready: true, snapshotState: 'updating', value: { pageviews: 1 } });
    const [producer] = await q(
      'SELECT job_id FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
      site,
    );
    expect(producer.job_id).toBeTruthy();
    await finish(producer.job_id);
    expect(await current()).toMatchObject({ ready: true, value: { pageviews: 2, visitors: 1 } });
  });
  it('reuses a captured retention window and corrects late facts before the next window gets a new key', async context => {
    const actualNow = Date.now(),
      boundary = (Math.floor(actualNow / 300000) + 1) * 300000,
      firstAt = boundary + 15000,
      secondAt = boundary + 85000;
    const currentMonth = new Date(actualNow);
    currentMonth.setUTCDate(1);
    currentMonth.setUTCHours(0, 0, 0, 0);
    const startAt = +currentMonth;
    currentMonth.setUTCMonth(currentMonth.getUTCMonth() + 1);
    const monthEnd = +currentMonth - 1;
    if (boundary <= startAt || boundary + 300000 >= monthEnd + 1) return context.skip();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(firstAt);
    const current = (endAt: number) =>
      withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'native:retention', {
          startAt,
          endAt,
          timezone: 'UTC',
        }),
      );
    const first = await current(firstAt);
    if (first.ready === true) throw new Error('expected cold retention');
    clock.mockReturnValue(secondAt);
    const joined = await current(secondAt);
    expect(joined.ready).toBe(false);
    if (joined.ready === false) expect(joined.analysisJob.id).toBe(first.analysisJob.id);
    const [initial] = await q(
      `SELECT d.parameters->>'endAt' AS selection,q.parameters->>'endAt' AS executed
       FROM liekan_dashboard_snapshot d JOIN liekan_analysis_query q ON q.id=d.job_id
       WHERE d.website_id=$1::uuid`,
      site,
    );
    expect(initial).toEqual({ selection: String(boundary - 1), executed: String(boundary - 1) });
    await finish(first.analysisJob.id);
    expect(await current(secondAt + 1000)).toMatchObject({
      ready: true,
      value: [],
      dataThrough: boundary,
    });
    expect(
      await q('SELECT query_key FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid', site),
    ).toHaveLength(1);
    expect(
      await q('SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid', site),
    ).toHaveLength(1);
    clock.mockReturnValue(firstAt + 300000);
    await sql(
      "UPDATE liekan_dashboard_snapshot SET next_refresh_at=clock_timestamp()-interval '1 second',last_read_at=$2 WHERE website_id=$1::uuid",
      site,
      new Date(firstAt + 300000),
    );
    await pumpDashboardSnapshots();
    const [stable] = await q(
      'SELECT data_through,job_id FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
      site,
    );
    expect(+new Date(stable.data_through)).toBe(boundary);
    expect(stable.job_id).toBeNull();
    expect(
      await q('SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid', site),
    ).toHaveLength(1);
    await event(new Date(boundary - 10000).toISOString());
    await sql(
      "UPDATE liekan_dashboard_snapshot SET next_refresh_at=clock_timestamp()-interval '1 second' WHERE website_id=$1::uuid",
      site,
    );
    await pumpDashboardSnapshots();
    const [correction] = await q(
      `SELECT d.job_id,d.pending_through,q.parameters->>'endAt' AS executed
       FROM liekan_dashboard_snapshot d JOIN liekan_analysis_query q ON q.id=d.job_id
       WHERE d.website_id=$1::uuid`,
      site,
    );
    expect(correction.job_id).not.toBe(first.analysisJob.id);
    expect(correction.executed).toBe(String(boundary - 1));
    expect(+new Date(correction.pending_through)).toBe(boundary);
    await finish(correction.job_id);
    expect(await current(boundary - 1)).toMatchObject({
      ready: true,
      value: [{ visitors: 1, returnVisitors: 1 }],
      dataThrough: boundary,
    });
    const next = await current(firstAt + 300000);
    expect(next.ready).toBe(false);
    if (next.ready === true) throw new Error('expected next retention window');
    const [advanced] = await q(
      "SELECT parameters->>'endAt' AS executed FROM liekan_analysis_query WHERE id=$1::uuid",
      next.analysisJob.id,
    );
    expect(advanced.executed).toBe(String(boundary + 300000 - 1));
    expect(
      await q('SELECT query_key FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid', site),
    ).toHaveLength(2);
    await finish(next.analysisJob.id);
  });
  it('keeps a retention task inside the captured window when registration crosses a cutoff', async context => {
    const actualNow = Date.now(),
      boundary = (Math.floor(actualNow / 300000) + 1) * 300000,
      enteredAt = boundary + 299000,
      registeredAt = boundary + 301000;
    const month = new Date(actualNow);
    month.setUTCDate(1);
    month.setUTCHours(0, 0, 0, 0);
    const startAt = +month;
    month.setUTCMonth(month.getUTCMonth() + 1);
    if (boundary <= startAt || registeredAt >= +month) return context.skip();
    const pending = await withPublishedRegistry(() => {
      vi.spyOn(Date, 'now').mockReturnValue(registeredAt).mockReturnValueOnce(enteredAt);
      return requestDashboardSnapshot(site, actor, 'native:retention', {
        startAt,
        endAt: enteredAt - 100,
        timezone: 'UTC',
      });
    });
    if (pending.ready === true) throw new Error('expected delayed cold retention');
    const [registered] = await q(
      `SELECT d.parameters->>'endAt' AS selected,d.pending_through,d.dependency_end,
       q.parameters->>'endAt' AS executed FROM liekan_dashboard_snapshot d
       JOIN liekan_analysis_query q ON q.id=d.job_id WHERE d.website_id=$1::uuid`,
      site,
    );
    expect(registered.selected).toBe(String(boundary - 1));
    expect(registered.executed).toBe(String(boundary - 1));
    expect(+new Date(registered.pending_through)).toBe(boundary);
    expect(+new Date(registered.dependency_end)).toBe(boundary);
    await finish(pending.analysisJob.id);
  });
  it('retains exact retention request clocks when dashboard acceleration is disabled', async () => {
    const at = Date.now(),
      month = new Date(at);
    month.setUTCDate(1);
    month.setUTCHours(0, 0, 0, 0);
    await sql("UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id=$1::uuid", site);
    const requested = await withPublishedRegistry(() =>
      requestDashboardSnapshot(site, actor, 'native:retention', {
        startAt: +month,
        endAt: at,
        timezone: 'UTC',
      }),
    );
    if (requested.ready === true) throw new Error('expected uncached retention');
    const [task] = await q(
      'SELECT parameters FROM liekan_analysis_query WHERE id=$1::uuid',
      requested.analysisJob.id,
    );
    expect(task.parameters.endAt).toBe(at);
    expect(
      await q('SELECT query_key FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid', site),
    ).toHaveLength(0);
  });
  it('recomputes an explicitly refreshed historical publication after late evidence invalidates the prior revision', async () => {
    const first = await read();
    if (first.ready === true) throw new Error('expected cold fixture');
    await finish(first.analysisJob.id);
    await event('2026-01-01T01:03Z', true);
    await sql(
      "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '10 seconds' WHERE id=$1::uuid",
      first.analysisJob.id,
    );
    const refreshed = await read({ refresh: '1' });
    if (refreshed.ready === true) throw new Error('expected explicit computation');
    expect(refreshed).not.toHaveProperty('previousResult');
    await finish(refreshed.analysisJob.id);
    expect(await read()).toMatchObject({ ready: true, value: { pageviews: 2 } });
  });
  it('reserves dashboard admission while foreground work shares priority above cold seed work', async () => {
    const heatmap = (device: string) =>
      withPublishedRegistry(() =>
        requestAnalysisQuery(site, actor, 'native:heatmaps', { ...p, device }),
      );
    await heatmap('eq.desktop');
    await heatmap('eq.mobile');
    await expect(heatmap('eq.tablet')).rejects.toMatchObject({ status: 429 });
    const dashboard = await read();
    expect(dashboard.ready).toBe(false);
    const send = vi.fn(async () => 'queue-fixture');
    await pumpAnalysisQueries({ send } as any);
    if (dashboard.ready === true) throw new Error('expected dashboard task');
    const priorities = send.mock.calls as any[];
    expect(priorities.find(call => call[1].id === dashboard.analysisJob.id)?.[2].priority).toBe(10);
    expect(
      priorities
        .filter(call => call[1].id !== dashboard.analysisJob.id)
        .every(call => call[2].priority === 10),
    ).toBe(true);
  });
  it('keeps maintenance reads out of recent foreground demand and assigns cold seed work low priority', async () => {
    const first = await withPublishedRegistry(() =>
      requestDashboardSnapshot(site, actor, 'native:stats', p, 'zh-CN', false),
    );
    if (first.ready === true) throw new Error('expected cold fixture');
    const [row] = await q(
      'SELECT last_read_at FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
      site,
    );
    expect(+new Date(row.last_read_at)).toBe(0);
    const send = vi.fn(async () => 'seed-queue-fixture');
    await pumpAnalysisQueries({ send } as any);
    expect(
      (send.mock.calls as any[]).find(call => call[1].id === first.analysisJob.id)?.[2].priority,
    ).toBe(0);
    await finish(first.analysisJob.id);
    await withPublishedRegistry(() =>
      requestDashboardSnapshot(site, actor, 'native:stats', p, 'zh-CN', false),
    );
    const [after] = await q(
      'SELECT last_read_at FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
      site,
    );
    expect(after.last_read_at).toEqual(row.last_read_at);
  });
  it('promotes a queued seed in the persisted queue when a foreground reader joins it', async () => {
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      schema: 'liekan_jobs',
      migrate: false,
      supervise: false,
      schedule: false,
      max: 2,
    });
    boss.on('error', () => {});
    await boss.start();
    let key: string;
    try {
      const seeded = await withPublishedRegistry(() =>
        requestDashboardSnapshot(site, actor, 'native:stats', p, 'zh-CN', false),
      );
      if (seeded.ready === true) throw new Error('expected cold seed');
      key = seeded.analysisJob.id;
      await pumpAnalysisQueries(boss);
      const before = await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key, queued: true });
      expect(before).toHaveLength(1);
      expect(before[0].priority).toBe(0);
      const demand = await read();
      if (demand.ready === true) throw new Error('expected joined producer');
      expect(demand.analysisJob.id).toBe(key);
      await pumpAnalysisQueries(boss);
      const after = await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key, queued: true });
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(before[0].id);
      expect(after[0].data).toEqual({ id: key });
      expect(after[0].priority).toBe(10);
      expect(after[0].retryLimit).toBe(10);
    } finally {
      if (key)
        for (const job of await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key }))
          await boss.deleteJob(ANALYSIS_QUERY_QUEUE, job.id);
      await boss.stop();
    }
  });
  it.each(['foreground', 'active-seed', 'native-heavy'] as const)(
    'redelivers a contended %s task without the outbox pump or a computation attempt',
    async kind => {
      const task = await (kind === 'active-seed'
        ? withPublishedRegistry(() =>
            requestDashboardSnapshot(site, actor, 'native:stats', p, 'zh-CN', false),
          )
        : kind === 'native-heavy'
          ? withPublishedRegistry(() =>
              requestAnalysisQuery(site, actor, 'native:metrics', { ...p, type: 'path' }),
            )
          : read());
      if (task.ready === true) throw new Error('expected cold fixture');
      const key = task.analysisJob.id;
      const boss = new PgBoss({
        connectionString: process.env.DATABASE_URL,
        schema: 'liekan_jobs',
        migrate: false,
        supervise: false,
        schedule: false,
        max: 2,
      });
      boss.on('error', () => {});
      await boss.start();
      try {
        await pumpAnalysisQueries(boss);
        await withBlockedLane(kind === 'native-heavy' ? 'interactive' : 'dashboard', async () => {
          const [delivery] = await boss.fetch<{ id: string }>(ANALYSIS_QUERY_QUEUE, {
            includeMetadata: true,
          });
          expect(delivery.data.id).toBe(key);
          if (kind === 'active-seed') {
            expect(delivery.priority).toBe(0);
            const joined = await read();
            expect(joined).toMatchObject({ ready: false, analysisJob: { id: key } });
          }
          expect(delivery.retryLimit).toBe(10);
          await expect(processAnalysisQueryDelivery(delivery, boss)).resolves.toBeUndefined();
          expect(await boss.complete(ANALYSIS_QUERY_QUEUE, delivery)).toMatchObject({
            affected: 0,
          });
          const [waiting] = await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key, queued: true });
          expect(waiting).toMatchObject({ state: 'retry', priority: 0, retryLimit: 10 });
          // A stale settlement preserves a later foreground promotion of the waiting delivery.
          await boss.update(ANALYSIS_QUERY_QUEUE, undefined, { id: delivery.id, priority: 10 });
          await processAnalysisQueryDelivery(delivery, boss);
          const [promoted] = await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key, queued: true });
          expect(promoted).toMatchObject({ state: 'retry', priority: 10, retryCount: 0 });
          const [queued] = await q(
            'SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid',
            key,
          );
          expect(queued).toEqual({ status: 'queued', attempts: 0 });
        });
        let redelivery: any;
        await vi.waitFor(
          async () => {
            [redelivery] = await boss.fetch<{ id: string }>(ANALYSIS_QUERY_QUEUE, {
              includeMetadata: true,
            });
            expect(redelivery).toBeDefined();
          },
          { timeout: 3000, interval: 100 },
        );
        expect(redelivery.retryCount).toBe(1);
        await processAnalysisQueryDelivery(redelivery, boss);
        await boss.complete(ANALYSIS_QUERY_QUEUE, redelivery);
        expect(
          (await q('SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid', key))[0],
        ).toEqual({ status: 'ready', attempts: 1 });
      } finally {
        for (const job of await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key }))
          await boss.deleteJob(ANALYSIS_QUERY_QUEUE, job.id);
        await boss.stop();
      }
    },
  );
  it.each([
    { heldLane: 'dashboard', blockedTarget: 'native:stats', openTarget: 'native:metrics' },
    { heldLane: 'interactive', blockedTarget: 'native:metrics', openTarget: 'native:stats' },
  ] as const)(
    'runs $openTarget while earlier deliveries wait for the $heldLane permit',
    async ({ heldLane, blockedTarget, openTarget }) => {
      const readers = [actor, { id: randomUUID(), role: 'admin' }];
      const taskIds: string[] = [];
      const delivered: string[] = [];
      const boss = new PgBoss({
        connectionString: process.env.DATABASE_URL,
        schema: 'liekan_jobs',
        migrate: false,
        supervise: false,
        schedule: false,
        max: 2,
      });
      boss.on('error', () => {});
      await boss.start();
      try {
        for (const reader of readers.slice(1))
          await sql(
            `INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$2,'synthetic','admin')`,
            reader.id,
            `snapshot-fairness-${reader.id}`,
          );
        for (const [index, reader] of readers.entries())
          for (let offset = 0; offset < 2; offset++) {
            const live = await withPublishedRegistry(() =>
              requestAnalysisQuery(site, reader, blockedTarget, {
                ...p,
                startAt: p.startAt + (index * 2 + offset) * 60000,
                ...(blockedTarget === 'native:metrics' ? { type: 'path' } : {}),
              }),
            );
            if (live.ready === true) throw new Error('expected cold live fairness task');
            taskIds.push(live.analysisJob.id);
          }
        const heavy = await withPublishedRegistry(() =>
          requestAnalysisQuery(site, actor, openTarget, {
            ...p,
            ...(openTarget === 'native:metrics' ? { type: 'path' } : {}),
          }),
        );
        if (heavy.ready === true) throw new Error('expected cold heavy fairness task');
        taskIds.push(heavy.analysisJob.id);
        await pumpAnalysisQueries(boss);
        const held = await withBlockedLane(heldLane, async () => {
          await boss.work<{ id: string }>(
            ANALYSIS_QUERY_QUEUE,
            { localConcurrency: 2, batchSize: 1, pollingIntervalSeconds: 1 },
            async jobs => {
              for (const job of jobs) {
                delivered.push(job.data.id);
                await processAnalysisQueryDelivery(job, boss);
              }
            },
          );
          try {
            await vi.waitFor(
              async () => {
                const [row] = await q(
                  'SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid',
                  heavy.analysisJob.id,
                );
                expect({ ...row, delivered: delivered.includes(heavy.analysisJob.id) }).toEqual({
                  status: 'ready',
                  attempts: 1,
                  delivered: true,
                });
              },
              { timeout: 3000, interval: 100 },
            );
          } catch (cause) {
            const [row] = await q(
              'SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid',
              heavy.analysisJob.id,
            );
            throw new Error(
              `Foreground heavy fairness: ${JSON.stringify({ ...row, deliveries: delivered.length, heavyDelivered: delivered.includes(heavy.analysisJob.id) })}`,
              { cause },
            );
          }
          expect(
            await q(
              'SELECT attempts FROM liekan_analysis_query WHERE id=ANY($1::uuid[])',
              taskIds.slice(0, -1),
            ),
          ).toEqual(Array.from({ length: 4 }, () => ({ attempts: 0 })));
        });
        expect(held.acquired).toBe(true);
      } finally {
        await boss.offWork(ANALYSIS_QUERY_QUEUE);
        for (const key of taskIds)
          for (const job of await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key }))
            await boss.deleteJob(ANALYSIS_QUERY_QUEUE, job.id);
        await boss.stop();
        await sql('DELETE FROM liekan_analysis_query WHERE id=ANY($1::uuid[])', taskIds);
        for (const reader of readers.slice(1))
          await sql('DELETE FROM "user" WHERE user_id=$1::uuid', reader.id);
      }
    },
  );
  it('rejects a stale candidate when qualified evidence changes before execution', async () => {
    const first = await read();
    if (first.ready === true) throw new Error('fixture already published');
    await event('2026-01-01T01:03Z', true);
    await expect(finish(first.analysisJob.id)).rejects.toMatchObject({ status: 410 });
    const current = await read();
    if (current.ready === true) throw new Error('expected current revision task');
    expect(current.analysisJob.id).not.toBe(first.analysisJob.id);
    await finish(current.analysisJob.id);
    expect(await read()).toMatchObject({ ready: true, value: { pageviews: 2, visitors: 1 } });
  });
  it('checks current website authority before returning a durable result', async () => {
    const first = await read();
    if (first.ready === true) throw new Error('fixture already published');
    await finish(first.analysisJob.id);
    await sql('UPDATE website SET deleted_at=clock_timestamp() WHERE website_id=$1::uuid', site);
    await expect(read()).rejects.toMatchObject({ status: 404 });
  });
  it('keeps events after a closed cutoff out of its publication fence', async () => {
    const pin = async () =>
      (
        await q(
          "SELECT liekan_dashboard_fingerprint(website_id,epoch,'2026-01-01T01:05:00Z') AS fingerprint FROM liekan_analysis_site WHERE website_id=$1::uuid",
          site,
        )
      )[0].fingerprint;
    const before = await pin();
    await event('2026-01-01T01:06Z', false);
    expect(await pin()).toBe(before);
    await event('2026-01-01T01:04Z', false);
    expect(await pin()).not.toBe(before);
  });
  it('fences events, detail and logs at a cutoff inside a five-minute rollup bucket', async () => {
    const pin = async () =>
      (
        await q(
          "SELECT liekan_dashboard_fingerprint(website_id,epoch,'2026-01-01T01:05:30Z') AS fingerprint FROM liekan_analysis_site WHERE website_id=$1::uuid",
          site,
        )
      )[0].fingerprint;
    let before = await pin();
    await event('2026-01-01T01:05:31Z', false);
    expect(await pin()).toBe(before);
    await event('2026-01-01T01:05:29Z', false);
    expect(await pin()).not.toBe(before);
    const imported = randomUUID();
    await sql(
      'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$3,2,0)',
      imported,
      site,
      randomUUID(),
    );
    const log = (at: string, id = randomUUID()) =>
      sql(
        `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification)
      VALUES($1,$2::uuid,$3::uuid,$4,'/synthetic','GET',200,10,'','synthetic','Synthetic fixture','','','','','unknown')`,
        id,
        site,
        imported,
        new Date(at),
      );
    before = await pin();
    await log('2026-01-01T01:05:31Z');
    expect(await pin()).toBe(before);
    const late = randomUUID();
    await log('2026-01-01T01:05:29Z', late);
    expect(await pin()).not.toBe(before);
    for (const statement of [
      "INSERT INTO liekan_crawler_evidence(website_id,log_id,crawler_id,classification_version) VALUES($1::uuid,$2,'gptbot','synthetic')",
      "UPDATE liekan_crawler_evidence SET crawler_id='claudebot' WHERE website_id=$1::uuid AND log_id=$2",
      'DELETE FROM liekan_crawler_evidence WHERE website_id=$1::uuid AND log_id=$2',
      'UPDATE liekan_log SET status=201 WHERE website_id=$1::uuid AND id=$2',
      'DELETE FROM liekan_log WHERE website_id=$1::uuid AND id=$2',
    ]) {
      before = await pin();
      await sql(statement, site, late);
      expect(await pin()).not.toBe(before);
    }
    before = await pin();
    await sql("SELECT liekan_analysis_invalidate($1::uuid,'log')", site);
    expect(await pin()).not.toBe(before);
    const detail = (at: string) =>
      sql(
        `INSERT INTO heatmap_event(heatmap_event_id,website_id,session_id,visit_id,url_path,event_type,x,y,created_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,'/synthetic-snapshot',1,10,20,$4)`,
        randomUUID(),
        site,
        session,
        new Date(at),
      );
    before = await pin();
    await detail('2026-01-01T01:05:31Z');
    expect(await pin()).toBe(before);
    await detail('2026-01-01T01:05:29Z');
    expect(await pin()).not.toBe(before);
  });
  it('fences earlier heatmap facts when a later event changes their visit eligibility', async () => {
    const visit = randomUUID();
    const cutoff = new Date(Math.floor(Date.now() / 30000) * 30000);
    const at = (offset: number) => new Date(+cutoff + offset).toISOString();
    const pin = async () =>
      (
        await q(
          'SELECT liekan_dashboard_fingerprint(website_id,epoch,$2::timestamptz) AS fingerprint FROM liekan_analysis_site WHERE website_id=$1::uuid',
          site,
          new Date(cutoff),
        )
      )[0].fingerprint;
    const eligible = async () =>
      (
        await q(
          'SELECT count(*)::int AS count FROM liekan_effective_heatmap_event WHERE website_id=$1::uuid AND visit_id=$2::uuid AND created_at<$3',
          site,
          visit,
          new Date(cutoff),
        )
      )[0].count;
    await sql(
      `INSERT INTO heatmap_event(heatmap_event_id,website_id,session_id,visit_id,url_path,event_type,x,y,created_at)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'/synthetic-early-heatmap',1,10,20,$5)`,
      randomUUID(),
      site,
      session,
      visit,
      new Date(at(-10000)),
    );
    let before = await pin();
    await event(at(1000), true, randomUUID());
    expect(await eligible()).toBe(0);
    expect(await pin()).toBe(before);
    await event(at(1000), true, visit);
    expect(await eligible()).toBe(1);
    expect(await pin()).not.toBe(before);
    before = await pin();
    await event(at(2000), true, visit);
    expect(await pin()).toBe(before);
    for (const classification of ['automated', 'browser']) {
      before = await pin();
      await sql(
        `UPDATE liekan_event_quality SET classification=$3 WHERE website_id=$1::uuid AND event_id IN
         (SELECT event_id FROM website_event WHERE website_id=$1::uuid AND visit_id=$2::uuid)`,
        site,
        visit,
        classification,
      );
      expect(await eligible()).toBe(classification === 'browser' ? 1 : 0);
      expect(await pin()).not.toBe(before);
    }
    before = await pin();
    await sql(
      'DELETE FROM website_event WHERE website_id=$1::uuid AND visit_id=$2::uuid',
      site,
      visit,
    );
    expect(await eligible()).toBe(0);
    expect(await pin()).not.toBe(before);
  });
  it.each([false, true])(
    'fences upgraded session identities with environment-first %s and stable subsequent collection',
    async environmentFirst => {
      const cutoff = new Date(Math.floor(Date.now() / 30000) * 30000);
      const at = (offset: number) => new Date(+cutoff + offset).toISOString();
      // Keep this visit inside the fine tail independently of the baseline's January visit.
      session = randomUUID();
      await sql(
        'INSERT INTO session(session_id,website_id,created_at) VALUES($1::uuid,$2::uuid,$3)',
        session,
        site,
        new Date(at(-10000)),
      );
      await event(at(-10000), true);
      const pin = async () =>
        (
          await q(
            'SELECT liekan_dashboard_fingerprint(website_id,epoch,$2::timestamptz) AS fingerprint FROM liekan_analysis_site WHERE website_id=$1::uuid',
            site,
            cutoff,
          )
        )[0].fingerprint;
      const matching = async () =>
        (
          await q(
            `SELECT count(*)::int AS count FROM liekan_effective_website_event e JOIN liekan_effective_session s
       ON s.website_id=e.website_id AND s.session_id=e.session_id
       WHERE e.website_id=$1::uuid AND e.created_at>=$2 AND e.created_at<$3 AND s.distinct_id='synthetic-identity'`,
            site,
            new Date(at(-15000)),
            cutoff,
          )
        )[0].count;
      const revision = async () =>
        (
          await q(
            "SELECT revision FROM liekan_analytics_revision WHERE resource_type='website' AND resource_id=$1::uuid",
            site,
          )
        )[0].revision;
      const strong = await revision();
      const before = await pin();
      expect(await matching()).toBe(0);
      await event(at(1000), true, session, 'synthetic-identity', environmentFirst);
      expect(await matching()).toBe(1);
      expect(await revision()).toBe(strong);
      expect(await pin()).not.toBe(before);
      const corrected = await pin();
      await event(at(2000), true, session, 'synthetic-identity', environmentFirst);
      expect(await matching()).toBe(1);
      expect(await revision()).toBe(strong);
      expect(await pin()).toBe(corrected);
    },
  );
  it('keeps rejected admissions atomic without accumulating empty snapshot rows', async () => {
    await read();
    await read({ endAt: p.endAt - 1000 });
    await expect(read({ endAt: p.endAt - 2000 })).rejects.toMatchObject({ status: 429 });
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(2);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_query WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(2);
  });
  it('tracks independently collected heatmap changes for historical correction', async () => {
    const pin = async () =>
      (
        await q(
          "SELECT liekan_dashboard_fingerprint(website_id,epoch,'2026-01-02') AS fingerprint FROM liekan_analysis_site WHERE website_id=$1::uuid",
          site,
        )
      )[0].fingerprint;
    const before = await pin();
    await sql(
      `INSERT INTO heatmap_event(heatmap_event_id,website_id,session_id,visit_id,url_path,event_type,x,y,created_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,'/synthetic-snapshot',1,10,20,'2026-01-01T01:02Z')`,
      randomUUID(),
      site,
      session,
    );
    expect(await pin()).not.toBe(before);
  });
  it('reserves every linked snapshot copy before publishing and preserves the prior generation on capacity failure', async () => {
    const first = await read();
    if (first.ready === true) throw new Error('fixture already published');
    await finish(first.analysisJob.id);
    const [job] = await q(
      'SELECT * FROM liekan_analysis_query WHERE id=$1::uuid',
      first.analysisJob.id,
    );
    await sql(
      `INSERT INTO liekan_dashboard_snapshot(website_id,query_key,actor_id,target,parameters,locale,strong_version,epoch,calendar_day,dependency_end,job_id,pending_fingerprint,pending_through)
      SELECT website_id,query_key||'-alias',actor_id,target,parameters,locale,strong_version,epoch,calendar_day,dependency_end,$2::uuid,fingerprint,data_through
      FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid`,
      site,
      job.id,
    );
    await sql(
      'UPDATE liekan_dashboard_snapshot SET job_id=$2::uuid,pending_fingerprint=fingerprint,pending_through=data_through WHERE website_id=$1::uuid AND result IS NOT NULL',
      site,
      job.id,
    );
    await analysisTransaction(async tx => {
      const capacity = await analysisCapacity(tx, site);
      await tx.$executeRawUnsafe(
        'UPDATE liekan_analysis_site SET derived_bytes=derived_bytes+$2::bigint WHERE website_id=$1::uuid',
        site,
        String(BigInt(capacity.siteLimit) - BigInt(capacity.siteBytes) - BigInt(job.result_bytes)),
      );
    });
    await expect(
      analysisTransaction(tx => publishDashboardSnapshot(tx, job)),
    ).rejects.toMatchObject({ status: 413, code: 'analysis-capacity-limited' });
    const [published] = await q(
      'SELECT count(*)::int AS n FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid AND result IS NOT NULL',
      site,
    );
    expect(published.n).toBe(1);
    expect(await read()).toMatchObject({ ready: true, value: { pageviews: 1 } });
  });
  it('keeps foreground authority available during retained-history boundary reads', async () => {
    const transaction = rollupDatabase.analysisTransaction;
    const observer = new Client({ connectionString: process.env.DATABASE_URL });
    await observer.connect();
    const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
    let inspected = false;
    vi.spyOn(rollupDatabase, 'analysisTransaction').mockImplementation((work, isolation) =>
      transaction(
        tx =>
          work(
            new Proxy(tx, {
              get(target, property) {
                if (property !== '$queryRawUnsafe') return Reflect.get(target, property);
                return async (statement: string, ...values: unknown[]) => {
                  if (statement.includes('SELECT min(at) AS starts,max(at) AS ends')) {
                    inspected = true;
                    await observer.query('BEGIN');
                    try {
                      await observer.query(`SET LOCAL search_path TO "${schema}"`);
                      const authority = await observer.query(
                        'SELECT website_id FROM liekan_analysis_site WHERE website_id=$1::uuid FOR SHARE NOWAIT',
                        [site],
                      );
                      expect(authority.rowCount).toBe(1);
                    } finally {
                      await observer.query('ROLLBACK');
                    }
                  }
                  return target.$queryRawUnsafe(statement, ...values);
                };
              },
            }),
          ),
        isolation,
      ),
    );
    try {
      await bootstrapAnalysisHistory(Date.now(), site);
      expect(inspected).toBe(true);
      expect(
        await q('SELECT id FROM liekan_analysis_build WHERE website_id=$1::uuid', site),
      ).toHaveLength(1);
    } finally {
      await observer.end();
    }
  });
  it.each(['epoch', 'mode', 'deleted'])(
    'rechecks %s after an unlocked retained-history boundary read',
    async change => {
      const transaction = rollupDatabase.analysisTransaction;
      let changed = false;
      const spy = vi
        .spyOn(rollupDatabase, 'analysisTransaction')
        .mockImplementation((work, isolation) =>
          transaction(
            tx =>
              work(
                new Proxy(tx, {
                  get(target, property) {
                    if (property !== '$queryRawUnsafe') return Reflect.get(target, property);
                    return async (statement: string, ...values: unknown[]) => {
                      const rows = await target.$queryRawUnsafe(statement, ...values);
                      if (
                        !changed &&
                        statement.includes('SELECT min(at) AS starts,max(at) AS ends')
                      ) {
                        changed = true;
                        if (change === 'epoch')
                          await sql(
                            'UPDATE liekan_analysis_site SET epoch=epoch+1 WHERE website_id=$1::uuid',
                            site,
                          );
                        else if (change === 'mode')
                          await sql(
                            "UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id=$1::uuid",
                            site,
                          );
                        else
                          await sql(
                            'UPDATE website SET deleted_at=clock_timestamp() WHERE website_id=$1::uuid',
                            site,
                          );
                      }
                      return rows;
                    };
                  },
                }),
              ),
            isolation,
          ),
        );
      await bootstrapAnalysisHistory(Date.now(), site);
      expect(changed).toBe(true);
      expect(
        await q('SELECT id FROM liekan_analysis_build WHERE website_id=$1::uuid', site),
      ).toHaveLength(0);
      expect(
        (
          await q('SELECT archive_epoch FROM liekan_analysis_site WHERE website_id=$1::uuid', site)
        )[0].archive_epoch,
      ).toBeNull();
      spy.mockRestore();
      if (change === 'epoch') {
        await bootstrapAnalysisHistory(Date.now(), site);
        expect(
          (
            await q(
              'SELECT epoch,archive_epoch FROM liekan_analysis_site WHERE website_id=$1::uuid',
              site,
            )
          )[0],
        ).toMatchObject({ epoch: 2n, archive_epoch: 2n });
        expect(
          await q('SELECT id FROM liekan_analysis_build WHERE website_id=$1::uuid', site),
        ).toHaveLength(1);
      }
    },
  );
  it('automatically registers the retained history once per site epoch', async () => {
    await bootstrapAnalysisHistory(Date.now(), site);
    const [state] = await q(
      'SELECT archive_epoch=epoch AS bootstrapped FROM liekan_analysis_site WHERE website_id=$1::uuid',
      site,
    );
    expect(state.bootstrapped).toBe(true);
    const rows = await q(
      'SELECT range_start,range_end,actor_id,status FROM liekan_analysis_build WHERE website_id=$1::uuid',
      site,
    );
    expect(rows).toHaveLength(1);
    expect(+rows[0].range_start).toBe(+new Date('2026-01-01T01:00Z'));
    expect(rows[0]).toMatchObject({ actor_id: null, status: 'queued' });
    await bootstrapAnalysisHistory(Date.now(), site);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_build WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(1);
  });
  it('retains an open imported hour until it closes, then automatically schedules it', async () => {
    await sql('DELETE FROM website_event WHERE website_id=$1::uuid', site);
    const at = new Date(Math.floor(Date.now() / 3600000) * 3600000 + 1000);
    await event(at.toISOString(), false);
    await bootstrapAnalysisHistory(+at + 60000, site);
    let [state] = await q(
      'SELECT archive_complete,archive_build_id FROM liekan_analysis_site WHERE website_id=$1::uuid',
      site,
    );
    expect(state).toEqual({ archive_complete: false, archive_build_id: null });
    await bootstrapAnalysisHistory(+at + 3600000 + 60000, site);
    [state] = await q(
      'SELECT archive_complete,archive_build_id FROM liekan_analysis_site WHERE website_id=$1::uuid',
      site,
    );
    expect(state.archive_build_id).toEqual(expect.any(String));
    const [build] = await q(
      'SELECT automatic_history FROM liekan_analysis_build WHERE id=$1::uuid',
      state.archive_build_id,
    );
    expect(build.automatic_history).toBe(true);
    await sql(
      "UPDATE liekan_analysis_build SET status='failed',next_attempt_at=clock_timestamp()-interval '1 second',attempts=4 WHERE id=$1::uuid",
      state.archive_build_id,
    );
    await bootstrapAnalysisHistory(Date.now(), site);
    expect(
      (
        await q(
          'SELECT status,attempts FROM liekan_analysis_build WHERE id=$1::uuid',
          state.archive_build_id,
        )
      )[0],
    ).toEqual({ status: 'queued', attempts: 0 });
  });
});
