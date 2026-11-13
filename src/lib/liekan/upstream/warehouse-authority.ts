import { getRecorderConfig } from '@/lib/recorder';
import { validateSource } from '../log-ingestion/service';
import type { Attempt } from '../warehouse/control';
import type { ControlDatabase, ControlSQL } from '../warehouse/control-db';
import { WarehouseConflict } from '../warehouse/control-db';
import type { LandedDecision } from '../warehouse/landing';
import { validateLogPackage } from '../warehouse/log-planner';
import { confirmWarehouseTasks, type TaskAuthority } from '../warehouse/tasks';
import { LiekanError, lockWritableWebsite } from './server';

export function warehouseControlAdapter(tx: ControlSQL) {
  return {
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
      (await tx.query(sql, values)).rows,
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
      (await tx.query(sql, values)).rowCount,
  };
}
type UploadIdentity = { batchId: string; websiteId: string; epoch: string };
async function recorderKinds(tx: ControlSQL, websiteId: string, lock = false) {
  const [website] = (
    await tx.query<{ recorder_enabled: boolean; replay_config: unknown }>(
      `SELECT recorder_enabled,replay_config FROM website WHERE website_id=$1::uuid AND deleted_at IS NULL ${lock ? 'FOR SHARE' : ''}`,
      [websiteId],
    )
  ).rows;
  const permitted = new Set<string>();
  if (website?.recorder_enabled) {
    const config = getRecorderConfig(website.replay_config);
    if (config.replayEnabled) permitted.add('replay');
    if (config.heatmapEnabled) permitted.add('heatmap');
  }
  return permitted;
}
export function authorizeWarehouseRecorder(db: ControlDatabase) {
  return (websiteId: string) => db.transaction(tx => recorderKinds(tx, websiteId));
}
async function allowed(tx: ControlSQL, input: UploadIdentity) {
  const [upload] = (
    await tx.query<{
      actor_id: string | null;
      source_id: string | null;
      source_epoch: number;
      kind: string;
      warehouse_epoch: string;
      status: string;
    }>('SELECT * FROM liekan_warehouse_upload WHERE batch_id=$1::uuid AND website_id=$2::uuid', [
      input.batchId,
      input.websiteId,
    ])
  ).rows;
  if (!upload || upload.status !== 'pending' || upload.warehouse_epoch !== input.epoch)
    return false;
  try {
    const sql = warehouseControlAdapter(tx);
    if (upload.kind === 'automatic') {
      const live = await validateSource(sql, upload.source_id, undefined, true, 'share');
      return live.source.website_id === input.websiteId && live.epoch === upload.source_epoch;
    }
    if (!upload.actor_id) return false;
    await lockWritableWebsite(sql, input.websiteId, { userId: upload.actor_id }, 'share');
    const [state] = (
      await tx.query<{ epoch: number }>(
        'SELECT epoch FROM liekan_log_state WHERE website_id=$1::uuid',
        [input.websiteId],
      )
    ).rows;
    return (state?.epoch ?? 1) === upload.source_epoch;
  } catch (error) {
    if (error instanceof LiekanError && [401, 403, 404, 409].includes(error.status)) return false;
    throw error;
  }
}

