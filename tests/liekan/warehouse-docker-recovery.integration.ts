// Installed-image and coherent backup recovery acceptance. All resources are
// new, explicitly named local projects; this driver never selects the live stack.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

assert.equal(process.env.WAREHOUSE_DOCKER_TEST, 'isolated-new-project');
const stage = process.env.WAREHOUSE_DOCKER_STAGE;
assert.ok(['prepare', 'backup', 'restore', 'launch', 'verify'].includes(stage!));
const finalImage = process.env.WAREHOUSE_DOCKER_RECOVERY_FINAL === '1';
const reviewImage = process.env.WAREHOUSE_DOCKER_RECOVERY_REVIEW === '1';
const kafkaImage = process.env.WAREHOUSE_DOCKER_RECOVERY_KAFKA === 'isolated-new-project';
assert.ok(!reviewImage || finalImage, 'Review recovery requires the final-image fixture');
assert.ok(!kafkaImage || (!reviewImage && !finalImage), 'Kafka uses its own new recovery fixture');
const directory = resolve(
  kafkaImage
    ? '.local/kafka-validation-20261104/docker-recovery'
    : reviewImage
      ? '.local/ch-final-review-recovery'
      : finalImage
        ? '.local/ch-final-recovery'
        : '.local/ch-deploy-validation',
);
const sourceProject = kafkaImage
  ? 'geoinflow-kafka-deploy-20261104'
  : finalImage
    ? 'liekan_ch_restore_validation_20261103_v2'
    : 'liekan_ch_deploy_validation_20261103';
const restoreProject = kafkaImage
  ? 'geoinflow-kafka-recovery-20261104'
  : reviewImage
    ? 'liekan_ch_review_recovery_20261103'
    : finalImage
      ? 'liekan_ch_final_recovery_20261103'
      : 'liekan_ch_restore_validation_20261103_v2';
const sourceOverride = `${directory}/${finalImage ? 'source.compose.json' : 'compose.yml'}`;
const backup = `${directory}/backup`;
const stateFile = `${directory}/recovery.json`;
const state = await readFile(stateFile, 'utf8')
  .then(JSON.parse)
  .catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return { site: randomUUID(), first: randomUUID(), pending: randomUUID(), steps: {} };
  });
