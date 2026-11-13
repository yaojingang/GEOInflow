import { warehouseTime } from '../warehouse/fact-input';
import { repairLogSourceRelation } from '../warehouse/log-scope-proof';
import { acceptedCandidates, boundaryParameters, factRelation } from '../warehouse/read';
import { warehouseReader } from '../warehouse/reader-runtime';
import { qualityAuditRelation, reportingParameters } from '../warehouse/reporting-relations';
import type { RunRow } from './history-repair-db';
import type { SavedEvidence } from './history-repair-evidence';
import type { EventRow, LogRow } from './history-repair-plan';
import { LiekanError } from './server';
import { repairUploadControls } from './warehouse-history-repair-inputs';
import { warehouseReportMetadata, withinWarehouseReport } from './warehouse-report-snapshot';

const iso = (column: string) => `formatDateTime(${column},'%Y-%m-%dT%H:%i:%S.%fZ','UTC')`;
export const repairInputRelation =
  () => `(SELECT * REPLACE(arrayElement({repairUploadStates:Array(String)},indexOf({repairUploads:Array(UUID)},upload_id)) AS state) FROM ${factRelation('liekan_history_repair_input')}
  WHERE run_id={repairRun:UUID} AND rulepack_hash={repairRulepack:String} AND upload_id IN {repairUploads:Array(UUID)}
    AND ({repairInputAfter:Nullable(DateTime64(6,'UTC'))} IS NULL OR created_at>{repairInputAfter:Nullable(DateTime64(6,'UTC'))}))`;

// Original facts are read at the durable source publication frozen by the run.
// Evidence/result families use the current published boundary of each bounded
// work unit. Deletion/reset invalidates the frozen source instead of reviving it.
export async function warehouseRepairQuery<T>(
  row: RunRow,
  sql: string,
  params: Record<string, unknown> = {},
  source = false,
): Promise<T[]> {
  return withinWarehouseReport(async () => {
    const m = await warehouseReportMetadata(row.website_id),
      frozen = row.snapshot.warehouseSource;
    if (
      source &&
      (!frozen ||
        frozen.websiteId !== row.website_id ||
        frozen.epoch !== m.boundary.epoch ||
        frozen.deletionRevision !== m.boundary.deletionRevision ||
        BigInt(frozen.publication) > BigInt(m.boundary.publication))
    )
      throw new LiekanError(
        '冻结后的历史输入发生变化，请重新预览',
        409,
        'history-repair-scope-changed',
      );
    const uploads = sql.includes('{repairUploadStates:') ? await repairUploadControls(row) : [];
    return warehouseReader().admission.run(() =>
      warehouseReader()
        .ch.query({
          query: sql,
          query_params: {
            ...reportingParameters(m),
            ...(source ? boundaryParameters(frozen) : {}),
            repairUploads: uploads.map(u => u.upload_id),
            repairUploadStates: uploads.map(u => u.state),
            repairRun: row.id,
            repairGeneration: row.generation,
            repairRulepack: row.snapshot.rulepack.hash,
            repairInputAfter: row.snapshot.inputNotBefore
              ? warehouseTime(row.snapshot.inputNotBefore)
              : null,
            repairTimezone: row.snapshot.timezone,
            repairLimit: row.batch_size,
            repairAfterTime: row.cursor.time ? warehouseTime(row.cursor.time) : null,
            repairAfterId: row.cursor.id ?? '00000000-0000-0000-0000-000000000000',
            ...params,
          },
          format: 'JSONEachRow',
        })
        .then(r => r.json<T>()),
    );
  });
}
export async function warehouseRepairEvents(row: RunRow): Promise<EventRow[]> {
  const rows = await warehouseRepairQuery<EventRow>(
    row,
    `SELECT event_id AS id,${iso('created_at')} AS time,formatDateTime(created_at,'%Y-%m-%d',{repairTimezone:String}) AS day,
    session_id,event_type,policy_hostname AS hostname,origin_hostname,excluded,identity_available,identity_scope,
    classification,source,reasons,rule_version,current_classification,current_reasons,current_rule_version
    FROM ${qualityAuditRelation({})} WHERE isNotNull(verdict_id) AND isNull(repair_scope_id) AND isNotNull(created_at)
    AND (isNull({repairAfterTime:Nullable(DateTime64(6,'UTC'))}) OR (created_at,event_id)>({repairAfterTime:Nullable(DateTime64(6,'UTC'))},toUUID({repairAfterId:String})))
    ORDER BY created_at,event_id LIMIT {repairLimit:UInt32}`,
    {},
    true,
  );
  return rows.map(r => ({
    ...r,
    excluded: !!r.excluded,
    identity_available: !!r.identity_available,
  }));
}
export async function warehouseRepairUndatedEvents(row: RunRow) {
  return warehouseRepairQuery<
    Pick<EventRow, 'id' | 'classification' | 'source' | 'reasons' | 'rule_version'>
  >(
    row,
    `SELECT event_id AS id,classification,source,reasons,rule_version FROM ${qualityAuditRelation({})}
      WHERE isNotNull(verdict_id) AND isNull(repair_scope_id) AND isNull(created_at) AND event_id>toUUID({repairAfterId:String})
      ORDER BY event_id LIMIT {repairLimit:UInt32}`,
    {},
    true,
  );
}
export async function warehouseRepairEvidence(row: RunRow, ids: string[]) {
  if (!ids.length) return [];
  const rows = await warehouseRepairQuery<{ record: string }>(
    row,
    `SELECT record FROM
    (SELECT upload_id,sequence,arrayJoin(JSONExtractArrayRaw(records)) AS record FROM ${repairInputRelation()} WHERE state='finalized')
    WHERE JSONExtractString(record,'eventId') IN {repairIds:Array(String)}
    ORDER BY JSONExtractString(record,'eventId'),upload_id,sequence LIMIT 1 BY JSONExtractString(record,'eventId')`,
    { repairIds: ids },
  );
  return rows.map(r => ({ record: JSON.parse(r.record) as SavedEvidence }));
}
async function nextRepairLogDay(row: RunRow, previous: string | null) {
  // Seek only days present in the frozen publication. The batch still applies
  // row versions, deletion and original-import scope.
  const [result] = await warehouseRepairQuery<{ day: string }>(
    row,
    `SELECT toDate32(_record_time) AS day FROM warehouse_liekan_log
    WHERE _website_id={wh_site:UUID} AND _epoch={wh_epoch:UInt64}
      ${previous ? 'AND toDate32(_record_time)>{previousDay:Date32}' : ''}
      AND (_attempt_id,_candidate_id) IN (${acceptedCandidates('liekan_log')})
    ORDER BY _website_id,_epoch,toDate32(_record_time) LIMIT 1 SETTINGS optimize_read_in_order=1`,
    previous ? { previousDay: previous } : {},
    true,
  );
  return result?.day;
}

