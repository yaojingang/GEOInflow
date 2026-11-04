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
  write = true,
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
  if (write)
    await ch.insert({
      table: 'warehouse_control_projection',
      format: 'JSONEachRow',
      values: [...proofs].map(([key, value]) => ({
        website_id: attempt.website_id,
        epoch: attempt.epoch,
        kind: 'browser-risk-window-v1',
        revision: '0',
        key,
        value,
        created_at: warehouseTime(decisions[0].input.envelope.receivedAt),
      })),
    });
  const rows = await ch
    .query({
      query: `SELECT DISTINCT key,value FROM warehouse_control_projection WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND kind='browser-risk-window-v1' AND revision=0 AND JSONExtractString(value,'candidateId')={candidate:String}`,
      query_params: {
        site: attempt.website_id,
        epoch: attempt.epoch,
        candidate: candidate.candidateId,
      },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ key: string; value: string }>());
  if (rows.length !== proofs.size || rows.some(r => proofs.get(r.key) !== r.value))
    throw new Error('warehouse-risk-window-proof-mismatch');
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
