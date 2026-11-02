// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { analysisTransaction } from './analysis-rollups-db';
import { analyticsWorkerContext, currentCacheContext } from './cache-context';
import { withDashboardClock } from './dashboard-clock';
import { reportSnapshot } from './server';
import * as snapshots from './query-snapshot';
import { withPublishedRegistry } from './crawler-registry-context';
import { readReportFragment, withReportFragments } from './report-fragments';

const enabled = process.env.LIEKAN_ANALYSIS_ROLLUPS_TEST === '1';
const actor = randomUUID();
const sites: string[] = [];
let site: string;
const start = new Date('2026-01-01T00:00Z'),
  end = new Date('2026-01-02T00:00Z');
const sql = (text: string, ...args: unknown[]) =>
  analysisTransaction(tx => tx.$executeRawUnsafe(text, ...args));
const rows = <T = any[]>(text: string, ...args: unknown[]) =>
  analysisTransaction(tx => tx.$queryRawUnsafe<T>(text, ...args));
const run = <T>(
  work: () => Promise<T>,
  scope: unknown = { private: true },
  allowed = true,
  options: { deadline?: number; reauthorize?: (deadline?: number) => Promise<boolean> } = {},
) => {
  const deadline = options.deadline ?? Date.now() + 5000;
  return withPublishedRegistry(() =>
    analyticsWorkerContext(
      actor,
      scope,
      () =>
        withDashboardClock(Date.now(), () =>
          withReportFragments(site, () => reportSnapshot(work, deadline)),
        ),
      {
        kind: 'interactive',
        refresh: false,
        deadline,
        reauthorize: options.reauthorize ?? (async () => allowed),
      },
    ),
  );
};
const count = async () =>
  (
    await rows(
      'SELECT count(*)::int AS n FROM liekan_report_fragment WHERE website_id=$1::uuid',
      site,
    )
  )[0].n;

