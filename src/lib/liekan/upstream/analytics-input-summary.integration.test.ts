// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const enabled = process.env.LIEKAN_ANALYSIS_ROLLUPS_TEST === '1';
const actor = randomUUID();
const end = '2026-01-02T01:02:30.000001Z';
let maintenance: typeof import('./analytics-input-summary') | undefined;
let client: PgClient, connect: () => Promise<PgClient>, site: string, schema: string;
const q = async <T = Record<string, any>>(text: string, ...values: unknown[]): Promise<T[]> =>
  (await client.query(text, values)).rows;
const fingerprint = async (ends = end, epoch = 1) =>
  (
    await q(
      'SELECT liekan_dashboard_fingerprint_v2($1::uuid,$2::bigint,$3::timestamptz) AS value',
      site,
      epoch,
      ends,
    )
  )[0].value as string;
const legacy = async (ends = end) =>
  (
    await q('SELECT liekan_dashboard_fingerprint($1::uuid,1,$2::timestamptz) AS value', site, ends)
  )[0].value as string;
const state = async () =>
  (
    await q(
      'SELECT * FROM liekan_analytics_input_state WHERE website_id=$1::uuid AND epoch=1',
      site,
    )
  )[0];
const step = async () =>
  (await q('SELECT liekan_analytics_input_backfill($1::uuid) AS n', site))[0].n as number;
async function finish() {
  for (let pass = 0; pass < 12; pass++) {
    if ((await state())?.ready) return;
    await step();
  }
  throw new Error('Input summary failed to finish its bounded fixture');
}
async function mark(source: 'coarse' | 'fine', family: string, at: string, shard = 0) {
  const table = source === 'coarse' ? 'liekan_analysis_dirty' : 'liekan_dashboard_dirty';
  await q(
    `INSERT INTO ${table}(website_id,epoch,family,bucket,shard) VALUES($1::uuid,1,$2,$3::timestamptz,$4)
   ON CONFLICT(website_id,epoch,family,bucket,shard) DO UPDATE SET revision=${table}.revision+1`,
    site,
    family,
    at,
    shard,
  );
}

