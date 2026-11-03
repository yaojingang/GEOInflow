// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { PgBoss } from 'pg-boss';
import { deletion } from 'pg-boss/dist/plans.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnalysisTx } from './analysis-rollups-model';
import {
  collectCompletedJobBatch,
  freezeCompletedJobs,
  storageCompletedQueues,
  storageOtherQueues,
  storageShortQueues,
  storageWakeQueues,
} from './storage-queue-retention';

const enabled = process.env.LIEKAN_STORAGE_GC_TEST === '1';
const suffix = randomUUID().replaceAll('-', '').slice(0, 24);
const appSchema = `liekan_storage_policy_${suffix}`;
const jobSchema = `liekan_storage_jobs_${suffix}`;
const managedQueue = 'liekan-analytics-refresh';
const otherQueue = 'storage-integration-unmanaged';
const allQueues = [...storageCompletedQueues, otherQueue];
const week = 7 * 24 * 60 * 60;
let client: Client;
let boss: PgBoss;
let appCreated = false;
let jobsCreated = false;

// Only the production queue schema qualifier is redirected to this fixture's installation.
const privateSql = (sql: string) => sql.replaceAll('liekan_jobs.', `"${jobSchema}".`);
const tx: AnalysisTx = {
  $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) =>
    (await client.query(privateSql(sql), values)).rows as T,
  $executeRawUnsafe: async (sql, ...values) =>
    (await client.query(privateSql(sql), values)).rowCount || 0,
};
async function transaction<T>(work: () => Promise<T>) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout='3s'");
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
async function job(
  name = managedQueue,
  state = 'completed',
  days = 8,
  retention = week,
  transition = true,
  id = randomUUID(),
) {
  await client.query(
    `INSERT INTO "${jobSchema}".job_common
     (id,name,state,deletion_seconds,created_on,completed_on,keep_until)
     VALUES($1,$2,$3,$4,now()-interval '60 days',now()-$5*interval '1 day',now()+interval '60 days')`,
    [id, name, transition ? 'active' : state, retention, days],
  );
  if (transition)
    await client.query(`UPDATE "${jobSchema}".job_common SET state=$2 WHERE id=$1 AND name=$3`, [
      id,
      state,
      name,
    ]);
  return id;
}
async function saved(id: string, name?: string) {
  return (
    await client.query(
      `SELECT id,state::text,deletion_seconds,tableoid::regclass::text AS relation
       FROM "${jobSchema}".job WHERE id=$1 AND ($2::text IS NULL OR name=$2)`,
      [id, name || null],
    )
  ).rows[0];
}
async function cleanup(
  id: string,
  options: {
    status?: string;
    websiteId?: string;
    scopeKey?: string;
    queue?: string;
    recordId?: string;
    kind?: string;
  } = {},
) {
  const run = randomUUID();
  await client.query('INSERT INTO liekan_storage_cleanup VALUES($1,$2,$3,$4)', [
    run,
    options.websiteId || null,
    options.scopeKey || (options.websiteId ? options.websiteId : 'instance'),
    options.status || 'queued',
  ]);
  await client.query('INSERT INTO liekan_storage_candidate VALUES($1,$2,$3,$4)', [
    run,
    options.kind || 'job',
    options.recordId || id,
    options.queue || managedQueue,
  ]);
  return run;
}
async function remove(id: string, guc?: string) {
  return transaction(async () => {
    if (guc !== undefined)
      await client.query("SELECT set_config('liekan.storage_cleanup_run',$1,true)", [guc]);
    return (
      await client.query(`DELETE FROM "${jobSchema}".job_common WHERE id=$1 RETURNING id`, [id])
    ).rows;
  });
}
const nativeSweep = () => client.query(deletion(jobSchema, 'job_common', allQueues, true));

