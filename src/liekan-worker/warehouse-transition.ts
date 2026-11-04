import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { rename, rm, writeFile } from 'node:fs/promises';
import { WarehouseRuntime, warehouseRuntimeConfig } from '../lib/liekan/warehouse/runtime';
import { TransitionService } from '../lib/liekan/warehouse/transition-service';
const config = warehouseRuntimeConfig();
const runtime = await WarehouseRuntime.connect(config);
const service = new TransitionService(runtime.db, runtime.ch, config.queue);
const healthFile =
  process.env.LIEKAN_TRANSITION_HEALTH_FILE ?? '/tmp/liekan-transition-worker.health.json';
let stopped = false;
process.once('SIGTERM', () => {
  stopped = true;
});
process.once('SIGINT', () => {
  stopped = true;
});
try {
  while (!stopped) {
    let busy = false;
    try {
      const progress = await service.tick();
      busy = !!(progress.sent || progress.clickhouse || progress.postgres);
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
          component: 'warehouse-transition',
          code: /^warehouse-[a-z-]+$/.test(message) ? message : 'warehouse-transition-unavailable',
        }),
      );
    }
    await delay(busy ? 10 : 1000);
  }
} finally {
  await rm(healthFile, { force: true });
  await service.close();
  await runtime.close();
}
