// Real production HTTP routes + compiled consumer, using only the fresh test installation.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import {
  testClickHouseURL,
  testPostgresPort,
  testPostgresPasswordFile,
} from './warehouse-test-target';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const directory = resolve(process.env.WAREHOUSE_FRESH_DIRECTORY ?? '.local/ch-fresh-validation');
assert.ok(directory.startsWith(`${resolve('.local')}/`));
const state = JSON.parse(await readFile(`${directory}/state.json`, 'utf8'));
assert.match(state.run, /^warehouse_fresh_\d+$/);
assert.ok(state.steps.install?.passed);
const url = new URL(`postgresql://127.0.0.1:${testPostgresPort}/${state.run}`);
url.username = 'liekan_ch_proto';
url.password = (await readFile(testPostgresPasswordFile, 'utf8')).trim();
const db = new ControlDatabase(url.toString());
const ch = createWarehouseClient({ url: testClickHouseURL, database: state.run });
const environment = {
  ...process.env,
  NODE_ENV: 'production' as const,
  NEXT_TELEMETRY_DISABLED: '1',
  DATABASE_URL: url.toString(),
  DIRECT_DATABASE_URL: url.toString(),
  DATABASE_REPLICA_URL: '',
  APP_SECRET: state.secret,
  TWO_FACTOR_ENCRYPTION_KEY: state.secret,
  LIEKAN_ANALYTICS_BACKEND: 'clickhouse',
  LIEKAN_WAREHOUSE_TRANSITION: 'true',
  LIEKAN_CLICKHOUSE_URL: testClickHouseURL,
  LIEKAN_CLICKHOUSE_DATABASE: state.run,
  LIEKAN_CLICKHOUSE_USERNAME: 'default',
  LIEKAN_CLICKHOUSE_PASSWORD: '',
  CLICKHOUSE_URL: '',
  LIEKAN_QUEUE_BROKERS: '127.0.0.1:29109',
  CLIENT_IP_HEADER: 'x-liekan-test-client-ip',
  LIEKAN_WAREHOUSE_HEALTH_FILE: `${directory}/http-worker.health.json`,
  REDIS_URL: '',
  LIEKAN_ANALYTICS_REDIS_URL: '',
  LIEKAN_AI_ENABLED: 'false',
  LIEKAN_PUBLIC_URL: 'https://warehouse-http.fixture.invalid',
  CLOUD_MODE: '',
  LIEKAN_EXPORT_DIRECTORY: `${directory}/exports`,
};
const cases: object[] = [],
  processes: ChildProcess[] = [],
  logs: Awaited<ReturnType<typeof open>>[] = [];
