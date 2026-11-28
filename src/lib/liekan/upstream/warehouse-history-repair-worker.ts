import type { RunRow } from './history-repair-db';
import { LiekanError } from './server';

export async function processWarehouseHistoryRepairUnit(
  _acquired: RunRow,
  _supplied?: unknown,
): Promise<never> {
  throw new LiekanError('历史修复在当前 ClickHouse v2 仓库模式下暂未启用', 501);
}
