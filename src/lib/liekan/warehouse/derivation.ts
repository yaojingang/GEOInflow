import { projectPropertyProofs } from './property-proof';
import type { ClickHouseClient } from '@clickhouse/client';
import { CandidateWriter } from './candidate';
import type { Attempt } from './control';
import { type ControlDatabase, WarehouseConflict } from './control-db';
import { deriveCandidates } from './derivation-plan';
import { applyPublicationEffects } from './effects';
import { stableOperation } from './identifiers';
import { LandingStore } from './landing';
import { projectLogScopeProofs } from './log-scope-proof';
import { WarehousePublisher } from './publication';
import { projectRiskProofs } from './risk-proof';

export class WarehouseDeriver {
  private readonly landing: LandingStore;
  private readonly writer: CandidateWriter;
  private readonly publisher: WarehousePublisher;
  constructor(
    private readonly db: ControlDatabase,
    private readonly ch: ClickHouseClient,
  ) {
    this.landing = new LandingStore(ch);
    this.writer = new CandidateWriter(ch);
    this.publisher = new WarehousePublisher(db, ch);
  }

  async derive(attemptId: string) {
    const [attempt] = await this.db.read<Attempt>(
      'SELECT * FROM liekan_warehouse_attempt WHERE attempt_id=$1::uuid',
      [attemptId],
    );
    if (!attempt || !['confirmed', 'projected'].includes(attempt.status))
      throw new WarehouseConflict('warehouse-attempt-not-confirmed');
    if (attempt.status === 'projected') return;
    await this.landing.projectDecision(attempt);
    const decisions = await this.landing.recover(attempt);
    const { groups, manifest } = deriveCandidates(attempt, decisions);
    for (const entry of manifest) {
      await this.db.transaction(async tx => {
        await tx.query(
          `INSERT INTO liekan_warehouse_candidate
          (candidate_id,attempt_id,website_id,epoch,family,row_count,digest,status,owner_id,generation,lease_until)
          VALUES($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5,$6::bigint,$7,'building',$8::uuid,$9::bigint,clock_timestamp()+interval '30 seconds')
          ON CONFLICT(candidate_id) DO NOTHING`,
          [
            entry.candidateId,
            attemptId,
            attempt.website_id,
            attempt.epoch,
            entry.family,
            entry.rowCount,
            entry.digest,
            attempt.owner_id,
            attempt.generation,
          ],
        );
        const [existing] = (
          await tx.query<{ digest: string; row_count: string }>(
            'SELECT digest,row_count FROM liekan_warehouse_candidate WHERE candidate_id=$1::uuid',
            [entry.candidateId],
          )
        ).rows;
        if (existing.digest !== entry.digest || existing.row_count !== entry.rowCount)
          throw new WarehouseConflict('warehouse-derivation-conflict');
      });
      await this.writer.append(entry.family, groups.get(entry.family));
    }
    await projectRiskProofs(this.ch, attempt, decisions, manifest);
    await projectLogScopeProofs(this.ch, attempt, decisions, manifest);
    await projectPropertyProofs(this.ch, attempt, decisions, manifest);
    if (manifest.length) {
      const operation = await this.publisher.reserve(
        attempt.website_id,
        attempt.epoch,
        manifest,
        stableOperation(['derived-publication', attemptId]),
      );
      await this.publisher.project(operation.operation_id);
    } else {
      // Conflict/no-op decisions have no derived facts. They still need a durable
      // completion state so source offsets and recovery work can be reclaimed.
      await this.db.transaction(async tx => {
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
      });
    }
  }
}
