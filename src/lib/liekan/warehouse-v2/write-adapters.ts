import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { LiekanError } from '../upstream/errors';
import type { LogRecord } from '../ingest';
import type { AutomaticRecord } from '../log-ingestion/protocol';
import type { WarehouseCollectionPackage } from '../upstream/warehouse-collection-package';
import {
  buildV2LogRow,
  computeObservationMask,
  normalizeHost,
  toV2Timestamp,
  type V2BrowserEventRow,
} from './ingest';
import { warehouseV2Runtime } from './runtime';
import { v2Tables } from './schema';

type SiteMetaCacheEntry = {
  epoch: string;
  policyRevision: number;
  active: boolean;
  expiresAt: number;
};

const siteMetaCache = new Map<string, SiteMetaCacheEntry>();
const SITE_META_TTL_MS = 2000;
const sourceLastReceivedCache = new Map<string, number>();
const SOURCE_LAST_RECEIVED_THROTTLE_MS = 5000;

export function clearV2SiteMetaCache(websiteId?: string) {
  if (!websiteId) {
    siteMetaCache.clear();
    return;
  }
  const suffix = `:${websiteId}`;
  for (const key of siteMetaCache.keys()) {
    if (key === websiteId || key.endsWith(suffix)) siteMetaCache.delete(key);
  }
}

async function readSiteWriteMeta(
  websiteId: string,
  resourceType: 'website' | 'link' | 'pixel',
  tx?: PoolClient,
): Promise<{ epoch: string; policyRevision: number; active: boolean }> {
  const cacheKey = `${resourceType}:${websiteId}`;
  const now = Date.now();
  const cached = siteMetaCache.get(cacheKey);
  if (!tx && cached && cached.expiresAt > now) return cached;

  const rt = warehouseV2Runtime();
  const tableCheck =
    resourceType === 'link'
      ? 'EXISTS(SELECT 1 FROM link WHERE link_id=$1::uuid AND deleted_at IS NULL)'
      : resourceType === 'pixel'
        ? 'EXISTS(SELECT 1 FROM pixel WHERE pixel_id=$1::uuid AND deleted_at IS NULL)'
        : 'EXISTS(SELECT 1 FROM website WHERE website_id=$1::uuid AND deleted_at IS NULL)';

  const { rows } = await (tx ?? rt.pg).query<{
    active: boolean;
    epoch: string;
    policy_revision: number;
  }>(
    `SELECT
      ${tableCheck} AS active,
      coalesce((SELECT epoch::text FROM liekan_log_state WHERE website_id=$1::uuid), '1') AS epoch,
      coalesce((SELECT revision::int FROM liekan_collection_policy WHERE website_id=$1::uuid), 0) AS policy_revision`,
    [websiteId],
  );
  const row = rows[0] ?? { active: false, epoch: '1', policy_revision: 0 };
  const entry: SiteMetaCacheEntry = {
    active: Boolean(row.active),
    epoch: row.epoch,
    policyRevision: Number(row.policy_revision ?? 0),
    expiresAt: now + SITE_META_TTL_MS,
  };
  if (!tx) siteMetaCache.set(cacheKey, entry);
  return entry;
}

type CollectionResult = {
  status: 'accepted' | 'duplicate';
  sessionId: string;
  visitId: string;
  eventId: string;
};

