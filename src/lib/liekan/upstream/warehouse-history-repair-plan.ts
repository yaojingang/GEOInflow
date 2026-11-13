import { emptyLogImpact } from '../history-repair/log-impact';
import { addCounts, hash } from '../history-repair/model';
import { recordKey } from '../warehouse/codec';
import { factInput } from '../warehouse/fact-input';
import type { FactMutation } from '../warehouse/landing';
import { factRelation } from '../warehouse/read';
import { warehouseReader } from '../warehouse/reader-runtime';
import type { RepairBatchResult } from '../warehouse/repair-task';
import type { RunRow } from './history-repair-db';
import {
  finishRepairPreview,
  planRepairEvents,
  planRepairLogs,
  type ResultWrite,
  type VisitorWrite,
} from './history-repair-plan';
import {
  repairInputRelation,
  warehouseRepairEvents,
  warehouseRepairEvidence,
  warehouseRepairLogs,
  warehouseRepairQuery,
  warehouseRepairUndatedEvents,
} from './warehouse-history-repair-read';
import { withinWarehouseReport } from './warehouse-report-snapshot';

async function visitorFacts(
  row: RunRow,
  values: VisitorWrite[],
  now: Date,
): Promise<FactMutation[]> {
  const merged = new Map<string, ReturnType<typeof factInput>>();
  for (const v of values) {
    const data = factInput('liekan_history_repair_visitor', {
      run_id: row.id,
      website_id: row.website_id,
      generation: row.generation,
      scope_day: v.day,
      item_key: v.itemKey ?? '',
      session_id: v.session,
      before_included: v.before,
      after_included: v.after,
      created_at: now,
    });
    const key = recordKey('liekan_history_repair_visitor', data),
      old = merged.get(key);
    if (old) {
      data.before_included = !!old.before_included || !!data.before_included;
      data.after_included = !!old.after_included || !!data.after_included;
    }
    merged.set(key, data);
  }
  if (!merged.size) return [];
  const old = await warehouseRepairQuery<any>(
    row,
    `SELECT * FROM ${factRelation('liekan_history_repair_visitor', { recordKeysParameter: 'repairVisitorKeys' })}`,
    { repairVisitorKeys: [...merged.keys()] },
  );
  for (const v of old) {
    const key = recordKey('liekan_history_repair_visitor', v),
      data = merged.get(key);
    if (data) {
      data.before_included = !!v.before_included || !!data.before_included;
      data.after_included = !!v.after_included || !!data.after_included;
      data.created_at = v.created_at;
    }
  }
  return [...merged.values()].map(data => ({ family: 'liekan_history_repair_visitor', row: data }));
}
const resultFacts = (row: RunRow, values: ResultWrite[], now: Date): FactMutation[] =>
  values.map(v => ({
    family: 'liekan_history_repair_result',
    row: factInput('liekan_history_repair_result', {
      run_id: row.id,
      website_id: row.website_id,
      generation: row.generation,
      kind: v.kind,
      record_id: v.id,
      before_value: v.before,
      after_value: v.after,
      proof: v.proof,
      issue: v.issue,
      created_at: now,
    }),
  }));

