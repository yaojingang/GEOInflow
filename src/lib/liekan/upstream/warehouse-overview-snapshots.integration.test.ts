import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { ControlDatabase } from '../warehouse/control-db';
import { featureDateRange } from '../contracts/analysis';
import { readFeatureDateRange } from './date-range';
import { readViewState } from '@/components/liekan/viewState';

const harness = vi.hoisted(() => ({
  db: undefined as ControlDatabase | undefined,
  catalog: { version: '11111111-1111-4111-8111-111111111111' },
  control: 'v1',
  publication: '1',
  concurrency: 1,
  compute: vi.fn(),
  hasLogFacts: vi.fn(async () => false),
  backfill: vi.fn(),
  rankingPage: vi.fn(),
  reportContext: vi.fn((work: () => unknown, _options?: unknown) => work()),
}));
vi.mock('../crawlers/published', () => ({ getPublishedCatalog: () => harness.catalog }));
vi.mock('../warehouse/reader-runtime', () => ({
  warehouseReader: () => ({ db: harness.db, admission: { concurrency: harness.concurrency } }),
}));
vi.mock('../warehouse/reporting-context', () => ({
  readReportingMetadataForSites: async (_db: ControlDatabase, sites: string[]) =>
    sites.map(websiteId => ({ boundary: { websiteId, publication: '1' } })),
}));
vi.mock('./crawler-registry-context', () => ({
  loadPublishedRegistry: async () => harness.catalog,
  withPublishedRegistry: (work: () => unknown) => work(),
}));
vi.mock('./warehouse-report-snapshot', () => ({
  warehouseControlFingerprint: () => harness.control,
  warehouseReportMetadata: async () => ({ boundary: { publication: harness.publication } }),
  withinWarehouseReport: harness.reportContext,
}));
vi.mock('./page-report', () => ({ computeWarehouseOverview: harness.compute }));
vi.mock('./warehouse-browser-page-report', () => ({
  readWarehouseOverviewRankingPage: harness.rankingPage,
}));
vi.mock('./warehouse-log-queries', () => ({ warehouseLogWindowHasFacts: harness.hasLogFacts }));
vi.mock('./warehouse-overview-log-segments', () => ({
  prepareWarehouseOverviewLogSegments: harness.backfill,
}));
vi.mock('./analysis-query-api', () => ({
  analysisResponse: (data: { value?: unknown; ready: boolean }) =>
    Response.json(data.value ?? data, { status: data.ready ? 200 : 202 }),
}));
vi.mock('./cache-context', () => ({ noteBrowserPopulation: () => {} }));

import {
  drainWarehouseOverview,
  pumpWarehouseOverview,
  readWarehouseOverviewJob,
  requestWarehouseOverview,
} from './warehouse-overview-snapshots';

const database = process.env.LIEKAN_OVERVIEW_SCHEDULE_TEST_URL;
const websiteId = '22222222-2222-4222-8222-222222222222';
const timezone = 'Asia/Shanghai';
const presets = ['0day', '7day', '30day'];
const access = {
  website: { id: websiteId, name: 'Overview fixture', domain: 'example.test' },
  canManage: true,
} as Parameters<typeof requestWarehouseOverview>[0];

function reportRequest(date: string, now: number, zone = timezone) {
  const { dateRange } = readFeatureDateRange(date, '', 0, zone, 'zh-CN', now);
  const { startAt, endAt } = featureDateRange(dateRange, zone);
  const { chartPeriod } = readViewState({ date }, 'overview');
  return { resource: 'overview', chartPeriod, startAt, endAt, timezone: zone };
}

