import { createHash } from 'node:crypto';
import { recordKey, rowDigest, validateWireRow } from './codec';
import type { DecisionPlanner } from './consumer';
import type { ControlDatabase } from './control-db';
import type { PublicationEffect } from './effects';
import { factInput } from './fact-input';
import { type FactMutation, type LandedDecision, receiptOutcome } from './landing';
import { type InputEnvelope, routingKey } from './routing';

const families = new Set([
  'session',
  'website_event',
  'event_data',
  'revenue',
  'session_data',
  'session_link',
  'liekan_session_source',
  'liekan_session_data_source',
  'liekan_session_link_source',
  'liekan_event_quality',
  'liekan_event_environment',
  'liekan_event_geography',
  'liekan_event_observation',
  'liekan_collection_receipt',
]);
type Package = {
  format: string;
  facts: FactMutation[];
  identify: boolean;
  hasQuality: boolean;
  hasIdentity: boolean;
  hasGeography: boolean;
  hasObservation: boolean;
};

export function validateBrowserPackage(e: InputEnvelope): FactMutation[] {
  const p = e.data as unknown as Package;
  if (
    p.format !== 'browser-v1' ||
    !Array.isArray(p.facts) ||
    p.facts.length > 15000 ||
    ['identify', 'hasQuality', 'hasIdentity', 'hasGeography', 'hasObservation'].some(
      k => typeof p[k] !== 'boolean',
    ) ||
    p.identify !== (e.kind === 'identify')
  )
    throw new Error('warehouse-invalid-browser-package');
  const counts = new Map<string, number>();
  const facts = p.facts.map(m => {
    if (!families.has(m.family)) throw new Error('warehouse-browser-family-mismatch');
    if (m.deleted !== undefined) throw new Error('warehouse-collection-delete-forbidden');
    if (m.propertyProof !== undefined) throw new Error('warehouse-collection-proof-override-forbidden');
    if (m.sessionId !== undefined)
      throw new Error('warehouse-collection-session-override-forbidden');
    const row = validateWireRow(m.family, m.row);
    if (
      row.website_id !== e.websiteId ||
      ('session_id' in row && row.session_id !== e.sessionId) ||
      ('event_id' in row && row.event_id !== e.eventId) ||
      ('website_event_id' in row && row.website_event_id !== e.eventId) ||
      ('visit_id' in row && row.visit_id !== e.visitId)
    )
      throw new Error('warehouse-browser-identity-mismatch');
    if (
      m.family === 'liekan_collection_receipt' &&
      (row.client_event_id !== e.clientEventId ||
        row.payload_hash !== e.fingerprint ||
        row.collection_source !== e.collectionSource ||
        row.collection_scope !== e.collectionScope)
    )
      throw new Error('warehouse-browser-receipt-mismatch');
    if (m.family === 'liekan_event_quality' && row.source !== e.collectionSource)
      throw new Error('warehouse-browser-source-mismatch');
    if (
      [
        'liekan_event_environment',
        'liekan_session_source',
        'liekan_session_link_source',
        'liekan_session_data_source',
      ].includes(m.family) &&
      row.scope !== e.collectionScope
    )
      throw new Error('warehouse-browser-scope-mismatch');
    counts.set(m.family, (counts.get(m.family) ?? 0) + 1);
    return { ...m, row };
  });
  const requireCount = (family: string, n: number) => {
    if ((counts.get(family) ?? 0) !== n) throw new Error('warehouse-browser-package-incomplete');
  };
  requireCount('session', 1);
  requireCount('website_event', p.identify ? 0 : 1);
  requireCount('liekan_session_source', p.hasIdentity ? 1 : 0);
  requireCount('liekan_event_quality', !p.identify && p.hasQuality ? 1 : 0);
  requireCount('liekan_event_environment', !p.identify && p.hasIdentity ? 1 : 0);
  requireCount('liekan_event_geography', !p.identify && p.hasGeography ? 1 : 0);
  requireCount('liekan_event_observation', !p.identify && p.hasObservation ? 1 : 0);
  requireCount('liekan_collection_receipt', !p.identify && e.clientEventId ? 1 : 0);
  if (p.identify) {
    requireCount('event_data', 0);
    requireCount('revenue', 0);
  } else {
    requireCount('session_data', 0);
    requireCount('session_link', 0);
    requireCount('liekan_session_data_source', 0);
    requireCount('liekan_session_link_source', 0);
  }
  for (const [value, source] of [
    ['session_data', 'liekan_session_data_source'],
    ['session_link', 'liekan_session_link_source'],
  ]) {
    const valueKeys = new Set(
      facts.filter(f => f.family === value).map(f => recordKey(source, f.row)),
    );
    const sourceKeys = new Set(
      facts.filter(f => f.family === source).map(f => recordKey(source, f.row)),
    );
    if (
      p.hasIdentity &&
      (valueKeys.size !== sourceKeys.size || [...valueKeys].some(k => !sourceKeys.has(k)))
    )
      throw new Error('warehouse-browser-property-evidence-missing');
  }
  for (const proof of facts.filter(f => f.family === 'liekan_session_data_source')) {
    const data = facts.find(
      f => f.family === 'session_data' && f.row.data_key === proof.row.data_key,
    );
    if (!data || proof.row.row_digest !== rowDigest('session_data', data.row))
      throw new Error('warehouse-browser-property-evidence-mismatch');
  }
  return facts;
}

