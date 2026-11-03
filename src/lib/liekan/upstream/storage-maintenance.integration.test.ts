// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AnalysisTx } from './analysis-rollups-model';

const h = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('./server', async () => ({
  primary: () => ({ $transaction: h.transaction }),
  lockWritableWebsite: vi.fn(),
  LiekanError: (await import('./errors')).LiekanError,
}));
vi.mock('./analysis-rollups-db', () => ({
  analysisCapacity: vi.fn(),
  analysisTransaction: vi.fn(),
}));
vi.mock('./crawler-access', () => ({ authorizeCrawler: vi.fn() }));
vi.mock('./ai-db', () => ({ aiExecutor: vi.fn() }));

import { pumpStorageRetention } from './storage-retention';

const enabled = process.env.LIEKAN_STORAGE_GC_TEST === '1';
const schema = `liekan_storage_maintenance_${randomUUID().replaceAll('-', '')}`;
let client: Client;
let confirmation: Client;
let created = false;
const tx: AnalysisTx = {
  $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) =>
    (await client.query(sql, values)).rows as T,
  $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rowCount || 0,
};
const boss = { deleteJob: vi.fn() };

async function run(status: string, expired = true) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO liekan_storage_cleanup(id,scope_key,kind,status,policy_revision,conditions,request_id,request_hash,expires_at)
     VALUES($1,'instance',$2,$3,0,'{}',$1,'fixture',clock_timestamp()+$4*interval '1 day')`,
    [id, ['queued', 'running'].includes(status) ? 'scheduled' : 'manual', status, expired ? -1 : 1],
  );
  const record = randomUUID();
  for (const queue of ['liekan-analysis-query', 'liekan-analysis-build'])
    await client.query("INSERT INTO liekan_storage_candidate VALUES($1,'job',$2,$3)", [
      id,
      record,
      queue,
    ]);
  return id;
}

async function candidateCount(id: string) {
  return (
    await client.query('SELECT count(*)::int AS n FROM liekan_storage_candidate WHERE run_id=$1', [
      id,
    ])
  ).rows[0].n;
}

describe.skipIf(!enabled)('isolated PostgreSQL storage metadata maintenance', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !['/liekan_storage_test', '/liekan_storage_gc_test'].includes(url.pathname) ||
      url.searchParams.get('schema') === 'public'
    )
      throw new Error('Storage maintenance requires a dedicated loopback storage test database');
    url.searchParams.delete('schema');
    client = new Client({ connectionString: url.toString() });
    confirmation = new Client({ connectionString: url.toString() });
    await client.connect();
    await confirmation.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await client.query(`SET search_path TO "${schema}"`);
    await confirmation.query(`SET search_path TO "${schema}"`);
    await client.query('CREATE TABLE website(website_id uuid PRIMARY KEY)');
    const source = await readFile(
      new URL('../../../../db/liekan/migrations/057_storage_retention.sql', import.meta.url),
      'utf8',
    );
    for (const table of [
      'liekan_storage_cleanup',
      'liekan_storage_candidate',
      'liekan_storage_operation',
    ]) {
      const definition = source.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?;`))?.[0];
      if (!definition) throw new Error(`Missing production definition: ${table}`);
      await client.query(definition);
    }
    await client.query(
      await readFile(
        new URL(
          '../../../../db/liekan/migrations/061_storage_candidate_queue_identity.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    url.searchParams.set('schema', schema);
    vi.stubEnv('DATABASE_URL', url.toString());
    vi.stubEnv('CLICKHOUSE_URL', '');
    h.transaction.mockImplementation(async (work: (value: AnalysisTx) => Promise<unknown>) => {
      await client.query('BEGIN');
      try {
        const result = await work(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  });
  afterEach(async () => {
    await confirmation?.query('ROLLBACK');
    await client?.query('DELETE FROM liekan_storage_cleanup');
  });
  afterAll(async () => {
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await confirmation?.end();
    await client?.end();
    vi.unstubAllEnvs();
  });

  it('preserves frozen candidates while a confirmation transaction owns the run', async () => {
    const id = await run('preview');
    await confirmation.query('BEGIN');
    // Confirmation has accepted the preview and queued it, while other sessions still see
    // the previously committed, now-expired preview until this transaction commits.
    await confirmation.query("UPDATE liekan_storage_cleanup SET status='queued' WHERE id=$1", [id]);
    await pumpStorageRetention(boss, { schedule: false, manualOnly: true });
    expect(await candidateCount(id)).toBe(2);
    await confirmation.query('COMMIT');
    expect(
      (await client.query('SELECT status FROM liekan_storage_cleanup WHERE id=$1', [id])).rows[0]
        .status,
    ).toBe('queued');
    expect(await candidateCount(id)).toBe(2);
    expect(boss.deleteJob).not.toHaveBeenCalled();
  });

  it('reclaims expired and terminal metadata while retaining live previews and active runs', async () => {
    const expired = await run('preview'),
      stopped = await run('stopped'),
      completed = await run('completed');
    const preview = await run('preview', false),
      queued = await run('queued'),
      running = await run('running');
    await pumpStorageRetention(boss, { schedule: false, manualOnly: true });
    for (const id of [expired, stopped, completed]) expect(await candidateCount(id)).toBe(0);
    for (const id of [preview, queued, running]) expect(await candidateCount(id)).toBe(2);
    expect(boss.deleteJob).not.toHaveBeenCalled();
  });
});
