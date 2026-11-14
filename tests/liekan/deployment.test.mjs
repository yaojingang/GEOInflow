import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

test('default Docker metadata covers the immutable release register and UI baseline', async () => {
  const dockerfile = await readFile('Dockerfile.liekan', 'utf8');
  const register = JSON.parse(await readFile('config/liekan/migrations.json', 'utf8'));
  const release = JSON.parse(await readFile('config/liekan/upstream.json', 'utf8'));
  const revision = Number(dockerfile.match(/^ARG LIEKAN_MIGRATION=(\d+)$/m)?.[1]);
  assert.equal(revision, Object.keys(register).length);
  assert.equal(revision, release.liekanMigration);
  assert.match(dockerfile, /io\.liekan\.migration=\$LIEKAN_MIGRATION/);
  const defaults = Object.fromEntries(
    [...dockerfile.matchAll(/^ARG (LIEKAN_\w+)=(\S+)$/gm)].map(match => [match[1], match[2]]),
  );
  for (const [arg, key] of [
    ['LIEKAN_UPSTREAM', 'commit'],
    ['LIEKAN_UI', 'uiManifestSha256'],
    ['LIEKAN_FEATURE_UI', 'featureUiManifestSha256'],
    ['LIEKAN_AI_UI', 'aiUiManifestSha256'],
  ])
    assert.equal(defaults[arg], release[key], arg);
});

test('Docker compilation isolates the webpack worker and retains type checking and all prerequisite builds', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(pkg.scripts['build:app:docker'], 'next build --webpack');
  assert.equal(pkg.scripts['build:app'], 'next build --turbo');
  assert.ok(pkg.scripts['test:deployment'].includes('tests/liekan/build-css-compat.test.mjs'));
  assert.equal(
    pkg.scripts['build:docker'],
    pkg.scripts.build
      .replace('check:env ', '')
      .replace('check:db ', '')
      .replace(/build:app$/, 'build:app:docker'),
  );
  const config = await readFile('next.config.ts', 'utf8');
  assert.match(config, /ignoreBuildErrors: false/);
  assert.match(config, /webpackBuildWorker: true/);
  assert.match(config, /webpackMemoryOptimizations: true/);
  const dockerfile = await readFile('Dockerfile.liekan', 'utf8');
  assert.match(dockerfile, /\. \.\/config\/liekan\/build-resources.sh/);
  assert.match(dockerfile, /RAYON_NUM_THREADS=1 NODE_OPTIONS="--max-old-space-size=\$liekan_build_node_heap_mib/);
});

async function installation(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liekan-install-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'bin'));
  await mkdir(path.join(root, 'config/liekan'), { recursive: true });
  await copyFile('config/liekan/buildkit.toml', path.join(root, 'config/liekan/buildkit.toml'));
  await copyFile('config/liekan/build-resources.sh', path.join(root, 'config/liekan/build-resources.sh'));
  await copyFile('scripts/liekan-deploy.sh', path.join(root, 'scripts/liekan-deploy.sh'));
  await copyFile('tests/liekan/fixtures/deployment-docker.sh', path.join(root, 'bin/docker'));
  await chmod(path.join(root, 'bin/docker'), 0o755);
  const calls = path.join(root, 'calls');
  const invoke = (method, args) =>
    method('sh', [path.join(root, 'scripts/liekan-deploy.sh'), ...(args || [])], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: {
        ...process.env,
        COMPOSE_PROJECT_NAME: 'liekan',
        PATH: `${root}/bin:${process.env.PATH}`,
        DEPLOY_TEST_CALLS: calls,
        ...options,
      },
    });
  return { root, calls, run: args => invoke(spawnSync, args), start: () => invoke(spawn) };
}

