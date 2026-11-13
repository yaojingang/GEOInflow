import 'dotenv/config';
import { initializeWarehouseAnalytics } from '../src/lib/liekan/warehouse/initialize';
import { closeWarehouseReader, warehouseReader } from '../src/lib/liekan/warehouse/reader-runtime';
import { assertWarehouseStartup } from '../src/lib/liekan/warehouse/startup';

try {
  await assertWarehouseStartup();
  if (
    process.argv.includes('--prepare-analytics') &&
    process.env.LIEKAN_ANALYTICS_BACKEND === 'clickhouse'
  ) {
    const reader = warehouseReader();
    await reader.verifyIdentity();
    await initializeWarehouseAnalytics(reader.ch);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'warehouse-startup-check-unavailable');
  process.exitCode = 1;
} finally {
  await closeWarehouseReader();
}
