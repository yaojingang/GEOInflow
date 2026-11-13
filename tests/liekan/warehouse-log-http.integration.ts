// A bounded real-HTTP log upload and mixed-read baseline on the separately
// restored Docker installation. This is not production-scale capacity approval.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

assert.equal(process.env.WAREHOUSE_DOCKER_TEST, 'isolated-new-project');
const fresh = process.env.WAREHOUSE_LOG_HTTP_FRESH_DIRECTORY;
const directory = resolve(fresh ?? '.local/ch-deploy-validation');
assert.ok(directory.startsWith(`${resolve('.local')}/`));
const recovery = !fresh ? JSON.parse(await readFile(`${directory}/recovery.json`, 'utf8')) : null;
const state = fresh ? JSON.parse(await readFile(`${directory}/state.json`, 'utf8')) : null;
assert.ok(
  fresh ? state.steps.install?.passed : recovery.steps.verify?.passed,
  'Complete the isolated installation/recovery first',
);
if (fresh) assert.match(state.run, /^warehouse_fresh_\d+$/);
const env = fresh
  ? {
      POSTGRES_USER: 'liekan_ch_proto',
      POSTGRES_DB: state.run,
      POSTGRES_PASSWORD: (
        await readFile('.local/kafka-validation-20261104/pg-password', 'utf8')
      ).trim(),
    }
  : Object.fromEntries(
      (await readFile(`${directory}/private.env`, 'utf8'))
        .split('\n')
        .filter(line => line && !line.startsWith('#'))
        .map(line => {
          const equal = line.indexOf('=');
          return [line.slice(0, equal), line.slice(equal + 1)];
        }),
    );
const db = new pg.Client({
  host: '127.0.0.1',
  port: 25479,
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DB,
  options: '-c default_transaction_read_only=on -c statement_timeout=30000',
});
const limits = { batches: 10, rowsPerBatch: 1000, uploadConcurrency: 2, drainTimeoutMs: 180000 };
const report: any = {
  limits,
  capacityAcceptance: false,
  source: 'isolated synthetic HTTP',
  cases: [],
};
const ackMs: number[] = [],
  queryMs: number[] = [];
const queryFailures: { status?: number; code: string }[] = [];
let uploadStart: number | undefined, queuedAt: number | undefined, publishedAt: number | undefined;
let last: any,
  maxWaitingLocks = 0;
let owner: string,
  queryErrors = 0,
  readActive = true,
  probe: Promise<void> | undefined;
const site = randomUUID(),
  generation = randomUUID();
