import { AsyncLocalStorage } from 'node:async_hooks';
import { ControlDatabase, WarehouseConflict } from './control-db';

type Authority = {
  authority: 'postgres' | 'clickhouse' | 'frozen';
  revision: string;
  installation_id: string;
};
const key = Symbol.for('liekan.warehouse-authority-routing.v1');
const globalState = globalThis as typeof globalThis & {
  [key]?: { context: AsyncLocalStorage<Authority>; db?: ControlDatabase };
};
const state = (globalState[key] ??= { context: new AsyncLocalStorage<Authority>() });
export const warehouseTransitionEnabled = () => process.env.LIEKAN_WAREHOUSE_TRANSITION === 'true';
export function warehouseEnabled() {
  return (
    (state.context.getStore()?.authority ?? process.env.LIEKAN_ANALYTICS_BACKEND) === 'clickhouse'
  );
}
export function warehouseIntakeEnabled() {
  return warehouseTransitionEnabled() || process.env.LIEKAN_ANALYTICS_BACKEND === 'clickhouse';
}
function database() {
  if (!state.db) {
    if (!process.env.DATABASE_URL) throw new Error('warehouse-database-unavailable');
    state.db = new ControlDatabase(process.env.DATABASE_URL);
  }
  return state.db;
}

export async function closeWarehouseAuthority() {
  const db = state.db;
  delete state.db;
  await db?.close();
}
export async function withinWarehouseAuthority<T>(
  work: () => Promise<T>,
  injected?: ControlDatabase,
  independent = false,
): Promise<T> {
  if (!warehouseTransitionEnabled() || (!independent && state.context.getStore())) return work();
  const db = injected ?? database();
  const read = async () => {
    const [row] = await db.read<Authority>(
      'SELECT authority,revision,installation_id FROM liekan_warehouse_installation WHERE id=1',
    );
    if (!row || row.authority === 'frozen')
      throw new WarehouseConflict('warehouse-authority-frozen');
    return row;
  };
  const before = await read();
  return state.context.run(before, async () => {
    const value = await work(),
      after = await read();
    if (
      before.authority !== after.authority ||
      before.revision !== after.revision ||
      before.installation_id !== after.installation_id
    )
      throw new WarehouseConflict('warehouse-authority-changed');
    return value;
  });
}
