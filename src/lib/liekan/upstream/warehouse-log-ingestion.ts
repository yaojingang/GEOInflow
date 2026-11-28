import type { LogRecord } from '../ingest';
import type { AutomaticRecord } from '../log-ingestion/protocol';
import { submitV2LogUpload } from '../warehouse-v2/index';
import { LiekanError } from './errors';

type SQL = {
  $queryRawUnsafe<T = any[]>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

export type WarehouseUploadDispatch = {
  batchId: string;
  websiteId: string;
  sourceId?: string | null;
  epoch?: string | number;
  isRetry?: boolean;
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
  const [ls] = await tx.$queryRawUnsafe<{ epoch: string }[]>(
    `SELECT coalesce((SELECT epoch::text FROM liekan_log_state WHERE website_id=$1::uuid), '1') AS epoch`,
    input.websiteId,
  );
  const epoch = ls?.epoch ?? '1';
  const [inserted] = await tx.$queryRawUnsafe(
    `INSERT INTO liekan_warehouse_upload(batch_id,website_id,source_id,source_epoch,kind,digest,expected,actor_id,warehouse_epoch)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::uuid,$9::bigint) ON CONFLICT(batch_id) DO NOTHING
    RETURNING *,warehouse_epoch::text AS bound_epoch`,
    input.batchId,
    input.websiteId,
    input.sourceId,
    input.sourceEpoch,
    input.kind,
    input.digest,
    input.count,
    input.actorId ?? null,
    epoch,
  );
  const upload =
    inserted ??
    (
      await tx.$queryRawUnsafe(
        'SELECT *,warehouse_epoch::text AS bound_epoch FROM liekan_warehouse_upload WHERE batch_id=$1::uuid FOR SHARE',
        input.batchId,
      )
    )[0];
  if (
    upload.website_id !== input.websiteId ||
    upload.digest !== input.digest ||
    upload.expected !== input.count ||
    upload.source_epoch !== input.sourceEpoch ||
    upload.source_id !== input.sourceId ||
    upload.kind !== input.kind
  )
    throw new LiekanError('同一批次标识的内容已改变', 409);
  if (upload.bound_epoch !== epoch || upload.status === 'cancelled')
    throw new LiekanError('采集代次已更新，请重新提交', 409);
  return upload;
}

export async function sendWarehouseUpload(dispatch: WarehouseUploadDispatch) {
  try {
    await submitV2LogUpload(dispatch);
  } catch (error) {
    if (error instanceof LiekanError) throw error;
    throw new LiekanError('日志写入暂时不可用，使用原批次标识重试', 503);
  }
}
