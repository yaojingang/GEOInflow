// Drive the real warehouse API from two independent schedules. Setup and fixture
// restoration are separate: this runner may write only to a pre-paired synthetic source.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { stableUuid } from '../../src/lib/liekan/log-ingestion/protocol';
import { dashboardWarmRanges } from '../../src/lib/liekan/upstream/dashboard-snapshot-model';

type Sample = {
  kind: 'upload' | 'overview';
  ordinal: number;
  range?: number;
  plannedAt: number;
  submittedAt?: number;
  terminalAt?: number;
  initialStatus?: number;
  status?: number;
  errorCode?: string;
  outcome?: string;
  accepted202?: number;
  retries?: number;
  previousSeen?: boolean;
  cache?: string;
  instrumentedLogsMs?: number;
  snapshotThrough?: number;
  snapshotPublication?: string;
  batch?: string;
  publishedObservedAt?: number;
  publicationObserved?: string;
  inserted?: number;
};
type Requester = (path: string) => Promise<Response>;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const transient = [429, 502, 503, 504];
const terminalJobs = ['failed', 'invalidated', 'expired'];
const reportBudgetMs = 65000;
const now = () => performance.timeOrigin + performance.now();
const ranges = [7, 30] as const;
const interval = 10000;
const rowsPerRequest = 1000;
const requestsPerWave = 10;

function planWindow(start: number, waveCount: number) {
  const uploads: Sample[] = [],
    reads: Sample[] = [];
  for (let i = 0; i < waveCount; i++) {
    const plannedAt = start + i * interval;
    for (let j = 0; j < requestsPerWave; j++)
      uploads.push({
        kind: 'upload',
        ordinal: i * requestsPerWave + j,
        plannedAt: plannedAt + j * 1000,
      });
    for (const range of ranges) reads.push({ kind: 'overview', ordinal: i, range, plannedAt });
  }
  return { uploads, reads };
}

async function drive(
  samples: Sample[],
  cap: number,
  work: (sample: Sample) => Promise<void>,
  slackMs = 1000,
) {
  let active = 0;
  await Promise.all(
    samples.map(async sample => {
      const wait = sample.plannedAt - now();
      if (wait > 0) await delay(wait);
      if (active >= cap || now() - sample.plannedAt > slackMs) {
        sample.outcome =
          now() - sample.plannedAt > slackMs ? 'missed-schedule' : 'missed-inflight-cap';
        sample.terminalAt = now();
        return;
      }
      active++;
      sample.submittedAt = now();
      try {
        await work(sample);
      } catch (error) {
        sample.outcome =
          error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
            ? 'deadline'
            : 'transport-or-invalid-json';
      } finally {
        sample.terminalAt = now();
        active--;
      }
    }),
  );
}

