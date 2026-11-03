// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_REPAIR_ENGINE } from '../contracts/history-repair';

const enabled = process.env.LIEKAN_ANALYSIS_ROLLUPS_TEST === '1';
const actor = { userId: randomUUID() };
let db: typeof import('./analysis-rollups-db');
let prisma: typeof import('@/lib/prisma').default;
let service: typeof import('../log-ingestion/service');
let website: string;
const q = <T = any[]>(statement: string, ...values: unknown[]) =>
  db.analysisTransaction(tx => tx.$queryRawUnsafe<T>(statement, ...values));
const sql = (statement: string, ...values: unknown[]) =>
  db.analysisTransaction(tx => tx.$executeRawUnsafe(statement, ...values));
type Source = { id: string; token: string };
type Outcome = { ok: boolean; status?: number; code?: string };
type Worker = { name: string; child: ChildProcess; done: Promise<Outcome> };

async function connect() {
  const url = new URL(process.env.DATABASE_URL);
  const schema = url.searchParams.get('schema');
  url.searchParams.delete('schema');
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);
  return client;
}
async function source(): Promise<Source> {
  const { newToken, tokenHash } = await import('../log-ingestion/secrets');
  const id = randomUUID(),
    token = newToken();
  await sql(
    `INSERT INTO liekan_log_source(id,website_id,kind,domain,created_by,owner_id,team_id,state,credential_hash)
     SELECT $1::uuid,$2::uuid,'server','example.test',$3::uuid,user_id,team_id,'active',$4
     FROM website WHERE website_id=$2::uuid`,
    id,
    website,
    actor.userId,
    tokenHash(token),
  );
  await sql(
    "INSERT INTO liekan_log_interval(id,website_id,source_id,starts_at) VALUES($1::uuid,$2::uuid,$3::uuid,'2026-01-01Z')",
    randomUUID(),
    website,
    id,
  );
  return { id, token };
}
async function batch(input: Source, generation = randomUUID(), path = '/synthetic', day = '04') {
  const result = await service.receiveBatch(
    new Request('https://collector.invalid/upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        batchId: randomUUID(),
        epoch: 1,
        events: [
          {
            generation,
            offset: 0,
            line: `192.0.2.20 - - [${day}/Oct/2026:10:00:00 +0800] "GET ${path} HTTP/1.1" 200 25 "-" "GPTBot"`,
          },
        ],
      }),
    }),
    input.id,
  );
  expect(result).toMatchObject({ valid: 1, rejected: 0 });
  return (result as { batchId: string }).batchId;
}
function worker(batchId: string): Worker {
  const name = `analysis-ingest-${randomUUID()}`;
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('application_name', name);
  const code = `const {processBatch}=require('./src/lib/liekan/log-ingestion/service.ts');
const prisma=require('./src/lib/prisma.ts').default;
(async()=>{try{await processBatch(process.argv[1]);console.log(JSON.stringify({ok:true}));}
catch(error){console.log(JSON.stringify({ok:false,status:error.status,code:error.meta?.driverAdapterError?.cause?.originalCode??error.meta?.code??error.code}));}
finally{await prisma.client.$disconnect();}})();`;
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', code, batchId], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    errors = '';
  child.stdout.on('data', bytes => {
    output += bytes.toString();
  });
  child.stderr.on('data', bytes => {
    errors += bytes.toString();
  });
  const done = new Promise<Outcome>((resolve, reject) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', async status => {
      clearTimeout(timeout);
      if (status !== 0) {
        await writeFile(`${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/${name}.log`, errors, {
          mode: 0o600,
        });
        reject(new Error('isolated-ingest-worker-failed'));
        return;
      }
      try {
        resolve(JSON.parse(output.trim().split('\n').at(-1)));
      } catch {
        reject(new Error('isolated-ingest-worker-result-missing'));
      }
    });
  });
  return { name, child, done };
}
async function waiting(client: Client, name: string, blocker: number) {
  for (let n = 0; n < 250; n++) {
    const { rows } = await client.query(
      `SELECT pid,query,query_start,clock_timestamp() AS observed_at,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers
       FROM pg_stat_activity WHERE application_name=$1 AND datname=current_database()`,
      [name],
    );
    const row = rows.find(row => row.blockers.includes(blocker));
    if (row) return row;
    await sleep(20);
  }
  throw new Error('expected-database-lock-barrier-not-reached');
}
async function managerBeforeBatch(id: string, change: (client: Client) => Promise<unknown>) {
  const manager = await connect(),
    observer = await connect();
  let task: Worker;
  try {
    await manager.query('BEGIN');
    const {
      rows: [{ pid }],
    } = await manager.query('SELECT pg_backend_pid() AS pid');
    await manager.query('SELECT website_id FROM website WHERE website_id=$1::uuid FOR UPDATE', [
      website,
    ]);
    await change(manager);
    task = worker(id);
    const wait = await waiting(observer, task.name, pid);
    expect(wait.query).toContain('FROM website');
    expect(wait.query).toContain('FOR SHARE');
    await manager.query('COMMIT');
    return await task.done;
  } finally {
    await manager.query('ROLLBACK');
    await manager.end();
    await observer.end();
    if (task) await task.done;
  }
}
async function counts() {
  return (
    await q(
      `SELECT
    (SELECT count(*)::int FROM liekan_log WHERE website_id=$1::uuid) AS logs,
    (SELECT count(*)::int FROM liekan_effective_log WHERE website_id=$1::uuid) AS effective,
    (SELECT count(*)::int FROM liekan_log_geography WHERE website_id=$1::uuid) AS geography,
    (SELECT count(*)::int FROM liekan_crawler_evidence WHERE website_id=$1::uuid) AS evidence,
    (SELECT count(*)::int FROM liekan_import WHERE website_id=$1::uuid) AS imports,
    (SELECT data_revision::int FROM liekan_log_state WHERE website_id=$1::uuid) AS revision`,
      website,
    )
  )[0];
}
async function collect() {
  const { withCollectionWrite, collectionWriteClient } = await import('./collection-write');
  const { observeCollection } = await import('./collection-observation');
  const { saveEvent } = await import('@/queries/sql/events/saveEvent');
  const eventId = randomUUID(),
    sessionId = randomUUID();
  return withCollectionWrite(
    {
      websiteId: website,
      eventId,
      fingerprint: eventId,
      quality: {
        classification: 'browser',
        source: 'browser',
        reasons: ['synthetic'],
        ruleVersion: 'fixture',
        catalogVersion: null,
        rangeVersion: null,
        rangeStatus: 'missing',
        hostname: 'example.test',
      },
      geography: {
        location: { country: 'CN', region: 'CN-11', city: '北京市' },
        source: 'synthetic',
        trust: 'unverified',
        ipFamily: 'missing',
        precision: 'city',
        reason: 'synthetic',
        ruleVersion: 'fixture',
        dataVersion: null,
        cityId: null,
        accuracyRadius: null,
        countryBasis: 'missing',
        processedAt: new Date().toISOString(),
        shadow: null,
      },
      observation: observeCollection(new Request('https://example.test')),
    },
    async () => {
      await collectionWriteClient().$executeRawUnsafe(
        "INSERT INTO session(session_id,website_id,browser) VALUES($1::uuid,$2::uuid,'Synthetic')",
        sessionId,
        website,
      );
      return saveEvent({
        websiteId: website,
        sessionId,
        visitId: sessionId,
        eventType: 1,
        createdAt: new Date(),
        hostname: 'example.test',
        urlPath: '/synthetic',
        eventData: { synthetic: 'fixture' },
      });
    },
  );
}