const exits = new Map<ChildProcess, Promise<void>>();
let pendingResponses = 0;
async function start(name: string, args: string[]) {
  const log = await open(`${directory}/http-${name}.log`, 'a', 0o600);
  logs.push(log);
  const child = spawn(process.execPath, args, {
    env: environment,
    stdio: ['ignore', log.fd, log.fd],
  });
  exits.set(
    child,
    new Promise(done => {
      child.once('exit', () => done());
      child.once('error', () => done());
    }),
  );
  processes.push(child);
  return child;
}
async function until(work: () => Promise<boolean>, label: string) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (processes.some(p => p.exitCode !== null))
      throw new Error(`HTTP fixture process exited: ${label}`);
    if (await work().catch(() => false)) return;
    await delay(250);
  }
  throw new Error(`HTTP fixture timed out: ${label}`);
}
async function request(path: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:3002${path}`, { ...init, signal: AbortSignal.timeout(65000) });
}
async function json(
  path: string,
  method: string,
  body: object | undefined,
  headers: Record<string, string> = {},
  status = 200,
) {
  const response = await request(path, {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, status, `${method} ${path} status`);
  return response.json();
}
try {
  const reservation = createServer();
  await new Promise<void>((done, reject) => {
    reservation.once('error', reject);
    reservation.listen(3002, '127.0.0.1', done);
  });
  await new Promise<void>(done => reservation.close(() => done()));
  await start('app', ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '3002']);
  await start('worker', ['dist/liekan-warehouse-worker.mjs']);
  await until(async () => (await request('/api/heartbeat')).ok, 'production app startup');
  await until(async () => {
    const health = JSON.parse(await readFile(environment.LIEKAN_WAREHOUSE_HEALTH_FILE, 'utf8'));
    return health.healthy && Date.now() - Date.parse(health.at) < 60000;
  }, 'compiled worker health');
  await json('/api/auth/login', 'POST', { username: 'admin', password: 'liekan' }, {}, 401);
  const login = await json('/api/auth/login', 'POST', {
    username: 'isolated-customized-admin',
    password: 'isolated-customized-password',
  });
  assert.equal(typeof login.token, 'string');
  const owner = { Authorization: `Bearer ${login.token}` };
  const site = randomUUID();
  const created = await json(
    '/api/websites',
    'POST',
    { id: site, name: 'HTTP acceptance (isolated synthetic)', domain: 'http.warehouse.invalid' },
    owner,
  );
  assert.equal(created.id, site);
  assert.equal((await db.read('SELECT 1 FROM website WHERE website_id=$1', [site])).length, 1);
  cases.push({
    name: 'production login preserves customized account and website creation registers warehouse metadata',
    status: 'pass',
  });
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'X-Liekan-Test-Client-IP': '192.0.2.27',
  };
  async function collect(body: object) {
    const deadline = Date.now() + 90000;
    for (;;) {
      const response = await request('/api/send', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (response.status === 503 && Date.now() < deadline) {
        pendingResponses++;
        await delay(1000);
        continue;
      }
      assert.equal(response.status, 200, 'public collection confirmation');
      const result = await response.json();
      assert.deepEqual(Object.keys(result).sort(), ['cache', 'sessionId', 'visitId']);
      return result;
    }
  }
  const first = {
    type: 'event',
    payload: {
      website: site,
      eventId: randomUUID(),
      url: '/first',
      hostname: 'http.warehouse.invalid',
      language: 'zh-CN',
      screen: '1920x1080',
    },
  };
  const a = await collect(first),
    duplicate = await collect(first);
  assert.equal(duplicate.sessionId, a.sessionId);
  assert.equal(duplicate.visitId, a.visitId);
  await collect({
    type: 'event',
    payload: { ...first.payload, eventId: randomUUID(), url: '/second' },
  });
  await collect({
    type: 'event',
    payload: {
      ...first.payload,
      eventId: randomUUID(),
      name: 'purchase',
      data: { revenue: 2.12345, currency: 'CNY' },
    },
  });
  const conflict = await request('/api/send', {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'event', payload: { ...first.payload, url: '/changed' } }),
  });
  assert.equal(conflict.status, 409);
  const [raw] = await ch
    .query({
      query:
        'SELECT countDistinct(event_id) AS n FROM warehouse_website_event WHERE website_id={site:UUID}',
      query_params: { site },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ n: string }>());
  assert.equal(Number(raw.n), 3);
  for (const table of [
    'website_event',
    'session',
    'event_data',
    'revenue',
    'liekan_event_quality',
    'liekan_collection_receipt',
  ])
    assert.equal(
      (
        await db.read<any>(`SELECT count(*)::text AS n FROM "${table}" WHERE website_id=$1`, [site])
      )[0].n,
      '0',
    );
  cases.push({
    name: 'real browser intake confirms complete CH packages, deduplicates UUID, rejects conflict and leaves PG facts empty',
    status: 'pass',
  });
  const now = Date.now(),
    range = new URLSearchParams({
      startAt: String(now - 3600000),
      endAt: String(now + 60000),
      timezone: 'UTC',
    });
  const path = `/api/websites/${site}/stats?${range}`;
  assert.equal((await request(path)).status, 401);
  const stats = await json(path, 'GET', undefined, owner);
  assert.equal(stats.pageviews, 2);
  cases.push({
    name: 'private overview rejects anonymous access and reads current CH pageviews through the production route',
    status: 'pass',
  });
  const shared = await json(
    '/api/share',
    'POST',
    {
      entityId: site,
      shareType: 1,
      name: 'HTTP acceptance share',
      parameters: { overview: true, compare: true },
    },
    owner,
  );
  const share = await json(`/api/share/${shared.slug}`, 'GET', undefined);
  const shareHeaders = { 'x-umami-share-token': share.token, 'x-umami-share-context': shared.slug };
  assert.equal((await json(path, 'GET', undefined, shareHeaders)).pageviews, 2);
  assert.equal(
    (await request(`/api/websites/${site}`, { method: 'DELETE', headers: shareHeaders })).status,
    401,
  );
  assert.equal(
    (
      await request(`/api/liekan/websites/${site}/exports`, {
        method: 'POST',
        headers: { ...shareHeaders, 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  cases.push({
    name: 'public share reads authorized CH overview but cannot delete the website or create private exports',
    status: 'pass',
  });
  assert.equal((await request('/script.js')).status, 200);
  await json(`/api/websites/${site}`, 'DELETE', undefined, owner);
  assert.equal((await db.read('SELECT 1 FROM website WHERE website_id=$1', [site])).length, 0);
  assert.equal(
    (await db.read<any>('SELECT state FROM liekan_warehouse_site WHERE website_id=$1', [site]))[0]
      .state,
    'deleting',
  );
  cases.push({
    name: 'tracker is served and authenticated website deletion retains a durable CH tombstone',
    status: 'pass',
  });
  if (process.env.WAREHOUSE_HTTP_LOGS === 'true') {
    assert.equal(testPostgresPort, 25479, 'Log fixture uses the isolated Kafka PostgreSQL port');
    await start('log-worker', ['dist/liekan-worker.mjs']);
    await until(
      async () =>
        (
          await db.read(
            "SELECT 1 FROM liekan_worker_state WHERE heartbeat_at>now()-interval '120 seconds'",
          )
        ).length > 0,
      'log worker registered heartbeat',
    );
    const log = await open(`${directory}/http-log-acceptance.log`, 'a', 0o600);
    try {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'tests/liekan/warehouse-log-http.integration.ts'],
        {
          env: {
            ...environment,
            WAREHOUSE_DOCKER_TEST: 'isolated-new-project',
            WAREHOUSE_LOG_HTTP_FRESH_DIRECTORY: directory,
          },
          stdio: ['ignore', log.fd, log.fd],
        },
      );
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(code, 0, 'Real HTTP log upload and CH publication; see private log');
      cases.push({
        name: '10,000 HTTP log records collected and published through Kafka',
        status: 'pass',
      });
    } finally {
      await log.close();
    }
  }
  console.log(
    `PASS ${cases.length} warehouse HTTP cases; pending collection responses ${pendingResponses}`,
  );
} catch (error) {
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
  console.error(error instanceof Error ? error.message : 'HTTP acceptance failed');
  process.exitCode = 1;
} finally {
  for (const child of processes) if (child.exitCode === null) child.kill('SIGTERM');
  for (const child of processes) {
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    await exits.get(child);
    clearTimeout(timer);
  }
  await Promise.allSettled([...logs.map(log => log.close()), db.close(), ch.close()]);
  await writeFile(
    `${directory}/http-report.json`,
    JSON.stringify({ cases, pendingResponses, productionDatabaseTouched: false }, null, 2),
    { mode: 0o600 },
  );
}
