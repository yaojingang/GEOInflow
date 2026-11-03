// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { analysisTransaction } from './analysis-rollups-db';
import { withPublishedRegistry } from './crawler-registry-context';
import { withAnalysisPermit } from './analysis-background';
import {
  processAnalysisQuery,
  pumpAnalysisQueries,
  readAnalysisQuery,
  requestAnalysisQuery,
  dispatchAnalysisQuery,
  processAnalysisQueryDelivery,
} from './analysis-queries';
import {
  ANALYSIS_QUERY_QUEUE,
  analysisDigest,
  decodeAnalysisEnvelope,
} from './analysis-query-model';
import {
  pumpDashboardSnapshots,
  requestDashboardSnapshot,
  seedDashboardSnapshots,
} from './dashboard-snapshots';
import { DASHBOARD_INTERVAL, dashboardWarmRanges } from './dashboard-snapshot-model';
import { currentCacheContext } from './cache-context';
import { timedAnalyticsClient } from './analytics-deadline';
import { coldDashboardPrewarmSql } from './dashboard-demand';
import {
  withAnalysisViewer,
  releaseAnalysisViewer,
  registerAnalysisViewer,
  analysisJobDemandSql,
} from './analysis-viewers';
import { canReadFirstPage } from './analysis-page-admission';
import { pageReportParts } from '../contracts/page-report';
import { lockWritableWebsite } from './server';
import { processAnalysisBuild, pumpAnalysisBuilds } from './analysis-build-queue';

const withBlockedLane = (
  kind: Parameters<typeof withAnalysisPermit>[0],
  work: () => Promise<unknown>,
) =>
  withAnalysisPermit(kind, async () => {
    if (kind === 'dashboard') await withAnalysisPermit(kind, work);
    else await work();
  });
const enabled = process.env.LIEKAN_ANALYSIS_ROLLUPS_TEST === '1';
const actors = [0, 1].map(() => ({ id: randomUUID(), role: 'user' }));
const sites: string[] = [];
let site: string, otherSite: string;
const q = <T = any[]>(text: string, ...values: unknown[]) =>
  analysisTransaction(tx => tx.$queryRawUnsafe<T>(text, ...values));
const sql = (text: string, ...values: unknown[]) =>
  analysisTransaction(tx => tx.$executeRawUnsafe(text, ...values));
const parameters = (resource = 'overview') => ({
  ...dashboardWarmRanges('Asia/Shanghai')[0],
  ...(resource.startsWith('ai/') ? { crawlerMetricsVersion: 1 } : {}),
  resource,
  chartPeriod: 'today',
  timezone: 'Asia/Shanghai',
});
const nativeParameters = () => ({
  ...dashboardWarmRanges('Asia/Shanghai')[0],
  timezone: 'Asia/Shanghai',
});
const read = (foreground = true, targetSite = site, resource = 'overview', actor = actors[0]) =>
  withPublishedRegistry(() =>
    requestDashboardSnapshot(
      targetSite,
      actor,
      'feature:page-report',
      parameters(resource),
      'zh-CN',
      foreground,
    ),
  );
const coldCount = async () =>
  (
    await q(
      `SELECT count(*)::int AS n FROM liekan_analysis_query q WHERE q.status IN('queued','running') AND ${coldDashboardPrewarmSql}`,
    )
  )[0].n;