export function repairLogBatchSQL() {
  const logs = repairLogSourceRelation({
    immutableTimeWindow: { start: 'repairDayStart', end: 'repairDayEnd', endExclusive: true },
    orderedLogVersions: true,
    narrowLogWindow: true,
    columns: [
      'website_id',
      'id',
      '_record_key',
      '_candidate_id',
      'import_id',
      'created_at',
      'source_id',
      'user_agent',
      'path',
      'bot',
      'vendor',
      'bot_type',
      'ai_eligible',
      'recognition_state',
      'recognition_candidates',
      'verification',
      'verification_version',
      'verification_observed_at',
      'verification_reason',
    ],
  });
  const evidence = factRelation('liekan_crawler_evidence', {
    columns: ['website_id', 'log_id', 'catalog_version', 'crawler_id', 'identity_evidence'],
    evidenceLogBatch: true,
  });
  return `WITH repair_log_batch AS MATERIALIZED (
      SELECT * FROM ${logs}
      WHERE isNull({repairAfterTime:Nullable(DateTime64(6,'UTC'))})
        OR (created_at,id)>({repairAfterTime:Nullable(DateTime64(6,'UTC'))},{repairLogAfterId:String})
      ORDER BY created_at,id LIMIT {repairLimit:UInt32}
    )
    SELECT l.id AS id,${iso('l.created_at')} AS time,formatDateTime(l.created_at,'%Y-%m-%d',{repairTimezone:String}) AS day,
    l.user_agent AS user_agent,l.path AS path,e.catalog_version AS catalog_version,l.bot AS bot,l.vendor AS vendor,l.bot_type AS bot_type,
    l.ai_eligible AS ai_eligible,e.crawler_id AS crawler_id,l.recognition_state AS recognition_state,l.recognition_candidates AS recognition_candidates,
    l.verification AS verification,l.verification_version AS verification_version,${iso('l.verification_observed_at')} AS verification_observed_at,
    l.verification_reason AS verification_reason,e.identity_evidence AS identity_evidence
    FROM repair_log_batch l LEFT JOIN ${evidence} e ON e.website_id=l.website_id AND e.log_id=l.id
    ORDER BY l.created_at,l.id SETTINGS enable_materialized_cte=1`;
}

type RepairLogWireRow = Omit<
  LogRow,
  'ai_eligible' | 'recognition_candidates' | 'identity_evidence'
> & {
  ai_eligible: boolean | number | null;
  recognition_candidates: string | null;
  identity_evidence: string | null;
};

export async function warehouseRepairLogs(row: RunRow): Promise<LogRow[]> {
  return withinWarehouseReport(async () => {
    const sql = repairLogBatchSQL();
    const batch: RepairLogWireRow[] = [];
    let afterTime = row.cursor.time ? warehouseTime(row.cursor.time) : null;
    let day = afterTime ? afterTime.slice(0, 10) : await nextRepairLogDay(row, null);
    while (day && batch.length < row.batch_size) {
      const start = new Date(`${day}T00:00:00Z`);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);
      const logs = await warehouseRepairQuery<RepairLogWireRow>(
        row,
        sql,
        {
          repairDayStart: warehouseTime(start),
          repairDayEnd: warehouseTime(end),
          repairAfterTime: afterTime,
          repairLogAfterId: afterTime ? (row.cursor.id ?? '') : '',
          repairLimit: row.batch_size - batch.length,
        },
        true,
      );
      batch.push(...logs);
      if (batch.length === row.batch_size) break;
      day = await nextRepairLogDay(row, day);
      afterTime = null;
    }
    return batch.map(r => ({
      ...r,
      ai_eligible: r.ai_eligible === null ? null : !!r.ai_eligible,
      recognition_candidates:
        r.recognition_candidates === null ? null : JSON.parse(r.recognition_candidates),
      identity_evidence: r.identity_evidence === null ? null : JSON.parse(r.identity_evidence),
    }));
  });
}
export async function warehouseRepairSourceCounts(row: RunRow) {
  const [counts] = await warehouseRepairQuery<{ events: string; logs: string; missing: string }>(
    row,
    `SELECT
    (SELECT count() FROM ${factRelation('liekan_event_quality')} WHERE isNull(repair_scope_id)) AS events,
    (SELECT count() FROM ${repairLogSourceRelation()}) AS logs,
    (SELECT count() FROM ${factRelation('website_event')} WHERE event_id NOT IN (SELECT event_id FROM ${factRelation('liekan_event_quality')})) AS missing`,
    {},
    true,
  );
  return counts;
}
