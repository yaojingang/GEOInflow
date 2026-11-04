import { createHash } from 'node:crypto';
import {
  HISTORY_REPAIR_ENGINE,
  type HistoryRepairEvidenceInput,
  type HistoryRepairEvidenceResult,
} from '../contracts/history-repair';
import { classifySuppliedUa, hash, workingStatuses } from '../history-repair/model';
import { factInput } from '../warehouse/fact-input';
import { factRelation } from '../warehouse/read';
import type { RepairInputResult } from '../warehouse/repair-input-task';
import { warehouseRuntime, type WarehouseRuntime } from '../warehouse/runtime';
import { prepareWarehouseTask, waitWarehouseTask } from '../warehouse/tasks';
import { withPublishedRegistry } from './crawler-registry-context';
import {
  archiveGeneration,
  assertSnapshot,
  audit,
  expected,
  repairTransaction,
  replayAction,
  requireRun,
  runForSite,
  type RunRow,
} from './history-repair-db';
import type { SavedEvidence } from './history-repair-evidence';
import { LiekanError, lockWritableWebsite, type WriteIdentity } from './server';
import { authorizeWarehouseTask, warehouseControlAdapter } from './warehouse-authority';
import { repairUploadControls, type RepairUpload } from './warehouse-history-repair-inputs';
import { repairInputRelation, warehouseRepairQuery } from './warehouse-history-repair-read';

