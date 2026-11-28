/**
 * Official Bundled Demo Seeder for Warehouse v2 ("猎看官网（示例数据）" / www.liekan.com)
 *
 * Preserves all AGENTS.md and docs/default-demo.md invariants:
 * - Verifies manifest + official.ndjson.gz + catalog.json SHA-256 hashes before touching state
 * - Respects customized websites, deleted markers (website.deleted_at or liekan_analytics_revision),
 *   cleared demos, existing installations (when --automatic), and missing administrators
 * - Writes PostgreSQL control metadata and streams all sanitized telemetry facts directly into
 *   ch_v2_logs, ch_v2_browser_events, and detail tables (auto-populating all 4 native MVs)
 * - Zero liekan_warehouse_migration / MigrationPages / SHA-256 post-write readback ceremony
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { ClickHouseClient } from '@clickhouse/client';
import type pg from 'pg';
import { ensureV2Schema, insertV2Rows, queryV2Json } from './client';
import {
  buildV2LogRow,
  computeObservationMask,
  normalizeHost,
  toV2Timestamp,
  type V2BrowserEventRow,
  type V2LogRow,
} from './ingest';
import { v2Tables } from './schema';

export type V2DemoSeedResult = {
  websiteId: string;
  name?: string;
  demo?: boolean;
  status:
    | 'created'
    | 'existing'
    | 'deleted'
    | 'cleared'
    | 'customized'
    | 'existing-installation'
    | 'no-administrator'
    | 'incompatible-catalog';
  inserted: boolean;
  counts?: Record<string, number>;
  chCounts?: {
    logs: number;
    browserEvents: number;
    eventData: number;
    revenue: number;
    heatmap: number;
    replay: number;
    sessionData: number;
  };
};

const CH_FACT_KINDS = new Set([
  'session',
  'session-source',
  'event',
  'quality',
  'environment',
  'geography',
  'session-data',
  'event-data',
  'revenue',
  'heatmap',
  'replay',
  'log',
  'evidence',
]);

async function loadDemoModules() {
  const root = process.cwd();
  const demoUrl = pathToFileURL(path.join(root, 'scripts/liekan-demo.mjs')).href;
  const formatUrl = pathToFileURL(path.join(root, 'scripts/liekan-demo-format.mjs')).href;
  const [fixture, format] = await Promise.all([
    import(/* webpackIgnore: true */ demoUrl),
    import(/* webpackIgnore: true */ formatUrl),
  ]);
  return { fixture, format };
}

