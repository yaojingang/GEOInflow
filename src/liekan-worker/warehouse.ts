import {
  captureAuthoritativeResult,
  decisionResult,
} from '../lib/liekan/warehouse/transition-capture';
import { recoverWarehouseTasks, taskPlanner } from '../lib/liekan/warehouse/tasks';
import { recoverWarehouseDeletions } from '../lib/liekan/upstream/warehouse-lifecycle';
import 'dotenv/config';
import { rename, rm, writeFile } from 'node:fs/promises';
import {
  authorizeWarehouseRecorder,
  authorizeWarehouseTask,
  authorizeWarehouseUploads,
  confirmWarehouseAuthority,
} from '../lib/liekan/upstream/warehouse-authority';
import { browserPlanner } from '../lib/liekan/warehouse/browser-planner';
import { WarehouseConsumer } from '../lib/liekan/warehouse/consumer';
import { WarehouseConsumerSupervisor } from '../lib/liekan/warehouse/consumer-supervisor';
import { WarehouseControl } from '../lib/liekan/warehouse/control';
import { logPlanner } from '../lib/liekan/warehouse/log-planner';
import { collectionPlanner } from '../lib/liekan/warehouse/planner';
import { recorderPlanner } from '../lib/liekan/warehouse/recorder-planner';
import { PostgresAuthority } from '../lib/liekan/warehouse/postgres-authority';
import {
  postgresLogLookup,
  postgresRecorderLookup,
} from '../lib/liekan/warehouse/postgres-lookups';
import { warehouseRuntime } from '../lib/liekan/warehouse/runtime';
import { verifyBoundWarehouse } from '../lib/liekan/warehouse/installation-identity';

const runtime = await warehouseRuntime();
function createWorker(authority: 'postgres' | 'clickhouse') {
  const control = new WarehouseControl(runtime.db, authority);
  const planner = collectionPlanner(
    browserPlanner(runtime.db),
    logPlanner(
      runtime.db,
      runtime.ch,
      authorizeWarehouseUploads(runtime.db),
      authority === 'postgres' ? postgresLogLookup(runtime.db) : undefined,
    ),
    recorderPlanner(
      runtime.ch,
      authorizeWarehouseRecorder(runtime.db),
      authority === 'postgres' ? postgresRecorderLookup(runtime.db) : undefined,
    ),
    taskPlanner(runtime.db, authorizeWarehouseTask),
  );
  return new WarehouseConsumer(control, runtime.ch, runtime.queue, planner, {
    groupId: `liekan-${runtime.queue.installation.topicId}`,
    concurrency: Number(process.env.LIEKAN_WAREHOUSE_CONCURRENCY ?? 2),
    confirmAuthority: confirmWarehouseAuthority,
    ...(authority === 'postgres'
      ? { authorityProcessor: new PostgresAuthority(control, planner, confirmWarehouseAuthority) }
      : {}),
    acceptResult: async (tx, attempt, decisions) => {
      await captureAuthoritativeResult(tx, decisionResult('clickhouse', attempt, decisions));
    },
    onHealth: health =>
      console.error(JSON.stringify({ component: 'warehouse-consumer', ...health })),
  });
}
const supervisor = new WarehouseConsumerSupervisor(
  async () =>
    (
      await runtime.db.read<{ authority: string; revision: string }>(
        'SELECT authority,revision FROM liekan_warehouse_installation WHERE id=1',
      )
    )[0],
  createWorker,
  () => verifyBoundWarehouse(runtime.db, runtime.ch),
);
const healthFile =
  process.env.LIEKAN_WAREHOUSE_HEALTH_FILE ?? '/tmp/liekan-warehouse-worker.health.json';
let closing = false,
  checking: Promise<void> | undefined;
async function health() {
  try {
    // Keep the consumer stopped until the claim guard migration is available.
    await runtime.db.read('SELECT 1 FROM liekan_warehouse_claim_guard LIMIT 1');
    await runtime.queue.assertIdentity();
    await supervisor.refresh();
    const mode = supervisor.authority;
    if (mode === 'clickhouse') {
      await recoverWarehouseTasks(runtime);
    }
    if (mode === 'clickhouse' || mode === 'postgres') await recoverWarehouseDeletions(runtime);
    if (mode === 'clickhouse') {
      const ping = await runtime.ch.ping();
      if (!ping.success) throw new Error('warehouse-unavailable');
    }
    if (!supervisor.isOperational()) throw new Error('warehouse-consumer-unavailable');
    const path = `${healthFile}.${process.pid}.tmp`;
    await writeFile(
      path,
      JSON.stringify({ healthy: true, at: new Date().toISOString(), pid: process.pid }),
      { mode: 0o600 },
    );
    await rename(path, healthFile);
  } catch {
    await rm(healthFile, { force: true });
  }
}
await health();
const timer = setInterval(() => {
  if (closing || checking) return;
  checking = health().finally(() => {
    checking = undefined;
  });
}, 10000);
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await checking;
  await supervisor.close();
  await rm(healthFile, { force: true });
  await runtime.close();
}
process.on(
  'SIGTERM',
  () =>
    void close().catch(() => {
      process.exitCode = 1;
    }),
);
process.on(
  'SIGINT',
  () =>
    void close().catch(() => {
      process.exitCode = 1;
    }),
);
