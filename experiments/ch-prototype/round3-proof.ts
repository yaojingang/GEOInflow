import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { resolve } from 'node:path';
import { delay, digest, type Event, OUTPUT, Prototype, ROUND2 } from './core.ts';
import { commitBackfillPage, prepareData } from './round2-data.ts';
import { ROUTING_VERSION, route, routingKey } from './routing.ts';

assert.ok(ROUND2);
const childMode = process.argv[2] === 'page';
const run = childMode ? process.argv[3] : `proto_r3_${Date.now()}`;
const p = new Prototype(run, true);
const children = new Set<ChildProcess>();
let sequence = 0;
const report: any = { run, tests: [], fullUpgradeValidated: false, sourceCloneUsed: false };

/** Read an external process marker within a bounded observation window. */
async function until(fn: () => Promise<any>, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(30);
  }
  throw new Error('proof deadline exceeded');
}

/** Run each case sequentially and preserve a failure rather than relabeling it. */
async function test(name: string, fn: () => Promise<any>) {
  if (process.env.PROTO_PROOF_FILTER && !new RegExp(process.env.PROTO_PROOF_FILTER).test(name)) {
    report.tests.push({ name, status: 'not-run' });
    return;
  }
  const started = Date.now();
  try {
    const evidence = await fn();
    report.tests.push({ name, status: 'passed', ms: Date.now() - started, evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.tests.push({ name, status: 'failed', error: String(error), ms: Date.now() - started });
    throw error;
  }
}

/** Start a bounded independent actor using the exact current Node runtime and local loader. */
function actor(args: string[], point = '', extra: Record<string, string> = {}) {
  const id = `${run}_${++sequence}`;
  const child = spawn(
    process.execPath,
    ['--import', resolve('experiments/ch-prototype/node_modules/tsx/dist/loader.mjs'), ...args],
    {
      env: {
        ...process.env,
        PROTO_ROUND: '2',
        PROTO_STRICT_ROUTING: '1',
        PROTO_ACTOR_ID: id,
        PROTO_FAULT: point,
        PROTO_RESUMABLE: '1',
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  let stderr = '';
  child.stderr.on('data', b => {
    stderr += b.toString();
  });
  const ended = new Promise<{ code: number | null; signal: string | null }>(r =>
    child.once('exit', (code, signal) => {
      children.delete(child);
      r({ code, signal });
    }),
  );
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  ended.then(() => clearTimeout(timer));
  return {
    child,
    ended,
    error: () => stderr,
    marker: (prefix = 'fault') =>
      until(() =>
        readFile(
          resolve(OUTPUT, `${prefix}-${id}${prefix === 'fault' ? `-${point}` : ''}.json`),
          'utf8',
        ).then(JSON.parse, () => false),
      ),
    release: () => writeFile(resolve(OUTPUT, `release-${id}-${point}`), '1'),
  };
}

/** Produce fixture identities with independent sessions so overlapping attempts are observable. */
function event(site: string, partition?: number): Event {
  for (;;) {
    const e: Event = {
      id: randomUUID(),
      site,
      session: randomUUID(),
      visit: randomUUID(),
      uuid: randomUUID(),
      path: '/proof',
      cents: 7,
      properties: { proof: 'synthetic' },
      kind: 'browser',
    };
    if (partition === undefined || route(e) === partition) return e;
  }
}

/** Recover all pending fixture work with a new fenced owner. */
async function drain() {
  const owners = await p.claim([0, 1]);
  for (let n = 0; n < 5; n++) {
    await p.process(owners);
    await p.derive();
    if (
      !(
        await p.pool.query(
          "SELECT 1 FROM proto_work WHERE run=$1 AND status NOT IN ('decided','quarantined')",
          [run],
        )
      ).rowCount
    )
      return;
  }
  throw new Error('finite input failed to drain');
}

/** Generate a three-sub-batch synthetic page without reading any restored source. */
function pageValues(kind: string) {
  return Array.from({ length: 12000 }, (_, i) => ({
    kind,
    id: `${kind}_${i.toString().padStart(5, '0')}`,
    site: kind,
    session: `s${i % 23}`,
    occurred: '2026-11-01 00:00:00.000',
    path: `/fixture/${i}`,
    status: 200,
    bytes: String(i),
    ai: i % 2,
    eligible: 1,
    scope: 'log',
    classification: 'synthetic',
    rule: 'fixture-v1',
    epoch: 1,
    version: 1,
  }));
}

/** Re-enter the exact page publisher used by the existing backfill after an uncertain commit. */
async function pageAttempt(kind: string) {
  const values = pageValues(kind),
    hash = digest(values);
  const old = (
    await p.pool.query('SELECT candidate FROM r3_page WHERE kind=$1 AND cursor=$2', [kind, '12000'])
  ).rows[0];
  const candidate = old?.candidate ?? randomUUID();
  if (!old)
    await p.ch.insert({
      table: 'liekan_ch_proto.proof_facts',
      values: values.map(v => ({ ...v, candidate })),
      format: 'JSONEachRow',
    });
  return commitBackfillPage(p, { kind, cursor: '12000', candidate, hash, values }, 'r3');
}

/** Drop PostgreSQL's COMMIT reply only after the backend has reported a successful commit. */
async function commitReplyProxy() {
  let dropped = false;
  const sockets = new Set<ReturnType<typeof createConnection>>();
  const server = createServer(socket => {
    const upstream = createConnection({ host: '127.0.0.1', port: 25459 });
    sockets.add(socket);
    sockets.add(upstream);
    socket.on('error', () => {});
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => {
      upstream.destroy();
      sockets.delete(socket);
      sockets.delete(upstream);
    });
    socket.pipe(upstream);
    let pending = Buffer.alloc(0);
    upstream.on('data', chunk => {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (pending.length >= 5) {
        const size = pending.readInt32BE(1) + 1;
        assert.ok(size >= 5 && size < 16 * 1024 * 1024);
        if (pending.length < size) break;
        const frame = pending.subarray(0, size);
        pending = pending.subarray(size);
        if (frame[0] === 67 && frame.subarray(5).toString() === 'COMMIT\0') {
          dropped = true;
          socket.destroy();
          upstream.destroy();
          return;
        }
        socket.write(frame);
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as any).port,
    dropped: () => dropped,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>(r => server.close(() => r()));
    },
  };
}

/** Compare the complete synthetic ID set in both stores using only published candidates. */
async function assertPage(kind: string) {
  const page = (await p.pool.query('SELECT * FROM r3_page WHERE kind=$1', [kind])).rows;
  assert.equal(page.length, 1);
  const reference = (
    await p.pool.query('SELECT id FROM r3_facts WHERE kind=$1 ORDER BY id', [kind])
  ).rows.map(r => r.id);
  const actual = (
    await p.rows(
      'SELECT id FROM liekan_ch_proto.proof_facts WHERE kind={kind:String} AND candidate={candidate:String} ORDER BY id',
      { kind, candidate: page[0].candidate },
    )
  ).map(r => r.id);
  const expected = pageValues(kind)
    .map(r => r.id)
    .sort();
  assert.deepEqual(reference, expected);
  assert.deepEqual(actual, expected);
  assert.equal(page[0].hash, digest(pageValues(kind)));
  return { rows: expected.length, publishedPages: 1, idDigest: digest(actual) };
}

if (childMode) {
  try {
    if (process.env.PROTO_PROXY_PORT) p.pool.options.port = Number(process.env.PROTO_PROXY_PORT);
    await p.connect();
    await pageAttempt(process.argv[4]);
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'page failed');
    process.exitCode = 2;
  } finally {
    await p.disconnect();
  }
} else {
  const globalTimer = setTimeout(() => {
    for (const c of children) c.kill('SIGKILL');
    process.exit(124);
  }, 600000);
  try {
    await mkdir(OUTPUT, { recursive: true });
    await p.connect();
    await p.setup();
    await prepareData(p, 'r3');
    await test('normal routing: independent keys at one site confirm concurrently', async () => {
      const site = `${run}_hot`;
      await p.addSites(site);
      const events = [event(site, 0), event(site, 1)];
      await p.enqueue(events.map(event => ({ event })));
      const actors = [0, 1].map(part =>
        actor(
          ['experiments/ch-prototype/round2-actor.ts', run, 'once', String(part)],
          'after_lookup',
        ),
      );
      await Promise.all(actors.map(a => a.marker()));
      await Promise.all(actors.map(a => a.release()));
      for (const a of actors) assert.equal((await a.ended).code, 0, a.error());
      await p.derive();
      assert.deepEqual(
        (await p.visible(site)).map(e => e.event_id).sort(),
        events.map(e => e.id).sort(),
      );
      const states = (
        await p.pool.query(
          'SELECT status,count(*)::int n FROM proto_attempt WHERE run=$1 AND site=$2 GROUP BY status',
          [run, site],
        )
      ).rows;
      assert.deepEqual(states, [{ status: 'confirmed', n: 2 }]);
      return { states, partitions: [0, 1], forcedOverlap: true };
    });
    await test('single-flight within one owner: identical retries and content conflict', async () => {
      const site = `${run}_retry`;
      await p.addSites(site);
      const first = event(site);
      const part = route(first);
      await p.enqueue([{ event: first }]);
      const held = actor(
        ['experiments/ch-prototype/round2-actor.ts', run, 'once', String(part)],
        'after_lookup',
      );
      await held.marker();
      await p.enqueue([{ event: { ...first, id: randomUUID(), session: randomUUID() } }]);
      const generation = (
        await p.pool.query('SELECT generation FROM proto_partition WHERE run=$1 AND partition=$2', [
          run,
          part,
        ])
      ).rows[0].generation;
      assert.equal(await p.process({ [part]: Number(generation) }), 0);
      await held.release();
      assert.equal((await held.ended).code, 0, held.error());
      await p.enqueue([{ event: { ...first, id: randomUUID(), session: randomUUID(), cents: 8 } }]);
      await drain();
      const ids = (
        await p.pool.query(
          "SELECT id FROM proto_attempt WHERE run=$1 AND site=$2 AND status='confirmed'",
          [run, site],
        )
      ).rows.map(r => r.id);
      const verdicts = (
        await p.rows(
          'SELECT verdict FROM liekan_ch_proto.landing WHERE run={run:String} AND attempt IN {ids:Array(String)}',
          { run, ids },
        )
      )
        .map(r => r.verdict)
        .sort();
      assert.deepEqual(verdicts, ['conflict', 'duplicate', 'new']);
      assert.equal((await p.visible(site)).length, 1);
      return { verdicts, sameOwnerOverlapRejected: true };
    });
    await test('no receipt keeps session routing and independent event semantics', async () => {
      const site = `${run}_no_uuid`;
      await p.addSites(site);
      const a = { ...event(site), uuid: undefined },
        b = { ...a, id: randomUUID() };
      assert.equal(route(a), route(b));
      assert.equal(routingKey(a), routingKey(b));
      await p.enqueue([{ event: a }, { event: b }]);
      await drain();
      assert.equal((await p.visible(site)).length, 2);
      return { events: 2, partition: route(a) };
    });
    await test('strict routing preserves takeover fencing and reset barriers', async () => {
      const site = `${run}_takeover`;
      await p.addSites(site);
      const first = event(site);
      await p.enqueue([{ event: first }]);
      const held = actor(
        ['experiments/ch-prototype/round2-actor.ts', run, 'once', String(route(first))],
        'after_lookup',
      );
      await held.marker();
      const next = await p.claim([route(first)]);
      await p.process(next);
      await p.derive();
      await held.release();
      assert.equal((await held.ended).code, 0, held.error());
      assert.deepEqual(
        (await p.visible(site)).map(r => r.event_id),
        [first.id],
      );
      const resetSite = `${run}_reset`;
      await p.addSites(resetSite);
      const before = event(resetSite);
      await p.enqueue([{ event: before }]);
      const old = actor(
        ['experiments/ch-prototype/round2-actor.ts', run, 'once', String(route(before))],
        'after_lookup',
      );
      await old.marker();
      const deletion = await p.beginDelete(resetSite, before.session, randomUUID(), true);
      await p.activateDelete(deletion);
      await old.release();
      assert.equal((await old.ended).code, 0, old.error());
      await drain();
      assert.equal((await p.visible(resetSite)).length, 0);
      const after = { ...before, id: randomUUID() };
      await p.enqueue([{ event: after }]);
      await drain();
      assert.deepEqual(
        (await p.visible(resetSite)).map(r => r.event_id),
        [after.id],
      );
      return { takeoverVisible: 1, preResetVisible: 0, postResetVisible: 1 };
    });
    await test('consumer quarantines invalid partition and routing version', async () => {
      const site = `${run}_invalid`;
      await p.addSites(site);
      const a = event(site),
        b = event(site);
      await assert.rejects(
        () => p.enqueue([{ event: a, partition: 1 - route(a) }]),
        /partition mismatch/,
      );
      await p.producer.sendBatch({
        acks: -1,
        topicMessages: [
          {
            topic: p.inputTopic,
            messages: [
              {
                partition: 1 - route(a),
                value: JSON.stringify({ ...a, routingVersion: ROUTING_VERSION }),
              },
              { partition: route(b), value: JSON.stringify({ ...b, routingVersion: 99 }) },
            ],
          },
        ],
      });
      await drain();
      assert.equal((await p.visible(site)).length, 0);
      const reasons = (
        await p.pool.query('SELECT reason FROM proto_quarantine WHERE run=$1 ORDER BY reason', [
          run,
        ])
      ).rows.map(r => r.reason);
      assert.deepEqual(reasons, ['routing-partition', 'routing-version']);
      return { reasons };
    });
    await test('HTTP ingress uses the pinned default partition route', async () => {
      const site = `${run}_http`;
      await p.addSites(site);
      const worker = actor(['experiments/ch-prototype/round2-actor.ts', run, 'worker', '0,1']);
      await worker.marker('ready');
      const api = actor(['experiments/ch-prototype/round2-actor.ts', run, 'http', '0'], '', {
        PROTO_HTTP_TIMEOUT: '15000',
      });
      const ready = await api.marker('ready');
      try {
        const expected = [event(site, 0), event(site, 1)];
        for (const e of expected) {
          const res = await fetch(`http://127.0.0.1:${ready.address.port}/browser`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(e),
            signal: AbortSignal.timeout(20000),
          });
          assert.equal(res.status, 200);
        }
        const actual = (await p.snapshot()).filter(i => i.value.site === site);
        assert.deepEqual(actual.map(i => i.partition).sort(), [0, 1]);
        return { partitions: [0, 1], requests: 2 };
      } finally {
        worker.child.kill('SIGTERM');
        api.child.kill('SIGTERM');
        await Promise.all([worker.ended, api.ended]);
      }
    });
    for (const point of ['after_backfill_subbatch', 'before_backfill_commit'])
      await test(`page crash: ${point}`, async () => {
        const kind = `${run}_${point}`;
        const a = actor(['experiments/ch-prototype/round3-proof.ts', 'page', run, kind], point);
        await a.marker();
        a.child.kill('SIGKILL');
        assert.equal((await a.ended).signal, 'SIGKILL');
        assert.equal(
          (await p.pool.query('SELECT count(*)::int n FROM r3_facts WHERE kind=$1', [kind])).rows[0]
            .n,
          0,
        );
        assert.equal(
          (await p.pool.query('SELECT count(*)::int n FROM r3_page WHERE kind=$1', [kind])).rows[0]
            .n,
          0,
        );
        await pageAttempt(kind);
        return assertPage(kind);
      });
    await test('page COMMIT succeeds while its reply is lost; retry reuses publication', async () => {
      const kind = `${run}_commit_reply`,
        proxy = await commitReplyProxy();
      try {
        const a = actor(['experiments/ch-prototype/round3-proof.ts', 'page', run, kind], '', {
          PROTO_PROXY_PORT: String(proxy.port),
        });
        assert.equal((await a.ended).code, 2, a.error());
        assert.ok(proxy.dropped());
      } finally {
        await proxy.close();
      }
      const old = (await p.pool.query('SELECT candidate FROM r3_page WHERE kind=$1', [kind]))
        .rows[0].candidate;
      assert.equal(await pageAttempt(kind), old);
      const evidence = await assertPage(kind);
      const rows = await p.rows(
        'SELECT count() n FROM liekan_ch_proto.proof_facts WHERE kind={kind:String}',
        { kind },
      );
      assert.equal(Number(rows[0].n), 12000);
      await assert.rejects(
        () =>
          commitBackfillPage(
            p,
            {
              kind,
              cursor: '12000',
              candidate: randomUUID(),
              values: pageValues(kind),
              hash: 'changed',
            },
            'r3',
          ),
        /source changed/,
      );
      return { ...evidence, commitReplyDropped: true, candidateReused: true };
    });
    await test('same topic identity with a changed partition count is rejected', async () => {
      await p.admin.createPartitions({ topicPartitions: [{ topic: p.inputTopic, count: 3 }] });
      // A new partition elects its leader asynchronously; do not confuse that with the invariant.
      await until(async () => {
        try {
          const meta = await p.admin.fetchTopicMetadata({ topics: [p.inputTopic] });
          return (
            meta.topics[0]?.partitions.length === 3 &&
            meta.topics[0].partitions.every(x => x.leader >= 0)
          );
        } catch (e) {
          if (/leader|leadership election/.test(String(e))) return false;
          throw e;
        }
      });
      await assert.rejects(() => p.validateTopic(), /partition count changed/);
      return { old: 2, new: 3 };
    });
    report.passed = report.tests.filter((t: any) => t.status === 'passed').length;
    report.failed = 0;
  } catch (e) {
    report.failed = 1;
    console.error(e);
    process.exitCode = 1;
  } finally {
    report.passed = report.tests.filter((t: any) => t.status === 'passed').length;
    report.notRun = report.tests.filter((t: any) => t.status === 'not-run').length;
    clearTimeout(globalTimer);
    for (const c of children) c.kill('SIGKILL');
    await p.disconnect();
    await writeFile(resolve(OUTPUT, `${run}-proof.json`), JSON.stringify(report, null, 2));
    console.log(`REPORT ${run}-proof.json`);
  }
}