function mutable(row: RunRow) {
  if ((row.confirmed_at && row.status !== 'rolled_back') || workingStatuses.includes(row.status))
    throw new LiekanError('请等待准备完成后补充证据', 409, 'history-repair-not-editable');
  if (['expired', 'invalidated', 'cancelled'].includes(row.status))
    throw new LiekanError('请重新扫描历史范围', 409, 'history-repair-scan-required');
}
async function context(
  site: string,
  body: HistoryRepairEvidenceInput,
  identity: WriteIdentity,
  payloadHash: string,
) {
  return repairTransaction(async tx => {
    await lockWritableWebsite(tx, site, identity);
    const prior = await replayAction<HistoryRepairEvidenceResult>(
      tx,
      site,
      identity,
      body.actionId,
      { action: body.action, hash: payloadHash },
    );
    if (prior) return { prior };
    const row = await runForSite(tx, site, false);
    if (!row) throw new LiekanError('请先扫描历史数据', 409, 'history-repair-scan-required');
    const [pending] = await tx.$queryRawUnsafe<{ task_id: string; result: RepairInputResult }[]>(
      `SELECT task_id::text,result FROM liekan_warehouse_task
      WHERE website_id=$1::uuid AND kind='history-repair-input' AND scope_key=$2 AND status IN('pending','confirmed')`,
      site,
      row.id,
    );
    if (
      pending &&
      pending.result.actionId === body.actionId &&
      pending.result.actorId === identity.userId &&
      pending.result.payloadHash === payloadHash
    )
      return { pending: pending.task_id };
    const current = await requireRun(tx, site, identity);
    expected(current, body.expectedRevision, body.runId);
    mutable(current);
    await assertSnapshot(tx, current, true);
    return { row: current };
  });
}
async function locked(
  site: string,
  body: HistoryRepairEvidenceInput,
  identity: WriteIdentity,
  row: RunRow,
  work: (tx: any, current: RunRow) => Promise<HistoryRepairEvidenceResult>,
) {
  return repairTransaction(async tx => {
    const current = await requireRun(tx, site, identity);
    expected(current, body.expectedRevision, body.runId);
    mutable(current);
    await assertSnapshot(tx, current, true);
    if (current.input_revision !== row.input_revision || current.generation !== row.generation)
      throw new LiekanError('修复输入已变化，请刷新', 409, 'history-repair-input-changed');
    if (current.status === 'rolled_back') await archiveGeneration(tx, current);
    return work(tx, current);
  });
}
type Chunk = {
  sequence: number;
  chunk_hash: string;
  rulepack_hash: string;
  source: string;
  rows: number;
  accepted: number;
  errors: string;
  state: string;
};
async function chunk(row: RunRow, upload: string, sequence: number) {
  return (
    await warehouseRepairQuery<Chunk>(
      row,
      `SELECT sequence,chunk_hash,rulepack_hash,source,rows,accepted,errors,state
    FROM ${factRelation('liekan_history_repair_input')} WHERE run_id={repairRun:UUID} AND upload_id={upload:UUID} AND sequence={sequence:Int32}`,
      { upload, sequence },
    )
  )[0];
}
async function resolve(
  row: RunRow,
  body: Extract<HistoryRepairEvidenceInput, { action: 'append' }>,
) {
  const receipts = await warehouseRepairQuery<{ client_event_id: string; event_id: string }>(
    row,
    `SELECT client_event_id,event_id FROM ${factRelation('liekan_collection_receipt')} WHERE client_event_id IN {clients:Array(UUID)}`,
    { clients: body.records.flatMap(r => ('clientEventId' in r ? [r.clientEventId] : [])) },
  );
  const byClient = new Map(receipts.map(r => [r.client_event_id, r.event_id]));
  const ids = body.records.flatMap(r => {
    const id = 'eventId' in r ? r.eventId : byClient.get(r.clientEventId);
    return id ? [id] : [];
  });
  const records = ids.length
    ? await warehouseRepairQuery<{
        event_id: string;
        source: string;
        repair_scope_id: string | null;
        dated: number;
      }>(
        row,
        `SELECT e.event_id,q.source,q.repair_scope_id,isNotNull(e.created_at) AS dated
      FROM ${factRelation('website_event')} e INNER JOIN ${factRelation('liekan_event_quality')} q ON q.event_id=e.event_id
      WHERE e.event_id IN {ids:Array(UUID)}`,
        { ids },
      )
    : [];
  const byEvent = new Map(records.map(r => [r.event_id, r]));
  const old = ids.length
    ? await warehouseRepairQuery<{ event: string; hash: string }>(
        row,
        `SELECT DISTINCT JSONExtractString(record,'eventId') AS event,JSONExtractString(record,'hash') AS hash FROM
      (SELECT arrayJoin(JSONExtractArrayRaw(records)) AS record FROM ${repairInputRelation()}) WHERE event IN {ids:Array(String)}`,
        { ids },
      )
    : [];
  const previous = new Map<string, Set<string>>();
  for (const v of old) previous.set(v.event, new Set([...(previous.get(v.event) ?? []), v.hash]));
  const saved: SavedEvidence[] = [],
    errors: { row: number; code: string }[] = [];
  for (const [index, record] of body.records.entries()) {
    const id = 'eventId' in record ? record.eventId : byClient.get(record.clientEventId),
      found = byEvent.get(id);
    let code = !found
      ? 'event-not-resolved'
      : found.source !== 'browser'
        ? 'browser-source-required'
        : found.repair_scope_id !== null
          ? 'outside-frozen-scope'
          : !found.dated
            ? 'event-date-missing'
            : null;
    const classified = classifySuppliedUa(record.requestUserAgent, row.snapshot.rulepack);
    if (!code && [...(previous.get(id) ?? [])].some(h => h !== classified.hash))
      code = 'conflicting-event-evidence';
    if (code) {
      errors.push({ row: index + 1, code });
      continue;
    }
    saved.push({ eventId: id, ...classified, uploadId: body.uploadId });
    previous.set(id, new Set([classified.hash]));
  }
  return { saved, errors };
}
async function verifyManifest(
  row: RunRow,
  body: Extract<HistoryRepairEvidenceInput, { action: 'finalize' }>,
  file: RepairUpload,
) {
  if (
    file.state === 'discarded' ||
    file.chunks !== body.chunks ||
    BigInt(file.rows) !== BigInt(body.rows) ||
    file.accepted !== file.rows ||
    (body.manifest !== undefined && body.manifest.length !== body.chunks)
  )
    throw new LiekanError(
      '证据文件存在无效行、缺块或摘要不一致',
      409,
      'history-repair-evidence-incomplete',
    );
  const digest = createHash('sha256');
  let after = -1,
    count = 0,
    rows = 0n;
  // Ordered keyset pages keep million-chunk manifests bounded in memory.
  for (;;) {
    const page = await warehouseRepairQuery<Chunk>(
      row,
      `SELECT sequence,chunk_hash,rulepack_hash,source,rows,accepted,errors,state
      FROM ${repairInputRelation()} WHERE upload_id={upload:UUID} AND sequence>{after:Int32} ORDER BY sequence LIMIT 1000`,
      { upload: body.uploadId, after },
    );
    if (!page.length) break;
    for (const c of page) {
      if (
        c.sequence !== count ||
        c.rulepack_hash !== row.snapshot.rulepack.hash ||
        c.rows !== c.accepted ||
        JSON.parse(c.errors).length ||
        (body.manifest !== undefined && body.manifest[count] !== c.chunk_hash)
      )
        throw new LiekanError(
          '证据文件存在无效行、缺块或摘要不一致',
          409,
          'history-repair-evidence-incomplete',
        );
      digest.update(`${c.chunk_hash}\n`);
      rows += BigInt(c.rows);
      count++;
      after = c.sequence;
    }
  }
  const manifestDigest = digest.digest('hex');
  if (
    count !== body.chunks ||
    rows !== BigInt(body.rows) ||
    (body.manifestDigest !== undefined && body.manifestDigest !== manifestDigest)
  )
    throw new LiekanError(
      '证据文件存在无效行、缺块或摘要不一致',
      409,
      'history-repair-evidence-incomplete',
    );
  return hash({
    manifestDigest,
    chunks: body.chunks,
    rows: body.rows,
    rulepack: row.snapshot.rulepack.hash,
  });
}
export async function ingestWarehouseRepairEvidence(
  site: string,
  body: HistoryRepairEvidenceInput,
  identity: WriteIdentity,
  supplied?: WarehouseRuntime,
): Promise<HistoryRepairEvidenceResult> {
  if (Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024)
    throw new LiekanError('每个证据分块上限为 1 MiB', 413, 'history-repair-evidence-too-large');
  return withPublishedRegistry(async () => {
    const payloadHash = hash(body),
      runtime = supplied ?? (await warehouseRuntime());
    const c = await context(site, body, identity, payloadHash);
    if (c.prior) return c.prior;
    if (c.pending) {
      await waitWarehouseTask(runtime.db, c.pending);
      const resumed = await context(site, body, identity, payloadHash);
      if (resumed.prior) return resumed.prior;
      throw new LiekanError('证据操作仍在发布', 409, 'history-repair-publication-pending');
    }
    const row = c.row,
      files = await repairUploadControls(row),
      file = files.find(f => f.upload_id === body.uploadId);
    // Check the durable file identity even if it is expired or discarded.
    const [anyFile] = await runtime.db.read<RepairUpload>(
      'SELECT * FROM liekan_warehouse_repair_upload WHERE run_id=$1 AND upload_id=$2',
      [row.id, body.uploadId],
    );
    if (anyFile && !file && anyFile.state !== 'discarded')
      throw new LiekanError(
        '证据文件已过期，请重新上传原文件',
        409,
        'history-repair-evidence-expired',
      );
    if (body.action === 'append') {
      const chunkHash = hash({
          sequence: body.sequence,
          source: body.source,
          records: body.records,
        }),
        old = await chunk(row, body.uploadId, body.sequence);
      if (old) {
        if (
          !file ||
          old.chunk_hash !== chunkHash ||
          old.source !== body.source ||
          anyFile?.state === 'discarded'
        )
          throw new LiekanError('同一证据分块的内容已改变', 409, 'history-repair-chunk-conflict');
        const result: HistoryRepairEvidenceResult = {
          uploadId: body.uploadId,
          sequence: body.sequence,
          hash: chunkHash,
          revision: row.revision,
          accepted: old.accepted,
          rejected: old.rows - old.accepted,
          errors: JSON.parse(old.errors),
          finalized: file.state === 'finalized',
          discarded: false,
        };
        return locked(site, body, identity, row, (tx, r) =>
          audit(
            tx,
            r,
            identity,
            'evidence-retry',
            { action: body.action, hash: payloadHash },
            result,
            body.actionId,
          ),
        );
      }
      if (!anyFile && files.length >= 100)
        throw new LiekanError(
          '最多保留100个待处理证据文件，请先撤下不使用的文件',
          413,
          'history-repair-upload-limit',
        );
      if (
        body.sequence !== (file?.chunks ?? 0) ||
        (anyFile && (!file || file.state !== 'open' || file.source !== body.source))
      )
        throw new LiekanError('证据序号或规则包发生冲突', 409, 'history-repair-manifest-conflict');
      const { saved, errors } = await resolve(row, body),
        now = new Date();
      const response: HistoryRepairEvidenceResult = {
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
      const result: RepairInputResult = {
        kind: 'history-repair-input',
        runId: row.id,
        generation: row.generation,
        actorId: identity.userId,
        revision: row.revision,
        inputRevision: row.input_revision,
        scopeRevision: String(row.scope_revision),
        authorityHash: row.snapshot.authorityHash,
        actionId: body.actionId,
        payloadHash,
        uploadId: body.uploadId,
        rulepack: row.snapshot.rulepack.hash,
        source: body.source,
        createdAt: now.toISOString(),
        response,
      };
      const fact = factInput('liekan_history_repair_input', {
        run_id: row.id,
        website_id: site,
        upload_id: body.uploadId,
        generation: row.generation,
        sequence: body.sequence,
        chunk_hash: chunkHash,
        rulepack_hash: row.snapshot.rulepack.hash,
        source: body.source,
        actor_id: identity.userId,
        rows: body.records.length,
        accepted: saved.length,
        errors,
        records: saved,
        state: 'open',
        manifest_hash: null,
        created_at: now,
      });
      const state = await runtime.resource(site, 'website');
      const task = await prepareWarehouseTask(
        runtime,
        state,
        result,
        [{ family: 'liekan_history_repair_input', row: fact }],
        async tx => {
          const sql = warehouseControlAdapter(tx),
            current = await requireRun(sql as any, site, identity);
          expected(current, body.expectedRevision, body.runId);
          mutable(current);
          if (!(await authorizeWarehouseTask(tx, site, result)))
            throw new LiekanError('修复输入已变化，请刷新', 409, 'history-repair-input-changed');
          if (current.status === 'rolled_back') await archiveGeneration(sql as any, current);
        },
      );
      await waitWarehouseTask(runtime.db, task);
      return response;
    }
    if (!anyFile) throw new LiekanError('证据文件不存在', 404, 'history-repair-upload-not-found');
    let manifest: string | null = null;
    if (body.action === 'finalize') {
      if (!file) throw new LiekanError('证据文件已撤下', 409, 'history-repair-evidence-incomplete');
      manifest = await verifyManifest(row, body, file);
    } else if (row.active_generation) {
      const refs = await warehouseRepairQuery(
        row,
        `SELECT 1 FROM ${factRelation('liekan_history_repair_result')}
        WHERE run_id={repairRun:UUID} AND generation={active:UUID} AND JSONExtractString(proof,'uploadId')={upload:String} LIMIT 1`,
        { active: row.active_generation, upload: body.uploadId },
      );
      if (refs.length)
        throw new LiekanError(
          '生效代次仍引用该证据，请先回退并保留审计',
          409,
          'history-repair-active-evidence',
        );
    }
    const result: HistoryRepairEvidenceResult = {
      uploadId: body.uploadId,
      revision: row.revision + 1,
      accepted: body.action === 'finalize' ? body.rows : 0,
      rejected: 0,
      errors: [],
      finalized: body.action === 'finalize',
      discarded: body.action === 'discard',
    };
    return locked(site, body, identity, row, async (tx, current) => {
      await tx.$executeRawUnsafe(
        'UPDATE liekan_warehouse_repair_upload SET state=$3,manifest_hash=$4,updated_at=clock_timestamp() WHERE run_id=$1::uuid AND upload_id=$2::uuid',
        row.id,
        body.uploadId,
        body.action === 'finalize' ? 'finalized' : 'discarded',
        manifest,
      );
      await tx.$executeRawUnsafe(
        "UPDATE liekan_history_repair_run SET revision=revision+1,input_revision=input_revision+1,status='paused',preview=NULL,confirmed_at=NULL,approved_digest=NULL,error_code='evidence-changed',updated_at=clock_timestamp() WHERE id=$1::uuid",
        row.id,
      );
      return audit(
        tx,
        current,
        identity,
        `evidence-${body.action}`,
        { action: body.action, hash: payloadHash },
        result,
        body.actionId,
        { uploadId: body.uploadId, engine: HISTORY_REPAIR_ENGINE },
      );
    });
  });
}
