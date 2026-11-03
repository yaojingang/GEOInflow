import 'dotenv/config';
import { assertWarehouseStartup } from '../src/lib/liekan/warehouse/startup';

try {
  await assertWarehouseStartup();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'warehouse-startup-check-unavailable');
  process.exitCode = 1;
}
