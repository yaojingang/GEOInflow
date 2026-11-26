import { randomUUID } from 'node:crypto';
import type { Db, PgBoss } from 'pg-boss';
import { HISTORY_REPAIR_QUEUE } from '../contracts/history-repair';

export async function sendRepairStep(
  boss: PgBoss,
  db: Db,
  runId: string,
  { stepId = randomUUID(), delay = 0 }: { stepId?: string; delay?: number } = {},
) {
  // Continuations get fresh queue identifiers and remain at the tail for fairness.
  const inserted = await boss.send(
    HISTORY_REPAIR_QUEUE,
    { runId, stepId },
    {
      id: stepId,
      db,
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: 120,
      retentionSeconds: 7 * 86400,
      ...(delay ? { startAfter: delay } : {}),
    },
  );
  if (inserted !== stepId) throw new Error('history-repair-step-not-enqueued');
  return stepId;
}
