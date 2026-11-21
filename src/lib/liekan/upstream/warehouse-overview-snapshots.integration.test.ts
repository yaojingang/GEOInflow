import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { readViewState } from '@/components/liekan/viewState';
import { featureDateRange } from '../contracts/analysis';
import { ControlDatabase, WarehouseConflict } from '../warehouse/control-db';
import { dashboardClock } from './dashboard-clock';
import { readFeatureDateRange } from './date-range';
import { WarehouseBackgroundDeferred } from './warehouse-background-budget';
import { offlineReportLagMs } from './warehouse-report-round';

const harness = vi.hoisted(() => ({
  db: undefined as ControlDatabase | undefined,
  catalog: { version: '11111111-1111-4111-8111-111111111111' },
  control: 'v1',
  resources: ['overview'] as string[],
  publication: '1',
  concurrency: 1,
  compute: vi.fn(),
  hasLogFacts: vi.fn(async () => false),
  backfill: vi.fn(),
  rankingPage: vi.fn(),
  collect: vi.fn(async () => {}),
  fairClaim: false,
  claimAfter: vi.fn<() => Promise<number | undefined>>(async () => undefined),
  reportContext: vi.fn((work: () => unknown, _options?: unknown) => work()),
}));
vi.mock('./warehouse-analysis-gc', () => ({ collectAnalysisArtifacts: harness.collect }));
vi.mock('../contracts/scheduled-reports', () => ({
  get scheduledReportResources() {
    return harness.resources;
  },
  isScheduledReport: (r: string) => harness.resources.includes(r),
}));
vi.mock('./warehouse-retention-result', () => ({
  computeWarehouseRetention: async (
    _site: string,
    _p: unknown,
    _conditions: unknown,
    cutoff: number,
  ) => ({
    kind: 'retention',
    rows: [],
    population: {},
    dataThrough: cutoff,
  }),
}));
vi.mock('./warehouse-analysis-model', () => ({
  prepareAnalysisModel: async () => {},
  withAvailableAnalysisModel: (_s: string, work: () => unknown) => work(),
  withVerifiedAnalysisRead: (_value: unknown, work: () => unknown) => work(),
  analysisModelDays: 64,
  analysisModelVersion: 'analysis-model-v1',
}));
vi.mock('./report-ranking-artifact', () => ({
  prefillReportRankings: async () => {},
  captureReportRankings: async (_s: string, _id: string, work: () => Promise<any>) => {
    const value = await work();
    return {
      value,
      rankings: {
        build: 'fixture',
        counts: Object.fromEntries(
          Object.entries(value.meta.tablePages).map(([t, p]: [string, any]) => [t, p.total]),
        ),
        fixture: value.overviewRanking,
      },
    };
  },
  rankingPageReady: (artifact, table, page, size, total) =>
    (artifact.counts[table] ?? -1) >= Math.min(total, page * size),
  readReportRanking: async (...args: any[]) => {
    const [_s, _id, artifact, table, page, size, total] = args;
    if ((page - 1) * size >= total) return { rows: [], geography: [] };
    if (artifact.fixture && page <= 3)
      return {
        rows: artifact.fixture.rows.slice((page - 2) * size, (page - 1) * size),
        geography: [],
      };
    return { rows: await harness.rankingPage(...args), geography: [] };
  },
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
  warehouseBackgroundClaimAfter: harness.claimAfter,
  warehouseFairClaimDue: () => harness.fairClaim,
  withWarehouseReportClaim: (work: () => unknown) => work(),
  warehouseReportCheckpoint: async () => {},
  warehouseControlFingerprint: () => harness.control,
  warehouseReportMetadata: async (websiteId: string) => ({
    boundary: { websiteId, epoch: '0', deletionRevision: '0', publication: harness.publication },
  }),
  withinWarehouseReport: harness.reportContext,
}));
vi.mock('./warehouse-website-summary', () => ({
  computeWebsiteSummary: async (site: { id: string }) => ({
    id: site.id,
    views: 0,
    visitors: 0,
    pageviews: 0,
    visits: 0,
    bounces: 0,
    totaltime: 0,
    aiVisits: 0,
    comparison: { visitors: 0, pageviews: 0, visits: 0, bounces: 0, totaltime: 0, aiVisits: 0 },
  }),
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
    expect(url.pathname).toMatch(/^\/overview_schedule_test(?:_[a-f0-9]{32})?$/);
    const db = new ControlDatabase(database);
    harness.db = db;
    const wallNow = Date.now();
    const now = Math.max(
      wallNow,
      ...[timezone, 'America/New_York'].map(
        zone => reportRequest('0day', wallNow, zone).startAt + offlineReportLagMs + 60000,
      ),
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const compute = (
      _site?: unknown,
      p?: { chartPeriod: string; startAt: number; endAt: number; timezone: string },
    ) => {
      const cutoff = dashboardClock()?.cutoff ?? Date.now();
      const visitorOnly = p?.chartPeriod === '7d';
      const table = visitorOnly ? 'visitorTopBody' : 'topBody';
      const ranking = p?.chartPeriod === '30d' || visitorOnly;
      return {
        contractVersion: 2,
        website: access.website,
        resource: 'overview',
        states: { human: 'available', logs: 'available', catalog: 'available', goals: 'available' },
        charts: {},
        insights: [],
        range: p
          ? { startAt: p.startAt, endAt: Math.min(p.endAt, cutoff - 1), timezone: p.timezone }
          : reportRequest('0day', now),
        cards: [
          {
            key: 'requests',
            label: '今日总请求',
            value: p?.chartPeriod === 'today' ? 20 : 700,
            state: 'available',
          },
        ],
        tables: { [table]: [{ path: '/first' }] },
        meta: {
          demo: false,
          canManage: true,
          latestImportAt: null,
          ruleCount: 0,
          generatedAt: Date.now(),
          aiCrawlerEnabled: !visitorOnly,
          expiresAt: now + 1800000,
          snapshot: { dataThrough: cutoff, state: 'ready', intervalMs: 1800000 },
          tablePages: {
            [table]: { page: 1, pageSize: 20, total: visitorOnly || !ranking ? 41 : 65 },
          },
        },
        ...(ranking && {
          overviewRanking: {
            table,
            rows: Array.from({ length: visitorOnly ? 21 : 40 }, (_, i) => ({
              path: `/rank-${i + 21}`,
            })),
          },
        }),
      };
    };
    let release: () => void;
    let running: ReturnType<typeof pumpWarehouseOverview> | undefined;
    try {
      await db.read(`
        CREATE TABLE "user" (user_id uuid PRIMARY KEY, role text, deleted_at timestamptz);
        CREATE TABLE team (team_id uuid PRIMARY KEY, deleted_at timestamptz);
        CREATE TABLE team_user (user_id uuid, team_id uuid);
        CREATE TABLE website (website_id uuid PRIMARY KEY, name text, domain text,
          user_id uuid, team_id uuid, deleted_at timestamptz, created_at timestamptz DEFAULT now());
        CREATE TABLE liekan_account_preferences (user_id uuid PRIMARY KEY, timezone text);
        CREATE TABLE liekan_warehouse_site (website_id uuid PRIMARY KEY, resource_type text,
          state text, publication bigint);
        CREATE TABLE liekan_setting (website_id uuid, updated_at timestamptz, rules_revision int,
          ai_crawler_enabled bool, is_demo bool);
        CREATE TABLE liekan_warehouse_reference(reference_id uuid PRIMARY KEY, website_id uuid,
          epoch bigint,publication bigint,kind text,owner_id uuid,expires_at timestamptz);
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
      await db.read(`ALTER TABLE liekan_warehouse_site ADD COLUMN epoch bigint NOT NULL DEFAULT 0,
        ADD COLUMN deletion_revision bigint NOT NULL DEFAULT 0`);
      await db.read(await readFile('db/liekan/migrations/097_warehouse_report_rounds.sql', 'utf8'));
      await db.read(await readFile('db/liekan/migrations/098_warehouse_round_metrics.sql', 'utf8'));
      await db.read(
        await readFile('db/liekan/migrations/099_warehouse_analysis_build.sql', 'utf8'),
      );
      const snapshots = () =>
        db.read<{
          id: string;
          parameters: { timezone: string; chartPeriod: string; endAt: number };
          next_attempt_at: Date;
        }>(
          `SELECT * FROM liekan_warehouse_overview_snapshot WHERE NOT (parameters ? 'siteSummary') ORDER BY query_key`,
        );
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
          const body = await response.json();
          expect(body.cards.find(card => card.label === '今日总请求')?.value).toBe(20);
          expect(body.meta.todayRequests.dataThrough).toBe(now - offlineReportLagMs);
          expect(body.meta.snapshot.intervalMs).toBe(
            { today: 600000, '7d': 21600000, '30d': 43200000 }[parameters.chartPeriod],
          );
          expect(body.meta.expiresAt).toBeLessThanOrEqual(snapshot!.next_attempt_at.getTime());
        }
      }
      expect(await snapshots()).toEqual(original);
      // Serialize an actual format-2 public payload with inline pages. Current
      // tasks remain queued; compatibility never rewrites their format or data.
      {
        const [currentThirty] = await db.read<any>(
          "SELECT * FROM liekan_warehouse_overview_snapshot WHERE parameters->>'chartPeriod'='30d' AND parameters->>'timezone'=$1",
          [timezone],
        );
        const legacyId = '99999999-1111-4111-8111-111111111111';
        const legacy = { ...currentThirty.result };
        delete legacy.rankings;
        await db.read(
          `INSERT INTO liekan_warehouse_overview_snapshot
        (id,website_id,query_key,parameters,catalog_version,format_version,preset,control_version,publication,generated_at,result)
        VALUES($1,$2,'legacy-upgrade',$3,$4,2,true,$5,$6,$7,$8)`,
          [
            legacyId,
            websiteId,
            currentThirty.parameters,
            currentThirty.catalog_version,
            currentThirty.control_version,
            currentThirty.publication,
            new Date(+currentThirty.generated_at - 60000),
            legacy,
          ],
        );
        await db.read(
          'UPDATE liekan_warehouse_overview_snapshot SET result=NULL,generated_at=NULL,publication=NULL WHERE id=$1',
          [currentThirty.id],
        );
        const legacyResponse = await requestWarehouseOverview(access, reportRequest('30day', now));
        expect(legacyResponse.status).toBe(200);
        const legacyBody = await legacyResponse.json();
        expect(legacyBody.meta.snapshot.state).toBe('updating');
        expect(legacyBody.range).toEqual(legacy.range);
        const legacyPage = await requestWarehouseOverview(access, {
          ...reportRequest('30day', now),
          tp_topBody: '2',
          reportVersion: legacyBody.meta.snapshot.version,
        });
        expect(legacyPage.status).toBe(200);
        expect((await legacyPage.json()).tables.topBody[0].path).toBe('/rank-21');
        await db.read(
          'UPDATE liekan_warehouse_overview_snapshot SET result=$2,generated_at=$3,publication=$4 WHERE id=$1',
          [
            currentThirty.id,
            currentThirty.result,
            currentThirty.generated_at,
            currentThirty.publication,
          ],
        );
        // The first offline build can finish later while covering less data.
        const lagging = structuredClone(currentThirty.result);
        lagging.meta.snapshot.dataThrough -= 60000;
        lagging.range.endAt = lagging.meta.snapshot.dataThrough - 1;
        await db.read('UPDATE liekan_warehouse_overview_snapshot SET result=$2 WHERE id=$1', [
          currentThirty.id,
          lagging,
        ]);
        await db.read(
          `UPDATE liekan_warehouse_overview_snapshot
          SET preset=false,last_requested_at=now()-interval '2 days'
          WHERE id=$1`,
          [legacyId],
        );
        await pumpWarehouseOverview();
        const request = reportRequest('30day', now);
        const legacyVersion = legacyBody.meta.snapshot.version;
        for (const response of [
          await requestWarehouseOverview(access, request),
          await readWarehouseOverviewJob(access, currentThirty.id, true),
        ]) {
          const body = await response.json();
          expect(body.meta.snapshot.version).toBe(legacyVersion);
          expect(body.meta.snapshot.dataThrough).toBe(legacy.meta.snapshot.dataThrough);
        }
        await db.read('UPDATE liekan_warehouse_overview_snapshot SET result=$2 WHERE id=$1', [
          currentThirty.id,
          currentThirty.result,
        ]);
        expect(
          (await (await requestWarehouseOverview(access, request)).json()).meta.snapshot.version,
        ).not.toBe(legacyVersion);
        await expect(
          requestWarehouseOverview(access, { ...request, reportVersion: legacyVersion }),
        ).rejects.toMatchObject({ status: 409 });
        await db.read('DELETE FROM liekan_warehouse_overview_snapshot WHERE id=$1', [legacyId]);
      }
      expect(
        await db.read(`SELECT count(DISTINCT mod((extract(epoch FROM next_attempt_at)*1000)::bigint,600000))::int AS slots,
          bool_and(next_attempt_at>generated_at
            AND mod((extract(epoch FROM next_attempt_at)*1000)::bigint, CASE parameters->>'chartPeriod' WHEN 'today' THEN 600000 WHEN '7d' THEN 21600000 ELSE 43200000 END)<600000
            AND next_attempt_at<=generated_at+interval '5 seconds'+CASE parameters->>'chartPeriod'
              WHEN 'today' THEN interval '10 minutes' WHEN '7d' THEN interval '6 hours' ELSE interval '12 hours' END) AS bounded
          FROM liekan_warehouse_overview_snapshot`),
      ).toEqual([{ slots: 1, bounded: true }]);
      await pumpWarehouseOverview();
      expect(harness.compute).toHaveBeenCalledTimes(6);

      // The same Today authority is composed into old 7/30-day reports, even
      // when its publication is newer. Window cards and ranking versions stay put.
      const todayRow = original.find(
        row => row.parameters.timezone === timezone && row.parameters.chartPeriod === 'today',
      )!;
      const [savedToday] = await db.read<any>(
        'SELECT result,generated_at,started_at,publication,error_code FROM liekan_warehouse_overview_snapshot WHERE id=$1',
        [todayRow.id],
      );
      const legacyToday = structuredClone(savedToday.result);
      legacyToday.meta.snapshot.dataThrough += 30000;
      legacyToday.range.endAt = Math.min(
        todayRow.parameters.endAt,
        legacyToday.meta.snapshot.dataThrough - 1,
      );
      legacyToday.cards[0].value = 123;
      const legacyTodayId = randomUUID();
      await db.read(
        `INSERT INTO liekan_warehouse_overview_snapshot
        (id,website_id,query_key,parameters,catalog_version,format_version,preset,control_version,publication,generated_at,result)
        SELECT $2,website_id,'upgrade-today',parameters,catalog_version,2,true,control_version,publication,
          generated_at-interval '1 minute',$3 FROM liekan_warehouse_overview_snapshot WHERE id=$1`,
        [todayRow.id, legacyTodayId, legacyToday],
      );
      for (const period of presets) {
        const body = await (
          await requestWarehouseOverview(access, reportRequest(period, now))
        ).json();
        expect(body.cards[0].value).toBe(123);
        expect(body.meta.todayRequests.dataThrough).toBe(legacyToday.meta.snapshot.dataThrough);
      }
      await db.read(
        'UPDATE liekan_warehouse_overview_snapshot SET control_version=$2 WHERE id=$1',
        [legacyTodayId, 'revoked-old-control'],
      );
      const allowedToday = await (
        await requestWarehouseOverview(access, reportRequest('30day', now))
      ).json();
      expect(allowedToday.cards[0].value).toBe(savedToday.result.cards[0].value);
      await db.read('DELETE FROM liekan_warehouse_overview_snapshot WHERE id=$1', [legacyTodayId]);
      // A recovered round with an older frozen clock must release its lease
      // and keep the newer, still-authorized same-format publication in place.
      await db.read(
        `UPDATE liekan_warehouse_overview_snapshot SET result=$2,
        next_attempt_at=now()-interval '1 minute' WHERE id=$1`,
        [todayRow.id, legacyToday],
      );
      expect(await pumpWarehouseOverview()).toBe(true);
      const [kept] = await db.read<any>(
        `SELECT result,generated_at,lease_token,next_attempt_at>now() AS delayed
        FROM liekan_warehouse_overview_snapshot WHERE id=$1`,
        [todayRow.id],
      );
      expect(kept).toMatchObject({
        result: legacyToday,
        generated_at: savedToday.generated_at,
        lease_token: null,
        delayed: true,
      });
      await db.read(
        'UPDATE liekan_warehouse_overview_snapshot SET result=$2,next_attempt_at=$3,started_at=$4 WHERE id=$1',
        [todayRow.id, savedToday.result, todayRow.next_attempt_at,savedToday.started_at],
      );
      const windowInput = reportRequest('30day', now);
      const beforeShared = await (await requestWarehouseOverview(access, windowInput)).json();
      harness.publication = '2';
      await db.read(
        `UPDATE liekan_warehouse_overview_snapshot SET result=jsonb_set(result,'{cards,0,value}','55'),publication=2 WHERE id=$1`,
        [todayRow.id],
      );
      for (const date of presets) {
        const value = await (
          await requestWarehouseOverview(access, reportRequest(date, now))
        ).json();
        expect(value.cards.find(card => card.label === '今日总请求').value).toBe(55);
        if (date === '30day') {
          expect(value.tables).toEqual(beforeShared.tables);
          expect(value.meta.snapshot.version).toBe(beforeShared.meta.snapshot.version);
        }
      }
      const otherZone = await (
        await requestWarehouseOverview(access, reportRequest('30day', now, 'America/New_York'))
      ).json();
      expect(otherZone.cards.find(card => card.label === '今日总请求').value).toBe(20);
      await db.read(
        `UPDATE liekan_warehouse_overview_snapshot SET result=NULL,generated_at=NULL,publication=NULL WHERE id=$1`,
        [todayRow.id],
      );
      const missing = await (await requestWarehouseOverview(access, windowInput)).json();
      expect(missing.meta.todayRequests.state).toBe('preparing');
      expect(missing.cards.find(card => card.label === '今日总请求')).toMatchObject({
        value: null,
        state: 'unavailable',
      });
      expect(missing.tables).toEqual(beforeShared.tables);
      await db.read(
        `UPDATE liekan_warehouse_overview_snapshot SET error_code='fixture-failure' WHERE id=$1`,
        [todayRow.id],
      );
      const failed = await (await requestWarehouseOverview(access, windowInput)).json();
      expect(failed.meta.todayRequests.state).toBe('failed');
      await db.read(
        `UPDATE liekan_warehouse_overview_snapshot SET result=$2,generated_at=$3,publication=$4,error_code=$5 WHERE id=$1`,
        [
          todayRow.id,
          savedToday.result,
          savedToday.generated_at,
          savedToday.publication,
          savedToday.error_code,
        ],
      );
      harness.publication = '1';
      expect(await snapshots()).toEqual(original);

      // A new calendar day has a different key, but must retain the last published report.
      clock.mockReturnValue(now + 86400000);
      // Retiring yesterday's registration must not retire its published card.
      await db.read('UPDATE liekan_warehouse_overview_snapshot SET preset=false WHERE id=$1', [todayRow.id]);
      // Incompatible archival bodies ahead of the latest readable one must not mask it.
      await db.read(`INSERT INTO liekan_warehouse_overview_snapshot
        (id,website_id,query_key,parameters,catalog_version,format_version,preset,control_version,publication,generated_at,result)
        SELECT gen_random_uuid(),website_id,'invalid-archive-'||n,parameters,catalog_version,2,false,control_version,publication,
          generated_at,jsonb_set(result - 'cards','{meta,snapshot,dataThrough}',to_jsonb($2::bigint+n))
        FROM liekan_warehouse_overview_snapshot CROSS JOIN generate_series(1,9) AS n WHERE id=$1`,
        [todayRow.id, now]);
      for (const date of presets) {
        const requested = reportRequest(date, now + 86400000);
        const response = await requestWarehouseOverview(access, requested);
        expect(response.status, 'last successful result survives a calendar rollover').toBe(200);
        const value = await response.json();
        const source = reportRequest(date, now);
        expect(value.meta.snapshot).toMatchObject({
          state: 'updating',
          fallback: {
            requestedRange: { startAt: requested.startAt, endAt: requested.endAt, timezone },
            sourceRange: { startAt: source.startAt, endAt: source.endAt, timezone },
            chartPeriod: source.chartPeriod,
          },
        });
        expect(value.range).toMatchObject({
          startAt: source.startAt,
          endAt: Math.min(source.endAt, now - offlineReportLagMs - 1),
        });
        expect(value.meta.snapshot.dataThrough).toBe(now - offlineReportLagMs);
        expect(value.meta.todayRequests).toMatchObject({
          state: 'updating',
          dataThrough: now - offlineReportLagMs,
        });
        expect(value.meta.todayRequests.range.startAt).toBe(reportRequest('0day', now).startAt);
        if (date === '30day') {
          const page = await requestWarehouseOverview(access, {
            ...requested,
            tp_topBody: '2',
            reportVersion: value.meta.snapshot.version,
          });
          expect(page.status).toBe(200);
          const second = await page.json();
          expect(second.meta.snapshot.version).toBe(value.meta.snapshot.version);
          expect(second.tables.topBody[0].path).toBe('/rank-21');
        }
      }
      await db.read("DELETE FROM liekan_warehouse_overview_snapshot WHERE query_key LIKE 'invalid-archive-%'");
      await db.read('UPDATE liekan_warehouse_overview_snapshot SET preset=true WHERE id=$1', [todayRow.id]);
      // Without a result for the same period, another period is explicit fallback.
      const [thirty] = await db.read<any>(
        "SELECT * FROM liekan_warehouse_overview_snapshot WHERE parameters->>'chartPeriod'='30d' AND parameters->>'timezone'=$1",
        [timezone],
      );
      await db.read(
        'UPDATE liekan_warehouse_overview_snapshot SET generated_at=NULL,result=NULL,publication=NULL,error_code=$2 WHERE id=$1',
        [thirty.id, 'fixture-update-failed'],
      );
      const alternative = await requestWarehouseOverview(
        access,
        reportRequest('30day', now + 86400000),
      );
      expect(alternative.status).toBe(200);
      const alternate = await alternative.json();
      expect(alternate.meta.snapshot.fallback.chartPeriod).not.toBe('30d');
      expect(alternate.meta.snapshot.state).toBe('updating');
      await db.read(
        'UPDATE liekan_warehouse_overview_snapshot SET generated_at=$2,result=$3,publication=$4,error_code=NULL WHERE id=$1',
        [thirty.id, thirty.generated_at, thirty.result, thirty.publication],
      );
      for (const mismatch of [{ search: 'different-filter' }, { timezone: 'UTC' }]) {
        expect(
          (
            await requestWarehouseOverview(access, {
              ...reportRequest('0day', now + 86400000),
              ...mismatch,
            })
          ).status,
        ).toBe(202);
      }
      harness.resources = ['overview', 'ai/overview'];
      expect(
        (
          await requestWarehouseOverview(access, {
            ...reportRequest('0day', now + 86400000),
            resource: 'ai/overview',
          })
        ).status,
      ).toBe(202);
      harness.resources = ['overview'];
      expect(
        (
          await requestWarehouseOverview(
            {
              ...access,
              website: { ...access.website, id: '33333333-3333-4333-8333-333333333333' },
            },
            reportRequest('0day', now + 86400000),
          )
        ).status,
      ).toBe(202);
      await db.read(
        'DELETE FROM liekan_warehouse_overview_snapshot WHERE NOT(id=ANY($1::uuid[]))',
        [original.map(r => r.id)],
      );
      expect(harness.compute).toHaveBeenCalledTimes(6);
      expect(await snapshots()).toEqual(original);
      clock.mockReturnValue(now);

      // Invalidate fresh snapshots before their regular refresh slot.
      harness.control = 'v2';
      clock.mockReturnValue(now + 10000);
      expect((await requestWarehouseOverview(access, input)).status).toBe(202);
      expect(await snapshots()).toEqual(original);
      // Eligibility uses the database clock. An empty poll is not a completed job.
      const invalidationDeadline = performance.now() + 5000;
      while (harness.compute.mock.calls.length < 12 && performance.now() < invalidationDeadline) {
        if (!(await pumpWarehouseOverview())) await new Promise(resolve => setTimeout(resolve, 25));
      }
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

      harness.rankingPage.mockClear();
      for (const [date, table, total] of [
        ['30day', 'topBody', 65],
        ['7day', 'visitorTopBody', 41],
      ] as const) {
        const params = reportRequest(date, now);
        const firstPage = await requestWarehouseOverview(access, params);
        const firstBody = await firstPage.json();
        expect(firstBody).not.toHaveProperty('overviewRanking');
        expect(firstBody.meta.snapshot.version).toMatch(/^[a-f0-9]{64}$/);
        for (const page of [2, 3]) {
          const response = await requestWarehouseOverview(access, {
            ...params,
            [`tp_${table}`]: page,
          });
          expect(response.status).toBe(200);
          expect(response.headers.get('X-Liekan-Overview-Ranking')).toBe('snapshot');
          for (const header of ['X-Liekan-Data-Through', 'X-Liekan-Warehouse-Publication'])
            expect(response.headers.get(header)).toBe(firstPage.headers.get(header));
          const body = await response.json();
          expect(body).not.toHaveProperty('overviewRanking');
          expect(body.meta.snapshot.version).toBe(firstBody.meta.snapshot.version);
          expect(body.tables[table]).toEqual(
            Array.from({ length: Math.min(20, total - (page - 1) * 20) }, (_, i) => ({
              path: `/rank-${(page - 1) * 20 + 1 + i}`,
            })),
          );
          expect(body.meta.tablePages[table]).toEqual({ page, pageSize: 20, total });
        }
      }
      expect(harness.rankingPage).not.toHaveBeenCalled();
      const deepPage = await requestWarehouseOverview(access, {
        ...reportRequest('30day', now),
        tp_topBody: 4,
      });
      expect(deepPage.headers.get('X-Liekan-Overview-Ranking')).toBe('snapshot');
      expect(harness.rankingPage).toHaveBeenCalledTimes(1);
      expect(await snapshots()).toEqual(beforePaging);

      const deepInput = reportRequest('30day', now);
      const firstDeepSnapshot = await (await requestWarehouseOverview(access, deepInput)).json();
      const overviewVersion = firstDeepSnapshot.meta.snapshot.version;
      const deepRequest = { ...deepInput, tp_topBody: 4, overviewVersion };
      const [deepRow] = await db.read<{ id: string }>(
        `SELECT id
           FROM liekan_warehouse_overview_snapshot
          WHERE parameters->>'chartPeriod'='30d' AND parameters->>'timezone'=$1`,
        [timezone],
      );
      const [savedRank] = await db.read<{ result: any }>(
        'SELECT result FROM liekan_warehouse_overview_snapshot WHERE id=$1',
        [deepRow.id],
      );
      await db.read(
        "UPDATE liekan_warehouse_overview_snapshot SET result=jsonb_set(jsonb_set(result,'{rankings,counts,topBody}','40'),'{rankings,pending}','true') WHERE id=$1",
        [deepRow.id],
      );
      expect((await requestWarehouseOverview(access, deepInput)).status).toBe(200);
      expect((await requestWarehouseOverview(access, { ...deepInput, tp_topBody: 2 })).status).toBe(
        200,
      );
      expect((await requestWarehouseOverview(access, { ...deepInput, tp_topBody: 4 })).status).toBe(
        202,
      );
      await db.read('UPDATE liekan_warehouse_overview_snapshot SET result=$2::jsonb WHERE id=$1', [
        deepRow.id,
        JSON.stringify(savedRank.result),
      ]);
      const stale = { status: 409, code: 'overview-version-invalidated' };
      await expect(
        requestWarehouseOverview(access, {
          ...deepRequest,
          overviewVersion: '0'.repeat(64),
        }),
      ).rejects.toMatchObject(stale);
      expect(harness.rankingPage).toHaveBeenCalledTimes(1);
      const jobInput = new URLSearchParams({ tp_topBody: '4', overviewVersion });
      expect((await readWarehouseOverviewJob(access, deepRow.id, true, jobInput)).status).toBe(200);

      harness.rankingPage.mockImplementationOnce(async () => {
        await db.read(
          "UPDATE liekan_warehouse_overview_snapshot SET generated_at=generated_at+interval '1 microsecond' WHERE id=$1",
          [deepRow.id],
        );
        return [{ path: '/stale' }];
      });
      await expect(requestWarehouseOverview(access, deepRequest)).rejects.toMatchObject(stale);
      await expect(
        readWarehouseOverviewJob(access, deepRow.id, true, jobInput),
      ).rejects.toMatchObject(stale);
      const fresh = await (await requestWarehouseOverview(access, deepInput)).json();
      expect(fresh.meta.snapshot.version).not.toBe(overviewVersion);
      const originalControl = harness.control;
      harness.rankingPage.mockImplementationOnce(async () => {
        harness.control = 'deleted-or-repaired';
        return [{ path: '/invalidated' }];
      });
      await expect(
        requestWarehouseOverview(access, {
          ...deepRequest,
          overviewVersion: fresh.meta.snapshot.version,
        }),
      ).rejects.toMatchObject(stale);
      harness.control = originalControl;
      await db.read(
        "UPDATE liekan_warehouse_overview_snapshot SET generated_at=generated_at-interval '1 microsecond' WHERE id=$1",
        [deepRow.id],
      );
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
        search: 'isolated-queue-without-a-published-result',
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
        reason: { status: 429, code: 'warehouse-report-no-valid-snapshot' },
      });
      expect((await requestWarehouseOverview(access, customInput(2))).status).toBe(202);
      await expect(requestWarehouseOverview(access, customInput(11))).rejects.toMatchObject({
        status: 429,
        code: 'warehouse-report-no-valid-snapshot',
      });
      const beforeCapacityFallback = await snapshots();
      const atCapacity = await requestWarehouseOverview(access, {
        ...input,
        startAt: input.startAt - 12000,
      });
      expect(atCapacity.status).toBe(200);
      expect((await atCapacity.json()).meta.snapshot).toMatchObject({
        state: 'updating',
        updateError: true,
        fallback: { requestedRange: { startAt: input.startAt - 12000 } },
      });
      expect(await snapshots()).toEqual(beforeCapacityFallback);
      clock.mockReturnValue(now + 86400000);
      await pumpWarehouseOverview();
      expect(await snapshots()).toHaveLength(20);
      expect(harness.compute.mock.lastCall?.[1].tablePages).toEqual({});

      const otherSite = '33333333-3333-4333-8333-333333333333';
      await db.read('DELETE FROM liekan_warehouse_overview_snapshot');
      await db.read("INSERT INTO website VALUES ($1,'fixture 2','second.test',NULL,NULL,NULL)", [
        otherSite,
      ]);
      await db.read(
        "INSERT INTO liekan_warehouse_site(website_id,resource_type,state,publication) VALUES ($1,'website','active',1)",
        [otherSite],
      );
      clock.mockReturnValue(now + 2 * 86400000);
      harness.concurrency = 2;
      let releaseFirst: () => void;
      let active = 0;
      let peak = 0;
      let executions = 0;
      harness.compute.mockImplementation(async () => {
        peak = Math.max(peak, ++active);
        if (++executions === 1)
          await new Promise<void>(resolve => {
            releaseFirst = resolve;
          });
        active--;
        return compute();
      });
      const drain = drainWarehouseOverview(new AbortController().signal);
      try {
        await vi.waitFor(() => expect(executions).toBe(1));
        expect(
          await db.read(`SELECT count(*)::int AS leases FROM liekan_warehouse_overview_snapshot
          WHERE lease_until>now()`),
        ).toEqual([{ leases: 1 }]);
        await db.read(
          `UPDATE liekan_warehouse_overview_snapshot SET lease_until=now()-interval '1 second'
          WHERE lease_token IS NOT NULL`,
        );
        expect(await pumpWarehouseOverview()).toBe(false);
        expect(executions).toBe(1);
      } finally {
        releaseFirst?.();
        await drain;
      }
      expect(peak).toBe(1);
      await drainWarehouseOverview(new AbortController().signal);
      expect(
        await db.read(`SELECT count(*)::int AS ready FROM liekan_warehouse_overview_snapshot
        WHERE generated_at IS NOT NULL AND NOT (parameters ? 'siteSummary')`),
      ).toEqual([{ ready: 9 }]);

      // Long cold reports use the same single queue and lease.
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

      // Recurring refreshes also stay serial with two interactive read permits.
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

      // A failed or cold 30-day snapshot still gets backfill, but it must not
      // prepare a newer boundary between tasks in an unfinished shared round.
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
           WHERE parameters->>'chartPeriod' IN ('today','7d') AND NOT (parameters ? 'siteSummary') RETURNING id
         ) SELECT count(*)::int FROM due`,
      );
      let completed = 0;
      const backfills: { site: string; completed: number }[] = [];
      harness.compute.mockImplementation(() => {
        completed++;
        return compute();
      });
      harness.hasLogFacts.mockResolvedValue(true);
      harness.backfill.mockImplementation(async (site, _start, _end, _parameters, backfill) => {
        expect(backfill).toBe(true);
        expect(
          await db.read('SELECT id FROM liekan_warehouse_report_round WHERE website_id=$1', [site]),
        ).toEqual([]);
        backfills.push({ site, completed });
      });
      await drainWarehouseOverview(new AbortController().signal);
      expect(completed).toBe(dueShort);
      for (let i = 0; i < 4; i++) await drainWarehouseOverview(new AbortController().signal);
      expect(backfills.every(step => step.completed > 0)).toBe(true);
      expect([...new Set(backfills.map(step => step.site))].sort()).toEqual(
        [websiteId, otherSite].sort(),
      );
      // Generalized scheduling is unattended and includes each aggregate page.
      await db.read('DELETE FROM liekan_warehouse_overview_snapshot');
      harness.resources = [
        'overview',
        'ai/overview',
        'ai/bots',
        'ai/pages',
        'ai/preference',
        'human/overview',
        'human/geo',
        'human/sources',
        'human/search-engines',
        'content',
        'conversions',
      ];
      harness.compute.mockImplementation(compute);
      harness.hasLogFacts.mockResolvedValue(false);
      clock.mockReturnValue(now + 3 * 86400000);
      let generated: { ready: number; resources: number }[];
      // Discovery uses the mocked application clock. SQL eligibility uses the
      // real PG clock, which may move backwards briefly on a local VM.
      const discoveryDeadline = performance.now() + 5000;
      for (let tick = 0; tick < 3 || performance.now() < discoveryDeadline; tick++) {
        await drainWarehouseOverview(new AbortController().signal);
        generated = await db.read<{ ready: number; resources: number }>(
          `SELECT count(*)::int AS ready,count(DISTINCT parameters->>'resource')::int AS resources FROM liekan_warehouse_overview_snapshot WHERE generated_at IS NOT NULL AND NOT (parameters ? 'siteSummary')`,
        );
        if (generated[0].ready === 102) break;
        await new Promise(resolve => setTimeout(resolve, 100));
        clock.mockReturnValue(now + 3 * 86400000 + (tick + 1) * 5000);
      }
      expect(generated).toEqual([{ ready: 102, resources: 11 }]);
      expect(await db.read(
        `SELECT count(*)::int AS months FROM liekan_warehouse_overview_snapshot
         WHERE preset AND parameters ? 'nativeRetention' AND
         (parameters->>'endAt')::bigint-(parameters->>'startAt')::bigint > 27*86400000::bigint`,
      )).toEqual([{ months: 3 }]);
      expect(harness.collect).toHaveBeenCalled();
      // The page's default sort must hit unattended presets, not create a custom job.
      for (const date of presets) {
        const parameters = {
          ...reportRequest(date, now + 3 * 86400000),
          resource: 'human/geo',
          direction: readViewState({ date }, 'human/geo').sort.direction === -1 ? 'desc' : 'asc',
          geoSort: 'sessions',
          search: '',
        };
        const response = await requestWarehouseOverview(
          access,
          parameters,
          new AbortController().signal,
        );
        expect(response.status).toBe(200);
      }
      expect(
        await db.read(
          'SELECT count(*)::int AS count FROM liekan_warehouse_overview_snapshot WHERE NOT preset',
        ),
      ).toEqual([{ count: 0 }]);
      // Upgrade an old rolling-retention row with a live lease. Discovery must
      // keep both the readable payload and the in-flight owner's receipt.
      const oldRetentionId = randomUUID();
      const oldLease = randomUUID();
      const [savedRetention] = await db.read<{ digest: string }>(
        `INSERT INTO liekan_warehouse_overview_snapshot
          (id,website_id,query_key,parameters,catalog_version,format_version,preset,control_version,
           publication,result,generated_at,lease_token,lease_until)
         SELECT $1,website_id,'retired-retention-fixture',parameters || '{"nativeRetention":{}}'::jsonb,
           catalog_version,format_version,true,control_version,publication,result,generated_at,$2,now()+interval '1 minute'
         FROM liekan_warehouse_overview_snapshot WHERE parameters->>'resource'='human/overview'
           AND parameters->>'chartPeriod'='7d' AND NOT parameters ? 'nativeRetention'
           AND result IS NOT NULL LIMIT 1
         RETURNING md5(result::text) AS digest`,
        [oldRetentionId, oldLease],
      );
      expect(savedRetention.digest).toMatch(/^[0-9a-f]{32}$/);
      clock.mockReturnValue(Date.now() + 31000);
      await pumpWarehouseOverview();
      expect(
        await db.read(
          'SELECT preset,lease_token,md5(result::text) AS digest FROM liekan_warehouse_overview_snapshot WHERE id=$1',
          [oldRetentionId],
        ),
      ).toEqual([{ preset: false, lease_token: oldLease, digest: savedRetention.digest }]);
      await db.read('DELETE FROM liekan_warehouse_overview_snapshot WHERE id=$1', [oldRetentionId]);
      // An owner that claimed a scheduled job before retirement may finish its
      // verified result. Its original scheduling flag cannot undo retirement.
      await db.read("UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()+interval '5 days'");
      const [retiringJob] = await db.read<{ id: string }>(
        `UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '1 minute'
         WHERE id=(SELECT id FROM liekan_warehouse_overview_snapshot WHERE preset
           AND website_id=$1 AND parameters->>'resource'='overview' AND parameters->>'timezone'=$2
           AND parameters->>'chartPeriod'='today' AND result IS NOT NULL LIMIT 1)
         RETURNING id`,
        [websiteId, timezone],
      );
      harness.compute.mockImplementationOnce(async (site, params) => {
        const retired = await db.read(
          'UPDATE liekan_warehouse_overview_snapshot SET preset=false WHERE id=$1 AND lease_until>now() RETURNING id',
          [retiringJob.id],
        );
        expect(retired).toEqual([{ id: retiringJob.id }]);
        const value = compute(site, params);
        value.cards[0].value = 127;
        return value;
      });
      await pumpWarehouseOverview();
      expect(
        await db.read(
          `SELECT preset,lease_token, result->'cards'->0->>'value' AS value
           FROM liekan_warehouse_overview_snapshot WHERE id=$1`,
          [retiringJob.id],
        ),
      ).toEqual([{ preset: false, lease_token: null, value: '127' }]);
      await db.read('UPDATE liekan_warehouse_overview_snapshot SET preset=true WHERE id=$1', [retiringJob.id]);
      // Two failing cold reports can become eligible again while each other runs.
      // Persisted due times must give overdue refreshes a turn after a restart.
      const coldReports = await db.read<{ id: string }>(
        `SELECT id FROM liekan_warehouse_overview_snapshot WHERE website_id=$1
          AND parameters->>'timezone'=$2 AND parameters->>'resource'='ai/preference'
          AND parameters->>'chartPeriod' IN ('7d','30d') ORDER BY id`,
        [websiteId, timezone],
      );
      const todayReports = await db.read<{ id: string }>(
        `SELECT id FROM liekan_warehouse_overview_snapshot WHERE website_id IN ($1,$2)
          AND parameters->>'timezone'=$3 AND parameters->>'resource'='overview'
          AND parameters->>'chartPeriod'='today' ORDER BY id`,
        [websiteId, otherSite, timezone],
      );
      expect(coldReports).toHaveLength(2);
      expect(todayReports).toHaveLength(2);
      const coldIds = coldReports.map(row => row.id);
      const todayIds = todayReports.map(row => row.id);
      const attempts: string[] = [];
      let requestCount = 0;
      harness.compute.mockImplementation(async (site, p) => {
        attempts.push(`${p.resource}:${site.id}`);
        if (p.resource === 'ai/preference') throw new Error('controlled cold failure');
        const report = compute(site, p);
        report.cards[0].value = requestCount;
        return report;
      });
      await db.read(
        "UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()+interval '5 days'",
      );
      await db.read(
        `UPDATE liekan_warehouse_overview_snapshot SET generated_at=NULL,result=NULL,
          error_code='warehouse-overview-unavailable',next_attempt_at=now()-interval '1 second'
         WHERE id=ANY($1::uuid[])`,
        [coldIds],
      );
      // Under sustained ingestion, one slot favors Today and the next one
      // returns to persisted eligibility order, including overdue retries.
      harness.fairClaim = true;
      const previousCollections = harness.collect.mock.calls.length;
      await db.read(
        "UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '1 hour' WHERE id=ANY($1::uuid[])",
        [coldIds],
      );
      await db.read(
        "UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '3 minutes' WHERE id=ANY($1::uuid[])",
        [todayIds],
      );
      await pumpWarehouseOverview();
      await pumpWarehouseOverview();
      expect(attempts.splice(0).map(task => task.split(':')[0])).toEqual([
        'overview',
        'ai/preference',
      ]);
      await pumpWarehouseOverview();
      await pumpWarehouseOverview();
      expect(attempts.splice(0).map(task => task.split(':')[0]).sort()).toEqual([
        'ai/preference',
        'overview',
      ]);
      expect(harness.collect).toHaveBeenCalledTimes(previousCollections);
      harness.fairClaim = false;
      await db.read(
        "UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])",
        [coldIds],
      );
      for (let cycle = 0; cycle < 2; cycle++) {
        requestCount = 100 * (cycle + 1);
        await db.read(
          `UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '20 minutes'
           WHERE id=ANY($1::uuid[])`,
          [todayIds],
        );
        for (const _ of todayIds) await pumpWarehouseOverview();
        expect(attempts.splice(0).sort()).toEqual(
          [`overview:${websiteId}`, `overview:${otherSite}`].sort(),
        );
        expect(
          await db.read(
            `SELECT count(*)::int AS n FROM liekan_warehouse_overview_snapshot
            WHERE id=ANY($1::uuid[]) AND next_attempt_at>now() AND error_code IS NULL
              AND result->'cards'->0->>'value'=$2`,
            [todayIds, String(requestCount)],
          ),
        ).toEqual([{ n: 2 }]);
        for (const _ of coldIds) await pumpWarehouseOverview();
        expect(attempts.splice(0)).toEqual(Array(2).fill(`ai/preference:${websiteId}`));
        expect(
          await db.read(
            `SELECT count(*)::int AS n FROM liekan_warehouse_overview_snapshot
            WHERE id=ANY($1::uuid[]) AND next_attempt_at>now()+interval '4 minutes'`,
            [coldIds],
          ),
        ).toEqual([{ n: 2 }]);
        await db.read(
          `UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '1 second'
           WHERE id=ANY($1::uuid[])`,
          [coldIds],
        );
      }
      harness.compute.mockImplementation(compute);
      // Resource deferral keeps the old valid result and retries as a schedule,
      // not a failed report. No query/data quota should turn it into a 503.
      await db.read(
        "UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()+interval '1 day'",
      );
      const [deferred] = await db.read<any>(
        `UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '1 second'
        WHERE id=(SELECT id FROM liekan_warehouse_overview_snapshot WHERE preset AND result IS NOT NULL
          AND website_id=$1 AND parameters->>'chartPeriod'='today' AND parameters->>'resource'='overview'
          AND parameters->>'timezone'=$2 ORDER BY id LIMIT 1)
        RETURNING id,md5(result::text) AS digest`,
        [websiteId, timezone],
      );
      const callsBeforeDeferral = harness.compute.mock.calls.length;
      harness.claimAfter.mockResolvedValueOnce(Date.now() + 2000);
      expect(await pumpWarehouseOverview()).toBe(false);
      expect(harness.compute).toHaveBeenCalledTimes(callsBeforeDeferral);
      expect(
        await db.read('SELECT lease_token FROM liekan_warehouse_overview_snapshot WHERE id=$1', [
          deferred.id,
        ]),
      ).toEqual([{ lease_token: null }]);
      harness.compute.mockRejectedValueOnce(new WarehouseBackgroundDeferred());
      await pumpWarehouseOverview();
      expect(harness.compute).toHaveBeenCalledTimes(callsBeforeDeferral + 1);
      expect(
        await db.read(
          `SELECT error_code,lease_token,md5(result::text) AS digest,next_attempt_at>now() AS delayed
        FROM liekan_warehouse_overview_snapshot WHERE id=$1`,
          [deferred.id],
        ),
      ).toEqual([{ error_code: null, lease_token: null, digest: deferred.digest, delayed: true }]);
      // Transient control-store contention also yields the background slot.
      // A real calculation failure below must still be reported as failed.
      for (const code of ['warehouse-control-busy', 'warehouse-control-unavailable']) {
        await db.read(
          "UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
          [deferred.id],
        );
        harness.compute.mockRejectedValueOnce(new WarehouseConflict(code));
        await pumpWarehouseOverview();
        expect(
          await db.read(
            `SELECT error_code,lease_token,md5(result::text) AS digest,next_attempt_at>now() AS delayed
            FROM liekan_warehouse_overview_snapshot WHERE id=$1`,
            [deferred.id],
          ),
          code,
        ).toEqual([
          { error_code: null, lease_token: null, digest: deferred.digest, delayed: true },
        ]);
      }
      // A preset discovered after freezing this site's members must wait
      // before taking a lease. Another site can continue in the meantime.
      const [late] = await db.read<{ id: string }>(
        `UPDATE liekan_warehouse_overview_snapshot SET control_version='',started_at=NULL,
          generated_at=NULL,result=NULL,next_attempt_at=now()-interval '10 minutes'
         WHERE id=(SELECT id FROM liekan_warehouse_overview_snapshot
           WHERE website_id=$1 AND id<>$2 AND parameters->>'timezone'=$3
           AND parameters->>'resource'='overview' AND parameters->>'chartPeriod'='7d' LIMIT 1)
         RETURNING id`,
        [websiteId, deferred.id, timezone],
      );
      await db.read(
        `UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '1 second'
         WHERE website_id=$1 AND parameters->>'timezone'=$2 AND parameters->>'resource'='overview'
           AND parameters->>'chartPeriod'='today'`,
        [otherSite, timezone],
      );
      await pumpWarehouseOverview();
      expect(harness.compute.mock.lastCall?.[0].id).toBe(otherSite);
      expect(
        await db.read('SELECT started_at FROM liekan_warehouse_overview_snapshot WHERE id=$1', [
          late.id,
        ]),
      ).toEqual([{ started_at: null }]);

      // Today's due time can land after this site's 30-day round froze.
      // Keep the old snapshots while the long job defers, then recover
      // today's and seven-day results even when the long job fails.
      await db.read('DELETE FROM liekan_warehouse_report_round');
      await db.read(
        "UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()+interval '1 day'",
      );
      const overlap = await db.read<{ id: string; site: string; period: string }>(
        `SELECT id, website_id AS site, parameters->>'chartPeriod' AS period
         FROM liekan_warehouse_overview_snapshot
         WHERE website_id=ANY($1::uuid[]) AND parameters->>'timezone'=$2
           AND parameters->>'resource'='overview'`,
        [[websiteId, otherSite], timezone],
      );
      const job = (site: string, period: string) =>
        overlap.find(row => row.site === site && row.period === period)!.id;
      const long = job(websiteId, '30d');
      const today = job(websiteId, 'today');
      const week = job(websiteId, '7d');
      const otherToday = job(otherSite, 'today');
      // Publish the seven-day row reset by the preceding discovery scenario.
      await db.read(
        "UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
        [week],
      );
      await pumpWarehouseOverview();
      const previousResults = await db.read<{ id: string; digest: string }>(
        `SELECT id,md5(result::text) AS digest FROM liekan_warehouse_overview_snapshot
         WHERE id=ANY($1::uuid[]) AND generated_at IS NOT NULL AND result IS NOT NULL ORDER BY id`,
        [[long, today, week]],
      );
      expect(previousResults).toHaveLength(3);
      const stages: string[] = [];
      let longAttempts = 0;
      const blocked = new Promise<void>(resolve => {
        release = resolve;
      });
      harness.compute.mockImplementation(async (site, params) => {
        stages.push(`${site.id}:${params.chartPeriod}`);
        if (site.id === websiteId && params.chartPeriod === '30d') {
          if (++longAttempts === 1) {
            await blocked;
            throw new WarehouseBackgroundDeferred();
          }
          throw new Error('controlled overlap failure');
        }
        const value = compute(site, params);
        value.cards[0].value = 456;
        return value;
      });
      await db.read(
        "UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
        [long],
      );
      running = pumpWarehouseOverview();
      await vi.waitFor(() => expect(longAttempts).toBe(1));
      await db.read(
        `UPDATE liekan_warehouse_overview_snapshot
         SET next_attempt_at=now()-CASE WHEN id=$2 THEN interval '10 seconds' ELSE interval '1 second' END
         WHERE id=ANY($1::uuid[])`,
        [[today, week, otherToday], today],
      );
      release();
      await running;
      expect(
        await db.read(
          `SELECT id,md5(result::text) AS digest FROM liekan_warehouse_overview_snapshot
           WHERE id=ANY($1::uuid[]) ORDER BY id`,
          [[long, today, week]],
        ),
      ).toEqual(previousResults);
      await pumpWarehouseOverview();
      expect(stages).toEqual([`${websiteId}:30d`, `${otherSite}:today`]);
      await db.read(
        "UPDATE liekan_warehouse_overview_snapshot SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
        [long],
      );
      for (let attempts = 0; attempts < 3; attempts++) await pumpWarehouseOverview();
      expect(stages.slice(0, 3)).toEqual([
        `${websiteId}:30d`,
        `${otherSite}:today`,
        `${websiteId}:30d`,
      ]);
      expect(stages.slice(3)).toEqual([`${websiteId}:today`, `${websiteId}:7d`]);
      expect(
        await db.read(
          `SELECT count(*)::int AS ready FROM liekan_warehouse_overview_snapshot WHERE id=ANY($1::uuid[])
          AND error_code IS NULL AND result->'cards'->0->>'value'='456'`,
          [[today, week, otherToday]],
        ),
      ).toEqual([{ ready: 3 }]);
      expect(
        await db.read(
          'SELECT error_code, result IS NOT NULL AS previous FROM liekan_warehouse_overview_snapshot WHERE id=$1',
          [long],
        ),
      ).toEqual([{ error_code: 'warehouse-overview-unavailable', previous: true }]);
      // First-generation failures must be failures, not endless preparing states.
      await db.read('DELETE FROM liekan_warehouse_overview_snapshot');
      harness.resources = ['overview'];
      harness.control = 'first-failure';
      clock.mockReturnValue(now + 4 * 86400000);
      harness.compute.mockRejectedValue(new Error('controlled fixture failure'));
      await drainWarehouseOverview(new AbortController().signal);
      const [failure] = await db.read<any>(
        'SELECT parameters,error_code,control_version FROM liekan_warehouse_overview_snapshot WHERE error_code IS NOT NULL',
      );
      expect(failure).toBeDefined();
      expect(failure.control_version).toContain('first-failure');
      await expect(
        requestWarehouseOverview(
          {
            ...access,
            website: {
              ...access.website,
              id: (
                await db.read<any>(
                  'SELECT website_id FROM liekan_warehouse_overview_snapshot WHERE error_code IS NOT NULL',
                )
              )[0].website_id,
            },
          },
          failure.parameters,
        ),
      ).rejects.toMatchObject({ status: 503 });

      // Retention must preserve the last good result, even after several failed days.
      const [failedRow] = await db.read<any>(
        'SELECT * FROM liekan_warehouse_overview_snapshot WHERE error_code IS NOT NULL AND website_id=$1 LIMIT 1',
        [websiteId],
      );
      const oldRange = {
        ...failedRow.parameters,
        startAt: now - 4 * 86400000,
        endAt: now - 3 * 86400000,
      };
      await db.read(
        `UPDATE liekan_warehouse_overview_snapshot SET query_key='fixture-last-good',
        parameters=$2,result=$3,publication=1,generated_at=now()-interval '2 days',
        last_requested_at=now()-interval '2 days',next_attempt_at=now()+interval '1 day',error_code=NULL WHERE id=$1`,
        [failedRow.id, oldRange, compute(undefined, oldRange)],
      );
      await pumpWarehouseOverview();
      expect(
        await db.read('SELECT id FROM liekan_warehouse_overview_snapshot WHERE id=$1', [
          failedRow.id,
        ]),
      ).toHaveLength(1);
      const retained = await requestWarehouseOverview(access, failedRow.parameters);
      expect(retained.status).toBe(200);
      expect((await retained.json()).meta.snapshot.fallback.sourceRange).toMatchObject({
        startAt: oldRange.startAt,
        endAt: oldRange.endAt,
      });
      // A newer successfully published result allows the superseded row to be reclaimed.
      await db.read(
        `INSERT INTO liekan_warehouse_overview_snapshot
        (id,website_id,query_key,parameters,catalog_version,format_version,preset,control_version,publication,result,generated_at,last_requested_at,next_attempt_at)
        SELECT gen_random_uuid(),website_id,'fixture-next-good',parameters,catalog_version,format_version,preset,control_version,publication,result,
          generated_at+interval '1 hour',last_requested_at,next_attempt_at FROM liekan_warehouse_overview_snapshot WHERE id=$1`,
        [failedRow.id],
      );
      await pumpWarehouseOverview();
      expect(
        await db.read('SELECT id FROM liekan_warehouse_overview_snapshot WHERE id=$1', [
          failedRow.id,
        ]),
      ).toHaveLength(0);
      expect(
        await db.read(
          "SELECT id FROM liekan_warehouse_overview_snapshot WHERE query_key='fixture-next-good'",
        ),
      ).toHaveLength(1);
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