export async function seedV2OfficialDemo(
  pgPool: pg.Pool,
  ch: ClickHouseClient,
  options: {
    secret: string;
    now?: number;
    schema?: string;
    automatic?: boolean;
  },
): Promise<V2DemoSeedResult> {
  const { secret, now = Date.now(), schema = 'public', automatic = false } = options;
  const { fixture, format } = await loadDemoModules();
  if (!secret) throw new fixture.DemoSeedError('缺少 APP_SECRET');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema))
    throw new fixture.DemoSeedError('数据库 schema 无效');

  const manifest = await fixture.readDemoManifest();
  const site: string = fixture.DEFAULT_DEMO_ID;
  const anchor = now - 300_000;
  await ensureV2Schema(ch);

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['liekan-default-demo']);

    const existing = (
      await client.query<{
        name: string;
        domain: string;
        deleted_at: Date | null;
        is_demo: boolean | null;
      }>(
        'SELECT w.name, w.domain, w.deleted_at, s.is_demo FROM website w LEFT JOIN liekan_setting s USING(website_id) WHERE w.website_id=$1::uuid FOR UPDATE OF w',
        [site],
      )
    ).rows[0];

    if (
      existing &&
      (existing.is_demo !== true ||
        existing.name !== fixture.DEFAULT_DEMO_NAME ||
        existing.domain !== fixture.DEFAULT_DEMO_DOMAIN)
    ) {
      if (automatic) {
        await client.query('COMMIT');
        return { websiteId: site, status: 'customized', inserted: false };
      }
      throw new fixture.DemoSeedError('默认示例 ID 已被其他网站使用，现有数据保持完整');
    }

    if (existing?.deleted_at) {
      await client.query('COMMIT');
      return { websiteId: site, status: 'deleted', inserted: false };
    }

    const previous = (
      await client.query<{ previously_created: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM liekan_analytics_revision WHERE resource_type='website' AND resource_id=$1::uuid) AS previously_created",
        [site],
      )
    ).rows[0].previously_created;

    if (!existing) {
      if (previous) {
        await client.query('COMMIT');
        return { websiteId: site, status: 'deleted', inserted: false };
      }
      if (automatic) {
        const inst = (
          await client.query<{ existing_installation: boolean }>(
            'SELECT EXISTS(SELECT 1 FROM website WHERE website_id<>$1::uuid) AS existing_installation',
            [site],
          )
        ).rows[0];
        if (inst.existing_installation) {
          await client.query('COMMIT');
          return { websiteId: site, status: 'existing-installation', inserted: false };
        }
      }
    } else {
      // Check if facts already exist in ClickHouse v2 (at current epoch) or PG
      const stateRow = (
        await client.query<{ epoch: string }>(
          'SELECT epoch::text FROM liekan_log_state WHERE website_id=$1::uuid',
          [site],
        )
      ).rows[0];
      const currentEpoch = stateRow?.epoch ?? '1';
      const [chHasLogs, chHasEvents] = await Promise.all([
        queryV2Json<{ n: string }>(
          ch,
          `SELECT toString(count()) AS n FROM ${v2Tables.logs} WHERE website_id = {site:UUID} AND epoch = {epoch:UInt64} LIMIT 1`,
          { site, epoch: currentEpoch },
        ),
        queryV2Json<{ n: string }>(
          ch,
          `SELECT toString(count()) AS n FROM ${v2Tables.browserEvents} WHERE website_id = {site:UUID} AND epoch = {epoch:UInt64} LIMIT 1`,
          { site, epoch: currentEpoch },
        ),
      ]);
      const occupiedInCh = Number(chHasLogs[0]?.n ?? 0) > 0 || Number(chHasEvents[0]?.n ?? 0) > 0;
      if (occupiedInCh) {
        await client.query('COMMIT');
        return { websiteId: site, status: 'existing', inserted: false };
      }
      if (previous) {
        await client.query('COMMIT');
        return { websiteId: site, status: 'cleared', inserted: false };
      }
    }

    const admin = (
      await client.query<{ id: string }>(
        `SELECT user_id AS id FROM "user" WHERE role='admin' AND deleted_at IS NULL ORDER BY created_at, user_id LIMIT 1`,
      )
    ).rows[0];
    if (!admin) {
      if (automatic) {
        await client.query('COMMIT');
        return { websiteId: site, status: 'no-administrator', inserted: false };
      }
      throw new fixture.DemoSeedError('初始化示例需要已有管理员，请先完成数据库迁移');
    }

    const catalogVersion: string | null = await fixture.bindDemoCatalog(client, manifest);
    if (!catalogVersion) {
      await client.query('COMMIT');
      return { websiteId: site, status: 'incompatible-catalog', inserted: false };
    }

    if (!existing) {
      await client.query(
        'INSERT INTO website(website_id, name, domain, user_id, created_by, created_at, updated_at) VALUES($1::uuid, $2, $3, $4::uuid, $4::uuid, now(), now())',
        [site, fixture.DEFAULT_DEMO_NAME, fixture.DEFAULT_DEMO_DOMAIN, admin.id],
      );
    }
    await client.query(
      'INSERT INTO liekan_setting(website_id, is_demo, rules) VALUES($1::uuid, true, $2::jsonb) ON CONFLICT(website_id) DO UPDATE SET is_demo=true, rules=EXCLUDED.rules',
      [site, JSON.stringify(manifest.rules)],
    );

    const stateRow = (
      await client.query<{ epoch: string }>(
        'INSERT INTO liekan_log_state(website_id, epoch, data_revision) VALUES($1::uuid, 1, 1) ON CONFLICT(website_id) DO UPDATE SET data_revision = liekan_log_state.data_revision + 1, updated_at = now() RETURNING epoch::text',
        [site],
      )
    ).rows[0];
    const epoch = stateRow.epoch;

    // Stream official.ndjson.gz: PG metadata goes directly into PG; facts are flattened for CH v2
    const counts: Record<string, number> = Object.fromEntries(
      format.demoKinds.map((k: string) => [k, 0]),
    );
    let sawMetadata = false;
    let pgKind: string | undefined;
    let pgBatch: Record<string, any>[] = [];

    const sessions = new Map<string, Record<string, any>>();
    const sessionSources = new Map<string, Record<string, any>>();
    const events: Record<string, any>[] = [];
    const qualities = new Map<string, Record<string, any>>();
    const environments = new Map<string, Record<string, any>>();
    const geographies = new Map<string, Record<string, any>>();
    const logs: Record<string, any>[] = [];
    const evidences = new Map<string, Record<string, any>>();
    const eventDataRows: Record<string, any>[] = [];
    const revenueRows: Record<string, any>[] = [];
    const heatmapRows: Record<string, any>[] = [];
    const replayRows: Record<string, any>[] = [];
    const sessionDataRows: Record<string, any>[] = [];

    const flushPg = async () => {
      if (!pgBatch.length || !pgKind) return;
      await format.insertDemoBatch(client, pgKind, pgBatch, { resume: true });
      pgBatch = [];
    };

    for await (const record of fixture.readDemoRecords()) {
      const kind: string = record[0];
      if (kind === 'metadata') {
        if (sawMetadata || record[1].websiteId !== site || record[1].isDemo !== true) {
          throw new fixture.DemoSeedError('默认示例数据头无效');
        }
        sawMetadata = true;
        continue;
      }
      if (!sawMetadata || !Object.hasOwn(counts, kind)) {
        throw new fixture.DemoSeedError('默认示例记录类型无效');
      }
      format.validateDemoRow(kind, record[1], manifest);
      const row = format.materializeDemoRow(kind, record[1], counts[kind], anchor, secret, admin.id);
      if (row.catalog_version) row.catalog_version = catalogVersion;
      counts[kind] += 1;

      if (!CH_FACT_KINDS.has(kind)) {
        if (pgKind !== kind) await flushPg();
        pgKind = kind;
        pgBatch.push(row);
        if (pgBatch.length >= 1000) await flushPg();
        continue;
      }

      switch (kind) {
        case 'session':
          sessions.set(row.session_id, row);
          break;
        case 'session-source':
          sessionSources.set(row.session_id, row);
          break;
        case 'event':
          events.push(row);
          break;
        case 'quality':
          qualities.set(row.event_id, row);
          break;
        case 'environment':
          environments.set(row.event_id, row);
          break;
        case 'geography':
          geographies.set(row.event_id, row);
          break;
        case 'log':
          logs.push(row);
          break;
        case 'evidence':
          evidences.set(row.log_id, row);
          break;
        case 'event-data':
          eventDataRows.push(row);
          break;
        case 'revenue':
          revenueRows.push(row);
          break;
        case 'heatmap':
          heatmapRows.push(row);
          break;
        case 'replay':
          replayRows.push(row);
          break;
        case 'session-data':
          sessionDataRows.push(row);
          break;
      }
    }
    await flushPg();

    if (!sawMetadata || format.demoKinds.some((k: string) => counts[k] !== manifest.counts[k])) {
      throw new fixture.DemoSeedError('默认示例记录数量与清单不一致');
    }

    // Materialize flattened CH v2 log rows
    const v2Logs: V2LogRow[] = logs.map(r => {
      const ev = evidences.get(r.id);
      return buildV2LogRow({
        websiteId: site,
        epoch,
        id: r.id,
        importId: r.import_id,
        sourceId: r.source_id ?? null,
        createdAt: r.created_at,
        path: r.path,
        method: r.method,
        status: Number(r.status),
        bytes: r.bytes ?? 0,
        ipMasked: r.ip_masked ?? '',
        ipHash: r.ip_hash ?? '',
        userAgent: r.user_agent ?? '',
        location: r.location ?? '',
        bot: r.bot ?? '',
        vendor: r.vendor ?? '',
        botType: r.bot_type ?? '',
        verification: r.verification ?? '',
        verificationVersion: r.verification_version ?? null,
        verificationReason: r.verification_reason ?? null,
        verificationObservedAt: r.verification_observed_at ?? null,
        aiEligible: Boolean(r.ai_eligible),
        recognitionState: r.recognition_state ?? 'recognized',
        crawlerId: ev?.crawler_id ?? null,
        classificationVersion: ev?.classification_version ?? null,
        catalogVersion: ev?.catalog_version ?? catalogVersion,
        cacheStatus: ev?.cache_status ?? null,
        durationMs: ev?.duration_ms != null ? Number(ev.duration_ms) : null,
        identityEvidence: ev?.identity_evidence ? JSON.stringify(ev.identity_evidence) : null,
        measurement: ev?.measurement ?? null,
        edgeObservation: ev?.edge_observation ?? null,
        version: 1,
      });
    });

    // Materialize flattened CH v2 browser event rows
    const v2BrowserEvents: V2BrowserEventRow[] = events.map(e => {
      const s = sessions.get(e.session_id);
      const ss = sessionSources.get(e.session_id);
      const q = qualities.get(e.event_id);
      const env = environments.get(e.event_id);
      const g = geographies.get(e.event_id);
      const reasons: string[] = Array.isArray(q?.reasons) ? q.reasons : [];
      const source = String(q?.source ?? ss?.source ?? 'browser');
      const classification = String(q?.classification ?? 'browser');
      const identityScope = String(env?.scope ?? ss?.scope ?? 'browser');
      const identityAvailable = Boolean(env?.identity_available ?? ss?.identity_available ?? true);
      const isEligible =
        source === 'browser' &&
        classification === 'browser' &&
        identityScope === 'browser' &&
        identityAvailable &&
        !reasons.includes('bot_check_disabled');
      const createdAt = toV2Timestamp(e.created_at);
      const host = normalizeHost(q?.hostname ?? e.hostname ?? fixture.DEFAULT_DEMO_DOMAIN);
      return {
        website_id: site,
        epoch,
        event_id: e.event_id,
        session_id: e.session_id,
        visit_id: e.visit_id,
        created_at: createdAt,
        received_at: toV2Timestamp(q?.created_at ?? e.created_at),
        session_created_at: toV2Timestamp(s?.created_at ?? e.created_at),
        event_type: Number(e.event_type ?? 1),
        event_name: e.event_name ?? null,
        url_path: e.url_path ?? '/',
        url_query: e.url_query ?? null,
        hostname: host,
        normalized_hostname: host || null,
        origin_hostname: env?.origin_hostname ? normalizeHost(env.origin_hostname) : host || null,
        page_title: e.page_title ?? null,
        referrer_domain: e.referrer_domain ?? null,
        referrer_path: e.referrer_path ?? null,
        referrer_query: e.referrer_query ?? null,
        tag: e.tag ?? null,
        fbclid: null,
        gclid: null,
        li_fat_id: null,
        msclkid: null,
        ttclid: null,
        twclid: null,
        utm_source: e.utm_source ?? null,
        utm_medium: e.utm_medium ?? null,
        utm_campaign: e.utm_campaign ?? null,
        utm_content: e.utm_content ?? null,
        utm_term: e.utm_term ?? null,
        cls: e.cls != null ? String(e.cls) : null,
        fcp: e.fcp != null ? String(e.fcp) : null,
        inp: e.inp != null ? String(e.inp) : null,
        lcp: e.lcp != null ? String(e.lcp) : null,
        ttfb: e.ttfb != null ? String(e.ttfb) : null,
        browser: String(env?.browser ?? s?.browser ?? 'unknown'),
        os: env?.os ?? s?.os ?? null,
        device: env?.device ?? s?.device ?? null,
        screen: env?.screen ?? s?.screen ?? null,
        language: env?.language ?? s?.language ?? null,
        country: g?.country ?? s?.country ?? null,
        region: g?.region ?? s?.region ?? null,
        city: g?.city ?? s?.city ?? null,
        distinct_id: null,
        collection_source: source,
        classification,
        quality_reasons: reasons,
        rule_version: String(q?.rule_version ?? 'demo'),
        range_status: String(q?.range_status ?? 'unknown'),
        range_version: null,
        repair_scope_id: null,
        catalog_version: q?.catalog_version ?? catalogVersion,
        is_eligible: isEligible,
        identity_scope: identityScope,
        identity_available: identityAvailable,
        identity_version: String(env?.identity_version ?? ss?.identity_version ?? '1'),
        has_observation: false,
        obs_version: 'not_collected',
        obs_features: '',
        obs_mask: computeObservationMask(null),
        is_risk_flagged: false,
        _ver: '1',
        _deleted: 0,
      };
    });

    // Insert all fact batches directly into ClickHouse v2 (native MVs auto-populate!)
    const insertChunked = async <T extends Record<string, unknown>>(
      table: string,
      rows: T[],
      chunk = 5000,
    ) => {
      for (let i = 0; i < rows.length; i += chunk) {
        await insertV2Rows(ch, table, rows.slice(i, i + chunk));
      }
    };

    await insertChunked(v2Tables.logs, v2Logs);
    await insertChunked(v2Tables.browserEvents, v2BrowserEvents);

    if (eventDataRows.length) {
      await insertChunked(
        v2Tables.eventData,
        eventDataRows.map(r => ({
          website_id: site,
          epoch,
          event_data_id: r.event_data_id,
          website_event_id: r.website_event_id,
          data_key: r.data_key,
          string_value: r.string_value ?? null,
          number_value: r.number_value != null ? String(r.number_value) : null,
          date_value: r.date_value ? toV2Timestamp(r.date_value) : null,
          data_type: Number(r.data_type ?? 1),
          created_at: toV2Timestamp(r.created_at),
          _ver: '1',
        })),
      );
    }

    if (revenueRows.length) {
      await insertChunked(
        v2Tables.revenue,
        revenueRows.map(r => ({
          website_id: site,
          epoch,
          revenue_id: r.revenue_id,
          session_id: r.session_id,
          event_id: r.event_id,
          event_name: r.event_name,
          currency: r.currency,
          revenue: String(r.revenue),
          created_at: toV2Timestamp(r.created_at),
          _ver: '1',
        })),
      );
    }

    if (heatmapRows.length) {
      await insertChunked(
        v2Tables.heatmap,
        heatmapRows.map(r => ({
          website_id: site,
          epoch,
          heatmap_event_id: r.heatmap_event_id,
          session_id: r.session_id,
          visit_id: r.visit_id,
          url_path: r.url_path,
          event_type: Number(r.event_type ?? 1),
          x: r.x != null ? Number(r.x) : null,
          y: r.y != null ? Number(r.y) : null,
          page_x: r.page_x != null ? Number(r.page_x) : null,
          page_y: r.page_y != null ? Number(r.page_y) : null,
          page_w: r.page_w != null ? Number(r.page_w) : null,
          viewport_w: r.viewport_w != null ? Number(r.viewport_w) : null,
          viewport_h: r.viewport_h != null ? Number(r.viewport_h) : null,
          page_h: r.page_h != null ? Number(r.page_h) : null,
          scroll_pct: r.scroll_pct != null ? Number(r.scroll_pct) : null,
          created_at: toV2Timestamp(r.created_at),
          _ver: '1',
        })),
      );
    }

    if (replayRows.length) {
      await insertChunked(
        v2Tables.sessionReplay,
        replayRows.map(r => ({
          website_id: site,
          epoch,
          replay_id: r.replay_id,
          session_id: r.session_id,
          visit_id: r.visit_id,
          chunk_index: Number(r.chunk_index ?? 0),
          events:
            typeof r.events === 'string' && r.events.startsWith('\\x')
              ? r.events.slice(2)
              : Buffer.from(String(r.events ?? ''), 'utf8').toString('hex'),
          event_count: Number(r.event_count ?? 0),
          started_at: toV2Timestamp(r.started_at),
          ended_at: toV2Timestamp(r.ended_at),
          created_at: toV2Timestamp(r.created_at),
          _ver: '1',
        })),
      );
    }

    if (sessionDataRows.length) {
      await insertChunked(
        v2Tables.sessionData,
        sessionDataRows.map(r => ({
          website_id: site,
          epoch,
          session_data_id: r.session_data_id,
          session_id: r.session_id,
          data_key: r.data_key,
          string_value: r.string_value ?? null,
          number_value: r.number_value != null ? String(r.number_value) : null,
          date_value: r.date_value ? toV2Timestamp(r.date_value) : null,
          data_type: Number(r.data_type ?? 1),
          created_at: toV2Timestamp(r.created_at),
          _ver: '1',
        })),
      );
    }

    await client.query(
      "INSERT INTO liekan_analytics_revision(resource_type, resource_id, revision) VALUES('website', $1::uuid, 1) ON CONFLICT(resource_type, resource_id) DO UPDATE SET revision = liekan_analytics_revision.revision + 1, updated_at = now()",
      [site],
    );
    await client.query('COMMIT');

    return {
      websiteId: site,
      name: fixture.DEFAULT_DEMO_NAME,
      demo: true,
      status: 'created',
      inserted: true,
      counts,
      chCounts: {
        logs: v2Logs.length,
        browserEvents: v2BrowserEvents.length,
        eventData: eventDataRows.length,
        revenue: revenueRows.length,
        heatmap: heatmapRows.length,
        replay: replayRows.length,
        sessionData: sessionDataRows.length,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