/** Compute one bounded work unit outside any PostgreSQL transaction. */
export async function planWarehouseRepairBatch(original: RunRow) {
  return withinWarehouseReport(async () => {
    const row = structuredClone(original),
      now = new Date(),
      facts: FactMutation[] = [];
    const result: RepairBatchResult = {
      kind: 'history-repair-batch',
      runId: row.id,
      generation: row.generation,
      actorId: row.actor_id,
      revision: row.revision,
      inputRevision: row.input_revision,
      scopeRevision: String(row.scope_revision),
      authorityHash: row.snapshot.authorityHash,
      beforeStatus: row.status,
      beforePhase: row.phase,
      beforeCursor: structuredClone(row.cursor) as Record<string, string>,
      next: null,
      days: [],
      visitorDays: [],
      coverageDays: [],
    };
    if (row.phase === 'events') {
      const events = await warehouseRepairEvents(row);
      if (!events.length) {
        row.phase = 'undated-events';
        row.cursor = { membership: row.cursor.membership };
      } else {
        const planned = planRepairEvents(
          row,
          events,
          await warehouseRepairEvidence(
            row,
            events.map(e => e.id),
          ),
        );
        result.days = planned.days;
        facts.push(
          ...resultFacts(row, planned.results, now),
          ...(await visitorFacts(row, planned.visitors, now)),
        );
      }
    } else if (row.phase === 'undated-events') {
      const events = await warehouseRepairUndatedEvents(row);
      if (!events.length) {
        row.phase = 'logs';
        row.cursor = { membership: row.cursor.membership };
      } else {
        facts.push(
          ...resultFacts(
            row,
            events.map(e => {
              const verdict = {
                classification: e.classification,
                source: e.source,
                reasons: e.reasons,
                ruleVersion: e.rule_version,
              };
              return {
                id: e.id,
                kind: 'event',
                before: verdict,
                after: verdict,
                proof: { kind: 'undated-original', originalRuleVersion: e.rule_version },
                issue: 'missing-event-time',
              };
            }),
            now,
          ),
        );
        row.counts = addCounts(row.counts, {
          processed: String(events.length),
          undatedEvents: String(events.length),
        });
        row.cursor = {
          id: events.at(-1).id,
          membership: hash([row.cursor.membership, events.map(e => [e.id, null])]),
        };
      }
    } else if (row.phase === 'logs') {
      const logs = await warehouseRepairLogs(row);
      if (!logs.length) {
        row.phase = 'visitors';
        row.cursor = { membership: row.cursor.membership };
      } else {
        const originalForms = await warehouseReader().db.read<{
          version: string;
          id: string;
          form: string;
        }>(
          `SELECT DISTINCT v.version::text,identity->>'id' AS id,identity->>'productForm' AS form
          FROM jsonb_to_recordset($1::jsonb) wanted(version uuid,id text) JOIN liekan_crawler_registry_version v ON v.version=wanted.version
          CROSS JOIN LATERAL jsonb_array_elements(v.payload->'identities') identity WHERE identity->>'id'=wanted.id`,
          [
            JSON.stringify(
              logs
                .filter(l => l.catalog_version && l.crawler_id)
                .map(l => ({ version: l.catalog_version, id: l.crawler_id })),
            ),
          ],
        );
        const pinnedForms = await warehouseReader().db.read<{ id: string; form: string }>(
          `SELECT identity->>'id' AS id,identity->>'productForm' AS form FROM liekan_crawler_registry_version v
          CROSS JOIN LATERAL jsonb_array_elements(v.payload->'identities') identity WHERE v.version=$1::uuid`,
          [row.snapshot.rulepack.catalogVersion || null],
        );
        const planned = planRepairLogs(
          row,
          logs,
          new Map(originalForms.map(f => [`${f.version}:${f.id}`, f.form])),
          new Map(pinnedForms.map(f => [f.id, f.form])),
        );
        result.days = planned.days;
        facts.push(
          ...resultFacts(row, planned.results, now),
          ...(await visitorFacts(row, planned.visitors, now)),
        );
      }
    } else if (row.phase === 'visitors') {
      const visitors = await warehouseRepairQuery<{
        scope_day: string;
        session_id: string;
        before_included: boolean;
        after_included: boolean;
      }>(
        row,
        `SELECT scope_day,session_id,before_included,after_included FROM ${factRelation('liekan_history_repair_visitor')}
         WHERE run_id={repairRun:UUID} AND generation={repairGeneration:UUID} AND scope_day NOT LIKE 'log:%'
           AND ({visitorAfter:Nullable(String)} IS NULL OR (scope_day,session_id)>({visitorAfter:Nullable(String)},{visitorSession:UUID}))
         ORDER BY scope_day,session_id LIMIT {repairLimit:UInt32}`,
        {
          visitorAfter: row.cursor.visitorsAfter ?? null,
          visitorSession: row.cursor.visitorSession ?? '00000000-0000-0000-0000-000000000000',
        },
      );
      if (!visitors.length) row.phase = 'log-impact';
      else {
        const all = visitors.filter(v => v.scope_day === 'all');
        row.counts = addCounts(row.counts, {
          beforeUV: String(all.filter(v => v.before_included).length),
          afterUV: String(all.filter(v => v.after_included).length),
        });
        result.visitorDays = visitors
          .filter(v => v.scope_day !== 'all')
          .map(v => ({ day: v.scope_day, before: +v.before_included, after: +v.after_included }));
        row.cursor.visitorsAfter = visitors.at(-1).scope_day;
        row.cursor.visitorSession = visitors.at(-1).session_id;
      }
    } else if (row.phase === 'log-impact') {
      const values = await warehouseRepairQuery<{
        scope_day: string;
        item_key: string;
        before_included: boolean;
        after_included: boolean;
      }>(
        row,
        `SELECT scope_day,item_key,before_included,after_included FROM ${factRelation('liekan_history_repair_visitor')}
         WHERE run_id={repairRun:UUID} AND generation={repairGeneration:UUID} AND scope_day LIKE 'log:%'
           AND ({impactScope:Nullable(String)} IS NULL OR (scope_day,item_key)>({impactScope:Nullable(String)},{impactKey:String}))
         ORDER BY scope_day,item_key LIMIT {repairLimit:UInt32}`,
        { impactScope: row.cursor.impactScope ?? null, impactKey: row.cursor.impactKey ?? '' },
      );
      if (!values.length) row.phase = 'days';
      else {
        row.log_impact = { ...emptyLogImpact(), ...row.log_impact };
        for (const v of values) {
          const suffix = v.scope_day === 'log:identities' ? 'Identities' : 'AiPages';
          for (const [prefix, included] of [
            ['before', v.before_included],
            ['after', v.after_included],
          ] as const) {
            const key = `${prefix}${suffix}` as
              | 'beforeIdentities'
              | 'afterIdentities'
              | 'beforeAiPages'
              | 'afterAiPages';
            row.log_impact[key] = (BigInt(row.log_impact[key]) + BigInt(+included)).toString();
          }
        }
        row.cursor.impactScope = values.at(-1).scope_day;
        row.cursor.impactKey = values.at(-1).item_key;
      }
    } else if (row.phase === 'days') {
      const days = await warehouseReader().db.read<{ day: string }>(
        'SELECT day::text FROM liekan_history_repair_day WHERE run_id=$1 AND generation=$2 AND ($3::date IS NULL OR day>$3::date) ORDER BY day LIMIT 30',
        [row.id, row.generation, row.cursor.daysAfter ?? null],
      );
      if (days.length) {
        result.coverageDays = days.map(d => d.day);
        row.cursor.daysAfter = days.at(-1).day;
      } else {
        const uploads = await warehouseRepairQuery<{ id: string }>(
          row,
          `SELECT DISTINCT upload_id AS id FROM ${repairInputRelation()} WHERE state='finalized' ORDER BY id LIMIT 100`,
        );
        finishRepairPreview(row, uploads);
      }
    } else throw new Error('warehouse-repair-phase-unsupported');
    result.next = {
      status: row.status,
      phase: row.phase,
      cursor: row.cursor as Record<string, string>,
      counts: row.counts,
      logImpact: row.log_impact,
      preview: row.preview,
      errorCode: row.error_code,
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
      membershipDigest: row.membership_digest,
    };
    return { result, facts };
  });
}
