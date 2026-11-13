import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Prototype, PROJECT, OUTPUT, ROUND2, delay, digest, type Event } from './core.ts';

const exec = promisify(execFile);
const compose = [
  'compose',
  '--env-file',
  '/dev/null',
  '-p',
  PROJECT,
  '-f',
  ROUND2 ? 'experiments/ch-prototype/compose-round2.yaml' : 'experiments/ch-prototype/compose.yaml',
];
const docker = async (...args: string[]) =>
  (await exec('docker', args, { maxBuffer: 2e6, timeout: 45000 })).stdout.trim();
const run = `proto_${Date.now()}_${randomUUID().slice(0, 8)}`;
const p = new Prototype(run);
const report: any = {
  run,
  started: new Date().toISOString(),
  scope: 'isolated synthetic protocol prototype',
  tests: [],
  faults: [],
  limitations: [
    'Process crashes and network loss only; no power-loss, disk-loss or multi-node availability proof.',
    'Bounded input replay and full publication manifests are protocol scaffolding, not production scale implementations.',
    'No production routes, quality policy, historical clone migration, real GEO counters or UI are integrated.',
  ],
};
const backupSamples: Event[] = ROUND2
  ? JSON.parse(await readFile(resolve(OUTPUT, 'protocol-samples.json'), 'utf8'))
  : [];
