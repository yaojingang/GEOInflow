import type { ControlSQL } from './control-db';
import { WarehouseConflict } from './control-db';
import { applyWarehouseTask } from './tasks';
export type UploadEffect = {
  kind: 'log-upload';
  batchId: string;
  processed: number;
  inserted: number;
  duplicates: number;
  conflicts: number;
  cancelled?: number;
  scopeProof?: { present: boolean; repairScopeId: string | null };
  geoDay?: string;
};
export type CollectionStateEffect = {
  kind: 'collection-state';
  diagnosticAt: string;
  observation?: { epoch: string; receivedAt: string; version: string };
};
export type PublicationEffect =
  | UploadEffect
  | CollectionStateEffect
  | { kind: 'analysis-task'; taskId: string; cancelled: boolean };
export function validateEffects(effects: PublicationEffect[], inputs: number): PublicationEffect[] {
  let count = 0;
  for (const e of effects) {
    if (e.kind === 'analysis-task') {
      if (!/^[0-9a-f-]{36}$/.test(e.taskId) || typeof e.cancelled !== 'boolean')
        throw new Error('Invalid warehouse task effect');
      count++;
      continue;
    }
    if (e.kind === 'collection-state') {
      if (
        !Number.isFinite(Date.parse(e.diagnosticAt)) ||
        (e.observation &&
          (!/^\d+$/.test(e.observation.epoch) ||
            !Number.isFinite(Date.parse(e.observation.receivedAt)) ||
            !e.observation.version ||
            e.observation.version.length > 100))
      )
        throw new Error('Invalid collection state effect');
      count++;
      continue;
    }
    if (
      e.kind !== 'log-upload' ||
      (e.geoDay !== undefined &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(e.geoDay) || !Number.isFinite(Date.parse(e.geoDay)))) ||
      (e.scopeProof &&
        (typeof e.scopeProof.present !== 'boolean' ||
          (e.scopeProof.repairScopeId !== null &&
            !/^[a-f0-9-]{36}$/.test(e.scopeProof.repairScopeId)))) ||
      !/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(e.batchId) ||
      [e.processed, e.inserted, e.duplicates, e.conflicts, e.cancelled ?? 0].some(
        n => !Number.isSafeInteger(n) || n < 0,
      ) ||
      e.processed !== e.inserted + e.duplicates + e.conflicts + (e.cancelled ?? 0)
    )
      throw new Error('Invalid warehouse publication effects');
    count += e.processed;
  }
  if (count > inputs || effects.length > inputs)
    throw new Error('Invalid warehouse publication effect count');
  return effects;
}
export async function applyPublicationEffects(tx: ControlSQL, attemptIds: string[]) {
  const attempts = (
    await tx.query<{ website_id: string; effects: PublicationEffect[] }>(
      `SELECT website_id,effects FROM liekan_warehouse_attempt
    WHERE attempt_id=ANY($1::uuid[]) AND status='confirmed' AND NOT effects_applied FOR UPDATE`,
      [attemptIds],
    )
  ).rows;
  const batches = new Map<string, UploadEffect & { websiteId: string }>();
  const collection = new Map<string, CollectionStateEffect[]>();
  const geoDays = new Map<string, Set<string>>();
  for (const attempt of attempts)
    for (const e of attempt.effects) {
      if (e.kind === 'analysis-task') {
        await applyWarehouseTask(tx, attempt.website_id, e.taskId, e.cancelled);
        continue;
      }
      if (e.kind === 'collection-state') {
        const rows = collection.get(attempt.website_id) ?? [];
        rows.push(e);
        collection.set(attempt.website_id, rows);
        continue;
      }
      const sum = batches.get(e.batchId) ?? {
        ...e,
        websiteId: attempt.website_id,
        processed: 0,
        inserted: 0,
        duplicates: 0,
        conflicts: 0,
        cancelled: 0,
      };
      if (e.inserted && e.geoDay) {
        const days = geoDays.get(attempt.website_id) ?? new Set<string>();
        days.add(e.geoDay);
        geoDays.set(attempt.website_id, days);
      }
      if (sum.websiteId !== attempt.website_id) throw new Error('Cross-site publication effect');
      for (const k of ['processed', 'inserted', 'duplicates', 'conflicts'] as const) sum[k] += e[k];
      sum.cancelled += e.cancelled ?? 0;
      batches.set(e.batchId, sum);
    }
  for (const [site, days] of geoDays) {
    // This runs in the same publication commit. Replayed attempts never advance
    // proof twice, and ordinary unreferenced days create no control rows.
    const changed = await tx.query(
      `WITH ranges AS(
      SELECT d::date::timestamp AT TIME ZONE 'UTC' AS starts,(d::date+1)::timestamp AT TIME ZONE 'UTC' AS ends FROM unnest($2::text[]) d
    ) INSERT INTO liekan_geo_weight_evidence_revision(website_id,starts_at,ends_at)
      SELECT $1,starts,ends FROM ranges r WHERE EXISTS(SELECT 1 FROM liekan_geo_weight_snapshot s WHERE s.website_id=$1 AND s.expires_at>now()
        AND to_timestamp((s.input_boundary->'window'->>'startAt')::double precision/1000)<r.ends
        AND to_timestamp((s.input_boundary->'window'->>'endAt')::double precision/1000)>r.starts)
      OR EXISTS(SELECT 1 FROM liekan_geo_weight_head h WHERE h.website_id=$1 AND h.task_status IN('queued','running')
        AND ((h.as_of-59)::timestamp AT TIME ZONE h.timezone)<r.ends AND ((h.as_of+1)::timestamp AT TIME ZONE h.timezone)>r.starts)
      ON CONFLICT(website_id,starts_at,ends_at) DO UPDATE SET revision=nextval('liekan_geo_weight_evidence_revision_revision_seq'),created_at=now()`,
      [site, [...days]],
    );
    if (changed.rowCount)
      await tx.query(
        'UPDATE liekan_log_state SET policy_revision=policy_revision+1 WHERE website_id=$1',
        [site],
      );
  }
  for (const [site, states] of collection) {
    const diagnosticAt = states
      .map(s => s.diagnosticAt)
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    await tx.query(
      `INSERT INTO liekan_collection_diagnostic_state(website_id,started_at) VALUES($1::uuid,$2::timestamptz)
      ON CONFLICT(website_id) DO UPDATE SET started_at=least(liekan_collection_diagnostic_state.started_at,EXCLUDED.started_at)`,
      [site, diagnosticAt],
    );
    // A delayed queue publication can affect already observed minute windows.
    // Rewind progress; a concurrent task may publish its snapshot but cannot
    // advance this earlier cursor past the new input.
    await tx.query(
      `UPDATE liekan_browser_risk_state SET next_window=least(next_window,date_trunc('minute',$2::timestamptz)+interval '1 minute'),next_attempt_at=clock_timestamp()
      WHERE website_id=$1 AND $2::timestamptz>clock_timestamp()-interval '30 days'`,
      [site, diagnosticAt],
    );
    const observations = states.flatMap(s => (s.observation ? [s.observation] : []));
    for (const epoch of new Set(observations.map(o => o.epoch))) {
      const rows = observations
        .filter(o => o.epoch === epoch)
        .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
      await tx.query(
        `INSERT INTO liekan_observation_state(website_id,epoch,first_received_at,last_received_at,last_version)
        SELECT $1::uuid,$2::integer,$3::timestamptz,$4::timestamptz,$5 WHERE $2::integer=coalesce((SELECT epoch FROM liekan_log_state WHERE website_id=$1::uuid),1)
        ON CONFLICT(website_id) DO UPDATE SET
          first_received_at=CASE WHEN liekan_observation_state.epoch=EXCLUDED.epoch THEN least(liekan_observation_state.first_received_at,EXCLUDED.first_received_at) ELSE EXCLUDED.first_received_at END,
          last_received_at=CASE WHEN liekan_observation_state.epoch=EXCLUDED.epoch THEN greatest(liekan_observation_state.last_received_at,EXCLUDED.last_received_at) ELSE EXCLUDED.last_received_at END,
          last_version=CASE WHEN liekan_observation_state.epoch<>EXCLUDED.epoch OR EXCLUDED.last_received_at>=liekan_observation_state.last_received_at THEN EXCLUDED.last_version ELSE liekan_observation_state.last_version END,epoch=EXCLUDED.epoch`,
        [site, epoch, rows[0].receivedAt, rows.at(-1).receivedAt, rows.at(-1).version],
      );
    }
  }
  for (const e of [...batches.values()].sort((a, b) => a.batchId.localeCompare(b.batchId))) {
    const [batch] = (
      await tx.query<{
        inserted: number;
        duplicates: number;
        conflicts: number;
        processed: number;
        expected: number;
        status: string;
        source_id: string | null;
      }>(
        `UPDATE liekan_warehouse_upload SET processed=processed+$3,inserted=inserted+$4,duplicates=duplicates+$5,conflicts=conflicts+$6,cancelled=cancelled+$7,
      status=CASE WHEN status='cancelled' THEN 'cancelled' WHEN processed+$3=expected THEN CASE WHEN conflicts+$6>0 THEN 'failed' WHEN cancelled+$7>0 THEN 'cancelled' ELSE 'processed' END ELSE 'pending' END,
      updated_at=clock_timestamp() WHERE batch_id=$1::uuid AND website_id=$2::uuid AND status IN ('pending','cancelled') AND processed+$3<=expected RETURNING *`,
        [
          e.batchId,
          e.websiteId,
          e.processed,
          e.inserted,
          e.duplicates,
          e.conflicts,
          e.cancelled ?? 0,
        ],
      )
    ).rows;
    if (!batch) throw new WarehouseConflict('warehouse-upload-effect-conflict');
    await tx.query(
      `UPDATE liekan_ingest_batch SET inserted=$2,duplicates=$3,rejected=rejected+$4,
      state=$5,processed_at=CASE WHEN $5<>'pending' THEN clock_timestamp() ELSE NULL END WHERE id=$1::uuid`,
      [e.batchId, batch.inserted, batch.duplicates, e.conflicts, batch.status],
    );
    await tx.query('UPDATE liekan_import SET inserted=$2,accepted=$2 WHERE id=$1::uuid', [
      e.batchId,
      batch.inserted,
    ]);
    if (e.inserted) {
      await tx.query(
        `INSERT INTO liekan_log_state(website_id,data_revision) VALUES($1::uuid,1)
        ON CONFLICT(website_id) DO UPDATE SET data_revision=liekan_log_state.data_revision+1,updated_at=clock_timestamp()`,
        [e.websiteId],
      );
      if (batch.source_id)
        await tx.query(
          'UPDATE liekan_log_source SET last_processed_at=clock_timestamp() WHERE id=$1::uuid',
          [batch.source_id],
        );
    }
  }
  await tx.query(
    `UPDATE liekan_warehouse_attempt SET effects_applied=true
    WHERE attempt_id=ANY($1::uuid[]) AND status='confirmed' AND NOT effects_applied`,
    [attemptIds],
  );
}
