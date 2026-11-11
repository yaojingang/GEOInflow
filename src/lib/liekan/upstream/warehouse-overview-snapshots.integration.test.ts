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
  compute: vi.fn(),
}));
vi.mock('../crawlers/published', () => ({ getPublishedCatalog: () => harness.catalog }));
vi.mock('../warehouse/reader-runtime', () => ({ warehouseReader: () => ({ db: harness.db }) }));
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
  warehouseReportMetadata: async () => ({ boundary: { publication: '1' } }),
  withinWarehouseReport: (work: () => unknown) => work(),
}));
vi.mock('./page-report', () => ({ computeWarehouseOverview: harness.compute }));
vi.mock('./analysis-query-api', () => ({
  analysisResponse: (data: { value?: unknown; ready: boolean }) =>
    Response.json(data.value ?? data, { status: data.ready ? 200 : 202 }),
}));
vi.mock('./cache-context', () => ({ noteBrowserPopulation: () => {} }));

import {
  drainWarehouseOverview,
  pumpWarehouseOverview,
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
    const compute = () => ({ meta: { generatedAt: Date.now(), snapshot: { dataThrough: now } } });
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
        db.read(`SELECT * FROM liekan_warehouse_overview_snapshot ORDER BY query_key`);
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
          const response = await requestWarehouseOverview(access, {
            ...reportRequest(date, now, zone),
            refresh: '1',
          });
          expect(response.status).toBe(200);
          expect(response.headers.get('X-Liekan-Read-Path')).toBe('published');
        }
      }
      expect(await snapshots()).toEqual(original);
      expect(
        (
          await db.read(`SELECT 1 FROM liekan_warehouse_overview_snapshot
        WHERE next_attempt_at < now()+interval '29 minutes'`)
        ).length,
      ).toBe(0);
      await pumpWarehouseOverview();
      expect(harness.compute).toHaveBeenCalledTimes(6);

      // Invalidate fresh snapshots while the regular refresh is still 30 minutes away.
      harness.control = 'v2';
      clock.mockReturnValue(now + 10000);
      expect((await requestWarehouseOverview(access, input)).status).toBe(202);
      expect(await snapshots()).toEqual(original);
      for (let i = 0; i < 6; i++) await pumpWarehouseOverview();
      expect((await requestWarehouseOverview(access, input)).status).toBe(200);
      expect(harness.compute).toHaveBeenCalledTimes(12);

      // An overdue preset with no recent visitors can still be read without changing its schedule.
      await db.read(`UPDATE liekan_warehouse_overview_snapshot SET
        last_requested_at=now()-interval '2 days', generated_at=now()-interval '31 minutes',
        queued_at=now()-interval '32 minutes', next_attempt_at=now()-interval '1 second'`);
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

      // Custom queries already waiting must not take the new day's preset slots.
      const customInput = (page: number) => ({ ...input, tp_topBody: page });
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
    } finally {
      release?.();
      await running?.catch(() => {});
      await db.close();
    }
  },
  20000,
);