describe.skipIf(!enabled)('isolated PostgreSQL completed-job retention ownership', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !['/liekan_storage_test', '/liekan_storage_gc_test'].includes(url.pathname) ||
      url.searchParams.get('schema') === 'public'
    )
      throw new Error('Storage integration requires a dedicated loopback storage test database');
    url.searchParams.delete('schema');
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(`CREATE SCHEMA "${appSchema}"`);
    appCreated = true;
    await client.query(`SET search_path TO "${appSchema}"`);
    await client.query(`CREATE TABLE liekan_storage_cleanup(
      id uuid PRIMARY KEY,website_id uuid,scope_key text NOT NULL,status text NOT NULL);
      CREATE TABLE liekan_storage_candidate(
      run_id uuid NOT NULL REFERENCES liekan_storage_cleanup(id) ON DELETE CASCADE,
      kind text NOT NULL,record_id uuid NOT NULL,queue_name text NOT NULL DEFAULT '',
      PRIMARY KEY(run_id,kind,queue_name,record_id))`);
    await client.query(`CREATE SCHEMA "${jobSchema}"`);
    jobsCreated = true;
    // PgBoss installs its real partitioned schema and queue metadata only under jobSchema.
    boss = new PgBoss({
      connectionString: url.toString(),
      schema: jobSchema,
      migrate: true,
      createSchema: false,
      supervise: false,
      schedule: false,
      max: 2,
    });
    await boss.start();
    for (const name of allQueues) await boss.createQueue(name, { policy: 'standard' });
    for (const [file, functionName] of [
      ['059_completed_job_retention_guard.sql', 'liekan_storage_guard_completed_job'],
      ['060_completed_job_policy_ownership.sql', 'liekan_storage_complete_job'],
    ]) {
      const source = await readFile(
        new URL(`../../../../db/liekan/migrations/${file}`, import.meta.url),
        'utf8',
      );
      // Migration DO blocks target the real queue installation and are deliberately excluded.
      const definition = source.match(
        new RegExp(`CREATE FUNCTION ${functionName}\\(\\)[\\s\\S]*?END \\$\\$;`),
      )?.[0];
      if (!definition) throw new Error(`Missing production function: ${functionName}`);
      await client.query(definition);
    }
    await client.query(`CREATE TRIGGER liekan_completed_retention_guard
      BEFORE DELETE ON "${jobSchema}".job FOR EACH ROW
      EXECUTE FUNCTION "${appSchema}".liekan_storage_guard_completed_job();
      CREATE TRIGGER liekan_completed_policy_owner
      BEFORE UPDATE OF state ON "${jobSchema}".job FOR EACH ROW
      EXECUTE FUNCTION "${appSchema}".liekan_storage_complete_job()`);
  }, 30000);

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    if (jobsCreated) await client.query(`DROP SCHEMA "${jobSchema}" CASCADE`);
    if (appCreated) await client.query(`DROP SCHEMA "${appSchema}" CASCADE`);
    await client?.end();
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE "${jobSchema}".job,
      "${appSchema}".liekan_storage_candidate,"${appSchema}".liekan_storage_cleanup`);
  });

  it('inherits both production triggers on the actual PgBoss job_common child', async () => {
    const { rows } = await client.query(
      `SELECT t.tgname,t.tgparentid<>0 AS inherited FROM pg_trigger t
       WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal ORDER BY t.tgname`,
      [`${jobSchema}.job_common`],
    );
    expect(rows).toEqual([
      { tgname: 'liekan_completed_policy_owner', inherited: true },
      { tgname: 'liekan_completed_retention_guard', inherited: true },
    ]);
    expect((await saved(await job())).relation).toBe(`${jobSchema}.job_common`);
  });

  it.each(storageCompletedQueues)(
    'assigns completed retention to storage policy for %s',
    async name => {
      expect((await saved(await job(name))).deletion_seconds).toBe(0);
    },
  );

  it.each(['failed', 'cancelled', 'active', 'retry', 'created'])(
    'preserves the queue deletion retention when a managed job becomes %s',
    async state => {
      expect((await saved(await job(managedQueue, state, 8, 123456))).deletion_seconds).toBe(
        123456,
      );
    },
  );

  it('preserves upstream completion retention for queues outside the allowlist', async () => {
    expect((await saved(await job(otherQueue))).deletion_seconds).toBe(week);
  });

  it.each([
    ['missing transaction GUC', 'missing', {}],
    ['invalid UUID GUC', 'invalid', {}],
    ['unknown run UUID', 'unknown', {}],
    ['preview', 'run', { status: 'preview' }],
    ['completed run', 'run', { status: 'completed' }],
    ['stopped run', 'run', { status: 'stopped' }],
    ['failed run', 'run', { status: 'failed' }],
    ['website run', 'run', { websiteId: randomUUID() }],
    ['wrong instance scope key', 'run', { scopeKey: 'different-instance' }],
    ['different candidate queue', 'run', { queue: 'liekan-analysis-query' }],
    ['different candidate job', 'run', { recordId: randomUUID() }],
    ['different candidate kind', 'run', { kind: 'generation' }],
  ] as const)(
    'retains an allowlisted completed child row for %s',
    async (_label, mode, options) => {
      const id = await job();
      const run = await cleanup(id, options);
      const guc =
        mode === 'missing'
          ? undefined
          : mode === 'invalid'
            ? 'invalid-uuid'
            : mode === 'unknown'
              ? randomUUID()
              : run;
      expect(await remove(id, guc)).toEqual([]);
      expect(await saved(id)).toMatchObject({ id, state: 'completed' });
    },
  );

  it.each(['queued', 'running'])(
    'permits the matching candidate of an active %s instance run',
    async status => {
      const id = await job();
      const run = await cleanup(id, { status });
      expect(await remove(id, run)).toEqual([{ id }]);
      expect(await saved(id)).toBeUndefined();
      expect(
        (
          await client.query(
            "SELECT nullif(current_setting('liekan.storage_cleanup_run',true),'') AS value",
          )
        ).rows[0].value,
      ).toBeNull();
    },
  );

  it.each(['created', 'retry', 'active', 'failed', 'cancelled'])(
    'leaves explicit PgBoss deletion authority intact for a managed %s job',
    async state => {
      const id = await job(managedQueue, state);
      expect(await remove(id)).toEqual([{ id }]);
    },
  );

  it('leaves explicit deletion authority intact for an unmanaged completed job', async () => {
    const id = await job(otherQueue);
    expect(await remove(id)).toEqual([{ id }]);
  });

  it('runs native child-table deletion while preserving managed completions and original failure expiry', async () => {
    const managed = await job();
    const historical = await job(managedQueue, 'completed', 8, week, false);
    const expired = [
      await job(managedQueue, 'failed'),
      await job(managedQueue, 'cancelled'),
      await job(otherQueue),
    ];
    const fresh = [await job(managedQueue, 'failed', 1), await job(managedQueue, 'cancelled', 1)];
    const unstarted = await job(managedQueue, 'created');
    await client.query(
      `UPDATE "${jobSchema}".job_common SET keep_until=now()-interval '1 day' WHERE id=$1`,
      [unstarted],
    );
    await nativeSweep();
    for (const id of [managed, historical, ...fresh])
      expect(await saved(id)).toHaveProperty('id', id);
    for (const id of [...expired, unstarted]) expect(await saved(id)).toBeUndefined();
  });

  it('applies a custom 30-day policy after the native 7-day sweep and deletes through PgBoss', async () => {
    const eightDays = await job();
    const thirtyOneDays = await job(managedQueue, 'completed', 31);
    await nativeSweep();
    expect(await saved(eightDays)).toHaveProperty('id', eightDays);
    expect(await saved(thirtyOneDays)).toHaveProperty('id', thirtyOneDays);
    const run = await cleanup(thirtyOneDays);
    await client.query('DELETE FROM liekan_storage_candidate WHERE run_id=$1', [run]);
    const cutoffs = {
      completedCutoff: new Date(Date.now() - 30 * 86400000).toISOString(),
      wakeCutoff: new Date(Date.now() - 30 * 86400000).toISOString(),
      shortCutoff: new Date(Date.now() - 3600000).toISOString(),
    };
    await transaction(async () => {
      expect(await freezeCompletedJobs(tx, run, cutoffs)).toBe(1);
      expect(
        (
          await client.query('SELECT record_id FROM liekan_storage_candidate WHERE run_id=$1', [
            run,
          ])
        ).rows,
      ).toEqual([{ record_id: thirtyOneDays }]);
      expect(await collectCompletedJobBatch(tx, run, cutoffs, boss)).toEqual({
        jobsDeleted: 1,
        more: false,
      });
    });
    expect(await saved(thirtyOneDays)).toBeUndefined();
    expect(await saved(eightDays)).toHaveProperty('id', eightDays);
    expect(
      (await client.query('SELECT * FROM liekan_storage_candidate WHERE run_id=$1', [run])).rows,
    ).toEqual([]);
  });

  it('rolls back both the PgBoss deletion and frozen membership after a batch interruption', async () => {
    const id = await job();
    const run = await cleanup(id);
    const cutoffs = {
      completedCutoff: new Date(Date.now() - 86400000).toISOString(),
      wakeCutoff: new Date(Date.now() - 3600000).toISOString(),
      shortCutoff: new Date(Date.now() - 3600000).toISOString(),
    };
    await expect(
      transaction(async () => {
        await collectCompletedJobBatch(tx, run, cutoffs, boss);
        throw new Error('interrupted-after-pgboss-delete');
      }),
    ).rejects.toThrow('interrupted-after-pgboss-delete');
    expect(await saved(id)).toHaveProperty('id', id);
    expect(
      (await client.query('SELECT record_id FROM liekan_storage_candidate WHERE run_id=$1', [run]))
        .rows,
    ).toEqual([{ record_id: id }]);
    expect(await remove(id)).toEqual([]);
  });

  it('keeps jobs arriving after preview outside the frozen cleanup membership', async () => {
    const frozen = await job();
    const run = await cleanup(frozen);
    const arrivingLater = await job();
    const cutoffs = {
      completedCutoff: new Date(Date.now() - 86400000).toISOString(),
      wakeCutoff: new Date(Date.now() - 3600000).toISOString(),
      shortCutoff: new Date(Date.now() - 3600000).toISOString(),
    };
    expect(await transaction(() => collectCompletedJobBatch(tx, run, cutoffs, boss))).toEqual({
      jobsDeleted: 1,
      more: false,
    });
    expect(await saved(frozen)).toBeUndefined();
    expect(await saved(arrivingLater)).toHaveProperty('id', arrivingLater);
  });

  it.each([false, true])(
    'keeps the same job UUID distinct across managed queues when retry=%s',
    async retry => {
      const id = randomUUID(),
        secondQueue = 'liekan-range-refresh';
      await job(managedQueue, 'completed', 8, week, true, id);
      await job(secondQueue, 'completed', 8, week, true, id);
      const run = await cleanup(id);
      await client.query('DELETE FROM liekan_storage_candidate WHERE run_id=$1', [run]);
      const cutoffs = {
        completedCutoff: new Date(Date.now() - 86400000).toISOString(),
        wakeCutoff: new Date(Date.now() - 3600000).toISOString(),
        shortCutoff: new Date(Date.now() - 3600000).toISOString(),
      };
      expect(await transaction(() => freezeCompletedJobs(tx, run, cutoffs))).toBe(2);
      expect(
        (
          await client.query(
            'SELECT record_id,queue_name FROM liekan_storage_candidate WHERE run_id=$1 ORDER BY queue_name',
            [run],
          )
        ).rows,
      ).toEqual([
        { record_id: id, queue_name: managedQueue },
        { record_id: id, queue_name: secondQueue },
      ]);
      if (retry)
        await client.query(
          `UPDATE "${jobSchema}".job_common SET state='retry' WHERE id=$1 AND name=$2`,
          [id, managedQueue],
        );
      expect(await transaction(() => collectCompletedJobBatch(tx, run, cutoffs, boss))).toEqual({
        jobsDeleted: retry ? 1 : 2,
        more: false,
      });
      expect(await saved(id, secondQueue)).toBeUndefined();
      if (retry) expect(await saved(id, managedQueue)).toMatchObject({ id, state: 'retry' });
      else expect(await saved(id, managedQueue)).toBeUndefined();
      expect(
        (await client.query('SELECT * FROM liekan_storage_candidate WHERE run_id=$1', [run])).rows,
      ).toEqual([]);
    },
  );

  it('limits hourly queue collection to wake and short queues before daily collection includes other queues', async () => {
    const jobs = new Map<string, string>();
    for (const name of storageCompletedQueues) jobs.set(name, await job(name));
    const run = await cleanup(jobs.get(managedQueue));
    await client.query('DELETE FROM liekan_storage_candidate WHERE run_id=$1', [run]);
    const cutoffs = {
      completedCutoff: new Date(Date.now() - 86400000).toISOString(),
      wakeCutoff: new Date(Date.now() - 3600000).toISOString(),
      shortCutoff: new Date(Date.now() - 3600000).toISOString(),
      hourlyOnly: true,
    };
    await transaction(async () => {
      expect(await freezeCompletedJobs(tx, run, cutoffs)).toBe(
        storageWakeQueues.length + storageShortQueues.length,
      );
      expect(await collectCompletedJobBatch(tx, run, cutoffs, boss)).toEqual({
        jobsDeleted: 6,
        more: false,
      });
    });
    for (const name of [...storageWakeQueues, ...storageShortQueues])
      expect(await saved(jobs.get(name), name)).toBeUndefined();
    for (const name of storageOtherQueues)
      expect(await saved(jobs.get(name), name)).toHaveProperty('id', jobs.get(name));
    await transaction(async () => {
      const daily = { ...cutoffs, hourlyOnly: false };
      expect(await freezeCompletedJobs(tx, run, daily)).toBe(storageOtherQueues.length);
      expect(await collectCompletedJobBatch(tx, run, daily, boss)).toEqual({
        jobsDeleted: 4,
        more: false,
      });
    });
    for (const [name, id] of jobs) expect(await saved(id, name)).toBeUndefined();
  });

  it('enforces the real candidate foreign key to its cleanup run', async () => {
    await expect(
      client.query(
        "INSERT INTO liekan_storage_candidate(run_id,kind,record_id,queue_name) VALUES($1,'job',$2,$3)",
        [randomUUID(), randomUUID(), managedQueue],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    expect(
      (await client.query('SELECT count(*)::int AS count FROM liekan_storage_candidate')).rows[0]
        .count,
    ).toBe(0);
  });

  it('freezes 920,000 PgBoss jobs with real run foreign keys in bounded pages and rolls back interruptions', async () => {
    const total = 920000,
      firstQueueRows = 500000,
      secondQueue = 'liekan-crawler-control';
    const sourceStarted = performance.now();
    for (let offset = 0; offset < total; offset += 50000) {
      await client.query(
        `INSERT INTO "${jobSchema}".job_common
        (id,name,state,deletion_seconds,created_on,completed_on,keep_until)
        SELECT ('00000000-0000-4000-8000-'||lpad(to_hex(CASE WHEN n<=$3 THEN n ELSE n-$3 END),12,'0'))::uuid,
          CASE WHEN n<=$3 THEN $4 ELSE $5 END,'completed',0,
          now()-interval '60 days',now()-interval '8 days',now()+interval '60 days'
        FROM generate_series($1::integer,$2::integer) n`,
        [offset + 1, Math.min(total, offset + 50000), firstQueueRows, managedQueue, secondQueue],
      );
    }
    await client.query(`ANALYZE "${jobSchema}".job_common`);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count,count(DISTINCT id)::int AS unique_ids FROM "${jobSchema}".job_common`,
        )
      ).rows,
    ).toEqual([{ count: total, unique_ids: firstQueueRows }]);
    const sourceMs = performance.now() - sourceStarted;
    type Page = {
      inserted: number;
      selected: number;
      name: string | null;
      id: string | null;
      ms: number;
    };
    const record = (pages: Page[], interruptAfter?: number): AnalysisTx => ({
      $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) => {
        const started = performance.now();
        const rows = await tx.$queryRawUnsafe<Omit<Page, 'ms'>[]>(sql, ...values);
        if (sql.includes('INSERT INTO liekan_storage_candidate')) {
          const page = { ...rows[0], ms: performance.now() - started };
          expect(page.selected).toBeGreaterThanOrEqual(0);
          expect(page.selected).toBeLessThanOrEqual(50000);
          expect(page.inserted).toBeGreaterThanOrEqual(0);
          expect(page.inserted).toBeLessThanOrEqual(page.selected);
          pages.push(page);
          if (pages.length === interruptAfter) throw new Error('interrupted-after-freeze-page');
        }
        return rows as T;
      },
      $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
        const changed = await tx.$executeRawUnsafe(sql, ...values);
        if (sql.includes('INSERT INTO liekan_storage_candidate'))
          expect(changed).toBeLessThanOrEqual(50000);
        return changed;
      },
    });
    const cutoffs = {
      completedCutoff: new Date(Date.now() - 86400000).toISOString(),
      wakeCutoff: new Date(Date.now() - 3600000).toISOString(),
      shortCutoff: new Date(Date.now() - 3600000).toISOString(),
    };
    const run = randomUUID(),
      pages: Page[] = [],
      repeated: Page[] = [],
      interrupted: Page[] = [];
    let freezeMs = 0,
      repeatMs = 0;
    const transactionStarted = performance.now();
    await transaction(async () => {
      await client.query("SET LOCAL statement_timeout='15s'");
      // Match preview creation: the FK target and every candidate page share one transaction.
      await client.query(
        "INSERT INTO liekan_storage_cleanup VALUES($1,NULL,'instance','preview')",
        [run],
      );
      const started = performance.now();
      expect(await freezeCompletedJobs(record(pages), run, cutoffs)).toBe(total);
      freezeMs = performance.now() - started;
    });
    const transactionMs = performance.now() - transactionStarted;
    await transaction(async () => {
      await client.query("SET LOCAL statement_timeout='15s'");
      const again = performance.now();
      expect(await freezeCompletedJobs(record(repeated), run, cutoffs)).toBe(0);
      repeatMs = performance.now() - again;
    });
    expect(pages.map(page => page.selected)).toEqual([...Array(18).fill(50000), 20000]);
    expect(pages.map(page => page.inserted)).toEqual(pages.map(page => page.selected));
    expect(repeated.map(page => page.selected)).toEqual(pages.map(page => page.selected));
    expect(repeated.every(page => page.inserted === 0)).toBe(true);
    expect(pages[0]).toMatchObject({ name: managedQueue, selected: 50000 });
    expect(pages[10]).toMatchObject({ name: secondQueue, selected: 50000, id: pages[0].id });
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count,count(DISTINCT(queue_name,record_id))::int AS unique_jobs
      FROM liekan_storage_candidate WHERE run_id=$1`,
          [run],
        )
      ).rows,
    ).toEqual([{ count: total, unique_jobs: total }]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS missing FROM "${jobSchema}".job j WHERE NOT EXISTS(
      SELECT 1 FROM liekan_storage_candidate c WHERE c.run_id=$1 AND c.kind='job' AND c.record_id=j.id AND c.queue_name=j.name)`,
          [run],
        )
      ).rows[0].missing,
    ).toBe(0);

    const rollbackRun = randomUUID(),
      rollbackStarted = performance.now();
    await expect(
      transaction(async () => {
        await client.query("SET LOCAL statement_timeout='15s'");
        await client.query(
          "INSERT INTO liekan_storage_cleanup VALUES($1,NULL,'instance','preview')",
          [rollbackRun],
        );
        await freezeCompletedJobs(record(interrupted, 2), rollbackRun, cutoffs);
      }),
    ).rejects.toThrow('interrupted-after-freeze-page');
    const rollbackMs = performance.now() - rollbackStarted;
    expect(interrupted.map(page => page.inserted)).toEqual([50000, 50000]);
    expect(
      (
        await client.query(
          'SELECT count(*)::int AS count FROM liekan_storage_candidate WHERE run_id=$1',
          [rollbackRun],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await client.query(
          'SELECT count(*)::int AS count FROM liekan_storage_cleanup WHERE id=$1',
          [rollbackRun],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await client.query(
          'SELECT count(*)::int AS count FROM liekan_storage_candidate WHERE run_id=$1',
          [run],
        )
      ).rows[0].count,
    ).toBe(total);
    expect(
      (await client.query(`SELECT count(*)::int AS count FROM "${jobSchema}".job_common`)).rows[0]
        .count,
    ).toBe(total);
    process.stdout.write(
      `${JSON.stringify({
        event: 'storage-freeze-fk-benchmark',
        jobs: total,
        sharedUuids: total - firstQueueRows,
        pages: pages.length,
        pageLimit: 50000,
        sourceMs: Math.round(sourceMs),
        transactionMs: Math.round(transactionMs),
        freezeMs: Math.round(freezeMs),
        repeatMs: Math.round(repeatMs),
        maxPageMs: Math.round(
          Math.max(...[...pages, ...repeated, ...interrupted].map(page => page.ms)),
        ),
        rollbackMs: Math.round(rollbackMs),
      })}\n`,
    );
  }, 180000);
});
