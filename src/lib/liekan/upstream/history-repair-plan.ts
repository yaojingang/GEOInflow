import type { HistoryRepairPreview } from '../contracts/history-repair';
// Shared bounded repair calculation. PG and CH stores supply the same original
// evidence and persist the resulting plan under their own publication boundary.
import {
  addLogImpact,
  distinctLogKey,
  emptyLogImpact,
  logImpactCategories,
} from '../history-repair/log-impact';
import {
  addCounts,
  type EventVerdict,
  eventDecision,
  fraction,
  hash,
  includedBrowserMetricEvent,
  includedEvent,
  type LogVerdict,
  logDecision,
  publicRepairCounts,
  terminalStatuses,
} from '../history-repair/model';
import type { RunRow } from './history-repair-db';
import type { SavedEvidence } from './history-repair-evidence';

export interface EventRow {
  id: string;
  time: string;
  day: string;
  session_id: string;
  event_type: number;
  hostname: string | null;
  origin_hostname: string | null;
  excluded: boolean;
  identity_available: boolean;
  identity_scope: string | null;
  classification: EventVerdict['classification'];
  source: string;
  reasons: string[];
  rule_version: string;
  current_classification: EventVerdict['classification'];
  current_reasons: string[];
  current_rule_version: string;
}
export interface LogRow {
  id: string;
  time: string;
  day: string;
  user_agent: string;
  bot: string;
  vendor: string;
  bot_type: string;
  ai_eligible: boolean | null;
  crawler_id: string | null;
  recognition_state: string | null;
  recognition_candidates: string[] | null;
  verification: string;
  verification_version: string | null;
  verification_observed_at: string | null;
  verification_reason: string | null;
  path: string;
  catalog_version: string | null;
  identity_evidence: { subjectId?: string; status?: string } | null;
}
export interface ResultWrite {
  id: string;
  kind: 'event' | 'log';
  before: unknown;
  after: unknown;
  proof: unknown;
  issue: string | null;
}
export interface DayWrite {
  day: string;
  beforePV: number;
  afterPV: number;
  beforeIdentityMissingPV: number;
  afterIdentityMissingPV: number;
  events: number;
  logs: number;
  changedEvents: number;
  changedLogs: number;
  evidence: number;
  logEvidence: number;
}
export interface VisitorWrite {
  itemKey?: string;
  day: string;
  session: string;
  before: boolean;
  after: boolean;
}
export function planRepairEvents(
  row: RunRow,
  rows: EventRow[],
  evidence: { record: SavedEvidence }[],
) {
  const supplied = new Map(evidence.map(item => [item.record.eventId, item.record]));
  const results: ResultWrite[] = [],
    days: DayWrite[] = [],
    visitors: VisitorWrite[] = [];
  let changed = 0,
    covered = 0,
    conflicts = 0,
    beforePV = 0,
    afterPV = 0,
    beforeIdentityMissingPV = 0,
    afterIdentityMissingPV = 0;
  for (const event of rows) {
    const original: EventVerdict = {
      classification: event.classification,
      source: event.source,
      reasons: event.reasons,
      ruleVersion: event.rule_version,
    };
    const decision = eventDecision(original, row.snapshot.rulepack, supplied.get(event.id));
    if (decision.changed || decision.issue)
      results.push({
        id: event.id,
        kind: 'event',
        before: decision.before,
        after: decision.after,
        proof: supplied.has(event.id)
          ? { ...decision.proof, catalogVersion: row.snapshot.rulepack.catalogVersion }
          : decision.proof,
        issue: decision.issue,
      });
    const before = {
      ...original,
      classification: event.current_classification,
      reasons: event.current_reasons,
      ruleVersion: event.current_rule_version,
    };
    const pv = event.event_type === 1;
    const beforeAdmissible =
      pv &&
      includedEvent(before, event.event_type, event.hostname, row.snapshot.policy, {
        originHostname: event.origin_hostname,
        excluded: event.excluded,
      });
    const afterAdmissible =
      pv &&
      includedEvent(decision.after, event.event_type, event.hostname, row.snapshot.policy, {
        originHostname: event.origin_hostname,
        excluded: event.excluded,
      });
    const metricContext = {
      originHostname: event.origin_hostname,
      excluded: event.excluded,
      identityScope: event.identity_scope,
      identityAvailable: event.identity_available,
    };
    const beforeIncluded =
      pv &&
      includedBrowserMetricEvent(
        before,
        event.event_type,
        event.hostname,
        row.snapshot.policy,
        metricContext,
      );
    const afterIncluded =
      pv &&
      includedBrowserMetricEvent(
        decision.after,
        event.event_type,
        event.hostname,
        row.snapshot.policy,
        metricContext,
      );
    if (pv)
      visitors.push(
        {
          day: event.day,
          session: event.session_id,
          before: beforeIncluded && event.identity_available,
          after: afterIncluded && event.identity_available,
        },
        {
          day: 'all',
          session: event.session_id,
          before: beforeIncluded && event.identity_available,
          after: afterIncluded && event.identity_available,
        },
      );
    changed += +decision.changed;
    covered += +decision.evidence;
    conflicts += +!!decision.issue;
    beforePV += +beforeIncluded;
    afterPV += +afterIncluded;
    beforeIdentityMissingPV += +(beforeAdmissible && !beforeIncluded);
    afterIdentityMissingPV += +(afterAdmissible && !afterIncluded);
    days.push({
      day: event.day,
      beforePV: +beforeIncluded,
      afterPV: +afterIncluded,
      beforeIdentityMissingPV: +(beforeAdmissible && !beforeIncluded),
      afterIdentityMissingPV: +(afterAdmissible && !afterIncluded),
      events: 1,
      logs: 0,
      changedEvents: +decision.changed,
      changedLogs: 0,
      evidence: +decision.evidence,
      logEvidence: 0,
    });
  }
  row.counts = addCounts(row.counts, {
    processed: String(rows.length),
    changedEvents: String(changed),
    browserEvidence: String(covered),
    conflicts: String(conflicts),
    beforePV: String(beforePV),
    afterPV: String(afterPV),
    beforeIdentityMissingPV: String(beforeIdentityMissingPV),
    afterIdentityMissingPV: String(afterIdentityMissingPV),
  });
  const last = rows.at(-1);
  row.cursor = {
    time: last.time,
    id: last.id,
    membership: hash([row.cursor.membership, rows.map(value => [value.id, value.time])]),
  };
  return { results, days, visitors };
}

