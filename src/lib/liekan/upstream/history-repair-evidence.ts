import { warehouseEnabled } from '@/lib/liekan/warehouse/authority-routing';
import {
  HISTORY_REPAIR_ENGINE,
  historyRepairEvidenceSchema,
  type HistoryRepairEvidenceResult,
} from '../contracts/history-repair';
import type { WriteIdentity } from './server';
import { LiekanError } from './errors';
import { withPublishedRegistry } from './crawler-registry-context';
import {
  classifySuppliedUa,
  evidenceManifestDigest,
  hash,
  workingStatuses,
} from '../history-repair/model';
import {
  repairTransaction,
  requireRun,
  expected,
  assertSnapshot,
  replayAction,
  audit,
  archiveGeneration,
  currentRepairInputSql,
  type RepairTx,
  type RunRow,
} from './history-repair-db';
export interface SavedEvidence {
  eventId: string;
  automated: boolean;
  reasons: string[];
  hash: string;
  uploadId: string;
}
interface InputRow {
  sequence: number;
  chunk_hash: string;
  rulepack_hash: string;
  rows: number;
  accepted: number;
  errors: { row: number; code: string }[];
  invalid: number;
  state: string;
  source: string;
  usable: boolean;
}
async function mutable(row: RunRow) {
  if ((row.confirmed_at && row.status !== 'rolled_back') || workingStatuses.includes(row.status))
    throw new LiekanError('请等待准备完成后补充证据', 409, 'history-repair-not-editable');
  if (['expired', 'invalidated', 'cancelled'].includes(row.status))
    throw new LiekanError('请重新扫描历史范围', 409, 'history-repair-scan-required');
}
export async function ingestHistoryRepairEvidence(
  websiteId: string,
  input: unknown,
  identity: WriteIdentity,
): Promise<HistoryRepairEvidenceResult> {
  const parsed = historyRepairEvidenceSchema.safeParse(input);
  if (!parsed.success)
    throw new LiekanError('证据格式无效', 400, 'history-repair-invalid-evidence');
  const body = parsed.data;
  if (warehouseEnabled())
    return (await import('./warehouse-history-repair-evidence')).ingestWarehouseRepairEvidence(
      websiteId,
      body,
      identity,
    );
  // The route enforces the byte limit while streaming; this also bounds direct adapter callers.
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 1024 * 1024)
    throw new LiekanError('每个证据分块上限为 1 MiB', 413, 'history-repair-evidence-too-large');
  // Only hashes and derived matches cross the persistence boundary.
  const payloadHash = hash(body);
  return withPublishedRegistry(() =>
    repairTransaction(async tx => {
      const row = await requireRun(tx, websiteId, identity);
      const prior = await replayAction<HistoryRepairEvidenceResult>(
        tx,
        websiteId,
        identity,
        body.actionId,
        { action: body.action, hash: payloadHash },
      );
      if (prior) return prior;
      expected(row, body.expectedRevision, body.runId);
      await mutable(row);
      await assertSnapshot(tx, row, true);
      const chunks = await tx.$queryRawUnsafe<InputRow[]>(
        `SELECT sequence,chunk_hash,rulepack_hash,rows,accepted,CASE WHEN sequence=$3::integer THEN errors ELSE '[]'::jsonb END AS errors,jsonb_array_length(errors) AS invalid,state,source,(${currentRepairInputSql}) AS usable FROM liekan_history_repair_input i WHERE run_id=$1::uuid AND upload_id=$2::uuid ORDER BY sequence FOR NO KEY UPDATE`,
        row.id,
        body.uploadId,
        body.action === 'append' ? body.sequence : null,
      );
      if (chunks.some(chunk => !chunk.usable))
        throw new LiekanError(
          '证据文件已过期，请重新上传原文件',
          409,
          'history-repair-evidence-expired',
        );
      if (row.status === 'rolled_back') await archiveGeneration(tx, row);
      let result: HistoryRepairEvidenceResult;
      if (body.action === 'append') {
        const [uploads] = await tx.$queryRawUnsafe<{ count: number }[]>(
          `SELECT count(distinct upload_id)::int AS count FROM liekan_history_repair_input i WHERE run_id=$1::uuid AND state<>'discarded' AND upload_id<>$2::uuid AND rulepack_hash=$3 AND ${currentRepairInputSql}`,
          row.id,
          body.uploadId,
          row.snapshot.rulepack.hash,
        );
        if (uploads.count >= 100 && !chunks.length)
          throw new LiekanError(
            '最多保留100个待处理证据文件，请先撤下不使用的文件',
            413,
            'history-repair-upload-limit',
          );
        const chunkHash = hash({
          sequence: body.sequence,
          source: body.source,
          records: body.records,
        });
        const priorChunk = chunks.find(chunk => chunk.sequence === body.sequence);
        if (priorChunk) {
          if (
            priorChunk.chunk_hash !== chunkHash ||
            priorChunk.source !== body.source ||
            priorChunk.state === 'discarded'
          )
            throw new LiekanError('同一证据分块的内容已改变', 409, 'history-repair-chunk-conflict');
          result = {
            uploadId: body.uploadId,
            sequence: body.sequence,
            hash: chunkHash,
            revision: row.revision,
            accepted: priorChunk.accepted,
            rejected: priorChunk.rows - priorChunk.accepted,
            errors: priorChunk.errors,
            finalized: priorChunk.state === 'finalized',
            discarded: false,
          };
          return audit(
            tx,
            row,
            identity,
            'evidence-retry',
            { action: body.action, hash: payloadHash },
            result,
            body.actionId,
          );
        }
        if (
          chunks.some(chunk => chunk.state !== 'open') ||
          body.sequence !== chunks.length ||
          chunks.some(
            chunk =>
              chunk.rulepack_hash !== row.snapshot.rulepack.hash || chunk.source !== body.source,
          )
        )
          throw new LiekanError(
            '证据序号或规则包发生冲突',
            409,
            'history-repair-manifest-conflict',
          );
        const resolved = await tx.$queryRawUnsafe<
          {
            event_id: string;
            client_event_id: string | null;
            source: string;
            repair_scope_id: string | null;
            dated: boolean;
          }[]
        >(
          `SELECT e.event_id::text,wanted.client_event_id::text,q.source,q.repair_scope_id,(e.created_at IS NOT NULL) AS dated
           FROM jsonb_to_recordset($2::jsonb) wanted(event_id uuid,client_event_id uuid)
           LEFT JOIN liekan_collection_receipt receipt ON receipt.website_id=$1::uuid AND receipt.client_event_id=wanted.client_event_id
           JOIN website_event e ON e.website_id=$1::uuid AND e.event_id=coalesce(wanted.event_id,receipt.event_id)
           JOIN liekan_event_quality q ON q.website_id=e.website_id AND q.event_id=e.event_id`,
          websiteId,
          JSON.stringify(
            body.records.map(record =>
              'eventId' in record
                ? { event_id: record.eventId, client_event_id: null }
                : { event_id: null, client_event_id: record.clientEventId },
            ),
          ),
        );
        const byEvent = new Map(resolved.map(value => [value.event_id, value]));
        const byClient = new Map<string, typeof resolved>();
        for (const value of resolved)
          if (
            value.client_event_id &&
            !byClient.get(value.client_event_id)?.some(prior => prior.event_id === value.event_id)
          )
            byClient.set(value.client_event_id, [
              ...(byClient.get(value.client_event_id) || []),
              value,
            ]);
        const classifiedRecords = body.records.map(record =>
          classifySuppliedUa(record.requestUserAgent, row.snapshot.rulepack),
        );
        const wanted = body.records.flatMap((record, index) => {
          const found =
            'eventId' in record
              ? byEvent.get(record.eventId)
              : byClient.get(record.clientEventId)?.[0];
          return found ? [{ event_id: found.event_id, hash: classifiedRecords[index].hash }] : [];
        });
        const conflicts = await tx.$queryRawUnsafe<{ event_id: string }[]>(
          `SELECT DISTINCT w.event_id FROM jsonb_to_recordset($2::jsonb) w(event_id text,hash text)
          WHERE EXISTS(SELECT 1 FROM liekan_history_repair_input i WHERE i.run_id=$1::uuid AND i.state<>'discarded' AND i.rulepack_hash=$3 AND ${currentRepairInputSql}
          AND i.records @> jsonb_build_array(jsonb_build_object('eventId',w.event_id))
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(i.records) r WHERE r->>'eventId'=w.event_id AND r->>'hash'<>w.hash)) LIMIT 1000`,
          row.id,
          JSON.stringify(wanted),
          row.snapshot.rulepack.hash,
        );
        const conflictIds = new Set(conflicts.map(record => record.event_id));
        const previous = new Map<string, string>();
        const errors: { row: number; code: string }[] = [];
        const saved: SavedEvidence[] = [];
        for (let index = 0; index < body.records.length; index++) {
          const record = body.records[index];
          const candidates =
            'eventId' in record
              ? byEvent.has(record.eventId)
                ? [byEvent.get(record.eventId)]
                : []
              : byClient.get(record.clientEventId) || [];
          const found = candidates[0];
          let code =
            candidates.length !== 1
              ? 'event-not-resolved'
              : found.source !== 'browser'
                ? 'browser-source-required'
                : found.repair_scope_id !== null
                  ? 'outside-frozen-scope'
                  : !found.dated
                    ? 'event-date-missing'
                    : null;
          const classified = classifiedRecords[index];
          if (
            !code &&
            (conflictIds.has(found.event_id) ||
              (previous.has(found.event_id) && previous.get(found.event_id) !== classified.hash))
          )
            code = 'conflicting-event-evidence';
          if (code) {
            errors.push({ row: index + 1, code });
            continue;
          }
          saved.push({ eventId: found.event_id, ...classified, uploadId: body.uploadId });
          previous.set(found.event_id, classified.hash);
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO liekan_history_repair_input(run_id,website_id,upload_id,sequence,chunk_hash,rulepack_hash,source,actor_id,rows,accepted,errors,records,generation,created_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::uuid,$9,$10,$11::jsonb,$12::jsonb,$13::uuid,clock_timestamp())`,
          row.id,
          websiteId,
          body.uploadId,
          body.sequence,
          chunkHash,
          row.snapshot.rulepack.hash,
          body.source,
          identity.userId,
          body.records.length,
          saved.length,
          JSON.stringify(errors),
          JSON.stringify(saved),
          row.generation,
        );
        result = {
          uploadId: body.uploadId,
          sequence: body.sequence,
          hash: chunkHash,
          revision: row.revision + 1,
          accepted: saved.length,
          rejected: errors.length,
          errors,
          finalized: false,
          discarded: false,
        };
      } else if (body.action === 'finalize') {
        const manifestDigest = evidenceManifestDigest(chunks.map(chunk => chunk.chunk_hash));
        if (
          !chunks.length ||
          chunks.length !== body.chunks ||
          (body.manifest !== undefined && body.manifest.length !== body.chunks) ||
          (body.manifestDigest !== undefined && body.manifestDigest !== manifestDigest) ||
          chunks.some(
            (chunk, index) =>
              chunk.sequence !== index ||
              (body.manifest !== undefined && chunk.chunk_hash !== body.manifest[index]) ||
              chunk.rulepack_hash !== row.snapshot.rulepack.hash ||
              chunk.invalid > 0 ||
              chunk.state === 'discarded',
          ) ||
          chunks.reduce((n, c) => n + c.rows, 0) !== body.rows
        )
          throw new LiekanError(
            '证据文件存在无效行、缺块或摘要不一致',
            409,
            'history-repair-evidence-incomplete',
          );
        await tx.$executeRawUnsafe(
          `UPDATE liekan_history_repair_input SET state='finalized',manifest_hash=$3 WHERE run_id=$1::uuid AND upload_id=$2::uuid`,
          row.id,
          body.uploadId,
          hash({
            manifestDigest,
            chunks: body.chunks,
            rows: body.rows,
            rulepack: row.snapshot.rulepack.hash,
          }),
        );
        result = {
          uploadId: body.uploadId,
          revision: row.revision + 1,
          accepted: body.rows,
          rejected: 0,
          errors: [],
          finalized: true,
          discarded: false,
        };
      } else {
        // An active generation retains the exact evidence it references.
        const referenced = await tx.$queryRawUnsafe(
          `SELECT 1 FROM liekan_history_repair_result WHERE run_id=$1::uuid AND generation=ANY($2::uuid[]) AND proof->>'uploadId'=$3 LIMIT 1`,
          row.id,
          [row.active_generation].filter(Boolean),
          body.uploadId,
        );
        if (referenced.length)
          throw new LiekanError(
            '生效代次仍引用该证据，请先回退并保留审计',
            409,
            'history-repair-active-evidence',
          );
        if (!chunks.length)
          throw new LiekanError('证据文件不存在', 404, 'history-repair-upload-not-found');
        await tx.$executeRawUnsafe(
          `UPDATE liekan_history_repair_input SET state='discarded',records='[]' WHERE run_id=$1::uuid AND upload_id=$2::uuid`,
          row.id,
          body.uploadId,
        );
        result = {
          uploadId: body.uploadId,
          revision: row.revision + 1,
          accepted: 0,
          rejected: 0,
          errors: [],
          finalized: false,
          discarded: true,
        };
      }
      await tx.$executeRawUnsafe(
        `UPDATE liekan_history_repair_run SET revision=revision+1,input_revision=input_revision+1,status='paused',preview=NULL,confirmed_at=NULL,approved_digest=NULL,error_code='evidence-changed',updated_at=clock_timestamp() WHERE id=$1::uuid`,
        row.id,
      );
      return audit(
        tx,
        row,
        identity,
        `evidence-${body.action}`,
        { action: body.action, hash: payloadHash },
        result,
        body.actionId,
        { uploadId: body.uploadId, engine: HISTORY_REPAIR_ENGINE },
      );
    }),
  );
}
