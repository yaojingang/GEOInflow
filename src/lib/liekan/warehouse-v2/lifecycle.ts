/**
 * Warehouse v2 Lifecycle & Presence Operations
 *
 * Replaces v1's Kafka barrier + liekan_warehouse_deletion state machine with:
 * - Instant epoch fence in PG + async ClickHouse partition/epoch deletion
 * - Direct session deletion + affected-hour MV aggregate rebuild
 * - Stateless browser presence read directly from ch_v2_browser_events
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { DEFAULT_RESET_DATE } from '../upstream/collection-defaults';
import { queryV2Json } from './client';
import { toV2Timestamp } from './ingest';
import { v2Tables } from './schema';

/**
 * Rebuild browser aggregate tables (ch_v2_observation_hour_agg & ch_v2_browser_path_hour_agg)
 * for a single UTC hour after an in-place session delete or history repair rewrite.
 */
export async function rebuildV2BrowserHourAggregates(
  ch: ClickHouseClient,
  websiteId: string,
  epoch: string | number,
  hourIsoUtc: string,
): Promise<void> {
  const params = {
    site: websiteId,
    epoch: String(epoch),
    hour: toV2Timestamp(hourIsoUtc),
  };

  // 1. Rebuild ch_v2_observation_hour_agg for this received_hour
  await ch.command({
    query: `ALTER TABLE ${v2Tables.observationHourAgg} DELETE
            WHERE website_id = {site:UUID} AND epoch = {epoch:UInt64}
              AND received_hour = toStartOfHour(parseDateTime64BestEffort({hour:String}, 6, 'UTC'))
            SETTINGS mutations_sync = 1`,
    query_params: params,
  });

  await ch.command({
    query: `INSERT INTO ${v2Tables.observationHourAgg}
      SELECT
        website_id,
        epoch,
        toStartOfHour(received_at) AS received_hour,
        collection_source,
        classification,
        browser,
        obs_version,
        obs_features,
        obs_mask,
        is_eligible,
        has_observation,
        (identity_scope = 'browser' AND identity_available) AS identity_qualified,
        identity_version,
        is_risk_flagged,
        countState() AS pv,
        uniqExactState(session_id) AS uv,
        uniqExactState(tuple(visit_id, session_id)) AS visits,
        minState(created_at) AS first_event_at,
        maxState(created_at) AS last_event_at,
        maxState(received_at) AS last_received_at
      FROM ${v2Tables.browserEvents} FINAL
      WHERE website_id = {site:UUID}
        AND epoch = {epoch:UInt64}
        AND received_at >= toStartOfHour(parseDateTime64BestEffort({hour:String}, 6, 'UTC'))
        AND received_at < toStartOfHour(parseDateTime64BestEffort({hour:String}, 6, 'UTC')) + INTERVAL 1 HOUR
        AND event_type = 1
        AND collection_source IN ('browser', 'legacy_override')
        AND _deleted = 0
      GROUP BY
        website_id, epoch, received_hour, collection_source, classification,
        browser, obs_version, obs_features, obs_mask, is_eligible,
        has_observation, identity_qualified, identity_version, is_risk_flagged`,
    query_params: params,
  });

  // 2. Rebuild ch_v2_browser_path_hour_agg for this created_at hour
  await ch.command({
    query: `ALTER TABLE ${v2Tables.browserPathHourAgg} DELETE
            WHERE website_id = {site:UUID} AND epoch = {epoch:UInt64}
              AND hour = toStartOfHour(parseDateTime64BestEffort({hour:String}, 6, 'UTC'))
            SETTINGS mutations_sync = 1`,
    query_params: params,
  });

  await ch.command({
    query: `INSERT INTO ${v2Tables.browserPathHourAgg}
      SELECT
        website_id,
        epoch,
        toStartOfHour(created_at) AS hour,
        hostname,
        url_path,
        classification,
        is_eligible,
        countState() AS pv,
        uniqExactState(session_id) AS uv,
        uniqExactState(tuple(visit_id, session_id)) AS visits,
        maxState(created_at) AS last_at
      FROM ${v2Tables.browserEvents} FINAL
      WHERE website_id = {site:UUID}
        AND epoch = {epoch:UInt64}
        AND created_at >= toStartOfHour(parseDateTime64BestEffort({hour:String}, 6, 'UTC'))
        AND created_at < toStartOfHour(parseDateTime64BestEffort({hour:String}, 6, 'UTC')) + INTERVAL 1 HOUR
        AND event_type = 1
        AND _deleted = 0
      GROUP BY website_id, epoch, hour, hostname, url_path, classification, is_eligible`,
    query_params: params,
  });
}

