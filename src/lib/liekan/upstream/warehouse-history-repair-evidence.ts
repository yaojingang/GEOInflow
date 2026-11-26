import { LiekanError, type WriteIdentity } from './server';

export async function ingestWarehouseRepairEvidence(
  _site: string,
  _input: unknown,
  _identity: WriteIdentity,
): Promise<never> {
  throw new LiekanError('历史修复证据导入在当前 ClickHouse v2 仓库模式下暂未启用', 501);
}
