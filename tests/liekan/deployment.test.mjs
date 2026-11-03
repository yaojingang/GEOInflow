import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, stat, access, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
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

async function installation(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liekan-install-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'bin'));
  await copyFile('scripts/liekan-deploy.sh', path.join(root, 'scripts/liekan-deploy.sh'));
  await writeFile(
    path.join(root, 'bin/docker'),
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$DEPLOY_TEST_CALLS"',
      'compose_project=${DEPLOY_TEST_PROJECT_FROM_ENV:-${COMPOSE_PROJECT_NAME:-liekan}}',
      'database_volume=${DEPLOY_TEST_DATABASE_VOLUME_NAME:-${compose_project}_liekan-data}',
      'db_container=${DEPLOY_TEST_DB_CONTAINER:-}',
      'cache_container=${DEPLOY_TEST_CACHE_CONTAINER:-}',
      'case "$*" in',
      "  'compose version'|info|'compose -f docker-compose.liekan.yml config --quiet') exit 0 ;;",
      '  \'volume ls --format {{.Name}}\') if [ "${DEPLOY_TEST_VOLUME_EXISTS:-1}" = 0 ]; then printf \'%s\\n\' "${DEPLOY_TEST_VOLUME_NAME:-${compose_project}_liekan-data}"; fi ;;',
      '  \'compose -f docker-compose.liekan.yml config --format yaml\') printf \'name: "%s"\\nvolumes:\\n  liekan-data:\\n    name: "%s"\\n  liekan-geography:\\n    name: %s_liekan-geography\\n\' "$compose_project" "$database_volume" "$compose_project" ;;',
      "  'compose -f docker-compose.liekan.yml ps --all --quiet db') printf '%s\\n' \"$db_container\" ;;",
      "  'compose -f docker-compose.liekan.yml ps --all --quiet analytics-cache') printf '%s\\n' \"$cache_container\" ;;",
      "  'inspect --format '*)",
      '    if [ "$4" = "$db_container" ] && [ -n "$db_container" ]; then state=${DEPLOY_TEST_DB_STATE:-running}; health=${DEPLOY_TEST_DB_HEALTH:-healthy};',
      '    elif [ "$4" = "$cache_container" ] && [ -n "$cache_container" ]; then state=${DEPLOY_TEST_CACHE_STATE:-running}; health=${DEPLOY_TEST_CACHE_HEALTH:-healthy};',
      '    else exit 91; fi',
      '    if [ -e "$DEPLOY_TEST_CALLS.started.$4" ]; then state=running; fi',
      '    case "$3" in',
      "      '{{.State.Status}}') printf '%s\\n' \"$state\" ;;",
      '      \'{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}\') printf \'%s %s\\n\' "$state" "$health" ;;',
      '      *) exit 94 ;;',
      '    esac ;;',
      '  start\\ *)',
      '    if [ "$2" != "$db_container" ] && [ "$2" != "$cache_container" ]; then exit 92; fi',
      '    if [ "${DEPLOY_TEST_START_STATUS:-0}" != 0 ]; then exit "$DEPLOY_TEST_START_STATUS"; fi',
      '    touch "$DEPLOY_TEST_CALLS.started.$2" ;;',
      '  \'compose -f docker-compose.liekan.yml build app\') if [ "${DEPLOY_TEST_KILL_DEPLOY:-0}" = 1 ]; then kill -KILL "$PPID"; fi; if [ "${DEPLOY_TEST_BLOCK_BUILD:-0}" = 1 ]; then touch "$DEPLOY_TEST_CALLS.building"; sleep 2; fi; exit "${DEPLOY_TEST_BUILD_STATUS:-0}" ;;',
      "  'compose -f docker-compose.liekan.yml stop log-worker analytics-worker') exit \"${DEPLOY_TEST_WORKER_STOP_STATUS:-0}\" ;;",
      "  'compose -f docker-compose.liekan.yml up -d --no-build --wait --wait-timeout 300') exit 0 ;;",
      "  'compose -f docker-compose.liekan.yml up -d --no-build --no-deps --wait --wait-timeout 300 '*)",
      '    shift 10',
      '    case "$*" in db|analytics-cache|app|\'log-worker analytics-worker\') ;; *) exit 93 ;; esac',
      '    if [ "$*" = analytics-cache ]; then exit "${DEPLOY_TEST_CACHE_UP_STATUS:-0}"; fi',
      '    if [ "$*" = app ]; then exit "${DEPLOY_TEST_APP_UP_STATUS:-0}"; fi ;;',
      "  *) printf 'Unexpected Docker command in deployment test\\n' >&2; exit 90 ;;",
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
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

test('legacy deployment refuses warehouse configuration before Docker calls and preserves it', async t => {
  const { root, calls, run } = await installation(t);
  const text = 'POSTGRES_PASSWORD=private-fixture\nexport LIEKAN_INSTALL_MODE=pg-transition\n';
  await writeFile(path.join(root, '.env'), text, { mode: 0o600 });
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /liekan-warehouse-deploy\.py/);
  assert.ok(!result.stderr.includes('private-fixture'));
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), text);
  await assert.rejects(access(calls));
});

