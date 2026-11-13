import { closeWarehouseAuthority } from './authority-routing';
import { closeWarehouseReader } from './reader-runtime';
import { closeWarehouseRuntime } from './runtime';

/** Worker shutdown only, after accepting and draining work has stopped. */
export async function closeWarehouseProcessResources() {
  // Close every owned pool even if a different transport fails to disconnect.
  const results = await Promise.allSettled([
    closeWarehouseRuntime(),
    closeWarehouseReader(),
    closeWarehouseAuthority(),
  ]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