describe.skipIf(!enabled)('persistent private report modules', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '15462' ||
      url.pathname !== '/liekan_analysis_rollups_test'
    )
      throw new Error('Owned report-fragment database required');
    await sql(
      "INSERT INTO \"user\"(user_id,username,password,role) VALUES($1::uuid,$2,'synthetic','user')",
      actor,
      `fragments-${actor}`,
    );
  });
  beforeEach(async () => {
    site = randomUUID();
    sites.push(site);
    await sql(
      "INSERT INTO website(website_id,user_id,name,domain) VALUES($1::uuid,$2::uuid,'Synthetic module fixture','fragment.invalid')",
      site,
      actor,
    );
    await sql(
      'INSERT INTO liekan_analysis_site(website_id) VALUES($1::uuid) ON CONFLICT DO NOTHING',
      site,
    );
  });
  afterAll(async () => {
    for (const id of sites) await sql('DELETE FROM website WHERE website_id=$1::uuid', id);
    await sql('DELETE FROM "user" WHERE user_id=$1::uuid', actor);
  });
  it('reuses exact modules across page assembly and preserves dates, big integers and independent values', async () => {
    const load = vi.fn(async () => ({ created: start, count: 7n, values: [1, 2] }));
    const read = () =>
      run(() => readReportFragment('human', start, end, { fields: ['pages'] }, load));
    const first = await read();
    expect(await count()).toBe(1);
    first.values.push(3);
    expect(await read()).toEqual({ created: start, count: 7n, values: [1, 2] });
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('keeps ranges, filters, sites and resource versions separate', async () => {
    const load = vi.fn(async () => 17);
    const read = (until = end, filter = 'all') =>
      run(() => readReportFragment('logs', start, until, { filter }, load));
    await read();
    await read(new Date(+end + 1));
    await read(end, 'verified');
    await sql(
      "INSERT INTO liekan_analytics_revision(resource_type,resource_id,revision) VALUES('website',$1::uuid,1) ON CONFLICT(resource_type,resource_id) DO UPDATE SET revision=liekan_analytics_revision.revision+1",
      site,
    );
    await read();
    expect(load).toHaveBeenCalledTimes(4);
    expect(await count()).toBe(1);
  });
  it('invalidates inclusive endpoint data while keeping half-open endpoint data reusable', async () => {
    const inclusive = vi.fn(async () => 1);
    const exclusive = vi.fn(async () => 2);
    const read = () =>
      run(async () => {
        await readReportFragment('human', start, end, {}, inclusive, true);
        await readReportFragment('logs', start, end, {}, exclusive);
      });
    await read();
    await sql(
      `INSERT INTO liekan_dashboard_dirty(website_id,epoch,family,bucket,shard)
      SELECT website_id,epoch,'detail',$2,0 FROM liekan_analysis_site WHERE website_id=$1::uuid`,
      site,
      end,
    );
    await read();
    expect(inclusive).toHaveBeenCalledTimes(2);
    expect(exclusive).toHaveBeenCalledTimes(1);
  });
  it('recovers the PostgreSQL transaction after a module-cache read error', async () => {
    const original = snapshots.getQuerySnapshot;
    const load = vi.fn(
      async () =>
        (await snapshots.getQuerySnapshot().$queryRawUnsafe('SELECT 42::int AS value'))[0].value,
    );
    const spy = vi.spyOn(snapshots, 'getQuerySnapshot').mockImplementation(() => {
      const tx = original();
      return (
        tx &&
        new Proxy(tx, {
          get(target, property) {
            if (property !== '$queryRawUnsafe') return Reflect.get(target, property);
            return (statement: string, ...parameters: unknown[]) =>
              statement.includes('SELECT result FROM liekan_report_fragment')
                ? target.$queryRawUnsafe('SELECT 1/0')
                : target.$queryRawUnsafe(statement, ...parameters);
          },
        })
      );
    });
    try {
      expect(await run(() => readReportFragment('human', start, end, {}, load))).toBe(42);
      expect(load).toHaveBeenCalledTimes(1);
      expect(await count()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
  it('retries parallel source reads in a fresh snapshot after a cache probe poisons the timed client', async () => {
    const original = snapshots.getQuerySnapshot;
    let queueSibling: (() => void) | undefined;
    let attempts = 0;
    const spy = vi.spyOn(snapshots, 'getQuerySnapshot').mockImplementation(() => {
      const tx = original();
      return (
        tx &&
        new Proxy(tx, {
          get(target, property) {
            if (property !== '$queryRawUnsafe') return Reflect.get(target, property);
            return (statement: string, ...args: unknown[]) => {
              if (statement.includes('SELECT result FROM liekan_report_fragment')) {
                const failure = target.$queryRawUnsafe('SELECT 1/0');
                queueSibling?.();
                return failure;
              }
              return target.$queryRawUnsafe(statement, ...args);
            };
          },
        })
      );
    });
    try {
      const value = await run(async () => {
        attempts++;
        const read = async () =>
          (await snapshots.getQuerySnapshot().$queryRawUnsafe('SELECT 43::int AS value')) as any[];
        const sibling =
          attempts === 1
            ? new Promise<any[]>((resolve, reject) => {
                queueSibling = () => void read().then(resolve, reject);
              })
            : read();
        const [cached, source] = await Promise.all([
          readReportFragment('human', start, end, {}, async () => 42),
          sibling,
        ]);
        expect(currentCacheContext()?.refresh).toBe(true);
        return [cached, source[0].value];
      });
      expect(value).toEqual([42, 43]);
      expect(attempts).toBe(2);
      expect(await count()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
  it('observes late historical corrections and revalidates before publishing a fragment', async () => {
    let revision = 1;
    const load = vi.fn(async () => revision);
    const read = () => run(() => readReportFragment('logs', start, end, {}, load));
    expect(await read()).toBe(1);
    await sql("SELECT liekan_analysis_invalidate($1::uuid,'log')", site);
    revision = 2;
    expect(await read()).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
    // A correction after snapshot capture prevents the old module from being persisted.
    await run(async () =>
      readReportFragment('race', start, end, {}, async () => {
        await sql("SELECT liekan_analysis_invalidate($1::uuid,'log')", site);
        return 3;
      }),
    );
    expect(await count()).toBe(1);
  });
  it('propagates a parallel source failure without treating its queued cache probe as a cache failure', async () => {
    let attempts = 0;
    await expect(
      run(async () => {
        attempts++;
        return Promise.all([
          readReportFragment('human', start, end, {}, async () => 7),
          snapshots
            .getQuerySnapshot()
            .$queryRawUnsafe(attempts === 1 ? 'SELECT 1/0' : 'SELECT 42::int AS value'),
        ]);
      }),
    ).rejects.toThrow(/division by zero/);
    expect(attempts).toBe(1);
    expect(await count()).toBe(0);
  });
  it('bounds optional cache authorization by the original request and publication deadline', async () => {
    let release!: () => void;
    let locked!: () => void;
    const holding = new Promise<void>(resolve => (release = resolve));
    const acquired = new Promise<void>(resolve => (locked = resolve));
    const blocker = analysisTransaction(async tx => {
      await tx.$queryRawUnsafe(
        'SELECT user_id FROM "user" WHERE user_id=$1::uuid FOR UPDATE',
        actor,
      );
      locked();
      await holding;
    });
    await acquired;
    const deadline = Date.now() + 1500;
    const authorizationDeadlines: (number | undefined)[] = [];
    try {
      expect(
        await run(
          () => readReportFragment('human', start, end, {}, async () => 42),
          undefined,
          true,
          {
            deadline,
            reauthorize: async publicationDeadline => {
              authorizationDeadlines.push(publicationDeadline);
              // The worker's authority check locks the actor through analysisTransaction.
              await analysisTransaction(
                async tx => {
                  await tx.$queryRawUnsafe(
                    'SELECT user_id FROM "user" WHERE user_id=$1::uuid FOR SHARE',
                    actor,
                  );
                },
                'ReadCommitted',
                publicationDeadline,
              );
              return true;
            },
          },
        ),
      ).toBe(42);
      expect(Date.now()).toBeLessThan(deadline);
      expect(authorizationDeadlines).toHaveLength(1);
      expect(authorizationDeadlines[0]).toBeLessThanOrEqual(deadline);
      expect(await count()).toBe(0);
    } finally {
      release();
      await blocker;
    }
  });
  it('keeps public reads and revoked writers outside private storage', async () => {
    await run(() => readReportFragment('logs', start, end, {}, async () => 1), {
      shareId: 'synthetic-public',
    });
    await run(
      () => readReportFragment('logs', start, end, {}, async () => 2),
      { private: true },
      false,
    );
    expect(await count()).toBe(0);
  });
  it('declines oversized and unsupported modules and propagates computation failures', async () => {
    await run(() =>
      readReportFragment('large', start, end, {}, async () => 'x'.repeat(2 * 1024 ** 2 + 1)),
    );
    await run(() => readReportFragment('unsupported', start, end, {}, async () => null));
    await expect(
      run(() =>
        readReportFragment('failure', start, end, {}, async () => {
          throw new Error('synthetic compute failure');
        }),
      ),
    ).rejects.toThrow('synthetic compute failure');
    expect(await count()).toBe(0);
  });
  it('recomputes unreadable cached values and respects capacity', async () => {
    const load = vi.fn(async () => 1);
    const read = () => run(() => readReportFragment('logs', start, end, {}, load));
    await read();
    await sql(
      "UPDATE liekan_report_fragment SET result=decode('000102','hex') WHERE website_id=$1::uuid",
      site,
    );
    expect(await read()).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
    await sql(
      'UPDATE liekan_analysis_site SET derived_bytes=1073741824 WHERE website_id=$1::uuid',
      site,
    );
    expect(await run(() => readReportFragment('no-capacity', start, end, {}, async () => 2))).toBe(
      2,
    );
    expect(await count()).toBe(1);
  });
  it('reserves publication headroom when optional modules would still fit the hard capacity', async () => {
    await sql(
      'UPDATE liekan_analysis_site SET derived_bytes=1073741824-16777216-1048576 WHERE website_id=$1::uuid',
      site,
    );
    expect(await run(() => readReportFragment('human', start, end, {}, async () => 42))).toBe(42);
    expect(await count()).toBe(0);
  });
});