export async function submitV2BrowserCollection(
  pkg: WarehouseCollectionPackage,
  resourceType: 'website' | 'link' | 'pixel',
  sessionId: string,
  visitId: string,
  receivedAt: Date,
): Promise<CollectionResult> {
  const rt = warehouseV2Runtime();
  await rt.ensureReady();
  const site = pkg.input.websiteId;
  const clientId = pkg.input.eventId;
  if (!clientId) {
    const meta = await readSiteWriteMeta(site, resourceType);
    return writeBrowserCollection(pkg, resourceType, sessionId, visitId, receivedAt, meta);
  }

  return withWriteTransaction(async tx => {
    await lockResource(tx, site, resourceType);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,12800116))', [
      `${site}:${clientId.toLowerCase()}`,
    ]);
    const meta = await readSiteWriteMeta(site, resourceType, tx);
    const result = await rt.ch.query({
      query: `SELECT event_id, session_id, visit_id, receipt_hash, receipt_scope, collection_source
              FROM ${v2Tables.browserEvents}
              WHERE website_id={site:UUID} AND epoch={epoch:UInt64}
                AND client_event_id={clientId:UUID} AND _deleted=0 LIMIT 2`,
      query_params: { site, epoch: meta.epoch, clientId },
      format: 'JSONEachRow',
    });
    const found = await result.json<{
      event_id: string;
      session_id: string;
      visit_id: string;
      receipt_hash: string;
      receipt_scope: string;
      collection_source: string;
    }>();
    if (found.length > 1) throw new Error('warehouse-v2-ambiguous-collection-receipt');
    const prior = found[0];
    if (prior) {
      const source = pkg.input.quality?.source ?? resourceType;
      if (
        prior.receipt_hash !== pkg.input.fingerprint ||
        prior.collection_source !== source ||
        prior.receipt_scope !== (pkg.input.identity?.scope ?? source)
      ) {
        throw Object.assign(new Error('warehouse-v2-collection-conflict'), {
          code: 'COLLECTION_CONFLICT',
        });
      }
      return {
        status: 'duplicate',
        eventId: prior.event_id,
        sessionId: prior.session_id,
        visitId: prior.visit_id,
      };
    }
    return writeBrowserCollection(pkg, resourceType, sessionId, visitId, receivedAt, meta);
  });
}