test('one command creates private random configuration and waits for service health', async t => {
  const { root, calls, run } = await installation(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const config = await readFile(path.join(root, '.env'), 'utf8');
  for (const key of ['POSTGRES_PASSWORD', 'APP_SECRET', 'TWO_FACTOR_ENCRYPTION_KEY']) {
    const secret = config.match(new RegExp(`^${key}=([a-f0-9]{64})$`, 'm'))?.[1];
    assert.ok(secret, `${key} should be a random 32-byte secret`);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
  assert.equal((await stat(path.join(root, '.env'))).mode & 0o777, 0o600);
  assert.match(
    await readFile(calls, 'utf8'),
    /up -d --no-build (?:--no-deps )?--wait --wait-timeout 300/,
  );
});

test('rerunning preserves existing configuration and credentials byte for byte', async t => {
  const { root, run } = await installation(t);
  assert.equal(run().status, 0);
  const original = await readFile(path.join(root, '.env'));
  assert.equal(run().status, 0);
  assert.deepEqual(await readFile(path.join(root, '.env')), original);
});

test('optional ClickHouse installation persists private credentials and survives a default rerun', async t => {
  const {root,calls,run}=await installation(t);
  const first=run(['--with-clickhouse']);
  assert.equal(first.status,0,first.stderr);
  const configuration=await readFile(path.join(root,'.env'),'utf8');
  const password=configuration.match(/^LIEKAN_CLICKHOUSE_PASSWORD=([a-f0-9]{64})$/m)?.[1];
  assert.ok(password);
  assert.ok(!first.stdout.includes(password));
  assert.ok(configuration.includes(`LIEKAN_ANALYTICS_CLICKHOUSE_URL=http://geoinflow_analytics:${password}@analytics-clickhouse:8123/geoinflow_analytics`));
  assert.equal(run().status,0);
  assert.equal(await readFile(path.join(root,'.env'),'utf8'),configuration);
  assert.match(await readFile(`${calls}.raw`,'utf8'),/docker-compose\.liekan-clickhouse\.yml up -d --no-deps --wait --wait-timeout 300 analytics-clickhouse/);
});

test('optional ClickHouse refuses replacing a missing password for an existing data volume',async t=>{
  const {root,run}=await installation(t,{DEPLOY_TEST_VOLUME_EXISTS:'0',DEPLOY_TEST_VOLUME_NAME:'liekan_liekan-clickhouse-data'});
  const result=run(['--with-clickhouse']);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/恢复原连接配置和密码/);
  assert.doesNotMatch(await readFile(path.join(root,'.env'),'utf8'),/^LIEKAN_CLICKHOUSE_PASSWORD=/m);
});

test('optional ClickHouse protects its existing volume when PostgreSQL uses a custom volume name', async t => {
  const { root, run } = await installation(t, {
    DEPLOY_TEST_VOLUME_EXISTS: '0',
    DEPLOY_TEST_VOLUME_NAME: 'liekan_liekan-clickhouse-data',
    DEPLOY_TEST_DATABASE_VOLUME_NAME: 'custom_postgresql_data',
  });
  const result = run(['--with-clickhouse']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /恢复原连接配置和密码/);
  assert.doesNotMatch(await readFile(path.join(root, '.env'), 'utf8'), /^LIEKAN_CLICKHOUSE_PASSWORD=/m);
});

test('the optional database stays on the internal network with its own bounded volume',async()=>{
  const source=await readFile('docker-compose.liekan-clickhouse.yml','utf8');
  assert.match(source,/image: clickhouse\/clickhouse-server:26\.8\.34\.13/);
  assert.match(source,/liekan-clickhouse-data:\/var\/lib\/clickhouse/);
  assert.match(source,/mem_limit: 4g/);
  assert.doesNotMatch(source,/ports:|network_mode: host/);
});

test('bundled ClickHouse installation preserves an existing external analytics connection',async t=>{
  const {root,run}=await installation(t);assert.equal(run().status,0);
  const file=path.join(root,'.env');const original=await readFile(file,'utf8')+'\nLIEKAN_ANALYTICS_CLICKHOUSE_URL=https://analytics.example.invalid/analytics\n';
  await writeFile(file,original);
  const result=run(['--with-clickhouse']);assert.notEqual(result.status,0);assert.match(result.stderr,/当前已配置外部 ClickHouse/);
  assert.equal(await readFile(file,'utf8'),original);
});

test('bundled ClickHouse installation preserves an existing password when the URL is missing',async t=>{
  const {root,run}=await installation(t);assert.equal(run().status,0);
  const file=path.join(root,'.env');const original=await readFile(file,'utf8')+'\nLIEKAN_CLICKHOUSE_PASSWORD='+ 'a'.repeat(64)+'\n';
  await writeFile(file,original);
  const result=run(['--with-clickhouse']);assert.notEqual(result.status,0);assert.match(result.stderr,/恢复完整的 ClickHouse 连接配置/);
  assert.equal(await readFile(file,'utf8'),original);
});

test('an existing database without its configuration is refused before a build', async t => {
  const { root, calls, run } = await installation(t, { DEPLOY_TEST_VOLUME_EXISTS: '0' });
  assert.equal(run().status, 1);
  await assert.rejects(access(path.join(root, '.env')));
  assert.doesNotMatch(await readFile(calls, 'utf8'), /build app/);
});

test('build failure stops before starting services and preserves the generated configuration', async t => {
  const { root, calls, run } = await installation(t, { DEPLOY_TEST_BUILD_STATUS: '1' });
  assert.equal(run().status, 1);
  await access(path.join(root, '.env'));
  assert.doesNotMatch(await readFile(calls, 'utf8'), /up -d/);
});

test('custom Compose project names also preserve the original database configuration', async t => {
  const { root, run } = await installation(t, {
    DEPLOY_TEST_VOLUME_EXISTS: '0',
    COMPOSE_PROJECT_NAME: 'production',
  });
  assert.equal(run().status, 1);
  await assert.rejects(access(path.join(root, '.env')));
});

test('help has no configuration or Docker side effects', async t => {
  const { root, calls, run } = await installation(t);
  assert.equal(run(['--help']).status, 0);
  await assert.rejects(access(calls));
  await assert.rejects(access(path.join(root, '.env')));
});

test('insufficient Docker memory stops before configuration, build or service changes', async t => {
  const { root, calls, run } = await installation(t, { DEPLOY_TEST_MEMORY_BYTES: '4294967296' });
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /6 GiB/);
  await assert.rejects(access(path.join(root, '.env')));
  assert.doesNotMatch(await readFile(calls, 'utf8'), /build app| up | stop /);
});