async function finish(id: string) {
  const result = await processAnalysisQuery(id);
  expect(result.acquired).toBe(true);
  expect(result.value).toBeUndefined();
  expect(
    (await q('SELECT status FROM liekan_analysis_query WHERE id=$1::uuid', id))[0].status,
  ).toBe('ready');
}
async function withSharedAuthority<T>(work: () => Promise<T>) {
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve)),
    acquired = new Promise<void>(resolve => (locked = resolve));
  const holder = analysisTransaction(async tx => {
    await lockWritableWebsite(tx, site, { userId: actors[0].id }, 'share');
    await tx.$queryRawUnsafe(
      'SELECT epoch,mode FROM liekan_analysis_site WHERE website_id=$1::uuid FOR SHARE',
      site,
    );
    locked();
    await gate;
  });
  await acquired;
  try {
    return await work();
  } finally {
    release();
    await holder;
  }
}
async function withDeliveryQueue<T>(key: string, work: (boss: PgBoss) => Promise<T>) {
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
    return await work(boss);
  } finally {
    for (const job of await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key }))
      await boss.deleteJob(ANALYSIS_QUERY_QUEUE, job.id);
    await boss.stop();
  }
}
async function pendingBuild(kind: 'incremental' | 'history', targetSite = site) {
  const id = randomUUID();
  await sql("UPDATE liekan_analysis_site SET mode='live' WHERE website_id=$1::uuid", targetSite);
  await sql(
    `INSERT INTO liekan_analysis_build(id,website_id,actor_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total,updated_at,created_at)
     SELECT $1::uuid,website_id,$3::uuid,epoch,'log',300,'2026-01-01','2026-01-01T00:05Z','UTC','en-US',$1::uuid,'synthetic-waiting-build','queued',1,
       clock_timestamp()-interval '40 seconds',clock_timestamp()-interval '40 seconds'
     FROM liekan_analysis_site WHERE website_id=$2::uuid`,
    id,
    targetSite,
    kind === 'incremental' ? null : actors[targetSite === otherSite ? 1 : 0].id,
  );
  return id;
}
describe.skipIf(!enabled)('ordinary dashboard demand scheduling in owned PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '15462' ||
      url.pathname !== '/liekan_analysis_rollups_test' ||
      !/^analysis_[a-f0-9]+$/.test(url.searchParams.get('schema') || '')
    )
      throw new Error('Owned scheduling fixture database required');
    for (const actor of actors)
      await sql(
        "INSERT INTO \"user\"(user_id,username,password,role) VALUES($1::uuid,$2,'fixture','user')",
        actor.id,
        `scheduling-${actor.id}`,
      );
  });
  beforeEach(async () => {
    for (const id of sites) await sql('DELETE FROM website WHERE website_id=$1::uuid', id);
    sites.length = 0;
    for (const actor of actors) {
      const id = randomUUID();
      sites.push(id);
      await sql(
        "INSERT INTO website(website_id,user_id,name,domain) VALUES($1::uuid,$2::uuid,'Synthetic scheduling','scheduling.invalid')",
        id,
        actor.id,
      );
    }
    [site, otherSite] = sites;
    await sql("UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id<>$1::uuid", site);
    await sql(
      'UPDATE liekan_analysis_background_lease SET token=NULL,lease_until=NULL,incremental_waiting_at=NULL,history_waiting_at=NULL,interactive_turns=0 WHERE id',
    );
    await sql('UPDATE liekan_analysis_dashboard_lease SET token=NULL,lease_until=NULL WHERE id');
    await sql('UPDATE liekan_analysis_read_lease SET token=NULL,lease_until=NULL');
    const execution = await import('./analysis-query-execution');
    vi.spyOn(execution, 'executeAnalysisQuery').mockResolvedValue({ pageviews: 1 });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    for (const id of sites) await sql('DELETE FROM website WHERE website_id=$1::uuid', id);
    for (const actor of actors) await sql('DELETE FROM "user" WHERE user_id=$1::uuid', actor.id);
  });
  it('keeps an opaque HTTP 200 refresh alive for its bounded dashboard demand window', async () => {
    const first = await read(true, site, 'ai/pages');
    if (first.ready) throw new Error('expected cold publication');
    await finish(first.analysisJob.id);
    await sql(
      "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '10 seconds' WHERE id=$1::uuid",
      first.analysisJob.id,
    );
    await sql(
      'UPDATE liekan_dashboard_snapshot SET fingerprint=NULL,data_through=to_timestamp(0) WHERE website_id=$1::uuid',
      site,
    );
    const maintenance = await import('./crawler-maintenance'),
      server = await import('./server'),
      queue = await import('../log-ingestion/queue');
    vi.spyOn(maintenance, 'authenticateCrawlerMaintenance').mockResolvedValue(actors[0]);
    vi.spyOn(server, 'authorize').mockResolvedValue({
      website: { id: site },
      canManage: true,
    } as any);
    const boss = {
      send: vi.fn(async () => randomUUID()),
      update: vi.fn(async () => ({ jobs: [], updated: 0 })),
    };
    vi.spyOn(queue, 'getQueue').mockResolvedValue(boss as any);
    const { asyncAnalysisResponse } = await import('./analysis-query-api');
    const viewer = randomUUID();
    await withBlockedLane('dashboard', async () => {
      const response = await withPublishedRegistry(() =>
        asyncAnalysisResponse(
          new Request(
            `http://fixture.invalid/api/liekan/websites/${site}/page-report?${new URLSearchParams(Object.entries(parameters('ai/pages')).map(([key, value]) => [key, String(value)]))}`,
            { headers: { Prefer: 'respond-async', 'X-Liekan-View': viewer } },
          ),
          site,
          'feature:page-report',
        ),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).pageviews).toBe(1);
      const [refresh] = await q(
        "SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid AND status='queued'",
        site,
      );
      expect(refresh).toBeDefined();
      await sql(
        "UPDATE liekan_analysis_query_viewer SET lease_until=lease_until-interval '20 seconds' WHERE job_id=$1::uuid AND viewer_id=$2::uuid",
        refresh.id,
        viewer,
      );
      await pumpAnalysisQueries(boss);
      expect(
        (
          await q(
            'SELECT status,error_code FROM liekan_analysis_query WHERE id=$1::uuid',
            refresh.id,
          )
        )[0],
      ).toEqual({ status: 'queued', error_code: null });
      const [lease] = await q(
        'SELECT c.managed,v.lease_until>clock_timestamp() AS active FROM liekan_analysis_query_consumer c JOIN liekan_analysis_query_viewer v USING(job_id,actor_id) WHERE c.job_id=$1::uuid AND v.viewer_id=$2::uuid',
        refresh.id,
        viewer,
      );
      expect(lease).toEqual({ managed: true, active: true });
      await sql(
        "UPDATE liekan_analysis_query_viewer SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id=$1::uuid",
        refresh.id,
      );
      await pumpAnalysisQueries(boss);
      expect(
        (
          await q(
            'SELECT status,error_code FROM liekan_analysis_query WHERE id=$1::uuid',
            refresh.id,
          )
        )[0],
      ).toEqual({ status: 'failed', error_code: 'analysis-idle' });
    });
  });
  it('shares a producer while each tab owns a separately releasable viewer lease', async () => {
    const firstView = randomUUID(),
      secondView = randomUUID();
    const first = await withAnalysisViewer(firstView, () => read());
    const second = await withAnalysisViewer(secondView, () => read());
    if (first.ready || second.ready) throw new Error('expected cold producer');
    expect(first.analysisJob.id).toBe(second.analysisJob.id);
    await withAnalysisViewer(firstView, () =>
      releaseAnalysisViewer(site, actors[0], first.analysisJob.id),
    );
    expect(
      (
        await q('SELECT status FROM liekan_analysis_query WHERE id=$1::uuid', first.analysisJob.id)
      )[0].status,
    ).toBe('queued');
    await withAnalysisViewer(secondView, () =>
      withPublishedRegistry(() => readAnalysisQuery(site, actors[0], first.analysisJob.id)),
    );
    await expect(
      withAnalysisViewer(firstView, () =>
        withPublishedRegistry(() => readAnalysisQuery(site, actors[0], first.analysisJob.id)),
      ),
    ).rejects.toMatchObject({ code: 'analysis-idle' });
    await withAnalysisViewer(secondView, () =>
      releaseAnalysisViewer(site, actors[0], first.analysisJob.id),
    );
    expect(
      (
        await q(
          'SELECT status,error_code FROM liekan_analysis_query WHERE id=$1::uuid',
          first.analysisJob.id,
        )
      )[0],
    ).toEqual({ status: 'failed', error_code: 'analysis-idle' });
    expect((await withAnalysisViewer(randomUUID(), () => read())).ready).toBe(false);
  });
  it.each(['release', 'pump'] as const)(
    'preserves a concurrent joining viewer during %s and reproduces the old snapshot race',
    async method => {
      for (const legacy of [true, false]) {
        const view = randomUUID(),
          joiningView = randomUUID();
        const task = await withAnalysisViewer(view, () =>
          read(true, site, legacy ? 'overview' : 'ai/pages'),
        );
        if (task.ready) throw new Error('expected cold producer');
        const id = task.analysisJob.id;
        if (method === 'pump')
          await sql(
            "UPDATE liekan_analysis_query_viewer SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id=$1::uuid",
            id,
          );
        let joined!: () => void, resume!: () => void;
        const entered = new Promise<void>(resolve => (joined = resolve)),
          gate = new Promise<void>(resolve => (resume = resolve));
        const joining = analysisTransaction(tx =>
          withAnalysisViewer(joiningView, async () => {
            await registerAnalysisViewer(tx, id, actors[0].id);
            if (legacy)
              await tx.$queryRawUnsafe(
                'SELECT id FROM liekan_analysis_query WHERE id=$1::uuid FOR SHARE',
                id,
              );
            joined();
            await gate;
          }),
        );
        await entered;
        let settled = false,
          blocked = false;
        const cancellation = (
          legacy
            ? analysisTransaction(async tx => {
                // Execute the previous cancellation statement to establish a real Read Committed regression oracle.
                if (method === 'release')
                  await tx.$executeRawUnsafe(
                    'UPDATE liekan_analysis_query_viewer SET lease_until=clock_timestamp() WHERE job_id=$1::uuid AND viewer_id=$2::uuid',
                    id,
                    view,
                  );
                await tx.$executeRawUnsafe(
                  `UPDATE liekan_analysis_query q SET status='failed',error_code='analysis-idle'
          WHERE q.id=$1::uuid AND q.status='queued' AND NOT ${analysisJobDemandSql()}`,
                  id,
                );
              })
            : method === 'release'
              ? withAnalysisViewer(view, () => releaseAnalysisViewer(site, actors[0], id))
              : pumpAnalysisQueries({ send: vi.fn(), update: vi.fn() })
        ).finally(() => (settled = true));
        try {
          for (let i = 0; i < 100 && !settled; i++) {
            const [activity] = await q(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE liekan_analysis_query q SET status=%') AS blocked",
            );
            if (activity.blocked) {
              blocked = true;
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          if (legacy) expect(blocked).toBe(true);
        } finally {
          resume();
          await Promise.all([joining, cancellation]);
        }
        expect(
          (await q('SELECT status FROM liekan_analysis_query WHERE id=$1::uuid', id))[0].status,
        ).toBe(legacy ? 'failed' : 'queued');
        expect(
          (
            await q(
              'SELECT lease_until>clock_timestamp() AS active FROM liekan_analysis_query_viewer WHERE job_id=$1::uuid AND viewer_id=$2::uuid',
              id,
              joiningView,
            )
          )[0].active,
        ).toBe(true);
      }
    },
  );
  it('allows concurrent same-actor joins while callbacks update task timing and reproduces the old lock upgrade', async () => {
    const first = await withAnalysisViewer(randomUUID(), () => read(true, site, 'ai/pages'));
    if (first.ready) throw new Error('expected cold producer');
    const id = first.analysisJob.id;
    for (const legacy of [true, false]) {
      let entered!: () => void,
        resume!: () => void,
        callbacks = 0;
      const callbackEntered = new Promise<void>(resolve => (entered = resolve)),
        gate = new Promise<void>(resolve => (resume = resolve));
      const join = () =>
        analysisTransaction(tx =>
          withAnalysisViewer(randomUUID(), async () => {
            const registration = legacy
              ? new Proxy(tx, {
                  get(target, key) {
                    if (key !== '$executeRawUnsafe') return Reflect.get(target, key);
                    return (statement: string, ...values: unknown[]) =>
                      target.$executeRawUnsafe(
                        statement.replace('FOR KEY SHARE', 'FOR SHARE'),
                        ...values,
                      );
                  },
                })
              : tx;
            await registerAnalysisViewer(registration, id, actors[0].id);
            if (++callbacks === 1) {
              entered();
              await gate;
            }
            await tx.$executeRawUnsafe(
              'UPDATE liekan_analysis_query SET next_attempt_at=clock_timestamp() WHERE id=$1::uuid',
              id,
            );
          }),
        );
      const a = join();
      const checkedA = a.then(
        () => ({ ok: true as const }),
        error => ({ ok: false as const, error }),
      );
      await callbackEntered;
      const b = join();
      const checkedB = b.then(
        () => ({ ok: true as const }),
        error => ({ ok: false as const, error }),
      );
      try {
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const [row] = await q(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO liekan_analysis_query_consumer%') AS blocked",
          );
          if (row.blocked) {
            blocked = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(blocked).toBe(true);
      } finally {
        resume();
      }
      const results = await Promise.all([checkedA, checkedB]);
      if (legacy) {
        const failure = results.find(v => !v.ok);
        expect(failure).toBeDefined();
        expect(String((failure as any).error)).toMatch(/deadlock detected|lock timeout/);
      } else expect(results.every(v => v.ok)).toBe(true);
    }
  });
  it('parks disconnected queued viewers after their leases expire and frees actor admission', async () => {
    const task = await withAnalysisViewer(randomUUID(), () => read());
    if (task.ready) throw new Error('expected cold producer');
    await sql(
      "UPDATE liekan_analysis_query_viewer SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id=$1::uuid",
      task.analysisJob.id,
    );
    await pumpAnalysisQueries({ send: vi.fn(), update: vi.fn() });
    expect(
      (
        await q(
          'SELECT status,error_code FROM liekan_analysis_query WHERE id=$1::uuid',
          task.analysisJob.id,
        )
      )[0],
    ).toEqual({ status: 'failed', error_code: 'analysis-idle' });
    await expect(
      withAnalysisViewer(randomUUID(), () => read(true, site, 'ai/pages')),
    ).resolves.toMatchObject({ ready: false });
  });
  it('admits at most two foreground computations across independent callers', async () => {
    let release!: () => void,
      entered = 0;
    const gate = new Promise<void>(resolve => (release = resolve));
    const hold = () =>
      withAnalysisPermit('dashboard', async () => {
        entered++;
        await gate;
      });
    const first = hold();
    while (entered < 1) await new Promise(resolve => setTimeout(resolve, 5));
    const second = hold();
    while (entered < 2) await new Promise(resolve => setTimeout(resolve, 5));
    try {
      expect(
        (
          await withAnalysisPermit('dashboard', async () => {
            throw new Error('third slot');
          })
        ).acquired,
      ).toBe(false);
      expect(
        (
          await q(
            'SELECT count(*)::int AS n FROM liekan_analysis_read_lease WHERE lease_until>clock_timestamp()',
          )
        )[0].n,
      ).toBe(2);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(await withAnalysisPermit('dashboard', async () => 7)).toMatchObject({
      acquired: true,
      value: 7,
    });
  });
  it('yields a new inline read to the older waiting website head', async () => {
    await sql("UPDATE liekan_analysis_site SET mode='live' WHERE website_id=$1::uuid", otherSite);
    const first = await withAnalysisViewer(randomUUID(), () => read(true, site, 'ai/pages'));
    const second = await withAnalysisViewer(randomUUID(), () =>
      read(true, otherSite, 'ai/pages', actors[1]),
    );
    if (first.ready || second.ready) throw new Error('expected cold producers');
    expect((await processAnalysisQuery(second.analysisJob.id, { firstPage: true })).acquired).toBe(
      false,
    );
    expect(
      (
        await q(
          'SELECT attempts,fast_attempted_at FROM liekan_analysis_query WHERE id=$1::uuid',
          second.analysisJob.id,
        )
      )[0],
    ).toEqual({ attempts: 0, fast_attempted_at: null });
    await finish(first.analysisJob.id);
    expect((await processAnalysisQuery(second.analysisJob.id, { firstPage: true })).acquired).toBe(
      true,
    );
  });
  it('bounds viewer receipts and reclaims expired leases on the next read', async () => {
    let id = '';
    for (let i = 0; i < 32; i++) {
      const task = await withAnalysisViewer(randomUUID(), () => read());
      if (task.ready) throw new Error('expected cold producer');
      id = task.analysisJob.id;
    }
    await expect(withAnalysisViewer(randomUUID(), () => read())).rejects.toMatchObject({
      status: 429,
    });
    await sql(
      "UPDATE liekan_analysis_query_viewer SET lease_until=clock_timestamp()-interval '1 second' WHERE job_id=$1::uuid",
      id,
    );
    await withAnalysisViewer(randomUUID(), () => read());
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_query_viewer WHERE job_id=$1::uuid',
          id,
        )
      )[0].n,
    ).toBeLessThanOrEqual(1);
  });
  it('bounds published physical facts independently of manifest source counts', async () => {
    const { createAnalysisBuild, runOneAnalysisWorkUnit } = await import('./analysis-rollups');
    const input = { ...parameters('ai/pages'), crawlerMetricsVersion: 1 };
    const start = new Date(Number(input.startAt)),
      end = new Date(+start + 3600000);
    const build = await withPublishedRegistry(() =>
      createAnalysisBuild(
        site,
        { userId: actors[0].id },
        {
          startDate: start,
          endDate: end,
          timezone: 'Asia/Shanghai',
          locale: 'zh-CN',
          requestId: randomUUID(),
        },
      ),
    );
    for (let i = 0; i < 20; i++) {
      const [state] = await q(
        'SELECT status FROM liekan_analysis_build WHERE id=$1::uuid',
        build.id,
      );
      if (state.status === 'completed') break;
      await withPublishedRegistry(() => runOneAnalysisWorkUnit(build.id));
    }
    // This isolated synthetic publication represents many source requests in one scanned fact.
    await sql(
      "UPDATE liekan_analysis_manifest SET row_count=9000000 WHERE website_id=$1::uuid AND family='log'",
      site,
    );
    await sql(
      `INSERT INTO liekan_analysis_log(website_id,generation,grain,bucket,dimensions,dimension_key,requests,first_at,last_at)
      SELECT website_id,generation,'5m',bucket,'{}'::jsonb,'synthetic-compressed-fact',9000000,bucket,bucket FROM liekan_analysis_manifest WHERE website_id=$1::uuid AND family='log' LIMIT 1`,
      site,
    );
    expect(
      await withPublishedRegistry(() => canReadFirstPage(site, input, Date.now() + 5000)),
    ).toBe(true);
  });
  it('uses physical bounded gaps for fast-page admission and defers large raw gaps', async () => {
    const input = { ...parameters('ai/pages'), crawlerMetricsVersion: 1 };
    expect(await canReadFirstPage(site, input, Date.now() + 5000)).toBe(true);
    const imported = randomUUID();
    await sql(
      'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$1,20001,0)',
      imported,
      site,
    );
    await sql(
      `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
      SELECT 'synthetic-admission-'||g,$1::uuid,$2::uuid,$3::timestamptz,'/test','GET',200,0,'','','GPTBot/1.0','','GPTBot','OpenAI','训练','verified_range',true,'recognized' FROM generate_series(1,20001) g`,
      site,
      imported,
      new Date(Number(input.startAt) + 1000),
    );
    expect(await canReadFirstPage(site, input, Date.now() + 5000)).toBe(false);
  });
  it('registers foreground demand while a build holds shared authority', async () => {
    const task = await withSharedAuthority(() => read());
    expect(task.ready).toBe(false);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(1);
  });
  it('seeds common selections while a build holds shared authority', async () => {
    await withSharedAuthority(() => seedDashboardSnapshots());
    expect(await coldCount()).toBe(1);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(1);
  });
  it('serializes same-site capacity when existing producers reattach outside global admission', async () => {
    const first = await read(),
      second = await read(true, site, 'human/overview');
    if (first.ready === true || second.ready === true)
      throw new Error('expected existing producers');
    await sql('DELETE FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid', site);
    await sql(
      `INSERT INTO liekan_dashboard_snapshot(website_id,query_key,actor_id,target,parameters,locale,strong_version,epoch,calendar_day,dependency_end,last_read_at)
       SELECT website_id,'synthetic-reattach-'||n,$2::uuid,'native:stats','{}','zh-CN','synthetic',epoch,'','2026-01-01',clock_timestamp()-interval '1 day'
       FROM liekan_analysis_site CROSS JOIN generate_series(1,199) n WHERE website_id=$1::uuid`,
      site,
      actors[0].id,
    );
    expect(await Promise.all([read(), read(true, site, 'human/overview')])).toMatchObject([
      { ready: false, analysisJob: { id: first.analysisJob.id } },
      { ready: false, analysisJob: { id: second.analysisJob.id } },
    ]);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(200);
  });
  it('bounds concurrent foreground registration and seed reclamation at 200 publications', async () => {
    await sql(
      `INSERT INTO liekan_dashboard_snapshot(website_id,query_key,actor_id,target,parameters,locale,strong_version,epoch,calendar_day,dependency_end,last_read_at)
       SELECT website_id,'synthetic-capacity-'||n,$2::uuid,'native:stats','{}','zh-CN','synthetic',epoch,'','2026-01-01',clock_timestamp()-interval '1 day'
       FROM liekan_analysis_site CROSS JOIN generate_series(1,199) n WHERE website_id=$1::uuid`,
      site,
      actors[0].id,
    );
    const tasks = await Promise.all([
      read(),
      read(true, site, 'human/overview'),
      seedDashboardSnapshots(),
    ]);
    expect(tasks.slice(0, 2).every(task => task && !task.ready)).toBe(true);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBeLessThanOrEqual(200);
    expect(await coldCount()).toBeLessThanOrEqual(1);
  });
  it.each([
    ['site', 8],
    ['global', 32],
  ] as const)('retains the %s pending producer limit of %s', async (scope, limit) => {
    const first = await read();
    if (first.ready === true) throw new Error('expected pending producer');
    await sql(
      `INSERT INTO liekan_analysis_query(id,website_id,actor_id,target,parameters,query_key,strong_version,catalog_version,epoch,forced,status,locale)
       SELECT gen_random_uuid(),$2::uuid,$3::uuid,target,parameters,query_key||'-quota-'||n,strong_version,catalog_version,epoch,forced,'queued',locale
       FROM liekan_analysis_query CROSS JOIN generate_series(1,$4::int)n WHERE id=$1::uuid`,
      first.analysisJob.id,
      scope === 'site' ? site : otherSite,
      actors[1].id,
      limit - 1,
    );
    await expect(read(true, site, 'human/overview')).rejects.toMatchObject({
      status: 429,
      code: 'analysis-concurrency-limited',
    });
    const [counts] = await q(
      `SELECT count(*)::int AS global,count(*) FILTER(WHERE website_id=$1::uuid)::int AS site
       FROM liekan_analysis_query WHERE status IN('queued','running')`,
      site,
    );
    expect(counts[scope]).toBe(limit);
  });
  it.each(['mode', 'epoch', 'permission', 'lease'] as const)(
    'fences a dashboard publication after its %s changes',
    async change => {
      const task = await read();
      if (task.ready === true) throw new Error('expected queued publication');
      const execution = await import('./analysis-query-execution');
      vi.mocked(execution.executeAnalysisQuery).mockImplementationOnce(async () => {
        if (change === 'lease')
          await sql(
            'UPDATE liekan_analysis_read_lease SET token=$1::uuid,epoch=epoch+1 WHERE token IS NOT NULL',
            randomUUID(),
          );
        else if (change === 'permission')
          await sql(
            'UPDATE website SET user_id=$2::uuid WHERE website_id=$1::uuid',
            site,
            actors[1].id,
          );
        else
          await sql(
            change === 'mode'
              ? "UPDATE liekan_analysis_site SET mode='disabled',epoch=epoch+1 WHERE website_id=$1::uuid"
              : 'UPDATE liekan_analysis_site SET epoch=epoch+1 WHERE website_id=$1::uuid',
            site,
          );
        return { pageviews: 1 };
      });
      await processAnalysisQuery(task.analysisJob.id);
      expect(
        (
          await q('SELECT status FROM liekan_analysis_query WHERE id=$1::uuid', task.analysisJob.id)
        )[0].status,
      ).not.toBe('ready');
      expect(
        (await q('SELECT result FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid', site))[0]
          .result,
      ).toBeNull();
      expect(execution.executeAnalysisQuery).toHaveBeenCalledOnce();
    },
  );
  it('completes a real eleven-second SQL first attempt in the dashboard lane', async () => {
    const execution = await import('./analysis-query-execution');
    vi.mocked(execution.executeAnalysisQuery).mockImplementation(async () => {
      const began = Date.now();
      const rows = await analysisTransaction(tx =>
        timedAnalyticsClient(tx, currentCacheContext().deadline).$queryRawUnsafe(
          'SELECT 1 AS n FROM pg_sleep(11)',
        ),
      );
      expect(Date.now() - began).toBeGreaterThan(10000);
      expect(rows).toEqual([{ n: 1 }]);
      return { pageviews: 1 };
    });
    const task = await read();
    if (task.ready === true) throw new Error('expected first attempt');
    await withAnalysisPermit('interactive', () => finish(task.analysisJob.id));
    expect((await read()).ready).toBe(true);
  }, 20000);
  it('keeps ordinary retries on dashboard while history and incremental work remain eligible', async () => {
    const execution = await import('./analysis-query-execution');
    vi.mocked(execution.executeAnalysisQuery).mockRejectedValueOnce(
      new Error('synthetic first failure'),
    );
    const task = await read();
    if (task.ready === true) throw new Error('expected first attempt');
    await processAnalysisQuery(task.analysisJob.id);
    await sql(
      'UPDATE liekan_analysis_query SET next_attempt_at=clock_timestamp() WHERE id=$1::uuid',
      task.analysisJob.id,
    );
    expect((await withAnalysisPermit('history', async () => true)).acquired).toBe(true);
    expect((await withAnalysisPermit('incremental', async () => true)).acquired).toBe(true);
    expect((await withAnalysisPermit('preheat', async () => true)).acquired).toBe(true);
    await withBlockedLane('dashboard', async () => {
      expect((await processAnalysisQuery(task.analysisJob.id)).acquired).toBe(false);
      expect(
        (
          await q(
            'SELECT attempts FROM liekan_analysis_query WHERE id=$1::uuid',
            task.analysisJob.id,
          )
        )[0].attempts,
      ).toBe(1);
    });
    await withAnalysisPermit('interactive', () => finish(task.analysisJob.id));
    expect(
      (
        await q('SELECT attempts FROM liekan_analysis_query WHERE id=$1::uuid', task.analysisJob.id)
      )[0].attempts,
    ).toBe(2);
  });
  it('rechecks demand in the business claim and promotes the same queued producer on return', async () => {
    const task = await read();
    if (task.ready === true) throw new Error('expected queued producer');
    const background = await import('./analysis-background');
    const original = background.withAnalysisPermit;
    const permit = vi
      .spyOn(background, 'withAnalysisPermit')
      .mockImplementationOnce(async (kind, work) => {
        await sql(
          'UPDATE liekan_dashboard_snapshot SET last_read_at=to_timestamp(0) WHERE job_id=$1::uuid',
          task.analysisJob.id,
        );
        return original(kind, work);
      });
    await processAnalysisQuery(task.analysisJob.id);
    permit.mockRestore();
    expect(
      (
        await q(
          'SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid',
          task.analysisJob.id,
        )
      )[0],
    ).toEqual({ status: 'queued', attempts: 0 });
    expect(await read()).toMatchObject({ ready: false, analysisJob: { id: task.analysisJob.id } });
    await withAnalysisPermit('interactive', () => finish(task.analysisJob.id));
  });
  it('uses authorized task reads as live demand and preserves native retry placement', async () => {
    const cold = await read(false);
    if (cold.ready === true) throw new Error('expected cold producer');
    await withPublishedRegistry(() => readAnalysisQuery(site, actors[0], cold.analysisJob.id));
    await withAnalysisPermit('interactive', () => finish(cold.analysisJob.id));
    const native = await withPublishedRegistry(() =>
      requestAnalysisQuery(site, actors[0], 'native:stats', nativeParameters()),
    );
    if (native.ready === true) throw new Error('expected native producer');
    await sql(
      'UPDATE liekan_analysis_query SET attempts=1 WHERE id=$1::uuid',
      native.analysisJob.id,
    );
    expect((await withAnalysisPermit('history', async () => true)).acquired).toBe(false);
    await withAnalysisPermit('interactive', async () =>
      expect((await processAnalysisQuery(native.analysisJob.id)).acquired).toBe(false),
    );
    await withAnalysisPermit('dashboard', () => finish(native.analysisJob.id));
  });
  it('runs an ordinary retry while an older same-site native retry waits for the shared lane', async () => {
    const native = await withPublishedRegistry(() =>
      requestAnalysisQuery(site, actors[0], 'native:stats', nativeParameters()),
    );
    const ordinary = await read();
    if (native.ready === true || ordinary.ready === true)
      throw new Error('expected mixed-lane tasks');
    await sql(
      "UPDATE liekan_analysis_query SET attempts=1,queued_at=clock_timestamp()-interval '30 seconds' WHERE id=$1::uuid",
      native.analysisJob.id,
    );
    await sql(
      "UPDATE liekan_analysis_query SET attempts=1,queued_at=clock_timestamp()-interval '10 seconds' WHERE id=$1::uuid",
      ordinary.analysisJob.id,
    );
    await withAnalysisPermit('interactive', () => finish(ordinary.analysisJob.id));
    expect(
      (
        await q(
          'SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid',
          native.analysisJob.id,
        )
      )[0],
    ).toEqual({ status: 'queued', attempts: 1 });
  });
  it('admits one concurrent ordinary cold producer globally while native work stays independent', async () => {
    await sql("UPDATE liekan_analysis_site SET mode='live' WHERE website_id=$1::uuid", otherSite);
    const results = await Promise.allSettled([
      read(false),
      read(false, otherSite, 'overview', actors[1]),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await coldCount()).toBe(1);
    for (let pass = 0; pass < 3; pass++) await seedDashboardSnapshots();
    expect(await coldCount()).toBe(1);
    const native = await withPublishedRegistry(() =>
      requestDashboardSnapshot(site, actors[0], 'native:stats', nativeParameters(), 'zh-CN', false),
    );
    expect(native.ready).toBe(false);
    expect(await coldCount()).toBe(1);
  });
  it('registers and completes common warmups while unviewed published maintenance stays present', async () => {
    const published = await read(false);
    if (published.ready === true) throw new Error('expected publication');
    await finish(published.analysisJob.id);
    await sql(
      "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '10 seconds' WHERE id=$1::uuid",
      published.analysisJob.id,
    );
    await sql(
      "UPDATE liekan_dashboard_snapshot SET fingerprint=NULL,next_refresh_at=clock_timestamp()-interval '1 second' WHERE website_id=$1::uuid",
      site,
    );
    await pumpDashboardSnapshots();
    const [maintenance] = await q(
      "SELECT id FROM liekan_analysis_query WHERE website_id=$1::uuid AND status='queued'",
      site,
    );
    expect(maintenance).toBeDefined();
    await seedDashboardSnapshots();
    expect(await coldCount()).toBe(1);
    const [cold] = await q(
      `SELECT q.id FROM liekan_analysis_query q WHERE q.status='queued' AND ${coldDashboardPrewarmSql}`,
    );
    await finish(cold.id);
    expect(
      (await q('SELECT status FROM liekan_analysis_query WHERE id=$1::uuid', maintenance.id))[0]
        .status,
    ).toBe('queued');
    await finish(maintenance.id);
  });
  it('lets published maintenance register alongside an outstanding cold producer', async () => {
    const published = await read(false);
    if (published.ready === true) throw new Error('expected publication');
    await finish(published.analysisJob.id);
    await seedDashboardSnapshots();
    expect(await coldCount()).toBe(1);
    await sql(
      "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '10 seconds' WHERE id=$1::uuid",
      published.analysisJob.id,
    );
    await sql(
      "UPDATE liekan_dashboard_snapshot SET fingerprint=NULL,next_refresh_at=clock_timestamp()-interval '1 second' WHERE website_id=$1::uuid AND result IS NOT NULL",
      site,
    );
    await pumpDashboardSnapshots();
    expect(
      (
        await q(
          "SELECT count(*)::int AS n FROM liekan_analysis_query WHERE status='queued' AND website_id=$1::uuid",
          site,
        )
      )[0].n,
    ).toBe(2);
    expect(await coldCount()).toBe(1);
  });
  it('shares the one-new-cold allowance between seed and snapshot maintenance', async () => {
    const pass = { coldRegistered: false };
    await seedDashboardSnapshots(pass);
    const [cold] = await q(
      `SELECT q.id FROM liekan_analysis_query q WHERE q.status='queued' AND ${coldDashboardPrewarmSql}`,
    );
    await finish(cold.id);
    await pumpDashboardSnapshots(pass);
    await seedDashboardSnapshots(pass);
    expect(pass.coldRegistered).toBe(true);
    expect(await coldCount()).toBe(0);
    await seedDashboardSnapshots();
    expect(await coldCount()).toBe(1);
  });
  it('prioritizes every Today resource before seven-day ranges, starting with both overview pages', async () => {
    const resources = Object.keys(pageReportParts).filter(
      resource => !['logs', 'human/keywords'].includes(resource),
    );
    const seeded: any[] = [];
    for (let pass = 0; pass <= resources.length; pass++) {
      await seedDashboardSnapshots();
      const [cold] = await q(
        `SELECT q.id,q.parameters FROM liekan_analysis_query q WHERE q.status='queued' AND ${coldDashboardPrewarmSql}`,
      );
      expect(cold).toBeDefined();
      seeded.push(cold.parameters);
      await finish(cold.id);
    }
    expect(seeded.slice(0, 2).map(value => value.resource)).toEqual(['overview', 'human/overview']);
    expect(seeded.slice(0, resources.length).every(value => value.chartPeriod === 'today')).toBe(
      true,
    );
    expect(seeded[resources.length]).toMatchObject({ chartPeriod: '7d', resource: 'overview' });
  });
  it('projects real page-report website metadata from the authoritative resource row', async () => {
    const execution = await import('./analysis-query-execution');
    vi.mocked(execution.executeAnalysisQuery).mockRestore();
    const task = await read();
    if (task.ready === true) throw new Error('expected real report producer');
    await finish(task.analysisJob.id);
    const result = await withPublishedRegistry(() =>
      readAnalysisQuery(site, actors[0], task.analysisJob.id, true),
    );
    if (result.ready === false) throw new Error('expected real report publication');
    const [saved] = await q(
      'SELECT result FROM liekan_analysis_query WHERE id=$1::uuid',
      task.analysisJob.id,
    );
    const [website] = await q(
      'SELECT website_id AS id,name,domain,site_number AS "siteNumber" FROM website WHERE website_id=$1::uuid',
      site,
    );
    const value: any = decodeAnalysisEnvelope(saved.result, site).value;
    const statistics = ({ meta, ...body }: any) => {
      const { generatedAt, expiresAt, snapshot, canManage, keywordReadAt, ...rest } = meta;
      return { ...body, meta: rest };
    };
    expect((result.value as any).website).toEqual(website);
    expect(analysisDigest(statistics({ ...value, website }))).toBe(
      analysisDigest(statistics(result.value)),
    );
    if (process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT)
      await writeFile(
        `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/producer-projection.private.json`,
        JSON.stringify(
          {
            envelope: saved.result,
            website,
            publicValue: result.value,
            rawHash: analysisDigest(statistics(value)),
            normalizedHash: analysisDigest(statistics({ ...value, website })),
            publicHash: analysisDigest(statistics(result.value)),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
  });
  it('hands off a published maintenance successor after a claimed delivery without another pump', async () => {
    await sql("UPDATE liekan_analysis_site SET mode='live' WHERE website_id=$1::uuid", site);
    const publication = await read(true, site, 'human/overview');
    if (publication.ready === true) throw new Error('expected initial publication');
    await finish(publication.analysisJob.id);
    await sql(
      "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '10 seconds' WHERE id=$1::uuid",
      publication.analysisJob.id,
    );
    const first = await read();
    if (first.ready === true) throw new Error('expected queued predecessor');
    await withDeliveryQueue(first.analysisJob.id, async boss => {
      let successorId: string;
      try {
        await pumpAnalysisQueries(boss);
        await sql(
          "UPDATE liekan_dashboard_snapshot SET fingerprint=NULL,next_refresh_at=clock_timestamp()-interval '1 second' WHERE website_id=$1::uuid AND parameters->>'resource'='human/overview'",
          site,
        );
        await pumpDashboardSnapshots();
        const [successor] = await q(
          `SELECT q.id,d.result IS NOT NULL AS published FROM liekan_analysis_query q
           JOIN liekan_dashboard_snapshot d ON d.job_id=q.id
           WHERE q.website_id=$1::uuid AND q.status='queued' AND q.id<>$2::uuid`,
          site,
          first.analysisJob.id,
        );
        expect(successor.published).toBe(true);
        successorId = successor.id;
        expect(await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key: successorId })).toHaveLength(0);
        const [delivery] = await boss.fetch<{ id: string }>(ANALYSIS_QUERY_QUEUE, {
          includeMetadata: true,
        });
        expect(delivery.data.id).toBe(first.analysisJob.id);
        await processAnalysisQueryDelivery(delivery, boss);
        expect(
          (
            await q(
              'SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid',
              first.analysisJob.id,
            )
          )[0],
        ).toEqual({ status: 'ready', attempts: 1 });
        expect(
          await q('SELECT token FROM liekan_analysis_read_lease WHERE token IS NOT NULL'),
        ).toEqual([]);
        expect(
          await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key: successorId, queued: true }),
        ).toHaveLength(1);
      } finally {
        if (successorId)
          for (const job of await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key: successorId }))
            await boss.deleteJob(ANALYSIS_QUERY_QUEUE, job.id);
      }
    });
  });
  it.each([true, false])(
    'wakes only the globally oldest dashboard head with queue availability %s',
    async available => {
      const first = await read(),
        sameSite = await read(true, site, 'human/overview'),
        other = await read(true, otherSite, 'overview', actors[1]);
      if (first.ready === true || sameSite.ready === true || other.ready === true)
        throw new Error('expected three queued producers');
      for (const [id, seconds] of [
        [first.analysisJob.id, 30],
        [other.analysisJob.id, 20],
        [sameSite.analysisJob.id, 10],
      ] as const)
        await sql(
          `UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-$2::int*interval '1 second' WHERE id=$1::uuid`,
          id,
          seconds,
        );
      await withDeliveryQueue(first.analysisJob.id, async boss => {
        try {
          await dispatchAnalysisQuery(first.analysisJob.id, boss);
          const [delivery] = await boss.fetch<{ id: string }>(ANALYSIS_QUERY_QUEUE, {
            includeMetadata: true,
          });
          const send = vi.spyOn(boss, 'send');
          if (!available)
            send.mockRejectedValueOnce(new Error('synthetic successor queue unavailable'));
          await expect(processAnalysisQueryDelivery(delivery, boss)).resolves.toBeUndefined();
          expect(send).toHaveBeenCalledOnce();
          expect(send.mock.calls[0][1]).toEqual({ id: other.analysisJob.id });
          expect(
            (
              await q(
                'SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid',
                first.analysisJob.id,
              )
            )[0],
          ).toEqual({ status: 'ready', attempts: 1 });
          expect(
            await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key: other.analysisJob.id, queued: true }),
          ).toHaveLength(available ? 1 : 0);
          expect(
            await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key: sameSite.analysisJob.id }),
          ).toHaveLength(0);
          send.mockRestore();
          if (!available) {
            await pumpAnalysisQueries(boss);
            expect(
              await boss.findJobs(ANALYSIS_QUERY_QUEUE, {
                key: other.analysisJob.id,
                queued: true,
              }),
            ).toHaveLength(1);
          }
        } finally {
          for (const key of [sameSite.analysisJob.id, other.analysisJob.id])
            for (const job of await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key }))
              await boss.deleteJob(ANALYSIS_QUERY_QUEUE, job.id);
        }
      });
    },
  );
  it('adds no successor delivery when no dashboard head remains', async () => {
    const first = await read();
    if (first.ready === true) throw new Error('expected queued producer');
    await withDeliveryQueue(first.analysisJob.id, async boss => {
      await dispatchAnalysisQuery(first.analysisJob.id, boss);
      const [delivery] = await boss.fetch<{ id: string }>(ANALYSIS_QUERY_QUEUE, {
        includeMetadata: true,
      });
      const send = vi.spyOn(boss, 'send');
      await processAnalysisQueryDelivery(delivery, boss);
      expect(send).not.toHaveBeenCalled();
      expect(
        (
          await q(
            'SELECT status FROM liekan_analysis_query WHERE id=$1::uuid',
            first.analysisJob.id,
          )
        )[0].status,
      ).toBe('ready');
    });
  });
  it('does not wake another head when the dashboard permit was not acquired', async () => {
    const first = await read();
    if (first.ready === true) throw new Error('expected queued producer');
    await withDeliveryQueue(first.analysisJob.id, async boss => {
      await dispatchAnalysisQuery(first.analysisJob.id, boss);
      const [delivery] = await boss.fetch<{ id: string }>(ANALYSIS_QUERY_QUEUE, {
        includeMetadata: true,
      });
      const send = vi.spyOn(boss, 'send');
      await withBlockedLane('dashboard', () => processAnalysisQueryDelivery(delivery, boss));
      expect(send).not.toHaveBeenCalled();
      expect(
        (
          await q(
            'SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid',
            first.analysisJob.id,
          )
        )[0],
      ).toEqual({ status: 'queued', attempts: 0 });
    });
  });
  it.each([false, true])(
    'TTL ends an expired due delivery without computation or retry when permit occupied=%s',
    async occupied => {
      const task = await read();
      if (task.ready === true) throw new Error('expected queued expiry fixture');
      await withDeliveryQueue(task.analysisJob.id, async boss => {
        await dispatchAnalysisQuery(task.analysisJob.id, boss);
        const [delivery] = await boss.fetch<{ id: string }>(ANALYSIS_QUERY_QUEUE, {
          includeMetadata: true,
        });
        await sql(
          "UPDATE liekan_analysis_query SET retention_until=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",
          task.analysisJob.id,
        );
        const fail = vi.spyOn(boss, 'fail');
        if (occupied)
          await withBlockedLane('dashboard', () => processAnalysisQueryDelivery(delivery, boss));
        else await processAnalysisQueryDelivery(delivery, boss);
        const execution = await import('./analysis-query-execution');
        expect(execution.executeAnalysisQuery).not.toHaveBeenCalled();
        expect(fail).not.toHaveBeenCalled();
        expect(await boss.complete(ANALYSIS_QUERY_QUEUE, delivery)).toMatchObject({ affected: 1 });
        expect(
          (
            await q(
              'SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid',
              task.analysisJob.id,
            )
          )[0],
        ).toEqual({ status: 'queued', attempts: 0 });
      });
    },
  );
  it('TTL prevents direct handoff of an expired due task', async () => {
    const task = await read();
    if (task.ready === true) throw new Error('expected queued expiry fixture');
    await sql(
      "UPDATE liekan_analysis_query SET retention_until=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",
      task.analysisJob.id,
    );
    await withDeliveryQueue(task.analysisJob.id, async boss => {
      await dispatchAnalysisQuery(task.analysisJob.id, boss);
      expect(await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key: task.analysisJob.id })).toHaveLength(
        0,
      );
    });
  });
  it.each([
    { name: 'recent publication', aged: false, alias: null, coldFirst: true },
    {
      name: 'publication waiting a full refresh interval',
      aged: true,
      alias: null,
      coldFirst: false,
    },
    { name: 'recent missing-result alias', aged: false, alias: 'recent', coldFirst: false },
    { name: 'idle missing-result alias', aged: false, alias: 'idle', coldFirst: true },
  ])('bounds first-result priority against $name', async ({ aged, alias, coldFirst }) => {
    const initial = await read();
    if (initial.ready === true) throw new Error('expected publication producer');
    await finish(initial.analysisJob.id);
    const [publication] = await q(
      'SELECT query_key,result FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
      site,
    );
    await sql(
      "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '10 seconds' WHERE id=$1::uuid",
      initial.analysisJob.id,
    );
    await sql(
      'UPDATE liekan_dashboard_snapshot SET fingerprint=NULL,data_through=to_timestamp(0) WHERE website_id=$1::uuid',
      site,
    );
    expect((await read()).ready).toBe(true);
    const [refresh] = await q(
      'SELECT job_id AS id FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid',
      site,
    );
    expect(refresh.id).not.toBe(initial.analysisJob.id);
    if (aged)
      await sql(
        "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-$2::int*interval '1 millisecond' WHERE id=$1::uuid",
        refresh.id,
        DASHBOARD_INTERVAL + 1000,
      );
    if (alias)
      await sql(
        `INSERT INTO liekan_dashboard_snapshot(website_id,query_key,actor_id,target,parameters,locale,strong_version,epoch,calendar_day,dependency_end,job_id,last_read_at)
         SELECT website_id,query_key||':missing-alias',actor_id,target,parameters,'en-US',strong_version,epoch,calendar_day,dependency_end,job_id,
           CASE WHEN $2::boolean THEN clock_timestamp() ELSE to_timestamp(0) END
         FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid`,
        site,
        alias === 'recent',
      );
    const cold = await read(true, site, 'human/overview');
    if (cold.ready === true) throw new Error('expected first-result producer');
    const first = coldFirst ? cold.analysisJob.id : refresh.id;
    const second = coldFirst ? refresh.id : cold.analysisJob.id;
    await withDeliveryQueue(first, async boss => {
      try {
        await pumpAnalysisQueries(boss);
        expect(
          await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key: first, queued: true }),
        ).toHaveLength(1);
        expect(await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key: second })).toHaveLength(0);
        expect((await processAnalysisQuery(second)).acquired).toBe(false);
        expect(
          (
            await q(
              'SELECT result FROM liekan_dashboard_snapshot WHERE website_id=$1::uuid AND query_key=$2',
              site,
              publication.query_key,
            )
          )[0].result,
        ).toEqual(publication.result);
        await finish(first);
        await finish(second);
      } finally {
        for (const id of [first, second])
          for (const job of await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key: id }))
            await boss.deleteJob(ANALYSIS_QUERY_QUEUE, job.id);
      }
    });
  });
  it('TTL lets a valid same-site head advance past an expired earlier head', async () => {
    const expired = await read(),
      valid = await read(true, site, 'human/overview');
    if (expired.ready === true || valid.ready === true)
      throw new Error('expected two queued heads');
    await sql(
      "UPDATE liekan_analysis_query SET retention_until=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",
      expired.analysisJob.id,
    );
    expect((await processAnalysisQuery(valid.analysisJob.id)).acquired).toBe(true);
    expect(
      (
        await q(
          'SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid',
          valid.analysisJob.id,
        )
      )[0],
    ).toEqual({ status: 'ready', attempts: 1 });
    expect(
      (
        await q(
          'SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid',
          expired.analysisJob.id,
        )
      )[0],
    ).toEqual({ status: 'queued', attempts: 0 });
  });
  it('TTL wakes the valid global successor while an older expired task remains queued', async () => {
    const first = await read(),
      expired = await read(true, site, 'human/overview');
    if (first.ready === true || expired.ready === true)
      throw new Error('expected predecessor and expired successor');
    const other = await read(true, otherSite, 'overview', actors[1]);
    if (other.ready === true) throw new Error('expected valid global successor');
    await sql(
      "UPDATE liekan_analysis_query SET retention_until=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",
      expired.analysisJob.id,
    );
    await withDeliveryQueue(first.analysisJob.id, async boss => {
      try {
        await dispatchAnalysisQuery(first.analysisJob.id, boss);
        const [delivery] = await boss.fetch<{ id: string }>(ANALYSIS_QUERY_QUEUE, {
          includeMetadata: true,
        });
        const send = vi.spyOn(boss, 'send');
        await processAnalysisQueryDelivery(delivery, boss);
        expect(send).toHaveBeenCalledOnce();
        expect(send.mock.calls[0][1]).toEqual({ id: other.analysisJob.id });
        expect(
          await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key: expired.analysisJob.id }),
        ).toHaveLength(0);
      } finally {
        for (const key of [expired.analysisJob.id, other.analysisJob.id])
          for (const job of await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key }))
            await boss.deleteJob(ANALYSIS_QUERY_QUEUE, job.id);
      }
    });
  });
  it('TTL fences expiry between candidate selection and the atomic claim', async () => {
    const task = await read();
    if (task.ready === true) throw new Error('expected queued claim fixture');
    await withDeliveryQueue(task.analysisJob.id, async boss => {
      await dispatchAnalysisQuery(task.analysisJob.id, boss);
      const [delivery] = await boss.fetch<{ id: string }>(ANALYSIS_QUERY_QUEUE, {
        includeMetadata: true,
      });
      const background = await import('./analysis-background'),
        original = background.withAnalysisPermit;
      vi.spyOn(background, 'withAnalysisPermit').mockImplementationOnce((kind, work) =>
        original(kind, async (owned, lease) => {
          await sql(
            "UPDATE liekan_analysis_query SET retention_until=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",
            task.analysisJob.id,
          );
          return work(owned, lease);
        }),
      );
      const fail = vi.spyOn(boss, 'fail');
      await processAnalysisQueryDelivery(delivery, boss);
      const execution = await import('./analysis-query-execution');
      expect(execution.executeAnalysisQuery).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
      expect(await boss.complete(ANALYSIS_QUERY_QUEUE, delivery)).toMatchObject({ affected: 1 });
      expect(
        (
          await q(
            'SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid',
            task.analysisJob.id,
          )
        )[0],
      ).toEqual({ status: 'queued', attempts: 0 });
    });
  });
  it('TTL preserves fresh delivery and the existing 24-hour retention after publication', async () => {
    const task = await read();
    if (task.ready === true) throw new Error('expected fresh queued fixture');
    await withDeliveryQueue(task.analysisJob.id, async boss => {
      await dispatchAnalysisQuery(task.analysisJob.id, boss);
      const [delivery] = await boss.fetch<{ id: string }>(ANALYSIS_QUERY_QUEUE, {
        includeMetadata: true,
      });
      await processAnalysisQueryDelivery(delivery, boss);
      expect(await boss.complete(ANALYSIS_QUERY_QUEUE, delivery)).toMatchObject({ affected: 1 });
      expect(
        (
          await q(
            `SELECT status,attempts,retention_until>completed_at+interval '23 hours 59 minutes'
        AND retention_until<completed_at+interval '24 hours 1 minute' AS retained FROM liekan_analysis_query WHERE id=$1::uuid`,
            task.analysisJob.id,
          )
        )[0],
      ).toEqual({ status: 'ready', attempts: 1, retained: true });
    });
  });
  it('hands off the oldest runnable task per website before another task from that website', async () => {
    const first = await read(),
      second = await read(true, site, 'human/overview');
    const other = await read(true, otherSite, 'overview', actors[1]);
    if (first.ready === true || second.ready === true || other.ready === true)
      throw new Error('expected queued fairness tasks');
    await sql(
      "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '30 seconds' WHERE id=$1::uuid",
      first.analysisJob.id,
    );
    await sql(
      "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '20 seconds' WHERE id=$1::uuid",
      second.analysisJob.id,
    );
    await sql(
      "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '10 seconds' WHERE id=$1::uuid",
      other.analysisJob.id,
    );
    const send = vi.fn(async () => 'synthetic-delivery');
    await pumpAnalysisQueries({ send, update: vi.fn() } as any);
    const ids = [first.analysisJob.id, second.analysisJob.id, other.analysisJob.id];
    expect(send.mock.calls.map((call: any[]) => call[1].id).filter(id => ids.includes(id))).toEqual(
      [first.analysisJob.id, other.analysisJob.id],
    );
    expect((await processAnalysisQuery(second.analysisJob.id)).acquired).toBe(false);
    expect(
      (
        await q(
          'SELECT attempts FROM liekan_analysis_query WHERE id=$1::uuid',
          second.analysisJob.id,
        )
      )[0].attempts,
    ).toBe(0);
    await finish(first.analysisJob.id);
    send.mockClear();
    await pumpAnalysisQueries({ send, update: vi.fn() } as any);
    expect(send.mock.calls.map((call: any[]) => call[1].id).filter(id => ids.includes(id))).toEqual(
      [second.analysisJob.id, other.analysisJob.id],
    );
  });
  it.each(['candidate-head', 'claim-head'] as const)(
    'redelivers a same-site %s miss without a recovery pump or computation attempt',
    async stage => {
      const first = await read(),
        second = await read(true, site, 'human/overview');
      if (first.ready === true || second.ready === true)
        throw new Error('expected queued producers');
      const key = second.analysisJob.id;
      if (stage === 'claim-head')
        await sql(
          "UPDATE liekan_analysis_query SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE id=$1::uuid",
          first.analysisJob.id,
        );
      await withDeliveryQueue(key, async boss => {
        await dispatchAnalysisQuery(key, boss);
        const [delivery] = await boss.fetch<{ id: string }>(ANALYSIS_QUERY_QUEUE, {
          includeMetadata: true,
        });
        expect(delivery.data.id).toBe(key);
        if (stage === 'claim-head') {
          const background = await import('./analysis-background');
          const original = background.withAnalysisPermit;
          vi.spyOn(background, 'withAnalysisPermit').mockImplementationOnce((kind, work) =>
            original(kind, async (owned, lease) => {
              await sql(
                'UPDATE liekan_analysis_query SET next_attempt_at=clock_timestamp() WHERE id=$1::uuid',
                first.analysisJob.id,
              );
              return work(owned, lease);
            }),
          );
        }
        const send = vi.spyOn(boss, 'send');
        await processAnalysisQueryDelivery(delivery, boss);
        expect(send).not.toHaveBeenCalled();
        send.mockRestore();
        expect(await boss.complete(ANALYSIS_QUERY_QUEUE, delivery)).toMatchObject({ affected: 0 });
        expect(await boss.getJobById(ANALYSIS_QUERY_QUEUE, delivery.id)).toMatchObject({
          state: 'retry',
          priority: 0,
          retryCount: 0,
          retryLimit: 10,
          retryDelay: 1,
        });
        expect(
          (await q('SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid', key))[0],
        ).toEqual({ status: 'queued', attempts: 0 });
        await finish(first.analysisJob.id);
        let redelivery: typeof delivery;
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
        expect(await boss.complete(ANALYSIS_QUERY_QUEUE, redelivery)).toMatchObject({
          affected: 1,
        });
        expect(
          (await q('SELECT status,attempts FROM liekan_analysis_query WHERE id=$1::uuid', key))[0],
        ).toEqual({ status: 'ready', attempts: 1 });
      });
    },
  );
  it.each(['terminal', 'backoff', 'background-demand'] as const)(
    'settles a missed claim after %s without a foreground redelivery',
    async change => {
      const task = await read();
      if (task.ready === true) throw new Error('expected queued producer');
      const key = task.analysisJob.id;
      await withDeliveryQueue(key, async boss => {
        await dispatchAnalysisQuery(key, boss);
        const [delivery] = await boss.fetch<{ id: string }>(ANALYSIS_QUERY_QUEUE, {
          includeMetadata: true,
        });
        const background = await import('./analysis-background');
        const original = background.withAnalysisPermit;
        vi.spyOn(background, 'withAnalysisPermit').mockImplementationOnce((kind, work) =>
          original(kind, async (owned, lease) => {
            if (change === 'background-demand')
              await sql(
                "UPDATE liekan_dashboard_snapshot SET last_read_at=clock_timestamp()-interval '1 day' WHERE job_id=$1::uuid",
                key,
              );
            else
              await sql(
                change === 'terminal'
                  ? "UPDATE liekan_analysis_query SET status='failed' WHERE id=$1::uuid"
                  : "UPDATE liekan_analysis_query SET next_attempt_at=clock_timestamp()+interval '5 seconds' WHERE id=$1::uuid",
                key,
              );
            return work(owned, lease);
          }),
        );
        const send = vi.spyOn(boss, 'send');
        await processAnalysisQueryDelivery(delivery, boss);
        expect(send).not.toHaveBeenCalled();
        send.mockRestore();
        expect(await boss.complete(ANALYSIS_QUERY_QUEUE, delivery)).toMatchObject({ affected: 1 });
        expect(
          (await q('SELECT attempts FROM liekan_analysis_query WHERE id=$1::uuid', key))[0]
            .attempts,
        ).toBe(0);
      });
    },
  );
  it('retains another aged incremental site after one short unit while cold demand waits', async () => {
    const ids = await Promise.all([
      pendingBuild('incremental'),
      pendingBuild('incremental', otherSite),
    ]);
    expect((await read(false)).ready).toBe(false);
    await pumpAnalysisBuilds({ send: vi.fn(async () => randomUUID()) });
    const result = await processAnalysisBuild(ids[0], 'incremental');
    expect(result.completedUnits).toBe(2);
    expect(
      await q('SELECT status FROM liekan_analysis_build WHERE id=ANY($1::uuid[])', ids),
    ).toEqual([{ status: 'completed' }, { status: 'completed' }]);
  });
  it('retains pending history after a short unit and yields again after five interactive turns', async () => {
    const ids = await Promise.all([pendingBuild('history'), pendingBuild('history', otherSite)]);
    expect((await read(false)).ready).toBe(false);
    await pumpAnalysisBuilds({ send: vi.fn(async () => randomUUID()) });
    await sql('UPDATE liekan_analysis_background_lease SET interactive_turns=5 WHERE id');
    expect((await processAnalysisBuild(ids[0], 'history')).completedUnits).toBe(1);
    expect(
      (await q('SELECT history_waiting_at FROM liekan_analysis_background_lease WHERE id'))[0]
        .history_waiting_at,
    ).not.toBeNull();
    for (let turn = 0; turn < 5; turn++)
      expect((await withAnalysisPermit('interactive', async () => true)).acquired).toBe(true);
    expect((await withAnalysisPermit('interactive', async () => true)).acquired).toBe(false);
    expect((await processAnalysisBuild(ids[1], 'history')).completedUnits).toBe(1);
  });
  it.each(['incremental', 'history'] as const)(
    'refreshes only %s waiting demand and clears it when no work remains',
    async kind => {
      const id = await pendingBuild(kind);
      const otherColumn = kind === 'incremental' ? 'history_waiting_at' : 'incremental_waiting_at';
      const ownColumn = `${kind}_waiting_at`;
      const sentinel = new Date(Date.now() - 5000);
      await sql(`UPDATE liekan_analysis_background_lease SET ${otherColumn}=$1 WHERE id`, sentinel);
      expect((await withAnalysisPermit(kind, async () => true)).acquired).toBe(true);
      const [waiting] = await q(
        `SELECT ${ownColumn},${otherColumn} FROM liekan_analysis_background_lease WHERE id`,
      );
      expect(waiting[ownColumn]).not.toBeNull();
      expect(waiting[otherColumn]).toEqual(sentinel);
      await sql("UPDATE liekan_analysis_build SET status='completed' WHERE id=$1::uuid", id);
      expect((await withAnalysisPermit(kind, async () => true)).acquired).toBe(true);
      expect(
        (
          await q(
            `SELECT ${ownColumn},${otherColumn} FROM liekan_analysis_background_lease WHERE id`,
          )
        )[0],
      ).toEqual({ [ownColumn]: null, [otherColumn]: sentinel });
    },
  );
  it.each(['incremental', 'history'] as const)(
    'preserves a replacement lease and waiting tickets after an old %s unit exits',
    async kind => {
      await pendingBuild(kind);
      let replacement: any;
      const permit = await withAnalysisPermit(kind, async () => {
        await sql(
          `UPDATE liekan_analysis_background_lease SET token=$1::uuid,epoch=epoch+1,
          lease_until=clock_timestamp()+interval '90 seconds',incremental_waiting_at=clock_timestamp(),history_waiting_at=clock_timestamp() WHERE id`,
          randomUUID(),
        );
        [replacement] = await q(
          'SELECT token,epoch,lease_until,incremental_waiting_at,history_waiting_at FROM liekan_analysis_background_lease WHERE id',
        );
      });
      expect(permit.acquired).toBe(true);
      expect(
        (
          await q(
            'SELECT token,epoch,lease_until,incremental_waiting_at,history_waiting_at FROM liekan_analysis_background_lease WHERE id',
          )
        )[0],
      ).toEqual(replacement);
    },
  );
  it.each([true, false])(
    'hands off a warm HTTP 200 refresh with queue availability %s',
    async available => {
      const first = await read();
      if (first.ready === true) throw new Error('expected first publication');
      await finish(first.analysisJob.id);
      await sql(
        "UPDATE liekan_analysis_query SET queued_at=clock_timestamp()-interval '10 seconds' WHERE id=$1::uuid",
        first.analysisJob.id,
      );
      await sql(
        'UPDATE liekan_dashboard_snapshot SET data_through=to_timestamp(0) WHERE website_id=$1::uuid',
        site,
      );
      let refreshId: string;
      await withDeliveryQueue(first.analysisJob.id, async boss => {
        try {
          const maintenance = await import('./crawler-maintenance');
          const server = await import('./server');
          const queue = await import('../log-ingestion/queue');
          vi.spyOn(maintenance, 'authenticateCrawlerMaintenance').mockResolvedValue(actors[0]);
          vi.spyOn(server, 'authorize').mockResolvedValue({
            website: { id: site },
            canManage: true,
          } as any);
          const getQueue = vi.spyOn(queue, 'getQueue');
          if (available) getQueue.mockResolvedValue(boss);
          else getQueue.mockRejectedValue(new Error('synthetic warm queue unavailable'));
          const { asyncAnalysisResponse } = await import('./analysis-query-api');
          const response = await withPublishedRegistry(() =>
            asyncAnalysisResponse(
              new Request(
                `http://fixture.invalid/api/liekan/websites/${site}/page-report?${new URLSearchParams(Object.entries(parameters()).map(([k, v]) => [k, String(v)]))}`,
                { headers: { Prefer: 'respond-async', 'Accept-Language': 'zh-CN' } },
              ),
              site,
              'feature:page-report',
            ),
          );
          expect(response.status).toBe(200);
          const [refresh] = await q(
            "SELECT id,status FROM liekan_analysis_query WHERE website_id=$1::uuid AND status='queued'",
            site,
          );
          expect(refresh).toBeDefined();
          refreshId = refresh.id;
          expect(await response.text()).not.toContain(refreshId);
          expect(JSON.stringify([...response.headers])).not.toContain(refreshId);
          const { dashboardRefreshJobId } = await import('./dashboard-snapshots');
          const internal = await read();
          expect(dashboardRefreshJobId(internal)).toBe(refreshId);
          expect(JSON.stringify(internal)).not.toContain(refreshId);
          expect(dashboardRefreshJobId({ refreshJobId: refreshId })).toBeUndefined();
          expect(getQueue).toHaveBeenCalledOnce();
          expect(
            await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key: refreshId, queued: true }),
          ).toHaveLength(available ? 1 : 0);
          if (!available) {
            await pumpAnalysisQueries(boss);
            expect(
              await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key: refreshId, queued: true }),
            ).toHaveLength(1);
          }
        } finally {
          if (refreshId)
            for (const job of await boss.findJobs(ANALYSIS_QUERY_QUEUE, { key: refreshId }))
              await boss.deleteJob(ANALYSIS_QUERY_QUEUE, job.id);
        }
      });
    },
  );
});
