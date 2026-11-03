// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AnalysisTx } from './analysis-rollups-model';
import { collectGenerationBatch, previewGenerations } from './storage-generation-gc';

vi.mock('./server', () => ({ primary: vi.fn(), LiekanError: class extends Error {} }));

import { assertAnalysisGenerationWritable, chargeAnalysisGeneration } from './analysis-rollups-db';

const enabled = process.env.LIEKAN_STORAGE_GC_TEST === '1';
const schema = `liekan_storage_gc_test_${randomUUID().replaceAll('-', '')}`;
const cutoff = new Date('2026-02-01T00:00:00Z');
const tables = [
  'liekan_analysis_log',
  'liekan_analysis_path',
  'liekan_analysis_visit',
  'liekan_analysis_browser_detail',
  'liekan_analysis_browser_visit',
  'liekan_analysis_browser_path',
];
let client: Client;
let created = false;
const tx: AnalysisTx = {
  $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) =>
    (await client.query(sql, values)).rows as T,
  $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rowCount || 0,
};
async function transaction<T>(site: string, work: () => Promise<T>) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout='1s'");
    await client.query("SET LOCAL lock_timeout='200ms'");
    await client.query('SELECT website_id FROM website WHERE website_id=$1 FOR UPDATE', [site]);
    await client.query(
      'SELECT website_id FROM liekan_analysis_site WHERE website_id=$1 FOR UPDATE',
      [site],
    );
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
async function website() {
  const site = randomUUID();
  await client.query('INSERT INTO website VALUES($1)', [site]);
  await client.query('INSERT INTO liekan_analysis_site(website_id) VALUES($1)', [site]);
  await client.query('INSERT INTO liekan_log VALUES($1,$2,7)', [randomUUID(), site]);
  await client.query('INSERT INTO website_event VALUES($1,$2,9)', [randomUUID(), site]);
  return site;
}
async function generation(site: string, bytes = 1000, at = '2026-01-01T00:00:00Z') {
  const id = randomUUID();
  await client.query(
    'INSERT INTO liekan_analysis_generation(website_id,generation,estimated_bytes,updated_at) VALUES($1,$2,$3,$4)',
    [site, id, bytes, at],
  );
  await client.query(
    'UPDATE liekan_analysis_site SET derived_bytes=derived_bytes+$2 WHERE website_id=$1',
    [site, bytes],
  );
  return id;
}
async function facts(site: string, id: string, count = 2) {
  for (let n = 0; n < count; n++) {
    // Two partitions share ctid values, exercising the tableoid/ctid deletion key.
    const bucket = n % 2 ? '2026-01-02T00:00:00Z' : '2026-01-01T00:00:00Z';
    await client.query(
      `INSERT INTO liekan_analysis_log(website_id,generation,grain,bucket,dimensions,dimension_key,requests,first_at,last_at)
       VALUES($1,$2,'hour',$3,'{}',$4,11,$3,$3)`,
      [site, id, bucket, String(n)],
    );
    await client.query(
      `INSERT INTO liekan_analysis_path(website_id,generation,bucket,path,dimensions,dimension_key,requests,first_at,last_at)
       VALUES($1,$2,$3,$4,'{}','d',13,$3,$3)`,
      [site, id, bucket, `/p${n}`],
    );
    const session = randomUUID(),
      visit = randomUUID();
    await client.query(
      `INSERT INTO liekan_analysis_visit(website_id,generation,bucket,session_id,visit_id,dimensions,dimension_key,pageviews,has_custom)
       VALUES($1,$2,$3,$4,$5,'{}','d',17,false)`,
      [site, id, bucket, session, visit],
    );
    await client.query(
      `INSERT INTO liekan_analysis_browser_visit(website_id,generation,bucket,session_id,visit_id,pageviews,has_custom)
       VALUES($1,$2,$3,$4,$5,17,false)`,
      [site, id, bucket, session, visit],
    );
    await client.query(
      `INSERT INTO liekan_analysis_browser_path(website_id,generation,bucket,session_id,visit_id,path,event_type,event_name,name_missing,events,pageviews,dwell_total,dwell_samples)
       VALUES($1,$2,$3,$4,$5,'/a',1,'',true,19,19,23,1)`,
      [site, id, bucket, session, visit],
    );
  }
  await client.query(
    "INSERT INTO liekan_analysis_browser_detail(website_id,generation,format,complete) VALUES($1,$2,'test-v1',true)",
    [site, id],
  );
}
async function counts(site: string, id: string) {
  return Promise.all(
    tables.map(async table => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE website_id=$1 AND generation=$2`,
        [site, id],
      );
      return rows[0].n;
    }),
  );
}
async function ledger(site: string, id: string) {
  const { rows } = await client.query(
    'SELECT gc_started_at,estimated_bytes FROM liekan_analysis_generation WHERE website_id=$1 AND generation=$2',
    [site, id],
  );
  return rows[0];
}
async function capacity(site: string) {
  return (
    await client.query(
      'SELECT derived_bytes::text AS bytes FROM liekan_analysis_site WHERE website_id=$1',
      [site],
    )
  ).rows[0].bytes;
}
const batch = (site: string, limit = 2000, runId?: string) =>
  transaction(site, () => collectGenerationBatch(tx, site, cutoff, limit, runId));

describe.skipIf(!enabled)('isolated PostgreSQL generation garbage collection', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/^\/liekan_storage_(?:gc_)?test(?:_[a-z0-9]+)?$/.test(url.pathname) ||
      url.searchParams.get('schema') === 'public'
    )
      throw new Error('GC integration requires a dedicated loopback storage test database');
    url.searchParams.delete('schema');
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE website(website_id uuid PRIMARY KEY);
      CREATE TABLE liekan_analysis_site(website_id uuid PRIMARY KEY REFERENCES website,derived_bytes bigint NOT NULL DEFAULT 0 CHECK(derived_bytes>=0));
      CREATE TABLE liekan_analysis_build(id uuid PRIMARY KEY,website_id uuid NOT NULL,status text NOT NULL,checkpoint jsonb NOT NULL);
      CREATE TABLE liekan_analysis_manifest(id uuid PRIMARY KEY,website_id uuid NOT NULL,epoch bigint NOT NULL,generation uuid NOT NULL,previous_generation uuid);
      CREATE TABLE liekan_storage_candidate(run_id uuid,kind text,record_id uuid,queue_name text NOT NULL DEFAULT '',PRIMARY KEY(run_id,kind,queue_name,record_id));
      CREATE TABLE liekan_log(id uuid PRIMARY KEY,website_id uuid,requests integer);
      CREATE TABLE website_event(event_id uuid PRIMARY KEY,website_id uuid,pageviews integer)`);
    const migration = async (name: string) =>
      readFile(new URL(`../../../../db/liekan/migrations/${name}`, import.meta.url), 'utf8');
    const rollups = await migration('037_analytics_rollups.sql');
    const visits = await migration('038_analytics_visits.sql');
    const browsers = await migration('050_browser_detail_facts.sql');
    for (const table of ['liekan_analysis_generation', ...tables]) {
      const source =
        table === 'liekan_analysis_visit'
          ? visits
          : table.includes('_browser_')
            ? browsers
            : rollups;
      const definition = source.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?;`))?.[0];
      if (!definition) throw new Error(`Missing production table definition: ${table}`);
      await client.query(definition);
      if (table !== 'liekan_analysis_generation' && table !== 'liekan_analysis_browser_detail') {
        await client.query(`CREATE TABLE ${table}_day1 PARTITION OF ${table} FOR VALUES FROM ('2026-01-01T00:00:00Z') TO ('2026-01-02T00:00:00Z');
          CREATE TABLE ${table}_day2 PARTITION OF ${table} FOR VALUES FROM ('2026-01-02T00:00:00Z') TO ('2026-01-03T00:00:00Z')`);
      }
    }
    await client.query(
      'ALTER TABLE liekan_analysis_generation ADD COLUMN gc_started_at timestamptz',
    );
    const storage = await migration('057_storage_retention.sql');
    for (const index of storage.matchAll(/CREATE INDEX liekan_analysis_[\s\S]*?;/g))
      await client.query(index[0]);
  });
  afterAll(async () => {
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client?.end();
  });

  it.each(['queued', 'running', 'paused', 'failed', 'capacity_limited'])(
    'preserves every family of a %s checkpoint without an age exemption',
    async status => {
      const site = await website(),
        id = await generation(site);
      await facts(site, id);
      await client.query('INSERT INTO liekan_analysis_build VALUES($1,$2,$3,$4)', [
        randomUUID(),
        site,
        status,
        { generation: id },
      ]);
      expect(await previewGenerations(tx, site, cutoff)).toEqual({
        candidateCount: 0,
        protectedCount: 1,
        estimatedBytes: '0',
      });
      expect(await batch(site)).toEqual({
        rowsDeleted: 0,
        generationsDeleted: 0,
        releasedBytes: '0',
        more: false,
      });
      expect(await counts(site, id)).toEqual([2, 2, 2, 1, 2, 2]);
      expect((await ledger(site, id)).gc_started_at).toBeNull();
      expect(await capacity(site)).toBe('1000');
    },
  );

  it('preserves current and previous generations in every epoch and published metrics', async () => {
    const site = await website();
    const protectedIds: string[] = [];
    for (const epoch of [1, 8]) {
      const current = await generation(site),
        previous = await generation(site);
      protectedIds.push(current, previous);
      await facts(site, current);
      await facts(site, previous);
      await client.query('INSERT INTO liekan_analysis_manifest VALUES($1,$2,$3,$4,$5)', [
        randomUUID(),
        site,
        epoch,
        current,
        previous,
      ]);
    }
    const metrics = async () =>
      (
        await client.query(
          `SELECT m.epoch,sum(f.requests)::text AS requests
      FROM liekan_analysis_manifest m JOIN liekan_analysis_log f ON f.website_id=m.website_id AND f.generation=m.generation
      WHERE m.website_id=$1 GROUP BY m.epoch ORDER BY m.epoch`,
          [site],
        )
      ).rows;
    const before = await metrics();
    expect(before).toEqual([
      { epoch: '1', requests: '22' },
      { epoch: '8', requests: '22' },
    ]);
    const disposable = await generation(site);
    await facts(site, disposable);
    expect(await previewGenerations(tx, site, cutoff)).toEqual({
      candidateCount: 1,
      protectedCount: 4,
      estimatedBytes: '1000',
    });
    expect((await batch(site)).generationsDeleted).toBe(1);
    expect(await metrics()).toEqual(before);
    for (const id of protectedIds) expect(await counts(site, id)).toEqual([2, 2, 2, 1, 2, 2]);
    expect(
      (await client.query('SELECT requests FROM liekan_log WHERE website_id=$1', [site])).rows,
    ).toEqual([{ requests: 7 }]);
    expect(
      (await client.query('SELECT pageviews FROM website_event WHERE website_id=$1', [site])).rows,
    ).toEqual([{ pageviews: 9 }]);
  });

  it('bounds the total across six families, rolls back interruption and releases bytes once', async () => {
    const site = await website(),
      id = await generation(site);
    await facts(site, id);
    expect(await batch(site, 2)).toEqual({
      rowsDeleted: 2,
      generationsDeleted: 0,
      releasedBytes: '0',
      more: true,
    });
    const marked = await ledger(site, id);
    expect(marked.gc_started_at).toBeInstanceOf(Date);
    expect(await capacity(site)).toBe('1000');
    const saved = await counts(site, id);
    await expect(
      transaction(site, async () => {
        await collectGenerationBatch(tx, site, cutoff, 2);
        throw new Error('interrupted-after-batch');
      }),
    ).rejects.toThrow('interrupted-after-batch');
    expect(await counts(site, id)).toEqual(saved);
    expect((await ledger(site, id)).gc_started_at).toEqual(marked.gc_started_at);
    let deleted = 2,
      released = 0n,
      generations = 0;
    for (let n = 0; n < 10; n++) {
      const result = await batch(site, 2);
      expect(result.rowsDeleted).toBeLessThanOrEqual(2);
      deleted += result.rowsDeleted;
      released += BigInt(result.releasedBytes);
      generations += result.generationsDeleted;
      if (result.more) {
        expect(result.releasedBytes).toBe('0');
        expect(await capacity(site)).toBe('1000');
      } else break;
    }
    expect(deleted).toBe(11);
    expect(generations).toBe(1);
    expect(released).toBe(1000n);
    expect(await counts(site, id)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await ledger(site, id)).toBeUndefined();
    expect(await capacity(site)).toBe('0');
    expect(await batch(site)).toEqual({
      rowsDeleted: 0,
      generationsDeleted: 0,
      releasedBytes: '0',
      more: false,
    });
    expect(await capacity(site)).toBe('0');
  });

  it('reclaims terminal checkpoints, protects recent generations and freezes run membership', async () => {
    const site = await website(),
      run = randomUUID();
    const completed = await generation(site),
      invalidated = await generation(site);
    const recent = await generation(site, 1000, '2026-03-01T00:00:00Z'),
      later = await generation(site);
    for (const [id, status] of [
      [completed, 'completed'],
      [invalidated, 'invalidated'],
    ]) {
      await client.query('INSERT INTO liekan_analysis_build VALUES($1,$2,$3,$4)', [
        randomUUID(),
        site,
        status,
        { generation: id },
      ]);
      await client.query("INSERT INTO liekan_storage_candidate VALUES($1,'generation',$2,'')", [
        run,
        id,
      ]);
    }
    const result = await batch(site, 2000, run);
    expect(result).toEqual({
      rowsDeleted: 0,
      generationsDeleted: 2,
      releasedBytes: '2000',
      more: false,
    });
    expect(await ledger(site, completed)).toBeUndefined();
    expect(await ledger(site, invalidated)).toBeUndefined();
    expect((await ledger(site, recent)).gc_started_at).toBeNull();
    expect((await ledger(site, later)).gc_started_at).toBeNull();
    expect(await capacity(site)).toBe('2000');
  });

  it('rejects late publication and writes while collection is resumable', async () => {
    const site = await website(),
      id = await generation(site);
    await facts(site, id);
    await batch(site, 1);
    await expect(
      transaction(site, () => assertAnalysisGenerationWritable(tx, site, id)),
    ).rejects.toThrow('analysis-generation-collecting');
    await expect(
      transaction(site, () => chargeAnalysisGeneration(tx, site, id, '100')),
    ).rejects.toThrow('analysis-generation-collecting');
    expect((await ledger(site, id)).estimated_bytes).toBe('1000');
    expect(await capacity(site)).toBe('1000');
  });

  it('caps the selected generation set and resumes a collecting generation first', async () => {
    const site = await website(),
      active = await generation(site, 1000, '2026-01-31T00:00:00Z');
    await facts(site, active);
    await batch(site, 1);
    for (let n = 0; n < 22; n++) await generation(site, 10, '2025-01-01T00:00:00Z');
    await batch(site, 1);
    expect((await counts(site, active))[0]).toBe(0);
    const all = (
      await client.query(
        'SELECT count(*)::int AS n FROM liekan_analysis_generation WHERE website_id=$1',
        [site],
      )
    ).rows[0].n;
    expect(all).toBe(4);
    const done = await batch(site);
    expect(done.generationsDeleted).toBe(4);
    expect(done.more).toBe(false);
    expect((await batch(site)).more).toBe(false);
  });

  it('shares 2,000 fact deletions across large, small and empty generations without a residual cascade', async () => {
    const site = await website(),
      run = randomUUID(),
      large = await generation(site, 5000),
      small = await generation(site, 100),
      empty = await generation(site, 10),
      outside = await generation(site, 1000);
    await facts(site, large);
    await facts(site, small, 1);
    await facts(site, outside, 1);
    await client.query(
      `INSERT INTO liekan_analysis_log(website_id,generation,grain,bucket,dimensions,dimension_key,requests,first_at,last_at)
       SELECT $1,$2,'hour','2026-01-01T00:00:00Z','{}','bulk-'||n,11,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'
       FROM generate_series(1,2500) n`,
      [site, large],
    );
    for (const id of [large, small, empty])
      await client.query("INSERT INTO liekan_storage_candidate VALUES($1,'generation',$2,'')", [
        run,
        id,
      ]);
    const before = [...(await counts(site, large)), ...(await counts(site, small))].reduce(
      (sum, n) => sum + n,
      0,
    );
    expect(before).toBe(2517);
    expect(await batch(site, 2000, run)).toEqual({
      rowsDeleted: 2000,
      generationsDeleted: 1,
      releasedBytes: '10',
      more: true,
    });
    const largeLeft = await counts(site, large),
      smallLeft = await counts(site, small);
    expect([...largeLeft, ...smallLeft].reduce((sum, n) => sum + n, 0)).toBe(517);
    expect(largeLeft.slice(1)).toEqual([2, 2, 1, 2, 2]);
    expect(smallLeft.slice(1)).toEqual([1, 1, 1, 1, 1]);
    expect(await ledger(site, large)).toBeDefined();
    expect(await ledger(site, small)).toBeDefined();
    expect(await ledger(site, empty)).toBeUndefined();
    expect(await capacity(site)).toBe('6100');
    expect(await batch(site, 2000, run)).toEqual({
      rowsDeleted: 517,
      generationsDeleted: 2,
      releasedBytes: '5100',
      more: false,
    });
    expect(await counts(site, large)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await counts(site, small)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await counts(site, outside)).toEqual([1, 1, 1, 1, 1, 1]);
    expect((await ledger(site, outside)).gc_started_at).toBeNull();
    expect(await capacity(site)).toBe('1000');
    expect(await batch(site, 2000, run)).toEqual({
      rowsDeleted: 0,
      generationsDeleted: 0,
      releasedBytes: '0',
      more: false,
    });
  });

  it('streams 62,000 frozen candidates past 10,000 protected ledgers and removes collected members', async () => {
    const site = await website(),
      run = randomUUID();
    await client.query(
      `INSERT INTO liekan_analysis_generation(website_id,generation,estimated_bytes,updated_at)
       SELECT $1::uuid,md5($1::text||':'||n)::uuid,10,'2025-01-01T00:00:00Z' FROM generate_series(1,62000) n`,
      [site],
    );
    await client.query(
      `INSERT INTO liekan_analysis_generation(website_id,generation,estimated_bytes,updated_at)
       SELECT $1::uuid,md5($1::text||':protected:'||n)::uuid,10,'2024-01-01T00:00:00Z' FROM generate_series(1,10000) n`,
      [site],
    );
    await client.query(
      `INSERT INTO liekan_analysis_manifest(id,website_id,epoch,generation)
       SELECT generation,website_id,1,generation FROM liekan_analysis_generation
       WHERE website_id=$1 AND updated_at='2024-01-01T00:00:00Z'`,
      [site],
    );
    await client.query('UPDATE liekan_analysis_site SET derived_bytes=720000 WHERE website_id=$1', [
      site,
    ]);
    await client.query(
      `INSERT INTO liekan_storage_candidate(run_id,kind,record_id)
       SELECT $2::uuid,'generation',generation FROM liekan_analysis_generation
       WHERE website_id=$1 AND updated_at='2025-01-01T00:00:00Z'`,
      [site, run],
    );
    await client.query('ANALYZE liekan_analysis_generation');
    await client.query('ANALYZE liekan_storage_candidate');
    await client.query('ANALYZE liekan_analysis_manifest');
    let plan: { Plans?: unknown[] };
    const observedTx: AnalysisTx = {
      ...tx,
      $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) => {
        if (sql.startsWith('WITH candidates'))
          plan = (await client.query(`EXPLAIN(FORMAT JSON) ${sql}`, values)).rows[0][
            'QUERY PLAN'
          ][0].Plan;
        return tx.$queryRawUnsafe<T>(sql, ...values);
      },
    };
    const started = performance.now();
    const result = await transaction(site, () =>
      collectGenerationBatch(observedTx, site, cutoff, 2000, run),
    );
    console.info(
      `GC 62,000 candidates + 10,000 protected ledgers: ${Math.round(performance.now() - started)}ms`,
    );
    expect(result).toEqual({
      rowsDeleted: 0,
      generationsDeleted: 20,
      releasedBytes: '200',
      more: true,
    });
    expect(await capacity(site)).toBe('719800');
    const nodes = (node: any): any[] => [node, ...(node.Plans || []).flatMap(nodes)];
    expect(nodes(plan).some(node => node['Index Name'] === 'liekan_storage_candidate_pkey')).toBe(
      true,
    );
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM liekan_storage_candidate WHERE run_id=$1 AND kind='generation' AND queue_name=''",
          [run],
        )
      ).rows[0].n,
    ).toBe(61980);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS n FROM liekan_analysis_generation g
       JOIN liekan_analysis_manifest m USING(website_id,generation)
       WHERE g.website_id=$1 AND g.gc_started_at IS NULL`,
          [site],
        )
      ).rows[0].n,
    ).toBe(10000);
  });

  it.each(['fresh', 'collecting'])(
    'honors the four-generation production budget for %s candidates',
    async state => {
      const site = await website();
      for (let n = 0; n < 8; n++) await generation(site, 10);
      if (state === 'collecting')
        await client.query(
          'UPDATE liekan_analysis_generation SET gc_started_at=clock_timestamp() WHERE website_id=$1',
          [site],
        );
      const run = () =>
        transaction(site, () => collectGenerationBatch(tx, site, cutoff, 2000, undefined, 4));
      expect(await run()).toEqual({
        rowsDeleted: 0,
        generationsDeleted: 4,
        releasedBytes: '40',
        more: true,
      });
      expect(await capacity(site)).toBe('40');
      expect(await run()).toEqual({
        rowsDeleted: 0,
        generationsDeleted: 4,
        releasedBytes: '40',
        more: false,
      });
      expect(await capacity(site)).toBe('0');
    },
  );
});
