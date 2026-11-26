import { createHash } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { insertV2Rows } from './client';
import { v2Tables } from './schema';

export function humanPathFromEncoded(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

export type V2LogRow = {
  website_id: string;
  epoch: string;
  id: string;
  import_id: string | null;
  source_id: string | null;
  created_at: string;
  path: string;
  human_path: string;
  method: string;
  status: number;
  bytes: string;
  ip_masked: string;
  ip_hash: string;
  user_agent: string;
  location: string;
  bot: string;
  vendor: string;
  bot_type: string;
  verification: string;
  event_digest: string | null;
  verification_version: string | null;
  verification_reason: string | null;
  verification_observed_at: string | null;
  ai_eligible: boolean;
  recognition_state: string;
  recognition_candidates: string | null;
  crawler_id: string | null;
  is_self_check: boolean;
  is_unknown_crawler: boolean;
  classification_version: string | null;
  catalog_version: string | null;
  security_action: string | null;
  terminating_rule_id: string | null;
  matched_rule_ids: string | null;
  cache_status: string | null;
  duration_ms: number | null;
  identity_evidence: string | null;
  request_host: string;
  host_basis: string;
  content_type_state: string;
  content_type_value: string;
  source_config_version: string;
  source_interval_version: string;
  sampling_rate: number | null;
  country: string | null;
  region: string | null;
  city: string | null;
  evidence_json: string;
  _ver: string;
  _deleted: number;
};

export type V2BrowserEventRow = {
  website_id: string;
  epoch: string;
  event_id: string;
  session_id: string;
  visit_id: string;
  created_at: string;
  received_at: string;
  session_created_at: string;
  event_type: number;
  event_name: string | null;
  url_path: string;
  url_query: string | null;
  hostname: string;
  normalized_hostname: string | null;
  origin_hostname: string | null;
  page_title: string | null;
  referrer_domain: string | null;
  referrer_path: string | null;
  referrer_query: string | null;
  tag: string | null;
  fbclid: string | null;
  gclid: string | null;
  li_fat_id: string | null;
  msclkid: string | null;
  ttclid: string | null;
  twclid: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  cls: string | null;
  fcp: string | null;
  inp: string | null;
  lcp: string | null;
  ttfb: string | null;
  browser: string;
  os: string | null;
  device: string | null;
  screen: string | null;
  language: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  distinct_id: string | null;
  collection_source: string;
  classification: string;
  quality_reasons: string[];
  rule_version: string;
  range_status: string;
  range_version: string | null;
  repair_scope_id: string | null;
  catalog_version: string | null;
  is_eligible: boolean;
  identity_scope: string;
  identity_available: boolean;
  identity_version: string;
  has_observation: boolean;
  obs_version: string;
  obs_features: string;
  obs_mask: number;
  is_risk_flagged: boolean;
  client_event_id?: string;
  receipt_hash?: string;
  receipt_scope?: string;
  event_properties?: [string, string, string | null, string | null, string | null, number][];
  event_revenue?: [string, string, string][];
  _ver: string;
  _deleted: number;
};

const OBSERVATION_FIELDS = ['accept', 'language', 'site', 'mode', 'dest'] as const;

export function computeObservationMask(
  features: Record<string, { state?: string }> | null,
): number {
  if (!features) return 0;
  let mask = 0;
  for (let i = 0; i < OBSERVATION_FIELDS.length; i++) {
    if (features[OBSERVATION_FIELDS[i]]?.state === 'present') {
      mask |= 1 << i;
    }
  }
  return mask;
}

export function normalizeHost(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/^www\./, '');
}

export function isUnknownCrawler(
  bot: string | null | undefined,
  botType: string | null | undefined,
): boolean {
  const b = (bot ?? '').trim();
  const t = (botType ?? '').trim().toLowerCase();
  return !b || b === 'Unknown' || b === '未知' || t === 'other' || t === 'unknown' || t === '';
}

export function toV2Timestamp(input: Date | string | number): string {
  if (typeof input === 'string') {
    const bare = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?$/.exec(input.trim());
    if (bare) {
      const frac = (bare[3] ?? '').padEnd(6, '0');
      return `${bare[1]} ${bare[2]}.${frac}`;
    }
  }
  const d = input instanceof Date ? input : new Date(input);
  const iso = d.toISOString();
  return `${iso.slice(0, 19).replace('T', ' ')}.${iso.slice(20, 23)}000`;
}

