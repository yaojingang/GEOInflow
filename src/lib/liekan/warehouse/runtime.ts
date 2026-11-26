export {
  warehouseEnabled,
  warehouseIntakeEnabled,
  warehouseTransitionEnabled,
} from './authority-routing';

export class WarehouseUnavailable extends Error {
  readonly status = 503;
  readonly code: string;
  constructor(code = 'warehouse-unavailable', message = '分析仓库暂不可用') {
    super(message);
    this.name = 'WarehouseUnavailable';
    this.code = code;
  }
}

export type WarehouseRuntime = never;

export async function closeWarehouseRuntime() {
  const { closeWarehouseV2Runtime } = await import('../warehouse-v2/runtime');
  await closeWarehouseV2Runtime();
}
