// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  pool: null as any,
  boss: null as any,
  catalog: null as any,
  aggregate: vi.fn(),
  first: vi.fn(),
  queries: [] as string[],
  queueFailure: false,
  queueGate: null as Promise<void> | null,
  queueEntered: null as (() => void) | null,
  afterQuery: null as ((sql: string, params: any[], client: any) => Promise<void>) | null,
  databaseErrors: [] as string[],
  rawTransaction: async (work: any) => {
    const client = await h.pool.connect();
    try {
      await client.query('BEGIN');
      const raw = {
        $queryRawUnsafe: async (sql: string, ...params: any[]) => {
          h.queries.push(sql);
          const result = await client.query(sql, params);
          await h.afterQuery?.(sql, params, client);
          return result.rows;
        },
        $executeRawUnsafe: async (sql: string, ...params: any[]) => {
          h.queries.push(sql);
          return (await client.query(sql, params)).rowCount;
        },
      };
      const value = await work(raw);
      await client.query('COMMIT');
      return value;
    } catch (e) {
      h.databaseErrors.push((e as any)?.code || 'unknown');
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },
}));
vi.mock('@/lib/prisma', () => ({
  default: { client: { $transaction: (work: any) => h.rawTransaction(work) } },
  getRawQueryClient: (client: any) => client,
}));
vi.mock('./ai-db', async original => {
  const actual = await original<any>();
  return {
    ...actual,
    aiTransaction: (work: any) => h.rawTransaction((raw: any) => work(actual.aiExecutor(raw))),
  };
});
vi.mock('../log-ingestion/queue', () => ({
  getQueue: async () => {
    if (h.queueFailure) throw new Error('queue unavailable');
    const gate = h.queueGate;
    h.queueGate = null;
    if (gate) {
      h.queueEntered?.();
      await gate;
    }
    return h.boss;
  },
}));
vi.mock('./geo-weight-sql', () => ({
  geoWeightAggregate: (...args: any[]) => h.aggregate(...args),
  geoWeightFirstEvidence: (...args: any[]) => h.first(...args),
}));
vi.mock('../crawlers/analysis', () => ({
  crawlerWindowQuality: async () => ({
    state: 'missing',
    basis: 'unknown',
    classificationVersion: null,
    sourceVersion: null,
    timezone: 'UTC',
  }),
}));
vi.mock('./crawler-registry-context', () => ({
  withPublishedRegistry: (work: any) => work(h.catalog),
}));
vi.mock('./query-cancellation', () => ({
  cancellableEvidence: (_tx: any, _signal: any, work: any) => work(),
}));
vi.mock('./analytics-budget', () => ({
  analyticsGate: { run: (work: any) => work() },
  AnalyticsUnavailable: class extends Error {
    status = 503;
  },
}));
import { getBundledPublishedCatalog } from '../crawlers/catalog-seed';
import {
  GEO_SNAPSHOT_QUEUE,
  readGeoWeightSnapshot,
  recalculateGeoWeight,
  processGeoSnapshotJob,
  reconcileGeoSnapshots,
  readGeoWeightForExport,
  geoSnapshotAccess,
  parseGeoSnapshotQuery,
  readLegacyGeoWeight,
} from './geo-weight-snapshots';
import { geoWeightSnapshotResponseSchema } from '../contracts/geo-weight';
import { geoDateOffset } from '../geo-weight/window';
import { GEO_ALGORITHM } from '../geo-weight/policy';
import { GEO_SCOPE_HASH } from './geo-weight';
const enabled = !!process.env.LIEKAN_GEO_SNAPSHOT_TEST_URL;
let pool: Pool, boss: PgBoss;
const actor = { id: randomUUID(), role: 'admin' },
  site = randomUUID();
const q = async (sql: string, ...params: any[]) => (await pool.query(sql, params)).rows;
const input = () => ({ mode: 'current', timezone: 'UTC', view: 'detail' });
const run = () => processGeoSnapshotJob({ headId: randomUUID() }, boss);
async function ready() {
  await readGeoWeightSnapshot(actor, site, input());
  await run();
  return readGeoWeightSnapshot(actor, site, input());
}

