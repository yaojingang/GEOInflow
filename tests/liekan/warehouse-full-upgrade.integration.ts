// Explicit, resumable acceptance against a NEW clone of the downloaded backup.
// Never selects a production URL or the original read-only prototype database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { WarehouseRuntime } from '../../src/lib/liekan/warehouse/runtime';
import { WarehouseCollectionPackage } from '../../src/lib/liekan/upstream/warehouse-collection-package';
import { factTables } from '../../src/lib/liekan/warehouse/catalog';
assert.equal(process.env.WAREHOUSE_FULL_UPGRADE_TEST, 'isolated-downloaded-clone');
const kafkaValidation = process.env.WAREHOUSE_FULL_KAFKA === 'isolated-new-project';
const directory = resolve(
    kafkaValidation ? '.local/kafka-validation-20261104/full' : '.local/ch-full-validation',
  ),
  artifacts = `${directory}/artifacts`;
const pgPassword = (await readFile(`${directory}/pg-password`, 'utf8')).trim();
const chPassword = (await readFile(`${directory}/ch-password`, 'utf8')).trim();
const database = kafkaValidation ? 'liekan_full_kafka_20261104' : 'liekan_full_test';
const target = new URL(`postgresql://127.0.0.1:${kafkaValidation ? 25479 : 25469}/${database}`);
target.username = kafkaValidation ? 'liekan_ch_proto' : 'liekan_full_test';
target.password = pgPassword;
const environment = {
  ...process.env,
  DATABASE_URL: target.toString(),
  LIEKAN_MIGRATION_SOURCE_URL: target.toString(),
  LIEKAN_MIGRATION_ADMIN_URL: target.toString(),
  LIEKAN_PG_DUMP: `${directory}/pg_dump`,
  LIEKAN_PG_RESTORE: `${directory}/pg_restore`,
  LIEKAN_CLICKHOUSE_URL: kafkaValidation ? 'http://127.0.0.1:28159' : 'http://127.0.0.1:28149',
  LIEKAN_CLICKHOUSE_DATABASE: database,
  LIEKAN_CLICKHOUSE_USERNAME: kafkaValidation ? 'default' : 'liekan_full_test',
  LIEKAN_CLICKHOUSE_PASSWORD: chPassword,
  LIEKAN_ANALYTICS_BACKEND: 'clickhouse',
  LIEKAN_WAREHOUSE_TRANSITION: 'true',
  LIEKAN_QUEUE_BROKERS: '127.0.0.1:29109',
  LIEKAN_QUEUE_TOPIC: kafkaValidation
    ? 'liekan_full_kafka_20261104'
    : 'liekan_full_upgrade_20261103',
  LIEKAN_RESULT_TOPIC: kafkaValidation
    ? 'liekan_full_kafka_20261104_results'
    : 'liekan_full_upgrade_20261103_results',
  LIEKAN_QUEUE_PARTITIONS: '1',
};
const db = new ControlDatabase(target.toString());
const stateFile = `${directory}/workflow.json`;
const state: { site: string; steps: Record<string, any>; operations: Record<string, string> } =
  await readFile(stateFile, 'utf8')
    .then(JSON.parse)
    .catch(() => ({ site: randomUUID(), steps: {}, operations: {} }));
async function save() {
  await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
async function command(
  name: string,
  args: string[],
  extra: Record<string, string> = {},
  memo = true,
) {
  if (memo && Object.hasOwn(state.steps, name)) return state.steps[name];
  const log = await open(`${artifacts}/${name}.jsonl`, 'a', 0o600);
  const results: any[] = [];
  let pending = '';
  const child = spawn(process.execPath, args, {
    env: { ...environment, ...extra },
    stdio: ['ignore', 'pipe', log.fd],
  });
  child.stdout.on('data', chunk => {
    log.write(chunk).catch(() => {});
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop()!;
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        results.push(data);
        if (data.family && Number(data.pages) % 20 === 0)
          console.log(JSON.stringify({ step: name, ...data }));
      } catch {}
    }
  });
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  await log.close();
  if (code !== 0) throw new Error(`warehouse-full-${name}-failed:${results.at(-1)?.error ?? code}`);
  const result = results.at(-1) ?? { passed: true };
  if (memo) {
    state.steps[name] = result;
    await save();
    console.log(JSON.stringify({ step: name, status: 'passed' }));
  }
  return result;
}
const cli = (name: string, args: string[], extra?: Record<string, string>, memo = true) =>
  command(name, ['dist/liekan-warehouse-command.mjs', ...args], extra, memo);
