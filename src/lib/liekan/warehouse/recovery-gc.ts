import type { ControlDatabase, ControlSQL } from './control-db';
import type { WarehouseQueue } from './transport';
import { stableOperation } from './identifiers';

/** Reclaims only replayable transport/control copies. Published CH facts,
 * canonical receipt journals, proof manifests and historical source stay intact. */
export class WarehouseRecoveryGC {
  constructor(
    private db: ControlDatabase,
    private queue: WarehouseQueue,
  ) {}
  private async permitted(tx: ControlSQL) {
    const rows = await tx.query(
      "SELECT id FROM liekan_warehouse_installation WHERE id=1 AND authority='clickhouse' AND facts_fenced AND topic_id=$1 FOR SHARE",
      [this.queue.installation.topicId],
    );
    return (
      !!rows.rowCount &&
      !(await tx.query("SELECT 1 FROM liekan_warehouse_transition WHERE state<>'closed'")).rowCount
    );
  }
  async collect(limit = 5000, graceSeconds = 600) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10000 ||
      !Number.isInteger(graceSeconds) ||
      graceSeconds < 60
    )
      throw new Error('warehouse-reclaim-options-invalid');
    await this.queue.assertIdentity();
    let work = 0,
      attempts = 0,
      journal = 0;
    for (let partition = 0; partition < this.queue.installation.partitions; partition++) {
      const batch = await this.db.transaction(async tx => {
        if (!(await this.permitted(tx))) return null;
        const [p] = (
          await tx.query<{ safe_offset: string; reclaimed_offset: string }>(
            'SELECT safe_offset,reclaimed_offset FROM liekan_warehouse_partition WHERE topic_id=$1 AND partition=$2 FOR UPDATE',
            [this.queue.installation.topicId, partition],
          )
        ).rows;
        if (!p) return null;
        const rows = (
          await tx.query<{ offset_id: string; eligible: boolean }>(
            `SELECT w.offset_id,
          (w.status IN('confirmed','cancelled') AND w.updated_at<clock_timestamp()-$5*interval '1 second'
          AND (w.status='cancelled' OR (a.status='projected' AND a.decision_projected AND a.effects_applied))) AS eligible
          FROM liekan_warehouse_work w LEFT JOIN liekan_warehouse_attempt a USING(attempt_id)
          WHERE w.topic_id=$1 AND w.partition=$2 AND w.offset_id>$3 AND w.offset_id<=$4 ORDER BY w.offset_id LIMIT $6`,
            [
              this.queue.installation.topicId,
              partition,
              p.reclaimed_offset,
              p.safe_offset,
              graceSeconds,
              limit,
            ],
          )
        ).rows;
        let through = p.reclaimed_offset;
        for (const row of rows) {
          if (!row.eligible) break;
          through = row.offset_id;
        }
        const removed =
          (
            await tx.query(
              'DELETE FROM liekan_warehouse_work WHERE topic_id=$1 AND partition=$2 AND offset_id<=$3',
              [this.queue.installation.topicId, partition, through],
            )
          ).rowCount ?? 0;
        await tx.query(
          'UPDATE liekan_warehouse_partition SET reclaimed_offset=$3 WHERE topic_id=$1 AND partition=$2',
          [this.queue.installation.topicId, partition, through],
        );
        return { removed, through };
      });
      if (!batch) continue;
      work += batch.removed;
      if (BigInt(batch.through) >= 0) {
        // PG floor commits before broker truncation. A lost broker reply or
        // process death simply retries this same proven prefix next time.
        await this.queue.assertIdentity();
        const admin = this.queue.kafka.admin();
        try {
          await admin.connect();
          await admin.fetchTopicMetadata({ topics: [this.queue.installation.topicName] });
          await admin.deleteTopicRecords({
            topic: this.queue.installation.topicName,
            partitions: [{ partition, offset: String(BigInt(batch.through) + 1n) }],
          });
        } finally {
          await admin.disconnect();
        }
      }
    }
    await this.db.transaction(async tx => {
      if (!(await this.permitted(tx))) return;
      // The terminal sequence and both acknowledged prefixes remain permanent.
      // Temporary result payloads have no consumers after explicit close().
      const results = (
        await tx.query<{ sequence: string }>(
          `SELECT r.sequence FROM liekan_warehouse_transition_result r JOIN liekan_warehouse_transition t ON t.id=1
        WHERE t.state='closed' AND r.sequence<=t.terminal_sequence ORDER BY r.sequence LIMIT $1 FOR UPDATE OF r`,
          [limit],
        )
      ).rows.map(r => r.sequence);
      if (results.length) {
        await tx.query(
          'DELETE FROM liekan_warehouse_transition_delivery WHERE sequence=ANY($1::bigint[])',
          [results],
        );
        await tx.query(
          'DELETE FROM liekan_warehouse_transition_applied WHERE sequence=ANY($1::bigint[])',
          [results],
        );
        journal =
          (
            await tx.query(
              'DELETE FROM liekan_warehouse_transition_result WHERE sequence=ANY($1::bigint[])',
              [results],
            )
          ).rowCount ?? 0;
      }
      const ids = (
        await tx.query<{ attempt_id: string }>(
          `SELECT a.attempt_id FROM liekan_warehouse_attempt a
        WHERE a.status IN('projected','aborted') AND (a.status='aborted' OR (a.decision_projected AND a.effects_applied))
        AND a.updated_at<clock_timestamp()-$1*interval '1 second'
        AND NOT EXISTS(SELECT 1 FROM liekan_warehouse_work w WHERE w.attempt_id=a.attempt_id)
        AND NOT EXISTS(SELECT 1 FROM liekan_warehouse_task t WHERE t.attempt_id=a.attempt_id AND t.status IN('pending','confirmed'))
        AND NOT EXISTS(SELECT 1 FROM liekan_warehouse_candidate c JOIN liekan_warehouse_checkpoint p USING(candidate_id) WHERE c.attempt_id=a.attempt_id)
        AND NOT EXISTS(SELECT 1 FROM liekan_warehouse_transition_result r WHERE r.operation_id=a.attempt_id)
        ORDER BY a.updated_at LIMIT $2 FOR UPDATE OF a SKIP LOCKED`,
          [graceSeconds, Math.min(limit, 1000)],
        )
      ).rows.map(r => r.attempt_id);
      if (ids.length) {
        await tx.query(
          `DELETE FROM liekan_warehouse_publication p WHERE p.operation_id=ANY($2::uuid[]) AND p.status='published' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.manifest) m WHERE NOT((m->>'attemptId')::uuid=ANY($1::uuid[]))) AND jsonb_array_length(p.manifest)>0`,
          [ids, ids.map(id => stableOperation(['derived-publication', id]))],
        );
        await tx.query(
          `INSERT INTO liekan_warehouse_garbage(candidate_id,website_id,epoch,family)
          SELECT candidate_id,website_id,epoch,family FROM liekan_warehouse_candidate
          WHERE attempt_id=ANY($1::uuid[]) AND status<>'published' ON CONFLICT DO NOTHING`,
          [ids],
        );
        await tx.query('DELETE FROM liekan_warehouse_candidate WHERE attempt_id=ANY($1::uuid[])', [
          ids,
        ]);
        attempts =
          (
            await tx.query(
              'DELETE FROM liekan_warehouse_attempt WHERE attempt_id=ANY($1::uuid[])',
              [ids],
            )
          ).rowCount ?? 0;
      }
    });
    const [closed] = await this.db.read<{ topic_name: string; topic_id: string }>(
      "SELECT topic_name,topic_id FROM liekan_warehouse_transition WHERE id=1 AND state='closed'",
    );
    if (closed) {
      const resultQueue = this.queue.sibling({
        topicName: closed.topic_name,
        topicId: closed.topic_id,
        partitions: 1,
        routingVersion: 1,
      });
      try {
        await resultQueue.connect();
        const boundary = await resultQueue.highWatermarks();
        const admin = resultQueue.kafka.admin();
        try {
          await admin.connect();
          await resultQueue.assertIdentity();
          await admin.fetchTopicMetadata({ topics: [closed.topic_name] });
          await admin.deleteTopicRecords({ topic: closed.topic_name, partitions: boundary });
        } finally {
          await admin.disconnect();
        }
      } finally {
        await resultQueue.close();
      }
    }
    return { work, attempts, journal };
  }
}
