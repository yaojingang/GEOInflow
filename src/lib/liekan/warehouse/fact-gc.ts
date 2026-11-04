import type { ClickHouseClient } from '@clickhouse/client';
import type { ControlDatabase } from './control-db';
import { factTable, identifier } from './catalog';
import { verifyBoundWarehouse } from './installation-identity';

/** Bounded, repeatable collection of explicitly abandoned candidates. Every
 * accepted publication, receipt body and proof version is preserved. Raw-fact
 * expiration requires a separately confirmed retention policy. */
export class WarehouseFactGC {
  constructor(
    private db: ControlDatabase,
    private ch: ClickHouseClient,
  ) {}
  async collect(limit = 5) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new Error('warehouse-garbage-limit-invalid');
    await verifyBoundWarehouse(this.db, this.ch);
    const jobs = await this.db.read<{
      candidate_id: string;
      website_id: string;
      epoch: string;
      family: string;
    }>(
      `SELECT g.* FROM liekan_warehouse_garbage g
      WHERE g.completed_at IS NULL AND NOT EXISTS(SELECT 1 FROM liekan_warehouse_transition WHERE state<>'closed')
      AND EXISTS(SELECT 1 FROM liekan_warehouse_installation WHERE id=1 AND authority='clickhouse' AND facts_fenced)
      AND NOT EXISTS(SELECT 1 FROM liekan_warehouse_candidate c WHERE c.candidate_id=g.candidate_id)
      ORDER BY g.created_at,g.candidate_id LIMIT $1`,
      [limit],
    );
    let removed = 0,
      protectedCandidates = 0;
    for (const job of jobs) {
      const family = factTable(job.family).name;
      const params = { site: job.website_id, epoch: job.epoch, id: job.candidate_id };
      const references = await this.ch
        .query({
          query: `SELECT 1 FROM warehouse_publication WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND candidate_id={id:UUID} LIMIT 1`,
          query_params: params,
          format: 'JSONEachRow',
        })
        .then(r => r.json());
      if (references.length) protectedCandidates++;
      else {
        // No PG attempt/candidate can publish this identifier after reclamation.
        // A crash/lost mutation response leaves the intent pending for replay.
        await this.ch.command({
          query: `ALTER TABLE ${identifier('warehouse_' + family)} DELETE WHERE _website_id={site:UUID} AND _epoch={epoch:UInt64} AND _candidate_id={id:UUID}`,
          query_params: params,
          clickhouse_settings: { mutations_sync: '1' },
        });
        removed++;
      }
      await this.db.read(
        'UPDATE liekan_warehouse_garbage SET completed_at=clock_timestamp() WHERE candidate_id=$1 AND completed_at IS NULL',
        [job.candidate_id],
      );
    }
    await this.db.read(
      `DELETE FROM liekan_warehouse_reference WHERE reference_id IN(SELECT reference_id FROM liekan_warehouse_reference WHERE kind IN('query','export') AND expires_at<clock_timestamp() ORDER BY expires_at LIMIT 1000)`,
    );
    await this.db.read(
      `DELETE FROM liekan_warehouse_garbage WHERE candidate_id IN(SELECT candidate_id FROM liekan_warehouse_garbage WHERE completed_at<clock_timestamp()-interval '7 days' ORDER BY completed_at LIMIT 1000)`,
    );
    return { removed, protectedCandidates };
  }
}