export function browserPlanner(db: ControlDatabase): DecisionPlanner {
  return async (inputs, state, receipts) => {
    const [context] = await db.read<{ epoch: number; repair_scope_id: string | null }>(
      `SELECT coalesce(l.epoch,1) AS epoch,r.repair_scope_id
      FROM website w LEFT JOIN liekan_log_state l ON l.website_id=w.website_id
      LEFT JOIN liekan_history_repair_run r ON r.website_id=w.website_id AND r.campaign_id='traffic-quality-repair-20261022-v1'
      WHERE w.website_id=$1::uuid`,
      [state.website_id],
    );
    return inputs.map(input => {
      const e = input.envelope;
      const facts = validateBrowserPackage(e);
      const receipt = e.clientEventId
        ? receipts.find(r => r.identity_key === routingKey(e))
        : undefined;
      const status = receipt ? receiptOutcome(receipt, e) : 'new';
      if (status === 'unavailable') throw new Error('warehouse-receipt-unavailable');
      const selected = status === 'new' ? facts : [];
      const effects: PublicationEffect[] = [];
      for (const fact of selected) {
        if (fact.family === 'liekan_event_observation')
          fact.row.epoch = String(context?.epoch ?? 1);
        if (fact.family === 'liekan_event_quality')
          fact.row.repair_scope_id = context?.repair_scope_id ?? null;
      }
      if (status !== 'conflict' && e.data.hasQuality === true && e.kind !== 'identify') {
        const observation = selected.find(f => f.family === 'liekan_event_observation')?.row;
        effects.push({
          kind: 'collection-state',
          diagnosticAt: e.receivedAt,
          ...(observation
            ? {
                observation: {
                  epoch: String(observation.epoch),
                  receivedAt: `${String(observation.received_at).replace(' ', 'T')}Z`,
                  version: String(observation.version),
                },
              }
            : {}),
        });
        const bucket = new Date(e.receivedAt);
        bucket.setUTCSeconds(0, 0);
        selected.push({
          family: 'liekan_collection_diagnostic',
          row: factInput('liekan_collection_diagnostic', {
            website_id: e.websiteId,
            bucket,
            shard: createHash('sha256').update(e.inputId).digest()[0] % 32,
            written: status === 'new' ? 1 : 0,
            with_uuid: status === 'new' && e.clientEventId ? 1 : 0,
            duplicate: status === 'duplicate' ? 1 : 0,
            first_at: e.receivedAt,
            last_at: e.receivedAt,
          }),
        });
      }
      return {
        input,
        status,
        sessionId: receipt?.original_session ?? e.sessionId,
        visitId: receipt?.original_visit ?? e.visitId,
        facts: selected,
        effects,
      } satisfies LandedDecision;
    });
  };
}