// Preflight can select a durable cancelled outcome for revoked sources. The
// confirmation check below repeats authority under the same short PG transaction
// as the accepted decision, closing the revoke-between-check-and-commit window.
export function authorizeWarehouseUploads(db: ControlDatabase) {
  return async (inputs: UploadIdentity[]) =>
    db.transaction(async tx => {
      const permitted = new Set<string>();
      for (const input of [...inputs].sort((a, b) => a.batchId.localeCompare(b.batchId)))
        if (await allowed(tx, input)) permitted.add(input.batchId);
      return permitted;
    });
}
export const authorizeWarehouseTask: TaskAuthority = async (tx, site, result) => {
  try {
    await lockWritableWebsite(
      warehouseControlAdapter(tx),
      site,
      { userId: result.actorId },
      'share',
    );
    if (result.kind === 'history-repair-input') {
      const [run] = (
        await tx.query<any>(
          `SELECT * FROM liekan_history_repair_run WHERE id=$1 AND website_id=$2 AND generation=$3
        AND revision=$4 AND input_revision=$5 AND scope_revision=$6 AND NOT scope_changed
        AND (confirmed_at IS NULL OR status='rolled_back') AND status NOT IN('scanning','preparing','queued','running','validating','expired','invalidated','cancelled') FOR SHARE`,
          [
            result.runId,
            site,
            result.generation,
            result.revision,
            result.inputRevision,
            result.scopeRevision,
          ],
        )
      ).rows;
      if (
        !run ||
        run.snapshot.authorityHash !== result.authorityHash ||
        run.snapshot.rulepack.hash !== result.rulepack
      )
        return false;
      await (await import('./crawler-registry-context')).withPublishedRegistry(() =>
        import('./history-repair-db').then(m =>
          m.assertSnapshot(warehouseControlAdapter(tx) as any, run, true),
        ),
      );
      return true;
    }
    if (result.kind === 'history-repair-batch') {
      const [run] = (
        await tx.query<any>(
          `SELECT * FROM liekan_history_repair_run WHERE id=$1 AND website_id=$2 AND generation=$3 AND actor_id=$4
        AND revision=$5 AND input_revision=$6 AND scope_revision=$7 AND NOT scope_changed AND status=$8 AND phase=$9 AND cursor=$10::jsonb FOR SHARE`,
          [
            result.runId,
            site,
            result.generation,
            result.actorId,
            result.revision,
            result.inputRevision,
            result.scopeRevision,
            result.beforeStatus,
            result.beforePhase,
            JSON.stringify(result.beforeCursor),
          ],
        )
      ).rows;
      if (!run || run.snapshot.authorityHash !== result.authorityHash) return false;
      await (await import('./history-repair-db')).assertSnapshot(
        warehouseControlAdapter(tx) as any,
        run,
        false,
      );
      return true;
    }
    const found = await tx.query(
      `SELECT 1 FROM liekan_traffic_exclusion x
      LEFT JOIN liekan_log_state l ON l.website_id=x.website_id
      WHERE x.id=$1::uuid AND x.website_id=$2::uuid AND x.actor_id=$3::uuid
        AND x.state='preview' AND x.expires_at>clock_timestamp() AND x.epoch=coalesce(l.epoch,1)
        AND x.membership_digest=$4 AND x.window_end=$5::timestamptz FOR SHARE OF x`,
      [result.collectionId, site, result.actorId, result.digest, result.windowEnd],
    );
    return !!found.rowCount;
  } catch (error) {
    if (error instanceof LiekanError && [401, 403, 404, 409].includes(error.status)) return false;
    throw error;
  }
};
export async function confirmWarehouseAuthority(
  tx: ControlSQL,
  attempt: Attempt,
  decisions: LandedDecision[],
) {
  await confirmWarehouseTasks(tx, attempt, decisions, authorizeWarehouseTask);
  const recording = decisions.filter(
    d => ['replay', 'heatmap'].includes(d.input.envelope.kind) && d.status !== 'cancelled',
  );
  if (recording.length) {
    const permitted = await recorderKinds(tx, attempt.website_id, true);
    if (recording.some(d => !permitted.has(d.input.envelope.kind)))
      throw new WarehouseConflict('warehouse-recorder-configuration-changed');
  }
  const batches = new Set<string>();
  for (const decision of decisions) {
    if (decision.input.envelope.kind !== 'log' || decision.status === 'cancelled') continue;
    const { packet } = validateLogPackage(decision.input.envelope);
    batches.add(packet.batchId);
  }
  for (const batchId of [...batches].sort())
    if (!(await allowed(tx, { batchId, websiteId: attempt.website_id, epoch: attempt.epoch })))
      throw new WarehouseConflict('warehouse-upload-authority-changed');
  const logFacts = decisions.filter(
    d =>
      d.status === 'new' &&
      d.input.envelope.kind === 'log' &&
      d.facts.some(f => f.family === 'liekan_log'),
  );
  if (logFacts.length) {
    const imports = (
      await tx.query<{ id: string; repair_scope_id: string | null }>(
        'SELECT id,repair_scope_id FROM liekan_import WHERE website_id=$1 AND id=ANY($2::uuid[]) FOR SHARE',
        [attempt.website_id, [...batches]],
      )
    ).rows;
    for (const d of logFacts)
      for (const effect of d.effects ?? []) {
        if (effect.kind !== 'log-upload') continue;
        const parent = imports.find(i => i.id === effect.batchId);
        if (
          !effect.scopeProof ||
          effect.scopeProof.present !== !!parent ||
          effect.scopeProof.repairScopeId !== (parent?.repair_scope_id ?? null)
        )
          throw new WarehouseConflict('warehouse-import-scope-changed');
      }
  }
  if (decisions.some(d => d.input.envelope.kind !== 'log' && d.status !== 'cancelled')) {
    const [site] = (
      await tx.query<{ resource_type: string }>(
        'SELECT resource_type FROM liekan_warehouse_site WHERE website_id=$1::uuid',
        [attempt.website_id],
      )
    ).rows;
    if (!site || !['website', 'link', 'pixel'].includes(site.resource_type))
      throw new WarehouseConflict('warehouse-resource-unavailable');
    const exists = await tx.query(
      `SELECT ${site.resource_type}_id FROM ${site.resource_type} WHERE ${site.resource_type}_id=$1::uuid AND deleted_at IS NULL FOR SHARE`,
      [attempt.website_id],
    );
    if (!exists.rowCount) throw new WarehouseConflict('warehouse-resource-unavailable');
    const browser = decisions.filter(
      d =>
        d.status === 'new' &&
        d.facts.some(
          f => f.family === 'liekan_event_quality' || f.family === 'liekan_event_observation',
        ),
    );
    if (browser.length) {
      // The website SHARE lock above serializes with a new repair scope/reset.
      // A package planned before that boundary must be planned again, never
      // silently assigned to the earlier frozen population after confirmation.
      const [context] = (
        await tx.query<{ epoch: string; repair_scope_id: string | null }>(
          `SELECT coalesce(l.epoch,1)::text AS epoch,r.repair_scope_id FROM website w
        LEFT JOIN liekan_log_state l ON l.website_id=w.website_id
        LEFT JOIN liekan_history_repair_run r ON r.website_id=w.website_id AND r.campaign_id='traffic-quality-repair-20261022-v1'
        WHERE w.website_id=$1::uuid`,
          [attempt.website_id],
        )
      ).rows;
      for (const d of browser)
        for (const f of d.facts) {
          if (
            (f.family === 'liekan_event_quality' &&
              f.row.repair_scope_id !== (context?.repair_scope_id ?? null)) ||
            (f.family === 'liekan_event_observation' &&
              String(f.row.epoch) !== (context?.epoch ?? '1'))
          )
            throw new WarehouseConflict('warehouse-collection-context-changed');
        }
    }
  }
}
