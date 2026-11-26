/**
 * Phase 1 Isolated 100x Benchmark for GEOInflow Warehouse v2 (Native ClickHouse)
 *
 * Mirrors the approved 102-site 100x benchmark on test ECS (PG 1 CPU / 640 MiB, CH 4 CPU / 8 GiB):
 * - 7 days browser history: 181,300 PV (25,900/day), exact 96,000 UV across 7 days
 * - 1 day log history: 5,700,000 unique logs across 24 hours & 8,192 catalog URLs
 * - 66-second paired pure-ingest vs mixed-load run:
 *   - 33 log batches/sec x 2 logs = 2,178 batches (4,356 logs) + 22 browser events
 *   - Mixed load adds continuous concurrent HTTP loops for 7-day Observation & Full-day Reconciliation
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import {
  buildV2LogRow,
  clearV2CatalogCache,
  createV2BrowserBatcher,
  createV2ClickHouseClient,
  createV2LogBatcher,
  ensureV2Schema,
  queryV2Observations,
  queryV2Reconciliation,
  readV2CatalogCached,
  readV2ControlContext,
  toV2Timestamp,
  type V2BrowserEventRow,
  v2Tables,
} from '../src/lib/liekan/warehouse-v2/index';

const { Pool } = pg;

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env ${name}`);
  return v;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function seedIsolatedDatabase(
  pgPool: pg.Pool,
  ch: ReturnType<typeof createV2ClickHouseClient>,
  websiteId: string,
  sourceId: string,
) {
  const t0 = performance.now();
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS "user" (
      user_id uuid PRIMARY KEY,
      role text NOT NULL DEFAULT 'user',
      deleted_at timestamptz NULL
    );
    CREATE TABLE IF NOT EXISTS team_user (
      team_id uuid NOT NULL,
      user_id uuid NOT NULL
    );
    CREATE TABLE IF NOT EXISTS website (
      website_id uuid PRIMARY KEY,
      domain text NOT NULL,
      user_id uuid NULL,
      team_id uuid NULL,
      deleted_at timestamptz NULL
    );
    CREATE TABLE IF NOT EXISTS liekan_log_state (
      website_id uuid PRIMARY KEY,
      epoch bigint NOT NULL DEFAULT 1,
      data_revision bigint NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS liekan_collection_policy (
      website_id uuid PRIMARY KEY,
      mode text NOT NULL DEFAULT 'standard',
      revision bigint NOT NULL DEFAULT 1,
      allowed_hostnames text[] NOT NULL DEFAULT ARRAY[]::text[]
    );
    CREATE TABLE IF NOT EXISTS liekan_log_source (
      id uuid PRIMARY KEY,
      website_id uuid NOT NULL,
      kind text NOT NULL,
      domain text NOT NULL,
      state text NOT NULL DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS liekan_catalog (
      website_id uuid NOT NULL,
      path text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (website_id, path)
    );
    CREATE TABLE IF NOT EXISTS liekan_v2_upload_receipt (
      batch_id uuid PRIMARY KEY,
      website_id uuid NOT NULL,
      row_count int NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const userId = '00000000-0000-4000-8000-000000000001';
  await pgPool.query(
    `INSERT INTO "user"(user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
    [userId],
  );
  await pgPool.query(
    `INSERT INTO website(website_id, domain, user_id) VALUES ($1, 'www.example102.com', $2) ON CONFLICT DO NOTHING`,
    [websiteId, userId],
  );
  await pgPool.query(
    `INSERT INTO liekan_log_state(website_id, epoch, data_revision) VALUES ($1, 1, 1) ON CONFLICT DO NOTHING`,
    [websiteId],
  );
  await pgPool.query(
    `INSERT INTO liekan_collection_policy(website_id, mode, revision, allowed_hostnames)
     VALUES ($1, 'standard', 1, ARRAY['example102.com']) ON CONFLICT DO NOTHING`,
    [websiteId],
  );
  await pgPool.query(
    `INSERT INTO liekan_log_source(id, website_id, kind, domain, state)
     VALUES ($1, $2, 'cloudflare', 'example102.com', 'active') ON CONFLICT DO NOTHING`,
    [sourceId, websiteId],
  );

  // Insert 8,192 catalog URLs
  await pgPool.query(
    `INSERT INTO liekan_catalog(website_id, path, updated_at)
     SELECT $1::uuid, '/page-' || lpad(g::text, 5, '0'), '2026-11-21T00:00:00Z'::timestamptz
     FROM generate_series(0, 8191) AS g
     ON CONFLICT DO NOTHING`,
    [websiteId],
  );

  // Create ClickHouse v2 tables + native MVs
  await ensureV2Schema(ch);

  // Seed 181,300 browser events across 7 days (2026-11-15..2026-11-21) with exact 25,900 PV/day,
  // 24,000 UV/day, and exact 96,000 UV across the 7-day union:
  // Day d (0..6): session index = (d * 12000 + (i % 24000)) % 96000 => each day has 24,000 distinct
  // sessions, and union over d=0..6 covers 0..95999 = EXACTLY 96,000 distinct UV!
  await ch.command({
    query: `
      INSERT INTO ${v2Tables.browserEvents}
      SELECT
        toUUID('${websiteId}') AS website_id,
        toUInt64(1) AS epoch,
        generateUUIDv4() AS event_id,
        toUUID(concat('10000000-0000-4000-8000-', leftPad(hex(toUInt64((intDiv(number, 25900) * 12000 + (number % 24000)) % 96000)), 12, '0'))) AS session_id,
        toUUID(concat('20000000-0000-4000-8000-', leftPad(hex(toUInt64(number % 140000)), 12, '0'))) AS visit_id,
        addSeconds(parseDateTime64BestEffort('2026-11-15 00:00:00', 6, 'UTC'), intDiv(number, 25900) * 86400 + (number % 86400)) AS created_at,
        addSeconds(parseDateTime64BestEffort('2026-11-15 00:00:00', 6, 'UTC'), intDiv(number, 25900) * 86400 + (number % 86400)) AS received_at,
        toInt32(1) AS event_type,
        NULL AS event_name,
        concat('/page-', leftPad(toString(number % 8192), 5, '0')) AS url_path,
        NULL AS url_query,
        'example102.com' AS hostname,
        NULL AS page_title,
        NULL AS referrer_domain,
        NULL AS referrer_path,
        NULL AS utm_source,
        NULL AS utm_medium,
        NULL AS utm_campaign,
        NULL AS utm_content,
        NULL AS utm_term,
        if(number % 2 = 0, 'chrome', 'safari') AS browser,
        'macOS' AS os,
        'desktop' AS device,
        '1920x1080' AS screen,
        'zh-CN' AS language,
        'CN' AS country,
        'BJ' AS region,
        'Beijing' AS city,
        NULL AS distinct_id,
        'browser' AS collection_source,
        'human' AS classification,
        CAST([] AS Array(LowCardinality(String))) AS quality_reasons,
        'v1' AS rule_version,
        NULL AS catalog_version,
        true AS is_eligible,
        'browser' AS identity_scope,
        true AS identity_available,
        'id-v1' AS identity_version,
        true AS has_observation,
        'obs-v1' AS obs_version,
        '{"accept":{"state":"present"},"language":{"state":"present"},"site":{"state":"present"},"mode":{"state":"present"},"dest":{"state":"present"}}' AS obs_features,
        toUInt8(31) AS obs_mask,
        false AS is_risk_flagged,
        toUInt64(1) AS _ver,
        toUInt8(0) AS _deleted
      FROM numbers(181300)
    `,
  });

  // Seed 5,700,000 unique logs on 2026-11-21 distributed across 24 hours and 8,192 catalog paths.
  // Materialized views automatically populate ch_v2_log_hour_agg & ch_v2_log_path_hour_agg!
  await ch.command({
    query: `
      INSERT INTO ${v2Tables.logs}
      SELECT
        toUUID('${websiteId}') AS website_id,
        toUInt64(1) AS epoch,
        concat('seed-', toString(number)) AS id,
        NULL AS import_id,
        toUUID('${sourceId}') AS source_id,
        addMilliseconds(parseDateTime64BestEffort('2026-11-21 00:00:00', 6, 'UTC'), intDiv(number * 86400000, 5700000)) AS created_at,
        concat('/page-', leftPad(toString(number % 8192), 5, '0')) AS path,
        concat('/page-', leftPad(toString(number % 8192), 5, '0')) AS human_path,
        'GET' AS method,
        toInt32(if(number % 50 = 0, 404, 200)) AS status,
        toInt64(4096) AS bytes,
        '192.0.2.0' AS ip_masked,
        'seedhash' AS ip_hash,
        if(number % 5 = 0, 'GPTBot/1.0', 'Mozilla/5.0') AS user_agent,
        'CN' AS location,
        if(number % 5 = 0, 'GPTBot', '') AS bot,
        if(number % 5 = 0, 'OpenAI', '') AS vendor,
        if(number % 5 = 0, 'ai', 'other') AS bot_type,
        if(number % 5 = 0, 'verified', 'unverified') AS verification,
        'v1' AS verification_version,
        NULL AS verification_reason,
        NULL AS verification_observed_at,
        (number % 5 = 0) AS ai_eligible,
        'recognized' AS recognition_state,
        if(number % 5 = 0, 'gptbot', NULL) AS crawler_id,
        false AS is_self_check,
        (number % 5 != 0) AS is_unknown_crawler,
        'cls-v1' AS classification_version,
        NULL AS catalog_version,
        'example102.com' AS request_host,
        'request_host' AS host_basis,
        'present' AS content_type_state,
        'text/html' AS content_type_value,
        'cfg-v1' AS source_config_version,
        'int-v1' AS source_interval_version,
        toFloat64(1.0) AS sampling_rate,
        'CN' AS country,
        'BJ' AS region,
        'Beijing' AS city,
        '{}' AS evidence_json,
        toUInt64(1) AS _ver,
        toUInt8(0) AS _deleted
      FROM numbers(5700000)
    `,
    clickhouse_settings: {
      max_execution_time: 180,
      max_memory_usage: '4294967296',
      max_insert_block_size: '500000',
    },
  });

  const seedSec = ((performance.now() - t0) / 1000).toFixed(2);
  console.log(JSON.stringify({ event: 'seeded', seedSec: Number(seedSec) }));
}

function startV2Server(
  pgPool: pg.Pool,
  ch: ReturnType<typeof createV2ClickHouseClient>,
  websiteId: string,
  sourceId: string,
  port: number,
) {
  const logBatcher = createV2LogBatcher(ch, { flushMs: 50, maxRows: 2000 });
  const browserBatcher = createV2BrowserBatcher(ch, { flushMs: 50, maxRows: 500 });
  const userId = '00000000-0000-4000-8000-000000000001';

  const obsStart = Date.UTC(2026, 10, 15, 0, 0, 0);
  const obsEnd = Date.UTC(2026, 10, 22, 0, 0, 0);
  const recStart = Date.UTC(2026, 10, 21, 0, 0, 0);
  const recEnd = Date.UTC(2026, 10, 22, 0, 0, 0);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (req.method === 'POST' && url.pathname === '/api/v2/logs/batch') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          batchId: string;
          seq: number;
        };

        // Real PG lightweight idempotency receipt (zero website row lock!)
        await pgPool.query(
          `INSERT INTO liekan_v2_upload_receipt(batch_id, website_id, row_count)
           VALUES ($1::uuid, $2::uuid, 2) ON CONFLICT DO NOTHING`,
          [body.batchId, websiteId],
        );

        const nowTs = Date.UTC(2026, 10, 21, 23, 30, 0) + body.seq * 10;
        const rows = [0, 1].map(i =>
          buildV2LogRow({
            websiteId,
            epoch: 1,
            id: `live-${body.batchId}-${i}`,
            sourceId,
            createdAt: nowTs + i,
            path: `/page-${String((body.seq * 2 + i) % 8192).padStart(5, '0')}`,
            method: 'GET',
            status: 200,
            bytes: 2048,
            userAgent: 'GPTBot/1.0',
            bot: 'GPTBot',
            vendor: 'OpenAI',
            botType: 'ai',
            verification: 'verified',
            aiEligible: true,
            classificationVersion: 'cls-v1',
            measurement: {
              host: 'example102.com',
              hostBasis: 'request_host',
              sourceConfigVersion: 'cfg-v1',
              sourceIntervalVersion: 'int-v1',
              samplingTimeBasis: 'event_time',
              samplingBasis: 'observed_provider_config',
              samplingRate: 1,
            },
            edgeObservation: {
              fields: { EdgeResponseContentType: { state: 'present', value: 'text/html' } },
            },
          }),
        );

        // Coalesced durable ClickHouse commit (native MV updates atomically inside this INSERT!)
        await logBatcher.enqueue(rows, body.batchId);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, batchId: body.batchId, committedAt: Date.now() }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/v2/browser/event') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          eventId: string;
          seq: number;
        };
        const ts = toV2Timestamp(Date.UTC(2026, 10, 21, 23, 40, 0) + body.seq * 1000);
        const row: V2BrowserEventRow = {
          website_id: websiteId,
          epoch: '1',
          event_id: body.eventId,
          session_id: randomUUID(),
          visit_id: randomUUID(),
          created_at: ts,
          received_at: ts,
          event_type: 1,
          event_name: null,
          url_path: `/page-${String(body.seq % 8192).padStart(5, '0')}`,
          url_query: null,
          hostname: 'example102.com',
          page_title: null,
          referrer_domain: null,
          referrer_path: null,
          utm_source: null,
          utm_medium: null,
          utm_campaign: null,
          utm_content: null,
          utm_term: null,
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
          classification: 'human',
          quality_reasons: [],
          rule_version: 'v1',
          catalog_version: null,
          is_eligible: true,
          identity_scope: 'browser',
          identity_available: true,
          identity_version: 'id-v1',
          has_observation: true,
          obs_version: 'obs-v1',
          obs_features:
            '{"accept":{"state":"present"},"language":{"state":"present"},"site":{"state":"present"},"mode":{"state":"present"},"dest":{"state":"present"}}',
          obs_mask: 31,
          is_risk_flagged: false,
          _ver: String(Date.now()),
          _deleted: 0,
        };
        await browserBatcher.enqueue([row], body.eventId);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, eventId: body.eventId, committedAt: Date.now() }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/v2/observations') {
        const ctx = await readV2ControlContext(pgPool, websiteId, userId);
        if (!ctx) {
          res.writeHead(404);
          res.end();
          return;
        }
        const data = await queryV2Observations(ch, ctx, {
          startAt: obsStart,
          endAt: obsEnd,
          subset: 'raw',
          observationVersion: 'obs-v1',
          page: 1,
          pageSize: 20,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/v2/reconciliation') {
        const ctx = await readV2ControlContext(pgPool, websiteId, userId);
        if (!ctx) {
          res.writeHead(404);
          res.end();
          return;
        }
        const catalog = await readV2CatalogCached(pgPool, websiteId, ctx.catalogVersion);
        const data = await queryV2Reconciliation(ch, ctx, catalog, {
          startAt: recStart,
          endAt: recEnd,
          hostname: 'example102.com',
          sourceId,
          page: 1,
          pageSize: 20,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });

  return { server, logBatcher, browserBatcher };
}

async function runPhase(
  baseUrl: string,
  mode: 'pure' | 'mixed',
  initialRawRequests: number,
  initialObsPv: number,
) {
  const durationMs = 66_000;
  const totalBatches = 2178; // 33 batches/sec x 66s
  const totalBrowser = 22;
  const startedAt = performance.now();

  const logLatencies: number[] = [];
  const logAckEvents: { expectedMinRequests: number; ackAt: number }[] = [];
  const browserAckEvents: { expectedMinPv: number; ackAt: number }[] = [];
  const obsHttpLatencies: number[] = [];
  const recHttpLatencies: number[] = [];
  const recSnapshots: { seenAt: number; rawRequests: number }[] = [];
  const obsSnapshots: { seenAt: number; pv: number }[] = [];
  let logErrors = 0;
  let browserErrors = 0;
  let obsErrors = 0;
  let recErrors = 0;
  let acceptedBatches = 0;
  let acceptedBrowser = 0;
  let stopReaders = false;

  // Background mixed readers (continuous sequential loops for 7-day obs + full-day rec)
  const readerPromises: Promise<void>[] = [];
  if (mode === 'mixed') {
    readerPromises.push(
      (async () => {
        while (!stopReaders) {
          const t0 = performance.now();
          try {
            const r = await fetch(`${baseUrl}/api/v2/observations`);
            if (!r.ok) obsErrors++;
            else {
              const json = (await r.json()) as { totals: { pv: number } };
              const t1 = performance.now();
              obsHttpLatencies.push(t1 - t0);
              obsSnapshots.push({ seenAt: t1, pv: json.totals.pv });
            }
          } catch {
            obsErrors++;
          }
          await new Promise(r => setTimeout(r, 150));
        }
      })(),
      (async () => {
        while (!stopReaders) {
          const t0 = performance.now();
          try {
            const r = await fetch(`${baseUrl}/api/v2/reconciliation`);
            if (!r.ok) recErrors++;
            else {
              const json = (await r.json()) as { rawRequests: number };
              const t1 = performance.now();
              recHttpLatencies.push(t1 - t0);
              recSnapshots.push({ seenAt: t1, rawRequests: json.rawRequests });
            }
          } catch {
            recErrors++;
          }
          await new Promise(r => setTimeout(r, 150));
        }
      })(),
    );
  }

  // Schedule 2,178 log batches at 33/sec + 22 browser events over 66s
  const inflight: Promise<void>[] = [];
  let seq = 0;
  let browserSent = 0;
  for (let i = 0; i < totalBatches; i++) {
    const targetOffset = (i * durationMs) / totalBatches;
    const waitMs = targetOffset - (performance.now() - startedAt);
    if (waitMs > 1) await new Promise(r => setTimeout(r, waitMs));

    const batchId = randomUUID();
    const mySeq = seq++;
    const sendT0 = performance.now();
    inflight.push(
      (async () => {
        try {
          const r = await fetch(`${baseUrl}/api/v2/logs/batch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ batchId, seq: mySeq }),
          });
          const ackAt = performance.now();
          if (!r.ok) {
            logErrors++;
            return;
          }
          await r.json();
          acceptedBatches++;
          logLatencies.push(ackAt - sendT0);
          logAckEvents.push({
            expectedMinRequests: initialRawRequests + acceptedBatches * 2,
            ackAt,
          });
        } catch {
          logErrors++;
        }
      })(),
    );

    if (browserSent < totalBrowser && i >= Math.floor(((browserSent + 1) * totalBatches) / (totalBrowser + 1))) {
      const bSeq = browserSent++;
      const eventId = randomUUID();
      inflight.push(
        (async () => {
          try {
            const r = await fetch(`${baseUrl}/api/v2/browser/event`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ eventId, seq: bSeq }),
            });
            const ackAt = performance.now();
            if (!r.ok) {
              browserErrors++;
              return;
            }
            await r.json();
            acceptedBrowser++;
            browserAckEvents.push({
              expectedMinPv: initialObsPv + acceptedBrowser,
              ackAt,
            });
          } catch {
            browserErrors++;
          }
        })(),
      );
    }
  }

  await Promise.all(inflight);
  const lastPublishAfterWindowMs = performance.now() - (startedAt + durationMs);

  // Give readers one short catch-up sweep so every accepted batch gets an observed visibility timestamp
  if (mode === 'mixed') {
    await new Promise(r => setTimeout(r, 800));
    stopReaders = true;
    await Promise.all(readerPromises);
  }

  // Compute ACK -> first visible in authenticated HTTP
  const logVisibleMs: number[] = [];
  for (const ev of logAckEvents) {
    const snap = recSnapshots.find(s => s.seenAt >= ev.ackAt && s.rawRequests >= ev.expectedMinRequests);
    if (snap) logVisibleMs.push(snap.seenAt - ev.ackAt);
  }
  const browserVisibleMs: number[] = [];
  for (const ev of browserAckEvents) {
    const snap = obsSnapshots.find(s => s.seenAt >= ev.ackAt && s.pv >= ev.expectedMinPv);
    if (snap) browserVisibleMs.push(snap.seenAt - ev.ackAt);
  }

  // Final verification read
  const finalObs = (await (await fetch(`${baseUrl}/api/v2/observations`)).json()) as {
    totals: { pv: number; uv: number };
  };
  const finalRec = (await (await fetch(`${baseUrl}/api/v2/reconciliation`)).json()) as {
    rawRequests: number;
    totalRows: number;
  };

  return {
    mode,
    acceptedBatches,
    logErrors,
    acceptedBrowser,
    browserErrors,
    publishP50Ms: Number(percentile(logLatencies, 50).toFixed(2)),
    publishP95Ms: Number(percentile(logLatencies, 95).toFixed(2)),
    publishMaxMs: Number(percentile(logLatencies, 100).toFixed(2)),
    lastPublishAfterWindowMs: Number(lastPublishAfterWindowMs.toFixed(2)),
    obsHttpCount: obsHttpLatencies.length,
    obsErrors,
    obsHttpP50Ms: Number(percentile(obsHttpLatencies, 50).toFixed(2)),
    obsHttpP95Ms: Number(percentile(obsHttpLatencies, 95).toFixed(2)),
    recHttpCount: recHttpLatencies.length,
    recErrors,
    recHttpP50Ms: Number(percentile(recHttpLatencies, 50).toFixed(2)),
    recHttpP95Ms: Number(percentile(recHttpLatencies, 95).toFixed(2)),
    logVisibleMatched: logVisibleMs.length,
    logVisibleP95Ms: Number(percentile(logVisibleMs, 95).toFixed(2)),
    logVisibleMaxMs: Number(percentile(logVisibleMs, 100).toFixed(2)),
    logVisibleOver5s: logVisibleMs.filter(x => x > 5000).length,
    browserVisibleMatched: browserVisibleMs.length,
    browserVisibleP95Ms: Number(percentile(browserVisibleMs, 95).toFixed(2)),
    browserVisibleMaxMs: Number(percentile(browserVisibleMs, 100).toFixed(2)),
    finalObsPv: finalObs.totals.pv,
    finalObsUv: finalObs.totals.uv,
    finalRecRawRequests: finalRec.rawRequests,
    finalRecTotalRows: finalRec.totalRows,
  };
}

async function main() {
  const pgUrl = env('V2_PG_URL');
  const chUrl = env('V2_CH_URL');
  const chUser = env('V2_CH_USER', 'default');
  const chPassword = env('V2_CH_PASSWORD', '');
  const chDb = env('V2_CH_DB');
  const port = Number(env('V2_PORT', '13922'));

  const pgPool = new Pool({ connectionString: pgUrl, max: 10 });
  const ch = createV2ClickHouseClient({
    url: chUrl,
    username: chUser,
    password: chPassword,
    database: chDb,
  });

  const websiteId = '10200000-0000-4000-8000-000000000102';
  const sourceId = '10200000-0000-4000-8000-000000000202';

  await seedIsolatedDatabase(pgPool, ch, websiteId, sourceId);

  const { server, logBatcher, browserBatcher } = startV2Server(pgPool, ch, websiteId, sourceId, port);
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${port}`;

  // Warmup and assert exact initial shape (181,300 PV / 96,000 exact UV / 5,700,000 logs / 8,192 paths)
  clearV2CatalogCache();
  const warmObsRes = await fetch(`${baseUrl}/api/v2/observations`);
  const warmObsText = await warmObsRes.text();
  if (!warmObsRes.ok) throw new Error(`warmObs HTTP ${warmObsRes.status}: ${warmObsText}`);
  const warmObs = JSON.parse(warmObsText) as { totals: { pv: number; uv: number } };

  const warmRecRes = await fetch(`${baseUrl}/api/v2/reconciliation`);
  const warmRecText = await warmRecRes.text();
  if (!warmRecRes.ok) throw new Error(`warmRec HTTP ${warmRecRes.status}: ${warmRecText}`);
  const warmRec = JSON.parse(warmRecText) as {
    rawRequests: number;
    totalRows: number;
    browserTotals: { pv: number; uv: number; visits: number };
  };
  console.log(JSON.stringify({ event: 'warmup_verified', warmObs: warmObs.totals, warmRec: { rawRequests: warmRec.rawRequests, totalRows: warmRec.totalRows, browserTotals: warmRec.browserTotals } }));
  if (warmObs.totals.pv !== 181300 || warmObs.totals.uv !== 96000 || warmRec.rawRequests !== 5700000 || warmRec.totalRows !== 8192) {
    throw new Error('Initial 100x shape mismatch!');
  }

  // Run Pure Ingest first, then Mixed Load
  const pure = await runPhase(baseUrl, 'pure', warmRec.rawRequests, warmObs.totals.pv);
  const mixed = await runPhase(baseUrl, 'mixed', pure.finalRecRawRequests, pure.finalObsPv);

  const publishDeltaPct = Number(
    (((mixed.publishP95Ms - pure.publishP95Ms) / Math.max(1, pure.publishP95Ms)) * 100).toFixed(2),
  );

  console.log(
    JSON.stringify(
      {
        event: 'benchmark_complete',
        pure,
        mixed,
        publishDeltaPct,
        logBatcherStats: logBatcher.stats,
        browserBatcherStats: browserBatcher.stats,
      },
      null,
      2,
    ),
  );

  await logBatcher.close();
  await browserBatcher.close();
  server.close();
  await ch.close();
  await pgPool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
