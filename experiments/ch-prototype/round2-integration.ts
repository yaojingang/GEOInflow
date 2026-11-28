import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Prototype,
  PROJECT,
  OUTPUT,
  ROUND2,
  delay,
  contentFingerprint,
  type Event,
} from './core.ts';

assert.ok(ROUND2);
const run = `proto_r2_${Date.now()}`;
const p = new Prototype(run),
  exec = promisify(execFile);
const report: any = {
  run,
  started: new Date().toISOString(),
  tests: [],
  faults: [],
  fullUpgradeValidated: false,
};
const actors = new Set<ChildProcess>();
let sequence = 0;

/** Wait for observable external state with a finite deadline. */
async function until(fn: () => Promise<any>, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await delay(40);
  }
  throw new Error('observable state deadline exceeded');
}
/** Read only this run's generated marker. */
async function marker(name: string) {
  return until(() => readFile(resolve(OUTPUT, name), 'utf8').then(JSON.parse, () => false));
}
/** Start an independent process using the prototype's own dependency tree. */
function actor(
  command: string,
  arg = '0',
  point?: string,
  resumable = false,
  extra: Record<string, string> = {},
) {
  const id = `${run}_${++sequence}`;
  const child = spawn(
    process.execPath,
    [
      '--import',
      resolve('experiments/ch-prototype/node_modules/tsx/dist/loader.mjs'),
      'experiments/ch-prototype/round2-actor.ts',
      run,
      command,
      arg,
    ],
    {
      env: {
        ...process.env,
        PROTO_ROUND: '2',
        PROTO_ACTOR_ID: id,
        PROTO_FAULT: point ?? '',
        PROTO_RESUMABLE: resumable ? '1' : '0',
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  actors.add(child);
  let stderr = '';
  child.stderr.on('data', b => {
    stderr += b.toString();
  });
  const ended = new Promise<{ code: number | null; signal: string | null }>(resolveEnd =>
    child.on('exit', (code, signal) => resolveEnd({ code, signal })),
  );
  return {
    id,
    child,
    ended,
    error: () => stderr,
    ready: () => marker(`ready-${id}.json`),
    fault: () => marker(`fault-${id}-${point}.json`),
    release: () => writeFile(resolve(OUTPUT, `release-${id}-${point}`), 'release'),
  };
}
/** Record an actual OS SIGKILL, not a thrown application exception. */
async function kill(a: ReturnType<typeof actor>, point: string) {
  a.child.kill('SIGKILL');
  const result = await a.ended;
  assert.equal(result.signal, 'SIGKILL');
  actors.delete(a.child);
  report.faults.push({ point, signal: result.signal, pid: a.child.pid });
}
/** Stop a probe after its observable outcome without leaving a processor behind. */
async function stop(a: ReturnType<typeof actor>) {
  a.child.kill('SIGTERM');
  await Promise.race([a.ended, delay(3000).then(() => a.child.kill('SIGKILL'))]);
  actors.delete(a.child);
}
/** Persist pass/fail evidence as each scenario finishes. */
async function step(name: string, fn: () => Promise<any>) {
  const start = performance.now();
  try {
    const details = await fn();
    report.tests.push({ name, status: 'pass', ms: Math.round(performance.now() - start), details });
    console.log(`PASS ${name}`);
  } catch (e) {
    report.tests.push({ name, status: 'fail', error: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    await save();
  }
}
/** Save only redacted observations and counts. */
async function save() {
  await writeFile(resolve(OUTPUT, `${run}-report.json`), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
}
/** Submit a request and parse its business status. */
async function post(port: number, body: any, path = '/browser', token?: string) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
/** Observe broker acceptance before driving the worker; avoid sleep-based ordering assumptions. */
async function submitted(port: number, body: any) {
  const previous = (await p.admin.fetchTopicOffsets(p.inputTopic)).reduce(
    (n, r) => n + Number(r.high),
    0,
  );
  const response = post(port, body);
  // Preserve an immediate rejection as data until the caller inspects it after fault injection.
  const settled = response.then(
    value => ({ value, error: undefined }),
    error => ({ value: undefined, error }),
  );
  await until(
    async () =>
      (await p.admin.fetchTopicOffsets(p.inputTopic)).reduce((n, r) => n + Number(r.high), 0) >
      previous,
  );
  return { settled };
}

/** Drain undecided work after a fenced attempt while keeping expectations in the test. */
async function cycle() {
  await p.process(await p.claim());
  await p.derive();
}

try {
  await mkdir(OUTPUT, { recursive: true });
  for (const name of ['pg', 'control', 'ch', 'redpanda']) {
    const { stdout } = await exec('docker', ['inspect', `${PROJECT}-${name}-1`]);
    const [state] = JSON.parse(stdout);
    assert.equal(state.Config.Labels['com.docker.compose.project'], PROJECT);
    for (const m of state.Mounts)
      if (m.Type === 'volume') assert.ok(m.Name.startsWith(`${PROJECT}_`));
    for (const binds of Object.values(state.HostConfig.PortBindings) as any[])
      for (const b of binds ?? []) assert.equal(b.HostIp, '127.0.0.1');
  }
  await p.connect();
  await p.setup();
  const seed = JSON.parse(
    await readFile(resolve(OUTPUT, 'protocol-samples.json'), 'utf8'),
  )[0] as Event;
  assert.ok(seed, 'restored database sample required');
  report.sampleSource =
    'verified production archive, 32 pseudonymized website_event rows; controlled fault variants';
  const make = (site: string, override: Partial<Event> = {}): Event => ({
    ...seed,
    id: randomUUID(),
    uuid: randomUUID(),
    site,
    ...override,
  });

  await step('canonical payload content and event-ID-independent fingerprint', async () => {
    const base = make('r2_canonical', {
      payload: {
        eventId: 'first',
        website: seed.site,
        data: { nested: { a: 1, b: 2 } },
        url: seed.path,
      },
    });
    const reordered = {
      ...base,
      payload: {
        url: seed.path,
        data: { nested: { b: 2, a: 1 } },
        website: seed.site,
        eventId: 'retry',
      },
    };
    assert.equal(contentFingerprint(base), contentFingerprint(reordered));
    assert.notEqual(
      contentFingerprint(base),
      contentFingerprint({ ...base, payload: { ...base.payload, name: 'changed' } }),
    );
    assert.notEqual(
      contentFingerprint(base),
      contentFingerprint({
        ...base,
        payload: { ...base.payload, data: { nested: { a: 1, b: 3 } } },
      }),
    );
    return {
      canonicalOrdering: true,
      eventIdExcluded: true,
      additionalValidatedFieldsCompared: true,
    };
  });

  await step('two independent owners and partition reassignment fence late writes', async () => {
    const site = 'r2_owners';
    await p.addSites(site);
    const a = make(site, { session: 'partition_zero' }),
      b = make(site, { session: 'partition_one' });
    await p.enqueue([
      { event: a, partition: 0 },
      { event: b, partition: 1 },
    ]);
    const old = actor('once', '0', 'after_lookup', true);
    await old.ready();
    await old.fault();
    const other = actor('once', '1');
    await other.ready();
    assert.equal((await other.ended).code, 0, other.error());
    assert.deepEqual(
      (await p.visible(site)).map(r => r.event_id),
      [b.id],
    );
    const current = actor('once', '0');
    await current.ready();
    assert.equal((await current.ended).code, 0, current.error());
    await old.release();
    assert.equal((await old.ended).code, 0, old.error());
    await p.derive();
    assert.deepEqual((await p.visible(site)).map(r => r.event_id).sort(), [a.id, b.id].sort());
    const attempts = (
      await p.pool.query(
        'SELECT status,count(*)::int n FROM proto_attempt WHERE run=$1 AND site=$2 GROUP BY status',
        [run, site],
      )
    ).rows;
    assert.equal(attempts.find(r => r.status === 'confirmed')?.n, 2);
    assert.ok(attempts.find(r => r.status === 'aborted')?.n >= 1);
    return {
      independentPids: [old.child.pid, other.child.pid, current.child.pid],
      visible: 2,
      lateAttemptRejected: true,
    };
  });

  await step('real Kafka consumer group rebalance fences the former member', async () => {
    const site = 'r2_group_rebalance';
    await p.addSites(site);
    const old = actor('group', '0', 'after_lookup', true);
    await marker(`assignment-${old.id}.json`);
    const survivor = actor('group');
    const assignment = async (id: string) =>
      readFile(resolve(OUTPUT, `assignment-${id}.json`), 'utf8').then(JSON.parse, () => null);
    await until(async () => {
      const a = await assignment(old.id),
        b = await assignment(survivor.id);
      return a?.partitions.length === 1 && b?.partitions.length === 1;
    }, 60000);
    const a = await assignment(old.id),
      b = await assignment(survivor.id);
    const first = make(site, { session: 'group_a' }),
      second = make(site, { session: 'group_b' });
    await p.enqueue([
      { event: first, partition: a.partitions[0] },
      { event: second, partition: b.partitions[0] },
    ]);
    await old.fault();
    await until(async () => (await p.visible(site)).some(r => r.event_id === second.id), 60000);
    await writeFile(
      resolve(OUTPUT, `rebalance-${old.id}`),
      'leave consumer group while work remains paused',
    );
    const reassigned = await until(async () => {
      const next = await assignment(survivor.id);
      return next?.partitions.length === 2 ? next : null;
    }, 60000);
    await until(async () => (await p.visible(site)).length === 2, 60000);
    await old.release();
    assert.equal((await old.ended).code, 0, old.error());
    assert.deepEqual(
      (await p.visible(site)).map(r => r.event_id).sort(),
      [first.id, second.id].sort(),
    );
    await stop(survivor);
    return {
      sdkGroupJoin: true,
      before: [a.partitions, b.partitions],
      after: reassigned.partitions,
      lateOwnerRejected: true,
    };
  });

  await step(
    'concurrent same UUID on different partitions returns one fact and conflict',
    async () => {
      const site = 'r2_uuid_race';
      await p.addSites(site);
      const a = make(site),
        b = { ...a, id: randomUUID(), cents: a.cents + 1 };
      await p.enqueue([
        { event: a, partition: 0 },
        { event: b, partition: 1 },
      ]);
      const first = actor('once', '0', 'after_lookup', true),
        second = actor('once', '1', 'after_lookup', true);
      await Promise.all([first.fault(), second.fault()]);
      await first.release();
      assert.equal((await first.ended).code, 0, first.error());
      await second.release();
      assert.equal((await second.ended).code, 0, second.error());
      await cycle();
      assert.deepEqual(
        (await p.visible(site)).map(r => r.event_id),
        [a.id],
      );
      const accepted = (
        await p.pool.query(
          "SELECT id FROM proto_attempt WHERE run=$1 AND site=$2 AND status='confirmed'",
          [run, site],
        )
      ).rows.map(r => r.id);
      const rows = await p.rows(
        'SELECT verdict FROM liekan_ch_proto.landing WHERE run={run:String} AND attempt IN {ids:Array(String)}',
        { run, ids: accepted },
      );
      assert.deepEqual(rows.map(r => r.verdict).sort(), ['conflict', 'new']);
      return {
        visible: 1,
        confirmedVerdicts: rows.map(r => r.verdict).sort(),
        versionRecheck: true,
      };
    },
  );

  await step('source and scope conflicts, SQL deletion, epoch and quality filtering', async () => {
    const site = 'r2_quality';
    await p.addSites(site);
    const a = make(site, { scope: 'browser', source: 'browser', policyVersion: 1 }),
      unknown = make(site, { scope: 'browser_unresolved' });
    const source = { ...a, id: randomUUID(), source: 'server_log' },
      scope = { ...a, id: randomUUID(), scope: 'browser_automated' };
    await p.enqueue([a, source, scope, unknown].map(event => ({ event, partition: 0 })));
    await cycle();
    assert.equal((await p.visible(site)).length, 2);
    assert.deepEqual(
      (await p.visible(site, true)).map(r => r.event_id),
      [a.id],
    );
    const jobs = (
      await p.pool.query(
        "SELECT id FROM proto_attempt WHERE run=$1 AND site=$2 AND status='confirmed'",
        [run, site],
      )
    ).rows.map(r => r.id);
    const conflicts = await p.rows(
      "SELECT count() n FROM liekan_ch_proto.landing WHERE run={run:String} AND verdict='conflict' AND attempt IN {jobs:Array(String)}",
      { run, jobs },
    );
    assert.equal(Number(conflicts[0].n), 2);
    await p.activateDelete(await p.beginDelete(site, a.session));
    assert.equal((await p.visible(site)).length, 0);
    const fresh = make(site, { scope: 'browser', source: 'browser', policyVersion: 1 });
    await p.enqueue([{ event: fresh, partition: 1 }]);
    await cycle();
    assert.equal((await p.visible(site, true)).length, 1);
    await p.activateDelete(await p.beginDelete(site, '*', randomUUID(), true));
    assert.equal((await p.visible(site)).length, 0);
    return { sourceScopeConflicts: 2, sqlQualifiedBeforeDelete: 1, afterDelete: 0, afterReset: 0 };
  });

  await step(
    'HTTP timeout is undetermined; retry returns original identity; public provenance ignored',
    async () => {
      const site = 'r2_http_timeout';
      await p.addSites(site);
      const body = {
        site,
        uuid: randomUUID(),
        session: seed.session,
        visit: seed.visit,
        path: seed.path,
        source: 'server_log',
        scope: 'browser',
        policyVersion: 999,
      };
      const timeout = actor('http', '0', undefined, false, { PROTO_HTTP_TIMEOUT: '150' });
      const port = (await timeout.ready()).address.port;
      const uncertain = await post(port, body);
      assert.equal(uncertain.status, 503);
      assert.equal(uncertain.body.status, 'undetermined');
      await stop(timeout);
      await cycle();
      const server = actor('http', '0', undefined, false, { PROTO_HTTP_TIMEOUT: '60000' });
      const live = (await server.ready()).address.port;
      const request = await submitted(live, {
        ...body,
        session: 'new_session',
        visit: 'new_visit',
      });
      await cycle();
      const retry = (await request.settled).value;
      assert.ok(retry, 'retry must receive an HTTP response');
      assert.equal(retry.status, 200);
      assert.equal(retry.body.status, 'duplicate');
      assert.equal(retry.body.sessionId, body.session);
      assert.equal(retry.body.visitId, body.visit);
      const rows = await p.rows(
        'SELECT payload FROM liekan_ch_proto.landing WHERE run={run:String} AND site={site:String}',
        { run, site },
      );
      assert.ok(
        rows.every(
          r =>
            JSON.parse(r.payload).source === 'browser' &&
            JSON.parse(r.payload).scope === 'browser_unresolved' &&
            JSON.parse(r.payload).policyVersion === 1,
        ),
      );
      await stop(server);
      return { timeout: 503, retry: 200, identityPreserved: true, bodyOverrideTrusted: false };
    },
  );

  for (const point of ['after_http_queue', 'before_http_reply'])
    await step(`HTTP process SIGKILL at ${point}`, async () => {
      const site = `r2_${point}`;
      await p.addSites(site);
      const body = {
        site,
        uuid: randomUUID(),
        session: seed.session,
        visit: seed.visit,
        path: seed.path,
      };
      const server = actor('http', '0', point, false, { PROTO_HTTP_TIMEOUT: '60000' });
      const port = (await server.ready()).address.port;
      const pending = await submitted(port, body);
      if (point === 'before_http_reply') {
        await cycle();
      }
      await server.fault();
      await kill(server, point);
      assert.ok((await pending.settled).error);
      await cycle();
      const retryServer = actor('http', '0', undefined, false, { PROTO_HTTP_TIMEOUT: '60000' });
      const retryPort = (await retryServer.ready()).address.port;
      const retry = await submitted(retryPort, body);
      await cycle();
      assert.equal((await retry.settled).value?.body.status, 'duplicate');
      assert.equal((await p.visible(site)).length, 1);
      await stop(retryServer);
      return { visibleFacts: 1, retry: 'duplicate' };
    });

  await step(
    'no UUID waits for confirmation; authenticated logs acknowledge durable queue separately',
    async () => {
      const site = 'r2_http_no_uuid';
      await p.addSites(site);
      const server = actor('http', '0', undefined, false, { PROTO_HTTP_TIMEOUT: '60000' });
      const port = (await server.ready()).address.port;
      for (let i = 0; i < 2; i++) {
        let done = false;
        const request: Promise<{ status: number; body: any }> = post(port, {
          site,
          session: seed.session,
          visit: seed.visit,
          path: seed.path,
        }).then(r => {
          done = true;
          return r;
        });
        await delay(400);
        assert.equal(done, false);
        await cycle();
        assert.equal((await request).status, 200);
      }
      assert.equal((await p.visible(site)).length, 2);
      assert.equal((await post(port, { site }, '/logs')).status, 401);
      const token = (await readFile(resolve(OUTPUT, 'pg-password'), 'utf8')).trim();
      const queued = await post(port, { site, session: 'log_batch' }, '/logs', token);
      assert.equal(queued.status, 202);
      assert.equal((await p.visible(site)).length, 2);
      await cycle();
      assert.equal((await p.visible(site)).length, 3);
      await stop(server);
      return {
        noUuidFacts: 2,
        logsUnauthorized: 401,
        logsAccepted: 202,
        logVisibleAfterProcessing: true,
      };
    },
  );

  await step('same-name input topic recreation fences replay and delete activation', async () => {
    const q = new Prototype(`proto_r2_identity_${Date.now()}`);
    try {
      await q.connect();
      await q.setup();
      await q.addSites('topic_site');
      const event = make('topic_site');
      await q.enqueue([{ event, partition: 0 }]);
      const owners = await q.claim();
      const deletion = await q.beginDelete('topic_site', event.session);
      const oldId = q.inputTopicId;
      await q.admin.deleteTopics({ topics: [q.inputTopic] });
      await until(async () => !(await q.admin.listTopics()).includes(q.inputTopic));
      await q.admin.createTopics({
        waitForLeaders: true,
        topics: [{ topic: q.inputTopic, numPartitions: 2, replicationFactor: 1 }],
      });
      await assert.rejects(() => q.process(owners), /identity changed/);
      await assert.rejects(() => q.activateDelete(deletion), /identity changed/);
      assert.equal(
        (await q.pool.query('SELECT count(*)::int n FROM proto_attempt WHERE run=$1', [q.run]))
          .rows[0].n,
        0,
      );
      return { oldId, oldOffsetsReused: false, deletionActivated: false };
    } finally {
      await q.disconnect();
    }
  });
  report.summary = { passed: report.tests.length, failed: 0 };
} catch (e) {
  report.summary = {
    passed: report.tests.filter((x: any) => x.status === 'pass').length,
    failed: 1,
  };
  report.error = e instanceof Error ? e.message : String(e);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  for (const c of actors) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await p.disconnect();
  report.completed = new Date().toISOString();
  await save();
  console.log(`REPORT ${resolve(OUTPUT, `${run}-report.json`)}`);
}