test('resource check accepts the build floor without creating configuration or building', async t => {
  const { root, calls, run } = await installation(t, { DEPLOY_TEST_MEMORY_BYTES: '6442450944' });
  const result = run(['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /6 GiB/);
  await assert.rejects(access(path.join(root, '.env')));
  await assert.rejects(access(path.join(root, '.local')));
  assert.match(await readFile(calls, 'utf8'), /info --format/);
  assert.doesNotMatch(await readFile(calls, 'utf8'), /build app| up | stop /);
});

for (const memory of ['', 'unknown', '0', '-1', '8589934592extra']) {
  test(`unknown Docker memory (${JSON.stringify(memory)}) stops before deployment`, async t => {
    const { root, calls, run } = await installation(t, { DEPLOY_TEST_MEMORY_BYTES: memory });
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Docker/);
    await assert.rejects(access(path.join(root, '.env')));
    assert.doesNotMatch(await readFile(calls, 'utf8'), /build app| up | stop log-worker|^start /m);
  });
}

test('low-memory upgrade preserves existing credentials and keeps existing services running', async t => {
  const { root, calls, run } = await existingInstallation(t, {
    DEPLOY_TEST_MEMORY_BYTES: '2147483648',
  });
  const config = await readFile(path.join(root, '.env'));
  assert.equal(run().status, 1);
  assert.deepEqual(await readFile(path.join(root, '.env')), config);
  assert.doesNotMatch(await readFile(calls, 'utf8'), /build app| up | stop /);
});

for (const available of ['2097152', '3145728', '5242880', '6291455', '', 'unknown', '-1', '9999999999999999']) {
  test(`unavailable build headroom (${JSON.stringify(available)}) preserves the running installation`, async t => {
    const { root, calls, run } = await existingInstallation(t, {
      DEPLOY_TEST_AVAILABLE_KIB: available,
    });
    const original = await readFile(path.join(root, '.env'));
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /可用内存/);
    assert.deepEqual(await readFile(path.join(root, '.env')), original);
    assert.doesNotMatch(await readFile(calls, 'utf8'), /build app| up | stop |buildx create/);
  });
}

test('available-memory floor accepts exactly 6 GiB in check mode', async t => {
  const { root, calls, run } = await installation(t, { DEPLOY_TEST_AVAILABLE_KIB: '6291456' });
  const result = run(['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /至少 6144 MiB/);
  await assert.rejects(access(path.join(root, '.env')));
  await assert.rejects(access(path.join(root, '.local')));
  assert.match(await readFile(calls, 'utf8'), /^run .*--memory 32m .*--cpus 0.1 .*--network none/m);
  assert.doesNotMatch(await readFile(calls, 'utf8'), /build app| up | stop |buildx create/);
});

test('memory is checked again immediately before building', async t => {
  const { calls, run } = await installation(t, { DEPLOY_TEST_LATER_AVAILABLE_KIB: '3145728' });
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /可用内存/);
  const commands = await readFile(calls, 'utf8');
  assert.equal(commands.split('\n').filter(line => line.startsWith('run ')).length, 2);
  assert.doesNotMatch(commands, /build app| up | stop |buildx create/);
});

for (const options of [
  { DEPLOY_TEST_BUILDX_STATUS: '1' },
  { DEPLOY_TEST_BUILD_HELP: 'no supported builder option' },
  { DEPLOY_TEST_RESOURCE_SUPPORT: 'true false true true' },
  { DEPLOY_TEST_CPUS: 'unknown' },
  { DEPLOY_TEST_PROBE_STATUS: '1' },
  { DEPLOY_TEST_BUILDER_CREATE_STATUS: '1' },
  { DEPLOY_TEST_BUILDER_LIMITS: '0|0|0|0' },
]) {
  test(`build isolation failure (${Object.keys(options)[0]}) never falls back to an unbounded build`, async t => {
    const { calls, run } = await installation(t, options);
    assert.notEqual(run().status, 0);
    assert.doesNotMatch(await readFile(calls, 'utf8'), /build app| up |compose [^\n]* stop /);
  });
}

for (const cpus of ['1', '2', '8']) {
  test(`bounded builder on a ${cpus}-CPU daemon is stopped after building and reused`, async t => {
    const { calls, run } = await installation(t, { DEPLOY_TEST_CPUS: cpus });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(run().status, 0);
    const commands = await readFile(`${calls}.raw`, 'utf8');
    const creates = commands.split('\n').filter(line => line.startsWith('buildx create '));
    assert.equal(creates.length, 1);
    assert.match(creates[0], /--driver docker-container/);
    assert.match(creates[0], /--driver-opt memory=5120m --driver-opt memory-swap=5120m/);
    assert.match(creates[0], new RegExp(`cpu-quota=${cpus === '1' ? '50000' : '100000'}`));
    assert.doesNotMatch(creates[0], /--use/);
    assert.match(
      commands,
      /build --builder geoinflow-build-v1-\d+ --build-arg LIEKAN_REVISION=unknown app/,
    );
    assert.equal(commands.split('\n').filter(line => line.startsWith('buildx stop ')).length, 2);
    const trace = await readFile(calls, 'utf8');
    assert.ok(trace.indexOf('buildx stop ') < trace.indexOf(safeAppUp));
  });
}

test('build failure stops the isolated builder and preserves the original services', async t => {
  const { calls, run } = await existingInstallation(t, { DEPLOY_TEST_BUILD_STATUS: '137' });
  const result = run();
  assert.notEqual(result.status, 0);
  const commands = await readFile(calls, 'utf8');
  assert.match(commands, /build app/);
  assert.match(commands, /buildx stop /);
  assert.doesNotMatch(commands, / up | stop log-worker|^start /m);
});

test('inherited legacy build mode cannot bypass the bounded builder', async t => {
  const { calls, run } = await installation(t, { DOCKER_BUILDKIT: '0' });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(`${calls}.buildkit`, 'utf8'), '1');
});

