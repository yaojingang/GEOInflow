import 'dotenv/config';
import { assertWarehouseStartup } from '../lib/liekan/warehouse/startup';
import { setInternalProcessRole } from '../lib/liekan/upstream/process-role';
setInternalProcessRole('analytics-worker');
await assertWarehouseStartup();
await import('./analytics-main');