async function overview(
  sample: Sample,
  path: string,
  site: string,
  send: Requester,
  signal: AbortSignal,
  poll: (ms: number) => Promise<unknown> = ms => delay(ms, undefined, { signal }),
) {
  const deadline = performance.now() + reportBudgetMs;
  let response = await send(path);
  sample.initialStatus = response.status;
  sample.status = response.status;
  sample.retries = 0;
  if (transient.includes(response.status)) {
    const seconds = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(seconds) && seconds > 0 ? Math.max(1000, seconds * 1000) : 1000;
    if (performance.now() + waitMs < deadline) {
      sample.retries++;
      await response.body?.cancel();
      await poll(waitMs);
      response = await send(path);
    }
  }
  const body = () => response.json() as Promise<any>;
  let value = await body();
  sample.accepted202 = 0;
  if (response.status === 202) {
    sample.accepted202++;
    const job = value?.analysisJob;
    if (
      !job ||
      job.websiteId !== site ||
      !uuid.test(job.id) ||
      !['analytics-jobs', 'overview-jobs'].some(
        kind => job.resultUrl === `/liekan/websites/${site}/${kind}/${job.id}/result`,
      )
    ) {
      sample.outcome = 'invalid-job';
      return;
    }
    const result = `/api${job.resultUrl}`;
    let current = job;
    sample.previousSeen = value.previousResult !== undefined;
    for (;;) {
      signal.throwIfAborted();
      if (terminalJobs.includes(current.status)) {
        sample.outcome = `job-${current.status}`;
        return;
      }
      await poll(Math.max(1000, Math.min(10000, Number(current.retryAfterMs) || 3000)));
      response = await send(result.slice(0, -'/result'.length));
      value = await body();
      if (response.status === 503 && value?.error?.code === 'analysis-read-busy') {
        sample.retries++;
        continue;
      }
      current = value?.analysisJob;
      if (!response.ok || current?.id !== job.id || current?.resultUrl !== job.resultUrl) {
        sample.outcome = 'job-status-error';
        return;
      }
      if (current.status !== 'ready') continue;
      response = await send(result);
      value = await body();
      if (response.status === 503 && value?.error?.code === 'analysis-read-busy') {
        sample.retries++;
        continue;
      }
      if (response.status !== 202) break;
      sample.accepted202++;
    }
  }
  sample.status = response.status;
  const errorCode = value?.error?.code;
  if (typeof errorCode === 'string' && /^[a-z0-9-]{1,80}$/i.test(errorCode))
    sample.errorCode = errorCode;
  const cache = response.headers.get('x-liekan-cache');
  if (cache && ['hit', 'miss', 'coalesced'].includes(cache)) sample.cache = cache;
  const logsMs = response.headers.get('server-timing')?.match(/(?:^|,\s*)report-logs;dur=([\d.]+)/);
  if (logsMs) sample.instrumentedLogsMs = Number(logsMs[1]);
  const through = value?.meta?.snapshot?.dataThrough;
  if (typeof through === 'number' && Number.isFinite(through)) sample.snapshotThrough = through;
  const publication = response.headers.get('x-liekan-warehouse-publication');
  if (publication && /^\d+$/.test(publication)) sample.snapshotPublication = publication;
  sample.outcome =
    response.status === 200
      ? value?.resource === 'overview' &&
        value?.states?.catalog === 'available' &&
        value?.states?.logs === 'available' &&
        value?.states?.human === 'available' &&
        value?.meta?.snapshot?.state !== 'updating' &&
        !value?.meta?.snapshot?.updateError
        ? 'ok'
        : 'incomplete-overview'
      : `http-${response.status}`;
}

