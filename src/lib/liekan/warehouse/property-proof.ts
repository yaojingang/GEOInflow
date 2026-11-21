import { persistPublicationProof, type ProofMode } from './publication-proof';
import type { ClickHouseClient } from '@clickhouse/client';
import { rowDigest } from './codec';
import type { Attempt } from './control';
import { warehouseTime } from './fact-input';
import type { LandedDecision } from './landing';
import type { ManifestEntry } from './publication';

export async function projectPropertyProofs(
  ch: ClickHouseClient,
  attempt: Attempt,
  decisions: LandedDecision[],
  manifest: ManifestEntry[],
  mode: ProofMode = 'write',
) {
  const proofs = new Map<string, string>();
  for (const decision of decisions)
    for (const mutation of decision.facts) {
      const proof = mutation.propertyProof;
      if (!proof) continue;
      const candidate = manifest.find(m => m.family === mutation.family);
      if (
        mutation.family !== 'liekan_session_data_source' ||
        proof.sourceHash !== rowDigest(mutation.family, mutation.row) ||
        !/^[0-9a-f]{64}$/.test(proof.dataHash) ||
        !candidate
      )
        throw new Error('warehouse-property-proof-invalid');
      const value = JSON.stringify({ candidateId: candidate.candidateId, value: proof.dataHash });
      if (proofs.has(proof.sourceHash) && proofs.get(proof.sourceHash) !== value)
        throw new Error('warehouse-property-proof-conflict');
      proofs.set(proof.sourceHash, value);
    }
  if (!proofs.size) return;
  const candidate = manifest.find(m => m.family === 'liekan_session_data_source');
  await persistPublicationProof(ch, attempt, candidate, proofs, {
    kind: 'pg-session-property-v2',
    revision: attempt.version,
    createdAt: warehouseTime(decisions[0].input.envelope.receivedAt),
    mismatch: 'warehouse-property-proof-mismatch',
    mode,
    verifyAfterWrite: true,
  });
}
