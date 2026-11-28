import 'dotenv/config';
import { closeWarehouseReader } from '../src/lib/liekan/warehouse/reader-runtime';
import { assertWarehouseStartup } from '../src/lib/liekan/warehouse/startup';
import {
  closeWarehouseV2Runtime,
  ensureV2Schema,
  warehouseV2Runtime,
} from '../src/lib/liekan/warehouse-v2/index';

try {
  await assertWarehouseStartup();
  if (
    process.argv.includes('--prepare-analytics') &&
    process.env.LIEKAN_ANALYTICS_BACKEND === 'clickhouse'
  ) {
    await ensureV2Schema(warehouseV2Runtime().ch);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'warehouse-startup-check-unavailable');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([closeWarehouseReader(), closeWarehouseV2Runtime()]);
}
