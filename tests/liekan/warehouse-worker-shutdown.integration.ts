// Exercise the compiled log worker against only the independently restored
// synthetic installation. A read-only bundle mount avoids rebuilding the app
// before a worker regression has actually passed.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

assert.equal(process.env.WAREHOUSE_DOCKER_TEST, 'isolated-new-project');
const run = promisify(execFile);
const directory = resolve('.local/ch-deploy-validation');
const recovery = JSON.parse(await readFile(`${directory}/recovery.json`, 'utf8'));
assert.ok(recovery.steps.verify?.passed);
const project = 'liekan_ch_restore_validation_20261103_v2';
const name = 'liekan_ch_worker_shutdown_validation_20261103_v3';
const compose = [
  'compose', '--project-name', project,
  '-f', `${directory}/backup/restore-${project}.compose.json`,
  '-f', `${directory}/restore-ports.json`,
];
const docker = async (...args: string[]) => (await run('docker', args, { timeout: 70000 })).stdout;
const report: Record<string, unknown> = { project, isolated: true, passed: false };
try {
  // The captured old image was proved to hang at shutdown. Only this restored
  // synthetic worker is replaced; original data volumes are never selected.
  await docker(...compose, 'stop', '-t', '5', 'log-worker');
  await docker(...compose, 'run', '-d', '--no-deps', '--name', name,
    '-v', `${resolve('dist/liekan-worker.mjs')}:/app/dist/liekan-worker.mjs:ro`, 'log-worker');
  const end = Date.now() + 45000;
  let healthy = false;
  while (Date.now() < end) {
    const info = JSON.parse(await docker('inspect', name))[0];
    assert.ok(info.State.Running, 'Patched log worker stays running');
    if (info.State.Health?.Status === 'healthy') { healthy = true; break; }
    await delay(1000);
  }
  assert.ok(healthy, 'Patched worker health');
  // Include a second maintenance pass and browser-risk delivery, which opens
  // the persistent producer even when no risk candidates are present.
  await delay(10000);
  const logs = await run('docker', ['logs', name], { timeout: 10000 });
  assert.ok(!`${logs.stdout}\n${logs.stderr}`.includes('Liekan worker maintenance unavailable'));
  const stoppedAt = performance.now();
  await docker('stop', '-t', '60', name);
  const stopped = JSON.parse(await docker('inspect', name))[0];
  assert.equal(stopped.State.ExitCode, 0, 'Graceful shutdown without SIGKILL');
  assert.equal(stopped.State.OOMKilled, false);
  report.passed = true;
  report.stopMs = Math.round(performance.now() - stoppedAt);
  report.exitCode = stopped.State.ExitCode;
  report.maintenanceFenceErrors = 0;
  report.bundleMount = 'compiled worker only, read-only';
  await docker('start', name);
} catch (error) {
  report.error = error instanceof Error ? error.message : 'worker-shutdown-failed';
  process.exitCode = 1;
} finally {
  await writeFile(`${directory}/worker-shutdown.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}
