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
  write = true,
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
  if (write)
    await ch.insert({
      table: 'warehouse_control_projection',
      format: 'JSONEachRow',
      values: [...proofs].map(([key, value]) => ({
        website_id: attempt.website_id,
        epoch: attempt.epoch,
        kind: 'pg-session-property-v2',
        revision: attempt.version,
        key,
        value,
        created_at: warehouseTime(decisions[0].input.envelope.receivedAt),
      })),
    });
  const rows = await ch
    .query({
      query: `SELECT DISTINCT key,value FROM warehouse_control_projection
    WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND kind='pg-session-property-v2' AND revision={version:UInt64}
    AND JSONExtractString(value,'candidateId')={candidate:String}`,
      query_params: {
        site: attempt.website_id,
        epoch: attempt.epoch,
        version: attempt.version,
        candidate: candidate.candidateId,
      },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ key: string; value: string }>());
  if (rows.length !== proofs.size || rows.some(r => proofs.get(r.key) !== r.value))
    throw new Error('warehouse-property-proof-mismatch');
}
