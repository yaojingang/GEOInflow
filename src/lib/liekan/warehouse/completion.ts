import type { ClickHouseClient } from '@clickhouse/client';
import type { SiteState } from './control';
import type { ControlDatabase } from './control-db';
import { type InputEnvelope, routingKey } from './routing';

export type CollectionCompletion = {
  status: 'new' | 'duplicate' | 'conflict' | 'cancelled';
  sessionId: string | null;
  visitId: string | null;
};
type Waiter = {
  input: InputEnvelope;
  until: number;
  resolve: (value: CollectionCompletion) => void;
  reject: (error: Error) => void;
};
export class WarehouseUnavailable extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// Coalesces concurrent HTTP waiters. Polling once per site/batch avoids one CH
// query per request per timer tick. Success follows the atomic publication.
export class WarehouseCompletion {
  private readonly pending = new Map<string, Waiter>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  constructor(
    private readonly db: ControlDatabase,
    private readonly ch: ClickHouseClient,
  ) {}
  wait(input: InputEnvelope, timeoutMs = 10000): Promise<CollectionCompletion> {
    if (this.pending.size >= 10000)
      return Promise.reject(new WarehouseUnavailable('warehouse-ingress-busy'));
    return new Promise((resolve, reject) => {
      if (this.pending.has(input.inputId)) {
        reject(new Error('Duplicate completion waiter'));
        return;
      }
      this.pending.set(input.inputId, { input, until: Date.now() + timeoutMs, resolve, reject });
      this.schedule();
    });
  }
  private schedule() {
    if (!this.timer && !this.flushing && this.pending.size)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flushing = this.flush()
          .catch(() => {
            /* Preserve waiters until their bounded deadline. */
          })
          .finally(() => {
            this.flushing = undefined;
            this.schedule();
          });
      }, 50);
  }
  private async flush() {
    for (const [id, w] of this.pending)
      if (w.until <= Date.now()) {
        this.pending.delete(id);
        w.reject(new WarehouseUnavailable('warehouse-confirmation-pending'));
      }
    if (!this.pending.size) return;
    const sites = await this.db.read<SiteState>(
      'SELECT * FROM liekan_warehouse_site WHERE website_id=ANY($1::uuid[])',
      [[...new Set([...this.pending.values()].map(w => w.input.websiteId))]],
    );
    for (const site of sites) {
      const waiters = [...this.pending.values()]
        .filter(w => w.input.websiteId === site.website_id)
        .slice(0, 500);
      for (const w of waiters)
        if (w.input.epoch !== site.epoch || site.state !== 'active') {
          this.pending.delete(w.input.inputId);
          w.resolve({ status: 'cancelled', sessionId: null, visitId: null });
        }
      const ids = waiters.filter(w => this.pending.has(w.input.inputId)).map(w => w.input.inputId);
      if (!ids.length) continue;
      // PG-authoritative receipts remain valid across the cutover. A CH outage
      // must not delay acknowledgement of an already committed PG package.
      const responses = await this.db.read<{
        input_id: string;
        result_status: CollectionCompletion['status'];
        result_session_id: string | null;
        result_visit_id: string | null;
      }>(
        `SELECT input_id,result_status,result_session_id,result_visit_id FROM liekan_warehouse_work
        WHERE website_id=$1 AND input_id=ANY($2::uuid[]) AND status='confirmed' AND result_status IS NOT NULL`,
        [site.website_id, ids],
      );
      for (const row of responses) {
        const waiter = this.pending.get(row.input_id);
        if (!waiter) continue;
        this.pending.delete(row.input_id);
        waiter.resolve({
          status: row.result_status,
          sessionId: row.result_session_id,
          visitId: row.result_visit_id,
        });
      }
      const remaining = ids.filter(id => this.pending.has(id));
      if (!remaining.length) continue;
      const [installation] = await this.db.read<{ authority: string }>(
        'SELECT authority FROM liekan_warehouse_installation WHERE id=1',
      );
      if (installation?.authority !== 'clickhouse') continue;
      const rows = await this.ch
        .query({
          query: `WITH candidates AS (SELECT * FROM warehouse_landing
          WHERE website_id={site:UUID} AND epoch={epoch:UInt64}
            AND identity_key IN {keys:Array(String)} AND input_id IN {ids:Array(UUID)})
        SELECT DISTINCT l.input_id,l.decision,l.original_session,l.original_visit,
        arrayDistinct(arrayMap(f->JSONExtractString(f,'family'),JSONExtractArrayRaw(l.envelope,'facts'))) AS required,
        p.families AS published
        FROM candidates l INNER JOIN (
          SELECT attempt_id,max(version) AS version FROM warehouse_decision
          WHERE website_id={site:UUID} AND epoch={epoch:UInt64}
            AND attempt_id IN (SELECT attempt_id FROM candidates) GROUP BY attempt_id
        ) d ON d.attempt_id=l.attempt_id LEFT JOIN (
          SELECT attempt_id,groupUniqArray(family) AS families FROM warehouse_publication
          WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND publication<={publication:UInt64}
            AND attempt_id IN (SELECT attempt_id FROM candidates) GROUP BY attempt_id
        ) p ON p.attempt_id=l.attempt_id
        WHERE l.website_id={site:UUID} AND l.epoch={epoch:UInt64} AND l.input_id IN {ids:Array(UUID)}`,
          query_params: {
            site: site.website_id,
            epoch: site.epoch,
            publication: site.publication,
            ids: remaining,
            keys: waiters
              .filter(w => this.pending.has(w.input.inputId))
              .map(w => routingKey(w.input)),
          },
          format: 'JSONEachRow',
        })
        .then(r =>
          r.json<{
            input_id: string;
            decision: CollectionCompletion['status'];
            original_session: string | null;
            original_visit: string | null;
            required: string[];
            published: string[];
          }>(),
        );
      for (const row of rows) {
        if (!row.required.every(f => row.published.includes(f))) continue;
        const w = this.pending.get(row.input_id);
        if (!w) continue;
        this.pending.delete(row.input_id);
        w.resolve({
          status: row.decision,
          sessionId: row.original_session,
          visitId: row.original_visit,
        });
      }
    }
  }
  async close() {
    clearTimeout(this.timer);
    for (const w of this.pending.values()) w.reject(new WarehouseUnavailable('warehouse-stopping'));
    this.pending.clear();
    await this.flushing;
  }
}
