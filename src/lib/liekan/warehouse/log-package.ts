import type { LogRecord } from '../ingest';
import type { AutomaticRecord } from '../log-ingestion/protocol';
import { rowDigest } from './codec';
import type { SiteState } from './control';
import { factInput } from './fact-input';
import { stableOperation } from './identifiers';
import type { FactMutation } from './landing';
import type { InputEnvelope } from './routing';
import type { QueueInstallation } from './transport';

export type LogPackage = {
  format: 'log-v1';
  batchId: string;
  sourceId: string | null;
  sourceEpoch: number;
  recordIndex: number;
  kind: 'automatic' | 'manual';
  facts: FactMutation[];
};
export function logEnvelope(
  site: SiteState,
  installation: QueueInstallation,
  record: LogRecord | AutomaticRecord,
  context: {
    batchId: string;
    sourceId: string | null;
    sourceEpoch: number;
    kind: 'automatic' | 'manual';
    receivedAt: Date;
    recordIndex?: number;
  },
): InputEnvelope {
  const r = record as AutomaticRecord,
    g = r.geography,
    c = r.crawlerEvidence;
  const log = factInput('liekan_log', {
    id: r.id,
    website_id: site.website_id,
    import_id: context.batchId,
    source_id: context.sourceId,
    created_at: r.time,
    path: r.path,
    method: r.method,
    status: r.status,
    bytes: r.bytes,
    ip_masked: r.ipMasked,
    ip_hash: r.ipHash,
    user_agent: r.userAgent,
    location: r.location,
    bot: r.bot,
    vendor: r.vendor,
    bot_type: r.type,
    verification: r.verification,
    event_digest: r.eventDigest ?? null,
    verification_version: r.verificationVersion,
    ai_eligible: r.aiEligible,
    recognition_state: r.recognitionState,
    recognition_candidates: r.recognitionCandidates,
    verification_observed_at: r.verificationObservedAt,
    verification_reason: r.verificationReason,
  });
  const facts: FactMutation[] = [{ family: 'liekan_log', row: log }];
  if (g)
    facts.push({
      family: 'liekan_log_geography',
      row: factInput('liekan_log_geography', {
        website_id: site.website_id,
        log_id: r.id,
        country: g.location.country || null,
        region: g.location.region || null,
        city: g.location.city?.slice(0, 80) || null,
        declared_location: r.declaredLocation || null,
        source: g.source,
        trust: g.trust,
        ip_family: g.ipFamily,
        precision: g.precision,
        reason: g.reason,
        rule_version: g.ruleVersion,
        data_version: g.dataVersion,
        city_id: g.cityId,
        accuracy_radius: g.accuracyRadius,
        country_basis: g.countryBasis,
        processed_at: g.processedAt,
        shadow: g.shadow,
      }),
    });
  facts.push({
    family: 'liekan_crawler_evidence',
    row: factInput('liekan_crawler_evidence', {
      website_id: site.website_id,
      log_id: r.id,
      classification_version: r.classificationVersion,
      crawler_id: r.crawlerId,
      security_action: c?.securityAction,
      terminating_rule_id: c?.terminatingRuleId,
      matched_rule_ids: c?.matchedRuleIds,
      cache_status: c?.cacheStatus,
      duration_ms: c?.durationMs,
      measurement: r.measurement,
      edge_observation: c?.edgeObservation,
      catalog_version: r.catalogVersion,
      identity_evidence: r.identityEvidence,
    }),
  });
  const data: LogPackage = {
    format: 'log-v1',
    batchId: context.batchId,
    sourceId: context.sourceId,
    sourceEpoch: context.sourceEpoch,
    recordIndex: context.recordIndex ?? 0,
    kind: context.kind,
    facts,
  };
  return {
    version: 1,
    routingVersion: 1,
    topicId: installation.topicId,
    websiteId: site.website_id,
    epoch: site.epoch,
    policyRevision: site.policy_revision,
    inputId: stableOperation([
      'log-input',
      context.batchId,
      r.id,
      String(context.recordIndex ?? 0),
    ]),
    eventId: stableOperation(['log-event', site.website_id, r.id]),
    clientEventId: stableOperation(['log-receipt', site.website_id, r.id]),
    sessionId: stableOperation(['log-route', site.website_id, r.id]),
    visitId: context.batchId,
    kind: 'log',
    fingerprint: r.eventDigest ?? rowDigest('liekan_log', log),
    collectionSource: 'log',
    collectionScope: 'log',
    receivedAt: context.receivedAt.toISOString(),
    data,
  };
}