const save = () => writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
const env = Object.fromEntries(
  (await readFile(`${directory}/private.env`, 'utf8'))
    .split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const equal = line.indexOf('=');
      return [line.slice(0, equal), line.slice(equal + 1)];
    }),
);
// Internal Docker networks can omit published host bindings. Keep the copy
// isolated and use the same exec transport as the same-host test harness.
const relays: ReturnType<typeof createServer>[] = [];
const relayConnections = new Set<() => void>();
async function isolatedRelays(project: string) {
  if (!kafkaImage) return;
  const [app, database] = JSON.parse(
    execFileSync('docker', ['inspect', `${project}-app-1`, `${project}-db-1`], {
      encoding: 'utf8',
    }),
  );
  for (const [info, service] of [
    [app, 'app'],
    [database, 'db'],
  ]) {
    assert.equal(info.Config.Labels['com.docker.compose.project'], project);
    assert.equal(info.Config.Labels['com.docker.compose.service'], service);
    assert.equal(info.State.Running, true);
  }
  const networks = Object.keys(app.NetworkSettings.Networks);
  assert.deepEqual(networks, Object.keys(database.NetworkSettings.Networks));
  assert.equal(networks.length, 1);
  const [network] = JSON.parse(
    execFileSync('docker', ['network', 'inspect', networks[0]], { encoding: 'utf8' }),
  );
  assert.equal(network.Internal, true);
  for (const [info, local, remote, host] of [
    [app, 3002, 3000, '127.0.0.1'],
    [database, 25479, 5432, 'db'],
  ] as const) {
    const bindings = info.NetworkSettings.Ports[`${remote}/tcp`];
    if (bindings?.length) {
      assert.ok(
        bindings.some(
          (b: { HostIp: string; HostPort: string }) =>
            b.HostIp === '127.0.0.1' && Number(b.HostPort) === local,
        ),
      );
      continue;
    }
    const code = `const s=require('node:net').connect(${remote},${JSON.stringify(host)});s.setTimeout(120000,()=>s.destroy());s.on('error',()=>process.exit(1));process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit());`;
    const server = createServer(socket => {
      if (relayConnections.size >= 4) return socket.destroy();
      const child = spawn('docker', ['exec', '-i', app.Id, 'node', '-e', code], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        relayConnections.delete(close);
        socket.destroy();
        child.kill('SIGTERM');
      };
      relayConnections.add(close);
      socket.setTimeout(120000, close);
      socket.on('error', close).on('close', close);
      child.on('error', close).on('exit', close);
      child.stdin.on('error', close);
      child.stdout.on('error', close);
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
    });
    relays.push(server);
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(local, '127.0.0.1', done);
    });
  }
}
const sourceCompose = [
  'compose',
  '--env-file',
  `${directory}/private.env`,
  '--project-name',
  sourceProject,
  '-f',
  'docker-compose.liekan.yml',
  '-f',
  'docker-compose.warehouse.yml',
  '-f',
  sourceOverride,
];
const restoredCompose = [
  'compose',
  '--project-name',
  restoreProject,
  '-f',
  `${backup}/restore-${restoreProject}.compose.json`,
  '-f',
  `${directory}/restore-ports.json`,
];
async function command(name: string, executable: string, args: string[]) {
  const log = await open(`${directory}/recovery-${name}.log`, 'a', 0o600);
  try {
    const child = spawn(executable, args, { stdio: ['ignore', log.fd, log.fd] });
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    assert.equal(code, 0, `Recovery ${name}; see private log`);
  } finally {
    await log.close();
  }
}
async function request(path: string, body?: object, token?: string) {
  const response = await fetch(`http://127.0.0.1:3002${path}`, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(65000),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      'X-Liekan-Test-Client-IP': '192.0.2.30',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
const event = (id: string) => ({
  type: 'event',
  payload: {
    website: state.site,
    eventId: id,
    hostname: 'docker-recovery.invalid',
    url: id === state.first ? '/before' : '/queued',
    language: 'zh-CN',
    screen: '1920x1080',
  },
});
async function database<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    host: '127.0.0.1',
    port: 25479,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB,
    options: '-c default_transaction_read_only=on -c statement_timeout=30000',
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
async function installation() {
  return database(
    async db =>
      (
        await db.query(`SELECT installation_id,topic_id,topic_name,
    authority,transition,facts_fenced,identity_bound FROM liekan_warehouse_installation WHERE id=1`)
      ).rows[0],
  );
}
async function emptyPGFacts() {
  await database(async db => {
    for (const table of [
      'website_event',
      'session',
      'event_data',
      'revenue',
      'liekan_event_quality',
      'liekan_collection_receipt',
    ]) {
      assert.equal(
        (
          await db.query(`SELECT count(*)::text AS n FROM "${table}" WHERE website_id=$1`, [
            state.site,
          ])
        ).rows[0].n,
        '0',
        table,
      );
    }
  });
}
async function legacyQuotaFixture() {
  // Only the newly created synthetic website in the explicitly guarded test
  // installation is modified. No physical disk allocation is manufactured.
  const client = new pg.Client({
    host: '127.0.0.1',
    port: 25479,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB,
  });
  await client.connect();
  try {
    const [installation] = (
      await client.query('SELECT installation_id FROM liekan_warehouse_installation WHERE id=1')
    ).rows;
    assert.equal(installation.installation_id, state.initial.installation_id);
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM website WHERE website_id=$1 AND domain='docker-recovery.invalid'",
          [state.site],
        )
      ).rowCount,
      1,
    );
    await client.query(
      `INSERT INTO liekan_analysis_site(website_id,derived_bytes) VALUES($1,9663676416)
      ON CONFLICT(website_id) DO UPDATE SET derived_bytes=EXCLUDED.derived_bytes`,
      [state.site],
    );
  } finally {
    await client.end();
  }
}
async function collect(id: string) {
  const end = Date.now() + 90000;
  for (;;) {
    const result = await request('/api/send', event(id));
    if (result.status === 503 && Date.now() < end) {
      await delay(1000);
      continue;
    }
    assert.equal(result.status, 200, 'Confirmed restored input');
    return result.body;
  }
}
async function owner() {
  const response = await request('/api/auth/login', { username: 'admin', password: 'liekan' });
  assert.equal(response.status, 200);
  assert.equal(typeof response.body.token, 'string');
  return response.body.token as string;
}
async function pageviews(token: string) {
  const now = Date.now();
  const range = new URLSearchParams({
    startAt: String(now - 86400000),
    endAt: String(now + 60000),
    timezone: 'UTC',
  });
  const stats = await request(`/api/websites/${state.site}/stats?${range}`, undefined, token);
  assert.equal(stats.status, 200);
  return stats.body.pageviews;
}
try {
  await save();
  if (stage === 'prepare' || stage === 'verify')
    await isolatedRelays(stage === 'prepare' ? sourceProject : restoreProject);
  if (stage === 'prepare') {
    const token = await owner();
    if (!state.steps.site) {
      const created = await request(
        '/api/websites',
        {
          id: state.site,
          name: 'Docker recovery (isolated synthetic)',
          domain: 'docker-recovery.invalid',
        },
        token,
      );
      assert.equal(created.status, 200);
      assert.equal(created.body.id, state.site);
      state.steps.site = true;
      await save();
    }
    state.initial = await installation();
    assert.equal(state.initial.authority, 'clickhouse');
    assert.equal(state.initial.facts_fenced, true);
    assert.equal(state.initial.identity_bound, true);
    assert.equal(state.initial.transition, 'none');
    await legacyQuotaFixture();
    state.confirmed = await collect(state.first);
    assert.equal(await pageviews(token), 1);
    await emptyPGFacts();
    await save();
    await command('pause-consumer', 'docker', [
      ...sourceCompose,
      'stop',
      '-t',
      '30',
      'warehouse-worker',
    ]);
    const pending = await request('/api/send', event(state.pending));
    assert.equal(
      pending.status,
      503,
      'A queued input without a consumer cannot report business success',
    );
    const work = await database(
      async db =>
        (
          await db.query(
            `SELECT status FROM liekan_warehouse_work
      WHERE website_id=$1 AND status<>'confirmed'`,
            [state.site],
          )
        ).rows,
    );
    // The queue write may precede control discovery; no unfinished PG work is
    // required. The restored retry must nevertheless find exactly one event.
    state.steps.prepare = {
      passed: true,
      pendingStatus: pending.status,
      discoveredPending: work.length,
      legacyDerivedLedgerGiB: 9,
      collectionAndReportsAvailableAboveOldQuotas: true,
    };
    await save();
  } else if (stage === 'backup') {
    assert.ok(state.steps.prepare?.passed);
    await command('backup', 'python3', [
      'scripts/liekan-warehouse-backup.py',
      'backup',
      '--directory',
      backup,
      '--env-file',
      `${directory}/private.env`,
      '--project',
      sourceProject,
      '--compose-override',
      sourceOverride,
    ]);
    const manifest = JSON.parse(await readFile(`${backup}/manifest.json`, 'utf8'));
    if (finalImage) assert.equal(manifest.configurationEncoding, 'literal-v1');
    assert.ok(manifest.files['images.tar'].bytes > 0);
    assert.equal(manifest.volumes.length, 6);
    state.steps.backup = {
      passed: true,
      imageBytes: manifest.files['images.tar'].bytes,
      volumeCount: manifest.volumes.length,
      consistency: manifest.consistency,
    };
    await save();
  } else if (stage === 'restore') {
    assert.ok(state.steps.backup?.passed);
    await command('restore', 'python3', [
      'scripts/liekan-warehouse-backup.py',
      'restore',
      '--directory',
      backup,
      '--project',
      restoreProject,
    ]);
    const config = JSON.parse(
      await readFile(`${backup}/restore-${restoreProject}.compose.json`, 'utf8'),
    );
    assert.equal(config.services['warehouse-init'], undefined);
    assert.ok(Object.values(config.services).every((s: any) => !s.ports));
    assert.ok(
      Object.values(config.networks).every((n: any) => n.internal === true),
      'Restored copies must not reach external provider APIs',
    );
    assert.ok(
      Object.values(config.volumes).every((v: any) => v.name.startsWith(`${restoreProject}_`)),
    );
    state.steps.restore = { passed: true, newVolumesOnly: true, sourceUntouched: true };
    await save();
  } else if (stage === 'launch') {
    assert.ok(state.steps.restore?.passed);
    await writeFile(
      `${directory}/restore-ports.json`,
      JSON.stringify({
        services: {
          app: { ports: ['127.0.0.1:3002:3000'] },
          db: { ports: ['127.0.0.1:25479:5432'] },
        },
        ...(kafkaImage
          ? { networks: { default: { ipam: { config: [{ subnet: '10.253.72.0/24' }] } } } }
          : {}),
      }),
      { mode: 0o600 },
    );
    for (const group of [
      ['db', 'warehouse-ch', 'warehouse-queue', 'analytics-cache'],
      ['app'],
      [
        'log-worker',
        'analytics-worker',
        'warehouse-worker',
        'warehouse-transition',
        'warehouse-maintenance',
      ],
    ]) {
      await command(`launch-${group[0]}`, 'docker', [
        ...restoredCompose,
        'up',
        '-d',
        '--no-build',
        '--no-deps',
        '--wait',
        '--wait-timeout',
        '300',
        ...group,
      ]);
    }
    state.steps.launch = { passed: true };
    await save();
  } else {
    assert.ok(state.steps.launch?.passed);
    assert.deepEqual(
      await installation(),
      state.initial,
      'Installation and topic identities survive restore',
    );
    const token = await owner();
    // Verify processing of the durable pending input BEFORE sending its retry.
    // Otherwise a backup that lost the queue could look successful by reinsertion.
    const end = Date.now() + 90000;
    while ((await pageviews(token)) !== 2) {
      if (Date.now() >= end)
        throw new Error('Restored pending queue did not reach exactly two pageviews');
      await delay(1000);
    }
    const first = await collect(state.first),
      pending = await collect(state.pending),
      retry = await collect(state.pending);
    assert.equal(first.sessionId, state.confirmed.sessionId);
    assert.equal(first.visitId, state.confirmed.visitId);
    assert.equal(pending.sessionId, retry.sessionId);
    assert.equal(pending.visitId, retry.visitId);
    assert.equal(await pageviews(token), 2);
    await emptyPGFacts();
    state.steps.verify = {
      passed: true,
      originalAndPendingEvents: 2,
      pgFactGrowth: 0,
      recoveredBeforeRetry: true,
      topicIdentityPreserved: true,
      duplicateReceiptsPreserved: true,
    };
    await save();
  }
  console.log(JSON.stringify({ stage, result: state.steps[stage!] }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Docker recovery failed');
  process.exitCode = 1;
} finally {
  for (const close of [...relayConnections]) close();
  await Promise.all(relays.map(server => new Promise<void>(done => server.close(() => done()))));
}
