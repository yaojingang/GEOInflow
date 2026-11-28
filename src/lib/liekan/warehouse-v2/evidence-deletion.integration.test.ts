// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ClickHouseClient } from '@clickhouse/client';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createV2ClickHouseClient, ensureV2Schema } from './client';
import { v2Tables } from './schema';
import { GET as getPage } from '@/app/api/liekan/websites/[websiteId]/page-report/route';
import { GET as getEntries } from '@/app/api/liekan/websites/[websiteId]/log-entries/route';
import { bindCacheRequest, installAuthorizationRunner } from '../upstream/cache-context';
import { analyticsCacheKey } from '../upstream/query-cache';
import { queryV2EvidenceFast } from './evidence-http';
import { deleteWarehouseStatistics } from '../upstream/warehouse-lifecycle';

const harness = vi.hoisted(() => ({
  runtime: undefined as any,
  authorize: vi.fn(),
  report: vi.fn(),
  entries: vi.fn(),
}));
vi.mock('./runtime', () => ({
  warehouseV2Runtime: () => harness.runtime,
  warehouseV2Enabled: () => true,
}));
vi.mock('../upstream/query-cache', async importOriginal => ({
  ...(await importOriginal<typeof import('../upstream/query-cache')>()),
  invalidateWebsiteAnalytics: () => {},
}));
vi.mock('../warehouse/reader-runtime', () => ({
  warehouseReader: () => ({
    verifyIdentity: async () => {},
    db: {
      read: async (sql: string, params: unknown[]) =>
        (await harness.runtime.pg.query(sql, params)).rows,
    },
  }),
}));
vi.mock('../upstream/page-report', () => ({ readPageReport: harness.report }));
vi.mock('../upstream/log-read', () => ({ readLogEntries: harness.entries }));
vi.mock('../upstream/analysis-query-api', () => ({ analysisAsyncRequested: () => false }));
vi.mock('../upstream/crawler-maintenance', () => ({
  authenticateCrawlerMaintenance: async () => ({ id: owner }),
}));
vi.mock('../upstream/crawler-registry-context', () => ({
  withPublishedRegistry: (work: () => unknown) => work(),
}));
vi.mock('../upstream/lifecycle', () => ({
  resetLiekanStatistics: (tx: any, site: string) =>
    tx.$executeRawUnsafe('UPDATE liekan_log_state SET epoch=epoch+1 WHERE website_id=$1', site),
}));
vi.mock('../upstream/server', async () => ({
  ...(await import('../upstream/errors')),
  authorize: harness.authorize,
  lockWritableWebsite: async (tx: any, site: string, identity: { userId: string }) => {
    const rows = await tx.$queryRawUnsafe(
      'SELECT 1 FROM website WHERE website_id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',
      site,
      identity.userId,
    );
    if (!rows.length) throw Error('Test site owner required');
  },
}));
vi.mock('@/lib/auth', () => ({ hasPermission: async () => false }));
vi.mock('../upstream/ai-lifecycle', () => ({ clearAiWebsiteInTransaction: () => {} }));

const pgUrl = process.env.LIEKAN_DELETION_TEST_PG;
const chUrl = process.env.LIEKAN_DELETION_TEST_CH;
const namespace = 'deletion_test_' + randomUUID().replaceAll('-', '');
const owner = randomUUID();

function barrier() {
  let open!: () => void;
  const wait = new Promise<void>(resolve => {
    open = resolve;
  });
  return { open, wait };
}