test('TERM during a blocked build promptly stops the builder without touching services', async t => {
  const { calls, start } = await installation(t, {
    DEPLOY_TEST_BLOCK_BUILD: '1',
    DEPLOY_TEST_BUILD_DELAY: '4',
  });
  const child = start();
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  let building = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    building = await access(`${calls}.building`).then(() => true, () => false);
    if (building) break;
    await delay(20);
  }
  assert.ok(building, 'the build must start before it is interrupted');
  const interrupted = Date.now();
  child.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.ok(Date.now() - interrupted < 2000, 'cleanup must not wait for the blocked build');
  const commands = await readFile(calls, 'utf8');
  assert.match(commands, /buildx stop /);
  assert.doesNotMatch(commands, / up | stop log-worker|^start /m);
  assert.match(commands, /^rm f{64}$/m);
});

test('a daemon-wide lease excludes another checkout until the first builder stops', async t => {
  const first = await installation(t, { DEPLOY_TEST_BLOCK_BUILD: '1' });
  const lease = path.join(first.root, 'daemon-lease');
  const second = await installation(t, { DEPLOY_TEST_LEASE_PATH: lease });
  // Each client has its own installation lock and shares only the Docker lease.
  const child = spawn('sh', ['scripts/liekan-deploy.sh'], {
    cwd: first.root,
    env: {
      ...process.env,
      PATH: `${first.root}/bin:${process.env.PATH}`,
      DEPLOY_TEST_CALLS: first.calls,
      DEPLOY_TEST_LEASE_PATH: lease,
      DEPLOY_TEST_BLOCK_BUILD: '1',
    },
    stdio: 'ignore',
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  let building = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    building = await access(`${first.calls}.building`).then(() => true, () => false);
    if (building) break;
    await delay(20);
  }
  assert.ok(building);
  const refused = second.run();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /构建租约/);
  assert.doesNotMatch(await readFile(second.calls, 'utf8'), /build app|buildx create/);
  assert.equal(await exited, 0);
  await assert.rejects(access(lease));
  assert.equal(second.run().status, 0);
});

test('a builder that cannot stop retains its lease and never starts application services', async t => {
  const { calls, run } = await installation(t, { DEPLOY_TEST_BUILDER_STOP_STATUS: '1' });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /构建租约已保留/);
  const commands = await readFile(calls, 'utf8');
  assert.match(commands, /build app/);
  assert.doesNotMatch(commands, /^rm f{64}$| up | stop log-worker/m);
});

test('private BuildKit registry configuration is passed only when creating the dedicated builder', async t => {
  const { root, calls, run } = await installation(t);
  await mkdir(path.join(root, '.local'));
  await writeFile(path.join(root, '.local/liekan-buildkit.toml'), '[worker.oci]\nmax-parallelism=1\n');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(calls, 'utf8'), /--buildkitd-config .local\/liekan-buildkit.toml/);
});

test('lost configuration also protects project names previously supplied by .env', async t => {
  const { root, calls, run } = await installation(t, {
    DEPLOY_TEST_VOLUME_EXISTS: '0',
    DEPLOY_TEST_VOLUME_NAME: 'production_liekan-data',
    COMPOSE_PROJECT_NAME: '',
  });
  assert.equal(run().status, 1);
  await assert.rejects(access(path.join(root, '.env')));
  assert.doesNotMatch(await readFile(calls, 'utf8'), /build app/);
});

