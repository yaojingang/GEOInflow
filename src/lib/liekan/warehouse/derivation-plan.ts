import { candidateDigest, type StoredFact, storedFact } from './candidate';
import type { Attempt } from './control';
import { stableOperation } from './identifiers';
import type { LandedDecision } from './landing';
import type { ManifestEntry } from './publication';

// Candidate IDs are deterministic for a sealed decision. Any recovering worker
// reproduces exactly these bytes; candidate verification detects divergent output.
export function deriveCandidates(attempt: Attempt, decisions: LandedDecision[]) {
  if (!attempt.version || !['confirmed', 'projected'].includes(attempt.status))
    throw new Error('Cannot derive an unconfirmed decision');
  const groups = new Map<string, StoredFact[]>();
  let ordinal = 0;
  for (const decision of [...decisions].sort((a, b) =>
    BigInt(a.input.offset) < BigInt(b.input.offset) ? -1 : 1,
  )) {
    for (const mutation of decision.facts) {
      const rows = groups.get(mutation.family) ?? [];
      const row = mutation.row;
      const timestamp =
        row.window_end ??
        row.created_at ??
        row.bucket ??
        row.event_at ??
        row.processed_at ??
        row.updated_at;
      rows.push(
        storedFact(mutation.family, row, {
          _website_id: attempt.website_id,
          _epoch: attempt.epoch,
          _version: attempt.version,
          _ordinal: ordinal++,
          _attempt_id: attempt.attempt_id,
          _candidate_id: stableOperation(['derived', attempt.attempt_id, mutation.family]),
          _record_time:
            typeof timestamp === 'string'
              ? timestamp
              : new Date(decision.input.envelope.receivedAt)
                  .toISOString()
                  .replace('T', ' ')
                  .replace('Z', '000'),
          // Repair results/inputs are run-owned audit evidence (matching PG's
          // lifecycle); exclusion memberships remain parent-session-owned.
          _session_id: [
            'liekan_collection_diagnostic',
            'liekan_geography_ingress',
            'liekan_history_repair_result',
            'liekan_history_repair_input',
          ].includes(mutation.family)
            ? null
            : typeof row.session_id === 'string'
              ? row.session_id
              : (mutation.sessionId ?? decision.sessionId),
          _topic_id: attempt.topic_id,
          _partition: attempt.partition,
          _offset: decision.input.offset,
          _deleted: mutation.deleted ?? false,
          _retain_created_at: mutation.retainCreatedAt ?? false,
        }),
      );
      groups.set(mutation.family, rows);
    }
  }
  const manifest: ManifestEntry[] = [...groups].map(([family, rows]) => ({
    family,
    attemptId: attempt.attempt_id,
    candidateId: rows[0]._candidate_id,
    rowCount: String(rows.length),
    digest: candidateDigest(family, rows),
  }));
  return { groups, manifest };
}