describe.skipIf(!enabled)('durable GEO snapshots in an owned PostgreSQL database', () => {
  beforeAll(async () => {
    const url = new URL(process.env.LIEKAN_GEO_SNAPSHOT_TEST_URL);
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '15461' ||
      url.pathname !== '/liekan_geo_snapshot_test'
    )
      throw new Error('Only the owned snapshot acceptance database is allowed');
    process.env.DATABASE_URL = url.toString();
    pool = new Pool({ connectionString: url.toString(), max: 60 });
    h.pool = pool;
    await q(
      'DROP SCHEMA IF EXISTS liekan_jobs CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public',
    );
    await q(`CREATE TABLE "user"(user_id uuid PRIMARY KEY,role text,deleted_at timestamptz);
      CREATE TABLE website(website_id uuid PRIMARY KEY,name text,domain text,user_id uuid,team_id uuid,reset_at timestamptz,deleted_at timestamptz);
      CREATE TABLE team(team_id uuid PRIMARY KEY,deleted_at timestamptz);CREATE TABLE team_user(team_id uuid,user_id uuid,role text);
      CREATE TABLE liekan_setting(website_id uuid PRIMARY KEY,ai_crawler_enabled boolean);
      CREATE TABLE liekan_log_state(website_id uuid PRIMARY KEY,epoch int,data_revision bigint DEFAULT 0,policy_revision bigint DEFAULT 0);
      CREATE TABLE liekan_crawler_state(website_id uuid PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE liekan_crawler_quality(website_id uuid,source_id uuid,starts_at timestamptz,ends_at timestamptz,state text,evidence jsonb,recorded_at timestamptz);
      CREATE TABLE liekan_log_source(id uuid PRIMARY KEY,website_id uuid,domain text,deleted_at timestamptz);
      CREATE TABLE liekan_log_interval(website_id uuid,source_id uuid,starts_at timestamptz,ends_at timestamptz);
      CREATE TABLE liekan_crawler_rule_version(website_id uuid,version text,catalog_version uuid,crawler_configuration jsonb);
      CREATE TABLE liekan_crawler_registry_version(version uuid,payload jsonb);
      CREATE TABLE liekan_crawler_range_snapshot(version text);
      CREATE TABLE liekan_log(id text,website_id uuid,created_at timestamptz);
      CREATE TABLE liekan_crawler_evidence(website_id uuid,log_id text,measurement jsonb);`);
    await q('CREATE TABLE liekan_warehouse_installation(id integer PRIMARY KEY,authority text)');
    for (const migration of [
      '036_geo_weight_snapshots.sql',
      '071_warehouse_geo_publication.sql',
      '101_geo_coverage_revision.sql',
    ]) {
      await q(await readFile(`db/liekan/migrations/${migration}`, 'utf8'));
    }
    boss = new PgBoss({
      connectionString: url.toString(),
      schema: 'liekan_jobs',
      schedule: false,
      supervise: false,
    });
    await boss.start();
    await boss.createQueue(GEO_SNAPSHOT_QUEUE, { retryLimit: 0 });
    h.boss = boss;
    h.catalog = getBundledPublishedCatalog();
  }, 30000);
  beforeEach(async () => {
    await q(
      `TRUNCATE liekan_warehouse_installation,liekan_geo_weight_request,liekan_geo_weight_head,liekan_geo_weight_snapshot,liekan_geo_weight_evidence_revision,"user",website,liekan_log_state,liekan_log_source,liekan_log,liekan_crawler_evidence,liekan_crawler_quality,liekan_crawler_rule_version,liekan_crawler_registry_version,liekan_crawler_range_snapshot,liekan_log_interval,liekan_crawler_state CASCADE`,
    );
    await boss.deleteAllJobs(GEO_SNAPSHOT_QUEUE);
    await q('INSERT INTO "user"(user_id,role) VALUES($1,\'admin\')', actor.id);
    await q(
      "INSERT INTO website(website_id,name,domain,user_id) VALUES($1,'Example','www.example.com',$2)",
      site,
      actor.id,
    );
    await q('INSERT INTO liekan_log_state(website_id,epoch) VALUES($1,1)', site);
    h.aggregate.mockReset().mockResolvedValue([]);
    h.first.mockReset().mockResolvedValue(null);
    h.queries = [];
    h.queueFailure = false;
    h.queueGate = null;
    h.queueEntered = null;
    h.afterQuery = null;
    h.databaseErrors = [];
  });
  afterAll(async () => {
    await boss?.stop();
    await pool?.end();
  });
  it('coalesces fifty simultaneous readers into one durable demand and publishes null evidence as ready', async () => {
    const states = await Promise.all(
      Array.from({ length: 50 }, () => readGeoWeightSnapshot(actor, site, input())),
    );
    expect(new Set(states.map(s => s.taskId)).size).toBe(1);
    expect((await q('SELECT count(*)::int AS count FROM liekan_geo_weight_head'))[0].count).toBe(1);
    expect(
      (
        await q(
          'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
          GEO_SNAPSHOT_QUEUE,
        )
      )[0].count,
    ).toBe(1);
    await Promise.all([run(), run()]);
    const result = await readGeoWeightSnapshot(actor, site, input());
    expect(result.taskStatus).toBe('ready');
    expect(result.result.current.level).toBeNull();
    expect(geoWeightSnapshotResponseSchema.safeParse(result).success).toBe(true);
    expect(h.aggregate).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 3; n++) await readGeoWeightSnapshot(actor, site, input());
    await readGeoWeightSnapshot(actor, site, { ...input(), snapshotId: result.snapshotId });
    expect(h.aggregate).toHaveBeenCalledTimes(1);
    expect((await q('SELECT result FROM liekan_geo_weight_snapshot'))[0].result).not.toHaveProperty(
      'canManageCatalog',
    );
  }, 30000);
  it('keeps a day stable across data revisions, display-name edits and fresh service instances; exports exact stored generations', async () => {
    const before = await ready();
    h.queries = [];
    await q('UPDATE liekan_log_state SET data_revision=100 WHERE website_id=$1', site);
    await q("UPDATE website SET name='Renamed' WHERE website_id=$1", site);
    const after = await readGeoWeightSnapshot(actor, site, input());
    expect(after.snapshotId).toBe(before.snapshotId);
    expect(h.aggregate).toHaveBeenCalledTimes(1);
    expect(
      h.queries.some(s => s.includes('max(recorded_at)') || s.includes('liekan_effective_log')),
    ).toBe(false);
    const exported = await readGeoWeightForExport(actor, site, { snapshotId: before.snapshotId });
    expect(exported.snapshotId).toBe(before.snapshotId);
    expect(h.aggregate).toHaveBeenCalledTimes(1);
    await expect(
      readGeoWeightForExport(actor, site, {
        asOf: before.servedAsOf,
        timezone: 'UTC',
        snapshot: '0'.repeat(64),
        catalogVersion: before.result.readCatalogVersion,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      readGeoWeightSnapshot(actor, site, {
        ...input(),
        mode: 'historical',
        asOf: geoDateOffset(before.servedAsOf, -1),
        snapshotId: before.snapshotId,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('uses separate historical identities and never borrows another date; exact IDs never enqueue', async () => {
    const before = await ready();
    const historical = await readGeoWeightSnapshot(actor, site, {
      ...input(),
      mode: 'historical',
      asOf: geoDateOffset(before.servedAsOf, -2),
    });
    expect(historical.result).toBeNull();
    expect(historical.taskStatus).toBe('queued');
    const heads = (await q('SELECT count(*)::int AS count FROM liekan_geo_weight_head'))[0].count;
    await readGeoWeightSnapshot(actor, site, { ...input(), snapshotId: before.snapshotId });
    expect((await q('SELECT count(*)::int AS count FROM liekan_geo_weight_head'))[0].count).toBe(
      heads,
    );
    await expect(
      readGeoWeightSnapshot(actor, site, { ...input(), snapshotId: randomUUID() }),
    ).rejects.toMatchObject({ status: 410 });
  });
  it('rolls back demand when transactional queue insertion fails', async () => {
    const send = vi
      .spyOn(boss, 'send')
      .mockRejectedValueOnce(new Error('injected enqueue failure'));
    await expect(readGeoWeightSnapshot(actor, site, input())).rejects.toThrow();
    send.mockRestore();
    expect((await q('SELECT count(*)::int AS count FROM liekan_geo_weight_head'))[0].count).toBe(0);
    expect(
      (
        await q(
          'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
          GEO_SNAPSHOT_QUEUE,
        )
      )[0].count,
    ).toBe(0);
    h.queueFailure = true;
    await expect(readGeoWeightSnapshot(actor, site, input())).rejects.toThrow();
    expect((await q('SELECT count(*)::int AS count FROM liekan_geo_weight_head'))[0].count).toBe(0);
  });
  it('enforces exact same-actor idempotency and website-wide cooldown across timezone changes', async () => {
    await ready();
    const requestId = randomUUID();
    const a = await recalculateGeoWeight(actor, site, {
      mode: 'current',
      timezone: 'UTC',
      requestId,
    });
    const b = await recalculateGeoWeight(actor, site, {
      mode: 'current',
      timezone: 'UTC',
      requestId,
    });
    expect(b.taskId).toBe(a.taskId);
    await expect(
      recalculateGeoWeight(actor, site, { mode: 'current', timezone: 'Asia/Shanghai', requestId }),
    ).rejects.toMatchObject({ status: 409 });
    await run();
    await expect(
      recalculateGeoWeight(actor, site, {
        mode: 'current',
        timezone: 'Asia/Shanghai',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 429 });
  });
  it('bounds failed calculations to three attempts and preserves old published output', async () => {
    const old = await ready();
    await recalculateGeoWeight(actor, site, {
      mode: 'current',
      timezone: 'UTC',
      requestId: randomUUID(),
    });
    h.aggregate.mockRejectedValue(new Error('aggregate failed'));
    for (let n = 0; n < 3; n++) {
      await run();
      const [head] = await q('SELECT * FROM liekan_geo_weight_head');
      expect(head.attempts).toBe(n + 1);
      if (n < 2) {
        expect(head.task_status).toBe('queued');
        expect(new Date(head.next_retry_at).getTime()).toBeGreaterThan(Date.now());
        await q('UPDATE liekan_geo_weight_head SET next_retry_at=now()');
      } else expect(head.task_status).toBe('failed');
    }
    const result = await readGeoWeightSnapshot(actor, site, input());
    expect(result.snapshotId).toBe(old.snapshotId);
    expect(result.taskStatus).toBe('failed');
    expect((await q('SELECT attempts FROM liekan_geo_weight_head'))[0].attempts).toBe(3);
  });
  it('uses the global transaction advisory lock across two workers without spending contention retries', async () => {
    const site2 = randomUUID();
    await q(
      "INSERT INTO website(website_id,name,domain,user_id) VALUES($1,'Other','other.example.com',$2)",
      site2,
      actor.id,
    );
    await readGeoWeightSnapshot(actor, site, input());
    await readGeoWeightSnapshot(actor, site2, input());
    let release: () => void;
    const barrier = new Promise<void>(r => {
      release = r;
    });
    let entered: () => void;
    const entry = new Promise<void>(r => {
      entered = r;
    });
    h.aggregate.mockImplementationOnce(async () => {
      entered();
      await barrier;
      return [];
    });
    const first = run();
    await entry;
    await run();
    release();
    await first;
    const rows = await q(
      'SELECT task_status,attempts FROM liekan_geo_weight_head ORDER BY task_status',
    );
    expect(rows).toEqual([
      { task_status: 'queued', attempts: 0 },
      { task_status: 'ready', attempts: 1 },
    ]);
    expect(h.aggregate).toHaveBeenCalledTimes(1);
  });
  it('reconciles expired leases, fences old owners and prevents a stale calculation from publishing', async () => {
    await readGeoWeightSnapshot(actor, site, input());
    let release: () => void;
    const barrier = new Promise<void>(r => {
      release = r;
    });
    let entered: () => void;
    const entry = new Promise<void>(r => {
      entered = r;
    });
    h.aggregate.mockImplementationOnce(async () => {
      entered();
      await barrier;
      return [];
    });
    const running = run();
    await entry;
    await q("UPDATE liekan_geo_weight_head SET lease_until=now()-interval '1 second'");
    await reconcileGeoSnapshots(boss);
    release();
    await running;
    expect(
      (await q('SELECT task_status,lease_epoch FROM liekan_geo_weight_head'))[0],
    ).toMatchObject({ task_status: 'queued', lease_epoch: 2 });
    expect(
      (await q('SELECT count(*)::int AS count FROM liekan_geo_weight_snapshot'))[0].count,
    ).toBe(0);
  });
  it('rejects transfer/reset boundary changes and re-registers demand under current authority', async () => {
    const old = await ready();
    await q('UPDATE liekan_log_state SET epoch=2 WHERE website_id=$1', site);
    await expect(
      readGeoWeightForExport(actor, site, { snapshotId: old.snapshotId }),
    ).rejects.toMatchObject({ status: 409 });
    const state = await readGeoWeightSnapshot(actor, site, input());
    expect(state.result).toBeNull();
    const nextOwner = randomUUID();
    await q('INSERT INTO "user"(user_id,role) VALUES($1,\'user\')', nextOwner);
    await q('UPDATE website SET user_id=$2 WHERE website_id=$1', site, nextOwner);
    await run();
    const transferred = await readGeoWeightSnapshot({ id: nextOwner, role: 'user' }, site, input());
    expect(transferred.taskStatus).toBe('queued');
    await run();
    expect(
      (await readGeoWeightSnapshot({ id: nextOwner, role: 'user' }, site, input())).taskStatus,
    ).toBe('ready');
  });
  it('requeues an evicted ready result and preserves ready null scores', async () => {
    const old = await ready();
    await q('DELETE FROM liekan_geo_weight_snapshot WHERE id=$1', old.snapshotId);
    expect((await readGeoWeightSnapshot(actor, site, input())).taskStatus).toBe('queued');
    await run();
    const next = await readGeoWeightSnapshot(actor, site, input());
    expect(next.taskStatus).toBe('ready');
    expect(next.result.current.level).toBeNull();
    expect((await readGeoWeightSnapshot(actor, site, input())).taskStatus).toBe('ready');
    expect(h.aggregate).toHaveBeenCalledTimes(2);
  });
  it('fails legacy foreground waiting within its budget while retaining shared durable demand', async () => {
    const p = parseGeoSnapshotQuery(input());
    await expect(
      readLegacyGeoWeight(
        actor,
        site,
        { asOf: p.asOf, timezone: 'UTC', view: 'summary' },
        { deadline: Date.now() + 20 },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect((await q('SELECT task_status FROM liekan_geo_weight_head'))[0].task_status).toBe(
      'queued',
    );
    expect(h.aggregate).not.toHaveBeenCalled();
  });
  it('bounds pending identities and rejects oversized output without manufacturing a numeric score', async () => {
    const p = parseGeoSnapshotQuery(input());
    for (let n = 0; n < 20; n++)
      await readGeoWeightSnapshot(actor, site, {
        ...input(),
        mode: 'historical',
        asOf: geoDateOffset(p.asOf, -n),
      });
    await expect(
      readGeoWeightSnapshot(actor, site, {
        ...input(),
        mode: 'historical',
        asOf: geoDateOffset(p.asOf, -21),
      }),
    ).rejects.toMatchObject({ status: 429 });
    h.aggregate.mockResolvedValue([
      { asOf: p.asOf, stats: {}, forms: [{ form: 'x'.repeat(600000), requests: 1 }] },
    ]);
    await run();
    const [head] = await q('SELECT error_code FROM liekan_geo_weight_head WHERE attempts>0');
    expect(head.error_code).toBe('result_too_large');
    expect(
      (await q('SELECT count(*)::int AS count FROM liekan_geo_weight_snapshot'))[0].count,
    ).toBe(0);
  });
  it('records corrections only within used proof windows and keeps normal appends inert', async () => {
    const old = await ready();
    const before = old.strongVersion;
    await q(
      "INSERT INTO liekan_log(id,website_id,created_at) VALUES('outside',$1,now()-interval '120 days'),('inside',$1,now()-interval '2 days')",
      site,
    );
    expect((await readGeoWeightSnapshot(actor, site, input())).strongVersion).toBe(before);
    await q("DELETE FROM liekan_log WHERE id='outside'");
    expect((await readGeoWeightSnapshot(actor, site, input())).strongVersion).toBe(before);
    await q(
      "INSERT INTO liekan_crawler_evidence(website_id,log_id,measurement) VALUES($1,'inside','{}')",
      site,
    );
    await q('UPDATE liekan_crawler_evidence SET measurement=\'{"samplingRate":0.1}\'');
    const corrected = await readGeoWeightSnapshot(actor, site, input());
    expect(corrected.strongVersion).not.toBe(before);
    expect(corrected.result).toBeNull();
    await expect(
      readGeoWeightForExport(actor, site, { snapshotId: old.snapshotId }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('returns capacity when 500 protected results or 64 MiB are occupied and leaves existing results readable', async () => {
    const old = await ready();
    await q(
      `INSERT INTO liekan_geo_weight_snapshot(id,website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,generation,input_boundary,calculated_at,result,result_bytes,result_digest)
      SELECT gen_random_uuid(),s.website_id,s.hostname,s.timezone,s.as_of,s.epoch,s.algorithm,s.scope_hash,s.strong_version,n+1,s.input_boundary,s.calculated_at,s.result,s.result_bytes,s.result_digest FROM liekan_geo_weight_snapshot s CROSS JOIN generate_series(1,499) n WHERE s.id=$1`,
      old.snapshotId,
    );
    let capacity = await readGeoWeightSnapshot(actor, site, {
      ...input(),
      mode: 'historical',
      asOf: geoDateOffset(old.servedAsOf, -1),
    });
    expect(capacity.taskStatus).toBe('capacity_blocked');
    expect(capacity.errorCode).toBe('capacity_exhausted');
    expect(capacity.result).toBeNull();
    expect((await readGeoWeightSnapshot(actor, site, input())).snapshotId).toBe(old.snapshotId);
    await q('DELETE FROM liekan_geo_weight_snapshot WHERE id<>$1', old.snapshotId);
    await q(
      `INSERT INTO liekan_geo_weight_snapshot(id,website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,generation,input_boundary,calculated_at,result,result_bytes,result_digest)
      SELECT gen_random_uuid(),s.website_id,s.hostname,s.timezone,s.as_of,s.epoch,s.algorithm,s.scope_hash,s.strong_version,n+1,s.input_boundary,s.calculated_at,s.result,524288,s.result_digest FROM liekan_geo_weight_snapshot s CROSS JOIN generate_series(1,128) n WHERE s.id=$1`,
      old.snapshotId,
    );
    capacity = await readGeoWeightSnapshot(actor, site, {
      ...input(),
      mode: 'historical',
      asOf: geoDateOffset(old.servedAsOf, -2),
    });
    expect(capacity.taskStatus).toBe('capacity_blocked');
    expect(
      (await readGeoWeightForExport(actor, site, { snapshotId: old.snapshotId })).snapshotId,
    ).toBe(old.snapshotId);
  });
  it('recovers completed queue deliveries while demand is pending and never duplicates a ready publication', async () => {
    const state = await readGeoWeightSnapshot(actor, site, input());
    await q("UPDATE liekan_jobs.job SET state='completed' WHERE name=$1", GEO_SNAPSHOT_QUEUE);
    await reconcileGeoSnapshots(boss);
    expect(
      (
        await q(
          'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
          GEO_SNAPSHOT_QUEUE,
        )
      )[0].count,
    ).toBe(2);
    await run();
    await run();
    expect(h.aggregate).toHaveBeenCalledTimes(1);
    expect((await readGeoWeightSnapshot(actor, site, input())).taskId).toBe(state.taskId);
    expect(
      (await q('SELECT count(*)::int AS count FROM liekan_geo_weight_snapshot'))[0].count,
    ).toBe(1);
  });
  it('protects referenced archives and immutable result bytes until the snapshot is removed', async () => {
    const range = 'archived-range',
      rule = 'archived-rule';
    const p = parseGeoSnapshotQuery(input());
    h.aggregate.mockResolvedValue([
      {
        asOf: p.asOf,
        stats: {
          catalogVersions: [h.catalog.version],
          classificationVersions: [rule],
          verificationVersions: [range],
        },
      },
    ]);
    const old = await ready();
    await q(
      'INSERT INTO liekan_crawler_rule_version(website_id,version) VALUES($1,$2)',
      site,
      rule,
    );
    await q('INSERT INTO liekan_crawler_range_snapshot(version) VALUES($1)', range);
    await expect(
      q('DELETE FROM liekan_crawler_rule_version WHERE website_id=$1', site),
    ).rejects.toThrow('referenced');
    await expect(
      q('DELETE FROM liekan_crawler_range_snapshot WHERE version=$1', range),
    ).rejects.toThrow('referenced');
    await expect(
      q("UPDATE liekan_geo_weight_snapshot SET result='{}' WHERE id=$1", old.snapshotId),
    ).rejects.toThrow('immutable');
    await q('DELETE FROM liekan_geo_weight_head');
    await q('DELETE FROM liekan_geo_weight_snapshot');
    await expect(
      q('DELETE FROM liekan_crawler_rule_version WHERE website_id=$1', site),
    ).resolves.toEqual([]);
    await expect(
      q('DELETE FROM liekan_crawler_range_snapshot WHERE version=$1', range),
    ).resolves.toEqual([]);
  });
  it('preserves published days during normal coverage extension but fences an existing proof downgrade', async () => {
    const old = await ready(),
      source = randomUUID();
    const evidence = {
      basis: 'event_time',
      classificationVersion: 'rule',
      sourceVersion: source,
      fromBatchId: 'a',
      toBatchId: 'b',
      cursors: [1],
    };
    await q(
      "INSERT INTO liekan_crawler_quality VALUES($1,$2,now()-interval '10 days',now()-interval '2 days','complete',$3,now())",
      site,
      source,
      JSON.stringify(evidence),
    );
    await q(
      "UPDATE liekan_crawler_quality SET ends_at=now()-interval '1 day',evidence=$1,recorded_at=now()",
      JSON.stringify({ ...evidence, toBatchId: 'c', cursors: [2] }),
    );
    expect((await readGeoWeightSnapshot(actor, site, input())).snapshotId).toBe(old.snapshotId);
    await q("UPDATE liekan_crawler_quality SET state='partial'");
    expect((await readGeoWeightSnapshot(actor, site, input())).result).toBeNull();
  });
  it('revises GEO evidence for new warehouse coverage without invalidating site reports', async () => {
    await q("INSERT INTO liekan_warehouse_installation VALUES(1,'clickhouse')");
    const published = await ready();
    const source = randomUUID();
    const revisions = async () =>
      (
        await q(
          `SELECT policy_revision::int AS policy,(SELECT coalesce(max(revision),0)::int
       FROM liekan_geo_weight_evidence_revision WHERE website_id=$1) AS proof
       FROM liekan_log_state WHERE website_id=$1`,
          site,
        )
      )[0];
    const before = await revisions();
    await q(
      `INSERT INTO liekan_crawler_quality VALUES($1,$2,current_date-10,current_date-5,
       'complete','{"classificationVersion":"original"}',now())`,
      site,
      source,
    );
    const added = await revisions();
    expect(added.policy).toBe(before.policy);
    expect(added.proof).toBeGreaterThan(before.proof);
    expect(published.snapshotId).toBeTruthy();
    expect((await readGeoWeightSnapshot(actor, site, input())).result).toBeNull();

    await q(`UPDATE liekan_crawler_quality SET ends_at=current_date-2,
      evidence=evidence || '{"toBatchId":"next"}'::jsonb`);
    const extended = await revisions();
    expect(extended.policy).toBe(before.policy);
    expect(extended.proof).toBeGreaterThan(added.proof);
    await q('UPDATE liekan_crawler_quality SET recorded_at=clock_timestamp()');
    expect(await revisions()).toEqual(extended);

    await q("UPDATE liekan_crawler_quality SET state='partial'");
    const corrected = await revisions();
    expect(corrected.policy).toBeGreaterThan(extended.policy);
    expect(corrected.proof).toBeGreaterThan(extended.proof);
    await q('UPDATE liekan_crawler_quality SET ends_at=current_date-1');
    const partialExtension = await revisions();
    expect(partialExtension.policy).toBe(corrected.policy);
    expect(partialExtension.proof).toBeGreaterThan(corrected.proof);
    await q('DELETE FROM liekan_crawler_quality WHERE source_id=$1', source);
    expect((await revisions()).policy).toBeGreaterThan(corrected.policy);
  });
  it('reuses a result published after the first inspection and before locked registration', async () => {
    let resume: () => void;
    h.queueGate = new Promise<void>(resolve => {
      resume = resolve;
    });
    const entered = new Promise<void>(resolve => {
      h.queueEntered = resolve;
    });
    const slowReader = readGeoWeightSnapshot(actor, site, input());
    await entered;
    await readGeoWeightSnapshot(actor, site, input());
    await run();
    resume();
    const result = await slowReader;
    expect(result.taskStatus).toBe('ready');
    expect(
      (await q('SELECT generation,expected_generation,task_status FROM liekan_geo_weight_head'))[0],
    ).toEqual({ generation: 1, expected_generation: 1, task_status: 'ready' });
    expect(h.aggregate).toHaveBeenCalledTimes(1);
    expect(
      (
        await q(
          'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
          GEO_SNAPSHOT_QUEUE,
        )
      )[0].count,
    ).toBe(1);
  });
  it('retains 90-day idempotency receipts when the 500-receipt quota is full', async () => {
    await ready();
    const requestId = randomUUID();
    const prior = await recalculateGeoWeight(actor, site, {
      mode: 'current',
      timezone: 'UTC',
      requestId,
    });
    await q(
      `INSERT INTO liekan_geo_weight_request(website_id,actor_id,request_id,parameter_hash,head_id)
      SELECT website_id,actor_id,gen_random_uuid(),parameter_hash,head_id FROM liekan_geo_weight_request CROSS JOIN generate_series(1,499) WHERE request_id=$1`,
      requestId,
    );
    expect(
      (await recalculateGeoWeight(actor, site, { mode: 'current', timezone: 'UTC', requestId }))
        .taskId,
    ).toBe(prior.taskId);
    await expect(
      recalculateGeoWeight(actor, site, {
        mode: 'current',
        timezone: 'UTC',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect((await q('SELECT count(*)::int AS count FROM liekan_geo_weight_request'))[0].count).toBe(
      500,
    );
    expect(
      (
        await q('SELECT request_id FROM liekan_geo_weight_request WHERE request_id=$1', requestId)
      )[0].request_id,
    ).toBe(requestId);
  });
  it('keeps task status pinned across midnight without enqueueing the next day and retains current-mode fallback', async () => {
    const old = await ready();
    const midnight =
      new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime() + 86400000;
    let now = midnight + 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const updating = await readGeoWeightSnapshot(actor, site, input());
      expect(updating.taskStatus).toBe('queued');
      expect(updating.servedAsOf).toBe(old.servedAsOf);
      expect(updating.stale).toBe(true);
      const heads = (await q('SELECT count(*)::int AS count FROM liekan_geo_weight_head'))[0].count;
      const jobs = (
        await q(
          'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
          GEO_SNAPSHOT_QUEUE,
        )
      )[0].count;
      now = midnight + 86400000 + 1000;
      const status = await readGeoWeightSnapshot(actor, site, {
        ...input(),
        taskId: updating.taskId,
        asOf: updating.requestedAsOf,
      });
      expect(status.taskId).toBe(updating.taskId);
      expect(status.requestedAsOf).toBe(updating.requestedAsOf);
      expect(status.servedAsOf).toBe(old.servedAsOf);
      expect(status.stale).toBe(true);
      expect((await q('SELECT count(*)::int AS count FROM liekan_geo_weight_head'))[0].count).toBe(
        heads,
      );
      expect(
        (
          await q(
            'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
            GEO_SNAPSHOT_QUEUE,
          )
        )[0].count,
      ).toBe(jobs);
      const entered = await readGeoWeightSnapshot(actor, site, input());
      expect(entered.requestedAsOf).not.toBe(updating.requestedAsOf);
      expect((await q('SELECT count(*)::int AS count FROM liekan_geo_weight_head'))[0].count).toBe(
        heads + 1,
      );
    } finally {
      clock.mockRestore();
    }
  });
  it('keeps valid idempotency receipts attached while unreferenced empty heads are pruned at capacity', async () => {
    const initial = await ready(),
      requestId = randomUUID();
    await recalculateGeoWeight(actor, site, { mode: 'current', timezone: 'UTC', requestId });
    await run();
    await q('DELETE FROM liekan_geo_weight_snapshot');
    await q("UPDATE liekan_geo_weight_head SET last_read_at=now()-interval '2 days'");
    await q(
      `INSERT INTO liekan_geo_weight_head(website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,task_status,actor_id,ownership)
      SELECT website_id,hostname,timezone,as_of-n,epoch,algorithm,scope_hash,strong_version,'ready',actor_id,ownership FROM liekan_geo_weight_head CROSS JOIN generate_series(1,499) n WHERE id=$1`,
      initial.taskId,
    );
    await readGeoWeightSnapshot(actor, site, {
      ...input(),
      mode: 'historical',
      asOf: geoDateOffset(initial.requestedAsOf, -500),
    });
    expect(
      (await q('SELECT head_id FROM liekan_geo_weight_request WHERE request_id=$1', requestId))[0]
        ?.head_id,
    ).toBe(initial.taskId);
    const jobs = (
      await q(
        'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
        GEO_SNAPSHOT_QUEUE,
      )
    )[0].count;
    expect(
      (await recalculateGeoWeight(actor, site, { mode: 'current', timezone: 'UTC', requestId }))
        .taskId,
    ).toBe(initial.taskId);
    expect(
      (
        await q(
          'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
          GEO_SNAPSHOT_QUEUE,
        )
      )[0].count,
    ).toBe(jobs);
  });

  it('rejects an idempotent recalculation retry after its original strong boundary changes', async () => {
    const initial = await ready(),
      requestId = randomUUID();
    await recalculateGeoWeight(actor, site, { mode: 'current', timezone: 'UTC', requestId });
    await q(
      "INSERT INTO liekan_geo_weight_evidence_revision(website_id,starts_at,ends_at) VALUES($1,now()-interval '3 days',now()-interval '2 days')",
      site,
    );
    const jobs = (
      await q(
        'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
        GEO_SNAPSHOT_QUEUE,
      )
    )[0].count;
    await expect(
      recalculateGeoWeight(actor, site, { mode: 'current', timezone: 'UTC', requestId }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await q('SELECT head_id FROM liekan_geo_weight_request WHERE request_id=$1', requestId))[0]
        .head_id,
    ).toBe(initial.taskId);
    expect(
      (
        await q(
          'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
          GEO_SNAPSHOT_QUEUE,
        )
      )[0].count,
    ).toBe(jobs);
  });
  it('validates task-only status identity, timezone, historical date and strong boundary without registering work', async () => {
    const initial = await ready();
    expect(
      (await readGeoWeightSnapshot(actor, site, { ...input(), taskId: initial.taskId })).snapshotId,
    ).toBe(initial.snapshotId);
    await expect(
      readGeoWeightSnapshot(actor, site, { ...input(), taskId: randomUUID() }),
    ).rejects.toMatchObject({ status: 410 });
    await expect(
      readGeoWeightSnapshot(actor, site, {
        ...input(),
        taskId: initial.taskId,
        snapshotId: initial.snapshotId,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      readGeoWeightSnapshot(actor, site, {
        ...input(),
        taskId: initial.taskId,
        timezone: 'Asia/Shanghai',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      readGeoWeightSnapshot(actor, site, {
        ...input(),
        taskId: initial.taskId,
        mode: 'historical',
        asOf: geoDateOffset(initial.requestedAsOf, -1),
      }),
    ).rejects.toMatchObject({ status: 409 });
    const other = randomUUID();
    await q(
      "INSERT INTO website(website_id,name,domain,user_id) VALUES($1,'Other','other.example.com',$2)",
      other,
      actor.id,
    );
    await expect(
      readGeoWeightSnapshot(actor, other, { ...input(), taskId: initial.taskId }),
    ).rejects.toMatchObject({ status: 404 });
    await q('UPDATE liekan_log_state SET epoch=epoch+1 WHERE website_id=$1', site);
    await expect(
      readGeoWeightSnapshot(actor, site, { ...input(), taskId: initial.taskId }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await q('SELECT count(*)::int AS count FROM liekan_geo_weight_head'))[0].count).toBe(1);
    expect(
      (
        await q(
          'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
          GEO_SNAPSHOT_QUEUE,
        )
      )[0].count,
    ).toBe(1);
  });
  it.each(['epoch', 'website', 'crawler'])(
    'releases archive references after a rollback lifecycle invalidates the %s boundary',
    async boundary => {
      const rule = 'rollback-rule',
        p = parseGeoSnapshotQuery(input());
      h.aggregate.mockResolvedValue([{ asOf: p.asOf, stats: { classificationVersions: [rule] } }]);
      const saved = await ready();
      await q(
        'INSERT INTO liekan_crawler_rule_version(website_id,version) VALUES($1,$2)',
        site,
        rule,
      );
      await q('INSERT INTO liekan_crawler_state(website_id) VALUES($1)', site);
      await expect(
        q('DELETE FROM liekan_crawler_rule_version WHERE website_id=$1', site),
      ).rejects.toThrow('referenced');
      if (boundary === 'epoch')
        await q('UPDATE liekan_log_state SET epoch=epoch+1 WHERE website_id=$1', site);
      else if (boundary === 'website')
        await q('UPDATE website SET deleted_at=now() WHERE website_id=$1', site);
      else await q('UPDATE liekan_crawler_state SET deleted_at=now() WHERE website_id=$1', site);
      await expect(
        q('DELETE FROM liekan_crawler_rule_version WHERE website_id=$1', site),
      ).resolves.toEqual([]);
      expect(
        (await q('SELECT id FROM liekan_geo_weight_snapshot WHERE id=$1', saved.snapshotId))[0].id,
      ).toBe(saved.snapshotId);
    },
  );
  it('uses the real Prisma PostgreSQL adapter for cold registration, transactional queue delivery and worker publication', async () => {
    const { PrismaClient } = await import('@/generated/prisma/client');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.LIEKAN_GEO_SNAPSHOT_TEST_URL }),
    });
    const original = h.rawTransaction;
    h.rawTransaction = work => client.$transaction(work);
    try {
      const initial = await readGeoWeightSnapshot(actor, site, input());
      expect(initial.taskStatus).toBe('queued');
      expect(initial.taskId).toBeTruthy();
      await run();
      const saved = await readGeoWeightSnapshot(actor, site, input());
      expect(saved.taskStatus).toBe('ready');
      expect(saved.result.current.level).toBeNull();
      expect(saved.taskId).toBe(initial.taskId);
      expect(
        (
          await q(
            'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
            GEO_SNAPSHOT_QUEUE,
          )
        )[0].count,
      ).toBe(1);
    } finally {
      h.rawTransaction = original;
      await client.$disconnect();
    }
  });
  it.each(['reset', 'delete'])(
    'publishes with the website-first lock order while a concurrent %s removes GEO state',
    async action => {
      await readGeoWeightSnapshot(actor, site, input());
      const remover = await pool.connect();
      let entered = false;
      let removal: Promise<void> | undefined;
      const removalErrors: string[] = [];
      h.afterQuery = async sql => {
        if (
          entered ||
          !sql.includes('SELECT * FROM liekan_geo_weight_head WHERE id=$1::uuid FOR UPDATE')
        )
          return;
        entered = true;
        await remover.query('BEGIN');
        await remover.query("SET LOCAL deadlock_timeout TO '50ms'");
        await remover.query("SET LOCAL lock_timeout TO '500ms'");
        try {
          await remover.query('SELECT website_id FROM website WHERE website_id=$1 FOR UPDATE', [
            site,
          ]);
        } catch (error) {
          await remover.query('ROLLBACK');
          if ((error as any).code === '55P03') return;
          throw error;
        }
        const pid = (await remover.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        removal = (async () => {
          try {
            await remover.query('DELETE FROM liekan_geo_weight_head WHERE website_id=$1', [site]);
            await remover.query('DELETE FROM liekan_geo_weight_snapshot WHERE website_id=$1', [
              site,
            ]);
            if (action === 'delete')
              await remover.query('UPDATE website SET deleted_at=now() WHERE website_id=$1', [
                site,
              ]);
            else
              await remover.query('UPDATE liekan_log_state SET epoch=epoch+1 WHERE website_id=$1', [
                site,
              ]);
            await remover.query('COMMIT');
          } catch (error) {
            removalErrors.push((error as any).code || 'unknown');
            await remover.query('ROLLBACK');
          }
        })();
        for (let n = 0; n < 30; n++) {
          const [waiting] = await q(
            'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',
            pid,
          );
          if (waiting?.wait_event_type === 'Lock') break;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      };
      try {
        await run();
        await removal;
        expect(entered).toBe(true);
        expect([...h.databaseErrors, ...removalErrors]).not.toContain('40P01');
        expect(removalErrors).toEqual([]);
        const [published] = await q(
          'SELECT task_status FROM liekan_geo_weight_head WHERE website_id=$1',
          site,
        );
        if (!removal) expect(published?.task_status).toBe('ready');
        h.afterQuery = null;
        await remover.query('BEGIN');
        await remover.query('SELECT website_id FROM website WHERE website_id=$1 FOR UPDATE', [
          site,
        ]);
        await remover.query('DELETE FROM liekan_geo_weight_head WHERE website_id=$1', [site]);
        await remover.query('DELETE FROM liekan_geo_weight_snapshot WHERE website_id=$1', [site]);
        await remover.query('COMMIT');
      } finally {
        h.afterQuery = null;
        await remover.query('ROLLBACK');
        remover.release();
      }
    },
    10000,
  );
  it("records another authorized actor's merged manual request before its retry after completion", async () => {
    const opener = { id: randomUUID(), role: 'admin' };
    await q('INSERT INTO "user"(user_id,role) VALUES($1,\'admin\')', opener.id);
    const initial = await readGeoWeightSnapshot(opener, site, input());
    const requestId = randomUUID();
    const merged = await recalculateGeoWeight(actor, site, {
      mode: 'current',
      timezone: 'UTC',
      requestId,
    });
    expect(merged.taskId).toBe(initial.taskId);
    expect(
      (await q('SELECT head_id FROM liekan_geo_weight_request WHERE request_id=$1', requestId))[0]
        ?.head_id,
    ).toBe(initial.taskId);
    await run();
    const jobs = (
      await q(
        'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
        GEO_SNAPSHOT_QUEUE,
      )
    )[0].count;
    const retried = await recalculateGeoWeight(actor, site, {
      mode: 'current',
      timezone: 'UTC',
      requestId,
    });
    expect(retried.taskId).toBe(initial.taskId);
    expect(retried.taskStatus).toBe('ready');
    expect(
      (
        await q(
          'SELECT actor_id,generation,expected_generation FROM liekan_geo_weight_head WHERE id=$1',
          initial.taskId,
        )
      )[0],
    ).toEqual({ actor_id: opener.id, generation: 1, expected_generation: 1 });
    expect(
      (
        await q(
          'SELECT count(*)::int AS count FROM liekan_jobs.job WHERE name=$1',
          GEO_SNAPSHOT_QUEUE,
        )
      )[0].count,
    ).toBe(jobs);
    expect(h.aggregate).toHaveBeenCalledTimes(1);
  });
  it('expires unused snapshot contents below quota while retaining active, export and idempotency references', async () => {
    const fresh = await ready();
    const inactiveSite = randomUUID(),
      deletedSite = randomUUID();
    await q(
      "INSERT INTO website(website_id,name,domain,user_id) VALUES($1,'Inactive','inactive.example.com',$2)",
      inactiveSite,
      actor.id,
    );
    await q(
      "INSERT INTO website(website_id,name,domain,user_id) VALUES($1,'Deleted','deleted.example.com',$2)",
      deletedSite,
      actor.id,
    );
    const expired = randomUUID(),
      unused = randomUUID(),
      orphaned = randomUUID(),
      exporting = randomUUID(),
      active = randomUUID();
    for (const [id, age, exportingNow, target] of [
      [expired, 100, false, site],
      [unused, 101, false, inactiveSite],
      [orphaned, 104, false, deletedSite],
      [exporting, 102, true, site],
      [active, 103, false, site],
    ] as const) {
      await q(
        `INSERT INTO liekan_geo_weight_snapshot(id,website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,generation,input_boundary,calculated_at,result,result_bytes,result_digest,expires_at,export_until)
        SELECT $2::uuid,$3::uuid,hostname,timezone,as_of-$4::int,epoch,algorithm,scope_hash,strong_version,generation,input_boundary,calculated_at,result,result_bytes,result_digest,now()-interval '1 day',CASE WHEN $5 THEN now()+interval '60 seconds' END
        FROM liekan_geo_weight_snapshot WHERE id=$1::uuid`,
        fresh.snapshotId,
        id,
        target,
        age,
        exportingNow,
      );
    }
    await q('DELETE FROM website WHERE website_id=$1', deletedSite);
    const receiptHead = randomUUID(),
      activeHead = randomUUID(),
      requestId = randomUUID();
    for (const [id, snapshot, status] of [
      [receiptHead, expired, 'ready'],
      [activeHead, active, 'running'],
    ] as const)
      await q(
        `INSERT INTO liekan_geo_weight_head(id,website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,snapshot_id,generation,task_status,actor_id,ownership,lease_until)
        SELECT $2::uuid,website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,id,generation,$3,$4::uuid,$5,CASE WHEN $3='running' THEN now()+interval '90 seconds' END
        FROM liekan_geo_weight_snapshot WHERE id=$1`,
        snapshot,
        id,
        status,
        actor.id,
        'fixture-ownership',
      );
    await q(
      "INSERT INTO liekan_geo_weight_request(website_id,actor_id,request_id,parameter_hash,head_id) VALUES($1,$2,$3,'fixture',$4)",
      site,
      actor.id,
      requestId,
      receiptHead,
    );
    await reconcileGeoSnapshots(boss);
    expect(
      (await q('SELECT id FROM liekan_geo_weight_snapshot ORDER BY id')).map(row => row.id).sort(),
    ).toEqual([fresh.snapshotId, exporting, active].sort());
    expect(
      (await q('SELECT snapshot_id FROM liekan_geo_weight_head WHERE id=$1', receiptHead))[0]
        .snapshot_id,
    ).toBeNull();
    expect(
      (await q('SELECT head_id FROM liekan_geo_weight_request WHERE request_id=$1', requestId))[0]
        .head_id,
    ).toBe(receiptHead);
    await q(
      "UPDATE liekan_geo_weight_snapshot SET export_until=now()-interval '1 second' WHERE id=$1",
      exporting,
    );
    await q(
      "UPDATE liekan_geo_weight_head SET task_status='failed',lease_until=NULL WHERE id=$1",
      activeHead,
    );
    await reconcileGeoSnapshots(boss);
    expect((await q('SELECT id FROM liekan_geo_weight_snapshot')).map(row => row.id)).toEqual([
      fresh.snapshotId,
    ]);
  });
  it.each([
    ['UTC', 'Etc/UTC'],
    ['America/Los_Angeles', 'america/los_angeles'],
  ])(
    'coalesces canonical timezone %s and equivalent spelling %s for reads and manual receipts',
    async (canonical, alias) => {
      const initial = await readGeoWeightSnapshot(actor, site, { ...input(), timezone: canonical });
      const second = await readGeoWeightSnapshot(actor, site, { ...input(), timezone: alias });
      expect(second.taskId).toBe(initial.taskId);
      expect((await q('SELECT count(*)::int AS count FROM liekan_geo_weight_head'))[0].count).toBe(
        1,
      );
      await run();
      const saved = await readGeoWeightSnapshot(actor, site, { ...input(), timezone: canonical });
      expect(
        (
          await readGeoWeightSnapshot(actor, site, {
            ...input(),
            timezone: alias,
            snapshotId: saved.snapshotId,
          })
        ).snapshotId,
      ).toBe(saved.snapshotId);
      expect(
        (
          await readGeoWeightSnapshot(actor, site, {
            ...input(),
            timezone: alias,
            taskId: initial.taskId,
          })
        ).snapshotId,
      ).toBe(saved.snapshotId);
      const requestId = randomUUID();
      const first = await recalculateGeoWeight(actor, site, {
        mode: 'current',
        timezone: canonical,
        requestId,
      });
      const retried = await recalculateGeoWeight(actor, site, {
        mode: 'current',
        timezone: alias,
        requestId,
      });
      expect(retried.taskId).toBe(first.taskId);
    },
  );
  it('rejects numeric-offset timezones before registering any demand or recalculation receipt', async () => {
    await expect(
      readGeoWeightSnapshot(actor, site, { ...input(), timezone: '+01:00' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      recalculateGeoWeight(actor, site, {
        mode: 'current',
        timezone: '+01:00',
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await q('SELECT count(*)::int AS count FROM liekan_geo_weight_head'))[0].count).toBe(0);
    expect((await q('SELECT count(*)::int AS count FROM liekan_geo_weight_request'))[0].count).toBe(
      0,
    );
  });
  it("retires an orphan website's only expired active head and its manual receipt during maintenance", async () => {
    const current = await ready(),
      orphanSite = randomUUID(),
      orphanSnapshot = randomUUID(),
      orphanHead = randomUUID(),
      requestId = randomUUID();
    await q(
      "INSERT INTO website(website_id,name,domain,user_id) VALUES($1,'Deleted owner site','deleted.example.com',$2)",
      orphanSite,
      actor.id,
    );
    await q(
      `INSERT INTO liekan_geo_weight_snapshot(id,website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,generation,input_boundary,calculated_at,result,result_bytes,result_digest,expires_at)
      SELECT $2::uuid,$3::uuid,hostname,timezone,as_of-100,epoch,algorithm,scope_hash,strong_version,generation,input_boundary,calculated_at,result,result_bytes,result_digest,now()-interval '1 day'
      FROM liekan_geo_weight_snapshot WHERE id=$1`,
      current.snapshotId,
      orphanSnapshot,
      orphanSite,
    );
    await q(
      `INSERT INTO liekan_geo_weight_head(id,website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,snapshot_id,generation,task_status,actor_id,ownership,lease_until)
      SELECT $2::uuid,website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,id,generation,'running',$3::uuid,'orphan-fixture',now()+interval '90 seconds'
      FROM liekan_geo_weight_snapshot WHERE id=$1`,
      orphanSnapshot,
      orphanHead,
      actor.id,
    );
    await q(
      "INSERT INTO liekan_geo_weight_request(website_id,actor_id,request_id,parameter_hash,head_id) VALUES($1,$2,$3,'fixture',$4)",
      orphanSite,
      actor.id,
      requestId,
      orphanHead,
    );
    await q('DELETE FROM website WHERE website_id=$1', orphanSite);
    await reconcileGeoSnapshots(boss);
    expect(await q('SELECT id FROM liekan_geo_weight_head WHERE id=$1', orphanHead)).toEqual([]);
    expect(
      await q('SELECT request_id FROM liekan_geo_weight_request WHERE request_id=$1', requestId),
    ).toEqual([]);
    expect(
      await q('SELECT id FROM liekan_geo_weight_snapshot WHERE id=$1', orphanSnapshot),
    ).toEqual([]);
    expect(
      (await q('SELECT id FROM liekan_geo_weight_snapshot WHERE id=$1', current.snapshotId))[0]?.id,
    ).toBe(current.snapshotId);
  });
  it('skips expiry candidates whose referencing head is locked by another transaction', async () => {
    const saved = await ready(),
      expired = randomUUID();
    await q(
      `INSERT INTO liekan_geo_weight_snapshot(id,website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,generation,input_boundary,calculated_at,result,result_bytes,result_digest,expires_at)
      SELECT $2::uuid,website_id,hostname,timezone,as_of-100,epoch,algorithm,scope_hash,strong_version,generation,input_boundary,calculated_at,result,result_bytes,result_digest,now()-interval '1 day'
      FROM liekan_geo_weight_snapshot WHERE id=$1`,
      saved.snapshotId,
      expired,
    );
    await q('UPDATE liekan_geo_weight_head SET snapshot_id=$2 WHERE id=$1', saved.taskId, expired);
    const publisher = await pool.connect();
    try {
      await publisher.query('BEGIN');
      await publisher.query('SELECT id FROM liekan_geo_weight_head WHERE id=$1 FOR UPDATE', [
        saved.taskId,
      ]);
      await reconcileGeoSnapshots(boss);
      expect(
        (await q('SELECT id FROM liekan_geo_weight_snapshot WHERE id=$1', expired))[0]?.id,
      ).toBe(expired);
    } finally {
      await publisher.query('ROLLBACK');
      publisher.release();
    }
    await reconcileGeoSnapshots(boss);
    expect(await q('SELECT id FROM liekan_geo_weight_snapshot WHERE id=$1', expired)).toEqual([]);
  }, 15000);
  it('skips locked LRU heads at capacity and admits demand after their reader releases its lock', async () => {
    const current = await ready();
    const past = {
      ...input(),
      mode: 'historical',
      asOf: geoDateOffset(current.requestedAsOf, -100),
    };
    await readGeoWeightSnapshot(actor, site, past);
    await run();
    const historic = await readGeoWeightSnapshot(actor, site, past);
    await q(
      `INSERT INTO liekan_geo_weight_snapshot(id,website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,generation,input_boundary,calculated_at,result,result_bytes,result_digest)
      SELECT gen_random_uuid(),s.website_id,s.hostname,s.timezone,s.as_of,s.epoch,s.algorithm,s.scope_hash,s.strong_version,n+1,s.input_boundary,s.calculated_at,s.result,s.result_bytes,s.result_digest
      FROM liekan_geo_weight_snapshot s CROSS JOIN generate_series(1,498) n WHERE s.id=$1`,
      current.snapshotId,
    );
    const reader = await pool.connect();
    const requested = { ...past, asOf: geoDateOffset(past.asOf, -1) };
    try {
      await reader.query('BEGIN');
      await reader.query('SELECT id FROM liekan_geo_weight_head WHERE id=$1 FOR UPDATE', [
        historic.taskId,
      ]);
      const blocked = await readGeoWeightSnapshot(actor, site, requested);
      expect(blocked.taskStatus).toBe('capacity_blocked');
      expect(
        (await q('SELECT snapshot_id FROM liekan_geo_weight_head WHERE id=$1', historic.taskId))[0]
          .snapshot_id,
      ).toBe(historic.snapshotId);
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
    }
    const admitted = await readGeoWeightSnapshot(actor, site, requested);
    expect(admitted.taskStatus).toBe('queued');
    expect(
      await q('SELECT id FROM liekan_geo_weight_snapshot WHERE id=$1', historic.snapshotId),
    ).toEqual([]);
  }, 15000);
  it('reads a previously saved raw timezone alias snapshot through its canonical timezone', async () => {
    const saved = await ready(),
      legacy = randomUUID(),
      legacyHead = randomUUID();
    await q(
      `INSERT INTO liekan_geo_weight_snapshot(id,website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,generation,input_boundary,calculated_at,result,result_bytes,result_digest)
      SELECT $2::uuid,website_id,hostname,'Etc/UTC',as_of,epoch,algorithm,scope_hash,strong_version,generation,input_boundary,calculated_at,result||jsonb_build_object('timezone','Etc/UTC'),result_bytes,result_digest
      FROM liekan_geo_weight_snapshot WHERE id=$1`,
      saved.snapshotId,
      legacy,
    );
    const exact = await readGeoWeightSnapshot(actor, site, { ...input(), snapshotId: legacy });
    expect(exact.snapshotId).toBe(legacy);
    expect(exact.result.timezone).toBe('Etc/UTC');
    await q(
      `INSERT INTO liekan_geo_weight_head(id,website_id,hostname,timezone,as_of,epoch,algorithm,scope_hash,strong_version,snapshot_id,generation,task_status,actor_id,ownership)
      SELECT $2::uuid,website_id,hostname,'Etc/UTC',as_of,epoch,algorithm,scope_hash,strong_version,$3::uuid,generation,'ready',actor_id,ownership
      FROM liekan_geo_weight_head WHERE id=$1`,
      saved.taskId,
      legacyHead,
      legacy,
    );
    expect(
      (await readGeoWeightSnapshot(actor, site, { ...input(), taskId: legacyHead })).snapshotId,
    ).toBe(legacy);
    const requestId = randomUUID();
    const legacyHash = createHash('sha256')
      .update(JSON.stringify(['current', saved.requestedAsOf, 'Etc/UTC', GEO_ALGORITHM]))
      .digest('hex');
    await q(
      'INSERT INTO liekan_geo_weight_request(website_id,actor_id,request_id,parameter_hash,head_id) VALUES($1,$2,$3,$4,$5)',
      site,
      actor.id,
      requestId,
      legacyHash,
      legacyHead,
    );
    const retried = await recalculateGeoWeight(actor, site, {
      mode: 'current',
      timezone: 'UTC',
      requestId,
    });
    expect(retried.taskId).toBe(legacyHead);
    expect(retried.snapshotId).toBe(legacy);
  });
});