test('an interrupted deployment releases its lock for a retry and keeps its configuration', async t => {
  const options = { DEPLOY_TEST_KILL_DEPLOY: '1' };
  const { root, run } = await installation(t, options);
  assert.equal(run().signal, 'SIGKILL');
  const original = await readFile(path.join(root, '.env'));
  options.DEPLOY_TEST_KILL_DEPLOY = '0';
  assert.equal(run().status, 0);
  assert.deepEqual(await readFile(path.join(root, '.env')), original);
});

test('a live deployment keeps exclusive ownership of its lock', async t => {
  const { root, calls, run, start } = await installation(t, { DEPLOY_TEST_BLOCK_BUILD: '1' });
  const first = start();
  const completed = new Promise(resolve => first.on('exit', resolve));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(`${calls}.building`);
      break;
    } catch {
      await delay(20);
    }
  }
  await access(`${calls}.building`);
  const original = await readFile(path.join(root, '.env'));
  assert.equal(run().status, 1);
  assert.equal(await completed, 0);
  assert.deepEqual(await readFile(path.join(root, '.env')), original);
  assert.equal((await readFile(calls, 'utf8')).match(/build app/g)?.length, 1);
});

async function existingInstallation(t, options = {}) {
  const installed = await installation(t, options);
  await writeFile(
    path.join(installed.root, '.env'),
    'POSTGRES_USER=existing\nPOSTGRES_DB=existing\nPOSTGRES_PASSWORD=preserved-private-password\nAPP_SECRET=preserved-private-key\nTWO_FACTOR_ENCRYPTION_KEY=preserved-private-2fa-key\n',
    { mode: 0o600 },
  );
  return installed;
}

function serviceStarts(calls) {
  return calls.split('\n').filter(line => line.includes(' up -d ') && !line.includes('--no-start'));
}

const safeUp =
  'compose -f docker-compose.liekan.yml up -d --no-build --no-deps --wait --wait-timeout 300';
const safeAppUp = safeUp.replace('300', '1800');
const safeWorkerUp = safeUp.replace('--no-deps ', '--no-deps --no-recreate ');

