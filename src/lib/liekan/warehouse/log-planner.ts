import type { ClickHouseClient } from '@clickhouse/client';
import { recordKey, validateWireRow } from './codec';
import type { DecisionPlanner } from './consumer';
import type { ControlDatabase } from './control-db';
import type { SiteState } from './control';
import { stableOperation } from './identifiers';
import type { FactMutation, LandedDecision } from './landing';
import type { LogPackage } from './log-package';
import { boundaryParameters, factRelation } from './read';
import type { InputEnvelope } from './routing';

export function validateLogPackage(e: InputEnvelope): {
  packet: LogPackage;
  facts: FactMutation[];
} {
  const p = e.data as unknown as LogPackage;
  if (
    e.kind !== 'log' ||
    p.format !== 'log-v1' ||
    !['automatic', 'manual'].includes(p.kind) ||
    !Number.isSafeInteger(p.sourceEpoch) ||
    p.sourceEpoch < 1 ||
    !Number.isSafeInteger(p.recordIndex) ||
    p.recordIndex < 0 ||
    !Array.isArray(p.facts) ||
    p.facts.length < 2 ||
    p.facts.length > 3
  )
    throw new Error('warehouse-invalid-log-package');
  const counts = new Map<string, number>();
  const facts = p.facts.map(f => {
    if (!['liekan_log', 'liekan_log_geography', 'liekan_crawler_evidence'].includes(f.family))
      throw new Error('warehouse-log-family-mismatch');
    const row = validateWireRow(f.family, f.row);
    if (row.website_id !== e.websiteId) throw new Error('warehouse-log-site-mismatch');
    counts.set(f.family, (counts.get(f.family) ?? 0) + 1);
    return { family: f.family, row };
  });
  if (
    counts.get('liekan_log') !== 1 ||
    counts.get('liekan_crawler_evidence') !== 1 ||
    (counts.get('liekan_log_geography') ?? 0) > 1
  )
    throw new Error('warehouse-log-package-incomplete');
  const row = facts.find(f => f.family === 'liekan_log').row;
  if (
    row.import_id !== p.batchId ||
    row.source_id !== p.sourceId ||
    facts.some(f => f.family !== 'liekan_log' && f.row.log_id !== row.id) ||
    e.clientEventId !== stableOperation(['log-receipt', e.websiteId, String(row.id)]) ||
    e.inputId !==
      stableOperation(['log-input', p.batchId, String(row.id), String(p.recordIndex)]) ||
    (p.kind === 'automatic' && row.event_digest !== e.fingerprint)
  )
    throw new Error('warehouse-log-identity-mismatch');
  return { packet: p, facts };
}

export function logPlanner(
  db: ControlDatabase,
  ch: ClickHouseClient,
  authorize?: (
    inputs: { batchId: string; websiteId: string; epoch: string }[],
  ) => Promise<Set<string>>,
  lookup?: (
    state: SiteState,
    ids: string[],
  ) => Promise<{ id: string; event_digest: string | null }[]>,
): DecisionPlanner {
  return async (inputs, state) => {
    const parsed = inputs.map(input => ({ input, ...validateLogPackage(input.envelope) }));
    const uploads = await db.read<{
      batch_id: string;
      source_id: string | null;
      source_epoch: number;
      status: string;
      kind: string;
      import_present: boolean;
      repair_scope_id: string | null;
    }>(
      'SELECT u.*,i.id IS NOT NULL AS import_present,i.repair_scope_id FROM liekan_warehouse_upload u LEFT JOIN liekan_import i ON i.id=u.batch_id AND i.website_id=u.website_id WHERE u.website_id=$1::uuid AND u.batch_id=ANY($2::uuid[])',
      [state.website_id, parsed.map(p => p.packet.batchId)],
    );
    for (const { packet } of parsed) {
      const upload = uploads.find(u => u.batch_id === packet.batchId);
      if (
        !upload ||
        upload.source_id !== packet.sourceId ||
        upload.source_epoch !== packet.sourceEpoch ||
        upload.kind !== packet.kind ||
        upload.status !== 'pending'
      )
        throw new Error('warehouse-log-upload-unavailable');
    }
    const permitted = authorize
      ? await authorize(
          uploads.map(u => ({
            batchId: u.batch_id,
            websiteId: state.website_id,
            epoch: state.epoch,
          })),
        )
      : new Set(uploads.map(u => u.batch_id));
    const rows = lookup
      ? await lookup(
          state,
          parsed.map(p => String(p.facts.find(f => f.family === 'liekan_log').row.id)),
        )
      : await ch
          .query({
            query: `SELECT id,event_digest FROM ${factRelation('liekan_log', { recordKeysParameter: 'logKeys' })}`,
            query_params: {
              ...boundaryParameters({
                websiteId: state.website_id,
                epoch: state.epoch,
                publication: state.publication,
                deletionRevision: state.deletion_revision,
              }),
              logKeys: parsed.map(p =>
                recordKey('liekan_log', p.facts.find(f => f.family === 'liekan_log').row),
              ),
            },
            format: 'JSONEachRow',
          })
          .then(r => r.json<{ id: string; event_digest: string | null }>());
    const existing = new Map(rows.map(r => [r.id, r.event_digest]));
    return parsed.map(({ input, packet, facts }) => {
      const row = facts.find(f => f.family === 'liekan_log').row,
        id = String(row.id);
      const status = !permitted.has(packet.batchId)
        ? 'cancelled'
        : existing.has(id)
          ? packet.kind === 'automatic' && existing.get(id) !== row.event_digest
            ? 'conflict'
            : 'duplicate'
          : 'new';
      if (status === 'new') existing.set(id, row.event_digest as string | null);
      const upload = uploads.find(u => u.batch_id === packet.batchId);
      return {
        input,
        status,
        sessionId: null,
        visitId: null,
        facts: status === 'new' ? facts : [],
        effects: [
          {
            kind: 'log-upload',
            batchId: packet.batchId,
            scopeProof: { present: upload.import_present, repairScopeId: upload.repair_scope_id },
            ...(status === 'new' ? { geoDay: String(row.created_at).slice(0, 10) } : {}),
            processed: 1,
            inserted: status === 'new' ? 1 : 0,
            duplicates: status === 'duplicate' ? 1 : 0,
            conflicts: status === 'conflict' ? 1 : 0,
            cancelled: status === 'cancelled' ? 1 : 0,
          },
        ],
      } satisfies LandedDecision;
    });
  };
}
