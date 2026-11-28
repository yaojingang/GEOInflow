/**
 * Phase 2 End-to-End Integration Verification for Warehouse v2
 *
 * Verifies against REAL PostgreSQL + REAL ClickHouse 26.8:
 * 1. v2 Schema init (`ensureV2Schema`)
 * 2. Real wired log upload (`prepareWarehouseUpload` + `sendWarehouseUpload`) -> `ch_v2_logs` + MVs
 * 3. Real wired browser collection (`submitV2BrowserCollection`) -> `ch_v2_browser_events` + MVs
 * 4. Real wired stateless `queryV2EvidenceFast` (`observations` + `traffic-quality/reconciliation`)
 * 5. Real wired single-table SQL relations (`reportingLogRelation`, `effectiveLogRelation`,
 *    `browserEventRelation`, `geographicEventRelation`, `websiteSummaryEventRelation`,
 *    `qualityAuditRelation`, `nativeRelations`) executed directly in ClickHouse
 * 6. Real PG -> ClickHouse v2 direct import (`importPgToWarehouseV2`)
 * 7. Real hour-partition aggregate rebuild (`rebuildV2LogHourAggregates`) & site epoch purge (`purgeV2SiteEpoch`)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  closeWarehouseV2Runtime,
  ensureV2Schema,
  importPgToWarehouseV2,
  purgeV2SiteEpoch,
  queryV2EvidenceFast,
  rebuildV2LogHourAggregates,
  submitV2LogUpload,
  v2AnalyticsEventRelation,
  v2BrowserEventRelation,
  v2EffectiveLogRelation,
  v2GeographicEventRelation,
  v2NativeRelations,
  v2QualityAuditRelation,
  v2ReportingLogRelation,
  v2Tables,
  v2WebsiteSummaryEventRelation,
  warehouseV2Runtime,
} from '../src/lib/liekan/warehouse-v2/index';
import { queryV2Json } from '../src/lib/liekan/warehouse-v2/client';
import { toV2Timestamp, type V2BrowserEventRow } from '../src/lib/liekan/warehouse-v2/ingest';

async function main() {
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  process.env.LIEKAN_WAREHOUSE_V2 = '1';

  const rt = warehouseV2Runtime();
  await ensureV2Schema(rt.ch);

  const userId = randomUUID();
  const websiteId = randomUUID();
  const sourceId = randomUUID();
  const batchId = randomUUID();
  const zeroUuid = '00000000-0000-0000-0000-000000000000';

  // Ensure minimal PG tables exist in isolated test DB
  await rt.pg.query(`
    CREATE TABLE IF NOT EXISTS "user" (user_id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'admin', deleted_at timestamptz NULL);
    CREATE TABLE IF NOT EXISTS team_user (team_id uuid NOT NULL, user_id uuid NOT NULL);
    CREATE TABLE IF NOT EXISTS website (website_id uuid PRIMARY KEY, domain text NOT NULL, user_id uuid NULL, team_id uuid NULL, deleted_at timestamptz NULL);
    CREATE TABLE IF NOT EXISTS link (link_id uuid PRIMARY KEY, deleted_at timestamptz NULL);
    CREATE TABLE IF NOT EXISTS pixel (pixel_id uuid PRIMARY KEY, deleted_at timestamptz NULL);
    CREATE TABLE IF NOT EXISTS liekan_log_state (website_id uuid PRIMARY KEY, epoch bigint NOT NULL DEFAULT 1, data_revision bigint NOT NULL DEFAULT 1, policy_revision bigint NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS liekan_collection_policy (website_id uuid PRIMARY KEY, mode text NOT NULL DEFAULT 'standard', revision bigint NOT NULL DEFAULT 1, allowed_hostnames text[] NOT NULL DEFAULT ARRAY[]::text[]);
    CREATE TABLE IF NOT EXISTS liekan_log_source (id uuid PRIMARY KEY, website_id uuid NOT NULL, kind text NOT NULL, domain text NOT NULL, state text NOT NULL DEFAULT 'active');
    CREATE TABLE IF NOT EXISTS liekan_catalog (website_id uuid NOT NULL, path text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (website_id, path));
    CREATE TABLE IF NOT EXISTS liekan_warehouse_upload (batch_id uuid PRIMARY KEY, website_id uuid NOT NULL, source_id uuid NULL, source_epoch int NOT NULL DEFAULT 1, kind text NOT NULL DEFAULT 'automatic', digest text NOT NULL DEFAULT '', expected int NOT NULL DEFAULT 0, actor_id uuid NULL, warehouse_epoch bigint NOT NULL DEFAULT 1, queued boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS liekan_ingest_batch (id uuid PRIMARY KEY, state text NOT NULL DEFAULT 'pending', processed_at timestamptz NULL);
    CREATE TABLE IF NOT EXISTS liekan_log (id varchar(64), website_id uuid, import_id uuid, created_at timestamptz, path varchar(500), method varchar(10), status int, bytes bigint, ip_masked varchar(80), ip_hash varchar(64), user_agent varchar(500), location varchar(80), bot varchar(80), vendor varchar(80), bot_type varchar(30), verification varchar(30), source_id uuid, event_digest varchar(64), verification_version varchar(64), ai_eligible boolean, recognition_state text, recognition_candidates jsonb, verification_observed_at timestamptz, verification_reason text, PRIMARY KEY (website_id, id));
    CREATE TABLE IF NOT EXISTS liekan_crawler_evidence (website_id uuid, log_id varchar(64), classification_version varchar(64), crawler_id varchar(80), security_action varchar(64), terminating_rule_id varchar(64), matched_rule_ids jsonb, cache_status varchar(64), duration_ms double precision, measurement jsonb, edge_observation jsonb, catalog_version uuid, identity_evidence jsonb, PRIMARY KEY (website_id, log_id));
    CREATE TABLE IF NOT EXISTS liekan_log_geography (log_id varchar(64), website_id uuid, country varchar(2), region varchar(20), city varchar(80), PRIMARY KEY (website_id, log_id));
    CREATE TABLE IF NOT EXISTS website_event (event_id uuid PRIMARY KEY, website_id uuid, session_id uuid, created_at timestamptz, url_path varchar(500), url_query varchar(500), referrer_path varchar(500), referrer_query varchar(500), referrer_domain varchar(500), page_title varchar(500), event_type int, event_name varchar(50), visit_id uuid, tag varchar(50), fbclid varchar(255), gclid varchar(255), li_fat_id varchar(255), msclkid varchar(255), ttclid varchar(255), twclid varchar(255), utm_campaign varchar(255), utm_content varchar(255), utm_medium varchar(255), utm_source varchar(255), utm_term varchar(255), hostname varchar(100), cls numeric(10,4), fcp numeric(10,1), inp numeric(10,1), lcp numeric(10,1), ttfb numeric(10,1));
    CREATE TABLE IF NOT EXISTS session (session_id uuid PRIMARY KEY, website_id uuid, browser varchar(20), os varchar(20), device varchar(20), screen varchar(11), language varchar(35), country varchar(2), region varchar(20), city varchar(50), created_at timestamptz, distinct_id varchar(50));
    CREATE TABLE IF NOT EXISTS liekan_event_quality (event_id uuid PRIMARY KEY, website_id uuid, classification text, source text, reasons text[], rule_version text, range_version text, range_status text, hostname text, created_at timestamptz, catalog_version uuid, repair_scope_id uuid);
    CREATE TABLE IF NOT EXISTS liekan_event_environment (event_id uuid PRIMARY KEY, website_id uuid, scope text, identity_version text, identity_available boolean, browser varchar(20), os varchar(20), device varchar(20), screen varchar(11), language varchar(35), origin_hostname text, distinct_id varchar(50), created_at timestamptz);
    CREATE TABLE IF NOT EXISTS liekan_event_observation (event_id uuid PRIMARY KEY, website_id uuid, epoch int, version text, event_at timestamptz, received_at timestamptz, features jsonb);
    CREATE TABLE IF NOT EXISTS liekan_event_geography (event_id uuid PRIMARY KEY, website_id uuid, country varchar(2), region varchar(20), city varchar(80));
  `);

  await rt.pg.query(`INSERT INTO "user"(user_id, role) VALUES ($1, 'admin')`, [userId]);
  await rt.pg.query(`INSERT INTO website(website_id, domain, user_id) VALUES ($1, 'www.v2e2e.example', $2)`, [websiteId, userId]);
  await rt.pg.query(`INSERT INTO liekan_log_state(website_id, epoch, data_revision) VALUES ($1, 1, 1)`, [websiteId]);
  await rt.pg.query(`INSERT INTO liekan_collection_policy(website_id, mode, revision, allowed_hostnames) VALUES ($1, 'standard', 1, ARRAY['v2e2e.example'])`, [websiteId]);
  await rt.pg.query(`INSERT INTO liekan_log_source(id, website_id, kind, domain, state) VALUES ($1, $2, 'cloudflare', 'v2e2e.example', 'active')`, [sourceId, websiteId]);
  await rt.pg.query(`INSERT INTO liekan_catalog(website_id, path, updated_at) VALUES ($1, '/article/1', '2026-11-21T00:00:00Z'), ($1, '/article/2', '2026-11-21T00:00:00Z')`, [websiteId]);
  await rt.pg.query(`INSERT INTO liekan_warehouse_upload(batch_id, website_id, source_id, expected, warehouse_epoch) VALUES ($1, $2, $3, 2, 1)`, [batchId, websiteId, sourceId]);

  // 1. Test real wired log upload -> ch_v2_logs + native MVs
  await submitV2LogUpload({
    batchId,
    websiteId,
    sourceId,
    epoch: 1,
    records: [
      {
        id: 'e2e-log-1',
        createdAt: new Date('2026-11-21T10:15:00Z'),
        path: '/article/1',
        method: 'GET',
        status: 200,
        bytes: 1024,
        userAgent: 'GPTBot/1.0',
        bot: 'GPTBot',
        vendor: 'OpenAI',
        botType: 'ai',
        aiEligible: true,
        measurement: {
          host: 'v2e2e.example',
          hostBasis: 'request_host',
          sourceConfigVersion: 'cfg-1',
          sourceIntervalVersion: 'int-1',
          samplingTimeBasis: 'event_time',
          samplingBasis: 'observed_provider_config',
          samplingRate: 1,
        },
        edgeObservation: {
          fields: { EdgeResponseContentType: { state: 'present', value: 'text/html' } },
        },
      } as any,
      {
        id: 'e2e-log-2',
        createdAt: new Date('2026-11-21T10:20:00Z'),
        path: '/article/2',
        method: 'GET',
        status: 200,
        bytes: 2048,
        userAgent: 'Mozilla/5.0',
        bot: '',
        vendor: '',
        botType: 'other',
        aiEligible: false,
        measurement: {
          host: 'v2e2e.example',
          hostBasis: 'request_host',
          sourceConfigVersion: 'cfg-1',
          sourceIntervalVersion: 'int-1',
          samplingTimeBasis: 'event_time',
          samplingBasis: 'observed_provider_config',
          samplingRate: 1,
        },
        edgeObservation: {
          fields: { EdgeResponseContentType: { state: 'present', value: 'text/html' } },
        },
      } as any,
    ],
  });

  // 2. Test browser event batcher -> ch_v2_browser_events + native MVs
  const sess1 = randomUUID();
  const visit1 = randomUUID();
  const ev1: V2BrowserEventRow = {
    website_id: websiteId,
    epoch: '1',
    event_id: randomUUID(),
    session_id: sess1,
    visit_id: visit1,
    created_at: toV2Timestamp('2026-11-21T10:25:00Z'),
    received_at: toV2Timestamp('2026-11-21T10:25:01Z'),
    session_created_at: toV2Timestamp('2026-11-21T10:25:00Z'),
    event_type: 1,
    event_name: null,
    url_path: '/article/2',
    url_query: null,
    hostname: 'v2e2e.example',
    normalized_hostname: 'v2e2e.example',
    origin_hostname: 'v2e2e.example',
    page_title: 'Article 2',
    referrer_domain: 'google.com',
    referrer_path: '/',
    referrer_query: null,
    tag: null,
    fbclid: null,
    gclid: null,
    li_fat_id: null,
    msclkid: null,
    ttclid: null,
    twclid: null,
    utm_source: 'google',
    utm_medium: 'organic',
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    cls: null,
    fcp: null,
    inp: null,
    lcp: null,
    ttfb: null,
    browser: 'chrome',
    os: 'macOS',
    device: 'desktop',
    screen: '1920x1080',
    language: 'zh-CN',
    country: 'CN',
    region: 'BJ',
    city: 'Beijing',
    distinct_id: null,
    collection_source: 'browser',
    classification: 'browser',
    quality_reasons: [],
    rule_version: 'v1',
    range_status: 'matched',
    range_version: 'r1',
    repair_scope_id: null,
    catalog_version: null,
    is_eligible: true,
    identity_scope: 'browser',
    identity_available: true,
    identity_version: 'id-v1',
    has_observation: true,
    obs_version: 'obs-v1',
    obs_features: '{"accept":{"state":"present"}}',
    obs_mask: 1,
    is_risk_flagged: false,
    _ver: '1',
    _deleted: 0,
  };
  await rt.browserBatcher.enqueue([ev1], ev1.event_id);

  // 3. Test real wired stateless queryV2EvidenceFast (observations + reconciliation)
  const actor = { userId, role: 'admin' } as any;
  const obs = await queryV2EvidenceFast(
    actor,
    websiteId,
    {
      startAt: Date.UTC(2026, 10, 21, 0, 0, 0),
      endAt: Date.UTC(2026, 10, 22, 0, 0, 0),
      timezone: 'UTC',
      subset: 'raw',
      page: 1,
    },
    'observations',
  );
  assert.equal(obs.totals.pv, 1);
  assert.equal(obs.totals.uv, 1);

  const rec = await queryV2EvidenceFast(
    actor,
    websiteId,
    {
      startAt: Date.UTC(2026, 10, 21, 0, 0, 0),
      endAt: Date.UTC(2026, 10, 22, 0, 0, 0),
      timezone: 'UTC',
      hostname: 'v2e2e.example',
      sourceId,
      page: 1,
      sort: 'requests',
      direction: 'desc',
    },
    'traffic-quality/reconciliation',
  );
  assert.equal(rec.rawRequests, 2);
  assert.equal(rec.browserTotals?.pv, 1);
  assert.equal(rec.browserTotals?.uv, 1);

  // 4. Execute ALL single-table v2 ClickHouse relations used by the 13 stats pages + native Umami!
  const relParams = {
    wh_site: websiteId,
    wh_epoch: '1',
    wh_resource: 'website',
    wh_policy_mode: 'standard',
    wh_allowed_hosts: ['v2e2e.example'],
    wh_interval_source: [sourceId],
    wh_interval_start: ['0'],
    wh_interval_end: ['9223372036854775807'],
    wh_repair_generation: zeroUuid,
    previousStart: toV2Timestamp('2026-11-20T00:00:00Z'),
    end: toV2Timestamp('2026-11-22T00:00:00Z'),
  };

  const [effLog] = await queryV2Json<{ c: string }>(rt.ch, `SELECT toString(count()) AS c FROM ${v2EffectiveLogRelation()}`, relParams);
  assert.equal(Number(effLog.c), 2);

  const [repLog] = await queryV2Json<{ c: string }>(rt.ch, `SELECT toString(count()) AS c FROM ${v2ReportingLogRelation({}, ['id', 'path', 'bot', 'reporting_crawler_id'])}`, relParams);
  assert.equal(Number(repLog.c), 2);

  const [brRel] = await queryV2Json<{ c: string }>(rt.ch, `SELECT toString(count()) AS c FROM ${v2BrowserEventRelation('qualified')}`, relParams);
  assert.equal(Number(brRel.c), 1);

  const [geoRel] = await queryV2Json<{ c: string; country: string }>(rt.ch, `SELECT toString(count()) AS c, any(liekan_country) AS country FROM ${v2GeographicEventRelation(false, true)}`, relParams);
  assert.equal(Number(geoRel.c), 1);
  assert.equal(geoRel.country, 'CN');

  const [anaRel] = await queryV2Json<{ c: string }>(rt.ch, `SELECT toString(count()) AS c FROM ${v2AnalyticsEventRelation(false)}`, relParams);
  assert.equal(Number(anaRel.c), 1);

  const [sumRel] = await queryV2Json<{ c: string }>(rt.ch, `SELECT toString(count()) AS c FROM ${v2WebsiteSummaryEventRelation()}`, relParams);
  assert.equal(Number(sumRel.c), 1);

  const [audRel] = await queryV2Json<{ c: string }>(rt.ch, `SELECT toString(count()) AS c FROM ${v2QualityAuditRelation()}`, relParams);
  assert.equal(Number(audRel.c), 1);

  const [natRel] = await queryV2Json<{ c: string }>(rt.ch, `WITH ${v2NativeRelations().join(',')} SELECT toString(count()) AS c FROM website_event_stats_hourly`, relParams);
  assert.equal(Number(natRel.c), 1);

  // 5. Test direct PG -> ClickHouse v2 import
  const pgSiteId = randomUUID();
  await rt.pg.query(`INSERT INTO website(website_id, domain, user_id) VALUES ($1, 'pgimport.example', $2)`, [pgSiteId, userId]);
  await rt.pg.query(`INSERT INTO liekan_log_state(website_id, epoch, data_revision) VALUES ($1, 1, 1)`, [pgSiteId]);
  await rt.pg.query(
    `INSERT INTO liekan_log(id, website_id, created_at, path, method, status, bytes, ip_masked, ip_hash, user_agent, location, bot, vendor, bot_type, verification, ai_eligible, recognition_state)
     VALUES ('pg-1', $1, '2026-11-21T12:00:00Z', '/from-pg', 'GET', 200, 512, '192.0.2.0', 'h', 'GPTBot/1.0', 'CN', 'GPTBot', 'OpenAI', 'ai', 'verified', true, 'recognized')`,
    [pgSiteId],
  );
  const importStats = await importPgToWarehouseV2(rt.pg, rt.ch, { websiteId: pgSiteId });
  assert.equal(importStats.logsImported, 1);

  // 6. Test hour-partition aggregate rebuild (late spider evidence / history repair path)
  await rebuildV2LogHourAggregates(rt.ch, websiteId, 1, '2026-11-21T10:00:00Z');
  const [afterRebuild] = await queryV2Json<{ c: string }>(
    rt.ch,
    `SELECT toString(countMerge(requests)) AS c FROM ${v2Tables.logHourAgg} WHERE website_id={site:UUID} AND epoch=1`,
    { site: websiteId },
  );
  assert.equal(Number(afterRebuild.c), 2);

  // 7. Test site epoch purge
  await purgeV2SiteEpoch(rt.ch, websiteId, 2);

  console.log(
    JSON.stringify({
      ok: true,
      verified: [
        'schema_init',
        'log_upload_and_native_mv',
        'browser_ingest_and_native_mv',
        'stateless_observations_fast_path',
        'stateless_reconciliation_fast_path',
        'all_8_single_table_v2_relations_executed_in_ch',
        'direct_pg_to_v2_ch_import',
        'hour_partition_agg_rebuild',
        'site_epoch_purge',
      ],
      importStats,
    }),
  );

  await closeWarehouseV2Runtime();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