it.skipIf(!database)(
  'publishes and refreshes presets without visits and holds the lock while a slow computation settles',
  async () => {
    // This fixture runs only against an explicit, fresh, disposable database.
    const url = new URL(database);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/overview_schedule_test');
    const db = new ControlDatabase(database);
    harness.db = db;
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const compute = () => ({
      cards: [{ value: 20 }],
      tables: { topBody: [{ path: '/first' }] },
      meta: {
        generatedAt: Date.now(),
        snapshot: { dataThrough: now },
        tablePages: { topBody: { page: 1, pageSize: 20, total: 41 } },
      },
    });
    let release: () => void;
    let running: ReturnType<typeof pumpWarehouseOverview> | undefined;
    try {
      await db.read(`
        CREATE TABLE "user" (user_id uuid PRIMARY KEY, role text, deleted_at timestamptz);
        CREATE TABLE team (team_id uuid PRIMARY KEY, deleted_at timestamptz);
        CREATE TABLE team_user (user_id uuid, team_id uuid);
        CREATE TABLE website (website_id uuid PRIMARY KEY, name text, domain text,
          user_id uuid, team_id uuid, deleted_at timestamptz);
        CREATE TABLE liekan_account_preferences (user_id uuid PRIMARY KEY, timezone text);
        CREATE TABLE liekan_warehouse_site (website_id uuid PRIMARY KEY, resource_type text,
          state text, publication bigint);
        CREATE TABLE liekan_setting (website_id uuid, updated_at timestamptz, rules_revision int,
          ai_crawler_enabled bool, is_demo bool);
      `);
      await db.read(
        await readFile('db/liekan/migrations/092_warehouse_overview_snapshots.sql', 'utf8'),
      );
      await db.read(`INSERT INTO "user" VALUES ($1,'user',NULL)`, [websiteId]);
      await db.read(`INSERT INTO liekan_account_preferences VALUES ($1,'America/New_York')`, [
        websiteId,
      ]);
      await db.read(`INSERT INTO website VALUES ($1,'fixture','example.test',$1,NULL,NULL)`, [
        websiteId,
      ]);
      await db.read(`INSERT INTO liekan_warehouse_site VALUES ($1,'website','active',1)`, [
        websiteId,
      ]);
      const snapshots = () =>
        db.read<{
          id: string;
          parameters: { timezone: string; chartPeriod: string };
          next_attempt_at: Date;
        }>(`SELECT * FROM liekan_warehouse_overview_snapshot ORDER BY query_key`);
      const input = reportRequest('0day', now);
      expect((await requestWarehouseOverview(access, { ...input, refresh: '1' })).status).toBe(202);
      expect(await snapshots()).toHaveLength(0);

      harness.compute.mockImplementation(compute);
      await drainWarehouseOverview(new AbortController().signal);
      expect(harness.compute).toHaveBeenCalledTimes(6);
      expect(
        await db.read(`SELECT count(*)::int AS pending FROM liekan_warehouse_overview_snapshot
          WHERE queued_at>generated_at`),
      ).toEqual([{ pending: 0 }]);
      const original = await snapshots();
      for (const zone of [timezone, 'America/New_York']) {
        for (const date of presets) {
          const parameters = reportRequest(date, now, zone);
          const response = await requestWarehouseOverview(access, {
            ...parameters,
            refresh: '1',
          });
          expect(response.status).toBe(200);
          expect(response.headers.get('X-Liekan-Read-Path')).toBe('published');
          const snapshot = original.find(
            row =>
              row.parameters.timezone === zone &&
              row.parameters.chartPeriod === parameters.chartPeriod,
          );
          expect((await response.json()).meta.expiresAt).toBe(snapshot?.next_attempt_at.getTime());
        }
      }
      expect(await snapshots()).toEqual(original);
      expect(
        await db.read(`SELECT count(DISTINCT mod((extract(epoch FROM next_attempt_at)*1000)::bigint,1800000))::int AS slots,
          bool_and(next_attempt_at>generated_at+interval '10 minutes'
            AND next_attempt_at<=generated_at+interval '40 minutes') AS bounded
          FROM liekan_warehouse_overview_snapshot`),
      ).toEqual([{ slots: 1, bounded: true }]);
      await pumpWarehouseOverview();
      expect(harness.compute).toHaveBeenCalledTimes(6);

      // Invalidate fresh snapshots before their regular refresh slot.
      harness.control = 'v2';
      clock.mockReturnValue(now + 10000);
      expect((await requestWarehouseOverview(access, input)).status).toBe(202);
      expect(await snapshots()).toEqual(original);
      for (let i = 0; i < 6; i++) await pumpWarehouseOverview();
      expect((await requestWarehouseOverview(access, input)).status).toBe(200);
      expect(harness.compute).toHaveBeenCalledTimes(12);

      // An overdue preset with no recent visitors can still be read without changing its schedule.
      await db.read(`UPDATE liekan_warehouse_overview_snapshot SET
        last_requested_at=now()-interval '2 days', generated_at=now()-interval '12 minutes',
        queued_at=now()-interval '13 minutes', next_attempt_at=now()-interval '1 second'`);
      const due = await snapshots();
      expect((await requestWarehouseOverview(access, { ...input, refresh: '1' })).status).toBe(200);
      expect(await snapshots()).toEqual(due);

      // A control change makes the old result unreadable until the background refresh.
      harness.control = 'v3';
      expect((await requestWarehouseOverview(access, input)).status).toBe(202);
      expect(await snapshots()).toEqual(due);

      let started: () => void;
      const entered = new Promise<void>(resolve => {
        started = resolve;
      });
      harness.compute.mockImplementationOnce(async () => {
        started();
        await new Promise<void>(resolve => {
          release = resolve;
        });
        return compute();
      });
      running = pumpWarehouseOverview();
      await Promise.race([
        entered,
        running.then(() => {
          throw new Error('Worker did not claim the due preset');
        }),
      ]);
      // Force expiry of the recovery lease while the original session is still alive.
      await db.read(`UPDATE liekan_warehouse_overview_snapshot
        SET lease_until=now()-interval '1 second' WHERE lease_until IS NOT NULL`);
      expect(await db.read('SELECT pg_try_advisory_xact_lock(12800001,92) AS acquired')).toEqual([
        { acquired: false },
      ]);
      await pumpWarehouseOverview();
      expect(harness.compute).toHaveBeenCalledTimes(13);
      release();
      await running;
      for (let i = 0; i < 6; i++) await pumpWarehouseOverview();
      expect(harness.compute).toHaveBeenCalledTimes(19);
      expect((await requestWarehouseOverview(access, input)).status).toBe(200);

      const beforePaging = await snapshots();
      harness.rankingPage.mockResolvedValue([{ path: '/second' }]);
      const first = await requestWarehouseOverview(access, input);
      harness.publication = '2';
      const second = await requestWarehouseOverview(access, { ...input, tp_topBody: '2' });
      expect(second.status).toBe(200);
      expect(second.headers.get('X-Liekan-Read-Path')).toBe('published');
      for (const header of ['X-Liekan-Data-Through', 'X-Liekan-Warehouse-Publication'])
        expect(second.headers.get(header)).toBe(first.headers.get(header));
      expect(await second.json()).toMatchObject({
        cards: [{ value: 20 }],
        tables: { topBody: [{ path: '/second' }] },
        meta: { tablePages: { topBody: { page: 2, pageSize: 20, total: 41 } } },
      });
      expect(await snapshots()).toEqual(beforePaging);
      expect(harness.compute).toHaveBeenCalledTimes(19);
      expect(harness.reportContext.mock.lastCall?.[1]).toMatchObject({
        publication: { websiteId, publication: '1' },
      });
      const beyond = await requestWarehouseOverview(access, { ...input, tp_topBody: '9' });
      expect(await beyond.json()).toMatchObject({
        tables: { topBody: [] },
        meta: { tablePages: { topBody: { page: 9, total: 41 } } },
      });
      expect(harness.rankingPage).toHaveBeenCalledTimes(1);
      const preset = beforePaging.find(
        row => row.parameters.timezone === timezone && row.parameters.chartPeriod === 'today',
      )!;
      const polled = await readWarehouseOverviewJob(
        access,
        preset.id,
        true,
        new URLSearchParams('tp_topBody=2'),
      );
      expect(await polled.json()).toMatchObject({ tables: { topBody: [{ path: '/second' }] } });
      harness.publication = '1';

      const [legacy] = await db.read<{ id: string }>(
        `INSERT INTO liekan_warehouse_overview_snapshot
          (id,website_id,query_key,parameters,catalog_version,format_version,preset,control_version)
         SELECT gen_random_uuid(),website_id,'legacy-paged',
          parameters || '{"tablePages":{"topBody":2}}',catalog_version,format_version,false,control_version
         FROM liekan_warehouse_overview_snapshot WHERE id=$1 RETURNING id`,
        [preset.id],
      );
      await expect(readWarehouseOverviewJob(access, legacy.id, true)).rejects.toMatchObject({
        code: 'analysis-expired',
      });
      expect(await pumpWarehouseOverview()).toBe(false);
      expect(harness.compute).toHaveBeenCalledTimes(19);
      await db.read('DELETE FROM liekan_warehouse_overview_snapshot WHERE id=$1', [legacy.id]);

      // Custom queries already waiting must not take the new day's preset slots.
      const customInput = (offset: number) => ({
        ...input,
        startAt: input.startAt - offset * 1000,
      });
      const submit = await requestWarehouseOverview(access, { ...customInput(2), tp_topBody: '2' });
      const sameJob = await requestWarehouseOverview(access, customInput(2));
      expect((await submit.json()).analysisJob.id).toBe((await sameJob.json()).analysisJob.id);
      for (let page = 2; page <= 8; page++) {
        const custom = await requestWarehouseOverview(access, customInput(page));
        expect(custom.headers.get('X-Liekan-Read-Path')).toBe('queued');
      }
      const lastSlot = await Promise.allSettled(
        [9, 10].map(page => requestWarehouseOverview(access, customInput(page))),
      );
      expect(lastSlot.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(lastSlot.find(result => result.status === 'rejected')).toMatchObject({
        reason: { status: 429, code: 'analysis-concurrency-limited' },
      });
      expect((await requestWarehouseOverview(access, customInput(2))).status).toBe(202);
      await expect(requestWarehouseOverview(access, customInput(11))).rejects.toMatchObject({
        status: 429,
        code: 'analysis-concurrency-limited',
      });
      clock.mockReturnValue(now + 86400000);
      await pumpWarehouseOverview();
      expect(await snapshots()).toHaveLength(20);
      expect(harness.compute.mock.lastCall?.[1].tablePages).toEqual({});

      const otherSite = '33333333-3333-4333-8333-333333333333';
      await db.read('DELETE FROM liekan_warehouse_overview_snapshot');
      await db.read("INSERT INTO website VALUES ($1,'fixture 2','second.test',NULL,NULL,NULL)", [
        otherSite,
      ]);
      await db.read("INSERT INTO liekan_warehouse_site VALUES ($1,'website','active',1)", [
        otherSite,
      ]);
      clock.mockReturnValue(now + 2 * 86400000);
      harness.concurrency = 2;
      const active = new Map<string, () => void>();
      let notify: () => void;
      const both = new Promise<void>(resolve => {
        notify = resolve;
      });
      let executions = 0;
      let peak = 0;
      const calls = new Map<string, number>();
      harness.compute.mockImplementation(async ({ id }: { id: string }) => {
        executions++;
        calls.set(id, (calls.get(id) ?? 0) + 1);
        expect(active.has(id)).toBe(false);
        await new Promise<void>(resolve => {
          active.set(id, resolve);
          peak = Math.max(peak, active.size);
          if (active.size === 2) notify();
          if (executions > 2) resolve();
        });
        active.delete(id);
        return compute();
      });
      const drain = drainWarehouseOverview(new AbortController().signal);
      try {
        await Promise.race([
          both,
          drain.then(() => {
            throw new Error('Two sites did not start');
          }),
        ]);
        expect([...active.keys()].sort()).toEqual([websiteId, otherSite]);
        expect(
          await db.read(`SELECT count(*)::int AS leases FROM liekan_warehouse_overview_snapshot
          WHERE lease_until>now()`),
        ).toEqual([{ leases: 2 }]);
        await db.read(
          `UPDATE liekan_warehouse_overview_snapshot SET lease_until=now()-interval '1 second'
          WHERE website_id=$1 AND lease_token IS NOT NULL`,
          [websiteId],
        );
        expect(await pumpWarehouseOverview()).toBe(false);
        const held = active.get(websiteId);
        active.get(otherSite)();
        for (let i = 0; i < 40 && (calls.get(otherSite) ?? 0) < 3; i++)
          await new Promise(resolve => setTimeout(resolve, 20));
        expect(calls.get(otherSite)).toBe(3);
        expect(calls.get(websiteId)).toBe(1);
        expect(active.get(websiteId)).toBe(held);
      } finally {
        for (const settle of active.values()) settle();
        await drain;
      }
      expect(peak).toBe(2);
      expect(
        await db.read(`SELECT count(*)::int AS ready FROM liekan_warehouse_overview_snapshot
        WHERE generated_at IS NOT NULL`),
      ).toEqual([{ ready: 9 }]);

      // A long cold report leaves the other slot available for shorter reports.
      await db.read(
        `UPDATE liekan_warehouse_overview_snapshot
        SET generated_at=NULL,next_attempt_at=now()-interval '1 second'
        WHERE parameters->>'chartPeriod'='30d' AND parameters->>'timezone'=$1`,
        [timezone],
      );
      let longActive = 0;
      let longPeak = 0;
      let longCount = 0;
      harness.compute.mockImplementation(async (_site, parameters) => {
        expect(parameters.chartPeriod).toBe('30d');
        longCount++;
        longPeak = Math.max(longPeak, ++longActive);
        await new Promise(resolve => setTimeout(resolve, 20));
        longActive--;
        return compute();
      });
      await drainWarehouseOverview(new AbortController().signal);
      expect(longCount).toBe(2);
      expect(longPeak).toBe(1);

      // Recurring refreshes keep one worker even when two cold slots are configured.
      await db.read(
        `UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '1 second'`,
      );
      let refreshActive = 0;
      let refreshPeak = 0;
      let refreshes = 0;
      harness.compute.mockImplementation(async () => {
        refreshes++;
        refreshPeak = Math.max(refreshPeak, ++refreshActive);
        await new Promise(resolve => setTimeout(resolve, 10));
        refreshActive--;
        return compute();
      });
      await drainWarehouseOverview(new AbortController().signal);
      expect(refreshes).toBe(9);
      expect(refreshPeak).toBe(1);

      // A failed or cold 30-day snapshot needs backfill even with shorter reports due.
      await db.read(
        `UPDATE liekan_warehouse_overview_snapshot SET
          next_attempt_at=now()+interval '1 hour',
          generated_at=CASE WHEN website_id=$1 THEN generated_at END,
          error_code=CASE WHEN website_id=$1 THEN 'warehouse-overview-unavailable' END
        WHERE parameters->>'chartPeriod'='30d'`,
        [websiteId],
      );
      const [{ count: dueShort }] = await db.read<{ count: number }>(
        `WITH due AS (
           UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '1 second'
           WHERE parameters->>'chartPeriod' IN ('today','7d') RETURNING id
         ) SELECT count(*)::int FROM due`,
      );
      let completed = 0;
      const backfills: { site: string; completed: number }[] = [];
      harness.compute.mockImplementation(() => {
        completed++;
        return compute();
      });
      harness.hasLogFacts.mockResolvedValue(true);
      harness.backfill.mockImplementation((site, _start, _end, _parameters, backfill) => {
        expect(backfill).toBe(true);
        backfills.push({ site, completed });
      });
      await drainWarehouseOverview(new AbortController().signal);
      expect(completed).toBe(dueShort);
      expect(backfills.some(step => step.completed > 0 && step.completed < dueShort)).toBe(true);
      for (let i = 0; i < 4; i++) await drainWarehouseOverview(new AbortController().signal);
      expect([...new Set(backfills.map(step => step.site))].sort()).toEqual(
        [websiteId, otherSite].sort(),
      );
    } finally {
      release?.();
      await running?.catch(() => {});
      harness.concurrency = 1;
      harness.hasLogFacts.mockResolvedValue(false);
      await db.close();
    }
  },
  20000,
);
