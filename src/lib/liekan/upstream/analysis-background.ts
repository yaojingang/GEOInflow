import { randomUUID } from 'node:crypto';
import {
  type AnalysisPermit,
  analysisPermitTable,
  analysisPermitPredicate,
  analysisPermitValues,
  withinAnalysisPermit,
} from './analysis-permit-context';
import { analysisCapacity, analysisTransaction } from './analysis-rollups-db';
import { analysisBuildWaitingSql } from './analysis-rollups-model';
import { dashboardAnalysisWorkSql } from './dashboard-demand';
import { storageHistoryAllowed } from './storage-capacity';

export type AnalysisWorkKind = 'interactive' | 'incremental' | 'history' | 'preheat' | 'dashboard';
/** Database leases bound concurrent analysis across worker processes. Waiting holds no connection. */
export async function withAnalysisPermit<T>(
  kind: AnalysisWorkKind,
  work: (owned: () => boolean, lease: AnalysisPermit) => Promise<T>,
) {
  const token = randomUUID();
  const table = analysisPermitTable({
    token,
    epoch: '',
    ...(kind === 'dashboard' ? { lane: 'dashboard' as const, slot: 1 } : {}),
  });
  const acquired = await analysisTransaction<{ epoch: bigint; slot?: number } | undefined>(
    async tx => {
      if (kind === 'dashboard') {
        const [row] = await tx.$queryRawUnsafe<{ epoch: bigint; slot: number }[]>(
          `WITH available AS(SELECT slot FROM liekan_analysis_read_lease
         WHERE lease_until IS NULL OR lease_until<=clock_timestamp() ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1)
         UPDATE liekan_analysis_read_lease SET token=$1::uuid,epoch=epoch+1,
          lease_until=clock_timestamp()+interval '90 seconds' WHERE slot IN(SELECT slot FROM available)
          AND NOT EXISTS(SELECT 1 FROM liekan_analysis_dashboard_lease WHERE lease_until>clock_timestamp())
          RETURNING epoch,slot`,
          token,
        );
        return row;
      }
      const [row] = await tx.$queryRawUnsafe<{ epoch: bigint }[]>(
        `WITH slot AS(SELECT id FROM liekan_analysis_background_lease WHERE id FOR UPDATE SKIP LOCKED)
       UPDATE liekan_analysis_background_lease SET token=$1::uuid,epoch=epoch+1,
       lease_until=clock_timestamp()+interval '90 seconds',
       interactive_turns=CASE WHEN $2='interactive' THEN interactive_turns+1 WHEN $2='history' THEN 0 ELSE interactive_turns END,
       last_incremental_at=CASE WHEN $2='incremental' THEN clock_timestamp() ELSE last_incremental_at END,
       incremental_waiting_at=CASE WHEN $2='incremental' THEN NULL ELSE incremental_waiting_at END,
       history_waiting_at=CASE WHEN $2='history' THEN NULL ELSE history_waiting_at END
       WHERE id IN(SELECT id FROM slot) AND (lease_until IS NULL OR lease_until<=clock_timestamp())
       AND ($2='incremental' OR incremental_waiting_at IS NULL OR incremental_waiting_at>clock_timestamp()-interval '30 seconds')
       AND ($2 IN('history','incremental') OR history_waiting_at IS NULL OR interactive_turns<5)
       AND ($2<>'history' OR interactive_turns>=5 OR (NOT EXISTS(SELECT 1 FROM liekan_analysis_query q WHERE q.status IN('queued','running') AND NOT ${dashboardAnalysisWorkSql}) AND NOT EXISTS(SELECT 1 FROM liekan_geo_weight_head WHERE task_status IN('queued','running'))))
       AND ($2<>'incremental' OR incremental_waiting_at<=clock_timestamp()-interval '30 seconds' OR (NOT EXISTS(SELECT 1 FROM liekan_analysis_query q WHERE q.status IN('queued','running') AND NOT ${dashboardAnalysisWorkSql}) AND NOT EXISTS(SELECT 1 FROM liekan_geo_weight_head WHERE task_status IN('queued','running'))))
       AND ($2<>'preheat' OR NOT EXISTS(SELECT 1 FROM liekan_analysis_query q WHERE q.status IN('queued','running') AND NOT ${dashboardAnalysisWorkSql})
          AND NOT EXISTS(SELECT 1 FROM liekan_geo_weight_head WHERE task_status IN('queued','running'))
          AND incremental_waiting_at IS NULL AND history_waiting_at IS NULL)
       RETURNING epoch`,
        token,
        kind,
      );
      return row;
    },
  );
  if (!acquired) return { acquired: false as const };
  let owned = true,
    renewing = false;
  const renewal = setInterval(async () => {
    if (renewing || !owned) return;
    renewing = true;
    try {
      owned = !!(await analysisTransaction(tx =>
        tx.$executeRawUnsafe(
          `UPDATE ${table} SET lease_until=clock_timestamp()+interval '90 seconds'
         WHERE ${analysisPermitPredicate(lease)} AND lease_until>clock_timestamp()`,
          ...analysisPermitValues(lease),
        ),
      ));
    } catch {
      owned = false;
    } finally {
      renewing = false;
    }
  }, 15000);
  const lease: AnalysisPermit = {
    token,
    epoch: String(acquired.epoch),
    ...(kind === 'dashboard' ? { lane: 'dashboard' as const, slot: acquired.slot } : {}),
  };
  try {
    return {
      acquired: true as const,
      value: await withinAnalysisPermit(lease, () => work(() => owned, lease)),
    };
  } finally {
    clearInterval(renewal);
    owned = false;
    // Preserve remaining runnable demand before the next bounded unit checks fairness.
    await analysisTransaction(async tx => {
      let waiting = '';
      if (kind === 'history') {
        const capacity = await analysisCapacity(tx, null);
        waiting = `,history_waiting_at=${analysisBuildWaitingSql.history(storageHistoryAllowed(capacity))}`;
      } else if (kind === 'incremental') {
        waiting = `,incremental_waiting_at=${analysisBuildWaitingSql.incremental}`;
      }
      await tx.$executeRawUnsafe(
        `UPDATE ${table} SET token=NULL,lease_until=NULL${waiting} WHERE ${analysisPermitPredicate(lease)}`,
        ...analysisPermitValues(lease),
      );
    });
  }
}