describe.skipIf(!enabled)('transactional daily input summaries in owned PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || 'http://invalid');
    schema = url.searchParams.get('schema') || '';
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '15462' ||
      url.pathname !== '/liekan_analysis_rollups_test' ||
      !/^analysis_[a-f0-9]+$/.test(schema)
    )
      throw new Error('Only the owned PostgreSQL15462 analysis schema is allowed');
    url.searchParams.delete('schema');
    const { Client } = await import('pg');
    connect = async () => {
      const connection = new Client({ connectionString: url.toString() });
      await connection.connect();
      await connection.query(`SET search_path TO "${schema}"`);
      await connection.query("SET statement_timeout='3s'");
      return connection;
    };
    client = await connect();
    await q(
      "INSERT INTO \"user\"(user_id,username,password,role) VALUES($1::uuid,$1,'synthetic','user')",
      actor,
    );
  });
  beforeEach(async () => {
    site = randomUUID();
    await q(
      "INSERT INTO website(website_id,user_id,name,domain) VALUES($1::uuid,$2::uuid,'Synthetic summary fixture','summary.invalid')",
      site,
      actor,
    );
  });
  afterEach(async () => {
    if (client) {
      await q('ROLLBACK');
      await q('DELETE FROM website WHERE website_id=$1::uuid', site);
    }
  });
  afterAll(async () => {
    if (client) {
      await q('DELETE FROM "user" WHERE user_id=$1::uuid', actor);
      await client.end();
      if (maintenance) await (await import('@/lib/prisma')).default.client.$disconnect();
    }
  });

  it('uses the original fingerprint before readiness and preserves all marker facts through backfill', async () => {
    await mark('coarse', 'log', '2025-01-01T00:05Z');
    await mark('coarse', 'visit', '2025-01-01T01:00Z', 7);
    await mark('fine', 'detail', '2025-01-01T01:00:30Z', 11);
    const original = await q(
      `SELECT 'coarse' AS source,to_jsonb(d) AS fact FROM liekan_analysis_dirty d WHERE website_id=$1::uuid
     UNION ALL SELECT 'fine',to_jsonb(d) FROM liekan_dashboard_dirty d WHERE website_id=$1::uuid ORDER BY 1,2`,
      site,
    );
    const initial = await fingerprint();
    expect(initial).toBe(`input-summary-v1:legacy:pending:${await legacy()}`);
    await q('DELETE FROM liekan_analytics_input_summary WHERE website_id=$1::uuid', site);
    expect(await step()).toBe(2);
    expect((await state()).ready).toBe(false);
    expect(await fingerprint()).toContain(':legacy:');
    await finish();
    const completed = await fingerprint();
    expect(completed).toMatch(/^input-summary-v1:[a-f0-9-]{36}:[a-f0-9]{64}$/);
    expect(await fingerprint()).toBe(completed);
    expect(await fingerprint('2026-01-02T01:02:31Z')).toBe(completed);
    expect(
      await q(
        `SELECT 'coarse' AS source,to_jsonb(d) AS fact FROM liekan_analysis_dirty d WHERE website_id=$1::uuid
     UNION ALL SELECT 'fine',to_jsonb(d) FROM liekan_dashboard_dirty d WHERE website_id=$1::uuid ORDER BY 1,2`,
        site,
      ),
    ).toEqual(original);
  });

  it('matches every original dependency predicate including old details, global markers and microseconds', async () => {
    await finish();
    const cases: ['coarse' | 'fine', string, string, boolean][] = [
      ['coarse', 'log', '2020-01-01T00:00Z', true],
      ['coarse', 'visit', '2020-01-01T00:00Z', true],
      ['fine', 'detail', '2020-01-01T00:00Z', true],
      ['coarse', 'log', '2026-01-02T00:55Z', true],
      ['coarse', 'log', '2026-01-02T01:00Z', false],
      ['coarse', 'visit', '2026-01-02T00:00Z', true],
      ['coarse', 'visit', '2026-01-02T01:00Z', false],
      ['fine', 'log', '2026-01-02T00:59:30Z', false],
      ['fine', 'log', '2026-01-02T01:00Z', true],
      ['fine', 'visit', '2026-01-02T00:59:30Z', false],
      ['fine', 'visit', '2026-01-02T01:00Z', true],
      ['fine', 'detail', '2026-01-02T01:02:30Z', true],
      ['fine', 'log', '2026-01-02T01:02:30Z', true],
      ['fine', 'visit', '2026-01-02T01:02:30Z', true],
      ['fine', 'detail', end, false],
      ['fine', 'log', end, false],
      ['fine', 'visit', end, false],
      ['coarse', 'log', '2026-01-03T00:00Z', false],
      ['coarse', 'visit', '2026-01-03T00:00Z', false],
      ['fine', 'detail', '2026-01-03T00:00Z', false],
      ['coarse', 'log', '-infinity', true],
      ['coarse', 'visit', '-infinity', true],
      ['fine', 'detail', '-infinity', true],
      ['fine', 'log', '-infinity', true],
      ['fine', 'visit', '-infinity', true],
    ];
    for (const [source, family, at, included] of cases) {
      const before = await fingerprint(),
        beforeLegacy = await legacy();
      await mark(source, family, at);
      expect((await legacy()) !== beforeLegacy, `${source}/${family}/${at} oracle`).toBe(included);
      expect((await fingerprint()) !== before, `${source}/${family}/${at} summary`).toBe(included);
    }
  });

  it('detects membership changes at thirty-second, five-minute, hour and UTC-day edges', async () => {
    await mark('fine', 'detail', '2026-01-02T00:00:30Z');
    await mark('coarse', 'log', '2026-01-02T00:00Z');
    await mark('fine', 'log', '2026-01-02T00:00Z');
    await mark('coarse', 'visit', '2026-01-02T00:00Z');
    await mark('fine', 'visit', '2026-01-02T00:00Z');
    await mark('fine', 'detail', '2026-01-01T23:59:30Z');
    await finish();
    for (const [a, b] of [
      ['2026-01-02T00:00:30Z', '2026-01-02T00:00:30.000001Z'],
      ['2026-01-02T00:04:59.999999Z', '2026-01-02T00:05:00Z'],
      ['2026-01-02T00:59:59.999999Z', '2026-01-02T01:00:00Z'],
      ['2026-01-01T23:59:30Z', '2026-01-02T00:00:00.000001Z'],
    ]) {
      expect(await legacy(a)).not.toBe(await legacy(b));
      expect(await fingerprint(a)).not.toBe(await fingerprint(b));
    }
  });

  it('captures real source insert/update/delete and rolls back summary changes with source facts', async () => {
    const imported = randomUUID(),
      log = randomUUID(),
      session = randomUUID(),
      detail = randomUUID();
    await q(
      'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$1,1,0)',
      imported,
      site,
    );
    await q('INSERT INTO session(session_id,website_id) VALUES($1::uuid,$2::uuid)', session, site);
    await finish();
    let before = await fingerprint();
    await q(
      `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
     VALUES($1,$2::uuid,$3::uuid,'2025-01-01T00:00Z','/a','GET',200,0,'','','GPTBot/fixture','','GPTBot','OpenAI','synthetic','verified_range',true,'recognized')`,
      log,
      site,
      imported,
    );
    expect(await fingerprint()).not.toBe(before);
    before = await fingerprint();
    await q("UPDATE liekan_log SET path='/b' WHERE id=$1", log);
    expect(await fingerprint()).not.toBe(before);
    before = await fingerprint();
    await q('BEGIN');
    await q("UPDATE liekan_log SET path='/rollback' WHERE id=$1", log);
    expect(await fingerprint()).not.toBe(before);
    await q('ROLLBACK');
    expect(await fingerprint()).toBe(before);
    await q(
      `INSERT INTO session_data(session_data_id,website_id,session_id,data_key,data_type,string_value,created_at)
     VALUES($1::uuid,$2::uuid,$3::uuid,'synthetic',1,'a','2024-01-01T00:00Z')`,
      detail,
      site,
      session,
    );
    expect(await fingerprint()).not.toBe(before);
    before = await fingerprint();
    await q("UPDATE session_data SET string_value='b' WHERE session_data_id=$1::uuid", detail);
    expect(await fingerprint()).not.toBe(before);
    before = await fingerprint();
    await q('DELETE FROM session_data WHERE session_data_id=$1::uuid', detail);
    expect(await fingerprint()).not.toBe(before);
    before = await fingerprint();
    await q('DELETE FROM liekan_log WHERE id=$1', log);
    expect(await fingerprint()).not.toBe(before);
    expect((await state()).ready).toBe(true);
  });

  it('invalidates readiness and fallback identity on marker deletion and each truncate', async () => {
    await mark('coarse', 'log', '2025-01-01T00:00Z');
    await mark('fine', 'detail', '2025-01-01T00:00Z');
    await finish();
    const ready = await fingerprint();
    await q('DELETE FROM liekan_analysis_dirty WHERE website_id=$1::uuid', site);
    expect((await state()).ready).toBe(false);
    expect(await fingerprint()).not.toBe(ready);
    const fallback = await fingerprint();
    await mark('coarse', 'log', '2025-01-01T00:00Z');
    await q('DELETE FROM liekan_analysis_dirty WHERE website_id=$1::uuid', site);
    expect(await fingerprint()).not.toBe(fallback);
    await finish();
    const rebuilt = await fingerprint();
    expect(rebuilt).not.toBe(ready);
    for (const table of [
      'liekan_analysis_dirty',
      'liekan_dashboard_dirty',
      'liekan_analytics_input_summary',
    ]) {
      await q('BEGIN');
      await q(`TRUNCATE ${table}`);
      expect((await state()).ready, table).toBe(false);
      expect(await fingerprint(), table).toContain(':legacy:');
      expect(await fingerprint(), table).not.toBe(rebuilt);
      await q('ROLLBACK');
      expect(await fingerprint()).toBe(rebuilt);
    }
  });

  it('captures both marker identities across key moves and preserves empty or unchanged transitions', async () => {
    await mark('coarse', 'log', '2020-01-01T00:00Z', 3);
    await mark('fine', 'detail', '2020-01-01T00:00Z', 5);
    await finish();
    const summaries = () =>
      q(
        `SELECT epoch::text,source,family,to_char(day AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
         shard,revision::text FROM liekan_analytics_input_summary WHERE website_id=$1::uuid
         ORDER BY epoch,source,family,day,shard`,
        site,
      );
    const facts = () =>
      q(
        `SELECT 'coarse' AS source,to_jsonb(d) AS fact FROM liekan_analysis_dirty d WHERE website_id=$1::uuid
         UNION ALL SELECT 'fine',to_jsonb(d) FROM liekan_dashboard_dirty d WHERE website_id=$1::uuid ORDER BY 1,2`,
        site,
      );
    const initial = {
      legacy: await legacy(),
      fingerprint: await fingerprint(),
      summaries: await summaries(),
      facts: await facts(),
      generation: (await state()).generation,
    };
    const mutate = async (sql: string, included: boolean) => {
      const beforeLegacy = await legacy(),
        before = await fingerprint();
      await q(sql, site);
      expect((await legacy()) !== beforeLegacy, `${sql} legacy membership`).toBe(included);
      expect((await fingerprint()) !== before, `${sql} summary membership`).toBe(included);
    };

    await q('BEGIN');
    try {
      const [{ shard: writerShard }] = await q<{ shard: number }>(
        'SELECT (txid_current()%32)::int AS shard',
      );
      await mutate(
        `UPDATE liekan_dashboard_dirty SET family='log',bucket='2020-01-02T00:00Z',shard=7
         WHERE website_id=$1::uuid AND family='detail'`,
        true,
      );
      const withoutDetail = await summaries();
      await mutate(
        `UPDATE liekan_dashboard_dirty SET family='visit',bucket='2020-01-02T01:00Z',shard=8
         WHERE website_id=$1::uuid AND family='log'`,
        false,
      );
      expect(await summaries()).toEqual(withoutDetail);
      await mutate(
        `UPDATE liekan_dashboard_dirty SET family='detail',bucket='2020-01-03T00:00Z',shard=9
         WHERE website_id=$1::uuid AND family='visit'`,
        true,
      );
      await mutate(
        `UPDATE liekan_analysis_dirty SET epoch=2,family='visit',bucket='2020-01-04T00:00Z',shard=11
         WHERE website_id=$1::uuid AND epoch=1 AND family='log'`,
        true,
      );
      await mutate(
        `UPDATE liekan_analysis_dirty SET epoch=1,bucket='2020-01-05T00:00Z',shard=13
         WHERE website_id=$1::uuid AND epoch=2 AND family='visit'`,
        true,
      );
      await mutate(
        `UPDATE liekan_analysis_dirty SET shard=14
         WHERE website_id=$1::uuid AND epoch=1 AND family='visit'`,
        true,
      );
      const moved = await summaries();
      const key = (row: Record<string, any>) =>
        [row.epoch, row.source, row.family, row.day, row.shard].join(':');
      const expected = new Map(initial.summaries.map(row => [key(row), row]));
      for (const [epoch, source, family, day, delta] of [
        ['1', 'coarse', 'log', '2020-01-01', 1],
        ['1', 'coarse', 'visit', '2020-01-05', 3],
        ['1', 'fine', 'detail', '2020-01-01', 1],
        ['1', 'fine', 'detail', '2020-01-03', 1],
        ['2', 'coarse', 'visit', '2020-01-04', 2],
      ] as const) {
        const row = { epoch, source, family, day, shard: writerShard };
        expected.set(key(row), {
          ...row,
          revision: String(Number(expected.get(key(row))?.revision || 0) + delta),
        });
      }
      expect(new Map(moved.map(row => [key(row), row]))).toEqual(expected);
      for (const table of ['liekan_analysis_dirty', 'liekan_dashboard_dirty']) {
        await mutate(`UPDATE ${table} SET revision=revision WHERE website_id=$1::uuid`, false);
        await mutate(
          `UPDATE ${table} SET revision=revision+1 WHERE website_id=$1::uuid AND false`,
          false,
        );
      }
      expect(await summaries()).toEqual(moved);
      expect((await state()).ready).toBe(true);
      expect((await state()).generation).toBe(initial.generation);
    } finally {
      await q('ROLLBACK');
    }
    expect(await legacy()).toBe(initial.legacy);
    expect(await fingerprint()).toBe(initial.fingerprint);
    expect(await summaries()).toEqual(initial.summaries);
    expect(await facts()).toEqual(initial.facts);
    expect((await state()).generation).toBe(initial.generation);
    expect((await state()).ready).toBe(true);
  });

  it('folds 32 original shards into one transaction token and rolls back savepoints atomically', async () => {
    await finish();
    const initial = await fingerprint();
    const tokens = () =>
      q(
        `SELECT shard,revision::text FROM liekan_analytics_input_summary
         WHERE website_id=$1::uuid AND epoch=1 ORDER BY shard`,
        site,
      );
    await q('BEGIN');
    try {
      const [{ shard }] = await q<{ shard: number }>('SELECT (txid_current()%32)::int AS shard');
      await q(
        `INSERT INTO liekan_analysis_dirty(website_id,epoch,family,bucket,shard)
         SELECT $1::uuid,1,'log','2020-01-01Z'::timestamptz,n::smallint FROM generate_series(0,31)n`,
        site,
      );
      expect(await tokens()).toEqual([{ shard, revision: '32' }]);
      const inserted = await fingerprint();
      expect(inserted).not.toBe(initial);
      await q('SAVEPOINT token_update');
      await q(
        'UPDATE liekan_analysis_dirty SET revision=revision+1 WHERE website_id=$1::uuid',
        site,
      );
      expect(await tokens()).toEqual([{ shard, revision: '96' }]);
      expect(await fingerprint()).not.toBe(inserted);
      await q('ROLLBACK TO SAVEPOINT token_update');
      expect(await tokens()).toEqual([{ shard, revision: '32' }]);
      expect(await fingerprint()).toBe(inserted);
      expect(
        await q(
          'SELECT count(*)::int AS n,min(revision)::text AS min,max(revision)::text AS max FROM liekan_analysis_dirty WHERE website_id=$1::uuid',
          site,
        ),
      ).toEqual([{ n: 32, min: '1', max: '1' }]);
    } finally {
      await q('ROLLBACK');
    }
    expect(await tokens()).toEqual([]);
    expect(await fingerprint()).toBe(initial);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_dirty WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(0);
  });

  it('preserves concurrent transaction-slot increments across matching and distinct backfill seed slots', async () => {
    await mark('coarse', 'log', '2020-01-01T00:00Z', 0);
    await mark('coarse', 'log', '2020-01-02T00:00Z', 1);
    await q('DELETE FROM liekan_analytics_input_summary WHERE website_id=$1::uuid', site);
    const writer = await connect(),
      other = await connect();
    const operations: Promise<unknown>[] = [];
    const beginSlotZero = async (connection: PgClient) => {
      for (let attempt = 0; attempt < 128; attempt++) {
        await connection.query('BEGIN');
        const { rows } = await connection.query('SELECT (txid_current()%32)::int AS shard');
        if (rows[0].shard === 0) return;
        await connection.query('ROLLBACK');
      }
      throw new Error('Could not allocate the fixture transaction slot');
    };
    const waitForBlock = async (waiting: number, holding: number) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const [{ blocked }] = await q<{ blocked: boolean }>(
          'SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked',
          holding,
          waiting,
        );
        if (blocked) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error('The fixture did not overlap the summary-row writers');
    };
    const tokens = () =>
      q(
        `SELECT to_char(day AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,shard,revision::text
         FROM liekan_analytics_input_summary WHERE website_id=$1::uuid AND epoch=1
         ORDER BY day,shard`,
        site,
      );
    try {
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
        otherPid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await beginSlotZero(writer);
      await writer.query(
        'UPDATE liekan_analysis_dirty SET revision=revision+1 WHERE website_id=$1::uuid',
        [site],
      );
      const backfill = other.query('SELECT liekan_analytics_input_backfill($1::uuid) AS n', [site]);
      void backfill.catch(() => {});
      operations.push(backfill);
      await waitForBlock(otherPid, writerPid);
      await writer.query('COMMIT');
      expect((await backfill).rows[0].n).toBe(2);
      await finish();
      expect(await tokens()).toEqual([
        { day: '2020-01-01', shard: 0, revision: '2' },
        { day: '2020-01-02', shard: 0, revision: '2' },
        { day: '2020-01-02', shard: 1, revision: '1' },
      ]);
      const before = await fingerprint(),
        generation = (await state()).generation;
      await beginSlotZero(writer);
      await writer.query(
        "UPDATE liekan_analysis_dirty SET revision=revision+1 WHERE website_id=$1::uuid AND bucket='2020-01-01Z'",
        [site],
      );
      await beginSlotZero(other);
      const concurrent = other.query(
        `INSERT INTO liekan_analysis_dirty(website_id,epoch,family,bucket,shard)
         VALUES($1::uuid,1,'log','2020-01-01T00:05Z',2)`,
        [site],
      );
      void concurrent.catch(() => {});
      operations.push(concurrent);
      await waitForBlock(otherPid, writerPid);
      await writer.query('COMMIT');
      await concurrent;
      await other.query('COMMIT');
      expect(await tokens()).toEqual([
        { day: '2020-01-01', shard: 0, revision: '5' },
        { day: '2020-01-02', shard: 0, revision: '2' },
        { day: '2020-01-02', shard: 1, revision: '1' },
      ]);
      expect(await fingerprint()).not.toBe(before);
      expect((await state()).ready).toBe(true);
      expect((await state()).generation).toBe(generation);
      expect(
        (
          await q(
            'SELECT count(*)::int AS n FROM liekan_analysis_dirty WHERE website_id=$1::uuid',
            site,
          )
        )[0].n,
      ).toBe(3);
    } finally {
      await writer.query('ROLLBACK');
      await Promise.allSettled(operations);
      await other.query('ROLLBACK');
      await writer.end();
      await other.end();
    }
  }, 20000);

  it('fences direct token rewrites while nested updates leave progress unlocked', async () => {
    await mark('coarse', 'log', '2025-01-01T00:00Z');
    await finish();
    const before = await fingerprint(),
      generation = (await state()).generation;
    const locker = await connect();
    try {
      await locker.query('BEGIN');
      await locker.query(
        'SELECT 1 FROM liekan_analytics_input_state WHERE website_id=$1::uuid FOR UPDATE',
        [site],
      );
      await mark('coarse', 'log', '2025-01-01T00:00Z');
      expect(await fingerprint()).not.toBe(before);
    } finally {
      await locker.query('ROLLBACK');
      await locker.end();
    }
    expect((await state()).generation).toBe(generation);
    expect((await state()).ready).toBe(true);
    await q('UPDATE liekan_analytics_input_summary SET revision=1 WHERE website_id=$1::uuid', site);
    expect((await state()).ready).toBe(false);
    expect((await state()).generation).not.toBe(generation);
    expect(await fingerprint()).not.toBe(before);
    await finish();
    expect(await fingerprint()).not.toBe(before);
  });

  it('bounds backfill keys and retains concurrent earlier-key writes across committed checkpoints', async () => {
    await q(
      `INSERT INTO liekan_analysis_dirty(website_id,epoch,family,bucket,shard)
     SELECT $1::uuid,1,'log','2025-01-01Z'::timestamptz+n*interval '5 minutes',(n%32)::smallint FROM generate_series(0,4999)n`,
      site,
    );
    await q('DELETE FROM liekan_analytics_input_summary WHERE website_id=$1::uuid', site);
    const writer = await connect();
    try {
      await q('BEGIN');
      expect(await step()).toBe(2048);
      expect((await state()).ready).toBe(false);
      await writer.query(
        `INSERT INTO liekan_analysis_dirty(website_id,epoch,family,bucket,shard)
       VALUES($1::uuid,1,'log','2020-01-01Z',31)`,
        [site],
      );
      await q('COMMIT');
      expect((await state()).cursor_bucket).toEqual(new Date('2025-01-08T02:35Z'));
      expect(await step()).toBe(2048);
      expect(await step()).toBe(904);
      expect((await state()).ready).toBe(false);
      await finish();
      expect(
        (
          await q(
            `SELECT count(*)::int AS n FROM liekan_analytics_input_summary WHERE website_id=$1::uuid AND day='2020-01-01Z'`,
            site,
          )
        )[0].n,
      ).toBe(1);
      const before = await fingerprint();
      await mark('coarse', 'log', '2020-01-01Z', 31);
      expect(await fingerprint()).not.toBe(before);
      expect(
        (
          await q(
            'SELECT count(*)::int AS n FROM liekan_analysis_dirty WHERE website_id=$1::uuid',
            site,
          )
        )[0].n,
      ).toBe(5001);
    } finally {
      await q('ROLLBACK');
      await writer.end();
    }
  });

  it('bounds stale-epoch cleanup and preserves current capture and every original marker', async () => {
    await q(
      `INSERT INTO liekan_analysis_dirty(website_id,epoch,family,bucket,shard)
     SELECT $1::uuid,1,'log','2020-01-01Z'::timestamptz+n*interval '1 day',(n%32)::smallint FROM generate_series(0,599)n`,
      site,
    );
    await finish();
    await q('UPDATE liekan_analysis_site SET epoch=2 WHERE website_id=$1::uuid', site);
    await q(
      "INSERT INTO liekan_analysis_dirty(website_id,epoch,family,bucket,shard) VALUES($1::uuid,2,'log','2026-01-01Z',0)",
      site,
    );
    await step();
    await step();
    maintenance = await import('./analytics-input-summary');
    const oldRows = async () =>
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analytics_input_summary WHERE website_id=$1::uuid AND epoch=1',
          site,
        )
      )[0].n;
    const globalStaleRows = async () =>
      (
        await q(`SELECT count(*)::int AS n FROM liekan_analytics_input_summary d
         JOIN liekan_analysis_site s USING(website_id) WHERE d.epoch<>s.epoch`)
      )[0].n as number;
    const oldStates = async () =>
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analytics_input_state WHERE website_id=$1::uuid AND epoch=1',
          site,
        )
      )[0].n as number;
    const initialStaleRows = await globalStaleRows();
    const initialOwnedRows = await oldRows();
    const currentRows = () =>
      q(
        `SELECT to_jsonb(d) AS fact FROM liekan_analytics_input_summary d
         WHERE website_id=$1::uuid AND epoch=2 ORDER BY source,family,day,shard`,
        site,
      );
    const sourceRows = () =>
      q(
        'SELECT to_jsonb(d) AS fact FROM liekan_analysis_dirty d WHERE website_id=$1::uuid ORDER BY epoch,family,bucket,shard',
        site,
      );
    const initialCurrentRows = await currentRows(),
      initialSourceRows = await sourceRows();
    const [{ n: initialStaleStates }] =
      await q(`SELECT count(*)::int AS n FROM liekan_analytics_input_state p
     JOIN liekan_analysis_site s USING(website_id) WHERE p.epoch<>s.epoch`);
    const maxPasses = Math.ceil(initialStaleRows / 512) + Math.ceil(initialStaleStates / 16) + 1;
    expect(initialOwnedRows).toBeGreaterThan(0);
    expect(initialStaleRows).toBeGreaterThanOrEqual(initialOwnedRows);
    // Earlier suites may retain stale epochs. Each pass shares its global budget.
    for (
      let pass = 0;
      pass < maxPasses && ((await oldRows()) > 0 || (await oldStates()) > 0);
      pass++
    ) {
      const before = await globalStaleRows(),
        ownedBefore = await oldRows();
      await maintenance.maintainAnalyticsInputSummaries();
      expect(await globalStaleRows()).toBe(Math.max(0, before - 512));
      const ownedAfter = await oldRows();
      expect(ownedAfter).toBeGreaterThanOrEqual(Math.max(0, ownedBefore - 512));
      expect(ownedAfter).toBeLessThanOrEqual(ownedBefore);
    }
    expect(await oldRows()).toBe(0);
    expect(await oldStates()).toBe(0);
    expect(await currentRows()).toEqual(initialCurrentRows);
    expect(await sourceRows()).toEqual(initialSourceRows);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM liekan_analysis_dirty WHERE website_id=$1::uuid',
          site,
        )
      )[0].n,
    ).toBe(601);
  });

  it('never publishes a summary from an obsolete site epoch and preserves installed search paths', async () => {
    await mark('coarse', 'log', '2025-01-01Z');
    await finish();
    const before = await fingerprint();
    await q('UPDATE liekan_analysis_site SET epoch=epoch+1 WHERE website_id=$1::uuid', site);
    expect(await fingerprint()).toContain(':legacy:');
    expect(await fingerprint()).not.toBe(before);
    expect(await fingerprint(end, 2)).toContain(':legacy:pending:');
    const routines = await q(
      `SELECT p.proname,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname=$1 AND p.proname IN('liekan_dashboard_fingerprint_v2','liekan_analytics_input_backfill','liekan_analytics_input_capture','liekan_analytics_input_removed','liekan_analytics_input_summary_updated')`,
      schema,
    );
    expect(routines).toHaveLength(5);
    for (const routine of routines)
      expect(routine.proconfig).toEqual([`search_path=${schema}, pg_temp`]);
    await q('SET search_path=public');
    try {
      const [qualified] = await q(
        `SELECT "${schema}".liekan_dashboard_fingerprint_v2($1::uuid,2,$2::timestamptz) AS value`,
        site,
        end,
      );
      expect(qualified.value).toContain(':legacy:pending:');
    } finally {
      await q(`SET search_path TO "${schema}"`);
    }
  });
});
