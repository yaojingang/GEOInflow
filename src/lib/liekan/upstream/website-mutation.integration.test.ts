// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sqlStatements } from '../../../../scripts/liekan-sql-statements.mjs';

const enabled = process.env.LIEKAN_WEBSITE_LIFECYCLE_TEST === '1';
const schema = 'website_mutation_' + randomUUID().replaceAll('-', '');
const actor = randomUUID(),
  other = randomUUID(),
  team = randomUUID();
let control: pg.Client, prisma: typeof import('@/lib/prisma').default;
let resetWebsite: typeof import('@/queries/prisma/website').resetWebsite;
let deleteWebsite: typeof import('@/queries/prisma/website').deleteWebsite;
const q = (sql: string, params: unknown[] = []) => control.query(sql, params);

async function fixture(rows: number, teamOwned = false) {
  const site = randomUUID();
  await q(
    `INSERT INTO website(website_id,name,domain,user_id,team_id) VALUES($1,'Lifecycle test','example.test',$2,$3)`,
    [site, teamOwned ? null : actor, teamOwned ? team : null],
  );
  const tables = ['session', 'website_event', 'event_data'];
  // Load synthetic source facts directly; mutation assertions exercise the normal enabled triggers.
  for (const table of tables) await q(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  try {
    await q(
      `INSERT INTO session(session_id,website_id) SELECT gen_random_uuid(),$1 FROM generate_series(1,$2::int)`,
      [site, rows],
    );
    await q(
      `INSERT INTO website_event(event_id,website_id,session_id,visit_id,url_path) SELECT gen_random_uuid(),website_id,session_id,gen_random_uuid(),'/test' FROM session WHERE website_id=$1`,
      [site],
    );
    await q(
      `INSERT INTO event_data(event_data_id,website_id,website_event_id,data_key,data_type,string_value) SELECT gen_random_uuid(),website_id,event_id,'test',1,'synthetic' FROM website_event WHERE website_id=$1`,
      [site],
    );
  } finally {
    for (const table of tables) await q(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
  for (const table of tables) await q(`ANALYZE ${table}`);
  return site;
}
async function counts(site: string) {
  const result = await q(
    `SELECT (SELECT count(*)::int FROM session WHERE website_id=$1) AS sessions,(SELECT count(*)::int FROM website_event WHERE website_id=$1) AS events,(SELECT count(*)::int FROM event_data WHERE website_id=$1) AS properties`,
    [site],
  );
  return result.rows[0];
}
async function blocked(sql: string, params: unknown[]) {
  const connection = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await connection.connect();
  try {
    await connection.query(`SET search_path TO "${schema}"`);
    await connection.query("SET lock_timeout TO '150ms'");
    await expect(connection.query(sql, params)).rejects.toMatchObject({ code: '55P03' });
  } finally {
    await connection.end();
  }
}

// Instrument the real transaction after its first event batch; every SQL call still uses PostgreSQL.
function pauseAfterBatch(fail = false) {
  let enter: () => void, resume: () => void;
  const entered = new Promise<void>(resolve => {
    enter = resolve;
  });
  const released = new Promise<void>(resolve => {
    resume = resolve;
  });
  let paused = false;
  const original = prisma.transaction.bind(prisma);
  const spy = vi.spyOn(prisma, 'transaction').mockImplementation(((work: any, options: any) =>
    original(async (tx: any) => {
      const proxy = new Proxy(tx, {
        get(target, key) {
          if (key !== '$executeRawUnsafe') return Reflect.get(target, key);
          return async (sql: string, ...params: unknown[]) => {
            let result: number;
              try { result = await target.$executeRawUnsafe(sql, ...params); }
              catch (error) { console.error('Mutation SQL failure:', sql.match(/^(?:DELETE FROM|UPDATE) [a-z_]+/)?.[0]); throw error; }
            if (!paused && sql.startsWith('DELETE FROM website_event') && sql.includes('LIMIT')) {
              paused = true;
              enter();
              await released;
              if (fail) throw new Error('Injected batch failure');
            }
            return result;
          };
        },
      });
      return work(proxy);
    }, options)) as any);
  return { entered, resume: () => resume(), restore: () => spy.mockRestore() };
}

describe.runIf(enabled)('website mutations on isolated PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
    expect(url.pathname).toBe('/lifecycle_test');
    control = new pg.Client({ connectionString: url.toString() });
    await control.connect();
    await q(`CREATE SCHEMA "${schema}"`);
    await q(`SET search_path TO "${schema}"`);
    for (const folder of ['prisma/migrations', 'db/liekan/migrations']) {
      for (const file of (await readdir(folder))
        .filter(f => (folder.startsWith('prisma') ? /^\d/.test(f) : f.endsWith('.sql')))
        .sort()) {
        await q('BEGIN');
        try {
          const source = await readFile(
            `${folder}/${file}${folder.startsWith('prisma') ? '/migration.sql' : ''}`,
            'utf8',
          );
          for (const sql of sqlStatements(source)) await q(sql);
          await q('COMMIT');
        } catch (error) {
          await q('ROLLBACK');
          throw error;
        }
      }
    }
    url.searchParams.set('schema', schema);
    process.env.DATABASE_URL = url.toString();
    process.env.CLICKHOUSE_URL = '';
    process.env.REDIS_URL = '';
    process.env.LIEKAN_ANALYTICS_REDIS_URL = '';
    prisma = (await import('@/lib/prisma')).default;
    ({ resetWebsite, deleteWebsite } = await import('@/queries/prisma/website'));
    await q(
      `INSERT INTO "user"(user_id,username,password,role) VALUES($1,'mutation-actor','disabled-test-login','user'),($2,'mutation-other','disabled-test-login','user')`,
      [actor, other],
    );
    await q(`INSERT INTO team(team_id,name) VALUES($1,'Mutation test')`, [team]);
    await q(
      `INSERT INTO team_user(team_user_id,team_id,user_id,role) VALUES($1,$2,$3,'team-owner')`,
      [randomUUID(), team, actor],
    );
  }, 60000);
  afterAll(async () => {
    vi.restoreAllMocks();
    if (prisma) await prisma.client.$disconnect();
    if (control) {
      await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await control.end();
    }
  });

  it('resets 300003 source rows beyond the old 30-second budget while fencing transfer, revocation and collection', async () => {
    const site = await fixture(100001, true);
    const gate = pauseAfterBatch();
    const start = Date.now();
    const pending = resetWebsite(site, { userId: actor });
    try {
      await Promise.race([
        gate.entered,
        pending.then(() => {
          throw new Error('Expected a real event deletion batch');
        }),
      ]);
      // Other connections retain the committed population throughout the destructive transaction.
      expect(await counts(site)).toEqual({ sessions: 100001, events: 100001, properties: 100001 });
      await blocked(`UPDATE website SET user_id=$2,team_id=NULL WHERE website_id=$1`, [
        site,
        other,
      ]);
      await blocked(`UPDATE team_user SET role='team-view-only' WHERE team_id=$1 AND user_id=$2`, [
        team,
        actor,
      ]);
      await blocked(`SELECT website_id FROM website WHERE website_id=$1 FOR SHARE`, [site]);
      // Model a slow large-site operation after a real batch has executed.
      await new Promise(resolve => setTimeout(resolve, 31000));
    } finally {
      gate.resume();
    }
    await pending;
    gate.restore();
    expect(Date.now() - start).toBeGreaterThan(30000);
    expect(await counts(site)).toEqual({ sessions: 0, events: 0, properties: 0 });
    expect(
      (await q(`SELECT reset_at FROM website WHERE website_id=$1`, [site])).rows[0].reset_at,
    ).toBeTruthy();
    await q(`UPDATE website SET user_id=$2,team_id=NULL WHERE website_id=$1`, [site, other]);
    await expect(resetWebsite(site, { userId: actor })).rejects.toMatchObject({ status: 403 });
  }, 180000);

  it('rolls back executed batches when a later batch fails', async () => {
    const site = await fixture(6001);
    const gate = pauseAfterBatch(true);
    const pending = resetWebsite(site, { userId: actor });
    const outcome = pending.then(() => null, error => error);
    await Promise.race([
      gate.entered,
      pending.then(() => {
        throw new Error('Expected a real event deletion batch');
      }),
    ]);
    gate.resume();
    expect((await outcome)?.message).toContain('Injected batch failure');
    gate.restore();
    expect(await counts(site)).toEqual({ sessions: 6001, events: 6001, properties: 6001 });
    expect(
      (await q(`SELECT reset_at FROM website WHERE website_id=$1`, [site])).rows[0].reset_at,
    ).toBeNull();
  }, 60000);

  it('hard deletes a populated website without removing another website', async () => {
    const site = await fixture(12001),
      survivor = await fixture(3);
    await deleteWebsite(site, { userId: actor });
    expect((await q(`SELECT website_id FROM website WHERE website_id=$1`, [site])).rowCount).toBe(
      0,
    );
    expect(await counts(site)).toEqual({ sessions: 0, events: 0, properties: 0 });
    expect(await counts(survivor)).toEqual({ sessions: 3, events: 3, properties: 3 });
  }, 60000);

  it('hard deletes rollback references spanning robots deployment batches', async () => {
    const site = await fixture(1);
    await q(
      `INSERT INTO liekan_robots_deployment(id,website_id,actor_id,agent_id,context,hostname,revision,expected_hash,target_hash,state)
      SELECT gen_random_uuid(),$1,$2,$2,'test','example.test',1,repeat('a',64),repeat('b',64),'verified' FROM generate_series(1,5000)`,
      [site, actor],
    );
    await q(
      `INSERT INTO liekan_robots_deployment(id,website_id,actor_id,agent_id,context,hostname,revision,expected_hash,target_hash,state,rollback_of)
      SELECT gen_random_uuid(),website_id,actor_id,agent_id,context,hostname,revision,expected_hash,target_hash,state,id FROM liekan_robots_deployment WHERE website_id=$1 LIMIT 1`,
      [site],
    );
    expect(
      (
        await q('SELECT count(*)::int AS n FROM liekan_robots_deployment WHERE website_id=$1', [
          site,
        ])
      ).rows[0].n,
    ).toBe(5001);
    await deleteWebsite(site, { userId: actor });
    expect(
      (await q('SELECT id FROM liekan_robots_deployment WHERE website_id=$1', [site])).rowCount,
    ).toBe(0);
  }, 60000);

  it('rejects revoked authority before hard-delete batches execute', async () => {
    const site = await fixture(3);
    await q(`UPDATE website SET user_id=$2 WHERE website_id=$1`, [site, other]);
    await expect(deleteWebsite(site, { userId: actor })).rejects.toMatchObject({ status: 403 });
    expect(await counts(site)).toEqual({ sessions: 3, events: 3, properties: 3 });
  });

  it('preserves settings during cloud soft deletion', async () => {
    const site = await fixture(3);
    await q(`INSERT INTO liekan_setting(website_id) VALUES($1)`, [site]);
    process.env.CLOUD_MODE = '1';
    try {
      await deleteWebsite(site, { userId: actor });
    } finally {
      delete process.env.CLOUD_MODE;
    }
    expect(
      (await q(`SELECT deleted_at FROM website WHERE website_id=$1`, [site])).rows[0].deleted_at,
    ).toBeTruthy();
    expect(
      (await q(`SELECT website_id FROM liekan_setting WHERE website_id=$1`, [site])).rowCount,
    ).toBe(1);
    expect(await counts(site)).toEqual({ sessions: 0, events: 0, properties: 0 });
  }, 60000);
});