async function request(path: string, body?: object, token = owner) {
  const response = await fetch(`http://127.0.0.1:3002${path}`, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(65000),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
const percentile = (numbers: number[], p: number) =>
  [...numbers].sort((a, b) => a - b)[
    Math.min(numbers.length - 1, Math.ceil(numbers.length * p) - 1)
  ] ?? null;
try {
  await db.connect();
  const installation = (
    await db.query(
      'SELECT installation_id,topic_name FROM liekan_warehouse_installation WHERE id=1',
    )
  ).rows[0];
  assert.equal(
    fresh ? installation.topic_name : installation.installation_id,
    fresh ? state.run : recovery.initial.installation_id,
  );
  const login = await request(
    '/api/auth/login',
    fresh
      ? { username: 'isolated-customized-admin', password: 'isolated-customized-password' }
      : { username: 'admin', password: 'liekan' },
  );
  assert.equal(login.status, 200);
  owner = login.body.token;
  const created = await request('/api/websites', {
    id: site,
    name: 'Log HTTP baseline (isolated synthetic)',
    domain: 'logs-baseline.invalid',
  });
  assert.equal(created.status, 200);
  const paired = await request(`/api/liekan/websites/${site}/log-sources/server/pairing`, {
    runtime: 'docker',
  });
  assert.equal(
    paired.status,
    200,
    `Installed signed collector package and readiness: ${paired.status === 200 ? 'ready' : JSON.stringify(paired.body)}`,
  );
  const connection = await request(
    '/api/liekan/collectors/pair',
    { code: paired.body.pairingCode, websiteId: site },
    '',
  );
  assert.equal(connection.status, 200);
  const { sourceId, token, epoch } = connection.body;
  assert.equal(
    (
      await request(
        `/api/liekan/log-sources/${sourceId}/heartbeat`,
        {
          version: '1',
          pending: 0,
          bytes: 0,
          gap: false,
          errorCode: 'none',
        },
        token,
      )
    ).status,
    200,
  );
  const started = Date.now();
  const range = new URLSearchParams({
    resource: 'logs',
    startAt: String(started - 3600000),
    endAt: String(started + 3600000),
    timezone: 'UTC',
    page: '1',
    pageSize: '20',
  });
  const path = `/api/liekan/websites/${site}/page-report?${range}`;
  const empty = await request(path);
  assert.equal(empty.status, 200, 'An empty browser population must not break a log report');
  assert.equal(empty.body.meta.totalLogs, 0);
  report.cases.push({ name: 'Empty browser population on a logs-only website', status: 'pass' });
  probe = (async () => {
    while (readActive) {
      const start = performance.now();
      try {
        const response = await request(path);
        if (response.status !== 200) {
          if (queryFailures.length < 20)
            queryFailures.push({
              status: response.status,
              code:
                typeof response.body?.error?.code === 'string'
                  ? response.body.error.code
                  : 'http-error',
            });
          throw new Error('concurrent-report-failed');
        }
        queryMs.push(performance.now() - start);
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError' && queryFailures.length < 20)
          queryFailures.push({ code: 'request-timeout' });
        queryErrors++;
      }
      if (readActive) await delay(1000);
    }
  })();
  // All records use real current timestamps after source activation. Each path
  // is unique, so compression by a small repeated-path fixture cannot hide loss.
  const at = new Date(Date.now() + 1000);
  const timestamp = `${String(at.getUTCDate()).padStart(2, '0')}/${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][at.getUTCMonth()]}/${at.getUTCFullYear()}:${at.toISOString().slice(11, 19)} +0000`;
  const uploads = Array.from({ length: limits.batches }, (_, batch) => ({
    version: 1,
    epoch,
    batchId: randomUUID(),
    events: Array.from({ length: limits.rowsPerBatch }, (_, index) => {
      const offset = batch * limits.rowsPerBatch + index;
      return {
        generation,
        offset,
        line: `192.0.2.5 - - [${timestamp}] "GET /baseline/${offset} HTTP/1.1" 200 25 "-" "GPTBot"`,
      };
    }),
  }));
  await delay(1100);
  let next = 0;
  uploadStart = performance.now();
  await Promise.all(
    Array.from({ length: limits.uploadConcurrency }, async () => {
      for (;;) {
        const index = next++;
        if (index >= uploads.length) return;
        const start = performance.now();
        const response = await request(
          `/api/liekan/log-sources/${sourceId}/batches`,
          uploads[index],
          token,
        );
        assert.equal(response.status, 200, `Batch ${index} durable acknowledgment`);
        assert.equal(response.body.requestBatchId, uploads[index].batchId);
        assert.equal(response.body.received, limits.rowsPerBatch);
        assert.equal(response.body.valid, limits.rowsPerBatch);
        assert.equal(response.body.rejected, 0);
        ackMs.push(performance.now() - start);
      }
    }),
  );
  queuedAt = performance.now();
  const duplicate = await request(`/api/liekan/log-sources/${sourceId}/batches`, uploads[0], token);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  do {
    const sample = (
      await db.query(
        `SELECT count(*) FILTER(WHERE status='processed')::integer AS done,
      coalesce(sum(expected),0)::integer AS expected,coalesce(sum(processed),0)::integer AS processed
      FROM liekan_warehouse_upload WHERE website_id=$1`,
        [site],
      )
    ).rows[0];
    maxWaitingLocks = Math.max(
      maxWaitingLocks,
      Number(
        (
          await db.query(`SELECT count(*)::integer AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`)
        ).rows[0].n,
      ),
    );
    last = sample;
    if (sample.done === limits.batches) break;
    if (performance.now() - queuedAt >= limits.drainTimeoutMs)
      throw new Error('Bounded mixed-load backlog did not drain');
    await delay(1000);
  } while (true);
  assert.equal(last.expected, limits.batches * limits.rowsPerBatch);
  assert.equal(last.processed, last.expected);
  publishedAt = performance.now();
  readActive = false;
  await probe;
  assert.ok(queryMs.length > 0);
  assert.equal(queryErrors, 0);
  const result = await request(path);
  assert.equal(result.status, 200);
  assert.equal(
    result.body.meta.totalLogs,
    last.expected,
    'Real full log-list count after duplicate retry',
  );
  assert.equal(
    (await db.query('SELECT count(*)::text AS n FROM liekan_log WHERE website_id=$1', [site]))
      .rows[0].n,
    '0',
  );
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::text AS n FROM liekan_ingest_batch
    WHERE website_id=$1 AND payload IS NOT NULL`,
        [site],
      )
    ).rows[0].n,
    '0',
  );
  report.cases.push({
    name: 'HTTP pairing, batch ingestion, concurrent full log reads, retry and PG fact isolation',
    status: 'pass',
  });
} catch (error) {
  report.cases.push({
    status: 'failed',
    error: error instanceof Error ? error.message : 'unknown',
  });
  process.exitCode = 1;
} finally {
  readActive = false;
  await probe?.catch(() => {});
  report.measurements = {
    acknowledgedRows: ackMs.length * limits.rowsPerBatch,
    processedRows: last?.processed ?? null,
    uploadMs: queuedAt && uploadStart ? queuedAt - uploadStart : null,
    totalPublicationMs: publishedAt && uploadStart ? publishedAt - uploadStart : null,
    drainMs: publishedAt && queuedAt ? publishedAt - queuedAt : null,
    ackP95Ms: percentile(ackMs, 0.95),
    ackP99Ms: percentile(ackMs, 0.99),
    queryP95Ms: percentile(queryMs, 0.95),
    queryP99Ms: percentile(queryMs, 0.99),
    querySamples: queryMs.length,
    queryErrors,
    queryFailures,
    maxWaitingLocks,
    expectedDistinctPaths: limits.batches * limits.rowsPerBatch,
  };
  await db.end();
  await writeFile(`${directory}/log-http-report.json`, JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
