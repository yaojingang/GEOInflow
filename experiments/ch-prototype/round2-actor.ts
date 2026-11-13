import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { delay, type Event, fault, OUTPUT, Prototype, ROUND2 } from './core.ts';

assert.ok(ROUND2, 'round two actor requires its isolated environment');
const [run, command, arg = '0'] = process.argv.slice(2);
const p = new Prototype(run);
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});

/** Read only a confirmed decision; a broker acknowledgement is insufficient. */
async function decision(id: string) {
  const jobs = (
    await p.pool.query(
      `SELECT a.id FROM proto_attempt a JOIN proto_work w
    ON w.run=a.run AND w.attempt=a.id WHERE a.run=$1 AND a.status='confirmed' AND w.status='decided'`,
      [run],
    )
  ).rows;
  if (!jobs.length) return undefined;
  return (
    await p.rows(
      `SELECT verdict,original_session,original_visit FROM liekan_ch_proto.landing
    WHERE run={run:String} AND event_id={id:String} AND attempt IN {attempts:Array(String)}`,
      { run, id, attempts: jobs.map(j => j.id) },
    )
  )[0];
}

/** Run a localhost HTTP contract probe; no product API or external sink is connected. */
async function http() {
  const token = (await readFile(resolve(OUTPUT, 'pg-password'), 'utf8')).trim();
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !['/browser', '/logs'].includes(req.url ?? '')) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 65536) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const isLog = req.url === '/logs';
      if (isLog && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      if (!(await p.site(body.site))) {
        res.writeHead(404).end();
        return;
      }
      // Derive provenance at ingress. Session/visit values are explicit test fixtures here;
      // the product's actual identity derivation and trusted-proxy handling are not integrated.
      const event: Event = {
        id: randomUUID(),
        site: body.site,
        session: body.session ?? randomUUID(),
        visit: body.visit ?? randomUUID(),
        uuid: body.uuid,
        path: String(body.path ?? '/').slice(0, 1000),
        cents: Number(body.cents ?? 0),
        properties: {},
        kind: isLog ? 'log' : 'browser',
        source: isLog ? 'server_log' : 'browser',
        scope: isLog ? 'log' : 'browser_unresolved',
        policyVersion: 1,
        payload: {
          website: body.site,
          url: String(body.path ?? '/').slice(0, 1000),
          data: body.data ?? {},
          name: body.name ?? null,
          cents: Number(body.cents ?? 0),
          eventId: body.uuid,
        },
      };
      assert.ok(Number.isSafeInteger(event.cents));
      const accepted = await p.enqueue([{ event, ...(p.strictRouting ? {} : { partition: 0 }) }]);
      await fault('after_http_queue');
      if (isLog) {
        res
          .writeHead(202, { 'content-type': 'application/json' })
          .end(JSON.stringify({ status: 'queued', offset: accepted[0].baseOffset }));
        return;
      }
      const deadline = Date.now() + Number(process.env.PROTO_HTTP_TIMEOUT ?? 1000);
      while (Date.now() < deadline) {
        const result = await decision(event.id);
        if (result) {
          await fault('before_http_reply');
          res.writeHead(
            result.verdict === 'conflict' ? 409 : result.verdict === 'canceled' ? 410 : 200,
            { 'content-type': 'application/json' },
          );
          res.end(
            JSON.stringify({
              status: result.verdict,
              sessionId: result.original_session,
              visitId: result.original_visit,
            }),
          );
          return;
        }
        await delay(30);
      }
      res
        .writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' })
        .end(JSON.stringify({ status: 'undetermined' }));
    } catch {
      if (!res.headersSent) res.writeHead(503);
      res.end(JSON.stringify({ status: 'undetermined' }));
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  await writeFile(
    resolve(OUTPUT, `ready-${process.env.PROTO_ACTOR_ID}.json`),
    JSON.stringify({ pid: process.pid, address: server.address() }),
  );
  while (!stopping) await delay(50);
  await new Promise<void>(r => server.close(() => r()));
}

/** Own assigned partitions in a separate OS process and preserve the lease across iterations. */
async function worker() {
  const owners = await p.claim(arg.split(',').map(Number));
  await writeFile(
    resolve(OUTPUT, `ready-${process.env.PROTO_ACTOR_ID}.json`),
    JSON.stringify({ pid: process.pid, owners }),
  );
  do {
    await p.process(owners);
    await p.derive();
    if (command === 'once') break;
    await delay(75);
  } while (!stopping);
}

/** Follow real Kafka group assignments and fence a still-running worker after reassignment. */
async function groupWorker() {
  const consumer = p.kafka.consumer({
    groupId: `${run}_owners`,
    allowAutoTopicCreation: false,
    sessionTimeout: 60000,
    heartbeatInterval: 1000,
    rebalanceTimeout: 30000,
  });
  let owners: Record<number, number> = {},
    left = false;
  let assignmentTask = Promise.resolve();
  consumer.on(consumer.events.GROUP_JOIN, event => {
    const assigned: number[] = event.payload.memberAssignment[p.inputTopic] ?? [];
    assignmentTask = assignmentTask.then(async () => {
      owners = assigned.length ? await p.claim(assigned) : {};
      await writeFile(
        resolve(OUTPUT, `assignment-${process.env.PROTO_ACTOR_ID}.json`),
        JSON.stringify({
          pid: process.pid,
          partitions: assigned,
          owners,
          memberId: event.payload.memberId,
        }),
      );
    });
  });
  await consumer.connect();
  await consumer.subscribe({ topic: p.inputTopic, fromBeginning: true });
  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: true,
    eachBatch: async ({ heartbeat }) => {
      await heartbeat();
    },
  });
  const leave = (async () => {
    while (!stopping && !left) {
      if (
        await readFile(resolve(OUTPUT, `rebalance-${process.env.PROTO_ACTOR_ID}`)).then(
          () => true,
          () => false,
        )
      ) {
        await consumer.disconnect();
        left = true;
        break;
      }
      await delay(40);
    }
  })();
  try {
    while (!stopping && !left) {
      await assignmentTask;
      const current = owners;
      if (Object.keys(current).length) {
        try {
          await p.process(current);
          await p.derive();
        } catch (e) {
          if (!(e instanceof Error) || !e.message.includes('owner fenced')) throw e;
        }
      }
      await delay(75);
    }
  } finally {
    left = true;
    await consumer.disconnect();
    await leave;
  }
}

try {
  const require = createRequire(import.meta.url);
  await writeFile(
    resolve(OUTPUT, `deps-${process.env.PROTO_ACTOR_ID}.json`),
    JSON.stringify(
      ['pg', 'kafkajs', '@clickhouse/client'].map(name => ({ name, path: require.resolve(name) })),
    ),
  );
  await p.connect();
  if (command === 'http') await http();
  else if (command === 'group') await groupWorker();
  else await worker();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'round two actor failed');
  process.exitCode = 1;
} finally {
  await p.disconnect();
}