export function buildV2LogRow(input: {
  websiteId: string;
  epoch: string | number | bigint;
  id: string;
  importId?: string | null;
  sourceId?: string | null;
  createdAt: Date | string | number;
  path: string;
  method: string;
  status: number;
  bytes?: number | string | bigint;
  ipMasked?: string;
  ipHash?: string;
  userAgent?: string;
  location?: string;
  bot?: string;
  vendor?: string;
  botType?: string;
  verification?: string;
  eventDigest?: string | null;
  verificationVersion?: string | null;
  verificationReason?: string | null;
  verificationObservedAt?: Date | string | number | null;
  aiEligible?: boolean;
  recognitionState?: string | null;
  recognitionCandidates?: string | null;
  crawlerId?: string | null;
  classificationVersion?: string | null;
  catalogVersion?: string | null;
  securityAction?: string | null;
  terminatingRuleId?: string | null;
  matchedRuleIds?: string | null;
  cacheStatus?: string | null;
  durationMs?: number | null;
  identityEvidence?: string | null;
  measurement?: Record<string, unknown> | null;
  edgeObservation?: Record<string, unknown> | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  version?: string | number | bigint;
}): V2LogRow {
  const ua = input.userAgent ?? '';
  const bot = input.bot ?? '';
  const botType = input.botType ?? '';
  const m = input.measurement ?? {};
  const edgeFields = (
    input.edgeObservation as { fields?: Record<string, { state?: string; value?: string }> } | null
  )?.fields;
  const ct = edgeFields?.EdgeResponseContentType;
  const samplingRate =
    m.samplingTimeBasis === 'event_time' &&
    m.samplingBasis === 'observed_provider_config' &&
    typeof m.samplingRate === 'number' &&
    m.samplingRate > 0 &&
    m.samplingRate <= 1
      ? m.samplingRate
      : null;

  return {
    website_id: input.websiteId,
    epoch: String(input.epoch),
    id: input.id,
    import_id: input.importId ?? null,
    source_id: input.sourceId ?? null,
    created_at: toV2Timestamp(input.createdAt),
    path: input.path,
    human_path: humanPathFromEncoded(input.path),
    method: input.method,
    status: input.status,
    bytes: String(input.bytes ?? 0),
    ip_masked: input.ipMasked ?? '',
    ip_hash: input.ipHash ?? '',
    user_agent: ua,
    location: input.location ?? '',
    bot,
    vendor: input.vendor ?? '',
    bot_type: botType,
    verification: input.verification ?? '',
    event_digest: input.eventDigest ?? null,
    verification_version: input.verificationVersion ?? null,
    verification_reason: input.verificationReason ?? null,
    verification_observed_at: input.verificationObservedAt
      ? toV2Timestamp(input.verificationObservedAt)
      : null,
    ai_eligible: Boolean(input.aiEligible),
    recognition_state: input.recognitionState ?? 'recognized',
    recognition_candidates: input.recognitionCandidates ?? null,
    crawler_id: input.crawlerId ?? null,
    is_self_check: ua.startsWith('Liekan-Crawler-Check/'),
    is_unknown_crawler: isUnknownCrawler(bot, botType),
    classification_version: input.classificationVersion ?? null,
    catalog_version: input.catalogVersion ?? null,
    security_action: input.securityAction ?? null,
    terminating_rule_id: input.terminatingRuleId ?? null,
    matched_rule_ids: input.matchedRuleIds ?? null,
    cache_status: input.cacheStatus ?? null,
    duration_ms: input.durationMs ?? null,
    identity_evidence: input.identityEvidence ?? null,
    request_host: normalizeHost(typeof m.host === 'string' ? m.host : ''),
    host_basis: typeof m.hostBasis === 'string' ? m.hostBasis : '',
    content_type_state: typeof ct?.state === 'string' ? ct.state : '',
    content_type_value: typeof ct?.value === 'string' ? ct.value : '',
    source_config_version: typeof m.sourceConfigVersion === 'string' ? m.sourceConfigVersion : '',
    source_interval_version:
      typeof m.sourceIntervalVersion === 'string' ? m.sourceIntervalVersion : '',
    sampling_rate: samplingRate,
    country: input.country ?? null,
    region: input.region ?? null,
    city: input.city ?? null,
    evidence_json: JSON.stringify({
      measurement: input.measurement ?? null,
      edgeObservation: input.edgeObservation ?? null,
    }),
    _ver: String(input.version ?? Date.now()),
    _deleted: 0,
  };
}

