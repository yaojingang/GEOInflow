import type { DecisionPlanner } from './consumer';
import type { Attempt, Ownership, WarehouseControl } from './control';
import { type ControlSQL, WarehouseConflict } from './control-db';
import type { DeletionOperation } from './deletions';
import { applyPublicationEffects } from './effects';
import type { InputPosition, LandedDecision, Receipt } from './landing';
import { validateLogPackage } from './log-planner';
import { applyPostgresFacts } from './postgres-facts';
import { routingKey } from './routing';
import { validateTask } from './tasks';
import { captureAuthoritativeResult, decisionResult } from './transition-capture';

export class PostgresAuthority {
  constructor(
    private readonly control: WarehouseControl,
    private readonly planner: DecisionPlanner,
    private readonly authorize: (
      tx: ControlSQL,
      attempt: Attempt,
      decisions: LandedDecision[],
    ) => Promise<void>,
  ) {
    if (control.authority !== 'postgres') throw new Error('warehouse-postgres-authority-required');
  }
  private async receipts(site: string, inputs: InputPosition[]): Promise<Receipt[]> {
    const ids = inputs
      .filter(i => i.envelope.clientEventId && i.envelope.kind !== 'log')
      .map(i => i.envelope.clientEventId);
    if (!ids.length) return [];
    const rows = await this.control.db.read<{
      client_event_id: string;
      payload_hash: string;
      original_session: string | null;
      original_visit: string | null;
      source: string | null;
      scope: string | null;
    }>(
      `
      SELECT r.client_event_id,r.payload_hash,e.session_id AS original_session,e.visit_id AS original_visit,
        coalesce(r.collection_source,q.source) AS source,coalesce(r.collection_scope,env.scope,q.source) AS scope
      FROM liekan_collection_receipt r LEFT JOIN website_event e ON e.website_id=r.website_id AND e.event_id=r.event_id
      LEFT JOIN liekan_event_quality q ON q.website_id=r.website_id AND q.event_id=r.event_id
      LEFT JOIN liekan_event_environment env ON env.website_id=r.website_id AND env.event_id=r.event_id
      WHERE r.website_id=$1 AND r.client_event_id=ANY($2::uuid[])`,
      [site, ids],
    );
    return rows.map(r => ({
      ...r,
      identity_key: routingKey({
        websiteId: site,
        sessionId: site,
        clientEventId: r.client_event_id,
      }),
      version: '0',
    }));
  }
  private async deleted(attempt: Attempt, inputs: InputPosition[], receipts: Receipt[]) {
    const sessions = inputs
      .map(i => i.envelope.sessionId)
      .concat(receipts.map(r => r.original_session))
      .filter(Boolean);
    const ids = inputs.map(i => i.envelope.clientEventId).filter(Boolean);
    const operations = await this.control.db.read<
      DeletionOperation & { client_event_id: string | null }
    >(
      `
      SELECT d.*,t.client_event_id FROM liekan_warehouse_deletion d LEFT JOIN liekan_warehouse_pg_receipt_tombstone t
        ON t.operation_id=d.operation_id AND t.client_event_id=ANY($3::uuid[])
      WHERE d.website_id=$1 AND d.epoch=$2 AND d.status IN('active','reclaimed')
        AND (d.session_id IS NULL OR d.session_id=ANY($4::uuid[]) OR t.client_event_id IS NOT NULL)`,
      [attempt.website_id, attempt.epoch, ids, sessions],
    );
    return new Set(
      inputs
        .filter(i =>
          operations.some(d => {
            const e = i.envelope,
              canonical = receipts.find(r => r.identity_key === routingKey(e))?.original_session;
            return (
              d.topic_id === e.topicId &&
              (!d.session_id ||
                d.session_id === (canonical ?? e.sessionId) ||
                d.client_event_id === e.clientEventId) &&
              d.boundary.some(
                b => b.partition === i.partition && BigInt(i.offset) < BigInt(b.offset),
              )
            );
          }),
        )
        .map(i => i.envelope.inputId),
    );
  }
  async process(owner: Ownership, attempt: Attempt, inputs: InputPosition[]) {
    const state = await this.control.site(attempt.website_id),
      receipts = await this.receipts(attempt.website_id, inputs);
    const deleted = await this.deleted(attempt, inputs, receipts);
    const stale = inputs.filter(
      i => i.envelope.epoch !== attempt.epoch || deleted.has(i.envelope.inputId),
    );
    const usable = inputs.filter(i => !stale.includes(i));
    const decisions: LandedDecision[] = [
      ...(usable.length ? await this.planner(usable, state, receipts) : []),
      ...stale.map(input => ({
        input,
        status: 'cancelled' as const,
        sessionId: null,
        visitId: null,
        facts: [],
        effects:
          input.envelope.kind === 'log'
            ? [
                {
                  kind: 'log-upload' as const,
                  batchId: validateLogPackage(input.envelope).packet.batchId,
                  processed: 1,
                  inserted: 0,
                  duplicates: 0,
                  conflicts: 0,
                  cancelled: 1,
                },
              ]
            : input.envelope.kind === 'task'
              ? [
                  {
                    kind: 'analysis-task' as const,
                    taskId: validateTask(input.envelope).taskId,
                    cancelled: true,
                  },
                ]
              : [],
      })),
    ];
    if (
      decisions.length !== inputs.length ||
      new Set(decisions.map(d => d.input.envelope.inputId)).size !== inputs.length
    )
      throw new Error('warehouse-postgres-planner-incomplete');
    await this.control.confirm(
      owner,
      attempt.attempt_id,
      attempt.input_digest,
      decisions.map(d => d.sessionId).filter(Boolean),
      decisions.flatMap(d => d.effects ?? []),
      (tx, a) => this.authorize(tx, a, decisions),
      async (tx, a) => {
        const normalized = await applyPostgresFacts(tx, a.website_id, decisions);
        await applyPublicationEffects(tx, [a.attempt_id]);
        await captureAuthoritativeResult(tx, decisionResult('postgres', a, normalized));
        const result = await tx.query(
          `UPDATE liekan_warehouse_work w SET status='confirmed',result_status=r.status,
          result_session_id=r.session,result_visit_id=r.visit,updated_at=clock_timestamp()
          FROM jsonb_to_recordset($2::jsonb) r(input uuid,status text,session uuid,visit uuid)
          WHERE w.attempt_id=$1 AND w.input_id=r.input AND w.status='working' RETURNING w.input_id`,
          [
            a.attempt_id,
            JSON.stringify(
              normalized.map(d => ({
                input: d.input.envelope.inputId,
                status: d.status,
                session: d.sessionId,
                visit: d.visitId,
              })),
            ),
          ],
        );
        if (result.rowCount !== inputs.length)
          throw new WarehouseConflict('warehouse-postgres-response-incomplete');
        await tx.query(
          'UPDATE liekan_warehouse_attempt SET decision_projected=true WHERE attempt_id=$1',
          [a.attempt_id],
        );
      },
    );
  }
  async recover(_owner: Ownership, attempt: Attempt) {
    const rows = await this.control.db.read<{ n: string }>(
      "SELECT count(*)::text AS n FROM liekan_warehouse_work WHERE attempt_id=$1 AND status='confirmed' AND result_status IS NOT NULL",
      [attempt.attempt_id],
    );
    if (Number(rows[0]?.n) !== attempt.input_count)
      throw new WarehouseConflict('warehouse-postgres-response-incomplete');
  }
}
