import { WarehouseFactGC } from '../lib/liekan/warehouse/fact-gc';
import { WarehouseDeletionGC } from '../lib/liekan/warehouse/deletion-gc';
import { cleanupWarehouseExports } from '../lib/liekan/warehouse/export-files';
import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { rename, rm, writeFile } from 'node:fs/promises';
import { WarehouseRuntime, warehouseRuntimeConfig } from '../lib/liekan/warehouse/runtime';
import { WarehouseRecoveryGC } from '../lib/liekan/warehouse/recovery-gc';
const runtime = await WarehouseRuntime.connect(warehouseRuntimeConfig());
const collector = new WarehouseRecoveryGC(runtime.db, runtime.queue);
const garbage = new WarehouseFactGC(runtime.db, runtime.ch);
const deletedFacts = new WarehouseDeletionGC(runtime.db, runtime.ch);
let nextGarbage = 0;
const grace = Number(process.env.LIEKAN_WAREHOUSE_RECOVERY_GRACE_SECONDS ?? 600);
const healthFile =
  process.env.LIEKAN_MAINTENANCE_HEALTH_FILE ?? '/tmp/liekan-warehouse-maintenance.health.json';
let nextExportCleanup = 0;
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
try {
  while (!stop.signal.aborted) {
    let busy = false;
    try {
      const progress = await collector.collect(5000, grace);
      if (Date.now() >= nextExportCleanup) {
        await cleanupWarehouseExports();
        nextExportCleanup = Date.now() + 3600000;
      }
      if (Date.now() >= nextGarbage) {
        await garbage.collect();
        await deletedFacts.collect();
        nextGarbage = Date.now() + 60000;
      }
      busy = !!(progress.work || progress.attempts || progress.journal);
      const temporary = `${healthFile}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ healthy: true, at: new Date().toISOString(), ...progress }),
        { mode: 0o600 },
      );
      await rename(temporary, healthFile);
    } catch (error) {
      await rm(healthFile, { force: true });
      const message = error instanceof Error ? error.message : '';
      console.error(
        JSON.stringify({
          component: 'warehouse-maintenance',
          code: /^warehouse-[a-z-]+$/.test(message) ? message : 'warehouse-maintenance-unavailable',
        }),
      );
    }
    await delay(busy ? 10 : 30000, undefined, { signal: stop.signal }).catch(() => {});
  }
} finally {
  await rm(healthFile, { force: true });
  await runtime.close();
}