const ledger: Event[] = [];
const submissions: any[] = [];
const expectations: any[] = [];
const enqueue = p.enqueue.bind(p);
p.enqueue = async entries => {
  const submission = { inputs: structuredClone(entries), status: 'attempted' };
  submissions.push(submission);
  try {
    const result = await enqueue(entries);
    submission.status = 'acknowledged';
    return result;
  } catch (error) {
    submission.status = 'uncertain-or-rejected';
    throw error;
  }
};
let serial = 0;
function event(site: string, session = 'session', extra: Partial<Event> = {}): Event {
  const e: Event = {
    id: `${run}_${++serial}`,
    site,
    session,
    visit: `visit_${session}`,
    uuid: `uuid_${serial}`,
    path: ROUND2 ? backupSamples[serial % backupSamples.length].path : `/synthetic/${serial}`,
    cents: serial * 7,
    properties: { fixture: 'synthetic-only' },
    kind: 'browser',
    ...extra,
  };
  ledger.push(e);
  return e;
}
const expected = (events: Event[]) => ({
  ids: events.map(e => e.id).sort(),
  cents: events.reduce((n, e) => n + e.cents, 0),
  properties: events.reduce((n, e) => n + Object.keys(e.properties).length, 0),
});
async function check(site: string, events: Event[]) {
  const value = expected(events);
  expectations.push({ site, expected: value });
  assert.deepEqual(await p.totals(site), value);
}
async function step(name: string, reference: number[], work: () => Promise<any>) {
  const selected = process.env.PROTO_CASES?.split(',');
  if (selected && !selected.some(part => name.includes(part))) {
    report.tests.push({ name, reference, status: 'not-run' });
    return;
  }
  console.log(`RUN ${name}`);
  const start = performance.now();
  try {
    const details = await work();
    report.tests.push({
      name,
      reference,
      status: 'pass',
      ms: Math.round(performance.now() - start),
      details,
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.tests.push({
      name,
      reference,
      status: 'fail',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await save();
  }
}
async function save() {
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(resolve(OUTPUT, `${run}-report.json`), JSON.stringify(report, null, 2));
  await writeFile(
    resolve(OUTPUT, `${run}-inputs.json`),
    JSON.stringify({ seed: 20261027, generated: ledger, submissions, expectations }, null, 2),
  );
}
async function service(name: string) {
  assert.ok(['pg', 'control', 'ch', 'redpanda'].includes(name));
  const id = await docker(...compose, 'ps', '-q', name);
  assert.ok(id);
  const [info] = JSON.parse(await docker('inspect', id));
  assert.equal(info.Config.Labels['com.docker.compose.project'], PROJECT);
  for (const mount of info.Mounts)
    if (mount.Type === 'volume') assert.ok(mount.Name.startsWith(`${PROJECT}_`));
  for (const bindings of Object.values(info.HostConfig.PortBindings ?? {}) as any[]) {
    for (const binding of bindings ?? []) assert.equal(binding.HostIp, '127.0.0.1');
  }
  return id;
}
async function actorCrash(command: string, point: string, arg?: string) {
  const marker = resolve(OUTPUT, `fault-${point}.json`);
  await rm(marker, { force: true });
  if (ROUND2) {
    const child = spawn(
      process.execPath,
      [
        '--import',
        resolve('experiments/ch-prototype/node_modules/tsx/dist/loader.mjs'),
        'experiments/ch-prototype/actor.ts',
        run,
        command,
        ...(arg ? [arg] : []),
      ],
      {
        env: { ...process.env, PROTO_FAULT: point },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let error = '';
    child.stderr.on('data', b => {
      error += b.toString();
    });
    const ended = new Promise<{ code: number | null; signal: string | null }>(r =>
      child.once('exit', (code, signal) => r({ code, signal })),
    );
    try {
      let reached = false;
      for (let i = 0; i < 300; i++) {
        reached = await readFile(marker, 'utf8').then(
          s => JSON.parse(s).reached === true,
          () => false,
        );
        if (reached) break;
        if (child.exitCode !== null) throw new Error(error || 'actor exited before fault');
        await delay(200);
      }
      assert.ok(reached, `actor did not reach ${point}`);
      child.kill('SIGKILL');
      assert.equal((await ended).signal, 'SIGKILL');
      report.faults.push({ point, command, termination: 'OS SIGKILL', signal: 'SIGKILL' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    return;
  }
  const name = `${PROJECT}_actor_${++serial}`;
  await docker(
    ...compose,
    'run',
    '-d',
    '--name',
    name,
    '-e',
    `PROTO_FAULT=${point}`,
    'actor',
    'node',
    '--experimental-transform-types',
    'experiments/ch-prototype/actor.ts',
    run,
    command,
    ...(arg ? [arg] : []),
  );
  let reached = false;
  try {
    for (let i = 0; i < 180; i++) {
      try {
        reached = JSON.parse(await readFile(marker, 'utf8')).reached === true;
      } catch {}
      if (reached) break;
      const [state] = JSON.parse(await docker('inspect', name));
      if (!state.State.Running)
        throw new Error(
          `actor exited before ${point}: ${await docker('logs', '--tail', '8', name)}`,
        );
      await delay(200);
    }
    assert.ok(reached, `actor did not reach ${point}`);
    assert.equal(
      JSON.parse(await docker('inspect', name))[0].Config.Labels['com.docker.compose.project'],
      PROJECT,
    );
    await docker('kill', '-s', 'KILL', name);
    const [state] = JSON.parse(await docker('inspect', name));
    assert.equal(state.State.ExitCode, 137);
    report.faults.push({
      point,
      command,
      termination: 'docker SIGKILL',
      exitCode: state.State.ExitCode,
    });
  } finally {
    await docker('rm', '-f', name);
  }
}
async function healthy(name: string) {
  for (let i = 0; i < 60; i++) {
    const id = await docker(...compose, 'ps', '-q', name);
    if (id) {
      const [state] = JSON.parse(await docker('inspect', id));
      if (state.State.Health?.Status === 'healthy') return;
    }
    await delay(500);
  }
  throw new Error(`${name} did not recover`);
}
async function cycle() {
  await p.process(await p.claim());
  await p.derive();
}

try {
  await mkdir(OUTPUT, { recursive: true });
  report.environment = {};
  for (const name of ROUND2 ? ['pg', 'control', 'ch', 'redpanda'] : ['pg', 'ch', 'redpanda']) {
    const id = await service(name),
      [state] = JSON.parse(await docker('inspect', id));
    report.environment[name] = {
      image: state.Config.Image,
      imageId: state.Image,
      mounts: state.Mounts.filter((m: any) => m.Type === 'volume').map((m: any) => m.Name),
      ports: state.HostConfig.PortBindings,
    };
  }
  await docker(
    ...compose,
    'exec',
    '-T',
    'redpanda',
    'rpk',
    'cluster',
    'config',
    'set',
    'write_caching_default',
    'disabled',
  );
  await docker(
    ...compose,
    'exec',
    '-T',
    'redpanda',
    'rpk',
    'cluster',
    'config',
    'set',
    'auto_create_topics_enabled',
    'false',
  );
  const writeCache = await docker(
    ...compose,
    'exec',
    '-T',
    'redpanda',
    'rpk',
    'cluster',
    'config',
    'get',
    'write_caching_default',
  );
  assert.match(writeCache, /disabled/);
  report.environment.writeCaching = writeCache;
  report.environment.autoCreateTopics = await docker(
    ...compose,
    'exec',
    '-T',
    'redpanda',
    'rpk',
    'cluster',
    'config',
    'get',
    'auto_create_topics_enabled',
  );
  assert.equal(report.environment.autoCreateTopics, 'false');
  report.environment.redpandaCommand = JSON.parse(
    await docker('inspect', await service('redpanda')),
  )[0].Config.Cmd;
  await p.connect();
  await p.setup();
  const topicDescription = await docker(
    ...compose,
    'exec',
    '-T',
    'redpanda',
    'rpk',
    'topic',
    'describe',
    p.inputTopic,
    '--format',
    'json',
  );
  report.environment.inputTopic = JSON.parse(topicDescription);
  // KafkaJS/rpk do not expose the broker topic ID here. Do not mislabel a name as an ID.
  report.environment.topicIdentityValidation = ROUND2
    ? 'Broker UUID registered in PG and rechecked on processing/deletion/acceptance.'
    : 'Unique names only; first-round metadata probe was separate.';
  if (!ROUND2) report.limitations.push('First-round mode does not validate broker topic identity.');
  report.environment.chVersion = (await p.rows('SELECT version() version'))[0].version;
  report.environment.pgVersion = (await p.pool.query('SHOW server_version')).rows[0].server_version;
  report.environment.schemas = {};
  for (const table of ['landing', 'events', 'properties', 'revenue', 'manifest']) {
    const create = await p.rows(`SHOW CREATE TABLE liekan_ch_proto.${table}`);
    assert.match(create[0].statement, /fsync_after_insert = 1/);
    assert.match(create[0].statement, /fsync_part_directory = 1/);
    report.environment.schemas[table] = digest(create[0].statement);
  }

  await step('UUID、内容冲突、无 UUID 与批内去重', [1, 24], async () => {
    await p.addSites('synthetic_identity');
    const a = event('synthetic_identity'),
      b = event('synthetic_identity', 's2', { uuid: undefined });
    const duplicate = event(a.site, 'other_session', { ...a, id: `${a.id}_retry` });
    const conflict = event(a.site, a.session, { ...a, id: `${a.id}_conflict`, cents: a.cents + 1 });
    await p.enqueue([a, duplicate, conflict, b].map(event => ({ event, partition: 0 })));
    await cycle();
    await check(a.site, [a, b]);
    const verdicts = await p.rows(
      'SELECT event_id,verdict,original_session,original_visit FROM liekan_ch_proto.landing WHERE run={run:String} AND site={site:String}',
      { run, site: a.site },
    );
    assert.equal(verdicts.find(r => r.event_id === duplicate.id)?.verdict, 'duplicate');
    assert.equal(verdicts.find(r => r.event_id === conflict.id)?.verdict, 'conflict');
    assert.equal(verdicts.find(r => r.event_id === duplicate.id)?.original_visit, a.visit);
    const b2 = event(b.site, b.session, { uuid: undefined });
    await p.enqueue([{ event: b2, partition: 0 }]);
    await cycle();
    await check(a.site, [a, b, b2]);
    return { input: 5, visible: 3, conflicts: 1 };
  });

  await step('落地后进程死亡、所有者接管与重试', [3, 4], async () => {
    await p.addSites('synthetic_landing');
    const e = event('synthetic_landing');
    await p.enqueue([{ event: e, partition: 1 }]);
    await actorCrash('process', 'after_landing');
    assert.equal((await p.visible(e.site)).length, 0);
    await cycle();
    await check(e.site, [e]);
    assert.ok(
      Number(
        (
          await p.rows(
            'SELECT count() n FROM liekan_ch_proto.landing WHERE run={run:String} AND site={site:String}',
            { run, site: e.site },
          )
        )[0].n,
      ) > 1,
    );
  });

  await step('同批 A 等待删除、B 继续，网络故障与重启', [18, 23], async () => {
    await p.addSites('synthetic_wait_a', 'synthetic_wait_b');
    const a = event('synthetic_wait_a'),
      b1 = event('synthetic_wait_b'),
      b2 = event('synthetic_wait_b');
    const deletion = await p.beginDelete(a.site, a.session);
    const rp = await service('redpanda');
    await docker('network', 'disconnect', `${PROJECT}_default`, rp);
    try {
      await assert.rejects(() => p.activateDelete(deletion));
    } finally {
      await docker('network', 'connect', '--alias', 'redpanda', `${PROJECT}_default`, rp);
    }
    await healthy('redpanda');
    await p.enqueue([
      { event: a, partition: 0 },
      { event: b1, partition: 0 },
    ]);
    await actorCrash('process', 'after_confirm');
    await p.derive();
    await check(b1.site, [b1]);
    await check(a.site, []);
    await p.enqueue([{ event: b2, partition: 0 }]);
    await cycle();
    await check(b1.site, [b1, b2]);
    await check(a.site, []);
    const deferred = await p.pool.query(
      "SELECT 1 FROM proto_work WHERE run=$1 AND site=$2 AND status='deferred'",
      [run, a.site],
    );
    assert.equal(deferred.rowCount, 1);
    await p.activateDelete(deletion);
    const fresh = event(a.site);
    await p.enqueue([{ event: fresh, partition: 0 }]);
    await cycle();
    await check(a.site, [fresh]);
    await check(b1.site, [b1, b2]);
    assert.equal(
      (await p.pool.query("SELECT 1 FROM proto_work WHERE run=$1 AND status<>'decided'", [run]))
        .rowCount,
      0,
    );
    return {
      samePartition: 0,
      sameBatch: true,
      bBeforeDeletionCompleted: 2,
      deferredRecovered: 1,
      networkDisconnect: true,
    };
  });

  await step('失败派生留盘、发布候选过滤与合并', [5, 6, 7], async () => {
    await p.addSites('synthetic_partial_a', 'synthetic_partial_b');
    const a = event('synthetic_partial_a'),
      b = event('synthetic_partial_b');
    await p.enqueue([
      { event: a, partition: 1 },
      { event: b, partition: 1 },
    ]);
    await p.process(await p.claim());
    await p.derive({ failSite: a.site });
    await check(a.site, []);
    await check(b.site, [b]);
    await p.ch.command({ query: 'OPTIMIZE TABLE liekan_ch_proto.events FINAL' });
    await check(b.site, [b]);
    await p.derive();
    await check(a.site, [a]);
    assert.equal(
      Number(
        (
          await p.rows(
            'SELECT count() n FROM liekan_ch_proto.events WHERE run={run:String} AND site={site:String}',
            { run, site: a.site },
          )
        )[0].n,
      ),
      2,
    );
  });

  await step('发布指针更新前崩溃', [13], async () => {
    await p.addSites('synthetic_publish');
    const e = event('synthetic_publish');
    await p.enqueue([{ event: e, partition: 0 }]);
    await p.process(await p.claim());
    await actorCrash('derive', 'before_publish');
    await check(e.site, []);
    await p.derive();
    await check(e.site, [e]);
    const before = (await p.site(e.site)).publication;
    await p.derive();
    assert.equal((await p.site(e.site)).publication, before);
    return { publicationRetry: 'one selected candidate', geoCounters: 'not integrated' };
  });

  await step('凭据在派生暂停与回收尝试后仍有效', [17], async () => {
    await p.addSites('synthetic_receipt');
    const e = event('synthetic_receipt');
    await p.enqueue([{ event: e, partition: 1 }]);
    await p.process(await p.claim());
    const attempt = (
      await p.pool.query('SELECT id FROM proto_attempt WHERE run=$1 AND site=$2 AND status=$3', [
        run,
        e.site,
        'confirmed',
      ])
    ).rows[0].id;
    assert.deepEqual(await p.gcLanding(attempt), { reclaimed: false, reason: 'receipt-lifetime' });
    const duplicate = { ...e, id: `${e.id}_retry` },
      conflict = { ...e, id: `${e.id}_conflict`, cents: -99 };
    await p.enqueue([
      { event: duplicate, partition: 1 },
      { event: conflict, partition: 1 },
    ]);
    await cycle();
    await check(e.site, [e]);
    const outcomes = await p.rows(
      'SELECT event_id,verdict FROM liekan_ch_proto.landing WHERE run={run:String} AND site={site:String}',
      { run, site: e.site },
    );
    assert.equal(outcomes.find(r => r.event_id === duplicate.id)?.verdict, 'duplicate');
    assert.equal(outcomes.find(r => r.event_id === conflict.id)?.verdict, 'conflict');
  });

  await step('旧所有者与控制修订变化使候选作废', [3, 16], async () => {
    await p.addSites('synthetic_fence');
    const e = event('synthetic_fence');
    await p.enqueue([{ event: e, partition: 0 }]);
    await p.process(await p.claim(), {
      afterLookup: async () => {
        await p.claim();
      },
    });
    await p.derive();
    await check(e.site, []);
    await cycle();
    await check(e.site, [e]);
    const retry = { ...e, id: `${e.id}_old_receipt` };
    await p.enqueue([{ event: retry, partition: 0 }]);
    await p.process(await p.claim(), {
      afterLookup: async () => {
        await p.activateDelete(await p.beginDelete(e.site, e.session));
      },
    });
    await check(e.site, []);
    await cycle();
    const fresh = { ...e, id: `${e.id}_after_delete` };
    await p.enqueue([{ event: fresh, partition: 0 }]);
    await cycle();
    await check(e.site, [fresh]);
  });

  await step('跨会话 UUID 重试等待原凭据会话的删除', [16, 23], async () => {
    await p.addSites('synthetic_receipt_session');
    const original = event('synthetic_receipt_session', 'original_session');
    await p.enqueue([{ event: original, partition: 0 }]);
    await cycle();
    const deletion = await p.beginDelete(original.site, original.session);
    const retry = {
      ...original,
      id: `${original.id}_retry`,
      session: 'current_session',
      visit: 'current_visit',
    };
    await p.enqueue([{ event: retry, partition: 0 }]);
    assert.equal(
      await p.process(await p.claim()),
      0,
      'original receipt session must fence a retry naming another session',
    );
    await p.activateDelete(deletion);
    await cycle();
    await check(original.site, [retry]);
  });

  await step('跨分区删除等待、持久边界恢复与重置', [8, 9, 21, 23], async () => {
    await p.addSites('synthetic_boundary');
    const initial = event('synthetic_boundary');
    await p.enqueue([{ event: initial, partition: 0 }]);
    await cycle();
    const id = await p.beginDelete(initial.site, initial.session);
    const firstBoundary = await p.bounds();
    const e1 = event(initial.site);
    await p.enqueue([{ event: e1, partition: 0 }]);
    assert.equal(
      await p.process(await p.claim()),
      0,
      'no business confirmation while delete is pending',
    );
    const secondBoundary = await p.bounds();
    await p.activateDelete(id, { 0: firstBoundary[0], 1: secondBoundary[1] });
    await cycle();
    await check(initial.site, [e1]);
    const e2 = event(initial.site);
    await p.enqueue([{ event: e2, partition: 1 }]);
    await cycle();
    await check(initial.site, [e1, e2]);
    const d2 = await p.beginDelete(initial.site, initial.session);
    await actorCrash('delete', 'after_delete_boundary', d2);
    const fixed = (
      await p.pool.query('SELECT boundary FROM proto_delete WHERE run=$1 AND id=$2', [run, d2])
    ).rows[0].boundary;
    const e3 = event(initial.site);
    await p.enqueue([{ event: e3, partition: 1 }]);
    await p.activateDelete(d2);
    assert.deepEqual(
      (await p.pool.query('SELECT boundary FROM proto_delete WHERE run=$1 AND id=$2', [run, d2]))
        .rows[0].boundary,
      fixed,
    );
    await cycle();
    await check(initial.site, [e3]);
    const reset = await p.beginDelete(initial.site, '*', randomUUID(), true);
    await p.activateDelete(reset);
    await check(initial.site, []);
    const after = event(initial.site);
    await p.enqueue([{ event: after, partition: 1 }]);
    await cycle();
    await check(initial.site, [after]);
    return {
      pendingBusinessConfirmations: 0,
      boundaryStableAcrossKill: true,
      sequentialClientEventsPreserved: true,
    };
  });

  await step('CH 停机时队列接收，恢复后追平', [4, 8], async () => {
    await p.addSites('synthetic_outage');
    const e = event('synthetic_outage');
    const id = await service('ch');
    await docker('kill', '-s', 'KILL', id);
    try {
      await p.enqueue([{ event: e, partition: 0 }]);
      const owners = await p.claim();
      await assert.rejects(() => p.process(owners), /ECONNREFUSED|ECONNRESET|socket hang up/);
    } finally {
      await docker(...compose, 'start', 'ch');
      await healthy('ch');
    }
    await cycle();
    await check(e.site, [e]);
    return { inputAcceptedWhileChDown: true, visibleAfterRecovery: 1 };
  });

  await step('提交后死亡、原事实删除、补发及重复发送', [19, 20], async () => {
    await p.addSites('synthetic_outcome');
    const e = event('synthetic_outcome');
    await p.enqueue([{ event: e, partition: 0 }]);
    await actorCrash('process', 'after_confirm');
    await p.activateDelete(await p.beginDelete(e.site, e.session));
    for (const table of ['landing', 'events', 'properties', 'revenue'])
      await p.ch.command({
        query: `ALTER TABLE liekan_ch_proto.${table} DELETE WHERE run={run:String} AND site={site:String}`,
        query_params: { run, site: e.site },
        clickhouse_settings: { mutations_sync: '1' },
      });
    await actorCrash('relay', 'after_result_send');
    await p.relay();
    const messages = await p.applyShadow();
    await p.applyShadow();
    assert.equal(
      (
        await p.pool.query('SELECT 1 FROM proto_shadow_fact WHERE run=$1 AND site=$2', [
          run,
          e.site,
        ])
      ).rowCount,
      0,
    );
    const expectedOps = Number(
      (await p.pool.query('SELECT count(*) n FROM proto_result WHERE run=$1', [run])).rows[0].n,
    );
    assert.equal(
      Number(
        (await p.pool.query('SELECT count(*) n FROM proto_shadow_operation WHERE run=$1', [run]))
          .rows[0].n,
      ),
      expectedOps,
    );
    assert.ok(messages > expectedOps, 'crash must actually cause a duplicate transport result');
    return { resultMessages: messages, appliedUniqueOperations: expectedOps, resurrectedFacts: 0 };
  });

  await step('异步批量日志与多行属性金额完整性', [22], async () => {
    await p.addSites('synthetic_logs');
    const events = Array.from({ length: 24 }, () =>
      event('synthetic_logs', 'log_batch', {
        kind: 'log',
        properties: { batch: 'synthetic_upload', source: 'test' },
      }),
    );
    await p.enqueue(events.map(event => ({ event, partition: 1 })));
    const start = performance.now();
    await p.process(await p.claim(), { asyncInsert: true });
    await p.derive({ asyncInsert: true });
    await check('synthetic_logs', events);
    return {
      events: events.length,
      elapsedMs: Math.round(performance.now() - start),
      capacityClaim: false,
    };
  });

  await step('迁移关闭、在途发送被杀、排空与清理后持续采集', [20, 23], async () => {
    await p.addSites('synthetic_final');
    const old = event('synthetic_final');
    await p.enqueue([{ event: old, partition: 0 }]);
    await cycle();
    const pending = await p.beginDelete(old.site, 'unused_session');
    await assert.rejects(() => p.beginClose(), /pending control operations/);
    await p.activateDelete(pending);
    await actorCrash('relay', 'before_result_send');
    const generation = await p.beginClose();
    const before = Number(
      (await p.pool.query('SELECT count(*) n FROM proto_result WHERE run=$1', [run])).rows[0].n,
    );
    const fresh = event(old.site);
    await p.enqueue([{ event: fresh, partition: 0 }]);
    await cycle();
    assert.equal(
      Number(
        (await p.pool.query('SELECT count(*) n FROM proto_result WHERE run=$1', [run])).rows[0].n,
      ),
      before,
    );
    assert.equal(await p.relay(generation - 1), 0, 'stale sender generation fenced');
    await assert.rejects(() => p.finalizeClose(), /unsent outcomes/);
    await p.relay(generation);
    await p.applyShadow();
    const shadowBefore = Number(
      (await p.pool.query('SELECT count(*) n FROM proto_shadow_fact WHERE run=$1', [run])).rows[0]
        .n,
    );
    await actorCrash('close', 'after_close_seal');
    await p.finalizeClose();
    await p.finalizeClose();
    await p.relay(generation - 1);
    await p.relay(generation);
    // A restarted old process must observe closed before contacting a deleted topic.
    if (ROUND2)
      await exec(
        process.execPath,
        [
          '--import',
          resolve('experiments/ch-prototype/node_modules/tsx/dist/loader.mjs'),
          'experiments/ch-prototype/actor.ts',
          run,
          'relay',
          '1',
        ],
        { env: process.env },
      );
    else
      await docker(
        ...compose,
        'run',
        '--rm',
        'actor',
        'node',
        '--experimental-transform-types',
        'experiments/ch-prototype/actor.ts',
        run,
        'relay',
        '1',
      );
    const after = event(old.site);
    await p.enqueue([{ event: after, partition: 1 }]);
    await cycle();
    await check(old.site, [old, fresh, after]);
    assert.equal((await p.admin.listTopics()).includes(p.resultTopic), false);
    assert.equal(
      (await p.pool.query('SELECT 1 FROM proto_result WHERE run=$1', [run])).rowCount,
      0,
    );
    assert.equal(
      Number(
        (await p.pool.query('SELECT count(*) n FROM proto_shadow_fact WHERE run=$1', [run])).rows[0]
          .n,
      ),
      shadowBefore,
    );
    return {
      captureStopped: true,
      temporaryResultsRemaining: 0,
      topicRecreated: false,
      pgShadowGrowthAfterClose: 0,
      chFactsForSite: 3,
    };
  });
  report.completed = new Date().toISOString();
  report.summary = {
    passed: report.tests.filter((t: any) => t.status === 'pass').length,
    notRun: report.tests.filter((t: any) => t.status === 'not-run').length,
    failed: 0,
    fullUpgradeValidated: false,
  };
  await save();
  console.log(`REPORT ${resolve(OUTPUT, `${run}-report.json`)}`);
} catch (error) {
  report.summary = {
    passed: report.tests.filter((t: any) => t.status === 'pass').length,
    failed: 1,
    fullUpgradeValidated: false,
  };
  report.error = error instanceof Error ? error.message : String(error);
  await save();
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await p.disconnect();
}