test('fresh installation starts database and cache before replacing the application and workers', async t => {
  const { calls, run } = await installation(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(serviceStarts(await readFile(calls, 'utf8')), [
    `${safeUp} db`,
    `${safeUp} analytics-cache`,
    `${safeAppUp} app`,
    `${safeWorkerUp} log-worker analytics-worker`,
  ]);
});

test('upgrading a running PostgreSQL 15 instance preserves its container despite the Compose image default', async t => {
  const { root, calls, run } = await existingInstallation(t, {
    DEPLOY_TEST_DB_CONTAINER: 'existing-postgres-15',
    DEPLOY_TEST_CACHE_CONTAINER: 'existing-cache',
    DEPLOY_TEST_VOLUME_EXISTS: '0',
  });
  const config = await readFile(path.join(root, '.env'));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const commands = await readFile(calls, 'utf8');
  assert.deepEqual(serviceStarts(commands), [
    `${safeAppUp} app`,
    `${safeWorkerUp} log-worker analytics-worker`,
  ]);
  assert.ok(commands.includes('existing-postgres-15'));
  assert.ok(commands.includes('existing-cache'));
  assert.deepEqual(await readFile(path.join(root, '.env')), config);
  assert.doesNotMatch(result.stdout + result.stderr, /preserved-private/);
});

test('stopped database and cache containers are started by their original IDs before the application update', async t => {
  const { calls, run } = await existingInstallation(t, {
    DEPLOY_TEST_DB_CONTAINER: 'stopped-postgres-15',
    DEPLOY_TEST_DB_STATE: 'exited',
    DEPLOY_TEST_CACHE_CONTAINER: 'stopped-cache',
    DEPLOY_TEST_CACHE_STATE: 'exited',
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const commands = await readFile(calls, 'utf8');
  assert.match(commands, /^start stopped-postgres-15$/m);
  assert.match(commands, /^start stopped-cache$/m);
  assert.ok(commands.indexOf('start stopped-postgres-15') < commands.indexOf(`${safeAppUp} app`));
  assert.ok(commands.indexOf('start stopped-cache') < commands.indexOf(`${safeAppUp} app`));
  assert.deepEqual(serviceStarts(commands), [
    `${safeAppUp} app`,
    `${safeWorkerUp} log-worker analytics-worker`,
  ]);
});

test('a database volume without its original container stops an upgrade before building or starting services', async t => {
  const { root, calls, run } = await existingInstallation(t, { DEPLOY_TEST_VOLUME_EXISTS: '0' });
  const original = await readFile(path.join(root, '.env'));
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /数据库.*容器|容器.*数据库/);
  const commands = await readFile(calls, 'utf8');
  assert.doesNotMatch(commands, /build app| up -d |^start /m);
  assert.deepEqual(await readFile(path.join(root, '.env')), original);
});

test('resolved custom Compose project names protect only the matching database volume', async t => {
  const options = {
    COMPOSE_PROJECT_NAME: '',
    DEPLOY_TEST_PROJECT_FROM_ENV: 'customer',
    DEPLOY_TEST_VOLUME_EXISTS: '0',
    DEPLOY_TEST_VOLUME_NAME: 'customer_liekan-data',
  };
  const { calls, run } = await existingInstallation(t, options);
  assert.equal(run().status, 1);
  assert.doesNotMatch(await readFile(calls, 'utf8'), /build app| up -d /);
  options.DEPLOY_TEST_VOLUME_NAME = 'unrelated_liekan-data';
  assert.equal(run().status, 0);
  assert.match(await readFile(calls, 'utf8'), /build app/);
});

test('an explicitly named database volume also blocks recreation when its original container is missing', async t => {
  const { calls, run } = await existingInstallation(t, {
    DEPLOY_TEST_DATABASE_VOLUME_NAME: 'ArchivedDatabase15',
    DEPLOY_TEST_VOLUME_EXISTS: '0',
    DEPLOY_TEST_VOLUME_NAME: 'ArchivedDatabase15',
  });
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /数据库.*容器|容器.*数据库/);
  assert.doesNotMatch(await readFile(calls, 'utf8'), /build app| up -d |^start /m);
});

test('an existing database with no cache creates only the missing cache before updating the application', async t => {
  const { calls, run } = await existingInstallation(t, {
    DEPLOY_TEST_DB_CONTAINER: 'existing-postgres-15',
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(serviceStarts(await readFile(calls, 'utf8')), [
    `${safeUp} analytics-cache`,
    `${safeAppUp} app`,
    `${safeWorkerUp} log-worker analytics-worker`,
  ]);
});

for (const [name, options] of [
  ['unhealthy database', { DEPLOY_TEST_DB_HEALTH: 'unhealthy' }],
  ['missing database health check', { DEPLOY_TEST_DB_HEALTH: 'missing' }],
  ['failed database start', { DEPLOY_TEST_DB_STATE: 'exited', DEPLOY_TEST_START_STATUS: '1' }],
  [
    'unhealthy existing cache',
    { DEPLOY_TEST_CACHE_CONTAINER: 'existing-cache', DEPLOY_TEST_CACHE_HEALTH: 'unhealthy' },
  ],
  ['failed cache creation', { DEPLOY_TEST_CACHE_UP_STATUS: '1' }],
]) {
  test(`${name} prevents replacement of the application and workers`, async t => {
    const { calls, run } = await existingInstallation(t, {
      DEPLOY_TEST_DB_CONTAINER: 'existing-postgres-15',
      ...options,
    });
    const result = run();
    assert.equal(result.status, 1, result.stderr);
    const commands = await readFile(calls, 'utf8');
    assert.match(commands, /existing-postgres-15/);
    if (options.DEPLOY_TEST_CACHE_CONTAINER) assert.match(commands, /inspect .*existing-cache/);
    if (options.DEPLOY_TEST_CACHE_UP_STATUS)
      assert.ok(commands.includes(`${safeUp} analytics-cache`));
    if (options.DEPLOY_TEST_START_STATUS) assert.match(commands, /^start existing-postgres-15$/m);
    assert.ok(
      !serviceStarts(commands).some(line => / (app|log-worker analytics-worker)$/.test(line)),
    );
  });
}

test('failed application health stops before replacing workers', async t => {
  const { calls, run } = await existingInstallation(t, {
    DEPLOY_TEST_DB_CONTAINER: 'existing-postgres-15',
    DEPLOY_TEST_CACHE_CONTAINER: 'existing-cache',
    DEPLOY_TEST_APP_UP_STATUS: '1',
  });
  assert.equal(run().status, 1);
  assert.deepEqual(serviceStarts(await readFile(calls, 'utf8')), [`${safeAppUp} app`]);
});

test('a build failure leaves stopped database and cache containers untouched', async t => {
  const { calls, run } = await existingInstallation(t, {
    DEPLOY_TEST_DB_CONTAINER: 'stopped-postgres-15',
    DEPLOY_TEST_DB_STATE: 'exited',
    DEPLOY_TEST_CACHE_CONTAINER: 'stopped-cache',
    DEPLOY_TEST_CACHE_STATE: 'exited',
    DEPLOY_TEST_BUILD_STATUS: '1',
  });
  assert.equal(run().status, 1);
  const commands = await readFile(calls, 'utf8');
  assert.match(commands, /build app/);
  assert.doesNotMatch(commands, /^start | up -d /m);
});

test('worker drain finishes before application migration during an existing upgrade', async t => {
  const { calls, run } = await existingInstallation(t, {
    DEPLOY_TEST_DB_CONTAINER: 'running-postgres-15',
    DEPLOY_TEST_CACHE_CONTAINER: 'running-cache',
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const commands = (await readFile(calls, 'utf8')).split('\n');
  const stopped = commands.indexOf(
    'compose -f docker-compose.liekan.yml stop log-worker analytics-worker',
  );
  assert.ok(stopped >= 0, 'old workers must stop before the app applies a new schema');
  assert.ok(commands.indexOf('compose -f docker-compose.liekan.yml build app') < stopped);
  assert.ok(stopped < commands.indexOf(`${safeAppUp} app`));
  assert.ok(
    commands.indexOf(`${safeAppUp} app`) <
      commands.indexOf(`${safeWorkerUp} log-worker analytics-worker`),
  );
  assert.equal(
    commands.filter(command => command.startsWith('compose ') && command.includes(' stop ')).length,
    1,
  );
});
test('worker stop failure preserves existing configuration and prevents application migration', async t => {
  const { root, calls, run } = await existingInstallation(t, {
    DEPLOY_TEST_WORKER_STOP_STATUS: '7',
  });
  const original = await readFile(path.join(root, '.env'));
  assert.equal(run().status, 7);
  const commands = await readFile(calls, 'utf8');
  assert.match(commands, /stop log-worker analytics-worker/);
  assert.ok(!commands.includes(`${safeAppUp} app`));
  assert.ok(!commands.includes(`${safeWorkerUp} log-worker analytics-worker`));
  assert.deepEqual(await readFile(path.join(root, '.env')), original);
});
test('build failure leaves workers running before an upgrade begins', async t => {
  const { calls, run } = await existingInstallation(t, { DEPLOY_TEST_BUILD_STATUS: '6' });
  assert.equal(run().status, 6);
  const commands = await readFile(calls, 'utf8');
  assert.match(commands, /build app/);
  assert.doesNotMatch(commands, /compose [^\n]* stop | up -d /);
});

const candidateImage = `sha256:${'a'.repeat(64)}`;
test('one immutable image ID pins all services through creation, startup and health checks', async t => {
  const { root, calls, run } = await installation(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  for (const phase of ['create', 'app', 'worker']) {
    const override = await readFile(`${calls}.${phase}-override`, 'utf8');
    assert.equal(override.match(new RegExp(`image: ${candidateImage}`, 'g'))?.length, 3);
    assert.equal(override.match(/pull_policy: never/g)?.length, 3);
    assert.doesNotMatch(override, /APP_SECRET|POSTGRES_PASSWORD/);
    assert.equal((await stat(`${calls}.${phase}-override`)).mode & 0o777, 0o600);
  }
  const trace = await readFile(calls, 'utf8');
  const create = trace.indexOf('up -d --no-build --no-deps --no-start log-worker analytics-worker');
  const inspect = trace.indexOf('inspect --format {{.Image}} log-worker-container');
  const start = trace.indexOf(safeWorkerUp);
  assert.ok(create >= 0 && inspect > create && start > inspect);
  assert.match(trace, new RegExp(`tag ${candidateImage} liekan:1.2.0`));
  assert.match(trace, /image inspect --format \{\{.Id\}\} liekan:deploy-liekan-candidate\./);
  assert.doesNotMatch(trace, /compose .* images /);
  assert.match(result.stdout, /来源：unknown；工作区：unknown/);
  assert.doesNotMatch(result.stdout, /来源：development/);
  const files = await readdir(path.join(root, '.local'));
  assert.ok(!files.some(file => file.startsWith('liekan-candidate.')));
});

for (const [service, options, workersMayStart] of [
  ['app', { DEPLOY_TEST_APP_IMAGE: `sha256:${'b'.repeat(64)}` }, false],
  ['app', { DEPLOY_TEST_APP_HEALTH: 'unhealthy' }, false],
  ['log-worker', { DEPLOY_TEST_LOG_WORKER_IMAGE: `sha256:${'b'.repeat(64)}` }, false],
  [
    'analytics-worker',
    { DEPLOY_TEST_ANALYTICS_WORKER_REVISION: 'different-known-revision' },
    false,
  ],
  ['log-worker', { DEPLOY_TEST_LOG_WORKER_HEALTH: 'unhealthy' }, true],
  ['analytics-worker', { DEPLOY_TEST_ANALYTICS_WORKER_HEALTH: 'unhealthy' }, true],
  ['log-worker', { DEPLOY_TEST_RUNNING_WORKER_IMAGE: `sha256:${'b'.repeat(64)}` }, true],
]) {
  test(`${service} candidate mismatch or health failure stops workers safely (${Object.keys(options)[0]})`, async t => {
    const { root, calls, run } = await existingInstallation(t, options);
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(service));
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /preserved-private|different-known-revision/,
    );
    const trace = await readFile(calls, 'utf8');
    if (!workersMayStart) assert.ok(!trace.includes(safeWorkerUp));
    assert.ok(trace.lastIndexOf('stop log-worker analytics-worker') > trace.indexOf('build app'));
    assert.doesNotMatch(trace, /^tag /m);
    assert.ok(
      !(await readdir(path.join(root, '.local'))).some(file =>
        file.startsWith('liekan-candidate.'),
      ),
    );
    assert.match(trace, /^image rm liekan:deploy-/m);
  });
}

test('an unresolved candidate image stops before touching the current services', async t => {
  const { calls, run } = await existingInstallation(t, {
    DEPLOY_TEST_CANDIDATE_IMAGE: 'liekan:1.2.0',
  });
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不可变镜像 ID/);
  assert.doesNotMatch(await readFile(calls, 'utf8'), /compose [^\n]* stop | up -d |^start /m);
});

for (const revision of ['development', '<no value>']) {
  test(`legacy ${revision} revision metadata remains unknown while immutable images agree`, async t => {
    const { run } = await installation(t, { DEPLOY_TEST_REVISION_LABEL: revision });
    assert.equal(run().status, 0);
  });
}

test('source archives deploy when Git is unavailable', async t => {
  const { root, run } = await installation(t);
  await writeFile(path.join(root, 'bin/git'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /来源：unknown；工作区：unknown/);
});

test('Git source metadata records real HEAD and changes its digest for untracked content only', async t => {
  const options = {};
  const { root, calls, run } = await installation(t, options);
  const git = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(git);
  const revision = 'c'.repeat(40);
  // Git plumbing hashes real fixture bytes; repository history and the caller checkout stay untouched.
  await writeFile(
    path.join(root, 'bin/git'),
    [
      '#!/bin/sh',
      'case "$*" in',
      '  "rev-parse --show-toplevel") printf "%s\\n" "$PWD" ;;',
      `  "rev-parse HEAD") printf '%s\\n' '${revision}' ;;`,
      '  status*) if [ "${DEPLOY_TEST_GIT_CLEAN:-0}" != 1 ]; then printf " M product.ts\\n?? new-product.ts\\n"; fi ;;',
      '  diff*) printf "private fixture difference\\n" ;;',
      '  ls-files*) printf "new-product.ts\\0" ;;',
      `  hash-object*) exec '${git}' "$@" ;;`,
      '  *) exit 99 ;;',
      'esac',
    ].join('\n'),
    { mode: 0o755 },
  );
  await writeFile(path.join(root, 'new-product.ts'), 'first untracked product');
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const original = await readFile(`${calls}.build-override`, 'utf8');
  assert.match(original, new RegExp(`revision: "${revision}"`));
  assert.match(original, /source.state: "dirty"/);
  assert.match(original, /source.difference: "[a-f0-9]{40}"/);
  assert.doesNotMatch(first.stdout + first.stderr, /private fixture|first untracked/);
  await writeFile(path.join(root, 'new-product.ts'), 'second untracked product');
  assert.equal(run().status, 0);
  const changed = await readFile(`${calls}.build-override`, 'utf8');
  assert.notEqual(changed, original);
  const raw = await readFile(`${calls}.raw`, 'utf8');
  assert.match(
    raw,
    new RegExp(
      `build --builder geoinflow-build-v1-\\d+ --build-arg LIEKAN_REVISION=${revision} app`,
    ),
  );
  options.DEPLOY_TEST_GIT_CLEAN = '1';
  assert.equal(run().status, 0);
  assert.match(await readFile(`${calls}.build-override`, 'utf8'), /source.state: "clean"/);
  assert.match(await readFile(`${calls}.build-override`, 'utf8'), /source.difference: "none"/);
  const previousCalls = (await readFile(calls, 'utf8')).length;
  options.DEPLOY_TEST_REVISION_LABEL = 'd'.repeat(40);
  const mismatch = run();
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /app 构建来源版本不匹配/);
  assert.doesNotMatch((await readFile(calls, 'utf8')).slice(previousCalls), /compose [^\n]* stop | up -d /);
});

test('Docker startup seeds the bundled official demo after migrations and before serving', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liekan-demo-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'bin'));
  await mkdir(path.join(root, 'scripts'));
  await copyFile('scripts/liekan-start.sh', path.join(root, 'scripts/liekan-start.sh'));
  const calls = path.join(root, 'calls');
  await writeFile(
    path.join(root, 'bin/node'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DEMO_START_CALLS"\nif [ "$1" = scripts/liekan-seed-demo.mjs ]; then exit "${DEMO_START_FAIL:-0}"; fi\n',
    { mode: 0o755 },
  );
  const run = failure =>
    spawnSync('sh', ['scripts/liekan-start.sh'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: path.join(root, 'bin') + ':' + process.env.PATH,
        DEMO_START_CALLS: calls,
        DEMO_START_FAIL: String(failure),
      },
    });
  assert.equal(run(0).status, 0);
  const trace = (await readFile(calls, 'utf8')).trim().split('\n');
  const seed = trace.indexOf('scripts/liekan-seed-demo.mjs --automatic');
  assert(seed > trace.indexOf('scripts/liekan-migrate.mjs'));
  assert(seed < trace.indexOf('server.js'));
  await writeFile(calls, '');
  assert.equal(run(1).status, 1);
  assert(!(await readFile(calls, 'utf8')).includes('server.js'));
  const dockerfile = await readFile('Dockerfile.liekan', 'utf8');
  assert.match(dockerfile, /COPY --from=builder[^\n]+scripts/);
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert(packageJson.scripts['build:docker'].includes('liekan:check-demo'));
});
