import { projectPropertyProofs } from './property-proof';
import type { ClickHouseClient } from '@clickhouse/client';
import { CandidateWriter } from './candidate';
import type { Attempt } from './control';
import { type ControlDatabase, WarehouseConflict } from './control-db';
import { deriveCandidates } from './derivation-plan';
import { applyPublicationEffects } from './effects';
import { stableOperation } from './identifiers';
import { LandingStore, type StagedLanding } from './landing';
import { projectLogScopeProofs } from './log-scope-proof';
import { type PublicationTrace, tracePublication } from './publication-timing';
import { WarehousePublisher } from './publication';
import { projectRiskProofs } from './risk-proof';

export class WarehouseDeriver {
  private readonly landing: LandingStore;
  private readonly writer: CandidateWriter;
  private readonly publisher: WarehousePublisher;
  constructor(
    private readonly db: ControlDatabase,
    private readonly ch: ClickHouseClient,
    options?: { ingestionLogFlushLimitMs: number },
  ) {
    this.landing = new LandingStore(ch);
    this.writer = new CandidateWriter(ch, { coalesce: true, ...options });
    this.publisher = new WarehousePublisher(db, ch);
  }

  async derive(
    attemptId: string,
    timing?: (stage: string, ms: number) => void,
    staged?: StagedLanding,
    trace?: PublicationTrace,
    recovering = false,
  ) {
    let started = performance.now();
    const [attempt] = await tracePublication(trace, 'attempt.read', () =>
      this.db.read<Attempt>('SELECT * FROM liekan_warehouse_attempt WHERE attempt_id=$1::uuid', [
        attemptId,
      ]),
    );
    if (!attempt || !['confirmed', 'projected'].includes(attempt.status))
      throw new WarehouseConflict('warehouse-attempt-not-confirmed');
    await tracePublication(trace, 'decision.project', () => this.landing.projectDecision(attempt));
    timing?.('decision-project', performance.now() - started);
    if (attempt.status === 'projected') return;
    started = performance.now();
    // Reuse the successful landing readback for new work. Recovery loads the
    // sealed input afresh, and publication independently verifies the manifest.
    const decisions = staged
      ? staged(attempt)
      : await tracePublication(trace, 'landing.recover', () => this.landing.recover(attempt));
    const planStarted = trace && performance.now();
    const { groups, manifest } = deriveCandidates(attempt, decisions);
    trace?.record('candidate.plan', planStarted);
    if (manifest.length) {
      await tracePublication(trace, 'candidate.register', () =>
        this.db.transaction(async tx => {
          const entries = JSON.stringify(
            manifest.map(({ candidateId, family, rowCount, digest }) => ({
              candidate_id: candidateId,
              family,
              row_count: rowCount,
              digest,
            })),
          );
          await tx.query(
            `INSERT INTO liekan_warehouse_candidate
          (candidate_id,attempt_id,website_id,epoch,family,row_count,digest,status,owner_id,generation,lease_until)
          SELECT candidate_id,$2::uuid,$3::uuid,$4::bigint,family,row_count,digest,'building',
            $5::uuid,$6::bigint,clock_timestamp()+interval '30 seconds'
          FROM jsonb_to_recordset($1::jsonb) AS c(candidate_id uuid,family text,row_count bigint,digest text)
          ORDER BY candidate_id
          ON CONFLICT(candidate_id) DO NOTHING`,
            [
              entries,
              attemptId,
              attempt.website_id,
              attempt.epoch,
              attempt.owner_id,
              attempt.generation,
            ],
          );
          const { rows } = await tx.query<{
            candidate_id: string;
            family: string;
            row_count: string;
            digest: string;
          }>(
            `SELECT candidate_id,family,row_count,digest FROM liekan_warehouse_candidate
          WHERE candidate_id=ANY($1::uuid[]) AND attempt_id=$2::uuid
            AND website_id=$3::uuid AND epoch=$4::bigint`,
            [
              manifest.map(entry => entry.candidateId),
              attemptId,
              attempt.website_id,
              attempt.epoch,
            ],
          );
          const existing = new Map(rows.map(row => [row.candidate_id, row]));
          for (const entry of manifest) {
            const row = existing.get(entry.candidateId);
            if (
              row?.family !== entry.family ||
              row.digest !== entry.digest ||
              row.row_count !== entry.rowCount
            )
              throw new WarehouseConflict('warehouse-derivation-conflict');
          }
        }),
      );
    }
    if (!recovering) {
      const writes = manifest.map(
        entry => () =>
          tracePublication(
            trace,
            'write.' + entry.family,
            () => this.writer.append(entry.family, groups.get(entry.family)),
            Number(entry.rowCount),
          ),
      );
      writes.push(() =>
        tracePublication(trace, 'write.log-scope', () =>
          projectLogScopeProofs(this.ch, attempt, decisions, manifest),
        ),
      );
      for (let i = 0; i < writes.length; i += 2) {
        // Candidate IDs fence each write. Drain both acknowledgements, including
        // after a partial failure, before releasing the partition or reserving.
        const results = await Promise.allSettled(writes.slice(i, i + 2).map(write => write()));
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      }
      await projectRiskProofs(this.ch, attempt, decisions, manifest);
      await projectPropertyProofs(this.ch, attempt, decisions, manifest);
    }
    timing?.(
      recovering ? 'derive-recovery-plan' : 'derive-and-write-candidates',
      performance.now() - started,
    );
    if (manifest.length) {
      started = performance.now();
      const operation = await this.publisher.reserve(
        attempt.website_id,
        attempt.epoch,
        manifest,
        stableOperation(['derived-publication', attemptId]),
        trace,
        recovering,
      );
      timing?.('verify-and-reserve', performance.now() - started);
      await this.publisher.project(operation.operation_id, timing, trace, recovering);
    } else {
      // Conflict/no-op decisions have no derived facts. They still need a durable
      // completion state so source offsets and recovery work can be reclaimed.
      started = performance.now();
      await tracePublication(trace, 'publication.commit', () =>
        this.db.transaction(async tx => {
          await tx.query(
            `SELECT website_id FROM liekan_warehouse_site WHERE website_id=$1::uuid FOR UPDATE`,
            [attempt.website_id],
          );
          await applyPublicationEffects(tx, [attemptId]);
          await tx.query(
            `UPDATE liekan_warehouse_attempt SET status='projected',updated_at=clock_timestamp()
          WHERE attempt_id=$1::uuid AND status='confirmed'`,
            [attemptId],
          );
        }),
      );
      timing?.('pg-publish', performance.now() - started);
    }
  }
}