async function writeBrowserCollection(
  pkg: WarehouseCollectionPackage,
  resourceType: 'website' | 'link' | 'pixel',
  sessionId: string,
  visitId: string,
  receivedAt: Date,
  meta: { epoch: string; policyRevision: number; active: boolean },
): Promise<CollectionResult> {
  const rt = warehouseV2Runtime();
  if (!meta.active) throw new Error('warehouse-v2-resource-inactive');
  if (
    pkg.input.expectedPolicyRevision !== undefined &&
    String(pkg.input.expectedPolicyRevision) !== String(meta.policyRevision)
  ) {
    const err = new Error('warehouse-v2-policy-conflict');
    (err as Error & { code?: string }).code = 'COLLECTION_CONFLICT';
    throw err;
  }

  const byFamily = new Map<string, Record<string, unknown>[]>();
  for (const fact of pkg.facts) {
    const list = byFamily.get(fact.family);
    if (list) list.push(fact.row);
    else byFamily.set(fact.family, [fact.row]);
  }

  const event = byFamily.get('website_event')?.[0];
  const session = byFamily.get('session')?.[0];
  const quality = byFamily.get('liekan_event_quality')?.[0];
  const env = byFamily.get('liekan_event_environment')?.[0];
  const geo = byFamily.get('liekan_event_geography')?.[0];
  const obs = byFamily.get('liekan_event_observation')?.[0];
  const ver = String(Date.now());
  const receivedTs = toV2Timestamp(receivedAt);

  const writes: Promise<void>[] = [];

  if (
    pkg.input.eventId &&
    (!event ||
      byFamily.get('website_event')?.length !== 1 ||
      byFamily.get('liekan_collection_receipt')?.length !== 1 ||
      byFamily.has('session_link') ||
      byFamily.has('session_data'))
  )
    throw new Error('warehouse-v2-browser-package-incomplete');

  if (event) {
    const featuresObj =
      obs?.features && typeof obs.features === 'string'
        ? (JSON.parse(obs.features) as Record<string, { state?: string }>)
        : ((obs?.features as Record<string, { state?: string }> | null) ?? null);
    const featuresStr = obs?.features
      ? typeof obs.features === 'string'
        ? obs.features
        : JSON.stringify(obs.features)
      : '';

    const rawHostname = String(quality?.hostname ?? event.hostname ?? '');
    const classification = String(quality?.classification ?? 'browser');
    const source = String(quality?.source ?? resourceType);
    const reasons = Array.isArray(quality?.reasons) ? (quality.reasons as string[]) : [];
    const identityScope = String(env?.scope ?? source);
    const identityAvailable = Boolean(env?.identity_available ?? resourceType !== 'website');

    const isEligible =
      resourceType === 'website'
        ? source === 'browser' &&
          classification === 'browser' &&
          identityScope === 'browser' &&
          identityAvailable &&
          !reasons.includes('bot_check_disabled')
        : true;

    const flatRow: V2BrowserEventRow = {
      website_id: pkg.input.websiteId,
      epoch: meta.epoch,
      event_id: String(event.event_id ?? pkg.eventId),
      session_id: String(event.session_id ?? sessionId),
      visit_id: String(event.visit_id ?? visitId),
      created_at: toV2Timestamp((event.created_at as string | Date) ?? receivedAt),
      received_at: obs?.received_at
        ? toV2Timestamp(obs.received_at as string | Date)
        : quality?.created_at
          ? toV2Timestamp(quality.created_at as string | Date)
          : receivedTs,
      session_created_at: session?.created_at
        ? toV2Timestamp(session.created_at as string | Date)
        : receivedTs,
      event_type: Number(event.event_type ?? 1),
      event_name: (event.event_name as string | null) ?? null,
      url_path: String(event.url_path ?? '/'),
      url_query: (event.url_query as string | null) ?? null,
      hostname: normalizeHost(rawHostname),
      normalized_hostname: quality?.hostname ? normalizeHost(String(quality.hostname)) : null,
      origin_hostname: env?.origin_hostname ? normalizeHost(String(env.origin_hostname)) : null,
      page_title: (event.page_title as string | null) ?? null,
      referrer_domain: (event.referrer_domain as string | null) ?? null,
      referrer_path: (event.referrer_path as string | null) ?? null,
      referrer_query: (event.referrer_query as string | null) ?? null,
      tag: (event.tag as string | null) ?? null,
      fbclid: (event.fbclid as string | null) ?? null,
      gclid: (event.gclid as string | null) ?? null,
      li_fat_id: (event.li_fat_id as string | null) ?? null,
      msclkid: (event.msclkid as string | null) ?? null,
      ttclid: (event.ttclid as string | null) ?? null,
      twclid: (event.twclid as string | null) ?? null,
      utm_source: (event.utm_source as string | null) ?? null,
      utm_medium: (event.utm_medium as string | null) ?? null,
      utm_campaign: (event.utm_campaign as string | null) ?? null,
      utm_content: (event.utm_content as string | null) ?? null,
      utm_term: (event.utm_term as string | null) ?? null,
      cls: event.cls != null ? String(event.cls) : null,
      fcp: event.fcp != null ? String(event.fcp) : null,
      inp: event.inp != null ? String(event.inp) : null,
      lcp: event.lcp != null ? String(event.lcp) : null,
      ttfb: event.ttfb != null ? String(event.ttfb) : null,
      browser: String(env?.browser ?? session?.browser ?? 'unknown'),
      os: (env?.os as string | null) ?? (session?.os as string | null) ?? null,
      device: (env?.device as string | null) ?? (session?.device as string | null) ?? null,
      screen: (env?.screen as string | null) ?? (session?.screen as string | null) ?? null,
      language: (env?.language as string | null) ?? (session?.language as string | null) ?? null,
      country: (geo?.country as string | null) ?? (session?.country as string | null) ?? null,
      region: (geo?.region as string | null) ?? (session?.region as string | null) ?? null,
      city: (geo?.city as string | null) ?? (session?.city as string | null) ?? null,
      distinct_id:
        (env?.distinct_id as string | null) ?? (session?.distinct_id as string | null) ?? null,
      collection_source: source,
      classification,
      quality_reasons: reasons,
      rule_version: String(quality?.rule_version ?? ''),
      range_status: String(quality?.range_status ?? 'unknown'),
      range_version: (quality?.range_version as string | null) ?? null,
      repair_scope_id: (quality?.repair_scope_id as string | null) ?? null,
      catalog_version: (quality?.catalog_version as string | null) ?? null,
      is_eligible: isEligible,
      identity_scope: identityScope,
      identity_available: identityAvailable,
      identity_version: String(env?.identity_version ?? ''),
      has_observation: Boolean(obs),
      obs_version: String(obs?.version ?? 'not_collected'),
      obs_features: featuresStr,
      obs_mask: computeObservationMask(featuresObj),
      is_risk_flagged: false,
      _ver: ver,
      _deleted: 0,
    };

    if (pkg.input.eventId) {
      const receipt = byFamily.get('liekan_collection_receipt')![0];
      if (
        receipt.client_event_id !== pkg.input.eventId ||
        receipt.event_id !== flatRow.event_id ||
        receipt.payload_hash !== pkg.input.fingerprint ||
        receipt.collection_source !== flatRow.collection_source
      ) {
        throw new Error('warehouse-v2-browser-receipt-mismatch');
      }
      flatRow.client_event_id = pkg.input.eventId;
      flatRow.receipt_hash = pkg.input.fingerprint;
      flatRow.receipt_scope = String(receipt.collection_scope);
      flatRow.event_properties = (byFamily.get('event_data') ?? []).map(row => {
        if (row.website_event_id !== flatRow.event_id || !row.event_data_id)
          throw new Error('warehouse-v2-property-event-mismatch');
        return [
          String(row.event_data_id),
          String(row.data_key),
          row.string_value as string | null,
          row.number_value == null ? null : String(row.number_value),
          row.date_value == null ? null : toV2Timestamp(String(row.date_value)),
          Number(row.data_type),
        ];
      });
      flatRow.event_revenue = (byFamily.get('revenue') ?? []).map(row => {
        if (row.event_id !== flatRow.event_id || !row.revenue_id)
          throw new Error('warehouse-v2-revenue-event-mismatch');
        return [String(row.revenue_id), String(row.currency), String(row.revenue)];
      });
      // The receipt, quality evidence, properties and revenue become readable in one fact.
      await rt.browserBatcher.enqueue([flatRow], `${flatRow.website_id}:${pkg.input.eventId}`);
      return { status: 'accepted', sessionId, visitId, eventId: flatRow.event_id };
    }

    writes.push(rt.browserBatcher.enqueue([flatRow], flatRow.event_id));
  }

  const eventDataRows = byFamily.get('event_data');
  if (eventDataRows?.length) {
    writes.push(
      rt.eventDataBatcher.enqueue(
        eventDataRows.map(r => ({
          website_id: pkg.input.websiteId,
          epoch: meta.epoch,
          event_data_id: r.event_data_id ?? randomUUID(),
          website_event_id: r.website_event_id ?? pkg.eventId,
          created_at: toV2Timestamp((r.created_at as string | Date) ?? receivedAt),
          data_key: String(r.data_key ?? ''),
          string_value: r.string_value ?? null,
          number_value: r.number_value != null ? String(r.number_value) : null,
          date_value: r.date_value ? toV2Timestamp(r.date_value as string | Date) : null,
          data_type: Number(r.data_type ?? 1),
          _ver: ver,
        })),
      ),
    );
  }

  const revenueRows = byFamily.get('revenue');
  if (revenueRows?.length) {
    writes.push(
      rt.revenueBatcher.enqueue(
        revenueRows.map(r => ({
          website_id: pkg.input.websiteId,
          epoch: meta.epoch,
          revenue_id: r.revenue_id ?? randomUUID(),
          session_id: r.session_id ?? sessionId,
          event_id: r.event_id ?? pkg.eventId,
          event_name: String(r.event_name ?? ''),
          currency: String(r.currency ?? 'USD'),
          revenue: String(r.revenue ?? 0),
          created_at: toV2Timestamp((r.created_at as string | Date) ?? receivedAt),
          _ver: ver,
        })),
      ),
    );
  }

  const sessionDataRows = byFamily.get('session_data');
  if (sessionDataRows?.length) {
    writes.push(
      rt.sessionDataBatcher.enqueue(
        sessionDataRows.map(r => ({
          website_id: pkg.input.websiteId,
          epoch: meta.epoch,
          session_data_id: r.session_data_id ?? randomUUID(),
          session_id: r.session_id ?? sessionId,
          data_key: String(r.data_key ?? ''),
          string_value: r.string_value ?? null,
          number_value: r.number_value != null ? String(r.number_value) : null,
          date_value: r.date_value ? toV2Timestamp(r.date_value as string | Date) : null,
          data_type: Number(r.data_type ?? 1),
          distinct_id: r.distinct_id ?? null,
          created_at: toV2Timestamp((r.created_at as string | Date) ?? receivedAt),
          _ver: ver,
        })),
      ),
    );
  }

  const sessionLinkRows = byFamily.get('session_link');
  if (sessionLinkRows?.length) {
    writes.push(
      rt.sessionLinkBatcher.enqueue(
        sessionLinkRows.map(r => ({
          website_id: pkg.input.websiteId,
          epoch: meta.epoch,
          distinct_id: String(r.distinct_id ?? ''),
          session_id: r.session_id ?? sessionId,
          created_at: receivedTs,
          _ver: ver,
        })),
      ),
    );
  }

  await Promise.all(writes);
  return { status: 'accepted', sessionId, visitId, eventId: pkg.eventId };
}

