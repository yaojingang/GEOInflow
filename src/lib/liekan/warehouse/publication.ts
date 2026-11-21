import { projectPropertyProofs } from './property-proof';
import { createHash, randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { CandidateWriter, type StoredFact } from './candidate';
import { factTable } from './catalog';
import type { Attempt } from './control';
import { type ControlDatabase, type ControlSQL, WarehouseConflict } from './control-db';
import { deriveCandidates } from './derivation-plan';
import { applyPublicationEffects } from './effects';
import { stableOperation } from './identifiers';
import { LandingStore } from './landing';
import { projectLogScopeProofs } from './log-scope-proof';
import { type PublicationTrace, tracePublication } from './publication-timing';
import { projectRiskProofs } from './risk-proof';
import { setTimeout as delay } from 'node:timers/promises';

export type ManifestEntry = {
  attemptId: string;
  family: string;
  candidateId: string;
  rowCount: string;
  digest: string;
};
type Publication = {
  operation_id: string;
  website_id: string;
  epoch: string;
  publication: string;
  manifest: ManifestEntry[];
  manifest_digest: string;
  status: string;
  created_at: Date;
};

export function manifestDigest(entries: ManifestEntry[]) {
  const normalized = entries
    .map(e => {
      factTable(e.family);
      if (!/^[0-9a-f]{64}$/.test(e.digest) || !/^\d+$/.test(e.rowCount))
        throw new Error('Invalid publication entry');
      return [e.attemptId, e.family, e.candidateId, e.rowCount, e.digest];
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  if (
    !entries.length ||
    entries.length > 2600 ||
    new Set(entries.map(e => `${e.attemptId}:${e.family}`)).size !== entries.length
  )
    throw new Error('Invalid publication manifest');
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

// A migration may finish an old epoch after PG has accepted a reset/delete.
// Only immutable source checkpoints or captured PG outcomes grant this right;
// ordinary CH work remains fenced by the current resource epoch and state.
async function historicalPublication(
  tx: ControlSQL,
  site: string,
  epoch: string,
  entries: ManifestEntry[],
) {
  const [result] = (
    await tx.query<{ valid: boolean }>(
      `SELECT bool_and(
    EXISTS(SELECT 1 FROM liekan_warehouse_transition_result r JOIN liekan_warehouse_transition t ON t.id=1
      WHERE r.operation_id=e.attempt AND r.website_id=$1 AND r.epoch=$2 AND r.authority='postgres'
      AND r.kind='decision' AND t.state<>'closed')
    OR EXISTS(SELECT 1 FROM liekan_warehouse_checkpoint c JOIN liekan_warehouse_migration m USING(migration_id)
      WHERE c.candidate_id=e.candidate AND c.family=e.family AND c.status IN('verified','published')
      AND m.phase IN('backfill','verify','shadow','frozen') AND m.boundary->'sites'->>$1::text=$2::text)
    ) AS valid FROM jsonb_to_recordset($3::jsonb) e(attempt uuid,candidate uuid,family text)`,
      [
        site,
        epoch,
        JSON.stringify(
          entries.map(e => ({ attempt: e.attemptId, candidate: e.candidateId, family: e.family })),
        ),
      ],
    )
  ).rows;
  return result?.valid === true;
}

export class WarehousePublisher {
  constructor(
    private readonly db: ControlDatabase,
    private readonly ch: ClickHouseClient,
  ) {}

  async reserve(
    websiteId: string,
    epoch: string,
    entries: ManifestEntry[],
    operationId: string = randomUUID(),
    trace?: PublicationTrace,
    recovering = false,
  ): Promise<Publication> {
    const digest = manifestDigest(entries);
    // Verify the complete sealed package outside the control transaction. A valid
    // subset (for example events without properties/revenue) cannot be published.
    const landing = new LandingStore(this.ch);
    const attemptIds = [...new Set(entries.map(entry => entry.attemptId))];
    const recoveryRows = new Map<string, StoredFact[]>();
    for (const id of attemptIds) {
      const [attempt] = await tracePublication(trace, 'reserve.attempt', () =>
        this.db.read<Attempt>('SELECT * FROM liekan_warehouse_attempt WHERE attempt_id=$1::uuid', [
          id,
        ]),
      );
      if (!attempt) continue; // Historical pages are authorized below by their checkpoint.
      if (!['confirmed', 'projected'].includes(attempt.status))
        throw new WarehouseConflict('warehouse-publication-unconfirmed');
      const decisions = await tracePublication(trace, 'reserve.source', () =>
        landing.recover(attempt),
      );
      const expectedStarted = trace && performance.now();
      const { groups, manifest: expected } = deriveCandidates(attempt, decisions);
      if (
        !expected.length ||
        manifestDigest(expected) !== manifestDigest(entries.filter(e => e.attemptId === id))
      )
        throw new WarehouseConflict('warehouse-publication-incomplete-package');
      if (recovering) {
        for (const entry of expected) recoveryRows.set(entry.candidateId, groups.get(entry.family));
      }
      trace?.record('reserve.expected', expectedStarted);
      const proofMode = recovering ? 'recover' : 'verify';
      await tracePublication(trace, 'reserve.risk-proof', () =>
        projectRiskProofs(this.ch, attempt, decisions, expected, proofMode),
      );
      await tracePublication(trace, 'reserve.log-proof', () =>
        projectLogScopeProofs(this.ch, attempt, decisions, expected, proofMode),
      );
      await tracePublication(trace, 'reserve.property-proof', () =>
        projectPropertyProofs(this.ch, attempt, decisions, expected, proofMode),
      );
    }
    const verifier = new CandidateWriter(this.ch);
    const verifiedVersions = new Map<ManifestEntry, string[]>();
    for (const entry of entries) {
      const result = await tracePublication(
        trace,
        'verify.' + entry.family,
        () =>
          verifier.verify(
            entry.family,
            websiteId,
            epoch,
            entry.candidateId,
            Number(entry.rowCount),
            entry.digest,
            recoveryRows.get(entry.candidateId),
            trace,
          ),
        Number(entry.rowCount),
      );
      if (result.attempts.some(id => id !== entry.attemptId))
        throw new WarehouseConflict('warehouse-candidate-attempt-mismatch');
      verifiedVersions.set(entry, result.versions);
    }
    // Another partition can be between its durable reservation and CH manifest
    // acknowledgement. Keep our already verified package while it completes;
    // aborting here used to repeat derivation and impose a two-second retry.
    // Wait only outside the transaction, with a bounded fallback to recovery.
    const waitUntil = Date.now() + 1000;
    for (;;) {
      const reserved = await tracePublication(trace, 'reserve.transaction', () =>
        this.db.transaction(async tx => {
          const { rows: sites } = await tx.query<{
            epoch: string;
            publication: string;
            state: string;
          }>(
            // Serialize publication/epoch changes without blocking the foreign-key
            // locks held by concurrent upload registration and queue discovery.
            'SELECT epoch,publication,state FROM liekan_warehouse_site WHERE website_id=$1::uuid FOR NO KEY UPDATE',
            [websiteId],
          );
          if (
            !sites[0] ||
            BigInt(sites[0].epoch) < BigInt(epoch) ||
            ((sites[0].epoch !== epoch || sites[0].state !== 'active') &&
              !(await historicalPublication(tx, websiteId, epoch, entries)))
          )
            throw new WarehouseConflict('warehouse-site-changed');
          const previous = await tx.query<Publication>(
            'SELECT * FROM liekan_warehouse_publication WHERE operation_id=$1::uuid',
            [operationId],
          );
          if (previous.rows.length) {
            const p = previous.rows[0];
            if (p.manifest_digest !== digest || p.website_id !== websiteId || p.epoch !== epoch)
              throw new WarehouseConflict('warehouse-publication-conflict');
            return p;
          }
          const { rows: attempts } = await tx.query<
            Pick<Attempt, 'attempt_id' | 'website_id' | 'epoch' | 'version' | 'status'>
          >(
            'SELECT attempt_id,website_id,epoch,version,status FROM liekan_warehouse_attempt WHERE attempt_id=ANY($1::uuid[])',
            [attemptIds],
          );
          const attemptsById = new Map(attempts.map(attempt => [attempt.attempt_id, attempt]));
          for (const entry of entries) {
            const attempt = attemptsById.get(entry.attemptId);
            if (attempt) {
              if (
                !['confirmed', 'projected'].includes(attempt.status) ||
                attempt.website_id !== websiteId ||
                attempt.epoch !== epoch ||
                verifiedVersions.get(entry).some(v => v !== attempt.version)
              )
                throw new WarehouseConflict('warehouse-publication-unconfirmed');
            } else {
              const [page] = (
                await tx.query<{ migration_id: string; page_key: string }>(
                  `SELECT c.migration_id,c.page_key
            FROM liekan_warehouse_checkpoint c JOIN liekan_warehouse_migration m USING(migration_id)
            WHERE c.candidate_id=$1::uuid AND c.family=$2 AND c.status IN ('verified','published')
              AND m.phase IN ('backfill','verify','shadow','frozen') AND m.boundary->'sites'->>$3=$4`,
                  [entry.candidateId, entry.family, websiteId, epoch],
                )
              ).rows;
              if (
                !page ||
                entry.attemptId !==
                  stableOperation([page.migration_id, entry.family, page.page_key]) ||
                verifiedVersions.get(entry).some(v => v !== '0')
              )
                throw new WarehouseConflict('warehouse-publication-unconfirmed');
            }
          }
          const pending = await tx.query(
            "SELECT 1 FROM liekan_warehouse_publication WHERE website_id=$1::uuid AND status='reserved'",
            [websiteId],
          );
          if (pending.rows.length) return null;
          // The readback above is shared by derivation and publication. Advance
          // candidate state in the same transaction as the durable reservation.
          await tx.query(
            `UPDATE liekan_warehouse_candidate SET status='verified',updated_at=clock_timestamp()
        WHERE candidate_id=ANY($1::uuid[]) AND website_id=$2::uuid AND epoch=$3::bigint
          AND status='building'`,
            [entries.map(entry => entry.candidateId), websiteId, epoch],
          );
          return (
            await tx.query<Publication>(
              `INSERT INTO liekan_warehouse_publication
        (operation_id,website_id,epoch,publication,manifest,manifest_digest,status)
        VALUES($1::uuid,$2::uuid,$3::bigint,$4::bigint+1,$5::jsonb,$6,'reserved') RETURNING *`,
              [
                operationId,
                websiteId,
                epoch,
                sites[0].publication,
                JSON.stringify(entries),
                digest,
              ],
            )
          ).rows[0];
        }),
      );
      if (reserved) return reserved;
      if (Date.now() >= waitUntil) throw new WarehouseConflict('warehouse-publication-pending');
      await tracePublication(trace, 'reserve.pending', () =>
        delay(Math.min(50, waitUntil - Date.now())),
      );
    }
  }

  // All records in this small manifest use one month/insert block. Retrying the
  // reserved operation must preserve each of its immutable candidate choices.
  async project(
    operationId: string,
    timing?: (stage: string, ms: number) => void,
    trace?: PublicationTrace,
    recovering = false,
  ) {
    const [p] = await tracePublication(trace, 'manifest.reservation', () =>
      this.db.read<Publication>(
        'SELECT * FROM liekan_warehouse_publication WHERE operation_id=$1::uuid',
        [operationId],
      ),
    );
    if (!p || p.status === 'obsolete')
      throw new WarehouseConflict('warehouse-publication-unavailable');
    if (p.status === 'published') return p;
    const values = p.manifest.map(e => ({
      website_id: p.website_id,
      epoch: p.epoch,
      publication: p.publication,
      attempt_id: e.attemptId,
      family: e.family,
      candidate_id: e.candidateId,
      row_count: e.rowCount,
      digest: e.digest,
      published_at: p.created_at.toISOString().replace('T', ' ').replace('Z', ''),
    }));
    const started = performance.now();
    const readManifest = (stage: string) =>
      tracePublication(trace, stage, () =>
        this.ch
          .query({
            query: `SELECT DISTINCT attempt_id,family,candidate_id,row_count,digest
      FROM warehouse_publication WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND publication={publication:UInt64}
      LIMIT {limit:UInt32}`,
            query_params: {
              site: p.website_id,
              epoch: p.epoch,
              publication: p.publication,
              limit: values.length + 1,
            },
            format: 'JSONEachRow',
          })
          .then(r =>
            r.json<{
              attempt_id: string;
              family: string;
              candidate_id: string;
              row_count: string;
              digest: string;
            }>(),
          ),
      );
    let missing = values;
    let projected = recovering ? await readManifest('manifest.recover-read') : [];
    if (projected.length) {
      const existing = new Map(projected.map(row => [row.candidate_id, row]));
      missing = values.filter(row => {
        const found = existing.get(row.candidate_id);
        if (!found) return true;
        if (
          found.attempt_id !== row.attempt_id ||
          found.family !== row.family ||
          found.row_count !== row.row_count ||
          found.digest !== row.digest
        )
          throw new WarehouseConflict('warehouse-manifest-verification-failed');
        return false;
      });
      if (projected.length !== values.length - missing.length)
        throw new WarehouseConflict('warehouse-manifest-verification-failed');
    }
    if (missing.length) {
      await tracePublication(trace, 'manifest.write', () =>
        this.ch.insert({
          table: 'warehouse_publication',
          values: missing,
          format: 'JSONEachRow',
          clickhouse_settings: { async_insert: 0 },
        }),
      );
      projected = await readManifest('manifest.read');
    }
    const digest = manifestDigest(
      projected.map(r => ({
        attemptId: r.attempt_id,
        family: r.family,
        candidateId: r.candidate_id,
        rowCount: r.row_count,
        digest: r.digest,
      })),
    );
    if (digest !== p.manifest_digest)
      throw new WarehouseConflict('warehouse-manifest-verification-failed');
    timing?.('ch-publish-and-verify', performance.now() - started);
    const activating = performance.now();
    const result = await tracePublication(trace, 'publication.commit', () =>
      this.db.transaction(async tx => {
        // Intake and governance lock the business resource before control state.
        // Publication effects also update their source/state rows; take the same
        // first lock before the site lock to avoid a cross-partition lock cycle.
        // Historical publication can outlive a physically removed resource; the
        // immutable epoch/checkpoint checks below still decide whether it is valid.
        const [resource] = (
          await tx.query<{ resource_type: string }>(
            'SELECT resource_type FROM liekan_warehouse_site WHERE website_id=$1::uuid',
            [p.website_id],
          )
        ).rows;
        if (!resource || !['website', 'link', 'pixel'].includes(resource.resource_type))
          throw new WarehouseConflict('warehouse-site-changed');
        await tx.query(
          `SELECT ${resource.resource_type}_id FROM ${resource.resource_type} WHERE ${resource.resource_type}_id=$1::uuid FOR NO KEY UPDATE`,
          [p.website_id],
        );
        const site = (
          await tx.query<{ epoch: string; publication: string; state: string }>(
            'SELECT epoch,publication,state FROM liekan_warehouse_site WHERE website_id=$1::uuid FOR NO KEY UPDATE',
            [p.website_id],
          )
        ).rows[0];
        const operation = (
          await tx.query<Publication>(
            'SELECT * FROM liekan_warehouse_publication WHERE operation_id=$1::uuid FOR UPDATE',
            [operationId],
          )
        ).rows[0];
        if (operation?.status === 'published') return operation;
        if (
          !site ||
          BigInt(site.epoch) < BigInt(p.epoch) ||
          ((site.epoch !== p.epoch || site.state !== 'active') &&
            !(await historicalPublication(tx, p.website_id, p.epoch, p.manifest))) ||
          BigInt(site.publication) + 1n !== BigInt(p.publication) ||
          operation?.status !== 'reserved' ||
          operation.manifest_digest !== digest
        )
          throw new WarehouseConflict('warehouse-publication-fenced');
        await tx.query(
          'UPDATE liekan_warehouse_site SET publication=$2::bigint,updated_at=clock_timestamp() WHERE website_id=$1::uuid',
          [p.website_id, p.publication],
        );
        await tx.query(
          `UPDATE liekan_warehouse_publication SET status='published',updated_at=clock_timestamp() WHERE operation_id=$1::uuid`,
          [operationId],
        );
        await tx.query(
          `UPDATE liekan_warehouse_candidate SET status='published',publication=$2::bigint,updated_at=clock_timestamp()
        WHERE candidate_id=ANY($1::uuid[]) AND status='verified'`,
          [p.manifest.map(e => e.candidateId), p.publication],
        );
        await applyPublicationEffects(
          tx,
          p.manifest.map(e => e.attemptId),
          resource.resource_type === 'website' && p.manifest.some(e => e.family === 'website_event')
            ? {
                site: p.website_id,
                epoch: p.epoch,
                pointer: p.publication,
                eventRows: p.manifest.reduce(
                  (sum, e) => sum + (e.family === 'website_event' ? Number(e.rowCount) : 0),
                  0,
                ),
              }
            : undefined,
        );
        await tx.query(
          `UPDATE liekan_warehouse_attempt SET status='projected',updated_at=clock_timestamp()
        WHERE attempt_id=ANY($1::uuid[]) AND status='confirmed'`,
          [p.manifest.map(e => e.attemptId)],
        );
        // Publication invalidates closed-period caches as well as live windows.
        // The operation status above makes this notification idempotent on recovery.
        await tx.query(
          `INSERT INTO liekan_analytics_revision(resource_type,resource_id,revision)
        VALUES('website',$1::uuid,1) ON CONFLICT(resource_type,resource_id)
        DO UPDATE SET revision=liekan_analytics_revision.revision+1,updated_at=clock_timestamp()`,
          [p.website_id],
        );
        return { ...operation, status: 'published' };
      }),
    );
    timing?.('pg-publish', performance.now() - activating);
    return result;
  }
}