/**
 * Find event and reception hours before removing the facts needed to rebuild them.
 */
export async function readV2SessionHours(
  ch: ClickHouseClient,
  websiteId: string,
  epoch: string | number,
  sessionId: string,
): Promise<string[]> {
  const params = { site: websiteId, epoch: String(epoch), sessionId };

  // Find distinct touched hours (created_at & received_at) before deleting
  const touched = await queryV2Json<{ h: string }>(
    ch,
    `SELECT DISTINCT toString(h) AS h FROM (
      SELECT toStartOfHour(created_at) AS h FROM ${v2Tables.browserEvents}
      WHERE website_id = {site:UUID} AND epoch = {epoch:UInt64} AND session_id = {sessionId:UUID}
      UNION DISTINCT
      SELECT toStartOfHour(received_at) AS h FROM ${v2Tables.browserEvents}
      WHERE website_id = {site:UUID} AND epoch = {epoch:UInt64} AND session_id = {sessionId:UUID}
    )`,
    params,
  );

  return touched.map(row => row.h);
}

export async function deleteV2Session(
  ch: ClickHouseClient,
  websiteId: string,
  epoch: string | number,
  sessionId: string,
  recordedHours?: string[],
): Promise<{ hoursRebuilt: number }> {
  const params = { site: websiteId, epoch: String(epoch), sessionId };
  const hours = recordedHours ?? (await readV2SessionHours(ch, websiteId, epoch, sessionId));

  // Synchronously delete session from main event table so immediate subsequent reads exclude it
  await ch.command({
    query: `ALTER TABLE ${v2Tables.browserEvents} DELETE
            WHERE website_id = {site:UUID} AND epoch = {epoch:UInt64} AND session_id = {sessionId:UUID}
            SETTINGS mutations_sync = 1`,
    query_params: params,
  });

  // Async delete from secondary detail tables
  const sessionTables = [
    v2Tables.revenue,
    v2Tables.heatmap,
    v2Tables.sessionReplay,
    v2Tables.sessionData,
    v2Tables.sessionLink,
  ];
  for (const table of sessionTables) {
    await ch.command({
      query: `ALTER TABLE ${table} DELETE
              WHERE website_id = {site:UUID} AND epoch = {epoch:UInt64} AND session_id = {sessionId:UUID}`,
      query_params: params,
    });
  }

  for (const h of hours) {
    await rebuildV2BrowserHourAggregates(ch, websiteId, epoch, h);
  }
  return { hoursRebuilt: hours.length };
}

/**
 * Fast, lock-free browser presence check directly on ch_v2_browser_events.
 */
export async function readV2BrowserPresence(
  ch: ClickHouseClient,
  websiteId: string,
  epoch: string | number,
  createdAt?: Date,
): Promise<{ received: boolean; known: boolean; lastAt: string | null }> {
  const created = createdAt ?? new Date(0);
  const rows = await queryV2Json<{ firstAt: string | null; lastAt: string | null }>(
    ch,
    `SELECT
       minOrNullIf(created_at, event_type NOT IN (2, 5) AND created_at >= parseDateTime64BestEffort({created:String}, 6, 'UTC')) AS firstAt,
       maxOrNullIf(created_at, created_at >= parseDateTime64BestEffort({reset:String}, 6, 'UTC')) AS lastAt
     FROM ${v2Tables.browserEvents}
     WHERE website_id = {site:UUID} AND epoch = {epoch:UInt64} AND _deleted = 0`,
    {
      site: websiteId,
      epoch: String(epoch),
      created: toV2Timestamp(created),
      reset: toV2Timestamp(new Date(DEFAULT_RESET_DATE)),
    },
  );
  const row = rows[0];
  const firstMs = row?.firstAt ? Date.parse(row.firstAt.replace(' ', 'T') + 'Z') : Number.NaN;
  const lastAt = row?.lastAt ? new Date(row.lastAt.replace(' ', 'T') + 'Z').toISOString() : null;
  const received = Number.isFinite(firstMs) && firstMs <= Date.now();
  return { received, known: true, lastAt };
}