export function mapV2UploadRecord(
  dispatch: { batchId: string; websiteId: string },
  epoch: string,
  sourceId: string | null,
  ver: string,
  rec: Record<string, unknown>,
  idx: number,
) {
  const r = rec as Record<string, any>;
  const ce = (r.crawlerEvidence ?? r.crawler_evidence) as Record<string, any> | null | undefined;
  const rawTime = r.createdAt ?? r.created_at ?? r.time ?? r.timestamp;
  if (rawTime === undefined || rawTime === null || rawTime === '') {
    throw new Error('warehouse-v2-log-missing-timestamp');
  }
  const matchedRuleIds = r.matchedRuleIds ?? r.matched_rule_ids ?? ce?.matchedRuleIds ?? null;
  const rawDuration = r.durationMs ?? r.duration_ms ?? ce?.durationMs ?? null;
  return buildV2LogRow({
    websiteId: dispatch.websiteId,
    epoch,
    id: String(r.id ?? `${dispatch.batchId}:${idx}`),
    importId: (r.importId ?? r.import_id ?? dispatch.batchId) as string | null,
    sourceId: (r.sourceId ?? r.source_id ?? sourceId) as string | null,
    createdAt: rawTime as Date | string | number,
    path: String(r.path ?? '/'),
    method: String(r.method ?? 'GET'),
    status: Number(r.status ?? 200),
    bytes: r.bytes ?? 0,
    ipMasked: String(r.ipMasked ?? r.ip_masked ?? ''),
    ipHash: String(r.ipHash ?? r.ip_hash ?? ''),
    userAgent: String(r.userAgent ?? r.user_agent ?? ''),
    location: String(r.location ?? ''),
    bot: String(r.bot ?? ''),
    vendor: String(r.vendor ?? ''),
    botType: String(r.botType ?? r.bot_type ?? r.type ?? ''),
    verification: String(r.verification ?? ''),
    eventDigest: (r.eventDigest ?? r.event_digest ?? null) as string | null,
    verificationVersion: (r.verificationVersion ?? r.verification_version ?? null) as string | null,
    verificationReason: (r.verificationReason ?? r.verification_reason ?? null) as string | null,
    verificationObservedAt: (r.verificationObservedAt ?? r.verification_observed_at ?? null) as
      | Date
      | string
      | null,
    aiEligible: Boolean(r.aiEligible ?? r.ai_eligible ?? false),
    recognitionState: (r.recognitionState ?? r.recognition_state ?? 'recognized') as string,
    recognitionCandidates: r.recognitionCandidates
      ? JSON.stringify(r.recognitionCandidates)
      : (r.recognition_candidates ?? null),
    crawlerId: (r.crawlerId ?? r.crawler_id ?? null) as string | null,
    classificationVersion: (r.classificationVersion ?? r.classification_version ?? null) as
      | string
      | null,
    catalogVersion: (r.catalogVersion ?? r.catalog_version ?? null) as string | null,
    securityAction: (r.securityAction ?? r.security_action ?? ce?.securityAction ?? null) as
      | string
      | null,
    terminatingRuleId: (r.terminatingRuleId ??
      r.terminating_rule_id ??
      ce?.terminatingRuleId ??
      null) as string | null,
    matchedRuleIds: Array.isArray(matchedRuleIds)
      ? JSON.stringify(matchedRuleIds)
      : typeof matchedRuleIds === 'string'
        ? matchedRuleIds
        : null,
    cacheStatus: (r.cacheStatus ?? r.cache_status ?? ce?.cacheStatus ?? null) as string | null,
    durationMs: rawDuration != null ? Number(rawDuration) : null,
    identityEvidence: r.identityEvidence
      ? JSON.stringify(r.identityEvidence)
      : (r.identity_evidence ?? null),
    measurement: (r.measurement ?? null) as Record<string, unknown> | null,
    edgeObservation: (r.edgeObservation ??
      r.edge_observation ??
      ce?.edgeObservation ??
      null) as Record<string, unknown> | null,
    country: (r.country ?? null) as string | null,
    region: (r.region ?? null) as string | null,
    city: (r.city ?? null) as string | null,
    version: ver,
  });
}