export function planRepairLogs(
  row: RunRow,
  logs: LogRow[],
  beforeForms: Map<string, string>,
  afterForms: Map<string, string>,
) {
  let changed = 0,
    covered = 0,
    conflicts = 0;
  const results: ResultWrite[] = [],
    days: DayWrite[] = [],
    visitors: VisitorWrite[] = [];
  row.log_impact = { ...emptyLogImpact(), ...row.log_impact };
  for (const log of logs) {
    const original: LogVerdict = {
      bot: log.bot,
      vendor: log.vendor,
      botType: log.bot_type,
      aiEligible: log.ai_eligible,
      crawlerId: log.crawler_id,
      recognitionState: log.recognition_state,
      recognitionCandidates: log.recognition_candidates || [],
      verification: log.verification,
      verificationVersion: log.verification_version,
      verificationObservedAt: log.verification_observed_at,
      verificationReason: log.verification_reason,
    };
    const decision = logDecision(
      original,
      log.user_agent,
      row.snapshot.rulepack,
      log.identity_evidence,
      {
        originalVersion: log.catalog_version,
        originalProductForm: beforeForms.get(`${log.catalog_version}:${log.crawler_id}`) || null,
        forms: afterForms,
      },
    );
    const before = logImpactCategories(original, decision.productForm.before);
    const after = logImpactCategories(decision.after, decision.productForm.after);
    row.log_impact = addLogImpact(row.log_impact, before, after);
    for (const identity of new Set([before.identity, after.identity].filter(Boolean)))
      visitors.push({
        day: 'log:identities',
        ...distinctLogKey('identity', identity),
        before: before.identity === identity,
        after: after.identity === identity,
      });
    if (before.ai || after.ai)
      visitors.push({
        day: 'log:ai-pages',
        ...distinctLogKey('ai-page', log.path),
        before: before.ai,
        after: after.ai,
      });
    if (decision.changed || decision.issue)
      results.push({
        id: log.id,
        kind: 'log',
        before: decision.before,
        after: decision.after,
        proof: decision.proof,
        issue: decision.issue,
      });
    changed += +decision.changed;
    covered += +decision.evidence;
    conflicts += +(decision.issue === 'identity-conflict');
    days.push({
      day: log.day,
      beforePV: 0,
      afterPV: 0,
      beforeIdentityMissingPV: 0,
      afterIdentityMissingPV: 0,
      events: 0,
      logs: 1,
      changedEvents: 0,
      changedLogs: +decision.changed,
      evidence: 0,
      logEvidence: +decision.evidence,
    });
  }
  row.counts = addCounts(row.counts, {
    processed: String(logs.length),
    changedLogs: String(changed),
    logEvidence: String(covered),
    conflicts: String(conflicts),
  });
  const last = logs.at(-1);
  row.cursor = {
    time: last.time,
    id: last.id,
    membership: hash([row.cursor.membership, logs.map(value => [value.id, value.time])]),
  };
  return { results, days, visitors };
}