test('app checks persisted warehouse mode before migrations or opening the HTTP server', async () => {
  const script = await readFile('scripts/liekan-start.sh', 'utf8');
  const guard = script.indexOf('node dist/liekan-warehouse-start-check.mjs');
  assert.ok(guard >= 0);
  for (const command of ['node scripts/check-db.js', 'node scripts/liekan-migrate.mjs', 'exec node server.js'])
    assert.ok(guard < script.indexOf(command));
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
  return calls.split('\n').filter(line => line.includes(' up -d '));
}

const safeUp =
  'compose -f docker-compose.liekan.yml up -d --no-build --no-deps --wait --wait-timeout 300';

test('fresh installation starts database and cache before replacing the application and workers', async t => {
  const { calls, run } = await installation(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(serviceStarts(await readFile(calls, 'utf8')), [
    `${safeUp} db`,
    `${safeUp} analytics-cache`,
    `${safeUp} app`,
    `${safeUp} log-worker analytics-worker`,
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
    `${safeUp} app`,
    `${safeUp} log-worker analytics-worker`,
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
  assert.ok(commands.indexOf('start stopped-postgres-15') < commands.indexOf(`${safeUp} app`));
  assert.ok(commands.indexOf('start stopped-cache') < commands.indexOf(`${safeUp} app`));
  assert.deepEqual(serviceStarts(commands), [
    `${safeUp} app`,
    `${safeUp} log-worker analytics-worker`,
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
    `${safeUp} app`,
    `${safeUp} log-worker analytics-worker`,
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
  assert.deepEqual(serviceStarts(await readFile(calls, 'utf8')), [`${safeUp} app`]);
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
  const stopped = commands.indexOf('compose -f docker-compose.liekan.yml stop log-worker analytics-worker');
  assert.ok(stopped >= 0, 'old workers must stop before the app applies a new schema');
  assert.ok(commands.indexOf('compose -f docker-compose.liekan.yml build app') < stopped);
  assert.ok(stopped < commands.indexOf(`${safeUp} app`));
  assert.ok(commands.indexOf(`${safeUp} app`) < commands.indexOf(`${safeUp} log-worker analytics-worker`));
  assert.equal(commands.filter(command => command.includes(' stop ')).length, 1);
});
test('worker stop failure preserves existing configuration and prevents application migration', async t => {
  const { root, calls, run } = await existingInstallation(t, { DEPLOY_TEST_WORKER_STOP_STATUS: '7' });
  const original = await readFile(path.join(root, '.env'));
  assert.equal(run().status, 7);
  const commands = await readFile(calls, 'utf8');
  assert.match(commands, /stop log-worker analytics-worker/);
  assert.ok(!commands.includes(`${safeUp} app`));
  assert.ok(!commands.includes(`${safeUp} log-worker analytics-worker`));
  assert.deepEqual(await readFile(path.join(root, '.env')), original);
});
test('build failure leaves workers running before an upgrade begins', async t => {
  const { calls, run } = await existingInstallation(t, { DEPLOY_TEST_BUILD_STATUS: '6' });
  assert.equal(run().status, 6);
  const commands = await readFile(calls, 'utf8');
  assert.match(commands, /build app/);
  assert.doesNotMatch(commands, / stop | up -d /);
});
