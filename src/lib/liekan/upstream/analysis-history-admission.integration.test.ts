// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisTx } from './analysis-rollups-model';

const h = vi.hoisted(() => ({ transactions: vi.fn(), capacity: vi.fn(), work: vi.fn() }));
vi.mock('./analysis-rollups-db', () => ({
  analysisTransaction: (work: any) => h.transactions(work),
  analysisCapacity: (tx: any, site: string) => h.capacity(tx, site),
}));
vi.mock('./analysis-rollups-worker', () => ({ runOneAnalysisWorkUnit: h.work }));

import { withAnalysisPermit } from './analysis-background';
import { pumpAnalysisBuilds } from './analysis-build-queue';

const enabled = process.env.LIEKAN_STORAGE_GC_TEST === '1';
const schema = `liekan_history_admission_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
let client: Client;
let created = false;
const tx: AnalysisTx = {
  $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) =>
    (await client.query(sql, values)).rows as T,
  $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rowCount || 0,
};
async function transaction<T>(work: (raw: AnalysisTx) => Promise<T>) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout='2s'");
    const result = await work(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
async function pending(automatic = false) {
  const website = randomUUID(),
    id = randomUUID();
  await client.query('INSERT INTO website VALUES($1)', [website]);
  await client.query('INSERT INTO liekan_analysis_site(website_id) VALUES($1)', [website]);
  await client.query(
    `INSERT INTO liekan_analysis_build(
    id,website_id,actor_id,automatic_history,epoch,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total)
    VALUES($1,$2,$3,$4,1,now()-interval '2 days',now()-interval '1 day','UTC','en-US',$1,'history-admission','queued',1)`,
    [id, website, automatic ? null : randomUUID(), automatic],
  );
  return { id, website };
}
async function capacity(gate: 'site' | 'global', high: boolean, website: string) {
  if (gate === 'site')
    await client.query('UPDATE liekan_analysis_site SET derived_bytes=$2 WHERE website_id=$1', [
      website,
      high ? '980000000' : '0',
    ]);
  else
    await client.query('UPDATE history_test_capacity SET bytes=$1 WHERE id', [
      high ? '7730941133' : '0',
    ]);
}
async function waiting() {
  return (
    await client.query(
      'SELECT history_waiting_at,interactive_turns,token,lease_until FROM liekan_analysis_background_lease WHERE id',
    )
  ).rows[0];
}

describe.skipIf(!enabled)(
  'isolated PostgreSQL history capacity admission and permit fairness',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL || '');
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !['/liekan_storage_test', '/liekan_storage_gc_test'].includes(url.pathname) ||
        url.searchParams.get('schema') === 'public'
      )
        throw new Error('History admission requires a dedicated loopback storage test database');
      url.searchParams.delete('schema');
      client = new Client({ connectionString: url.toString() });
      await client.connect();
      await client.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await client.query(`SET search_path TO "${schema}"`);
      await client.query('CREATE TABLE website(website_id uuid PRIMARY KEY)');
      for (const [file, table] of [
        ['037_analytics_rollups.sql', 'liekan_analysis_site'],
        ['037_analytics_rollups.sql', 'liekan_analysis_build'],
        ['039_analytics_query_jobs.sql', 'liekan_analysis_background_lease'],
      ]) {
        const source = await readFile(
          new URL(`../../../../db/liekan/migrations/${file}`, import.meta.url),
          'utf8',
        );
        const definition = source.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?;`))?.[0];
        if (!definition) throw new Error(`Missing production table definition: ${table}`);
        await client.query(definition);
      }
      await client.query(`ALTER TABLE liekan_analysis_site ADD COLUMN incremental_served_at timestamptz,ADD COLUMN history_served_at timestamptz;
      ALTER TABLE liekan_analysis_build ADD COLUMN automatic_history boolean NOT NULL DEFAULT false;
      CREATE TABLE liekan_analysis_meter(website_id uuid,bytes bigint);
      CREATE TABLE liekan_analysis_query(id uuid PRIMARY KEY,website_id uuid,status text,target text,attempts integer,result_bytes bigint);
      CREATE TABLE liekan_dashboard_snapshot(job_id uuid,last_read_at timestamptz,website_id uuid,result_bytes bigint);
      CREATE TABLE liekan_report_fragment(website_id uuid,result_bytes bigint);
      CREATE TABLE liekan_analytics_input_summary(website_id uuid);
      CREATE TABLE liekan_analytics_input_state(website_id uuid);
      CREATE TABLE liekan_geo_weight_head(task_status text);
      CREATE TABLE liekan_history_repair_run(status text);
      CREATE TABLE history_test_capacity(id boolean PRIMARY KEY CHECK(id),bytes bigint NOT NULL);
      INSERT INTO liekan_analysis_background_lease(id) VALUES(true);
      INSERT INTO history_test_capacity VALUES(true,0)`);
      h.transactions.mockImplementation(transaction);
      // The production site SQL and lease SQL execute in PostgreSQL. This bounded fixture supplies
      // the global physical-size observation without allocating several GiB of test relations.
      h.capacity.mockImplementation(async (raw: AnalysisTx) => {
        const [row] = await raw.$queryRawUnsafe<{ bytes: string }[]>(
          'SELECT bytes::text AS bytes FROM history_test_capacity WHERE id',
        );
        return {
          globalBytes: row.bytes,
          globalLimit: 8 * 1024 ** 3,
          siteBytes: '0',
          siteLimit: 1024 ** 3,
        };
      });
    });
    beforeEach(async () => {
      await client.query(`TRUNCATE liekan_analysis_build,liekan_analysis_site,website;
      UPDATE liekan_analysis_background_lease SET token=NULL,lease_until=NULL,epoch=0,interactive_turns=5,incremental_waiting_at=NULL,history_waiting_at=now() WHERE id;
      UPDATE history_test_capacity SET bytes=0 WHERE id`);
      h.capacity.mockClear();
    });
    afterAll(async () => {
      if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client?.end();
    });

    it.each([
      ['site', false],
      ['global', false],
      ['site', true],
      ['global', true],
    ] as const)(
      'keeps interactive work moving above the %s limit and restores low-water fairness for automatic=%s',
      async (gate, automatic) => {
        const task = await pending(automatic),
          boss = { send: vi.fn(async () => randomUUID()) };
        await capacity(gate, true, task.website);
        await pumpAnalysisBuilds(boss);
        expect(boss.send).not.toHaveBeenCalled();
        expect(
          (await withAnalysisPermit('interactive', async () => 'interactive-ran')).acquired,
        ).toBe(true);
        expect((await waiting()).history_waiting_at).toBeNull();
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM liekan_analysis_build WHERE status='queued'",
            )
          ).rows[0].count,
        ).toBe(1);

        await capacity(gate, false, task.website);
        await pumpAnalysisBuilds(boss);
        expect(boss.send).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          { id: task.id, kind: 'history' },
          expect.any(Object),
        );
        expect((await waiting()).history_waiting_at).toBeInstanceOf(Date);
        expect((await withAnalysisPermit('interactive', async () => 'must-yield')).acquired).toBe(
          false,
        );
        expect((await withAnalysisPermit('history', async () => 'history-ran')).acquired).toBe(
          true,
        );
        for (let turn = 0; turn < 5; turn++)
          expect((await withAnalysisPermit('interactive', async () => true)).acquired).toBe(true);
        expect(
          (await withAnalysisPermit('interactive', async () => 'must-yield-again')).acquired,
        ).toBe(false);
      },
    );

    it.each(['site', 'global'] as const)(
      'does not restore blocked history demand when the %s limit is crossed during a permit',
      async gate => {
        const task = await pending(),
          boss = { send: vi.fn(async () => randomUUID()) };
        await pumpAnalysisBuilds(boss);
        expect((await waiting()).history_waiting_at).toBeInstanceOf(Date);
        expect(
          (await withAnalysisPermit('history', async () => capacity(gate, true, task.website)))
            .acquired,
        ).toBe(true);
        expect(await waiting()).toMatchObject({
          history_waiting_at: null,
          token: null,
          lease_until: null,
        });
        await client.query(
          'UPDATE liekan_analysis_background_lease SET interactive_turns=5 WHERE id',
        );
        expect((await withAnalysisPermit('interactive', async () => true)).acquired).toBe(true);
        expect(
          (await client.query('SELECT status FROM liekan_analysis_build WHERE id=$1', [task.id]))
            .rows[0].status,
        ).toBe('queued');
      },
    );
  },
);