export function finishRepairPreview(row: RunRow, sourceUploads: { id: string }[]) {
  const limitations: string[] = [];
  if (BigInt(row.counts.browserEvidence) < BigInt(row.counts.events))
    limitations.push('browser-input-incomplete');
  if (BigInt(row.counts.logEvidence) < BigInt(row.counts.logs))
    limitations.push('log-input-incomplete');
  if (BigInt(row.counts.missingQuality)) limitations.push('missing-quality-scan-time-only');
  if (BigInt(row.counts.undatedEvents)) limitations.push('undated-events');
  if (BigInt(row.counts.conflicts)) limitations.push('evidence-conflicts-retained');
  if (row.excluded_batches.length) limitations.push('excluded-old-batches');
  if (
    BigInt(row.counts.beforeIdentityMissingPV ?? '0') ||
    BigInt(row.counts.afterIdentityMissingPV ?? '0')
  )
    limitations.push('identity-input-incomplete');
  if (row.snapshot.rulepack.botCheckDisabled) limitations.push('bot-check-disabled');
  const preview: HistoryRepairPreview = {
    generation: row.generation,
    revision: row.revision,
    digest: '',
    complete: true,
    metricScope: 'qualified-browser',
    counts: publicRepairCounts(row.counts, 'qualified-browser'),
    logImpact: { ...emptyLogImpact(), ...row.log_impact },
    sourceUploads: sourceUploads.map(source => source.id),
    browserCoverage: fraction(row.counts.browserEvidence, row.counts.events),
    logCoverage: fraction(row.counts.logEvidence, row.counts.logs),
    partial: limitations.length > 0,
    limitations,
    excludedBatches: row.excluded_batches,
    timezone: row.snapshot.timezone,
    policy: row.snapshot.policy,
    rulepack: {
      engine: row.snapshot.rulepack.engine,
      matcher: row.snapshot.rulepack.matcher,
      detector: row.snapshot.rulepack.detector,
      botCheckDisabled: row.snapshot.rulepack.botCheckDisabled,
      catalogVersion: row.snapshot.rulepack.catalogVersion,
      rulesRevision: row.snapshot.rulepack.rulesRevision,
      hash: row.snapshot.rulepack.hash,
    },
  };
  preview.digest = hash([
    preview,
    row.cursor.membership,
    row.scope_revision.toString(),
    row.input_revision,
    row.snapshot.authorityHash,
  ]);
  row.preview = preview;
  row.membership_digest = row.cursor.membership;
  row.phase = 'preview';
  const total = BigInt(row.counts.events) + BigInt(row.counts.logs),
    changes = BigInt(row.counts.changedEvents) + BigInt(row.counts.changedLogs),
    coverage = BigInt(row.counts.browserEvidence) + BigInt(row.counts.logEvidence);
  row.status =
    total === 0n
      ? BigInt(row.counts.missingQuality)
        ? 'unidentifiable'
        : 'empty'
      : changes > 0n
        ? 'ready'
        : coverage > 0n
          ? 'unchanged'
          : 'unidentifiable';
  if (terminalStatuses.includes(row.status)) row.completed_at = new Date();
}
