import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
export const warehouseExportRoot = () =>
  // This directory contains runtime-generated exports, never bundled assets.
  resolve(
    /* turbopackIgnore: true */ process.env.LIEKAN_EXPORT_DIRECTORY ?? '.local/warehouse-exports',
  );
export async function cleanupWarehouseExports(now = Date.now()) {
  const root = warehouseExportRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const name of await readdir(root)) {
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name)) continue;
    const folder = join(/* turbopackIgnore: true */ root, name),
      s = await stat(folder).catch(() => null);
    if (s?.isDirectory() && s.mtimeMs < now - 86400000)
      await rm(folder, { recursive: true, force: true });
  }
}