describe.skipIf(!enabled)(
  'batch authority with real browser collection and independent workers',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_URL || 'http://invalid');
      if (
        url.hostname !== '127.0.0.1' ||
        url.port !== '15462' ||
        url.pathname !== '/liekan_analysis_rollups_test' ||
        !/^analysis_[a-f0-9]+$/.test(url.searchParams.get('schema') || '')
      )
        throw new Error('owned-analysis-schema-required');
      db = await import('./analysis-rollups-db');
      ({ default: prisma } = await import('@/lib/prisma'));
      service = await import('../log-ingestion/service');
      await sql(
        "INSERT INTO \"user\"(user_id,username,password,role) VALUES($1::uuid,$1::text,'fixture','user')",
        actor.userId,
      );
    });
    beforeEach(async () => {
      website = randomUUID();
      await sql(
        "INSERT INTO website(website_id,name,domain,user_id) VALUES($1::uuid,'Synthetic batch authority','example.test',$2::uuid)",
        website,
        actor.userId,
      );
      await sql('INSERT INTO liekan_log_state(website_id) VALUES($1::uuid)', website);
    });
    afterEach(async () => {
      await db.analysisTransaction(async tx => {
        await tx.$queryRawUnsafe(
          'SELECT website_id FROM website WHERE website_id=$1::uuid FOR UPDATE',
          website,
        );
        await tx.$queryRawUnsafe(
          'SELECT website_id FROM liekan_analysis_site WHERE website_id=$1::uuid FOR UPDATE',
          website,
        );
        await tx.$executeRawUnsafe('DELETE FROM website WHERE website_id=$1::uuid', website);
      });
    });
    afterAll(async () => {
      if (enabled && prisma) await prisma.client.$disconnect();
    });

    it('keeps standard migration DDL locks within two seconds and retries atomically', async () => {
      const migration = '048_analytics_revenue_proof.sql';
      const checksum = createHash('sha256')
        .update(await readFile(`db/liekan/migrations/${migration}`))
        .digest('hex');
      const input = await source(),
        batchId = await batch(input);
      expect(await worker(batchId).done).toEqual({ ok: true });
      expect(await counts()).toEqual({
        logs: 1,
        effective: 1,
        geography: 1,
        evidence: 1,
        imports: 1,
        revision: 1,
      });
      type Journal = { name: string; checksum: string; appliedAt: string };
      const journal = () =>
        q<Journal[]>(
          'SELECT name,checksum,applied_at::text AS "appliedAt" FROM liekan_migration ORDER BY name',
        );
      const facts = async () =>
        (
          await q(
            `SELECT count(*)::int AS rows,md5(string_agg(to_jsonb(l)::text,',' ORDER BY id)) AS digest
             FROM liekan_log l WHERE website_id=$1::uuid`,
            website,
          )
        )[0];
      const view = async () =>
        (
          await q<{ definition: string }[]>(
            "SELECT pg_get_viewdef('liekan_effective_revenue'::regclass,true) AS definition",
          )
        )[0].definition;
      const before = { journal: await journal(), facts: await facts(), view: await view() };
      const original = before.journal.find(row => row.name === migration);
      expect(before.journal.map(row => row.name)).toEqual(Object.keys(JSON.parse(await readFile('config/liekan/migrations.json', 'utf8'))).sort());
      expect(original.checksum).toBe(checksum);
      expect(before.facts.rows).toBe(1);
      const retained = before.journal.filter(row => row.name !== migration);
      let holder: Client, observer: Client;
      type MigrationProcess = {
        child: ChildProcess;
        done: Promise<{ code: number; signal: string; stdout: string; stderr: string }>;
        name: string;
      };
      const children: MigrationProcess[] = [];
      const start = (phase: string): MigrationProcess => {
        const name = `analysis-migrate-${randomUUID()}`;
        const url = new URL(process.env.DATABASE_URL);
        url.searchParams.set('application_name', name);
        const child = spawn(process.execPath, ['scripts/liekan-migrate.mjs'], {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: url.toString() },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', bytes => (stdout += bytes.toString()));
        child.stderr.on('data', bytes => (stderr += bytes.toString()));
        const done = new Promise<{
          code: number;
          signal: string;
          stdout: string;
          stderr: string;
        }>((resolve, reject) => {
          const deadline = setTimeout(() => child.kill('SIGKILL'), 15000);
          child.once('error', error => {
            clearTimeout(deadline);
            reject(error);
          });
          child.once('close', async (code, signal) => {
            clearTimeout(deadline);
            try {
              await writeFile(
                `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/migration-lock-${phase}.log`,
                `${stdout}\n${stderr}`,
                { mode: 0o600 },
              );
              resolve({ code, signal, stdout, stderr });
            } catch (error) {
              reject(error);
            }
          });
        });
        const migrationProcess = { child, done, name };
        children.push(migrationProcess);
        return migrationProcess;
      };
      try {
        holder = await connect();
        observer = await connect();
        await sql('DELETE FROM liekan_migration WHERE name=$1', migration);
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE liekan_effective_revenue IN ACCESS SHARE MODE');
        const {
          rows: [{ pid }],
        } = await holder.query('SELECT pg_backend_pid() AS pid');
        const blocked = start('blocked');
        const wait = await waiting(observer, blocked.name, pid);
        const observed = performance.now();
        expect(wait.query).toContain('CREATE OR REPLACE VIEW liekan_effective_revenue');
        const locks = (
          await observer.query(
            `SELECT pid,mode,granted FROM pg_locks WHERE pid=ANY($1::int[])
             AND relation='liekan_effective_revenue'::regclass ORDER BY pid,mode`,
            [[pid, wait.pid]],
          )
        ).rows;
        const failed = await blocked.done;
        const lockWaitMs =
          +new Date(wait.observed_at) - +new Date(wait.query_start) + performance.now() - observed;
        const rolledBack = { journal: await journal(), facts: await facts(), view: await view() };
        expect(failed.code).not.toBe(0);
        expect(failed.signal).toBeNull();
        expect(failed.stderr).toContain('55P03');
        expect(locks).toContainEqual({ pid, mode: 'AccessShareLock', granted: true });
        expect(locks).toContainEqual({
          pid: wait.pid,
          mode: 'AccessExclusiveLock',
          granted: false,
        });
        expect(rolledBack).toEqual({ ...before, journal: retained });
        await holder.query('ROLLBACK');
        const resumed = await start('released').done;
        expect(resumed.code).toBe(0);
        expect(resumed.stdout).toContain(`Liekan migration applied: ${migration}`);
        const applied = await journal();
        expect(applied).toHaveLength(before.journal.length);
        expect(applied.filter(row => row.name !== migration)).toEqual(retained);
        expect(applied.find(row => row.name === migration).checksum).toBe(checksum);
        const repeated = await start('idempotent').done;
        expect(repeated.code).toBe(0);
        expect(repeated.stdout).not.toContain('Liekan migration applied:');
        expect(await journal()).toEqual(applied);
        expect(await facts()).toEqual(before.facts);
        expect(await view()).toBe(before.view);
        await writeFile(
          `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/migration-lock-evidence.json`,
          JSON.stringify({
            migration,
            checksum,
            before,
            wait,
            locks,
            lockWaitMs,
            rolledBack,
            applied,
          }),
          { mode: 0o600 },
        );
        expect(lockWaitMs).toBeGreaterThanOrEqual(1500);
        expect(lockWaitMs).toBeLessThanOrEqual(3500);
      } finally {
        for (const child of children)
          if (child.child.exitCode === null && child.child.signalCode === null)
            child.child.kill('SIGTERM');
        await Promise.allSettled(children.map(child => child.done));
        try {
          await holder?.query('ROLLBACK');
          if (original) {
            await sql(
              `INSERT INTO liekan_migration(name,checksum,applied_at) VALUES($1,$2,$3::timestamptz)
               ON CONFLICT(name) DO UPDATE SET checksum=EXCLUDED.checksum,applied_at=EXCLUDED.applied_at`,
              original.name,
              original.checksum,
              original.appliedAt,
            );
            expect(await journal()).toEqual(before.journal);
          }
        } finally {
          await Promise.allSettled([holder?.end(), observer?.end()]);
        }
      }
    }, 30000);

    it('serializes same-visit collection before the marker snapshot while retaining atomic receipts and evidence', async () => {
      const { AsyncLocalStorage } = await import('node:async_hooks');
      const { createHash } = await import('node:crypto');
      const module = await import('@/lib/prisma');
      const { withCollectionWrite, collectionWriteClient, recordEventQuality } = await import(
        './collection-write'
      );
      const { observeCollection } = await import('./collection-observation');
      const observer = await connect();
      const session = randomUUID(),
        visit = randomUUID();
      const ids: Record<string, string> = {};
      for (const [role, shard] of Object.entries({ P: 17, C: 3, H: 31, D: 5 })) {
        do {
          ids[role] = randomUUID();
        } while (createHash('md5').update(ids[role]).digest()[0] % 32 !== shard);
      }
      const receipts = Object.fromEntries(Object.keys(ids).map(role => [role, randomUUID()]));
      const pids: Record<string, number> = {},
        frames: unknown[] = [],
        seen: any[] = [];
      const roles = new AsyncLocalStorage<string>();
      const defer = () => {
        let resolve!: () => void;
        return {
          promise: new Promise<void>(r => {
            resolve = r;
          }),
          resolve: () => resolve(),
        };
      };
      const cInserted = defer(),
        releaseC = defer(),
        hInserted = defer(),
        releaseH = defer();
      const primary: any = module.getRawQueryClient(prisma.client, { write: true });
      const originalTransaction = primary.$transaction.bind(primary);
      const spy = vi.spyOn(primary, '$transaction').mockImplementation(
        (work: any, options: any) =>
          originalTransaction(
            async (tx: any) =>
              work(
                new Proxy(tx, {
                  get(object, key) {
                    if (key === '$queryRawUnsafe')
                      return async (statement: string, ...values: unknown[]) => {
                        const result = await object.$queryRawUnsafe(statement, ...values);
                        const role = roles.getStore();
                        if (
                          role &&
                          statement.includes('FROM website') &&
                          statement.includes('FOR SHARE')
                        )
                          pids[role] = (
                            await object.$queryRawUnsafe('SELECT pg_backend_pid() AS pid')
                          )[0].pid;
                        return result;
                      };
                    const value = Reflect.get(object, key);
                    return typeof value === 'function' ? value.bind(object) : value;
                  },
                }),
              ),
            options,
          ) as any,
      );
      const event = (role: string) =>
        roles
          .run(role, () =>
            withCollectionWrite(
              {
                websiteId: website,
                eventId: receipts[role],
                fingerprint: role,
                quality: {
                  classification: 'browser',
                  source: 'browser',
                  reasons: ['synthetic'],
                  ruleVersion: 'fixture',
                  catalogVersion: null,
                  rangeVersion: null,
                  rangeStatus: 'missing',
                  hostname: 'example.test',
                },
                geography: {
                  location: { country: 'CN', region: 'CN-11', city: '北京市' },
                  source: 'synthetic',
                  trust: 'unverified',
                  ipFamily: 'missing',
                  precision: 'city',
                  reason: 'synthetic',
                  ruleVersion: 'fixture',
                  dataVersion: null,
                  cityId: null,
                  accuracyRadius: null,
                  countryBasis: 'missing',
                  processedAt: new Date().toISOString(),
                  shadow: null,
                },
                observation: observeCollection(new Request('https://example.test')),
              },
              async () => {
                const tx = collectionWriteClient();
                await tx.$executeRawUnsafe(
                  `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type,hostname)
          VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'2026-10-23T18:00:00Z',$5,1,'example.test')`,
                  ids[role],
                  website,
                  session,
                  visit,
                  `/synthetic/${role}`,
                );
                if (role === 'C') {
                  cInserted.resolve();
                  await releaseC.promise;
                }
                if (role === 'H') {
                  seen.push(
                    await tx.$queryRawUnsafe(
                      `SELECT shard,revision::text FROM liekan_analysis_dirty WHERE website_id=$1::uuid AND family='visit' AND isfinite(bucket) ORDER BY shard`,
                      website,
                    ),
                  );
                  hInserted.resolve();
                  await releaseH.promise;
                }
                await recordEventQuality(tx, ids[role], website);
                return { eventId: ids[role] };
              },
            ),
          )
          .then(
            value => ({ ok: true, role, value, code: undefined }),
            (error: any) => ({
              ok: false,
              role,
              code: error.meta?.driverAdapterError?.cause?.originalCode ?? error.code,
            }),
          );
      const wait = async (a: string, b: string) => {
        for (let n = 0; n < 250; n++) {
          const { rows } = await observer.query(
            `SELECT pid,query,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=ANY($1::int[]) ORDER BY pid`,
            [Object.values(pids)],
          );
          frames.push({ at: new Date().toISOString(), rows });
          const row = rows.find(r => r.pid === pids[a] && r.blockers.includes(pids[b]));
          if (row) return row;
          await sleep(20);
        }
        throw new Error(`same-visit-${a}-not-waiting-${b}`);
      };
      let c: ReturnType<typeof event>, h: ReturnType<typeof event>, d: ReturnType<typeof event>;
      try {
        await sql(
          'INSERT INTO session(session_id,website_id) VALUES($1::uuid,$2::uuid)',
          session,
          website,
        );
        expect((await event('P')).ok).toBe(true);
        c = event('C');
        await cInserted.promise;
        h = event('H');
        expect((await wait('H', 'C')).query).toContain('INSERT INTO website_event');
        releaseC.resolve();
        expect((await c).ok).toBe(true);
        await hInserted.promise;
        d = event('D');
        expect((await wait('D', 'H')).query).toContain('INSERT INTO website_event');
        releaseH.resolve();
        const outcomes = await Promise.all([h, d]);
        const facts = (
          await q(
            `SELECT
          (SELECT array_agg(event_id::text ORDER BY event_id) FROM website_event WHERE website_id=$1::uuid) AS events,
          (SELECT count(*)::int FROM liekan_event_geography WHERE website_id=$1::uuid) AS geography,
          (SELECT count(*)::int FROM liekan_event_quality WHERE website_id=$1::uuid) AS quality,
          (SELECT count(*)::int FROM liekan_event_observation WHERE website_id=$1::uuid) AS observations,
          (SELECT count(*)::int FROM liekan_collection_receipt WHERE website_id=$1::uuid AND event_id IS NOT NULL) AS receipts,
          (SELECT count(*)::int FROM liekan_collection_receipt WHERE website_id=$1::uuid AND event_id IS NULL) AS dangling`,
            website,
          )
        )[0];
        await writeFile(
          `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/same-visit-collection.json`,
          JSON.stringify({ website, visit, ids, pids, seen, frames, outcomes, facts }, null, 2),
          { mode: 0o600 },
        );
        // Both winners retain every business fact; a failed transaction leaves no partial receipt.
        expect(facts).toMatchObject({
          geography: facts.events.length,
          quality: facts.events.length,
          observations: facts.events.length,
          receipts: facts.events.length,
          dangling: 0,
        });
        expect(outcomes.map(r => r.code)).not.toContain('40P01');
        expect(outcomes.every(r => r.ok)).toBe(true);
        expect(facts.events).toEqual(Object.values(ids).sort());
        expect(seen[0].find(r => r.shard === 3)?.revision).toBe('4');
      } finally {
        releaseC.resolve();
        releaseH.resolve();
        await Promise.allSettled([c, h, d].filter(Boolean));
        spy.mockRestore();
        await observer.end();
      }
    }, 30000);

    it('pins evidence to the current raw visit and time and atomically rejects a concurrent raw move', async () => {
      const [moving, evidence, observer] = await Promise.all([connect(), connect(), connect()]);
      const { createHash } = await import('node:crypto');
      const slot = (id: string) => createHash('md5').update(id).digest()[0] % 32;
      let afterVisit = randomUUID();
      const event = randomUUID(),
        session = randomUUID(),
        beforeVisit = randomUUID(),
        receipt = randomUUID();
      while (slot(afterVisit) === slot(beforeVisit)) afterVisit = randomUUID();
      const facts = async () =>
        (
          await observer.query(
            `SELECT
        (SELECT count(*)::int FROM liekan_event_geography WHERE website_id=$1) AS geography,
        (SELECT count(*)::int FROM liekan_event_quality WHERE website_id=$1) AS quality,
        (SELECT count(*)::int FROM liekan_collection_receipt WHERE website_id=$1) AS receipts,
        (SELECT visit_id::text FROM website_event WHERE event_id=$2 AND website_id=$1) AS visit,
        (SELECT created_at FROM website_event WHERE event_id=$2 AND website_id=$1) AS event_time`,
            [website, event],
          )
        ).rows[0];
      const insertGeography = () =>
        evidence.query(
          `INSERT INTO liekan_event_geography(event_id,website_id,country,source,trust,ip_family,precision,reason,rule_version,country_basis,processed_at)
        VALUES($1,$2,'CN','synthetic','unverified','missing','country','synthetic','fixture','missing',now())`,
          [event, website],
        );
      let attempt: Promise<any>;
      const frames: unknown[] = [];
      try {
        await sql(
          `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type)
          VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'2026-10-23T10:01:00Z','/synthetic/mapping',1)`,
          event,
          website,
          session,
          beforeVisit,
        );
        await moving.query('BEGIN');
        await moving.query("SET LOCAL statement_timeout='5s'");
        await moving.query(
          `UPDATE website_event SET visit_id=$1,created_at='2026-10-23T11:01:00Z' WHERE website_id=$2 AND event_id=$3`,
          [afterVisit, website, event],
        );
        // An unlocked mapping sees the old committed tuple while the move is in flight.
        expect(
          (
            await observer.query(
              'SELECT visit_id::text FROM website_event WHERE event_id=$1 AND website_id=$2',
              [event, website],
            )
          ).rows[0].visit_id,
        ).toBe(beforeVisit);
        await evidence.query('BEGIN');
        await evidence.query("SET LOCAL statement_timeout='5s'");
        await evidence.query(
          "INSERT INTO liekan_collection_receipt(website_id,client_event_id,payload_hash) VALUES($1,$2,'synthetic')",
          [website, receipt],
        );
        let settled = false;
        attempt = insertGeography()
          .then(
            () => ({ ok: true, code: undefined }),
            error => ({ ok: false, code: error.code }),
          )
          .finally(() => {
            settled = true;
          });
        for (let n = 0; n < 25 && !settled; n++) {
          frames.push(
            (
              await observer.query(
                `SELECT pid,query,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid IN (SELECT pid FROM pg_stat_activity WHERE query LIKE '%liekan_event_geography%' AND datname=current_database())`,
              )
            ).rows,
          );
          await sleep(10);
        }
        await moving.query('COMMIT');
        const outcome = await attempt;
        await evidence.query('ROLLBACK');
        const afterRejected = await facts();
        await writeFile(
          `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/visit-evidence-mapping.json`,
          JSON.stringify(
            { website, event, beforeVisit, afterVisit, outcome, frames, afterRejected },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        // This assertion defines the new guard protocol, independent of the old dirty-lock deadlock.
        expect(outcome).toEqual({ ok: false, code: '55P03' });
        expect(afterRejected).toMatchObject({
          geography: 0,
          quality: 0,
          receipts: 0,
          visit: afterVisit,
        });
        expect(afterRejected.event_time.toISOString()).toBe('2026-10-23T11:01:00.000Z');
        const beforeMarkers = (
          await observer.query(
            `SELECT bucket::text,shard,revision::text FROM liekan_analysis_dirty WHERE website_id=$1 AND family='visit' AND isfinite(bucket) ORDER BY bucket,shard`,
            [website],
          )
        ).rows;
        await evidence.query('BEGIN');
        await insertGeography();
        await evidence.query(
          `INSERT INTO liekan_event_quality(event_id,website_id,classification,source,reasons,rule_version,range_status) VALUES($1,$2,'browser','browser','{synthetic}','fixture','missing')`,
          [event, website],
        );
        // FOR SHARE also fences non-key visit/time updates after the mapping has been chosen.
        await expect(
          moving.query(
            'SELECT event_id FROM website_event WHERE website_id=$1 AND event_id=$2 FOR UPDATE NOWAIT',
            [website, event],
          ),
        ).rejects.toMatchObject({ code: '55P03' });
        await expect(
          moving.query('SELECT liekan_analysis_visit_guard_lock($1,$2::smallint,false)', [
            website,
            slot(afterVisit),
          ]),
        ).rejects.toMatchObject({ code: '55P03' });
        // The original visit slot stays available; only the current mapping is protected.
        await moving.query('SELECT liekan_analysis_visit_guard_lock($1,$2::smallint,false)', [
          website,
          slot(beforeVisit),
        ]);
        const afterMarkers = (
          await evidence.query(
            `SELECT bucket::text,shard,revision::text FROM liekan_analysis_dirty WHERE website_id=$1 AND family='visit' AND isfinite(bucket) ORDER BY bucket,shard`,
            [website],
          )
        ).rows;
        expect(afterMarkers.find(r => r.bucket.includes('10:00'))).toEqual(
          beforeMarkers.find(r => r.bucket.includes('10:00')),
        );
        expect(
          BigInt(afterMarkers.find(r => r.bucket.includes('11:00')).revision) -
            BigInt(beforeMarkers.find(r => r.bucket.includes('11:00')).revision),
        ).toBe(2n);
        await evidence.query('COMMIT');
        expect(await facts()).toMatchObject({
          geography: 1,
          quality: 1,
          receipts: 0,
          visit: afterVisit,
        });
      } finally {
        await moving.query('ROLLBACK');
        await evidence.query('ROLLBACK');
        await Promise.allSettled([attempt].filter(Boolean));
        await Promise.all([moving.end(), evidence.end(), observer.end()]);
      }
    }, 30000);

    it('takes every visit guard before secondary invalidation or truncation touches either dirty family', async () => {
      const holder = await connect(),
        writer = await connect();
      const session = randomUUID(),
        event = randomUUID();
      const state = () =>
        q(
          `SELECT family,bucket::text,shard,revision::text FROM liekan_analysis_dirty WHERE website_id=$1::uuid ORDER BY family,bucket,shard`,
          website,
        );
      try {
        await sql(
          "INSERT INTO session(session_id,website_id,browser) VALUES($1::uuid,$2::uuid,'before')",
          session,
          website,
        );
        await sql(
          `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type)
          VALUES($1::uuid,$2::uuid,$3::uuid,$3::uuid,'2026-10-23T18:00Z','/synthetic',1)`,
          event,
          website,
          session,
        );
        const baseline = await state();
        await holder.query('BEGIN');
        await holder.query('SELECT liekan_analysis_visit_guard_lock($1,31::smallint,true)', [
          website,
        ]);
        // A full-family call must reject at the guard before waiting for this log marker/meter domain.
        await holder.query(
          "SELECT shard FROM liekan_analysis_dirty WHERE website_id=$1 AND family='log' AND bucket='-infinity' FOR UPDATE",
          [website],
        );
        await writer.query("SET statement_timeout='5s'");
        const outcomes: unknown[] = [];
        for (const [statement, values] of [
          ['SELECT liekan_analysis_invalidate($1,NULL)', [website]],
          [
            "UPDATE session SET browser='after' WHERE website_id=$1 AND session_id=$2",
            [website, session],
          ],
          ['TRUNCATE website_event CASCADE', []],
        ] as const) {
          const outcome = await writer.query(statement, [...values]).then(
            () => ({ ok: true, code: undefined }),
            error => ({ ok: false, code: error.code }),
          );
          outcomes.push(outcome);
          expect(outcome).toEqual({ ok: false, code: '55P03' });
          expect(await state()).toEqual(baseline);
        }
        expect(
          (await q('SELECT browser FROM session WHERE session_id=$1::uuid', session))[0].browser,
        ).toBe('before');
        expect(
          (
            await q(
              'SELECT count(*)::int AS n FROM website_event WHERE website_id=$1::uuid',
              website,
            )
          )[0].n,
        ).toBe(1);
        await writeFile(
          `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/visit-invalidation-guards.json`,
          JSON.stringify({ website, outcomes, baseline }, null, 2),
          { mode: 0o600 },
        );
      } finally {
        await holder.query('ROLLBACK');
        await Promise.all([holder.end(), writer.end()]);
      }
    }, 30000);

    it('initializes bounded guards atomically in the ORM schema and preserves disabled and parentless collection', async () => {
      const fresh = randomUUID(),
        holder = await connect();
      const { saveEvent } = await import('@/queries/sql/events/saveEvent');
      const noParents = [randomUUID(), randomUUID()];
      try {
        // A fresh Prisma connection uses its ordinary search_path; trigger schema pinning owns registration.
        await prisma.client.$disconnect();
        expect(await prisma.client.$queryRawUnsafe('SHOW search_path')).toEqual([
          { search_path: '"$user", public' },
        ]);
        await prisma.client.website.create({
          data: { id: fresh, name: 'Synthetic guard registration', userId: actor.userId },
        });
        expect(
          (
            await q(
              'SELECT count(*)::int AS n,min(slot)::int AS first,max(slot)::int AS last FROM liekan_analysis_visit_guard WHERE website_id=$1::uuid',
              fresh,
            )
          )[0],
        ).toEqual({ n: 32, first: 0, last: 31 });
        const row = await q<{ proconfig: string[] }[]>(
          `SELECT p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.proname='liekan_analysis_visit_guard_init'`,
        );
        expect(row[0].proconfig.some(value => value.startsWith('search_path=analysis_'))).toBe(
          true,
        );
        await sql(
          "UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id=$1::uuid",
          fresh,
        );
        await holder.query('BEGIN');
        await holder.query(
          'SELECT slot FROM liekan_analysis_visit_guard WHERE website_id=$1 ORDER BY slot FOR NO KEY UPDATE',
          [fresh],
        );
        await saveEvent({
          websiteId: fresh,
          sessionId: randomUUID(),
          visitId: randomUUID(),
          eventType: 1,
          createdAt: new Date(),
          urlPath: '/synthetic/disabled',
        });
        expect(
          (
            await q('SELECT count(*)::int AS n FROM website_event WHERE website_id=$1::uuid', fresh)
          )[0].n,
        ).toBe(1);
        expect(
          (
            await q(
              'SELECT count(*)::int AS n FROM liekan_analysis_dirty WHERE website_id=$1::uuid',
              fresh,
            )
          )[0].n,
        ).toBe(0);
        await holder.query('ROLLBACK');
        // Relational link/pixel collection has no website/analysis_site parent and no quality wrapper.
        for (const [index, websiteId] of noParents.entries()) {
          await saveEvent({
            websiteId,
            sessionId: randomUUID(),
            visitId: randomUUID(),
            eventType: index + 3,
            createdAt: new Date(),
            urlPath: '/synthetic/parentless',
          });
        }
        expect(
          (
            await q(
              'SELECT count(*)::int AS n FROM website_event WHERE website_id=ANY($1::uuid[])',
              noParents,
            )
          )[0].n,
        ).toBe(2);
        expect(
          (
            await q(
              'SELECT count(*)::int AS n FROM liekan_analysis_site WHERE website_id=ANY($1::uuid[])',
              noParents,
            )
          )[0].n,
        ).toBe(0);
        expect(
          (
            await q(
              'SELECT count(*)::int AS n FROM liekan_analysis_visit_guard WHERE website_id=ANY($1::uuid[])',
              noParents,
            )
          )[0].n,
        ).toBe(0);
        // Known-site capture never repairs a missing guard while holding raw tuples.
        await sql("UPDATE liekan_analysis_site SET mode='live' WHERE website_id=$1::uuid", fresh);
        await sql('DELETE FROM liekan_analysis_visit_guard WHERE website_id=$1::uuid', fresh);
        await expect(
          saveEvent({
            websiteId: fresh,
            sessionId: randomUUID(),
            visitId: randomUUID(),
            eventType: 1,
            createdAt: new Date(),
            urlPath: '/synthetic/missing-guard',
          }),
        ).rejects.toMatchObject({
          meta: { driverAdapterError: { cause: { originalCode: '23514' } } },
        });
        expect(
          (
            await q('SELECT count(*)::int AS n FROM website_event WHERE website_id=$1::uuid', fresh)
          )[0].n,
        ).toBe(1);
        await sql(
          'INSERT INTO liekan_analysis_visit_guard(website_id,slot) SELECT $1::uuid,n::smallint FROM generate_series(0,31)n',
          fresh,
        );
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
        await sql('DELETE FROM website_event WHERE website_id=ANY($1::uuid[])', noParents);
        await db.analysisTransaction(async tx => {
          await tx.$queryRawUnsafe(
            'SELECT website_id FROM website WHERE website_id=$1::uuid FOR UPDATE',
            fresh,
          );
          await tx.$queryRawUnsafe(
            'SELECT website_id FROM liekan_analysis_site WHERE website_id=$1::uuid FOR UPDATE',
            fresh,
          );
          await tx.$executeRawUnsafe(
            'INSERT INTO liekan_analysis_visit_guard(website_id,slot) SELECT s.website_id,n::smallint FROM liekan_analysis_site s CROSS JOIN generate_series(0,31)n WHERE s.website_id=$1::uuid ON CONFLICT DO NOTHING',
            fresh,
          );
          await tx.$executeRawUnsafe('DELETE FROM website_event WHERE website_id=$1::uuid', fresh);
          await tx.$executeRawUnsafe('DELETE FROM website WHERE website_id=$1::uuid', fresh);
        });
      }
    }, 30000);

    it('keeps new-site batch and evidence lookups bounded under stale website statistics', async () => {
      const oldSites = Array.from({ length: 5 }, () => randomUUID());
      const oldImports = oldSites.map(() => randomUUID());
      const targetImports = [randomUUID(), randomUUID()];
      const statsLock = await connect();
      const server = await import('./server');
      const originalTransaction = server.transaction;
      const plans: Record<string, any> = {};
      const stats = async () =>
        (
          await q(`SELECT c.reltuples::text,c.relpages,s.last_analyze,s.last_autoanalyze,
          s.analyze_count::text,s.autoanalyze_count::text,
          (SELECT most_common_vals::text FROM pg_stats WHERE schemaname=current_schema()
           AND tablename='liekan_log' AND attname='website_id') AS website_values
          FROM pg_class c JOIN pg_stat_user_tables s ON s.relid=c.oid
          WHERE c.oid='liekan_log'::regclass`)
        )[0];
      let spy: ReturnType<typeof vi.spyOn>;
      try {
        for (let n = 0; n < oldSites.length; n++) {
          await sql(
            "INSERT INTO website(website_id,name,domain,user_id) VALUES($1::uuid,'Synthetic stale statistics','example.test',$2::uuid)",
            oldSites[n],
            actor.userId,
          );
          await sql(
            'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$1::text,20000,0)',
            oldImports[n],
            oldSites[n],
          );
          await sql(
            `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification)
            SELECT md5($1::text||n::text)||md5(n::text||$1::text),$1::uuid,$2::uuid,'2025-12-01Z','/synthetic','GET',200,0,'','','Synthetic','','其他','','其他','unverified'
            FROM generate_series(1,20000)n`,
            oldSites[n],
            oldImports[n],
          );
        }
        await sql('ANALYZE liekan_log');
        await statsLock.query('BEGIN');
        await statsLock.query("SET LOCAL lock_timeout='2s'");
        // Freeze only statistics maintenance; the real processBatch DML remains concurrent.
        await statsLock.query('LOCK TABLE liekan_log IN SHARE UPDATE EXCLUSIVE MODE');
        const beforeStats = await stats();
        for (let n = 0; n < targetImports.length; n++) {
          await sql(
            'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected) VALUES($1::uuid,$2::uuid,$1::text,6000,0)',
            targetImports[n],
            website,
          );
          await sql(
            `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification)
            SELECT md5($1::text||n::text)||md5(n::text||$1::text),$2::uuid,$1::uuid,'2025-12-01Z','/synthetic','GET',200,0,'','','Synthetic','','其他','','其他','unverified'
            FROM generate_series(1,6000)n`,
            targetImports[n],
            website,
          );
        }
        expect(beforeStats.website_values).not.toContain(website);
        const input = await source();
        const generation = randomUUID();
        const received = await service.receiveBatch(
          new Request('https://collector.invalid/upload', {
            method: 'POST',
            headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              version: 1,
              batchId: randomUUID(),
              epoch: 1,
              events: Array.from({ length: 1000 }, (_, offset) => ({
                generation,
                offset,
                line: `192.0.2.20 - - [04/Oct/2026:10:00:00 +0800] "GET /point/${offset} HTTP/1.1" 200 25 "-" "Synthetic"`,
              })),
            }),
          }),
          input.id,
        );
        expect(received).toMatchObject({ valid: 1000, rejected: 0 });
        const pending = (received as { batchId: string }).batchId;
        const state = async () => ({
          counts: await counts(),
          batch: (
            await q(
              'SELECT to_jsonb(b) AS data FROM liekan_ingest_batch b WHERE id=$1::uuid',
              pending,
            )
          )[0].data,
          dirty: await q(
            'SELECT epoch::text,family,bucket::text,shard,revision::text FROM liekan_analysis_dirty WHERE website_id=$1::uuid ORDER BY epoch,family,bucket,shard',
            website,
          ),
        });
        const baseline = await state();
        const sentinel = new Error('owned-stale-statistics-rollback');
        let writes = 0;
        const explain = async (tx: any, name: string, statement: string, values: unknown[]) => {
          const [row] = await tx.$queryRawUnsafe(
            `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statement}`,
            ...values,
          );
          plans[name] = row['QUERY PLAN'][0];
        };
        spy = vi.spyOn(server, 'transaction').mockImplementation(work =>
          originalTransaction(async tx => {
            let qualifies = false;
            const wrapped = new Proxy(tx, {
              get(object, key) {
                if (key === '$queryRawUnsafe')
                  return async (statement: string, ...values: unknown[]) => {
                    if (
                      statement.includes('FROM liekan_ingest_batch') &&
                      statement.includes('FOR UPDATE') &&
                      values[0] === pending
                    ) {
                      qualifies = true;
                      writes++;
                    }
                    if (qualifies && statement.includes('event_digest IS DISTINCT FROM'))
                      await explain(object, 'conflicting', statement, values);
                    return object.$queryRawUnsafe(statement, ...values);
                  };
                if (key === '$executeRawUnsafe')
                  return async (statement: string, ...values: unknown[]) => {
                    const name = statement.startsWith('INSERT INTO liekan_crawler_evidence')
                      ? 'crawler'
                      : statement.startsWith('INSERT INTO liekan_log_geography')
                        ? 'geography'
                        : null;
                    if (qualifies && name) {
                      // EXPLAIN ANALYZE executes the actual insert. Both helpers ignore its row count.
                      await explain(object, name, statement, values);
                      return 0;
                    }
                    return object.$executeRawUnsafe(statement, ...values);
                  };
                const value = Reflect.get(object, key);
                return typeof value === 'function' ? value.bind(object) : value;
              },
            });
            const value = await work(wrapped);
            if (!qualifies) return value;
            const [inside] = await tx.$queryRawUnsafe(
              `SELECT
            (SELECT count(*)::int FROM liekan_log WHERE website_id=$1::uuid AND import_id=$2::uuid) AS raw,
            (SELECT count(*)::int FROM liekan_crawler_evidence e JOIN liekan_log l ON l.website_id=e.website_id AND l.id=e.log_id WHERE l.website_id=$1::uuid AND l.import_id=$2::uuid) AS evidence,
            (SELECT count(*)::int FROM liekan_log_geography e JOIN liekan_log l ON l.website_id=e.website_id AND l.id=e.log_id WHERE l.website_id=$1::uuid AND l.import_id=$2::uuid) AS geography,
            (SELECT accepted FROM liekan_import WHERE id=$2::uuid) AS accepted,
            (SELECT data_revision::int FROM liekan_log_state WHERE website_id=$1::uuid) AS revision,
            (SELECT state FROM liekan_ingest_batch WHERE id=$2::uuid) AS state`,
              website,
              pending,
            );
            expect(inside).toEqual({
              raw: 1000,
              evidence: 1000,
              geography: 1000,
              accepted: 1000,
              revision: 1,
              state: 'processed',
            });
            const { persistCrawlerEvidence } = await import('../log-ingestion/crawler-evidence');
            const { persistLogGeography } = await import('./log-geography');
            const retained = await tx.$queryRawUnsafe(
              `SELECT id,import_id FROM (
            SELECT id,import_id,row_number() OVER(PARTITION BY import_id ORDER BY id) AS n
            FROM liekan_log WHERE website_id=$1::uuid AND import_id=ANY($2::uuid[])) r
            WHERE n<=8 ORDER BY import_id,id`,
              website,
              targetImports,
            );
            expect(retained).toHaveLength(16);
            const sameImport = retained.filter(row => row.import_id === targetImports[0]);
            expect(sameImport).toHaveLength(8);
            const [foreign] = await tx.$queryRawUnsafe(
              'SELECT id FROM liekan_log WHERE website_id=$1::uuid ORDER BY id LIMIT 1',
              oldSites[0],
            );
            const known = {
              location: { country: 'CN', region: 'CN-11', city: '北京市' },
              source: 'synthetic',
              trust: 'unverified',
              ipFamily: 'missing',
              precision: 'city',
              reason: 'synthetic',
              ruleVersion: 'fixture',
              dataVersion: null,
              cityId: null,
              accuracyRadius: null,
              countryBasis: 'missing',
              processedAt: '2026-10-04T02:00:00.000Z',
              shadow: null,
            };
            const unknown = {
              ...known,
              location: { country: null, region: null, city: null },
              precision: 'missing',
              reason: 'synthetic_missing',
            };
            await persistLogGeography(tx, website, [
              { id: retained[0].id, geography: unknown },
            ] as any);
            const [unknownGeo] = await tx.$queryRawUnsafe(
              'SELECT * FROM liekan_log_geography WHERE website_id=$1::uuid AND log_id=$2',
              website,
              retained[0].id,
            );
            await persistLogGeography(tx, website, [
              ...retained.map(row => ({ id: row.id, geography: known })),
              {
                id: retained[1].id,
                geography: { ...known, location: { country: 'US', region: null, city: null } },
              },
              { id: foreign.id, geography: known },
            ] as any);
            const geo = await tx.$queryRawUnsafe(
              'SELECT * FROM liekan_log_geography WHERE website_id=$1::uuid AND log_id=ANY($2::text[]) ORDER BY log_id',
              website,
              [...retained.map(row => row.id), foreign.id],
            );
            expect(geo).toHaveLength(16);
            expect(geo.find(row => row.log_id === retained[0].id)).toEqual(unknownGeo);
            expect(
              geo
                .filter(row => row.log_id !== retained[0].id)
                .every(
                  row => row.country === 'CN' && row.region === 'CN-11' && row.city === '北京市',
                ),
            ).toBe(true);
            await persistCrawlerEvidence(tx, website, targetImports[0], [{ id: sameImport[0].id }]);
            const [unknownEvidence] = await tx.$queryRawUnsafe(
              'SELECT * FROM liekan_crawler_evidence WHERE website_id=$1::uuid AND log_id=$2',
              website,
              sameImport[0].id,
            );
            const observation = {
              securityAction: 'allow',
              terminatingRuleId: null,
              matchedRuleIds: null,
              cacheStatus: null,
              durationMs: null,
            };
            await persistCrawlerEvidence(tx, website, targetImports[0], [
              ...retained.map(row => ({ id: row.id, crawlerEvidence: observation })),
              {
                id: sameImport[1].id,
                crawlerEvidence: { ...observation, securityAction: 'challenge' },
              },
              { id: foreign.id, crawlerEvidence: observation },
            ]);
            const evidence = await tx.$queryRawUnsafe(
              'SELECT * FROM liekan_crawler_evidence WHERE website_id=$1::uuid AND log_id=ANY($2::text[]) ORDER BY log_id',
              website,
              [...retained.map(row => row.id), foreign.id],
            );
            expect(evidence).toHaveLength(8);
            expect(evidence.find(row => row.log_id === sameImport[0].id)).toEqual(unknownEvidence);
            expect(
              evidence
                .filter(row => row.log_id !== sameImport[0].id)
                .every(row => row.security_action === 'allow' && row.identity_evidence === null),
            ).toBe(true);
            throw sentinel;
          }),
        );
        await expect(service.processBatch(pending)).rejects.toBe(sentinel);
        spy.mockRestore();
        spy = undefined;
        expect(writes).toBe(1);
        expect(await state()).toEqual(baseline);
        const afterStats = await stats();
        expect(afterStats).toEqual(beforeStats);
        await writeFile(
          `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/ingestion-lookup-plans.json`,
          JSON.stringify({
            beforeStats,
            afterStats,
            baselineSites: 5,
            baselineRows: 100000,
            newSiteRows: 12000,
            batchRows: 1000,
            plans,
          }),
          { mode: 0o600 },
        );
        expect(Object.keys(plans).sort()).toEqual(['conflicting', 'crawler', 'geography']);
        const nodes = (node: any): any[] => [node, ...(node.Plans || []).flatMap(nodes)];
        for (const plan of Object.values(plans)) {
          const all = nodes(plan.Plan);
          const lookups = all.filter(node => node['Relation Name'] === 'liekan_log');
          expect(lookups).toHaveLength(1);
          const lookup = lookups[0];
          expect(lookup['Index Cond']).toContain('website_id');
          expect(lookup['Index Cond']).toMatch(/\bid\)?(?:::text)?\s*=\s*r\.id/);
          expect(lookup['Actual Loops']).toBe(1000);
          expect(lookup['Actual Rows']).toBeLessThanOrEqual(1);
          expect(lookup['Rows Removed by Filter'] || 0).toBeLessThanOrEqual(1);
          expect(
            (lookup['Shared Hit Blocks'] || 0) + (lookup['Shared Read Blocks'] || 0),
          ).toBeLessThanOrEqual(17000);
          const init = all.filter(node => node['Parent Relationship'] === 'InitPlan');
          expect(init).toHaveLength(1);
          expect(init[0]['Actual Loops']).toBe(1);
        }
      } finally {
        spy?.mockRestore();
        await statsLock.query('ROLLBACK');
        await statsLock.end();
        await db.analysisTransaction(async tx => {
          await tx.$queryRawUnsafe(
            'SELECT website_id FROM website WHERE website_id=ANY($1::uuid[]) ORDER BY website_id FOR UPDATE',
            oldSites,
          );
          await tx.$queryRawUnsafe(
            'SELECT website_id FROM liekan_analysis_site WHERE website_id=ANY($1::uuid[]) ORDER BY website_id FOR UPDATE',
            oldSites,
          );
          await tx.$executeRawUnsafe(
            'DELETE FROM website WHERE website_id=ANY($1::uuid[])',
            oldSites,
          );
        });
      }
    }, 90000);

    it('allows atomic browser collection while a validated batch waits for its own ledger row', async () => {
      const input = await source(),
        id = await batch(input);
      const blocker = await connect(),
        observer = await connect();
      let task: Worker, browser: Promise<unknown>;
      let observed: 'completed' | 'blocked-on-batch' | undefined;
      try {
        await blocker.query('BEGIN');
        const {
          rows: [{ pid }],
        } = await blocker.query('SELECT pg_backend_pid() AS pid');
        await blocker.query('SELECT id FROM liekan_ingest_batch WHERE id=$1::uuid FOR UPDATE', [
          id,
        ]);
        task = worker(id);
        const bulk = await waiting(observer, task.name, pid);
        expect(bulk.query).toContain('liekan_ingest_batch');
        await expect(
          observer.query('SELECT id FROM liekan_log_source WHERE id=$1::uuid FOR UPDATE NOWAIT', [
            input.id,
          ]),
        ).rejects.toMatchObject({ code: '55P03' });
        await expect(
          observer.query(
            'SELECT website_id FROM website WHERE website_id=$1::uuid FOR UPDATE NOWAIT',
            [website],
          ),
        ).rejects.toMatchObject({ code: '55P03' });
        let complete = false;
        browser = collect().then(value => {
          complete = true;
          return value;
        });
        for (let n = 0; n < 250; n++) {
          if (complete) {
            observed = 'completed';
            break;
          }
          const { rows } = await observer.query(
            'SELECT pid,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))',
            [bulk.pid],
          );
          if (
            rows.some(
              row =>
                row.query.includes('SELECT website_id FROM website') &&
                row.query.includes('FOR SHARE'),
            )
          ) {
            observed = 'blocked-on-batch';
            break;
          }
          await sleep(20);
        }
        await writeFile(
          `${process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT}/batch-browser-barrier.json`,
          JSON.stringify({ observed, batchWait: bulk }),
          { mode: 0o600 },
        );
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
        await observer.end();
        if (task) expect(await task.done).toEqual({ ok: true });
        if (browser) await browser;
      }
      const [counts] = await q(
        `SELECT
      (SELECT count(*)::int FROM website_event WHERE website_id=$1::uuid) AS events,
      (SELECT count(*)::int FROM liekan_event_quality WHERE website_id=$1::uuid) AS quality,
      (SELECT count(*)::int FROM liekan_event_geography WHERE website_id=$1::uuid) AS geography,
      (SELECT count(*)::int FROM liekan_collection_receipt WHERE website_id=$1::uuid AND event_id IS NOT NULL) AS receipts,
      (SELECT count(*)::int FROM liekan_log WHERE website_id=$1::uuid) AS logs,
      (SELECT count(*)::int FROM liekan_crawler_evidence WHERE website_id=$1::uuid) AS evidence`,
        website,
      );
      expect(counts).toEqual({
        events: 1,
        quality: 1,
        geography: 1,
        receipts: 1,
        logs: 1,
        evidence: 1,
      });
      expect(observed).toBe('completed');
    }, 30000);

    it('serializes conflicting normalized identities from independent same-source workers', async () => {
      const input = await source(),
        generation = randomUUID();
      const first = await batch(input, generation, '/first'),
        second = await batch(input, generation, '/conflict');
      const normalized = await q(
        'SELECT id,payload->0 AS record FROM liekan_ingest_batch WHERE id=ANY($1::uuid[]) ORDER BY id',
        [first, second],
      );
      expect(normalized).toHaveLength(2);
      expect(normalized[0].record.id).toBe(normalized[1].record.id);
      expect(normalized[0].record.eventDigest).not.toBe(normalized[1].record.eventDigest);
      const blocker = await connect(),
        observer = await connect();
      let a: Worker, b: Worker;
      try {
        await blocker.query('BEGIN');
        const {
          rows: [{ pid }],
        } = await blocker.query('SELECT pg_backend_pid() AS pid');
        await blocker.query('SELECT id FROM liekan_ingest_batch WHERE id=$1::uuid FOR UPDATE', [
          first,
        ]);
        a = worker(first);
        const firstWait = await waiting(observer, a.name, pid);
        b = worker(second);
        const secondWait = await waiting(observer, b.name, firstWait.pid);
        expect(secondWait.query).toContain('FROM liekan_log_source');
        expect(secondWait.query).toContain('FOR UPDATE');
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
        await observer.end();
        if (a) expect(await a.done).toEqual({ ok: true });
        if (b) expect(await b.done).toMatchObject({ ok: false, status: 409 });
      }
      expect(await counts()).toEqual({
        logs: 1,
        effective: 1,
        geography: 1,
        evidence: 1,
        imports: 1,
        revision: 1,
      });
      const [row] = await q(
        'SELECT state,payload IS NOT NULL AS retained FROM liekan_ingest_batch WHERE id=$1::uuid',
        second,
      );
      expect(row).toEqual({ state: 'pending', retained: true });
      expect(
        (
          await q(
            'SELECT path,import_id,source_id FROM liekan_log WHERE website_id=$1::uuid',
            website,
          )
        )[0],
      ).toEqual({ path: '/first', import_id: first, source_id: input.id });
    }, 30000);

    it('admits independent normalized sources and preserves paused-source pending intervals and both revisions', async () => {
      const firstSource = await source(),
        generation = randomUUID();
      const first = await batch(firstSource, generation, '/old-source', '02');
      await sql(
        "UPDATE liekan_log_interval SET ends_at='2026-10-03Z' WHERE source_id=$1::uuid",
        firstSource.id,
      );
      await sql("UPDATE liekan_log_source SET state='paused' WHERE id=$1::uuid", firstSource.id);
      const secondSource = await source();
      await sql(
        "UPDATE liekan_log_interval SET starts_at='2026-10-03Z' WHERE source_id=$1::uuid",
        secondSource.id,
      );
      const second = await batch(secondSource, generation, '/new-source');
      const expected = await q(
        'SELECT id,source_id,payload->0 AS record FROM liekan_ingest_batch WHERE id=ANY($1::uuid[]) ORDER BY id',
        [first, second],
      );
      expect(new Set(expected.map(row => row.record.id)).size).toBe(2);
      const blocker = await connect(),
        observer = await connect();
      let a: Worker, b: Worker;
      try {
        await blocker.query('BEGIN');
        const {
          rows: [{ pid }],
        } = await blocker.query('SELECT pg_backend_pid() AS pid');
        await blocker.query(
          'SELECT id FROM liekan_ingest_batch WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [[first, second]],
        );
        a = worker(first);
        const firstWait = await waiting(observer, a.name, pid);
        expect(firstWait.query).toContain('FROM liekan_ingest_batch');
        b = worker(second);
        const secondWait = await waiting(observer, b.name, pid);
        expect(secondWait.query).toContain('FROM liekan_ingest_batch');
        expect(firstWait.pid).not.toBe(secondWait.pid);
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
        await observer.end();
        if (a) expect(await a.done).toEqual({ ok: true });
        if (b) expect(await b.done).toEqual({ ok: true });
      }
      expect(await counts()).toEqual({
        logs: 2,
        effective: 2,
        geography: 2,
        evidence: 2,
        imports: 2,
        revision: 2,
      });
      const actual = await q(
        'SELECT id,source_id,import_id,event_digest FROM liekan_log WHERE website_id=$1::uuid ORDER BY import_id',
        website,
      );
      expect(actual).toEqual(
        expected.map(row => ({
          id: row.record.id,
          source_id: row.source_id,
          import_id: row.id,
          event_digest: row.record.eventDigest,
        })),
      );
      expect(
        await q(
          'SELECT state,inserted FROM liekan_ingest_batch WHERE id=ANY($1::uuid[]) ORDER BY id',
          [first, second],
        ),
      ).toEqual([
        { state: 'processed', inserted: 1 },
        { state: 'processed', inserted: 1 },
      ]);
    }, 30000);

    it('rolls back raw facts, evidence, ledger and dirty markers on a late counter failure', async () => {
      const input = await source(),
        id = await batch(input);
      const dirty = () =>
        q(
          'SELECT epoch,family,bucket,shard,revision FROM liekan_analysis_dirty WHERE website_id=$1::uuid ORDER BY epoch,family,bucket,shard',
          website,
        );
      const before = await dirty();
      const constraint = `fixture_${randomUUID().replaceAll('-', '')}`;
      try {
        await sql(
          `ALTER TABLE liekan_log_state ADD CONSTRAINT ${constraint} CHECK(website_id<>'${website}'::uuid OR data_revision=0)`,
        );
        expect(await worker(id).done).toMatchObject({ ok: false, code: '23514' });
        expect(await counts()).toEqual({
          logs: 0,
          effective: 0,
          geography: 0,
          evidence: 0,
          imports: 0,
          revision: 0,
        });
        expect(await dirty()).toEqual(before);
        expect(
          (
            await q(
              'SELECT state,payload IS NOT NULL AS retained FROM liekan_ingest_batch WHERE id=$1::uuid',
              id,
            )
          )[0],
        ).toEqual({ state: 'pending', retained: true });
      } finally {
        await sql(`ALTER TABLE liekan_log_state DROP CONSTRAINT IF EXISTS ${constraint}`);
      }
      expect(await worker(id).done).toEqual({ ok: true });
      expect(await counts()).toEqual({
        logs: 1,
        effective: 1,
        geography: 1,
        evidence: 1,
        imports: 1,
        revision: 1,
      });
    }, 30000);

    it.each(['paused', 'error'] as const)(
      'retains the existing %s-source pending contract after a management barrier',
      async state => {
        const input = await source(),
          id = await batch(input);
        expect(
          await managerBeforeBatch(id, tx =>
            tx.query('UPDATE liekan_log_source SET state=$2 WHERE id=$1::uuid', [input.id, state]),
          ),
        ).toEqual({ ok: true });
        expect(await counts()).toEqual({
          logs: 1,
          effective: 1,
          geography: 1,
          evidence: 1,
          imports: 1,
          revision: 1,
        });
      },
      30000,
    );

    it.each(['disconnected', 'domain', 'owner', 'epoch'] as const)(
      'rechecks a committed %s change after waiting for management',
      async change => {
        const input = await source(),
          id = await batch(input);
        const outcome = await managerBeforeBatch(id, async tx => {
          if (change === 'disconnected')
            await tx.query("UPDATE liekan_log_source SET state='disconnected' WHERE id=$1::uuid", [
              input.id,
            ]);
          if (change === 'domain')
            await tx.query(
              "UPDATE website SET domain='changed.invalid' WHERE website_id=$1::uuid",
              [website],
            );
          if (change === 'owner') {
            const next = randomUUID();
            await tx.query(
              "INSERT INTO \"user\"(user_id,username,password,role) VALUES($1::uuid,$1::text,'fixture','user')",
              [next],
            );
            await tx.query('UPDATE website SET user_id=$2::uuid WHERE website_id=$1::uuid', [
              website,
              next,
            ]);
          }
          if (change === 'epoch')
            await tx.query(
              'UPDATE liekan_log_state SET epoch=epoch+1,reset_at=clock_timestamp() WHERE website_id=$1::uuid',
              [website],
            );
        });
        expect(outcome).toMatchObject(
          change === 'epoch'
            ? { ok: true }
            : { ok: false, status: change === 'disconnected' ? 409 : 403 },
        );
        expect(await counts()).toEqual({
          logs: 0,
          effective: 0,
          geography: 0,
          evidence: 0,
          imports: 0,
          revision: 0,
        });
        expect(
          (
            await q(
              'SELECT state,payload IS NOT NULL AS retained FROM liekan_ingest_batch WHERE id=$1::uuid',
              id,
            )
          )[0],
        ).toEqual(
          change === 'epoch'
            ? { state: 'cancelled', retained: false }
            : { state: 'pending', retained: true },
        );
      },
      30000,
    );

    it('rechecks current team write authority and holds the original shared membership fence', async () => {
      const team = randomUUID();
      try {
        await sql("INSERT INTO team(team_id,name) VALUES($1::uuid,'Synthetic authority')", team);
        await sql(
          "INSERT INTO team_user(team_user_id,team_id,user_id,role) VALUES($1::uuid,$2::uuid,$3::uuid,'team-owner')",
          randomUUID(),
          team,
          actor.userId,
        );
        await sql(
          'UPDATE website SET user_id=NULL,team_id=$2::uuid WHERE website_id=$1::uuid',
          website,
          team,
        );
        const input = await source(),
          id = await batch(input);
        const blocker = await connect(),
          observer = await connect();
        let task: Worker;
        try {
          await blocker.query('BEGIN');
          const {
            rows: [{ pid }],
          } = await blocker.query('SELECT pg_backend_pid() AS pid');
          await blocker.query('SELECT id FROM liekan_ingest_batch WHERE id=$1::uuid FOR UPDATE', [
            id,
          ]);
          task = worker(id);
          await waiting(observer, task.name, pid);
          await expect(
            observer.query('SELECT user_id FROM "user" WHERE user_id=$1::uuid FOR UPDATE NOWAIT', [
              actor.userId,
            ]),
          ).rejects.toMatchObject({ code: '55P03' });
          await expect(
            observer.query(
              'SELECT team_user_id FROM team_user WHERE team_id=$1::uuid AND user_id=$2::uuid FOR UPDATE NOWAIT',
              [team, actor.userId],
            ),
          ).rejects.toMatchObject({ code: '55P03' });
          await expect(
            observer.query('SELECT team_id FROM team WHERE team_id=$1::uuid FOR UPDATE NOWAIT', [
              team,
            ]),
          ).rejects.toMatchObject({ code: '55P03' });
        } finally {
          await blocker.query('ROLLBACK');
          await blocker.end();
          await observer.end();
          if (task) expect(await task.done).toEqual({ ok: true });
        }
        const next = await batch(input);
        expect(
          await managerBeforeBatch(next, tx =>
            tx.query('DELETE FROM team_user WHERE team_id=$1::uuid AND user_id=$2::uuid', [
              team,
              actor.userId,
            ]),
          ),
        ).toMatchObject({ ok: false, status: 403 });
        expect(await counts()).toEqual({
          logs: 1,
          effective: 1,
          geography: 1,
          evidence: 1,
          imports: 1,
          revision: 1,
        });
      } finally {
        await sql(
          'UPDATE website SET user_id=$2::uuid,team_id=NULL WHERE website_id=$1::uuid',
          website,
          actor.userId,
        );
        await sql('DELETE FROM team WHERE team_id=$1::uuid', team);
      }
    }, 30000);

    it('serializes repair activation and preserves pre-boundary pending and post-boundary captured scopes', async () => {
      const input = await source(),
        id = await batch(input),
        run = randomUUID(),
        generation = randomUUID(),
        scope = randomUUID();
      expect(
        await managerBeforeBatch(id, tx =>
          tx.query(
            `INSERT INTO liekan_history_repair_run(id,website_id,campaign_id,actor_id,status,generation,repair_scope_id,snapshot,locale)
        VALUES($1::uuid,$2::uuid,'traffic-quality-repair-20261022-v1',$3::uuid,'running',$4::uuid,$5::uuid,$6::jsonb,'en-US')`,
            [
              run,
              website,
              actor.userId,
              generation,
              scope,
              JSON.stringify({ rulepack: { engine: HISTORY_REPAIR_ENGINE } }),
            ],
          ),
        ),
      ).toEqual({ ok: true });
      expect(
        (await q('SELECT repair_scope_id FROM liekan_import WHERE id=$1::uuid', id))[0],
      ).toEqual({ repair_scope_id: null });
      expect(
        (await q('SELECT scope_changed FROM liekan_history_repair_run WHERE id=$1::uuid', run))[0],
      ).toEqual({ scope_changed: false });
      const next = await batch(input);
      expect(
        (await q('SELECT repair_scope_id FROM liekan_ingest_batch WHERE id=$1::uuid', next))[0],
      ).toEqual({ repair_scope_id: scope });
      expect(await worker(next).done).toEqual({ ok: true });
      expect(
        (await q('SELECT repair_scope_id FROM liekan_import WHERE id=$1::uuid', next))[0],
      ).toEqual({ repair_scope_id: scope });
      expect(
        (await q('SELECT scope_changed FROM liekan_history_repair_run WHERE id=$1::uuid', run))[0],
      ).toEqual({ scope_changed: false });
      expect(await counts()).toEqual({
        logs: 2,
        effective: 2,
        geography: 2,
        evidence: 2,
        imports: 2,
        revision: 2,
      });
    }, 30000);
  },
);
