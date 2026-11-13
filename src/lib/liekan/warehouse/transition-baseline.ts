import { factTables } from './catalog';
import { type ControlDatabase, WarehouseConflict } from './control-db';

type Baseline = {
  migration_id: string;
  sequence: string;
  source_snapshot: string;
  verified_digest: string;
  status: string;
};
export async function establishTransitionBaseline(db: ControlDatabase, migrationId: string) {
  const baseline = await db.transaction(async tx => {
    const [installation] = (
      await tx.query<{ installation_id: string; authority: string }>(
        'SELECT installation_id,authority FROM liekan_warehouse_installation WHERE id=1 FOR SHARE',
      )
    ).rows;
    if (!installation || !['postgres', 'frozen'].includes(installation.authority))
      throw new WarehouseConflict('warehouse-baseline-requires-postgres');
    const [transition] = (
      await tx.query<{
        transition_id: string;
        migration_id: string;
        sequence: string;
        sent_sequence: string;
        ch_sequence: string;
        pg_sequence: string;
        state: string;
      }>('SELECT * FROM liekan_warehouse_transition WHERE id=1 FOR UPDATE')
    ).rows;
    const [migration] = (
      await tx.query<{
        source_snapshot: string;
        verified_digest: string;
        boundary: any;
        phase: string;
      }>('SELECT * FROM liekan_warehouse_migration WHERE migration_id=$1 FOR SHARE', [migrationId])
    ).rows;
    const [prior] = (
      await tx.query<Baseline>('SELECT * FROM liekan_warehouse_transition_baseline WHERE id=1')
    ).rows;
    if (prior) {
      if (
        prior.migration_id !== migrationId ||
        prior.source_snapshot !== migration?.source_snapshot ||
        prior.verified_digest !== migration?.verified_digest
      )
        throw new WarehouseConflict('warehouse-baseline-conflict');
      return prior;
    }
    const boundary = migration?.boundary?.sourceControl;
    const sequence = String(boundary?.capture?.sequence ?? '0');
    const families = (
      await tx.query<{ family: string; status: string }>(
        'SELECT family,status FROM liekan_warehouse_migration_family WHERE migration_id=$1',
        [migrationId],
      )
    ).rows;
    if (
      !migration ||
      migration.phase !== 'verify' ||
      !migration.verified_digest ||
      families.length !== factTables.length ||
      factTables.some(t => !families.some(f => f.family === t.name && f.status === 'verified'))
    )
      throw new WarehouseConflict('warehouse-baseline-source-not-verified');
    if (
      !transition ||
      transition.migration_id !== migrationId ||
      !['capturing', 'frozen'].includes(transition.state) ||
      !/^\d+$/.test(sequence) ||
      BigInt(sequence) > BigInt(transition.sequence) ||
      [transition.sent_sequence, transition.ch_sequence, transition.pg_sequence].some(
        s => s !== '0',
      )
    )
      throw new WarehouseConflict('warehouse-baseline-stream-already-started');
    if (
      boundary?.installation &&
      boundary.installation.installation_id !== installation.installation_id
    )
      throw new WarehouseConflict('warehouse-baseline-installation-mismatch');
    if (
      boundary?.mode !== 'offline-backup' &&
      boundary?.capture?.transition_id !== transition.transition_id
    )
      throw new WarehouseConflict('warehouse-baseline-source-boundary-missing');
    if (
      (
        await tx.query(
          "SELECT 1 FROM liekan_warehouse_publication p WHERE EXISTS(SELECT 1 FROM liekan_warehouse_attempt a,jsonb_array_elements(p.manifest) m WHERE a.attempt_id=(m->>'attemptId')::uuid) LIMIT 1",
        )
      ).rowCount
    )
      throw new WarehouseConflict('warehouse-baseline-shadow-already-published');
    await tx.query(
      'UPDATE liekan_warehouse_transition SET generation=generation+1,owner_id=NULL,lease_until=NULL WHERE id=1',
    );
    return (
      await tx.query<Baseline>(
        `INSERT INTO liekan_warehouse_transition_baseline(id,migration_id,sequence,source_snapshot,verified_digest,status)
      VALUES(1,$1,$2,$3,$4,'preparing') RETURNING *`,
        [migrationId, sequence, migration.source_snapshot, migration.verified_digest],
      )
    ).rows[0];
  });
  if (baseline.status === 'ready') return baseline;
  for (;;) {
    const count = await db.transaction(async tx => {
      await tx.query('SELECT id FROM liekan_warehouse_transition WHERE id=1 FOR UPDATE');
      const rows = await tx.query(
        `UPDATE liekan_warehouse_attempt a SET status='projected',decision_projected=true,updated_at=clock_timestamp()
        WHERE a.attempt_id IN(SELECT a.attempt_id FROM liekan_warehouse_attempt a
          JOIN liekan_warehouse_transition_result r ON r.operation_id=a.attempt_id
          WHERE r.sequence<=$1 AND r.authority='postgres' AND r.kind='decision' AND a.status='confirmed' AND a.effects_applied
          ORDER BY r.sequence LIMIT 2000)`,
        [baseline.sequence],
      );
      return rows.rowCount ?? 0;
    });
    if (count < 2000) break;
  }
  return db.transaction(async tx => {
    await tx.query('SELECT id FROM liekan_warehouse_transition WHERE id=1 FOR UPDATE');
    if (
      (
        await tx.query(
          `SELECT 1 FROM liekan_warehouse_attempt a JOIN liekan_warehouse_transition_result r ON r.operation_id=a.attempt_id
      WHERE r.sequence<=$1 AND (a.status<>'projected' OR NOT a.effects_applied) LIMIT 1`,
          [baseline.sequence],
        )
      ).rowCount
    )
      throw new WarehouseConflict('warehouse-baseline-authority-incomplete');
    const changed = await tx.query(
      `UPDATE liekan_warehouse_transition SET sent_sequence=$1,ch_sequence=$1,pg_sequence=$1,updated_at=clock_timestamp()
      WHERE id=1 AND sent_sequence=0 AND ch_sequence=0 AND pg_sequence=0 AND state IN('capturing','frozen') RETURNING id`,
      [baseline.sequence],
    );
    if (!changed.rowCount) {
      const [ready] = (
        await tx.query<Baseline>('SELECT * FROM liekan_warehouse_transition_baseline WHERE id=1')
      ).rows;
      if (ready?.status === 'ready') return ready;
      throw new WarehouseConflict('warehouse-baseline-stream-changed');
    }
    return (
      await tx.query<Baseline>(
        "UPDATE liekan_warehouse_transition_baseline SET status='ready',updated_at=clock_timestamp() WHERE id=1 RETURNING *",
      )
    ).rows[0];
  });
}