export type FlushTiming = { started?: number; ended?: number };

type QueuedBatch<T> = {
  timing?: FlushTiming;
  rows: readonly T[];
  dedupKey?: string;
  resolve: () => void;
  reject: (err: unknown) => void;
};

export type BatcherStats = {
  flushes: number;
  rowsWritten: number;
  batchesCoalesced: number;
  lastFlushMs: number;
};

/**
 * Coalesces high-frequency micro-batches into clean bulk ClickHouse INSERTs so ClickHouse never
 * suffers small-part storms while preserving durable commit ACKs.
 */
export class WarehouseV2Batcher<T extends Record<string, unknown>> {
  private pending: QueuedBatch<T>[] = [];
  private pendingRows = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private closed = false;
  readonly stats: BatcherStats = {
    flushes: 0,
    rowsWritten: 0,
    batchesCoalesced: 0,
    lastFlushMs: 0,
  };

  constructor(
    private readonly ch: ClickHouseClient,
    private readonly table: string,
    private readonly options: {
      flushMs?: number;
      maxRows?: number;
    } = {},
  ) {}

  enqueue(rows: readonly T[], dedupKey?: string, timing?: FlushTiming): Promise<void> {
    if (this.closed) return Promise.reject(new Error('WarehouseV2Batcher is closed'));
    if (!rows.length) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ rows, dedupKey, timing, resolve, reject });
      this.pendingRows += rows.length;
      const maxRows = this.options.maxRows ?? 2000;
      if (this.pendingRows >= maxRows) {
        this.clearTimer();
        void this.pump();
      } else if (!this.timer) {
        const flushMs = this.options.flushMs ?? 50;
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.pump();
        }, flushMs);
        this.timer.unref?.();
      }
    });
  }

  async flush(): Promise<void> {
    this.clearTimer();
    while (this.pending.length || this.inflight) {
      if (this.inflight) {
        await this.inflight;
      } else {
        await this.pump();
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async pump(): Promise<void> {
    if (this.inflight || !this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    this.pendingRows = 0;

    const mergedRows: T[] = [];
    const dedupKeys: string[] = [];
    for (const item of batch) {
      for (const row of item.rows) mergedRows.push(row);
      if (item.dedupKey) dedupKeys.push(item.dedupKey);
    }

    const deduplicationToken =
      dedupKeys.length === batch.length && dedupKeys.length > 0
        ? createHash('sha256').update(dedupKeys.sort().join('|')).digest('hex').slice(0, 32)
        : undefined;

    const run = (async () => {
      const started = performance.now();
      try {
        await insertV2Rows(this.ch, this.table, mergedRows, { deduplicationToken });
        this.stats.flushes += 1;
        this.stats.rowsWritten += mergedRows.length;
        this.stats.batchesCoalesced += batch.length;
        this.stats.lastFlushMs = performance.now() - started;
        const ended = performance.now();
        for (const item of batch) {
          if (item.timing) {
            item.timing.started = started;
            item.timing.ended = ended;
          }
          item.resolve();
        }
      } catch (error) {
        for (const item of batch) item.reject(error);
      } finally {
        this.inflight = null;
        if (this.pending.length) {
          void this.pump();
        }
      }
    })();

    this.inflight = run;
    await run;
  }
}

export function createV2LogBatcher(
  ch: ClickHouseClient,
  options?: { flushMs?: number; maxRows?: number },
) {
  return new WarehouseV2Batcher<V2LogRow>(ch, v2Tables.logs, options);
}

export function createV2BrowserBatcher(
  ch: ClickHouseClient,
  options?: { flushMs?: number; maxRows?: number },
) {
  return new WarehouseV2Batcher<V2BrowserEventRow>(ch, v2Tables.browserEvents, options);
}
