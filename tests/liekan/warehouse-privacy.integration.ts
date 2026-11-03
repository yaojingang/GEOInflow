// Real production HTTP + built tracker + durable broker + compiled consumer + CH/export.
// First run warehouse-fresh.integration.ts install into a NEW .local directory.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { Kafka, logLevel } from 'kafkajs';
import Papa from 'papaparse';
import { EVENT_TYPE } from '../../src/lib/constants';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { boundaryParameters, factRelation } from '../../src/lib/liekan/warehouse/read';
import { testClickHouseURL } from './warehouse-test-target';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const directory = resolve(
  process.env.WAREHOUSE_FRESH_DIRECTORY ?? '.local/ch-privacy-integration/fresh',
);
assert.ok(directory.startsWith(`${resolve('.local')}/`));
const state = JSON.parse(await readFile(`${directory}/state.json`, 'utf8'));
assert.match(state.run, /^warehouse_fresh_\d+$/);
assert.ok(state.steps.install?.passed);
const target = new URL(`postgresql://127.0.0.1:25459/${state.run}`);
target.username = 'liekan_ch_proto';
target.password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const db = new ControlDatabase(target.toString());
const ch = createWarehouseClient({ url: testClickHouseURL, database: state.run });
const kafka = new Kafka({ brokers: ['127.0.0.1:29109'], logLevel: logLevel.NOTHING });
const observer = kafka.consumer({
  groupId: `privacy-observer-${randomUUID()}`,
  allowAutoTopicCreation: false,
});
const broker = kafka.admin();
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  DATABASE_URL: target.toString(),
  DIRECT_DATABASE_URL: target.toString(),
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
  LIEKAN_QUEUE_TOPIC: state.run,
  LIEKAN_RESULT_TOPIC: `${state.run}_results`,
  LIEKAN_QUEUE_PARTITIONS: '1',
  CLIENT_IP_HEADER: 'x-liekan-test-client-ip',
  REDIS_URL: '',
  LIEKAN_ANALYTICS_REDIS_URL: '',
  LIEKAN_SEED_DEMO: 'false',
  LIEKAN_AI_ENABLED: 'false',
  CLOUD_MODE: '',
  LIEKAN_EXPORT_DIRECTORY: `${directory}/privacy-exports`,
  LIEKAN_WAREHOUSE_HEALTH_FILE: `${directory}/privacy-worker.health.json`,
};
const base = 'http://127.0.0.1:23833';
const cases: object[] = [],
  processes: ChildProcess[] = [];
const logs: Awaited<ReturnType<typeof open>>[] = [];
const exited: Promise<void>[] = [];
const site = randomUUID(),
  seen = new Map<string, any>();
let token = '',
  cache = '',
  browser: JSDOM | undefined,
  observerError: unknown;
