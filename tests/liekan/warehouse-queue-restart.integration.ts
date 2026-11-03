import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

assert.equal(process.env.WAREHOUSE_DOCKER_TEST, 'isolated-new-project');
const directory = '.local/ch-deploy-validation';
const recovery = JSON.parse(await readFile(`${directory}/recovery.json`, 'utf8'));
assert.ok(recovery.steps.verify?.passed);
const name = 'liekan_ch_restore_validation_20261103_v2-warehouse-queue-1';
const run = promisify(execFile);
const docker = async (...args: string[]) => (await run('docker', args, { timeout: 70000 })).stdout;
const report: Record<string, unknown> = { passed: false, isolated: true };
try {
  const before = JSON.parse(await docker('inspect', name))[0];
  assert.equal(
    before.Config.Labels['com.docker.compose.project'],
    'liekan_ch_restore_validation_20261103_v2',
  );
  assert.equal(before.State.Health.Status, 'healthy');
  // These captured bind files deliberately retain their old 0444 mode. The new
  // entrypoint must give its internal runtime copies a restartable owner mode.
  assert.equal(
    (await docker('exec', name, 'stat', '-c', '%a', '/liekan/bootstrap.yaml')).trim(),
    '444',
  );
  assert.equal(
    (await docker('exec', name, 'stat', '-c', '%a', '/etc/redpanda/.bootstrap.yaml')).trim(),
    '600',
  );
  const started = performance.now();
  await docker('restart', '-t', '60', name);
  let after: any;
  for (let end = Date.now() + 60000; Date.now() < end; ) {
    after = JSON.parse(await docker('inspect', name))[0];
    if (after.State.Health?.Status === 'healthy') break;
    await delay(1000);
  }
  assert.equal(after.State.Health.Status, 'healthy');
  assert.equal(after.RestartCount, 0, 'No automatic crash/restart loop');
  const orderedMounts = (mounts: { Destination: string }[]) =>
    [...mounts].sort((a, b) => a.Destination.localeCompare(b.Destination));
  assert.deepEqual(
    orderedMounts(after.Mounts),
    orderedMounts(before.Mounts),
    'No volume replacement',
  );
  report.passed = true;
  report.recoveryMs = Math.round(performance.now() - started);
  report.runtimeConfigMode = '600';
  report.readOnlyBackupConfigMode = '444';
} catch (error) {
  report.error = error instanceof Error ? error.message : 'queue-restart-failed';
  process.exitCode = 1;
} finally {
  await writeFile(`${directory}/queue-restart-report.json`, JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