function p95(numbers: number[]) {
  return [...numbers].sort((a, b) => a - b)[Math.ceil(numbers.length * 0.95) - 1] ?? null;
}
function metrics(samples: Sample[]) {
  const ok = samples.filter(
    (s): s is Sample & { terminalAt: number; submittedAt: number } =>
      s.outcome === 'ok' && s.submittedAt !== undefined && s.terminalAt !== undefined,
  );
  const counts: Record<string, number> = {};
  for (const s of samples)
    counts[s.outcome ?? 'unaccounted'] = (counts[s.outcome ?? 'unaccounted'] ?? 0) + 1;
  return {
    planned: samples.length,
    submitted: samples.filter(s => s.submittedAt !== undefined).length,
    outcomes: counts,
    retries: samples.reduce((n, s) => n + (s.retries ?? 0), 0),
    pendingResponses: samples.reduce((n, s) => n + (s.accepted202 ?? 0), 0),
    submissionToCompleteP95Ms: p95(ok.map(s => s.terminalAt - s.submittedAt)),
    planToCompleteP95Ms: p95(ok.map(s => s.terminalAt - s.plannedAt)),
    instrumentedLogsGroupSamples: ok.filter(s => s.instrumentedLogsMs !== undefined).length,
    instrumentedLogsGroupP95Ms: p95(
      ok.flatMap(s => (s.instrumentedLogsMs === undefined ? [] : [s.instrumentedLogsMs])),
    ),
    coverageSamples: ok.filter(s => s.snapshotThrough !== undefined).length,
    snapshotPublicationSamples: ok.filter(s => s.snapshotPublication !== undefined).length,
    snapshotClockAgeP95Ms: p95(
      ok.flatMap(s => (s.snapshotThrough === undefined ? [] : [s.terminalAt - s.snapshotThrough])),
    ),
  };
}
async function run() {
  assert.equal(process.env.WAREHOUSE_DOCKER_TEST, 'isolated-new-project');
  const local = await realpath(resolve('.local'));
  const file = await realpath(resolve(process.argv[2] ?? 'missing-config'));
  assert.ok(
    file.startsWith(`${local}/`) && ((await stat(file)).mode & 0o777) === 0o600,
    'private-config-required',
  );
  const c = JSON.parse(await readFile(file, 'utf8'));
  const mode = process.argv[3];
  assert.ok(mode === 'smoke' || mode === 'baseline');
  assert.match(c.origin, /^http:\/\/127\.0\.0\.1:(3002|3012)$/);
  assert.match(c.database, /^warehouse_(fresh|baseline)_\d+$/);
  assert.ok([25479, 25489].includes(c.pgPort));
  for (const id of [c.site, c.source, c.installationId]) assert.ok(uuid.test(id));
  assert.match(c.sourceToken, /^[a-z0-9_-]{43}$/i);
  assert.ok(Number.isSafeInteger(c.epoch) && c.epoch > 0);
  assert.ok(c.cacheMode === 'bypass' || c.cacheMode === 'normal');
  assert.ok(c.presetRanges === undefined || typeof c.presetRanges === 'boolean');
  assert.match(c.fixtureSha256, /^[a-f0-9]{64}$/);
  assert.match(c.revision, /^[a-f0-9]{40}$/);
  if (c.candidateDigest !== undefined) assert.match(c.candidateDigest, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(c.rangeEnd) && c.rangeEnd - Date.now() <= 86400000);
  assert.ok(Number.isSafeInteger(c.catalogPaths) && c.catalogPaths > 0);
  assert.ok(Number.isSafeInteger(c.browserEvents30d) && c.browserEvents30d > 0);
  assert.ok(Number.isSafeInteger(c.logs30d) && c.logs30d > 0);
  const db = new pg.Client({
    host: '127.0.0.1',
    port: c.pgPort,
    database: c.database,
    user: c.pgUser,
    password: c.pgPassword,
    connectionTimeoutMillis: 3000,
    options: '-c default_transaction_read_only=on -c statement_timeout=5000',
  });
  const send = (path: string, token: string, signal: AbortSignal, payload?: object) =>
    fetch(c.origin + path, {
      method: payload ? 'POST' : 'GET',
      signal,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(payload ? {} : { Prefer: 'respond-async' }),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
  const samples: Sample[] = [];
  const observations: { observedAt: number; publication?: string; [key: string]: unknown }[] = [];
  const waveCount = mode === 'smoke' ? 30 : 180;
  const wallStart = Date.now();
  const rangeEnd = c.rangeEnd;
  assert.ok(
    rangeEnd >= wallStart + waveCount * interval + 140000,
    'fixed-range-does-not-cover-window',
  );
  const out = resolve(dirname(file), `overview-${mode}-${wallStart}.json`);
  const report: Record<string, unknown> = {
    mode,
    waveCount,
    samples,
    observations,
    fixture: {
      sha256: c.fixtureSha256,
      revision: c.revision,
      candidateDigest: c.candidateDigest,
      rangeEnd,
      catalogPaths: c.catalogPaths,
      browserEvents30d: c.browserEvents30d,
      logs30d: c.logs30d,
    },
    capacityAccepted: false,
    cacheMode: c.cacheMode,
    presetRanges: Boolean(c.presetRanges),
    phase: 'preflight',
  };
  try {
    await db.connect();
    const initial = (
      await db.query(
        `SELECT i.installation_id,i.authority,i.transition,i.topic_name,s.publication::text,s.epoch::text,
        ls.epoch AS source_epoch,
        s.catalog_revision::text,s.deletion_revision::text,w.domain,
        (SELECT count(*)::int FROM liekan_catalog WHERE website_id=w.website_id) AS catalog
       FROM website w JOIN liekan_warehouse_site s USING(website_id)
       JOIN liekan_log_source l ON l.website_id=w.website_id
       JOIN liekan_log_state ls ON ls.website_id=w.website_id
       CROSS JOIN liekan_warehouse_installation i
       WHERE i.id=1 AND w.website_id=$1::uuid AND l.id=$2::uuid
         AND l.kind='server' AND l.state='active' AND s.state='active'
         AND l.domain=w.domain AND EXISTS (SELECT 1 FROM liekan_log_interval li
           WHERE li.website_id=w.website_id AND li.source_id=l.id AND li.ends_at IS NULL)`,
        [c.site, c.source],
      )
    ).rows[0];
    assert.ok(
      initial &&
        initial.installation_id === c.installationId &&
        initial.authority === 'clickhouse' &&
        ['none', 'exited'].includes(initial.transition) &&
        initial.domain === c.domain &&
        initial.domain.endsWith('.invalid') &&
        initial.catalog === c.catalogPaths &&
        initial.topic_name === c.database &&
        Number(initial.source_epoch) === c.epoch &&
        BigInt(initial.publication) > 0n,
      'fixture-identity',
    );
    // A successful read also proves the HTTP process can access the same random site.
    const siteResponse = await send(
      `/api/websites/${c.site}`,
      c.ownerToken,
      AbortSignal.timeout(5000),
    );
    assert.equal(siteResponse.status, 200);
    const site = await siteResponse.json();
    assert.ok(site.id === c.site && site.domain === c.domain, 'http-site-identity');
    const generation = randomUUID();
    const url = `/api/liekan/websites/${c.site}/page-report`;
    const [, last7, last30] = dashboardWarmRanges('UTC', wallStart);
    const path = (days: number) =>
      url +
      '?' +
      new URLSearchParams({
        resource: 'overview',
        startAt: String(
          c.presetRanges ? (days === 7 ? last7 : last30).startAt : rangeEnd - days * 86400000,
        ),
        endAt: String(c.presetRanges ? (days === 7 ? last7 : last30).endAt : rangeEnd),
        timezone: 'UTC',
        ...(c.presetRanges ? { chartPeriod: days === 7 ? '7d' : '30d' } : {}),
        page: '1',
        pageSize: '20',
        ...(c.cacheMode === 'bypass' ? { refresh: '1' } : {}),
      });
    // Verify both ranges before scheduling. Warm-up is deliberately reported apart.
    const warmups: Sample[] = [];
    report.warmup = warmups;
    for (const days of ranges) {
      const warmup: Sample = { kind: 'overview', range: days, ordinal: -1, plannedAt: now() };
      warmups.push(warmup);
      await drive([warmup], 1, s => {
        const signal = AbortSignal.timeout(reportBudgetMs);
        return overview(s, path(days), c.site, p => send(p, c.ownerToken, signal), signal);
      });
    }
    // Even if a warm-up fails, its error and the scheduled window are evidence.
    const start = now() + 3000;
    assert.ok(start + waveCount * interval <= rangeEnd, 'range-ended-before-window');
    if (warmups.some(s => s.outcome === 'incomplete-overview')) {
      report.phase = 'fixture-incomplete';
      process.exitCode = 1;
      return;
    }
    const { uploads, reads } = planWindow(start, waveCount);
    const requestIds = new Map<number, string>();
    for (const upload of uploads) {
      const id = randomUUID();
      requestIds.set(upload.ordinal, id);
      upload.batch = stableUuid(`${c.source}:${c.epoch}:${id}`);
    }
    samples.push(...uploads, ...reads);
    const batchById = new Map(uploads.map(s => [s.batch, s]));
    let completed = false;
    let controlDrift = false;
    const observe = async () => {
      for (;;) {
        const observedAt = now();
        const rows = (
          await db.query(
            `SELECT s.publication::text,s.catalog_revision::text,s.deletion_revision::text,s.epoch::text,
             u.batch_id,u.status,u.inserted,u.queued FROM liekan_warehouse_site s
             LEFT JOIN liekan_warehouse_upload u ON u.website_id=s.website_id AND u.source_id=$2::uuid
                AND u.batch_id=ANY($3::uuid[])
           WHERE s.website_id=$1::uuid`,
            [c.site, c.source, [...batchById.keys()]],
          )
        ).rows;
        if (
          !rows[0] ||
          rows[0].epoch !== initial.epoch ||
          rows[0].catalog_revision !== initial.catalog_revision ||
          rows[0].deletion_revision !== initial.deletion_revision
        )
          controlDrift = true;
        observations.push({
          observedAt,
          publication: rows[0]?.publication,
          catalogRevision: rows[0]?.catalog_revision,
          deletionRevision: rows[0]?.deletion_revision,
          epoch: rows[0]?.epoch,
          queued: rows.filter(r => r.queued).length,
          processed: rows.filter(r => r.status === 'processed').length,
        });
        for (const r of rows) {
          const s = batchById.get(r.batch_id);
          if (!s) continue;
          s.inserted = r.inserted;
          if (r.status === 'processed' && s.publishedObservedAt === undefined) {
            s.publishedObservedAt = now();
            s.publicationObserved = r.publication;
          }
        }
        if (
          (completed &&
            !uploads.some(
              s => s.submittedAt !== undefined && s.publishedObservedAt === undefined,
            )) ||
          now() >= start + waveCount * interval + 180000
        )
          break;
        await delay(1000);
      }
    };
    report.phase = 'measuring';
    console.log(
      JSON.stringify({
        phase: report.phase,
        start: new Date(start).toISOString(),
        plannedUploads: uploads.length,
        plannedReads: reads.length,
      }),
    );
    await Promise.all([
      observe().catch(() => {
        report.observer = 'failed';
      }),
      Promise.all([
        drive(uploads, 30, async s => {
          const time = new Date();
          const t = `${time.toISOString().slice(8, 10)}/${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][time.getUTCMonth()]}/${time.getUTCFullYear()}:${time.toISOString().slice(11, 19)} +0000`;
          const signal = AbortSignal.timeout(65000);
          const payload = {
            version: 1,
            epoch: c.epoch,
            batchId: requestIds.get(s.ordinal),
            events: Array.from({ length: rowsPerRequest }, (_, n) => {
              const offset = s.ordinal * rowsPerRequest + n;
              return {
                generation,
                offset,
                line: `192.0.2.5 - - [${t}] "GET /baseline/${generation}/${offset} HTTP/1.1" 200 25 "-" "GPTBot"`,
              };
            }),
          };
          const request = () =>
            send(`/api/liekan/log-sources/${c.source}/batches`, c.sourceToken, signal, payload);
          let response = await request();
          if (transient.includes(response.status)) {
            s.retries = 1;
            await response.body?.cancel();
            await delay(1000, undefined, { signal });
            response = await request();
          }
          s.status = response.status;
          const ack = await response.json();
          s.outcome =
            response.status !== 200
              ? `http-${response.status}`
              : ack.requestBatchId === payload.batchId &&
                  ack.batchId === s.batch &&
                  ack.received === rowsPerRequest &&
                  ack.valid === rowsPerRequest &&
                  ack.rejected === 0
                ? 'ok'
                : 'invalid-ack';
        }),
        drive(reads, 16, s => {
          assert.ok(s.range === 7 || s.range === 30);
          const signal = AbortSignal.timeout(reportBudgetMs);
          return overview(s, path(s.range), c.site, p => send(p, c.ownerToken, signal), signal);
        }),
      ]).finally(() => {
        completed = true;
      }),
    ]);
    const read7d = metrics(reads.filter(s => s.range === 7));
    const read30d = metrics(reads.filter(s => s.range === 30));
    const sampledPublicationGaps = reads.flatMap(sample => {
      const { terminalAt, snapshotPublication } = sample;
      if (sample.outcome !== 'ok' || snapshotPublication === undefined || terminalAt === undefined)
        return [];
      const observed = observations.findLast(v => v.observedAt <= terminalAt);
      if (!observed?.publication) return [];
      return [Math.max(0, Number(BigInt(observed.publication) - BigInt(snapshotPublication)))];
    });
    const readLatencyGate = [read7d, read30d].every(
      m =>
        m.outcomes.ok === m.planned &&
        m.submissionToCompleteP95Ms !== null &&
        m.submissionToCompleteP95Ms <= 10000,
    );
    const sendingEndsAt = start + waveCount * interval;
    const lastPublication = Math.max(...uploads.map(s => s.publishedObservedAt ?? 0));
    const allPublished = uploads.every(s => s.publishedObservedAt !== undefined);
    report.measurements = {
      uploads: metrics(uploads),
      reads: metrics(reads),
      read7d,
      read30d,
      readLatencyGate,
      controlDrift,
      acknowledgedRows: uploads.filter(s => s.outcome === 'ok').length * rowsPerRequest,
      insertedRows: uploads.reduce((n, s) => n + (s.inserted ?? 0), 0),
      rowsObservedPublishedAtEndOfInput:
        uploads.filter(s => (s.publishedObservedAt ?? Infinity) <= sendingEndsAt).length *
        rowsPerRequest,
      allBatchesPublishedAfterInputMs: allPublished ? lastPublication - sendingEndsAt : null,
      notObservedPublished: uploads.filter(s => s.publishedObservedAt === undefined).length,
      sampledPublicationGapCount: sampledPublicationGaps.length,
      sampledPublicationGapP95: p95(sampledPublicationGaps),
      sampledPublicationGapMax: sampledPublicationGaps.length
        ? Math.max(...sampledPublicationGaps)
        : null,
      reportCoverageExact: false,
      expensiveFallbackObserved: null,
    };
    report.phase = 'measured';
    if (
      samples.some(s => s.outcome !== 'ok') ||
      uploads.some(s => s.inserted !== rowsPerRequest) ||
      report.observer === 'failed' ||
      !readLatencyGate ||
      controlDrift
    )
      process.exitCode = 1;
  } finally {
    await db.end();
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(
      JSON.stringify({ output: out, phase: report.phase, measurements: report.measurements }),
    );
  }
}

async function selfTest() {
  for (const [waves, expectedReads] of [
    [30, 60],
    [180, 360],
  ]) {
    const { uploads, reads } = planWindow(0, waves);
    assert.equal(uploads.length, waves * 10);
    assert.equal(reads.length, expectedReads);
    assert.equal(uploads.at(-1)?.plannedAt, waves * interval - 1000);
    assert.ok(reads.filter(s => s.range === 7).every((s, i) => s.plannedAt === i * interval));
  }
  const site = randomUUID(),
    id = randomUUID();
  const job = {
    websiteId: site,
    id,
    resultUrl: `/liekan/websites/${site}/overview-jobs/${id}/result`,
  };
  const result = {
    resource: 'overview',
    states: { catalog: 'available', logs: 'available', human: 'available' },
  };
  const sample = (): Sample => ({ kind: 'overview', ordinal: 1, plannedAt: now() });
  const s = sample(),
    retried = sample(),
    fail = sample(),
    incomplete = sample();
  const json = (data: object, status = 200) => Response.json(data, { status });
  const responses = [
    json({ analysisJob: job, previousResult: result }, 202),
    json({ analysisJob: { ...job, status: 'running' } }),
    json({ analysisJob: { ...job, status: 'ready' } }),
    json({ analysisJob: job }, 202),
    json({ analysisJob: { ...job, status: 'ready' } }),
    json(result),
  ];
  const signal = AbortSignal.timeout(1000),
    noWait = () => Promise.resolve();
  const queue = (responses: Response[]) => async () => {
    const response = responses.shift();
    assert.ok(response, 'unexpected poll');
    return response;
  };
  await overview(s, '/page', site, queue(responses), signal, noWait);
  assert.equal(s.accepted202, 2);
  assert.equal(s.previousSeen, true);
  assert.equal(s.outcome, 'ok');
  const invalid = sample();
  await overview(
    invalid,
    '/page',
    site,
    queue([json({ analysisJob: { ...job, resultUrl: job.resultUrl + '?unexpected' } }, 202)]),
    signal,
    noWait,
  );
  assert.equal(invalid.outcome, 'invalid-job');
  await overview(
    retried,
    '/page',
    site,
    queue([Response.json({}, { status: 429, headers: { 'Retry-After': '5' } }), json(result)]),
    signal,
    async ms => assert.equal(ms, 5000),
  );
  assert.equal(retried.initialStatus, 429);
  assert.equal(retried.retries, 1);
  assert.equal(retried.outcome, 'ok');
  const failed = [
    json({ analysisJob: job }, 202),
    json({ analysisJob: { ...job, status: 'failed' } }),
  ];
  await overview(fail, '/page', site, queue(failed), signal, noWait);
  assert.equal(fail.outcome, 'job-failed');
  await overview(
    incomplete,
    '/page',
    site,
    async () => json({ ...result, states: {} }),
    signal,
    noWait,
  );
  assert.equal(incomplete.outcome, 'incomplete-overview');
  const slow = { ...sample(), kind: 'upload' as const },
    another = sample(),
    capped = sample();
  const overdue = { ...sample(), plannedAt: now() - 2000 };
  await Promise.all([
    drive([slow, capped], 1, async t => {
      await delay(20);
      t.outcome = 'ok';
    }),
    drive([another, overdue], 1, async t => {
      await delay(5);
      t.outcome = 'ok';
    }),
  ]);
  assert.ok(another.terminalAt !== undefined && slow.terminalAt !== undefined);
  assert.ok(another.terminalAt < slow.terminalAt, 'reader independent of writer');
  assert.equal(capped.outcome, 'missed-inflight-cap');
  assert.equal(overdue.outcome, 'missed-schedule');
  console.log('scheduler, pending-to-terminal, incomplete result, and missed-sample checks passed');
}

(process.argv[2] === '--self-test' ? selfTest() : run()).catch(() => {
  console.error('Overview baseline stopped; check the isolated fixture prerequisites and phase.');
  process.exitCode = 1;
});