const ordinary = [
  '/articles/11111111-1111-4111-8111-111111111111',
  '/articles/22222222-2222-4222-8222-222222222222',
  '/articles/deadbeef1234567890',
  '/articles/cafefeed1234567890',
  '/docs/code/examples',
  '/docs/code/reference',
];
const secrets = [
  'privacy-url-one',
  'privacy-url-two',
  'privacy-query',
  'privacy-referrer',
  'privacy-performance',
  'privacy-replay',
  'privacy-dom',
  'privacy-heatmap',
];
function clean(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets)
    assert.ok(!text.includes(secret), 'synthetic secret must be absent');
}
function replay(value: string) {
  return JSON.parse(gunzipSync(Buffer.from(value, 'hex')).toString());
}
async function start(name: string, args: string[]) {
  const log = await open(`${directory}/privacy-${name}.log`, 'a', 0o600);
  logs.push(log);
  const child = spawn(process.execPath, args, {
    env: environment,
    stdio: ['ignore', log.fd, log.fd],
  });
  processes.push(child);
  exited.push(
    new Promise(done => {
      child.once('exit', () => done());
      child.once('error', () => done());
    }),
  );
}
async function until(work: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (processes.some(p => p.exitCode !== null))
      throw new Error(`Fixture process exited: ${label}`);
    if (observerError) throw observerError;
    if (await work()) return;
    await delay(250);
  }
  throw new Error(`Fixture timed out: ${label}`);
}
async function request(path: string, body?: object, authenticated = true, extra = {}) {
  return fetch(base + path, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(65000),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
      'X-Liekan-Test-Client-IP': '192.0.2.27',
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function json(path: string, body?: object, authenticated = true, extra = {}) {
  const response = await request(path, body, authenticated, extra);
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  return response.json();
}
async function facts(family: string): Promise<any[]> {
  const [b] = await db.read<any>(
    'SELECT epoch,publication,deletion_revision FROM liekan_warehouse_site WHERE website_id=$1',
    [site],
  );
  return ch
    .query({
      query: `SELECT * FROM ${factRelation(family)}`,
      query_params: boundaryParameters({
        websiteId: site,
        epoch: b.epoch,
        publication: b.publication,
        deletionRevision: b.deletion_revision,
      }),
      format: 'JSONEachRow',
    })
    .then(r => r.json<any>());
}
try {
  await start('app', [
    'node_modules/next/dist/bin/next',
    'start',
    '-H',
    '127.0.0.1',
    '-p',
    '23833',
  ]);
  await start('consumer', ['dist/liekan-warehouse-worker.mjs']);
  await until(
    async () => (await request('/api/heartbeat').catch(() => null))?.ok === true,
    'app startup',
  );
  await until(async () => {
    const health = await readFile(environment.LIEKAN_WAREHOUSE_HEALTH_FILE, 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    return health?.healthy && Date.now() - Date.parse(health.at) < 60000;
  }, 'compiled consumer startup');
  token = (
    await json(
      '/api/auth/login',
      { username: 'isolated-customized-admin', password: 'isolated-customized-password' },
      false,
    )
  ).token;
  assert.ok(token);
  await json('/api/websites', {
    id: site,
    name: 'Privacy acceptance (isolated synthetic)',
    domain: 'privacy.fixture.invalid',
  });
  await json(`/api/websites/${site}`, {
    replayConfig: {
      replayEnabled: true,
      heatmapEnabled: true,
      sampleRate: 1,
      heatmapSampleRate: 1,
    },
  });
  await broker.connect();
  observer.on(observer.events.CRASH, e => {
    observerError = e.payload.error;
  });
  await observer.connect();
  await observer.subscribe({ topic: state.run, fromBeginning: true });
  await observer.run({
    autoCommit: false,
    eachMessage: async ({ partition, message }) => {
      assert.ok(message.value);
      seen.set(`${partition}:${message.offset}`, JSON.parse(message.value.toString()));
    },
  });

  const collect = (url: string, extra = {}, type = 'event') =>
    json(
      '/api/send',
      {
        type,
        payload: {
          website: site,
          eventId: randomUUID(),
          hostname: 'privacy.fixture.invalid',
          url,
          language: 'zh-CN',
          screen: '1920x1080',
          ...extra,
        },
      },
      false,
    );
  // Execute the actual Rollup artifact, then forward its output to the real API.
  browser = new JSDOM('<!doctype html><title>Fixture</title>', {
    url: 'https://privacy.fixture.invalid/',
    runScripts: 'outside-only',
  });
  const window = browser.window;
  const script = window.document.createElement('script');
  script.src = `${base}/script.js`;
  script.dataset.websiteId = site;
  script.dataset.autoTrack = 'false';
  Object.defineProperty(window.document, 'currentScript', { value: script });
  const outbound: any[] = [];
  const browserResponses: { status: number; data: any }[] = [];
  window.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    outbound.push(body);
    const response = await request('/api/send', body, false);
    browserResponses.push({ status: response.status, data: await response.clone().json() });
    return response;
  }) as any;
  window.eval(await readFile('public/script.js', 'utf8'));
  for (const url of ordinary.slice(0, 2))
    await (window as any).umami.track({ website: site, hostname: 'privacy.fixture.invalid', url });
  assert.deepEqual(
    outbound.map(body => new URL(body.payload.url, 'https://privacy.fixture.invalid').pathname),
    ordinary.slice(0, 2),
  );
  for (const url of ordinary.slice(2)) await collect(url);
  const firstSecret = {
    type: 'event',
    payload: {
      website: site,
      eventId: randomUUID(),
      hostname: 'privacy.fixture.invalid',
      url: '/reset/privacy-url-one?token=privacy-query&utm_source=fixture',
      referrer: 'https://referrer.invalid/invite/privacy-referrer',
      language: 'zh-CN',
      screen: '1920x1080',
    },
  };
  const first = await json('/api/send', firstSecret, false);
  cache = first.cache;
  const repeat = await json('/api/send', firstSecret, false);
  assert.equal(first.sessionId, repeat.sessionId);
  await (window as any).umami.track({
    website: site,
    hostname: 'privacy.fixture.invalid',
    url: '/reset/privacy-url-two',
    referrer: 'https://referrer.invalid/invite/privacy-referrer',
  });
  assert.equal(browserResponses.length, 3);
  for (const response of browserResponses) {
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.ok(response.data.cache);
  }
  clean(outbound);
  assert.equal(outbound[2].payload.url, '/reset/[redacted]');
  await collect('/reset/privacy-performance', { lcp: 123 }, 'performance');
  assert.ok(cache);
  cases.push({
    name: 'built tracker and direct event/performance HTTP collection; stable ordinary IDs and idempotent retry',
    passed: true,
  });
  const malformed = await request(
    '/api/send',
    {
      type: 'event',
      payload: { website: site, url: 'https://[invalid/reset/privacy-malformed' },
    },
    false,
  );
  assert.equal(malformed.status, 400);
  assert.ok(!(await malformed.text()).includes('privacy-malformed'));
  const invalidBase = await request(
    '/api/send',
    {
      type: 'event',
      payload: { website: site, hostname: '[invalid', url: '/reset/privacy-malformed' },
    },
    false,
  );
  assert.equal(invalidBase.status, 500);
  assert.ok(!(await invalidBase.text()).includes('privacy-malformed'));
  const diagnostics = await readFile(`${directory}/privacy-app.log`, 'utf8');
  assert.ok(diagnostics.includes('Invalid collection URL'));
  assert.ok(!diagnostics.includes('privacy-malformed'));

  const timestamp = Date.now();
  await json(
    '/api/record',
    {
      type: 'record',
      payload: {
        website: site,
        timestamp: Math.floor(timestamp / 1000),
        events: [
          {
            type: 4,
            timestamp,
            data: {
              href: 'https://privacy.fixture.invalid/reset/privacy-replay',
              width: 800,
              height: 600,
            },
          },
          {
            type: 2,
            timestamp,
            data: {
              node: {
                id: 1,
                type: 2,
                tagName: 'a',
                attributes: { href: '/token/privacy-dom' },
                childNodes: [],
              },
            },
          },
          ...ordinary.slice(0, 2).map((url, i) => ({
            type: 5,
            timestamp: timestamp + i + 1,
            data: { tag: 'url-change', payload: { url } },
          })),
        ],
      },
    },
    false,
    { 'x-umami-cache': cache },
  );
  await json(
    '/api/record',
    {
      type: 'heatmap',
      payload: {
        website: site,
        events: [...ordinary.slice(0, 2), '/reset/privacy-heatmap'].map((url, index) => ({
          type: 'click',
          url,
          x: 0.5,
          y: 0.25,
          pageX: 40 + index,
          pageY: 60,
          pageW: 800,
          pageH: 600,
          viewportW: 800,
          viewportH: 600,
          timestamp,
        })),
      },
    },
    false,
    { 'x-umami-cache': cache },
  );

  const ends = await broker.fetchTopicOffsets(state.run);
  await until(
    async () =>
      ends.every(
        end =>
          [...seen.keys()].filter(k => k.startsWith(`${end.partition}:`)).length ===
          Number(end.offset),
      ),
    'read all durable messages',
  );
  const envelopes = [...seen.values()].filter(e => e.websiteId === site);
  assert.ok(envelopes.length >= 11, 'non-empty durable collection evidence');
  for (const envelope of envelopes) {
    clean(envelope);
    for (const fact of envelope.data.facts)
      if (fact.family === 'session_replay') clean(replay(fact.row.events));
  }
  assert.deepEqual([...new Set(envelopes.map(e => e.kind))].sort(), [
    'browser',
    'heatmap',
    'replay',
  ]);
  cases.push({
    name: 'independent Kafka consumer inspects durable envelopes and decompresses recorder data; no synthetic secrets',
    passed: true,
  });

  const events = await facts('website_event'),
    heatmaps = await facts('heatmap_event'),
    recordings = await facts('session_replay');
  assert.equal(events.length, 9);
  clean(events);
  clean(heatmaps);
  const views = events.filter(e => Number(e.event_type) === 1);
  assert.equal(views.length, 8);
  for (const path of ordinary) assert.equal(views.filter(e => e.url_path === path).length, 1);
  assert.equal(views.filter(e => e.url_path === '/reset/[redacted]').length, 2);
  assert.equal(
    events.find(e => Number(e.event_type) === EVENT_TYPE.performance)?.url_path,
    '/reset/[redacted]',
  );
  assert.equal(heatmaps.length, 3);
  assert.deepEqual(
    heatmaps.map(e => e.url_path).sort(),
    [...ordinary.slice(0, 2), '/reset/[redacted]'].sort(),
  );
  assert.equal(recordings.length, 1);
  const recorded = replay(recordings[0].events);
  clean(recorded);
  assert.equal(recorded[0].data.href, 'https://privacy.fixture.invalid/reset/[redacted]');
  assert.deepEqual(
    recorded.slice(2).map((e: any) => e.data.payload.url),
    ordinary.slice(0, 2),
  );
  for (const family of ['website_event', 'heatmap_event', 'session_replay'])
    assert.equal(
      (
        await db.read<any>(`SELECT count(*)::int AS n FROM ${family} WHERE website_id=$1`, [site])
      )[0].n,
      0,
    );
  cases.push({
    name: 'accepted CH facts preserve six ordinary page identities, two redacted PVs, performance, distinct heatmaps and replay; PG facts zero',
    passed: true,
  });

  for (const locale of ['zh-CN', 'en-US']) {
    const response = await request(`/api/liekan/websites/${site}/exports`, {
      startAt: timestamp - 86400000,
      endAt: Date.now() + 1000,
      timezone: 'UTC',
      format: 'zip',
      sections: ['dimensions'],
      filters: {},
      locale,
    });
    assert.equal(response.status, 200);
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(frames.at(-1).type, 'complete');
    const file = frames.find(f => f.type === 'file');
    assert.ok(file?.downloadUrl);
    const location = new URL(file.downloadUrl, base);
    assert.equal(location.origin, base);
    const download = await request(location.pathname + location.search);
    assert.equal(download.status, 200);
    const zip = await JSZip.loadAsync(Buffer.from(await download.arrayBuffer()));
    for (const entry of Object.values(zip.files))
      if (!entry.dir) clean(await entry.async('string'));
    const pagesFile = zip.file('pages.csv');
    assert.ok(pagesFile);
    const csv = await pagesFile.async('string');
    const rows = Papa.parse(csv, {
      header: true,
      skipEmptyLines: true,
    }).data as Record<string, string>[];
    const name = locale === 'en-US' ? 'Page' : 'name';
    assert.deepEqual(rows.map(row => row[name]).sort(), [...ordinary, '/reset/[redacted]'].sort());
    const columns = Object.keys(rows[0]);
    // This synthetic fixture has one visitor; the last numeric column is views.
    const redactedPage = rows.find(row => row[name] === '/reset/[redacted]');
    const viewsColumn = columns.at(-1);
    assert.ok(redactedPage && viewsColumn);
    assert.equal(Number(redactedPage[viewsColumn]), 2);
  }
  cases.push({
    name: 'authorized HTTP export/download in both locales keeps ordinary pages distinct and excludes secrets in every ZIP entry',
    passed: true,
  });
  console.log(`PASS ${cases.length} warehouse privacy end-to-end cases`);
} catch (error) {
  cases.push({ passed: false, error: error instanceof Error ? error.message : 'unknown' });
  console.error(error instanceof Error ? error.stack : 'Privacy validation failed');
  process.exitCode = 1;
} finally {
  browser?.window.close();
  await Promise.allSettled([observer.disconnect(), broker.disconnect()]);
  for (const child of processes) child.kill('SIGTERM');
  const timer = setTimeout(() => {
    for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL');
  }, 15000);
  await Promise.all(exited);
  clearTimeout(timer);
  await Promise.all(logs.map(log => log.close()));
  await Promise.all([db.close(), ch.close()]);
  await writeFile(
    `${directory}/privacy-result.json`,
    JSON.stringify({ database: state.run, site, cases }, null, 2),
    { mode: 0o600 },
  );
}
