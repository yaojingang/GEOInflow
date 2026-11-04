import type { ClickHouseClient } from '@clickhouse/client';
import { validateWireRow } from './codec';
import type { DecisionPlanner } from './consumer';
import type { SiteState } from './control';
import type { FactMutation, LandedDecision } from './landing';
import { boundaryParameters, factRelation } from './read';
import type { InputEnvelope } from './routing';

export function validateRecorderPackage(e: InputEnvelope): FactMutation[] {
  const facts = e.data.facts as FactMutation[];
  const family = e.kind === 'replay' ? 'session_replay' : 'heatmap_event';
  if (
    !['replay', 'heatmap'].includes(e.kind) ||
    e.data.format !== 'recorder-v1' ||
    e.clientEventId ||
    !Array.isArray(facts) ||
    !facts.length ||
    facts.length > (e.kind === 'replay' ? 1 : 200)
  )
    throw new Error('warehouse-invalid-recorder-package');
  const keys = new Set<string>();
  return facts.map(f => {
    if (f.family !== family) throw new Error('warehouse-recorder-family-mismatch');
    const row = validateWireRow(family, f.row);
    if (
      row.website_id !== e.websiteId ||
      row.session_id !== e.sessionId ||
      row.visit_id !== e.visitId
    )
      throw new Error('warehouse-recorder-identity-mismatch');
    const key = String(row[family === 'session_replay' ? 'replay_id' : 'heatmap_event_id']);
    if (keys.has(key)) throw new Error('warehouse-recorder-duplicate-key');
    keys.add(key);
    return { family, row };
  });
}

export function recorderPlanner(
  ch: ClickHouseClient,
  enabled?: (websiteId: string) => Promise<Set<string>>,
  lookup?: (
    state: SiteState,
    pairs: { sessionId: string; visitId: string }[],
  ) => Promise<{ session_id: string; visit_id: string }[]>,
): DecisionPlanner {
  return async (inputs, state) => {
    const parsed = inputs.map(input => ({ input, facts: validateRecorderPackage(input.envelope) }));
    const permitted = enabled ? await enabled(state.website_id) : new Set(['replay', 'heatmap']);
    // The signed recorder token predates website binding. Prove the session/visit
    // against accepted site facts; a token from another site grants no authority.
    const rows = lookup
      ? await lookup(
          state,
          inputs.map(i => ({ sessionId: i.envelope.sessionId, visitId: i.envelope.visitId })),
        )
      : await ch
          .query({
            query: `SELECT DISTINCT session_id,visit_id FROM ${factRelation('website_event', { sessionIdsParameter: 'sessions' })}
        WHERE (session_id,visit_id) IN arrayZip({sessions:Array(UUID)},{visits:Array(UUID)})`,
            query_params: {
              ...boundaryParameters({
                websiteId: state.website_id,
                epoch: state.epoch,
                publication: state.publication,
                deletionRevision: state.deletion_revision,
              }),
              sessions: inputs.map(i => i.envelope.sessionId),
              visits: inputs.map(i => i.envelope.visitId),
            },
            format: 'JSONEachRow',
          })
          .then(r => r.json<{ session_id: string; visit_id: string }>());
    const known = new Set(rows.map(r => `${r.session_id}/${r.visit_id}`));
    return parsed.map(({ input, facts }) => {
      const e = input.envelope,
        accepted = permitted.has(e.kind) && known.has(`${e.sessionId}/${e.visitId}`);
      return {
        input,
        status: accepted ? 'new' : 'cancelled',
        sessionId: e.sessionId,
        visitId: e.visitId,
        facts: accepted ? facts : [],
      } satisfies LandedDecision;
    });
  };
}
