import type { ClickHouseClient } from '@clickhouse/client';
import type { Attempt } from './control';
import { warehouseTime } from './fact-input';
import type { LandedDecision } from './landing';
import type { ManifestEntry } from './publication';
import { effectiveLogRelation } from './reporting-relations';

export async function projectLogScopeProofs(
  ch: ClickHouseClient,
  attempt: Attempt,
  decisions: LandedDecision[],
  manifest: ManifestEntry[],
  write = true,
) {
  const candidate = manifest.find(m => m.family === 'liekan_log');
  if (!candidate) return;
  const proofs = new Map<string, string>();
  for (const d of decisions.filter(d => d.status === 'new' && d.input.envelope.kind === 'log')) {
    for (const f of d.facts.filter(f => f.family === 'liekan_log')) {
      const effect = d.effects?.find(e => e.kind === 'log-upload' && e.batchId === f.row.import_id);
      if (effect?.kind !== 'log-upload' || !effect.scopeProof)
        throw new Error('warehouse-log-scope-proof-missing');
      const key = String(f.row.import_id),
        value = JSON.stringify({
          candidateId: candidate.candidateId,
          value: JSON.stringify(effect.scopeProof),
        });
      if (proofs.has(key) && proofs.get(key) !== value)
        throw new Error('warehouse-log-scope-proof-conflict');
      proofs.set(key, value);
    }
  }
  if (!proofs.size) throw new Error('warehouse-log-scope-proof-missing');
  if (write)
    await ch.insert({
      table: 'warehouse_control_projection',
      format: 'JSONEachRow',
      values: [...proofs].map(([key, value]) => ({
        website_id: attempt.website_id,
        epoch: attempt.epoch,
        kind: 'log-import-scope-v1',
        revision: '0',
        key,
        value,
        created_at: warehouseTime(decisions[0].input.envelope.receivedAt),
      })),
    });
  const rows = await ch
    .query({
      query: `SELECT DISTINCT key,value FROM warehouse_control_projection WHERE website_id={site:UUID} AND epoch={epoch:UInt64}
    AND kind='log-import-scope-v1' AND revision=0 AND JSONExtractString(value,'candidateId')={candidate:String}`,
      query_params: {
        site: attempt.website_id,
        epoch: attempt.epoch,
        candidate: candidate.candidateId,
      },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ key: string; value: string }>());
  if (rows.length !== proofs.size || rows.some(r => proofs.get(r.key) !== r.value))
    throw new Error('warehouse-log-scope-proof-mismatch');
}

// A frozen repair reads the original import's scope without transferring a
// site-sized list of import/event IDs to PG or trusting unpublished metadata.
export function repairLogSourceRelation() {
  return `(SELECT l.* FROM ${effectiveLogRelation()} l INNER JOIN
    (SELECT key,JSONExtractString(p.value,'candidateId') AS candidate,any(JSONExtractString(p.value,'value')) AS body
     FROM warehouse_control_projection p WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND kind='log-import-scope-v1' AND revision=0 GROUP BY key,candidate) proof
    ON proof.key=toString(l.import_id) AND proof.candidate=toString(l._candidate_id)
    WHERE JSONExtractBool(proof.body,'present') AND isNull(JSONExtract(proof.body,'repairScopeId','Nullable(String)')))`;
}