// Hold the resource fence and the logical receipt lock until CH and PG finish.
// The pool client is always released, including after a lost COMMIT response.
type UploadTiming = {
  batchId: string;
  timeOriginMs: number;
  pid?: number;
  stamps: Record<string, number>;
};

function stamp(timing: UploadTiming | undefined, stage: string) {
  if (timing) timing.stamps[stage] = performance.now();
}

async function withWriteTransaction<T>(
  work: (tx: PoolClient) => Promise<T>,
  timing?: UploadTiming,
): Promise<T> {
  stamp(timing, 'poolRequested');
  const tx = await warehouseV2Runtime().pg.connect();
  stamp(timing, 'connected');
  if (timing) timing.pid = (tx as PoolClient & { processID?: number }).processID;
  let discard = false;
  try {
    await tx.query('BEGIN');
    stamp(timing, 'began');
    const result = await work(tx);
    stamp(timing, 'commitStarted');
    await tx.query('COMMIT');
    stamp(timing, 'committed');
    return result;
  } catch (error) {
    try {
      await tx.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    tx.release(discard);
    if (timing) console.info(JSON.stringify({ event: 'v2-upload-stages', ...timing }));
  }
}

async function lockResource(tx: PoolClient, site: string, kind: 'website' | 'link' | 'pixel') {
  const resource = await tx.query(
    `SELECT 1 FROM ${kind} WHERE ${kind}_id=$1::uuid AND deleted_at IS NULL FOR SHARE`,
    [site],
  );
  if (!resource.rowCount) throw new LiekanError('采集资源已删除', 409);
}

export async function submitV2LogUpload(dispatch: {
  batchId: string;
  websiteId: string;
  sourceId?: string | null;
  epoch?: string | number;
  isRetry?: boolean;
  records: (LogRecord | AutomaticRecord)[];
}): Promise<void> {
  const rt = warehouseV2Runtime();
  await rt.ensureReady();
  const { batchId, websiteId } = dispatch;
  const timing: UploadTiming | undefined =
    process.env.LIEKAN_V2_UPLOAD_TIMING === '1'
      ? { batchId, timeOriginMs: performance.timeOrigin, stamps: {} }
      : undefined;
  const { insertedCount, sourceId, conflicts } = await withWriteTransaction(async tx => {
    await lockResource(tx, websiteId, 'website');
    stamp(timing, 'websiteLocked');
    const {
      rows: [upload],
    } = await tx.query(
      `SELECT u.source_id, u.warehouse_epoch::text AS epoch, u.expected, u.status, u.kind,
          coalesce(ls.epoch,1)::text AS live_epoch, b.state AS batch_state
       FROM liekan_warehouse_upload u
       LEFT JOIN liekan_log_state ls ON ls.website_id=u.website_id
       LEFT JOIN liekan_ingest_batch b ON b.id=u.batch_id
       WHERE u.batch_id=$1::uuid AND u.website_id=$2::uuid FOR UPDATE OF u`,
      [batchId, websiteId],
    );
    stamp(timing, 'receiptLocked');
    if (
      !upload ||
      upload.epoch !== upload.live_epoch ||
      (dispatch.epoch !== undefined && String(dispatch.epoch) !== upload.epoch) ||
      (dispatch.sourceId !== undefined && dispatch.sourceId !== upload.source_id) ||
      upload.expected !== dispatch.records.length ||
      !['pending', 'processed'].includes(upload.status) ||
      (upload.kind === 'automatic' && !['pending', 'processed'].includes(upload.batch_state))
    ) {
      throw new LiekanError('采集批次已失效，请同步配置', 409);
    }
    if (upload.status === 'processed')
      return { insertedCount: 0, sourceId: upload.source_id, conflicts: 0 };
    const version = String(Date.now());
    const input = dispatch.records.map((rec, idx) =>
      mapV2UploadRecord(
        dispatch,
        upload.epoch,
        upload.source_id,
        version,
        rec as unknown as Record<string, unknown>,
        idx,
      ),
    );
    const ids = [...new Set(input.map(row => row.id))];
    let insertedCount = 0;
    let conflicts = 0;
    if (ids.length) {
      // Use at most 256 advisory locks, even for 10,000-row manual imports. All
      // sessions lock overlapping stripes in the same numeric order.
      stamp(timing, 'keysRequested');
      await tx.query(
        `SELECT pg_advisory_xact_lock(12800115, k) FROM (
           SELECT DISTINCT (hashtextextended($1 || ':' || id, 0) & 255)::int AS k
           FROM unnest($2::text[]) ids(id) ORDER BY k
         ) keys`,
        [websiteId, ids],
      );
      stamp(timing, 'keysLocked');
      type ExistingLog = { id: string; import_id: string | null; event_digest: string | null };
      const existing = new Map<string, ExistingLog>();
      // ClickHouse encodes named HTTP parameters in the URI. Bound each ID array.
      const lookupSize = 256;
      for (let offset = 0; offset < ids.length; offset += lookupSize) {
        const result = await rt.ch.query({
          query: `SELECT id, import_id, event_digest FROM ${v2Tables.logs}
                  WHERE website_id={site:UUID} AND epoch={epoch:UInt64}
                    AND id IN {ids:Array(String)} AND _deleted=0`,
          query_params: {
            site: websiteId,
            epoch: upload.epoch,
            ids: ids.slice(offset, offset + lookupSize),
          },
          format: 'JSONEachRow',
        });
        for (const row of await result.json<ExistingLog>()) existing.set(row.id, row);
      }
      stamp(timing, 'lookupDone');
      const toInsert = [];
      const counted = new Set<string>();
      for (const row of input) {
        const old = existing.get(row.id);
        if (old && upload.kind === 'automatic' && old.event_digest !== row.event_digest) {
          conflicts++;
          continue;
        }
        if (!old) {
          toInsert.push(row);
          existing.set(row.id, row);
        }
        if ((!old || old.import_id === batchId) && !counted.has(row.id)) {
          counted.add(row.id);
          insertedCount++;
        }
      }
      if (toInsert.length) {
        stamp(timing, 'enqueued');
        const flush = timing ? ({} as { started?: number; ended?: number }) : undefined;
        await rt.logBatcher.enqueue(toInsert, batchId, flush);
        if (timing && flush?.started !== undefined && flush.ended !== undefined) {
          timing.stamps.flushStarted = flush.started;
          timing.stamps.flushEnded = flush.ended;
        }
      }
    }
    const duplicates = input.length - insertedCount - conflicts;
    const confirmed = await tx.query(
      `WITH u AS (
         UPDATE liekan_warehouse_upload SET queued=true, status=CASE WHEN $6::int=0 THEN 'processed' ELSE 'failed' END,
           processed=$3::int, inserted=$4::int, duplicates=$5::int, conflicts=$6::int, updated_at=clock_timestamp()
         WHERE batch_id=$1::uuid AND website_id=$2::uuid AND status='pending' AND warehouse_epoch=$7::bigint
         RETURNING status
       ), i AS (
         UPDATE liekan_import SET accepted=$4::int, inserted=$4::int
         WHERE id=$1::uuid AND website_id=$2::uuid AND EXISTS(SELECT 1 FROM u)
         RETURNING id
       ), b AS (
         UPDATE liekan_ingest_batch SET state=u.status, inserted=$4::int, duplicates=$5::int,
           rejected=rejected+$6::int, processed_at=clock_timestamp()
         FROM u WHERE id=$1::uuid AND website_id=$2::uuid AND state='pending'
         RETURNING id
       )
       SELECT (SELECT count(*)::int FROM u) AS uploads, (SELECT count(*)::int FROM i) AS imports,
         (SELECT count(*)::int FROM b) AS batches`,
      [batchId, websiteId, input.length, insertedCount, duplicates, conflicts, upload.epoch],
    );
    const counts = confirmed.rows[0];
    if (
      counts.uploads !== 1 ||
      counts.imports !== 1 ||
      (upload.kind === 'automatic' && counts.batches !== 1)
    ) {
      throw new LiekanError('采集批次已取消', 409);
    }
    if (insertedCount) {
      await tx.query(
        `INSERT INTO liekan_log_state(website_id,data_revision) VALUES($1::uuid,1)
         ON CONFLICT(website_id) DO UPDATE SET data_revision=liekan_log_state.data_revision+1`,
        [websiteId],
      );
    }
    return { insertedCount, sourceId: upload.source_id, conflicts };
  }, timing);
  if (conflicts) throw new LiekanError('同一事件标识的内容已改变', 409);

  // Throttled lock-safe update of source last_received_at (outside any FOR SHARE transaction).
  if (sourceId && insertedCount > 0) {
    const nowMs = Date.now();
    const prev = sourceLastReceivedCache.get(sourceId) ?? 0;
    if (nowMs - prev >= SOURCE_LAST_RECEIVED_THROTTLE_MS) {
      sourceLastReceivedCache.set(sourceId, nowMs);
      void rt.pg
        .query(
          'UPDATE liekan_log_source SET last_received_at = clock_timestamp() WHERE id = $1::uuid',
          [sourceId],
        )
        .catch(() => {});
    }
  }
}