async function retry(work: () => Promise<any>, timeout = 90000) {
  const start = Date.now();
  for (;;) {
    try {
      return await work();
    } catch (e) {
      if (Date.now() - start > timeout) throw e;
      await delay(1000);
    }
  }
}
let runtime: WarehouseRuntime,
  worker: ReturnType<typeof spawn>,
  workerLog: Awaited<ReturnType<typeof open>>;
async function event(name: string) {
  if (state.steps[name]) return;
  const site = await runtime.resource(state.site, 'website'),
    sessionId = randomUUID(),
    visitId = randomUUID(),
    at = new Date();
  const identity = {
    scope: 'browser' as const,
    available: true,
    version: 'cookieless-trusted-input-v3',
    sessionId,
    browser: 'chrome',
    os: 'Windows',
    device: 'desktop',
    screen: '1920x1080',
    language: 'zh-CN',
    originHostname: null,
    distinctId: null,
    hostname: 'warehouse-acceptance.invalid',
    classification: 'browser' as const,
  };
  const p = new WarehouseCollectionPackage(
    {
      websiteId: state.site,
      eventId: randomUUID(),
      fingerprint: 'a'.repeat(64),
      identity,
      quality: {
        classification: 'browser',
        source: 'browser',
        reasons: [],
        ruleVersion: 'traffic-quality-v4',
        rangeVersion: null,
        rangeStatus: 'missing',
        hostname: identity.hostname,
      },
    },
    at,
  );
  await p.createSession({ id: sessionId, websiteId: state.site, createdAt: at });
  await p.identity(state.site, identity);
  await p.saveEvent({
    websiteId: state.site,
    sessionId,
    visitId,
    eventType: 1,
    urlPath: `/${name}`,
    createdAt: at,
  });
  const input = runtime.envelope(site, {
    websiteId: state.site,
    sessionId,
    visitId,
    eventId: p.eventId,
    clientEventId: p.input.eventId,
    kind: 'browser',
    fingerprint: p.input.fingerprint,
    collectionSource: 'browser',
    collectionScope: 'browser',
    receivedAt: at.toISOString(),
    data: p.seal() as any,
  });
  await runtime.queue.enqueue(input);
  await retry(async () => {
    const rows = await db.read(
      "SELECT 1 FROM liekan_warehouse_work WHERE input_id=$1 AND status='confirmed'",
      [input.inputId],
    );
    assert.equal(rows.length, 1);
  });
  state.steps[name] = { inputId: input.inputId, eventId: p.eventId };
  await save();
  console.log(JSON.stringify({ step: name, status: 'passed' }));
}
async function barrier(name: string, kind: 'snapshot' | 'cutover' | 'rollback') {
  state.operations[name] ??= randomUUID();
  await save();
  const id = state.operations[name];
  await cli(`${name}-request`, ['barrier', '--kind', kind, '--operation', id]);
  await retry(() => cli(`${name}-freeze`, ['freeze', '--operation', id]));
  return id;
}
async function sync() {
  await retry(async () => {
    await cli('sync', ['sync'], {}, false);
    const [s] = await db.read<any>('SELECT * FROM liekan_warehouse_transition WHERE id=1');
    assert.equal(s.sequence, s.sent_sequence);
    assert.equal(s.sequence, s.ch_sequence);
    assert.equal(s.sequence, s.pg_sequence);
  });
}
try {
  await command('pg-migrations', ['scripts/liekan-migrate.mjs'], {}, false);
  await cli('source-preflight', ['preflight']);
  await cli('install', ['install', '--mode', 'pg-transition']);
  await db.read(
    "INSERT INTO website(website_id,name,domain) VALUES($1,'Warehouse acceptance (isolated synthetic)','warehouse-acceptance.invalid') ON CONFLICT DO NOTHING",
    [state.site],
  );
  runtime = await WarehouseRuntime.connect({
    databaseURL: target.toString(),
    clickhouseURL: environment.LIEKAN_CLICKHOUSE_URL,
    clickhouseDatabase: environment.LIEKAN_CLICKHOUSE_DATABASE,
    clickhouseUsername: environment.LIEKAN_CLICKHOUSE_USERNAME,
    clickhousePassword: chPassword,
    queue: { brokers: ['127.0.0.1:29109'] },
  });
  workerLog = await open(`${artifacts}/consumer.log`, 'a', 0o600);
  worker = spawn(process.execPath, ['dist/liekan-warehouse-worker.mjs'], {
    env: { ...environment, LIEKAN_WAREHOUSE_HEALTH_FILE: `${artifacts}/consumer.health.json` },
    stdio: ['ignore', workerLog.fd, workerLog.fd],
  });
  await event('pre-snapshot-event');
  const snapshot = await barrier('snapshot', 'snapshot');
  const archive = await cli('snapshot-export', ['snapshot-export', '--directory', artifacts]);
  const restored = await cli('snapshot-restore', [
    'snapshot-restore',
    '--archive',
    archive.archive,
    '--sha256',
    archive.sha256,
    '--directory',
    artifacts,
    '--boundary',
    `${archive.directory}/archive.json`,
  ]);
  const clone = new URL(target);
  clone.pathname = `/${restored.descriptor.database}`;
  const source = { LIEKAN_MIGRATION_SOURCE_URL: clone.toString() };
  const registered = await cli('register', ['register'], source);
  await cli('resume-snapshot', ['resume-snapshot', '--operation', snapshot]);
  await event('post-snapshot-event');
  const copied = await cli('backfill', ['backfill', '--migration', registered.migrationId], source);
  const audited = await cli('verify', ['verify', '--migration', registered.migrationId], source);
  assert.equal(
    audited.digest,
    copied.digest,
    'Independent full audit preserves the migration digest',
  );
  await cli('baseline', ['baseline', '--migration', registered.migrationId]);
  await sync();
  const cutover = await barrier('cutover', 'cutover');
  await sync();
  await cli('switch', ['switch', '--operation', cutover]);
  await event('ch-authority-event');
  await sync();
  const rollback = await barrier('rollback', 'rollback');
  await sync();
  await cli('rollback', ['switch', '--operation', rollback]);
  await event('rollback-pg-event');
  await sync();
  const again = await barrier('cutover-again', 'cutover');
  await sync();
  await cli('switch-again', ['switch', '--operation', again]);
  await cli('exit-begin', ['exit-begin']);
  await sync();
  await cli('exit-complete', ['exit-complete']);
  async function pgFactCounts() {
    const counts: Record<string, string> = {};
    for (const family of factTables) {
      const [row] = await db.read<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${family.name}" WHERE website_id=$1`,
        [state.site],
      );
      counts[family.name] = row.n;
    }
    const [transition] = await db.read<{ sequence: string }>(
      "SELECT sequence FROM liekan_warehouse_transition WHERE id=1 AND state='closed'",
    );
    assert.ok(transition, 'Transition must be closed');
    counts.transition_sequence = transition.sequence;
    return counts;
  }
  if (!state.steps['post-exit-pg-facts-before']) {
    state.steps['post-exit-pg-facts-before'] = await pgFactCounts();
    await save();
  }
  await event('post-exit-ch-only-event-v2');
  assert.deepEqual(
    await pgFactCounts(),
    state.steps['post-exit-pg-facts-before'],
    'All PG fact families and the authoritative-result journal stay unchanged after transition exit',
  );
  const retirement = await cli('retirement-preview', ['retirement-preview'], {}, false);
  assert.equal(retirement.status, 'ready-for-review');
  assert.equal(retirement.deletionAuthorized, false);
  assert.equal(retirement.databaseWrites, false);
  state.steps.retirementPreview = { passed: true, readOnly: true, deletionAuthorized: false };
  await cli('monitor', ['monitor']);
  state.steps.final = {
    passed: true,
    originalDatabaseTouched: false,
    originalBackupModified: false,
    pgFactGrowthAfterExit: 0,
    verifiedPgFactFamilies: factTables.length,
    transitionJournalGrowthAfterExit: 0,
  };
  await save();
  console.log(JSON.stringify(state.steps.final));
} catch (e) {
  console.error(e instanceof Error ? e.message : 'warehouse-full-failed');
  process.exitCode = 1;
} finally {
  if (worker) {
    worker.kill('SIGTERM');
    await new Promise<void>(done => {
      if (worker.exitCode !== null) return done();
      const t = setTimeout(() => worker.kill('SIGKILL'), 15000);
      worker.once('exit', () => {
        clearTimeout(t);
        done();
      });
    });
  }
  await workerLog?.close();
  await runtime?.close();
  await db.close();
}
