import { persistPublicationProof, type ProofMode } from './publication-proof';
import type { ClickHouseClient } from '@clickhouse/client';
import type { Attempt } from './control';
import { warehouseTime } from './fact-input';
import type { LandedDecision } from './landing';
import type { ManifestEntry } from './publication';
import { type FactReadOptions, factRelation } from './read';
import { validateTask } from './tasks';
export async function projectRiskProofs(
  ch: ClickHouseClient,
  attempt: Attempt,
  decisions: LandedDecision[],
  manifest: ManifestEntry[],
  mode: ProofMode = 'write',
) {
  const candidate = manifest.find(m => m.family === 'liekan_browser_risk');
  if (!candidate) return;
  const proofs = new Map<string, string>();
  for (const d of decisions.filter(d => d.input.envelope.kind === 'task' && d.status === 'new')) {
    const p = validateTask(d.input.envelope),
      r = p.result;
    if (r.kind !== 'browser-risk') continue;
    proofs.set(
      warehouseTime(r.windowEnd),
      JSON.stringify({
        candidateId: candidate.candidateId,
        value: JSON.stringify({
          epoch: r.logEpoch,
          ruleVersion: r.ruleVersion,
          coverage: r.coverage,
          computedAt: warehouseTime(d.input.envelope.receivedAt),
        }),
      }),
    );
  }
  if (!proofs.size) throw new Error('warehouse-risk-window-proof-missing');
  await persistPublicationProof(ch, attempt, candidate, proofs, {
    kind: 'browser-risk-window-v1',
    revision: '0',
    createdAt: warehouseTime(decisions[0].input.envelope.receivedAt),
    mismatch: 'warehouse-risk-window-proof-mismatch',
    mode,
    verifyAfterWrite: true,
  });
}
export function riskRelation(options: FactReadOptions = {}) {
  return `(SELECT r.website_id AS website_id,r.window_end AS window_end,r.session_id AS session_id,r.visit_id AS visit_id,r.reasons AS reasons,r.features AS features,
    parseDateTime64BestEffortOrNull(JSONExtractString(p.body,'computedAt'),6,'UTC') AS computed_at
    FROM ${factRelation('liekan_browser_risk', options)} r INNER JOIN
      (SELECT key,JSONExtractString(projection.value,'candidateId') AS candidate,any(JSONExtractString(projection.value,'value')) AS body
       FROM warehouse_control_projection projection WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND kind='browser-risk-window-v1' AND revision=0 GROUP BY key,candidate) p
      ON p.key=toString(r.window_end) AND p.candidate=toString(r._candidate_id)
    WHERE JSONExtractString(p.body,'coverage')='observed' AND JSONExtractString(p.body,'ruleVersion')={riskRule:String}
      AND JSONExtractString(p.body,'epoch')={riskEpoch:String})`;
}
