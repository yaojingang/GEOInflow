// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  db: undefined as Client | undefined,
  website: { id: '' },
  warehouse: false,
}));
vi.mock('../upstream/server', () => ({
  authorize: async () => ({ website: fixture.website, canManage: true }),
  query: async (sql: string, ...params: unknown[]) => {
    if (sql.includes('AS "latestBatch"')) return (await fixture.db.query(sql, params)).rows;
    return sql.includes('liekan_reporting_log') ? [{}] : [];
  },
  LiekanError: class extends Error {},
}));
vi.mock('../warehouse/runtime', () => ({
  warehouseIntakeEnabled: () => fixture.warehouse,
  warehouseEnabled: () => false,
}));
vi.mock('../warehouse/authority-routing', () => ({
  warehouseEnabled: () => false,
}));
vi.mock('../http', () => ({
  requestApi: async (_request: Request, run: () => Promise<unknown>) => Response.json(await run()),
}));
vi.mock('../upstream/identity-diagnostic', () => ({ identityIngressDiagnostic: () => ({}) }));
vi.mock('../upstream/installation-observation', () => ({ readInstallationObservation: vi.fn() }));
vi.mock('../upstream/collection-presence', () => ({ collectionPresence: async () => ({}) }));
vi.mock('../upstream/history-repair-boundary', () => ({ collectionRepairScope: vi.fn() }));
vi.mock('./capabilities', () => ({
  getLogCapabilities: async () => ({ cloudflare: {}, server: {} }),
}));

const database = process.env.LIEKAN_OVERVIEW_SCHEDULE_TEST_URL;
it.skipIf(!database)(
  'reports batch state from actual PostgreSQL rows through the installation endpoint',
  async () => {
    const url = new URL(database);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/overview_schedule_test');
    vi.stubEnv('DATABASE_URL', database);
    const db = new Client({ connectionString: database });
    fixture.db = db;
    fixture.website.id = randomUUID();
    const site = fixture.website.id;
    const source = randomUUID();
    const batch = randomUUID();
    await db.connect();
    try {
      const { GET } = await import('@/app/api/liekan/websites/[websiteId]/installation/route');
      await db.query(`
      CREATE TEMP TABLE liekan_log_source(id uuid,website_id uuid,kind text,domain text,state text,
        credential_version int,last_heartbeat_at timestamptz,last_received_at timestamptz,
        last_processed_at timestamptz,last_test_at timestamptz,error_code text,health jsonb,
        provider_config jsonb,credential_hash text,created_at timestamptz);
      CREATE TEMP TABLE liekan_log_state(website_id uuid,epoch bigint);
      CREATE TEMP TABLE liekan_log_interval(source_id uuid,ends_at timestamptz);
      CREATE TEMP TABLE liekan_ingest_batch(id uuid,website_id uuid,source_id uuid,epoch bigint,
        state text,valid int,inserted int,payload jsonb,received_at timestamptz);
      CREATE TEMP TABLE liekan_warehouse_upload(batch_id uuid,website_id uuid,inserted int,
        processed int,queued boolean,conflicts int);
    `);
      await db.query(
        "INSERT INTO liekan_log_source(id,website_id,state,kind) VALUES($1,$2,'active','server')",
        [source, site],
      );
      const read = async () => {
        const response = await GET(
          new Request(`http://localhost/api/liekan/websites/${site}/installation`),
          {
            params: Promise.resolve({ websiteId: site }),
          },
        );
        expect(response.status).toBe(200);
        const { sources } = await response.json();
        expect(sources).toHaveLength(1);
        return sources[0].latestBatch;
      };
      expect(await read()).toBeNull();
      await db.query(
        "INSERT INTO liekan_ingest_batch VALUES($1,$2,$3,1,'pending',10,0,'[]',now())",
        [batch, site, source],
      );
      expect(await read()).toMatchObject({ state: 'queued', expected: 10 });
      fixture.warehouse = true;
      expect(await read()).toMatchObject({ state: 'queue_unconfirmed' });
      await db.query('UPDATE liekan_ingest_batch SET payload=NULL');
      await db.query('INSERT INTO liekan_warehouse_upload VALUES($1,$2,0,0,false,0)', [
        batch,
        site,
      ]);
      expect(await read()).toMatchObject({ state: 'registered', processed: 0 });
      await db.query('UPDATE liekan_warehouse_upload SET queued=true');
      expect(await read()).toMatchObject({ state: 'queued' });
      await db.query('UPDATE liekan_warehouse_upload SET processed=4,inserted=4');
      expect(await read()).toMatchObject({ state: 'processing', processed: 4 });
      await db.query("UPDATE liekan_ingest_batch SET state='processed',inserted=10");
      await db.query('UPDATE liekan_warehouse_upload SET processed=10,inserted=10');
      expect(await read()).toMatchObject({ state: 'published', processed: 10, inserted: 10 });
      await db.query("UPDATE liekan_ingest_batch SET state='failed',inserted=8");
      await db.query('UPDATE liekan_warehouse_upload SET processed=10,inserted=8,conflicts=2');
      expect(await read()).toMatchObject({ state: 'failed', conflicts: 2 });
      await db.query("UPDATE liekan_ingest_batch SET state='processed',valid=0,inserted=0");
      await db.query('UPDATE liekan_warehouse_upload SET processed=0,inserted=0,conflicts=0');
      expect(await read()).toMatchObject({ state: 'processed', expected: 0, inserted: 0 });
    } finally {
      vi.unstubAllEnvs();
      await db.end();
    }
  },
);