describe.skipIf(!pgUrl || !chUrl)('v2 evidence reads across deletion commits', () => {
  let adminPg: Pool, pg: Pool, adminCh: ClickHouseClient, ch: ClickHouseClient;
  let afterRead: (() => Promise<void>) | undefined;
  let beforeCommand: ((sql: string) => Promise<void>) | undefined;

  beforeAll(async () => {
    for (const url of [pgUrl, chUrl])
      if (new URL(url!).hostname !== '127.0.0.1')
        throw Error('Use isolated loopback test databases');
    if (new URL(pgUrl!).pathname !== '/liekan_deletion_test')
      throw Error('Use liekan_deletion_test');
    const appUrl = new URL(pgUrl!);
    appUrl.searchParams.set('schema', namespace);
    vi.stubEnv('LIEKAN_ANALYTICS_BACKEND', 'clickhouse');
    vi.stubEnv('DATABASE_URL', appUrl.toString());
    adminPg = new Pool({ connectionString: pgUrl });
    adminCh = createV2ClickHouseClient({ url: chUrl });
    await adminPg.query('CREATE SCHEMA ' + namespace);
    await adminCh.command({ query: 'CREATE DATABASE ' + namespace });
    pg = new Pool({ connectionString: pgUrl, options: '-c search_path=' + namespace });
    ch = createV2ClickHouseClient({ url: chUrl, database: namespace });
    await pg.query(`
      CREATE TABLE "user"(user_id uuid PRIMARY KEY,role text,deleted_at timestamptz);
      CREATE TABLE team(team_id uuid PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE team_user(team_id uuid,user_id uuid);
      CREATE TABLE website(website_id uuid PRIMARY KEY,user_id uuid,team_id uuid,domain text,deleted_at timestamptz,reset_at timestamptz);
      CREATE TABLE liekan_log_state(website_id uuid PRIMARY KEY,epoch bigint,data_revision bigint DEFAULT 0);
      CREATE TABLE liekan_collection_policy(website_id uuid, mode text, revision bigint, allowed_hostnames text[]);
      CREATE TABLE liekan_catalog(website_id uuid,path text,updated_at timestamptz);
      CREATE TABLE liekan_log_source(website_id uuid,id uuid,kind text,domain text,state text);
      CREATE TABLE liekan_analytics_revision(resource_type text,resource_id uuid,revision bigint,updated_at timestamptz DEFAULT now(),PRIMARY KEY(resource_type,resource_id));
      CREATE TABLE session_replay_saved(website_id uuid,visit_id uuid);
      CREATE TABLE website_event(website_id uuid,session_id uuid,visit_id uuid);
    `);
    await pg.query(
      await readFile('db/liekan/migrations/103_warehouse_v2_evidence_deletion.sql', 'utf8'),
    );
    await pg.query('INSERT INTO "user"(user_id,role) VALUES($1,\'user\')', [owner]);
    await ensureV2Schema(ch);
    harness.runtime = {
      ensureReady: async () => {},
      pg,
      ch: {
        query: async (args: Parameters<typeof ch.query>[0]) => {
          const rows = await (await ch.query(args)).json();
          const hook = afterRead;
          afterRead = undefined;
          if (hook) await hook();
          return { json: async () => rows };
        },
        command: async (args: Parameters<typeof ch.command>[0]) => {
          if (beforeCommand) await beforeCommand(args.query);
          return ch.command(args);
        },
      },
    };
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await ch?.close();
    await pg?.end();
    if (adminCh) {
      await adminCh.command({ query: 'DROP DATABASE IF EXISTS ' + namespace + ' SYNC' });
      await adminCh.close();
    }
    if (adminPg) {
      await adminPg.query('DROP SCHEMA IF EXISTS ' + namespace + ' CASCADE');
      await adminPg.end();
    }
  });

  async function fixture() {
    const site = randomUUID(),
      session = randomUUID();
    await pg.query("INSERT INTO website(website_id,user_id,domain) VALUES($1,$2,'site.test')", [
      site,
      owner,
    ]);
    await pg.query('INSERT INTO liekan_log_state(website_id,epoch) VALUES($1,1)', [site]);
    await pg.query("INSERT INTO liekan_catalog VALUES($1,'/a',now())", [site]);
    // Use a recent, closed UTC hour to exercise the aggregate path and the observation retention bound.
    const hour = new Date(Math.floor(Date.now() / 3600000 - 2) * 3600000);
    const time = hour.toISOString().replace('T', ' ').slice(0, 19);
    await ch.insert({
      table: v2Tables.browserEvents,
      format: 'JSONEachRow',
      values: [
        {
          website_id: site,
          epoch: 1,
          event_id: randomUUID(),
          session_id: session,
          visit_id: randomUUID(),
          created_at: time,
          received_at: time,
          session_created_at: time,
          event_type: 1,
          url_path: '/a',
          hostname: 'site.test',
          normalized_hostname: 'site.test',
          is_eligible: true,
          collection_source: 'browser',
          identity_scope: 'browser',
          identity_available: true,
          _ver: 1,
        },
      ],
    });
    const read = (kind: 'observations' | 'traffic-quality/reconciliation') =>
      queryV2EvidenceFast(
        { id: owner, role: 'user' },
        site,
        {
          startAt: +hour,
          endAt: +hour + 3600000,
          timezone: 'UTC',
          hostname: 'site.test',
          sourceId: 'manual',
        },
        kind,
      );
    return { site, session, read };
  }

  for (const [kind, deletion] of [
    ['observations', 'session'],
    ['observations', 'reset'],
    ['traffic-quality/reconciliation', 'session'],
    ['traffic-quality/reconciliation', 'reset'],
  ] as const) {
    it(
      'rejects ' + kind + ' during and after ' + deletion + ', and permits fresh reads',
      async () => {
        const { site, session, read } = await fixture();
        const first = await read(kind);
        expect(kind === 'observations' ? first.totals.pv : first.browserTotals.pv).toBe(1);
        const readReady = barrier(),
          finishRead = barrier(),
          deleting = barrier(),
          finishDelete = barrier();
        afterRead = async () => {
          readReady.open();
          await finishRead.wait;
        };
        const oldRead = read(kind);
        await readReady.wait;
        beforeCommand = async () => {
          deleting.open();
          await finishDelete.wait;
        };
        const removal = deleteWarehouseStatistics(
          site,
          deletion,
          { userId: owner },
          deletion === 'session' ? session : null,
        );
        const during = await (async () => {
          try {
            await Promise.race([
              deleting.wait,
              removal.then(() => {
                throw Error('No cleanup command');
              }),
            ]);
            return await read(kind).then(
              () => 200,
              error => error.status,
            );
          } finally {
            finishDelete.open();
            beforeCommand = undefined;
            try {
              await removal;
            } finally {
              finishRead.open();
            }
          }
        })();
        const oldStatus = await oldRead.then(
          () => 200,
          error => error.status,
        );
        expect({ during, oldStatus }).toEqual({ during: 503, oldStatus: 409 });
        const fresh = await read(kind);
        expect(kind === 'observations' ? fresh.totals.pv : fresh.browserTotals.pv).toBe(0);
      },
    );
  }

  it('interrupts an already computed read while a deletion is still pending', async () => {
    const { site, session, read } = await fixture();
    const deleting = barrier(),
      finishDelete = barrier();
    let removal: Promise<unknown>;
    beforeCommand = async () => {
      deleting.open();
      await finishDelete.wait;
    };
    afterRead = async () => {
      removal = deleteWarehouseStatistics(site, 'session', { userId: owner }, session);
      await Promise.race([
        deleting.wait,
        removal.then(() => {
          throw Error('No cleanup command');
        }),
      ]);
    };
    try {
      await expect(read('observations')).rejects.toMatchObject({ status: 503 });
    } finally {
      finishDelete.open();
      beforeCommand = undefined;
      await removal;
    }
  });

  for (const part of ['page-report', 'log-entries'] as const) {
    it(
      part + ' rejects a pre-delete response and allows a fresh read after session cleanup',
      async () => {
        installAuthorizationRunner(work => work());
        const { site, session } = await fixture();
        const request = () =>
          (part === 'page-report' ? getPage : getEntries)(
            new Request(
              'http://localhost/api/liekan/websites/102/' +
                part +
                '?resource=overview&startAt=1&endAt=1000&timezone=UTC',
            ),
            { params: Promise.resolve({ websiteId: '102' }) },
          );
        const pageCache = new Map<string, number>();
        // Use the real cache key, but leave the old entry resident across deletion.
        const count = async () =>
          Number(
            (
              await (
                await ch.query({
                  query:
                    'SELECT count() AS n FROM ' +
                    v2Tables.browserEvents +
                    ' WHERE website_id={site:UUID}',
                  query_params: { site },
                  format: 'JSONEachRow',
                })
              ).json<{ n: string }>()
            )[0].n,
          );
        harness.report.mockImplementation(async () => {
          const key = analyticsCacheKey('test-page', [site, 'overview']);
          const hit = pageCache.has(key);
          if (!hit) pageCache.set(key, await count());
          return {
            value: { meta: {}, sample: pageCache.get(key) },
            generatedAt: 1,
            expiresAt: 2,
            status: hit ? 'hit' : 'miss',
          };
        });
        // A browser-session deletion preserves independent access logs.
        harness.entries.mockResolvedValue({ sample: 'retained-access-log' });
        let atReturn: (() => Promise<void>) | undefined;
        let authorized = true;
        harness.authorize.mockImplementation(async (req: Request) => {
          bindCacheRequest(req, { user: { id: owner } }, {}, async () => {
            const hook = atReturn;
            atReturn = undefined;
            if (hook) await hook();
            return authorized;
          });
          return { website: { id: site, name: 'fixture', domain: 'site.test' }, canManage: true };
        });
        const deleting = barrier(),
          finishDelete = barrier();
        let removal: Promise<unknown> | undefined;
        const startDelete = async () => {
          beforeCommand = async () => {
            deleting.open();
            await finishDelete.wait;
          };
          removal = deleteWarehouseStatistics(site, 'session', { userId: owner }, session);
          await Promise.race([
            deleting.wait,
            removal.then(() => {
              throw Error('Missing cleanup');
            }),
          ]);
        };
        const held = barrier(),
          release = barrier();
        let late: Promise<Response> | undefined;
        try {
          const initial = await request();
          expect(initial.status).toBe(200);
          expect((await initial.json()).sample).toBe(
            part === 'page-report' ? 1 : 'retained-access-log',
          );
          atReturn = async () => {
            held.open();
            await release.wait;
          };
          late = request();
          await Promise.race([
            held.wait,
            late.then(() => {
              throw Error('Missing final authorization');
            }),
          ]);
          atReturn = startDelete;
          const alreadyRead = await request();
          const readCalls = harness.report.mock.calls.length + harness.entries.mock.calls.length;
          const whilePending = await request();
          finishDelete.open();
          await removal;
          release.open();
          const afterDelete = await late;
          const beforeFresh = harness.report.mock.calls.length + harness.entries.mock.calls.length;
          const fresh = await request();
          expect([
            alreadyRead.status,
            whilePending.status,
            afterDelete.status,
            fresh.status,
          ]).toEqual([503, 503, 409, 200]);
          for (const rejected of [alreadyRead, whilePending, afterDelete]) {
            expect(await rejected.json()).toEqual({
              error: expect.objectContaining({ status: rejected.status }),
            });
            expect(rejected.headers.get('Cache-Control')).toContain('no-store');
          }
          expect(beforeFresh).toBe(readCalls);
          expect((await fresh.json()).sample).toBe(
            part === 'page-report' ? 0 : 'retained-access-log',
          );
          atReturn = async () => {
            await pg.query(
              'UPDATE liekan_log_state SET data_revision=data_revision+1 WHERE website_id=$1',
              [site],
            );
          };
          expect((await request()).status).toBe(200);
          authorized = false;
          expect((await request()).status).toBe(403);
        } finally {
          finishDelete.open();
          release.open();
          beforeCommand = undefined;
          await Promise.allSettled([removal, late]);
          installAuthorizationRunner(undefined);
        }
      },
    );
  }

  it('retries the recorded hours after facts were removed but aggregate cleanup failed', async () => {
    const { site, session, read } = await fixture();
    beforeCommand = async sql => {
      if (sql.includes('ALTER TABLE ' + v2Tables.observationHourAgg))
        throw Error('test interruption before aggregate cleanup');
    };
    try {
      await expect(
        deleteWarehouseStatistics(site, 'session', { userId: owner }, session),
      ).rejects.toThrow('test interruption');
    } finally {
      beforeCommand = undefined;
    }
    const facts = await ch.query({
      query: `SELECT count() AS n FROM ${v2Tables.browserEvents} WHERE website_id={site:UUID}`,
      query_params: { site },
      format: 'JSONEachRow',
    });
    expect(Number((await facts.json<{ n: string }>())[0].n)).toBe(0);
    await expect(read('observations')).rejects.toMatchObject({ status: 503 });
    const retried = await deleteWarehouseStatistics(site, 'session', { userId: owner }, session);
    expect(retried.deletion_revision).toBe('1');
    expect((await read('observations')).totals.pv).toBe(0);
  });

  it('still rechecks current site access before returning', async () => {
    const { site, read } = await fixture();
    afterRead = async () => {
      await pg.query('UPDATE website SET deleted_at=now() WHERE website_id=$1', [site]);
    };
    await expect(read('observations')).rejects.toMatchObject({ status: 404 });
  });

  it('keeps an in-flight read valid when ordinary ingestion revisions advance', async () => {
    const { site, read } = await fixture();
    afterRead = async () => {
      await pg.query(
        'UPDATE liekan_log_state SET data_revision=data_revision+1 WHERE website_id=$1',
        [site],
      );
      await pg.query("INSERT INTO liekan_analytics_revision VALUES('website',$1,1,now())", [site]);
    };
    expect((await read('observations')).totals.pv).toBe(1);
  });
});
