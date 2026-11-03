import type { LogRecord } from '../ingest';
import type { AutomaticRecord } from '../log-ingestion/protocol';
import { logEnvelope } from '../warehouse/log-package';
import { warehouseRuntime } from '../warehouse/runtime';
import { LiekanError } from './errors';

type SQL = {
  $queryRawUnsafe<T = any[]>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};
export type WarehouseUploadDispatch = {
  batchId: string;
  websiteId: string;
  records: (LogRecord | AutomaticRecord)[];
};
export async function prepareWarehouseUpload(
  tx: SQL,
  input: {
    batchId: string;
    websiteId: string;
    sourceId: string | null;
    sourceEpoch: number;
    kind: 'automatic' | 'manual';
    digest: string;
    count: number;
    actorId?: string | null;
  },
) {
  const [installation] = await tx.$queryRawUnsafe<{ authority: string }[]>(
    'SELECT authority FROM liekan_warehouse_installation WHERE id=1 FOR SHARE',
  );
  if (installation?.authority !== 'clickhouse')
    throw new LiekanError('分析存储正在切换，请稍后重试', 503);
  // The caller already holds the authorized website/source lock. Only bounded
  // metadata is registered here; queue I/O is performed after this transaction.
  await tx.$executeRawUnsafe(
    `INSERT INTO liekan_warehouse_site(website_id,policy_revision)
    VALUES($1::uuid,coalesce((SELECT revision FROM liekan_collection_policy WHERE website_id=$1::uuid),0)) ON CONFLICT DO NOTHING`,
    input.websiteId,
  );
  const [site] = await tx.$queryRawUnsafe<{ epoch: string; state: string }[]>(
    'SELECT epoch::text,state FROM liekan_warehouse_site WHERE website_id=$1::uuid',
    input.websiteId,
  );
  if (site?.state !== 'active') throw new LiekanError('网站数据正在维护，请稍后重试', 503);
  await tx.$executeRawUnsafe(
    `INSERT INTO liekan_warehouse_upload(batch_id,website_id,source_id,source_epoch,kind,digest,expected,actor_id,warehouse_epoch)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::uuid,$9::bigint) ON CONFLICT(batch_id) DO NOTHING`,
    input.batchId,
    input.websiteId,
    input.sourceId,
    input.sourceEpoch,
    input.kind,
    input.digest,
    input.count,
    input.actorId ?? null,
    site.epoch,
  );
  const [upload] = await tx.$queryRawUnsafe<any[]>(
    'SELECT *,warehouse_epoch::text AS bound_epoch FROM liekan_warehouse_upload WHERE batch_id=$1::uuid FOR SHARE',
    input.batchId,
  );
  if (
    upload.website_id !== input.websiteId ||
    upload.digest !== input.digest ||
    upload.expected !== input.count ||
    upload.source_epoch !== input.sourceEpoch ||
    upload.source_id !== input.sourceId ||
    upload.kind !== input.kind
  )
    throw new LiekanError('同一批次标识的内容已改变', 409);
  if (upload.bound_epoch !== site.epoch || upload.status === 'cancelled')
    throw new LiekanError('采集代次已更新，请重新提交', 409);
  return upload;
}

export async function sendWarehouseUpload(dispatch: WarehouseUploadDispatch) {
  try {
    const runtime = await warehouseRuntime();
    const [upload] = await runtime.db.read<{
      source_id: string | null;
      source_epoch: number;
      kind: 'automatic' | 'manual';
      warehouse_epoch: string;
      created_at: Date;
      queued: boolean;
    }>('SELECT * FROM liekan_warehouse_upload WHERE batch_id=$1::uuid AND website_id=$2::uuid', [
      dispatch.batchId,
      dispatch.websiteId,
    ]);
    if (!upload) throw new LiekanError('日志批次状态不存在', 409);
    if (upload.queued) return;
    const site = await runtime.resource(dispatch.websiteId, 'website');
    if (site.epoch !== upload.warehouse_epoch)
      throw new LiekanError('采集代次已更新，请重新提交', 409);
    for (let start = 0; start < dispatch.records.length; start += 1000) {
      const inputs = dispatch.records.slice(start, start + 1000).map((record, index) =>
        logEnvelope(site, runtime.queue.installation, record, {
          batchId: dispatch.batchId,
          sourceId: upload.source_id,
          sourceEpoch: upload.source_epoch,
          kind: upload.kind,
          receivedAt: upload.created_at,
          recordIndex: start + index,
        }),
      );
      await runtime.queue.enqueueMany(inputs);
    }
    await runtime.db.transaction(async tx => {
      await tx.query(
        `UPDATE liekan_warehouse_upload SET queued=true,
        status=CASE WHEN expected=0 THEN 'processed' ELSE status END,updated_at=clock_timestamp() WHERE batch_id=$1::uuid AND warehouse_epoch=$2::bigint`,
        [dispatch.batchId, site.epoch],
      );
      if (!dispatch.records.length)
        await tx.query(
          "UPDATE liekan_ingest_batch SET state='processed',processed_at=clock_timestamp() WHERE id=$1::uuid",
          [dispatch.batchId],
        );
    });
  } catch (error) {
    if (error instanceof LiekanError) throw error;
    throw new LiekanError('日志队列暂时不可用，使用原批次标识重试', 503);
  }
}
