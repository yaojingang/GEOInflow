// @vitest-environment node
// Every database, container, website and cache mutation belongs to the runner's labelled fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { hashSync } from 'bcryptjs';
import { Client } from 'pg';
import { it } from 'vitest';
import {
  readBenchmarkDemand,
  type BenchmarkCohort,
} from '../../../../scripts/liekan-dashboard-drain';
import {
  benchmarkBrowserHeaders,
  seedBenchmarkBrowserEvidence,
} from '../../../../scripts/liekan-benchmark-fixtures';
import { calendarDayRange } from '../contracts/calendar';
import { pageReportSchema } from '../contracts/page-report';
import {
  decodeAnalysisEnvelope,
  liveAnalysisTargets,
  stableAnalysisJson,
} from './analysis-query-model';

const enabled = process.env.LIEKAN_ANALYSIS_DASHBOARD_BENCHMARK === '1';
const folder = process.env.LIEKAN_ANALYSIS_ROLLUPS_OUTPUT;
const save = (name: string, value: unknown) =>
  writeFile(
    `${folder}/${name}`,
    JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v), 2),
    { mode: 0o600 },
  );
const summary = (values: number[]) => {
  const ordered = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? null;
  return { samples: values.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
};
function benchmarkRemaining(deadline: number, now = performance.now()) {
  const remaining = deadline - now;
  if (remaining <= 0)
    throw Object.assign(new Error('benchmark-deadline-exceeded'), {
      code: 'benchmark-deadline-exceeded',
    });
  return remaining;
}
async function benchmarkWait(
  ms: number,
  deadline: number,
  observation: any,
  sleep: (ms: number) => Promise<unknown> = pause,
  now = () => performance.now(),
) {
  const budget = benchmarkRemaining(deadline, now()),
    started = now();
  observation.scheduledWaitMs = ms;
  try {
    await sleep(Math.min(ms, budget));
  } finally {
    observation.waitMs = now() - started;
  }
  benchmarkRemaining(deadline, now());
}
function failedBenchmarkObservation(error: any, observation: any) {
  const code = error?.code || error?.name || 'transport-failed';
  return {
    ...observation,
    status: 0,
    body: null,
    contractValid: false,
    statisticsHash: null,
    errorCode: code,
    transportError: { code, name: error?.name || 'Error' },
    queueMs: observation.queueMs ?? null,
    serverQueueMs: observation.serverQueueMs ?? null,
  };
}
async function finishFixtureBuild(
  read: () => Promise<any>,
  run: () => Promise<{ worked: boolean }>,
  observe: (state: any, result?: { worked: boolean }) => Promise<void>,
  options: {
    limit?: number;
    timeoutMs?: number;
    now?: () => number;
    wallNow?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
  } = {},
) {
  const now = options.now || (() => performance.now()),
    wallNow = options.wallNow || (() => Date.now()),
    sleep = options.sleep || pause,
    begin = now(),
    deadline = begin + (options.timeoutMs ?? 1200000);
  let units = 0,
    idlePolls = 0;
  for (;;) {
    const row = await read();
    await observe(row);
    assert(now() < deadline, 'fixture-bounded-build-deadline');
    if (row.status === 'completed') return { units, idlePolls, wallMs: now() - begin };
    assert(
      !['failed', 'invalidated', 'capacity_limited', 'paused'].includes(row.status),
      `fixture rollup build failed: ${row.status}/${row.error_code}`,
    );
    assert(units < (options.limit ?? 10000), 'fixture-bounded-build-limit');
    const eligibleAt = Math.max(
      +new Date(row.next_attempt_at || 0),
      +new Date(row.lease_until || 0),
    );
    const waitMs = eligibleAt - (row.observed_at ? +new Date(row.observed_at) : wallNow());
    if (waitMs > 0) {
      await sleep(Math.min(waitMs, 1000, deadline - now()));
      idlePolls++;
      continue;
    }
    const result = await run();
    if (result.worked) units++;
    else idlePolls++;
    await observe(await read(), result);
    if (!result.worked) await sleep(Math.min(50, Math.max(0, deadline - now())));
  }
}
async function benchmarkFetchJson(
  target: string,
  init: RequestInit,
  timeoutMs: number,
  onResponse?: (value: { status: number; observedAt: number; requestMs: number }) => void,
  fetcher: typeof fetch = fetch,
) {
  const start = performance.now();
  const response = await fetcher(target, {
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
    ...init,
  });
  onResponse?.({
    status: response.status,
    observedAt: Date.now(),
    requestMs: performance.now() - start,
  });
  const body = await response.json();
  return { response, body, wallMs: performance.now() - start };
}
const digest = (value: unknown) =>
  createHash('sha256').update(stableAnalysisJson(value)).digest('hex');
// Population, identity, policy versions and selected/trend ranges are statistical output.
// Only publication clocks, UI snapshot state, permission projection and keyword read time vary by read.
const statisticalPayload = ({ meta, ...body }: any) => {
  const { generatedAt, expiresAt, snapshot, canManage, keywordReadAt, ...statistics } = meta;
  return { ...body, meta: statistics };
};
function producerStatisticsHash(result: unknown, site: string, website: any) {
  try {
    const value = decodeAnalysisEnvelope(result, site).value as any;
    if (website?.id !== site || value?.website?.id !== site) return null;
    return digest(
      statisticalPayload({
        ...value,
        website: {
          id: website.id,
          name: website.name,
          domain: website.domain,
          siteNumber: website.siteNumber,
        },
      }),
    );
  } catch {
    return null;
  }
}
const statisticsHashPresent = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function standardProducerObserved(value: any) {
  const producer = value.producer;
  if (
    ![202, 429].includes(value.firstStatus) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.id || '') ||
    producer?.verified !== true ||
    producer.id !== value.id ||
    producer.status !== 'ready' ||
    producer.statisticsHash !== value.statisticsHash
  )
    return false;
  if (
    !Array.isArray(value.admission) ||
    !value.admission.length ||
    value.admission[0].status !== value.firstStatus ||
    value.admission.at(-1).status !== value.admissionStatus
  )
    return false;
  if (
    value.firstStatus === 429 &&
    (value.admission.length < 2 ||
      value.admission
        .slice(0, -1)
        .some(
          (row: any) => row.status !== 429 || row.errorCode !== 'analysis-concurrency-limited',
        ) ||
      value.admission
        .slice(1)
        .some(
          (row: any) =>
            row.scheduledWaitMs !== 3000 || !Number.isFinite(row.waitMs) || row.waitMs <= 0,
        ))
  )
    return false;
  const clocks = ['queuedAt', 'startedAt', 'completedAt', 'generatedAt'].map(key =>
    typeof producer[key] === 'string' ? +new Date(producer[key]) : NaN,
  );
  if (
    !clocks.every(Number.isFinite) ||
    clocks[0] > clocks[1] ||
    clocks[1] > clocks[2] ||
    !Number.isFinite(value.requestedAt) ||
    value.serverQueueMs !== clocks[1] - clocks[0] ||
    value.requestToStartMs !== Math.max(0, clocks[1] - value.requestedAt) ||
    value.queueMs !== value.requestToStartMs
  )
    return false;
  return producer.source === 'response-handle'
    ? value.admissionStatus === 202 && value.responseHandleId === value.id
    : producer.source === 'published-response' &&
        value.firstStatus === 429 &&
        value.admissionStatus === 200 &&
        !value.responseHandleId;
}
function standardFivePassed(value: any, samples: number) {
  return (
    value.rounds.length === samples &&
    value.rounds.every(
      (round: any) =>
        round.results.length === 5 &&
        round.results.filter((r: any) => r.firstStatus === 200).length >= 4 &&
        round.results.filter((r: any) => r.firstStatus !== 200).length === 1 &&
        round.results.filter((r: any) => r.firstStatus !== 200).every(standardProducerObserved) &&
        round.background.some(
          (b: any) => b.automatic_history && ['queued', 'running'].includes(b.status),
        ) &&
        round.background.some(
          (b: any) => !b.automatic_history && ['queued', 'running'].includes(b.status),
        ) &&
        round.results.every(
          (r: any) =>
            r.status === 200 &&
            r.contractValid &&
            statisticsHashPresent(r.statisticsHash) &&
            r.statisticsHash === r.expectedStatisticsHash,
        ),
    ) &&
    value.cold.accepted === samples &&
    value.cold.complete.samples === samples &&
    Number.isFinite(value.cold.complete.p95Ms) &&
    value.cold.complete.p95Ms <= 5000 &&
    value.cold.queue.samples === samples &&
    Number.isFinite(value.cold.queue.p95Ms) &&
    value.cold.queue.p95Ms <= 2000 &&
    value.cold.failures.length === 0 &&
    value.publishedHttp.samples >= samples * 4 &&
    Number.isFinite(value.publishedHttp.p95Ms) &&
    value.publishedHttp.p95Ms <= 500
  );
}
function doubleColdPassed(value: any, samples: number) {
  return (
    value.rounds.length === samples &&
    value.wall.samples === samples &&
    Number.isFinite(value.wall.p95Ms) &&
    value.wall.p95Ms <= 12000 &&
    value.rounds.every(
      (round: any) =>
        round.results.length === 2 &&
        new Set(round.results.map((r: any) => r.id)).size === 2 &&
        round.results.every(
          (r: any) =>
            standardProducerObserved(r) &&
            r.status === 200 &&
            r.contractValid &&
            statisticsHashPresent(r.statisticsHash) &&
            r.statisticsHash === r.expectedStatisticsHash,
        ),
    )
  );
}
function burstResponsePassed(result: any) {
  if (
    (result.firstStatus === 200 || result.firstStatus === 202) &&
    result.status === 200 &&
    result.contractValid &&
    statisticsHashPresent(result.statisticsHash)
  )
    return true;
  if (
    result.firstStatus !== 429 ||
    result.status !== 429 ||
    result.errorCode !== 'analysis-concurrency-limited' ||
    !Array.isArray(result.admissionState) ||
    result.quotaEvidence?.verified !== true
  )
    return false;
  const rows = result.admissionState;
  const observed =
    rows.length >= 32 ||
    rows.filter((q: any) => q.website_id === result.site).length >= 8 ||
    rows.filter(
      (q: any) =>
        liveAnalysisTargets.includes(q.target) &&
        Array.isArray(q.consumers) &&
        q.consumers.includes(result.consumerId),
    ).length >= 2;
  return (
    observed ||
    (result.quotaEvidence.observations || []).some(
      (frame: any) =>
        frame.observedAt >= result.requestedAt &&
        frame.queryStartedAt <= result.firstObservedAt &&
        (frame.global >= 32 ||
          Number(frame.sites?.[result.site] || 0) >= 8 ||
          Number(frame.actors?.[result.consumerId] || 0) >= 2),
    )
  );
}
function burstPassed(results: any[], peaks: any, containers: any[], collection: any) {
  return (
    results.length === 10 &&
    results.every(burstResponsePassed) &&
    peaks.samples > 0 &&
    peaks.global <= 32 &&
    peaks.site <= 8 &&
    peaks.actor <= 2 &&
    containers.length >= 3 &&
    containers.every(
      s => s.running && !s.oomKilled && !s.dead && !s.restarting && s.exitCode === 0 && !s.error,
    ) &&
    collection.status >= 200 &&
    collection.status < 300 &&
    collection.committed === 1 &&
    collection.overlapped
  );
}
function freshnessLagResult(readings: any[], minimumSamples: number) {
  const valid = readings.filter(
    r =>
      r.status === 200 &&
      r.contractValid &&
      statisticsHashPresent(r.statisticsHash) &&
      Number.isFinite(r.observedAt) &&
      Number.isFinite(r.dataThrough) &&
      r.dataThrough <= r.observedAt &&
      r.lagMs === r.observedAt - r.dataThrough,
  );
  const lag = summary(valid.map(r => r.lagMs));
  return {
    attempts: readings.length,
    validSamples: valid.length,
    lag,
    failures: readings.filter(r => !valid.includes(r)),
    passed:
      readings.length >= minimumSamples &&
      valid.length === readings.length &&
      lag.samples >= minimumSamples &&
      Number.isFinite(lag.p95Ms) &&
      lag.p95Ms <= 60000,
  };
}

it('fixture preparation follows real backoff without spending work units and keeps failure bounds', async () => {
  let clock = 0,
    calls = 0;
  let state: any = { status: 'queued', next_attempt_at: new Date(0) };
  const observed: any[] = [];
  const options = {
    limit: 2,
    now: () => clock,
    wallNow: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
  const result = await finishFixtureBuild(
    async () => state,
    async () => {
      calls++;
      if (calls === 1) return { worked: false };
      if (calls === 2)
        state = {
          status: 'queued',
          error_code: 'analysis-work-failed',
          attempts: 1,
          next_attempt_at: new Date(clock + 5000),
        };
      else state = { status: 'completed' };
      return { worked: true };
    },
    async (row, unit) => {
      observed.push({ row: { ...row }, unit });
    },
    options,
  );
  assert.equal(result.units, 2);
  assert.equal(calls, 3);
  assert(result.idlePolls > 1 && clock >= 5000);
  assert(observed.some(frame => frame.row.error_code === 'analysis-work-failed'));
  await assert.rejects(
    () =>
      finishFixtureBuild(
        async () => ({ status: 'failed', error_code: 'real-failure' }),
        async () => {
          throw new Error('must not execute terminal work');
        },
        async () => {},
      ),
    /real-failure/,
  );
  clock = 0;
  await assert.rejects(
    () =>
      finishFixtureBuild(
        async () => ({ status: 'queued' }),
        async () => ({ worked: true }),
        async () => {},
        options,
      ),
    /fixture-bounded-build-limit/,
  );
  clock = 0;
  await assert.rejects(
    () =>
      finishFixtureBuild(
        async () => ({ status: 'queued' }),
        async () => ({ worked: false }),
        async () => {},
        { ...options, timeoutMs: 100 },
      ),
    /fixture-bounded-build-deadline/,
  );
  clock = 0;
  await assert.rejects(
    () =>
      finishFixtureBuild(
        async () => {
          clock = 100;
          return { status: 'completed' };
        },
        async () => ({ worked: true }),
        async () => {},
        { ...options, timeoutMs: 100 },
      ),
    /fixture-bounded-build-deadline/,
  );
  clock = 0;
  let finalUnit = false;
  const last = await finishFixtureBuild(
    async () => ({ status: finalUnit ? 'completed' : 'queued' }),
    async () => {
      finalUnit = true;
      return { worked: true };
    },
    async () => {},
    { ...options, limit: 1 },
  );
  assert.equal(last.units, 1);
});

it('C4 producer proof uses independent public website projection and preserves the full statistical hash', () => {
  const site = '11111111-1111-4111-8111-111111111111';
  const website = { id: site, name: 'Current name', domain: 'current.invalid', siteNumber: 105 };
  const value = {
    website: { id: site, name: 'Stored name', domain: 'stored.invalid' },
    cards: [{ label: 'Requests', value: 7 }],
    meta: { generatedAt: 1000, population: 'eligible-v1' },
  };
  const envelope = { format: 'liekan-analysis-result-v3', value, populations: [] };
  const expected = digest(statisticalPayload({ ...value, website }));
  assert.equal(producerStatisticsHash(envelope, site, website), expected);
  for (const wrong of [
    { ...website, name: 'Wrong' },
    { ...website, domain: 'wrong.invalid' },
    { ...website, siteNumber: 106 },
  ])
    assert.notEqual(producerStatisticsHash(envelope, site, wrong), expected);
  assert.notEqual(
    producerStatisticsHash(
      { ...envelope, value: { ...value, cards: [{ label: 'Requests', value: 8 }] } },
      site,
      website,
    ),
    expected,
  );
  assert.notEqual(
    producerStatisticsHash(
      { ...envelope, value: { ...value, meta: { ...value.meta, population: 'different-v2' } } },
      site,
      website,
    ),
    expected,
  );
  assert.equal(producerStatisticsHash(envelope, site, { ...website, id: 'another-site' }), null);
  assert.equal(
    producerStatisticsHash(
      { ...envelope, value: { ...value, website: { ...value.website, id: 'another-site' } } },
      site,
      website,
    ),
    null,
  );
});
it('C4 gates reject incomplete, unsupported quota, unhealthy and stale observations', () => {
  const hash = 'a'.repeat(64);
  const ready = {
    firstStatus: 202,
    admissionStatus: 202,
    admission: [{ status: 202, errorCode: null, waitMs: 0, scheduledWaitMs: 0 }],
    id: '11111111-1111-4111-8111-111111111111',
    responseHandleId: '11111111-1111-4111-8111-111111111111',
    queueMs: 500,
    serverQueueMs: 500,
    requestToStartMs: 500,
    requestedAt: +new Date('2026-01-01T00:00:00.000Z'),
    producer: {
      source: 'response-handle',
      verified: true,
      id: '11111111-1111-4111-8111-111111111111',
      status: 'ready',
      statisticsHash: hash,
      queuedAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:00.500Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      generatedAt: '2026-01-01T00:00:00.500Z',
    },
    status: 200,
    contractValid: true,
    statisticsHash: hash,
    expectedStatisticsHash: hash,
  };
  const round = {
    results: [
      { ...ready, firstStatus: 200 },
      { ...ready, firstStatus: 200 },
      { ...ready, firstStatus: 200 },
      { ...ready, firstStatus: 200 },
      ready,
    ],
    background: [
      { automatic_history: true, status: 'queued' },
      { automatic_history: false, status: 'running' },
    ],
  };
  const five = {
    rounds: Array.from({ length: 100 }, () => structuredClone(round)),
    cold: {
      accepted: 100,
      complete: { samples: 100, p95Ms: 1000 },
      queue: { samples: 100, p95Ms: 500 },
      failures: [],
    },
    publishedHttp: { samples: 400, p95Ms: 30 },
  };
  assert(standardFivePassed(five, 100));
  const afterAdmission = structuredClone(five);
  for (const row of afterAdmission.rounds) {
    row.results[4].firstStatus = 429;
    row.results[4].admission = [
      { status: 429, errorCode: 'analysis-concurrency-limited', waitMs: 0, scheduledWaitMs: 0 },
      { status: 202, errorCode: null, waitMs: 3000, scheduledWaitMs: 3000 },
    ];
  }
  assert(standardFivePassed(afterAdmission, 100));
  const publishedAfterAdmission = structuredClone(afterAdmission);
  for (const row of publishedAfterAdmission.rounds) {
    row.results[4].admissionStatus = 200;
    row.results[4].responseHandleId = undefined;
    row.results[4].producer.source = 'published-response';
    row.results[4].admission[1].status = 200;
  }
  assert(standardFivePassed(publishedAfterAdmission, 100));
  const waitedBeforeQueue = structuredClone(afterAdmission);
  for (const row of waitedBeforeQueue.rounds) {
    row.results[4].producer.queuedAt = '2026-01-01T00:00:03.000Z';
    row.results[4].producer.startedAt = '2026-01-01T00:00:03.200Z';
    row.results[4].producer.completedAt = '2026-01-01T00:00:03.500Z';
    row.results[4].serverQueueMs = 200;
    row.results[4].requestToStartMs = 3200;
    row.results[4].queueMs = 3200;
  }
  waitedBeforeQueue.cold.queue.p95Ms = 3200;
  waitedBeforeQueue.cold.complete.p95Ms = 3500;
  assert(!standardFivePassed(waitedBeforeQueue, 100));
  for (const change of [
    (v: any) => {
      v.rounds[0].results[4].producer.verified = false;
    },
    (v: any) => {
      delete v.rounds[0].results[4].producer;
    },
    (v: any) => {
      v.rounds[0].results[4].producer.startedAt = null;
    },
    (v: any) => {
      v.rounds[0].results[4].status = 429;
    },
    (v: any) => {
      v.rounds[0].results[4].statisticsHash = 'b'.repeat(64);
    },
    (v: any) => {
      v.rounds[0].results[4].admission = [];
    },
  ]) {
    const invalid = structuredClone(publishedAfterAdmission);
    change(invalid);
    assert(!standardFivePassed(invalid, 100));
  }
  const otherReady = structuredClone(ready);
  otherReady.id = '22222222-2222-4222-8222-222222222222';
  otherReady.responseHandleId = otherReady.id;
  otherReady.producer.id = otherReady.id;
  const pair = {
    wall: { samples: 100, p95Ms: 2000 },
    rounds: Array.from({ length: 100 }, () => ({
      results: [structuredClone(ready), structuredClone(otherReady)],
    })),
  };
  assert(doubleColdPassed(pair, 100));
  const pairAfterAdmission = structuredClone(pair);
  for (const row of pairAfterAdmission.rounds) {
    row.results[0].firstStatus = 429;
    row.results[0].admission = [
      { status: 429, errorCode: 'analysis-concurrency-limited', waitMs: 0, scheduledWaitMs: 0 },
      { status: 202, errorCode: null, waitMs: 3000, scheduledWaitMs: 3000 },
    ];
  }
  assert(doubleColdPassed(pairAfterAdmission, 100));
  assert.equal(
    pairAfterAdmission.rounds.flatMap(row => row.results).filter(standardProducerObserved).length,
    200,
  );
  const publishedPair = structuredClone(pairAfterAdmission);
  for (const row of publishedPair.rounds) {
    row.results[0].admissionStatus = 200;
    row.results[0].responseHandleId = undefined;
    row.results[0].producer.source = 'published-response';
    row.results[0].admission[1].status = 200;
  }
  assert(doubleColdPassed(publishedPair, 100));
  for (const change of [
    (v: any) => {
      v.rounds.pop();
    },
    (v: any) => {
      v.wall.p95Ms = 12001;
    },
    (v: any) => {
      v.rounds[0].results[0].firstStatus = 200;
    },
    (v: any) => {
      v.rounds[0].results[0].contractValid = false;
    },
    (v: any) => {
      v.rounds[0].results[0].statisticsHash = 'b'.repeat(64);
    },
    (v: any) => {
      const result = v.rounds[0].results[1];
      result.id = v.rounds[0].results[0].id;
      result.responseHandleId = result.id;
      result.producer.id = result.id;
    },
    (v: any) => {
      delete v.rounds[0].results[0].producer;
    },
    (v: any) => {
      v.rounds[0].results[0].producer.verified = false;
    },
    (v: any) => {
      v.rounds[0].results[0].producer.id = otherReady.id;
    },
    (v: any) => {
      v.rounds[0].results[0].responseHandleId = otherReady.id;
    },
    (v: any) => {
      v.rounds[0].results[0].producer.startedAt = null;
    },
    (v: any) => {
      v.rounds[0].results[0].producer.completedAt = '2026-01-01T00:00:00.100Z';
    },
    (v: any) => {
      v.rounds[0].results[0].statisticsHash = 'b'.repeat(64);
      v.rounds[0].results[0].producer.statisticsHash = 'b'.repeat(64);
    },
    (v: any) => {
      v.rounds[0].results[0].queueMs = 0;
    },
    (v: any) => {
      v.rounds[0].results[0].admission[0].errorCode = 'unsupported-quota';
    },
    (v: any) => {
      const result = v.rounds[0].results[0];
      result.id = 'not-a-uuid';
      result.responseHandleId = result.id;
      result.producer.id = result.id;
    },
    (v: any) => {
      v.wall.samples = 99;
    },
  ]) {
    const invalid = structuredClone(pairAfterAdmission);
    change(invalid);
    assert(!doubleColdPassed(invalid, 100));
  }
  for (const change of [
    (v: any) => {
      v.rounds.pop();
    },
    (v: any) => {
      v.cold.queue.samples = 0;
    },
    (v: any) => {
      v.cold.queue.p95Ms = 2001;
    },
    (v: any) => {
      v.cold.complete.p95Ms = 5001;
    },
    (v: any) => {
      v.rounds[0].background = [];
    },
    (v: any) => {
      delete v.rounds[0].results[4].id;
    },
    (v: any) => {
      delete v.rounds[0].results[4].producer;
    },
    (v: any) => {
      delete v.rounds[0].results[4].responseHandleId;
    },
    (v: any) => {
      v.rounds[0].results[4].producer.startedAt = null;
    },
    (v: any) => {
      v.rounds[0].results[4].status = 202;
    },
    (v: any) => {
      v.rounds[0].results[4].producer.statisticsHash = 'b'.repeat(64);
    },
    (v: any) => {
      v.cold.complete.samples = 99;
    },
    (v: any) => {
      v.rounds[0].results[0].statisticsHash = 'b'.repeat(64);
    },
  ]) {
    const invalid = structuredClone(five);
    change(invalid);
    assert(!standardFivePassed(invalid, 100));
  }
  const limited = {
    firstStatus: 429,
    status: 429,
    errorCode: 'analysis-concurrency-limited',
    site: 'site',
    consumerId: 'actor',
    admissionState: [
      { website_id: 'site', target: 'feature:page-report', consumers: ['actor'] },
      { website_id: 'site', target: 'feature:page-report', consumers: ['actor'] },
    ],
    quotaEvidence: { verified: true },
  };
  const results = [
    ready,
    ready,
    ready,
    ready,
    limited,
    limited,
    limited,
    limited,
    limited,
    limited,
  ];
  const peaks = { samples: 2, global: 4, site: 2, actor: 2 };
  const containers = Array.from({ length: 3 }, () => ({
    running: true,
    oomKilled: false,
    dead: false,
    restarting: false,
    exitCode: 0,
    error: false,
  }));
  const collection = { status: 200, committed: 1, overlapped: true };
  assert(burstPassed(results, peaks, containers, collection));
  for (const status of [500, 202])
    assert(
      !burstPassed([{ ...ready, status }, ...results.slice(1)], peaks, containers, collection),
    );
  assert(!burstPassed([...results.slice(0, 9)], peaks, containers, collection));
  assert(
    !burstPassed(
      [{ ...limited, admissionState: [] }, ...results.slice(1)],
      peaks,
      containers,
      collection,
    ),
  );
  assert(
    !burstPassed(
      [{ ...limited, errorCode: 'other' }, ...results.slice(1)],
      peaks,
      containers,
      collection,
    ),
  );
  assert(!burstPassed(results, { ...peaks, samples: 0 }, containers, collection));
  assert(
    !burstPassed(
      results,
      peaks,
      [{ ...containers[0], oomKilled: true }, ...containers.slice(1)],
      collection,
    ),
  );
  assert(!burstPassed(results, peaks, containers, { ...collection, committed: 0 }));
  const readings = Array.from({ length: 100 }, (_, i) => ({
    status: 200,
    contractValid: true,
    statisticsHash: hash,
    observedAt: 100000 + i * 1000,
    dataThrough: 70000 + i * 1000,
    lagMs: 30000,
  }));
  assert(freshnessLagResult(readings, 100).passed);
  assert(!freshnessLagResult([], 100).passed);
  assert(!freshnessLagResult(readings.slice(0, 99), 100).passed);
  assert(
    !freshnessLagResult(
      readings.map(r => ({
        ...r,
        dataThrough: r.observedAt - 120000,
        lagMs: 120000,
        propagatedPlusOne: true,
      })),
      100,
    ).passed,
  );
  assert(
    !freshnessLagResult([{ ...readings[0], dataThrough: null }, ...readings.slice(1)], 100).passed,
  );
});

it('retains standard admission observations on transport failure and bounds all waiting by one deadline', async () => {
  let clock = 0;
  const admission: any[] = [
    { status: 429, errorCode: 'analysis-concurrency-limited', waitMs: 0, scheduledWaitMs: 0 },
  ];
  const attempt: any = { status: null, waitMs: 0, scheduledWaitMs: 3000 };
  admission.push(attempt);
  await benchmarkWait(
    3000,
    65000,
    attempt,
    async ms => {
      clock += ms;
    },
    () => clock,
  );
  const failed = failedBenchmarkObservation(
    Object.assign(new Error('synthetic transport failure'), { code: 'ECONNRESET' }),
    {
      firstStatus: 429,
      requestedAt: 10000,
      firstObservedAt: 10020,
      observedAt: 13020,
      completeMs: 3020,
      admission,
    },
  );
  assert.equal(failed.firstStatus, 429);
  assert.equal(failed.requestedAt, 10000);
  assert.equal(failed.firstObservedAt, 10020);
  assert.equal(failed.status, 0);
  assert.equal(failed.transportError.code, 'ECONNRESET');
  assert.equal(failed.admission.length, 2);
  assert.equal(failed.admission[1].waitMs, 3000);
  assert(!standardProducerObserved(failed));
  assert(!standardFivePassed({ rounds: [{ results: [failed] }] }, 1));
  const firstFailed = failedBenchmarkObservation(new Error('initial request failed'), {
    firstStatus: 0,
    requestedAt: 10001,
    firstObservedAt: null,
    completeMs: 40,
  });
  assert.equal(firstFailed.requestedAt, 10001);
  assert.equal(firstFailed.firstObservedAt, null);
  clock = 64000;
  const limited: any = { waitMs: 0 };
  let extraRequest = 0;
  try {
    await benchmarkWait(
      3000,
      65000,
      limited,
      async ms => {
        clock += ms;
      },
      () => clock,
    );
    extraRequest++;
  } catch (error) {
    assert.equal((error as any).code, 'benchmark-deadline-exceeded');
  }
  assert.equal(extraRequest, 0);
  assert.equal(clock, 65000);
  assert.equal(limited.waitMs, 1000);
  assert.equal(benchmarkRemaining(65000, 64000), 1000);
  assert.throws(() => benchmarkRemaining(65000, 65000));
  let headers: any;
  await assert.rejects(
    () =>
      benchmarkFetchJson(
        'http://fixture.invalid',
        {},
        20,
        value => {
          headers = value;
        },
        async (_target, init) =>
          ({
            status: 202,
            json: () =>
              new Promise((_resolve, reject) =>
                init.signal.addEventListener(
                  'abort',
                  () => reject(new DOMException('synthetic body deadline', 'AbortError')),
                  { once: true },
                ),
              ),
          }) as Response,
      ),
    { name: 'AbortError' },
  );
  assert.equal(headers.status, 202);
  const bodyFailure = failedBenchmarkObservation(new SyntaxError('synthetic JSON failure'), {
    ...failed,
    lastHttpStatus: headers.status,
  });
  assert.equal(bodyFailure.firstStatus, 429);
  assert.equal(bodyFailure.lastHttpStatus, 202);
  assert.equal(bodyFailure.admission[1].waitMs, 3000);
  assert(!standardProducerObserved(bodyFailure));
});

it.skipIf(!enabled)(
  'measures exact overview and human overview through the production HTTP/job pipeline on owned 1M raw fixtures',
  async () => {
    const url = new URL(process.env.DATABASE_URL || 'http://invalid');
    const owner = process.env.LIEKAN_ANALYSIS_ROLLUPS_OWNER;
    const databaseName = process.env.LIEKAN_ANALYSIS_ROLLUPS_CONTAINER;
    const workerName = process.env.LIEKAN_ANALYSIS_ROLLUPS_WORKER;
    const appName = process.env.LIEKAN_ANALYSIS_DASHBOARD_APP;
    const baselineName = process.env.LIEKAN_ANALYSIS_DASHBOARD_BASELINE;
    const image = process.env.LIEKAN_ANALYSIS_ROLLUPS_CANDIDATE_ID;
    const baselineImage = process.env.LIEKAN_ANALYSIS_DASHBOARD_BASELINE_ID;
    const workerEnv = process.env.LIEKAN_ANALYSIS_ROLLUPS_WORKER_ENV;
    assert(
      url.hostname === '127.0.0.1' &&
        url.port === '15462' &&
        url.pathname === '/liekan_analysis_rollups_test',
    );
    assert(/^analysis_[a-f0-9]+$/.test(url.searchParams.get('schema') || ''));
    assert(
      /^[a-f0-9-]{36}$/.test(owner || '') && databaseName === `liekan-analysis-rollups-${owner}`,
    );
    assert(
      workerName === `${databaseName}-worker` &&
        appName === `${databaseName}-app` &&
        baselineName === `${databaseName}-baseline`,
    );
    assert(/^sha256:[a-f0-9]{64}$/.test(image || '') && workerEnv === `${folder}/worker.env`);
    assert(folder?.includes('/.local/analysis-rollups/'));
    const totalRows = Number(process.env.LIEKAN_ANALYSIS_ROLLUPS_BENCHMARK_ROWS);
    assert([10000, 1000000, 10000000].includes(totalRows));
    const samples = totalRows === 10000 ? 5 : 100;
    const selectedDistribution = process.env.LIEKAN_ANALYSIS_DASHBOARD_DISTRIBUTION;
    assert(!selectedDistribution || ['uniform', 'hotspot80'].includes(selectedDistribution));
    const distributions = selectedDistribution ? [selectedDistribution] : ['uniform', 'hotspot80'];
    assert(
      totalRows === 10000 || distributions.length === 1,
      'Scale distributions require independent owned databases',
    );
    const label = 'io.liekan.analysis-rollups-test';
    const docker = (args: string[], optional = false): Promise<string> =>
      new Promise((resolve, reject) => {
        const process = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [],
          stderr: Buffer[] = [];
        process.stdout.on('data', chunk => stdout.push(chunk));
        process.stderr.on('data', chunk => stderr.push(chunk));
        const timer = setTimeout(() => process.kill('SIGKILL'), 60000);
        process.once('error', reject);
        process.once('close', async status => {
          clearTimeout(timer);
          if (status && !optional) {
            await writeFile(
              `${folder}/dashboard-container-error.private.log`,
              Buffer.concat(stderr),
              { mode: 0o600 },
            );
            reject(new Error('owned-dashboard-container-command-failed'));
          } else
            resolve(
              Buffer.concat(args[0] === 'logs' ? [...stdout, ...stderr] : stdout)
                .toString()
                .trim(),
            );
        });
      });
    const assertOwner = async (name: string) =>
      assert.equal(
        await docker(['inspect', '--format', `{{index .Config.Labels "${label}"}}`, name]),
        owner,
      );
    await assertOwner(databaseName);
    const rawUrl = new URL(url);
    rawUrl.searchParams.delete('schema');
    const native = new Client({ connectionString: rawUrl.toString() });
    await native.connect();
    await native.query(`SET search_path TO "${url.searchParams.get('schema')}"`);
    const { analysisTransaction } = await import('./analysis-rollups-db');
    const { createAnalysisBuild, runOneAnalysisWorkUnit, readAnalysisLogToday } = await import(
      './analysis-rollups'
    );
    const { withPublishedRegistry } = await import('./crawler-registry-context');
    const { withinQuerySnapshot } = await import('./query-snapshot');
    const { ANALYSIS_ROLLUP_VERSION } = await import('./analysis-rollups-model');
    const { default: prisma } = await import('@/lib/prisma');
    const created: string[] = [];
    const progress = async (stage: string) =>
      appendFile(
        `${folder}/dashboard-progress.jsonl`,
        `${JSON.stringify({ at: new Date().toISOString(), stage })}\n`,
        { mode: 0o600 },
      );
    const report: any = {
      schemaVersion: 2,
      synthetic: true,
      image,
      baselineImage: baselineImage || null,
      samplesPerCorePath: samples,
      standard: totalRows === 1000000,
      rawInputRowsPerDistribution: totalRows,
      eventRows: totalRows / 2,
      logRows: totalRows / 2,
      distributions: [],
      passed: false,
      outcomeDefinition:
        'candidateTargetsPassed evaluates the optimized candidate matrix. Old-build diagnostics stop after five attempts or an observed budget miss; unfinished baseline observations have no p95 conclusion. passed also requires every completed baseline response to match the frozen reference.',
      layers: [
        'published HTTP response',
        'cold HTTP submission and real job/result wait',
        'worker queue/compute/publication diagnostics',
        'today reader kernel EXPLAIN',
      ],
      thresholds: {
        warmHttpP95Ms: 500,
        singleColdCompleteMs: 5000,
        queueMs: 2000,
        doubleColdCompleteMs: 12000,
        historyGrowthMaximumRatio: 1.3,
        collectionP95MaximumRatio: 1.1,
        activeDataThroughLagP95Ms: 60000,
      },
      cacheCondition:
        'Logical cold deletes only this owned fixture combination from persistent derived result tables; Redis is unset. PostgreSQL buffers and OS cache remain warm and are not flushed.',
      fixtureSetup:
        'Bulk fixture writes temporarily disable triggers on this connection only; all normal policy/identity sidecars are populated. Timing starts after triggers are restored. Actual collection is measured separately through /api/send.',
      runtime: (
        await native.query(
          "SELECT version(),current_setting('shared_buffers') AS shared_buffers,current_setting('work_mem') AS work_mem",
        )
      ).rows[0],
    };
    const saveReport = () => save('dashboard-benchmark.json', report);
    let endpoint = '',
      token = '';
    const actorId = randomUUID(),
      username = `synthetic-dashboard-${owner}`,
      password = randomBytes(24).toString('hex');
    const consumers: string[] = [actorId];
    const burstCollectionTrials: any[] = [];
    const drainConsumers = async (stage: string, sites: string[] = [], includeBuilds = false) => {
      const start = performance.now();
      let first: any[] = [],
        current: any[] = [];
      let cohort: BenchmarkCohort;
      do {
        current = await readBenchmarkDemand(native, consumers, sites, includeBuilds, cohort);
        if (!cohort) {
          first = current;
          cohort = {
            queries: first.filter(row => row.target !== 'build').map(row => row.id),
            builds: first.filter(row => row.target === 'build').map(row => row.id),
          };
        }
        if (!current.length) break;
        await pause(200);
      } while (performance.now() - start < 120000);
      report.drains ||= [];
      report.drains.push({
        stage,
        waitedMs: performance.now() - start,
        initial: first,
        remaining: current,
        ongoingMaintenance: (
          await readBenchmarkDemand(native, consumers, sites, includeBuilds)
        ).filter(row => !current.some(pending => pending.id === row.id)),
      });
      await saveReport();
      assert.equal(current.length, 0, `owned consumers did not naturally drain before ${stage}`);
    };
    const started = performance.now();
    const startContainer = async (name: string, candidate: string, port?: number) => {
      assert(
        !(await docker(['inspect', '--format', '{{.Id}}', name], true)),
        'owned container name is already present',
      );
      await docker([
        'run',
        '--detach',
        '--name',
        name,
        '--label',
        `${label}=${owner}`,
        '--network',
        `container:${databaseName}`,
        '--cpus',
        name === workerName ? '1' : '2',
        '--memory',
        name === workerName ? '512m' : '1536m',
        '--env-file',
        workerEnv,
        ...(port ? ['--env', `PORT=${port}`] : []),
        '--entrypoint',
        'node',
        candidate,
        name === workerName ? 'dist/liekan-analytics-worker.mjs' : 'server.js',
      ]);
      if (!created.includes(name)) created.push(name);
      const budget = JSON.parse(
        await docker(['inspect', '--format', '{{json .HostConfig}}', name]),
      );
      report.containerBudgets ||= {};
      report.containerBudgets[
        name === workerName ? 'worker' : name === appName ? 'app' : 'baseline'
      ] = { cpus: budget.NanoCpus / 1e9, memory: budget.Memory };
    };
    const waitHttp = async (base: string) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          if ((await fetch(`${base}/api/heartbeat`, { signal: AbortSignal.timeout(2000) })).ok)
            return;
        } catch {}
        await pause(500);
      }
      throw new Error('owned-dashboard-http-not-ready');
    };
    const headers = (auth = token) => ({
      Authorization: `Bearer ${auth}`,
      Prefer: 'respond-async',
      'Accept-Language': 'zh-CN',
    });
    const path = (site: string, parameters: Record<string, any>) =>
      `${endpoint}/api/liekan/websites/${site}/page-report?${new URLSearchParams(Object.entries(parameters).map(([k, v]) => [k, String(v)]))}`;
    const fetchJson = (
      target: string,
      init?: RequestInit,
      auth = token,
      bounded?: {
        timeoutMs: number;
        onResponse?: (value: { status: number; observedAt: number; requestMs: number }) => void;
      },
    ) =>
      benchmarkFetchJson(
        target,
        { headers: headers(auth), ...init },
        bounded?.timeoutMs ?? 65000,
        bounded?.onResponse,
      );
    const readAdmissionState = async () =>
      (
        await native.query(`SELECT q.id,q.website_id,q.status,q.target,q.parameters->>'resource' AS resource,q.attempts,q.next_attempt_at,
        ARRAY(SELECT c.actor_id FROM liekan_analysis_query_consumer c WHERE c.job_id=q.id) AS consumers,
        (SELECT max(d.last_read_at) FROM liekan_dashboard_snapshot d WHERE d.job_id=q.id) AS snapshot_last_read_at,
        EXISTS(SELECT 1 FROM liekan_dashboard_snapshot d WHERE d.job_id=q.id AND d.result IS NOT NULL) AS previously_published
        FROM liekan_analysis_query q WHERE q.status IN('queued','running') AND q.retention_until>clock_timestamp() ORDER BY q.queued_at`)
      ).rows;
    const waitReport = async (
      site: string,
      parameters: Record<string, any>,
      timeout = 65000,
      auth = token,
      options: { followAdmission?: boolean } = {},
    ) => {
      const requestedAt = Date.now(),
        start = performance.now(),
        deadline = start + timeout;
      const admission: any[] = [],
        polling: any[] = [];
      let first: Awaited<ReturnType<typeof fetchJson>>,
        current: Awaited<ReturnType<typeof fetchJson>>;
      let firstObservedAt: number | null = null,
        firstHttpStatus = 0,
        admissionStatus: number | undefined;
      let responseHandleId: string | undefined,
        id: string | undefined,
        polls = 0,
        job: any,
        producer: any,
        activeObservation: any;
      const read = async (target: string, observation?: any) => {
        const timeoutMs = benchmarkRemaining(deadline);
        if (observation) observation.requestedAt = Date.now();
        const result = await fetchJson(target, undefined, auth, {
          timeoutMs,
          onResponse: value => {
            if (!firstHttpStatus) {
              firstHttpStatus = value.status;
              firstObservedAt = value.observedAt;
            }
            if (observation) Object.assign(observation, value);
          },
        });
        if (observation)
          Object.assign(observation, {
            requestMs: result.wallMs,
            errorCode: result.body.error?.code ?? null,
          });
        benchmarkRemaining(deadline);
        return result;
      };
      const observe = async (observation: any) => {
        Object.assign(observation, {
          observedAt: Date.now(),
          status: current.response.status,
          errorCode: current.body.error?.code ?? null,
          requestMs: current.wallMs,
        });
        if (
          current.response.status === 429 &&
          current.body.error?.code === 'analysis-concurrency-limited'
        )
          observation.admissionState = await readAdmissionState();
      };
      try {
        activeObservation = { status: null, observedAt: null, waitMs: 0, scheduledWaitMs: 0 };
        if (options.followAdmission) admission.push(activeObservation);
        first = await read(path(site, parameters), activeObservation);
        firstObservedAt = Date.now();
        current = first;
        if (options.followAdmission) {
          await observe(activeObservation);
          while (
            current.response.status === 429 &&
            current.body.error?.code === 'analysis-concurrency-limited'
          ) {
            activeObservation = {
              status: null,
              observedAt: null,
              waitMs: 0,
              scheduledWaitMs: 3000,
            };
            admission.push(activeObservation);
            await benchmarkWait(3000, deadline, activeObservation);
            current = await read(path(site, parameters), activeObservation);
            await observe(activeObservation);
          }
        }
        admissionStatus = current.response.status;
        responseHandleId = admissionStatus === 202 ? current.body.analysisJob?.id : undefined;
        id = responseHandleId;
        while (current.response.status === 202) {
          activeObservation = { status: null, observedAt: null, waitMs: 0, scheduledWaitMs: 100 };
          if (options.followAdmission) polling.push(activeObservation);
          await benchmarkWait(100, deadline, activeObservation);
          current = await read(
            id
              ? `${endpoint}/api/liekan/websites/${site}/analytics-jobs/${id}/result`
              : path(site, parameters),
            activeObservation,
          );
          id ||= current.body.analysisJob?.id;
          polls++;
        }
        const observedAt = Date.now(),
          observedWallMs = performance.now() - start;
        const contractValid =
          current.response.status === 200 &&
          pageReportSchema.safeParse(current.body).success &&
          current.body.website.id === site &&
          current.body.resource === parameters.resource &&
          current.body.range.startAt === parameters.startAt &&
          current.body.range.endAt === parameters.endAt &&
          current.body.range.timezone === parameters.timezone;
        const statisticsHash = contractValid ? digest(statisticalPayload(current.body)) : null;
        job = id
          ? (
              await native.query(
                'SELECT status,attempts,queued_at,started_at,completed_at,error_code FROM liekan_analysis_query WHERE id=$1::uuid',
                [id],
              )
            ).rows[0]
          : null;
        if (options.followAdmission && first.response.status !== 200) {
          producer = {
            source: responseHandleId ? 'response-handle' : 'published-response',
            verified: false,
            reason: 'producer-unobserved',
          };
          const generatedAt = Number(current.body.meta?.generatedAt);
          if (contractValid && Number.isFinite(generatedAt)) {
            const candidates = (
              await native.query(
                `SELECT q.*,jsonb_build_object('id',w.website_id,'name',w.name,'domain',w.domain,'siteNumber',w.site_number) AS public_website
               FROM liekan_analysis_query q JOIN liekan_analysis_site s USING(website_id,epoch)
               JOIN website w USING(website_id)
               WHERE q.website_id=$1::uuid AND q.target='feature:page-report' AND q.status='ready' AND s.mode='live'
                 AND q.parameters @> $2::jsonb AND ($3::uuid IS NULL OR q.id=$3::uuid) AND q.generated_at=$4
                 AND EXISTS(SELECT 1 FROM liekan_analysis_query_consumer c WHERE c.job_id=q.id AND c.actor_id=$5::uuid)
               ORDER BY q.sequence DESC LIMIT 2`,
                [site, JSON.stringify(parameters), id || null, new Date(generatedAt), actorId],
              )
            ).rows;
            if (candidates.length === 1) {
              const candidate = candidates[0];
              const producerHash = producerStatisticsHash(
                candidate.result,
                site,
                candidate.public_website,
              );
              const verified =
                producerHash === statisticsHash &&
                candidate.started_at &&
                candidate.completed_at &&
                +candidate.queued_at <= +candidate.started_at &&
                +candidate.started_at <= +candidate.completed_at;
              producer = {
                source: responseHandleId ? 'response-handle' : 'published-response',
                verified: Boolean(verified),
                id: candidate.id,
                status: candidate.status,
                websiteId: candidate.website_id,
                consumerId: actorId,
                epoch: String(candidate.epoch),
                strongVersion: candidate.strong_version,
                statisticsHash: producerHash,
                queuedAt: candidate.queued_at?.toISOString(),
                startedAt: candidate.started_at?.toISOString(),
                completedAt: candidate.completed_at?.toISOString(),
                generatedAt: candidate.generated_at?.toISOString(),
              };
              if (verified) {
                id = candidate.id;
                job = candidate;
              }
            }
          }
        }
        const admissionState =
          current.response.status === 429 ? await readAdmissionState() : undefined;
        const serverQueueMs = job?.started_at ? +job.started_at - +job.queued_at : null;
        const requestToStartMs =
          producer?.verified && job?.started_at ? Math.max(0, +job.started_at - requestedAt) : null;
        return {
          status: current.response.status,
          body: current.body,
          requestedAt,
          firstObservedAt,
          observedAt,
          contractValid,
          statisticsHash,
          id,
          polls,
          submitMs: first.wallMs,
          completeMs: options.followAdmission ? observedWallMs : performance.now() - start,
          firstStatus: first.response.status,
          queueMs: options.followAdmission ? requestToStartMs : serverQueueMs,
          attempts: job?.attempts ?? 0,
          errorCode: job?.error_code ?? current.body.error?.code ?? null,
          ...(options.followAdmission
            ? {
                admissionStatus,
                responseHandleId,
                admission,
                polling,
                admissionWaitMs: admission.reduce((sum, row) => sum + row.waitMs, 0),
                serverQueueMs,
                requestToStartMs,
                producer,
              }
            : {}),
          ...(admissionState ? { admissionState } : {}),
        };
      } catch (error) {
        if (!options.followAdmission) throw error;
        if (activeObservation)
          activeObservation.transportError =
            (error as any)?.code || (error as any)?.name || 'transport-failed';
        const serverQueueMs = job?.started_at ? +job.started_at - +job.queued_at : null;
        const requestToStartMs =
          producer?.verified && job?.started_at ? Math.max(0, +job.started_at - requestedAt) : null;
        return failedBenchmarkObservation(error, {
          requestedAt,
          firstObservedAt,
          observedAt: Date.now(),
          firstStatus: first?.response.status ?? firstHttpStatus,
          submitMs: first?.wallMs ?? admission[0]?.requestMs ?? performance.now() - start,
          completeMs: performance.now() - start,
          lastHttpStatus: activeObservation?.status ?? current?.response.status ?? null,
          admissionStatus: admissionStatus ?? current?.response.status,
          responseHandleId,
          id,
          polls,
          admission,
          polling,
          admissionWaitMs: admission.reduce((sum, row) => sum + (row.waitMs || 0), 0),
          producer,
          serverQueueMs,
          requestToStartMs,
          queueMs: requestToStartMs,
          attempts: job?.attempts ?? 0,
        });
      }
    };
    const clearResult = async (site: string, parameters: Record<string, any>) => {
      // The combination is complete before clearing; no source/coverage/queue tables are cleared.
      for (const table of ['liekan_dashboard_snapshot', 'liekan_analysis_query'])
        await native.query(
          `DELETE FROM ${table} WHERE website_id=$1::uuid AND target='feature:page-report' AND parameters @> $2::jsonb`,
          [site, JSON.stringify(parameters)],
        );
    };
    const measureCore = async (site: string, p: Record<string, any>, expected: unknown) => {
      await drainConsumers(`${p.resource}:core-start`);
      const warm: number[] = [],
        cold: any[] = [],
        warmFailures: number[] = [];
      const expectedHash = digest(expected);
      let correctWarm = 0;
      for (let sample = 0; sample < samples; sample++) {
        const value = await fetchJson(path(site, p));
        if (value.response.status === 200) {
          warm.push(value.wallMs);
          if (
            pageReportSchema.safeParse(value.body).success &&
            digest(statisticalPayload(value.body)) === expectedHash
          )
            correctWarm++;
        } else warmFailures.push(value.response.status);
      }
      for (let sample = 0; sample < samples; sample++) {
        await clearResult(site, p);
        cold.push(await waitReport(site, p, 65000, token, { followAdmission: true }));
      }
      return {
        warm: { ...summary(warm), failures: warmFailures, correctOutputs: correctWarm },
        logicalCold: {
          ...summary(cold.filter(v => v.status === 200).map(v => v.completeMs)),
          attemptLatency: summary(cold.map(v => v.completeMs)),
          submission: summary(cold.map(v => v.submitMs)),
          queue: summary(cold.filter(v => v.queueMs !== null).map(v => v.queueMs)),
          failures: cold.filter(v => v.status !== 200).map(({ body, ...v }) => v),
          retries: cold.filter(v => v.attempts > 1).length,
          actualColdHandles: cold.filter(standardProducerObserved).length,
          correctOutputs: cold.filter(
            v =>
              v.status === 200 &&
              pageReportSchema.safeParse(v.body).success &&
              digest(statisticalPayload(v.body)) === expectedHash,
          ).length,
          attempts: cold.length,
        },
        samples: cold.map(({ body, ...v }) => v),
      };
    };
    const finishBuild = async (site: string, startDate: Date, endDate: Date) => {
      const build = await withPublishedRegistry(() =>
        createAnalysisBuild(
          site,
          { userId: actorId },
          {
            startDate,
            endDate,
            timezone: 'Asia/Shanghai',
            locale: 'zh-CN',
            requestId: randomUUID(),
          },
        ),
      );
      return finishFixtureBuild(
        async () =>
          (
            await native.query(
              `SELECT status,error_code,attempts,next_attempt_at,lease_until,checkpoint,work_done,work_total,
             updated_at,clock_timestamp() AS observed_at FROM liekan_analysis_build WHERE id=$1::uuid`,
              [build.id],
            )
          ).rows[0],
        () => withPublishedRegistry(() => runOneAnalysisWorkUnit(build.id)),
        async (state, result) => {
          await appendFile(
            `${folder}/fixture-build-progress.private.jsonl`,
            `${JSON.stringify({ buildId: build.id, state, result }, (_, value) =>
              typeof value === 'bigint' ? String(value) : value,
            )}\n`,
            { mode: 0o600 },
          );
        },
      );
    };
    try {
      await native.query(
        'INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$2,$3,\'admin\')',
        [actorId, username, hashSync(password, 8)],
      );
      // A synthetic website exists before server startup; the official example importer never runs.
      const collectionSite = randomUUID();
      await native.query(
        "INSERT INTO website(website_id,user_id,name,domain) VALUES($1::uuid,$2::uuid,'Synthetic collection benchmark','collection.invalid')",
        [collectionSite, actorId],
      );
      await native.query(
        "UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id=$1::uuid",
        [collectionSite],
      );
      await startContainer(appName, image, 3000);
      endpoint = `http://127.0.0.1:${(await docker(['port', databaseName, '3000/tcp'])).split(':').at(-1)}`;
      await waitHttp(endpoint);
      const login = await fetchJson(`${endpoint}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(login.response.status, 200);
      token = login.body.token;
      const candidateEndpoint = endpoint;
      let baselineEndpoint: string;
      if (baselineImage) {
        await startContainer(baselineName, baselineImage, 3001);
        baselineEndpoint = `http://127.0.0.1:${(await docker(['port', databaseName, '3001/tcp'])).split(':').at(-1)}`;
        await waitHttp(baselineEndpoint);
      }
      const secondActor = randomUUID(),
        secondUsername = `synthetic-consumer-${owner}`;
      consumers.push(secondActor);
      await native.query(
        'INSERT INTO "user"(user_id,username,password,role) VALUES($1::uuid,$2,$3,\'admin\')',
        [secondActor, secondUsername, hashSync(password, 8)],
      );
      const secondLogin = await fetchJson(`${endpoint}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: secondUsername, password }),
      });
      assert.equal(secondLogin.response.status, 200);
      const secondToken = secondLogin.body.token;
      await save('dashboard-runtime.json', {
        owner,
        label,
        databaseName,
        workerName,
        appName,
        baselineName,
        endpoint,
        baselineEndpoint,
        image,
        baselineImage,
        restartEntry: ['docker', 'restart', '--time', '15', workerName],
        ownershipCheck: [
          'docker',
          'inspect',
          '--format',
          `{{index .Config.Labels "${label}"}}`,
          workerName,
        ],
        lifecycle: 'Only available during this owned run; cleanup removes all listed containers.',
      });
      await save('dashboard-auth.private.json', { token, secondToken });
      await startContainer(workerName, image);
      for (const distribution of distributions) {
        await progress(`${distribution}:seed`);
        const today = calendarDayRange(Date.now(), 'Asia/Shanghai').startAt;
        const closedHour = Math.floor((Date.now() - 60000) / 3600000) * 3600000;
        assert(
          closedHour > today,
          'A closed visit hour inside the genuinely current local day is required',
        );
        const todayAt = today + 1800000;
        const oldAt = today - 6 * 86400000 + 1800000;
        const frozenEnd = Math.floor((Date.now() - 30000) / 30000) * 30000 - 1;
        const sites = Array.from({ length: 10 }, () => randomUUID()),
          selected = sites[0];
        const entry: any = {
          distribution,
          selected,
          timezone: 'Asia/Shanghai',
          todayStart: today,
          frozenEnd,
          todayEventTime: todayAt,
          oldEventTime: oldAt,
          rawInputRows: totalRows,
          eventRows: totalRows / 2,
          logRows: totalRows / 2,
          core: {},
        };
        report.distributions.push(entry);
        await saveReport();
        for (const site of sites) {
          await native.query(
            "INSERT INTO website(website_id,user_id,name,domain) VALUES($1::uuid,$2::uuid,'Synthetic dashboard fixture','dashboard.invalid')",
            [site, actorId],
          );
          await native.query(
            'INSERT INTO liekan_setting(website_id,is_demo) VALUES($1::uuid,true)',
            [site],
          );
          await native.query(
            "UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id=$1::uuid",
            [site],
          );
          await native.query(
            'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected,imported_at) VALUES(gen_random_uuid(),$1::uuid,$1,$2,0,to_timestamp($3/1000.0))',
            [site, totalRows / 20, todayAt],
          );
        }
        await native.query('DROP TABLE IF EXISTS pg_temp.benchmark_sessions');
        await native.query(
          `CREATE TEMP TABLE benchmark_sessions AS SELECT i,gen_random_uuid() AS session_id,
        ($1::uuid[])[CASE WHEN $3::boolean AND (i-1)%100<80 THEN 1 WHEN $3::boolean THEN 2+((i-1)%100-80)%9 ELSE 1+(i-1)%10 END] AS website_id
        FROM generate_series(1,$2::int) i`,
          [sites, Math.max(100, totalRows / 100), distribution === 'hotspot80'],
        );
        await native.query("SET session_replication_role='replica'");
        try {
          await native.query(
            `INSERT INTO session(session_id,website_id,created_at,browser,os,device,country,screen,language)
          SELECT session_id,website_id,to_timestamp($1/1000.0),'Chrome','Mac OS','desktop','CN','1920x1080','zh-CN' FROM benchmark_sessions`,
            [oldAt],
          );
          await native.query(
            `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type,hostname,referrer_domain)
          SELECT gen_random_uuid(),s.website_id,s.session_id,s.session_id,to_timestamp((CASE WHEN e.i%97<20 THEN $1::bigint ELSE $2::bigint END+(e.i%1000))/1000.0),'/synthetic/'||(e.i%100),1,'dashboard.invalid','chatgpt.com'
          FROM generate_series(1,$3::int) e(i) JOIN benchmark_sessions s ON s.i=1+(e.i-1)%$4::int`,
            [todayAt, oldAt, totalRows / 2, Math.max(100, totalRows / 100)],
          );
          await native.query(
            `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
          SELECT md5('dashboard-'||e.i||s.website_id),s.website_id,imp.id,to_timestamp((CASE WHEN e.i%97<20 THEN $1::bigint ELSE $2::bigint END+(e.i%1000))/1000.0),
          CASE WHEN e.i%7=0 THEN '/synthetic/style.CSS?x=1' ELSE '/synthetic/'||(e.i%100) END,'GET',CASE WHEN e.i%11=0 THEN 404 ELSE 200 END,0,'','','SyntheticBenchmarkBot','','GPTBot','OpenAI','训练','unverified',true,'recognized'
          FROM generate_series(1,$3::int) e(i) JOIN benchmark_sessions s ON s.i=1+(e.i-1)%$4::int JOIN liekan_import imp ON imp.website_id=s.website_id`,
            [todayAt, oldAt, totalRows / 2, Math.max(100, totalRows / 100)],
          );
          await seedBenchmarkBrowserEvidence(native, sites);
          await native.query(
            'UPDATE liekan_import imp SET accepted=(SELECT count(*) FROM liekan_log l WHERE l.import_id=imp.id) WHERE imp.website_id=ANY($1::uuid[])',
            [sites],
          );
        } finally {
          await native.query("SET session_replication_role='origin'");
        }
        for (const table of [
          'website_event',
          'session',
          'liekan_log',
          'liekan_event_quality',
          'liekan_event_environment',
          'liekan_session_source',
        ])
          await native.query(`ANALYZE ${table}`);
        entry.population = (
          await native.query(
            `SELECT
        (SELECT count(*) FROM website_event WHERE website_id=ANY($1::uuid[])) AS browser_events,
        (SELECT count(*) FROM liekan_log WHERE website_id=ANY($1::uuid[])) AS logs,
        (SELECT count(*) FROM website_event WHERE website_id=$2::uuid) AS selected_events,
        (SELECT count(*) FROM liekan_log WHERE website_id=$2::uuid) AS selected_logs,
        (SELECT count(*) FROM website_event WHERE website_id=$2::uuid AND created_at>=to_timestamp($3/1000.0)) AS selected_today_events,
        (SELECT count(*) FROM liekan_log WHERE website_id=$2::uuid AND created_at>=to_timestamp($3/1000.0)) AS selected_today_logs,
        (SELECT count(*) FROM liekan_event_quality WHERE website_id=ANY($1::uuid[])) AS quality_sidecars,
        (SELECT count(*) FROM liekan_event_environment WHERE website_id=ANY($1::uuid[])) AS environment_sidecars`,
            [sites, selected, today],
          )
        ).rows[0];
        assert.equal(
          Number(entry.population.browser_events) + Number(entry.population.logs),
          totalRows,
        );
        assert(
          Number(entry.population.selected_today_events) > 0 &&
            Number(entry.population.selected_today_logs) > 0,
        );
        const combinations = [
          {
            resource: 'overview',
            startAt: today,
            endAt: frozenEnd,
            timezone: 'Asia/Shanghai',
            chartPeriod: 'today',
          },
          {
            resource: 'human/overview',
            startAt: today,
            endAt: frozenEnd,
            timezone: 'Asia/Shanghai',
            chartPeriod: 'today',
          },
          {
            resource: 'overview',
            startAt: today - 6 * 86400000,
            endAt: frozenEnd,
            timezone: 'Asia/Shanghai',
            chartPeriod: '7d',
          },
          {
            resource: 'human/overview',
            startAt: today - 6 * 86400000,
            endAt: frozenEnd,
            timezone: 'Asia/Shanghai',
            chartPeriod: '7d',
          },
          {
            resource: 'overview',
            startAt: today - 29 * 86400000,
            endAt: frozenEnd,
            timezone: 'Asia/Shanghai',
            chartPeriod: '30d',
          },
        ];
        const rawBodies: any[] = [];
        await progress(`${distribution}:raw-http`);
        for (const p of combinations) {
          const raw = await waitReport(selected, p);
          assert.equal(raw.status, 200, `raw HTTP report failed: ${raw.errorCode}`);
          pageReportSchema.parse(raw.body);
          rawBodies.push(statisticalPayload(raw.body));
        }
        if (baselineImage) {
          await progress(`${distribution}:baseline-http-job-pipeline`);
          await assertOwner(workerName);
          await docker(['stop', '--time', '15', workerName]);
          await writeFile(
            `${folder}/${distribution}-candidate-raw-worker.private.log`,
            await docker(['logs', workerName]),
            { mode: 0o600 },
          );
          await docker(['rm', '--volumes', workerName]);
          await startContainer(workerName, baselineImage);
          endpoint = baselineEndpoint;
          entry.baseline = {
            image: baselineImage,
            mode: 'bounded-old-build-diagnostic',
            maximumAttempts: 5,
            p95Conclusion: 'unavailable-bounded-diagnostic',
            censored: false,
            censorReason: null,
            completedResponsesValid: true,
            correctness: [],
          };
          for (const [index, p] of combinations.entries()) {
            await clearResult(selected, p);
            let before: any;
            try {
              before = await waitReport(selected, p);
            } catch (error) {
              before = {
                status: 0,
                contractValid: false,
                statisticsHash: null,
                completeMs: null,
                queueMs: null,
                errorCode:
                  (error as any)?.code || (error as any)?.name || 'baseline-transport-failed',
              };
            }
            const { body, ...timing } = before;
            const outputMatch =
              before.status === 200 &&
              before.contractValid &&
              before.statisticsHash === digest(rawBodies[index]);
            if (before.status === 200 && !outputMatch)
              entry.baseline.completedResponsesValid = false;
            entry.baseline.correctness.push({
              parameters: p,
              expectedStatisticsHash: digest(rawBodies[index]),
              outputMatch,
              ...timing,
            });
            const budgetFailure =
              before.status !== 200 ||
              !outputMatch ||
              before.completeMs > 5000 ||
              (before.firstStatus === 202 && (before.queueMs === null || before.queueMs > 2000));
            if (budgetFailure) {
              entry.baseline.censored = true;
              entry.baseline.censorReason =
                before.status !== 200
                  ? 'unfinished-or-failed-old-build-response'
                  : !outputMatch
                    ? 'old-build-output-mismatch'
                    : 'old-build-observed-budget-miss';
            }
            await saveReport();
            if (budgetFailure) break;
          }
          entry.baseline.actualAttempts = entry.baseline.correctness.length;
          entry.baseline.completedResponses = entry.baseline.correctness.filter(
            (v: any) => v.status === 200,
          ).length;
          entry.baseline.p95Ms = null;
          entry.baseline.unattemptedCombinations = combinations.slice(
            entry.baseline.actualAttempts,
          );
          endpoint = candidateEndpoint;
        }
        await docker(['stop', '--time', '15', workerName]);
        await writeFile(
          `${folder}/${distribution}-baseline-worker.private.log`,
          await docker(['logs', workerName]),
          { mode: 0o600 },
        );
        await docker(['rm', '--volumes', workerName]);
        // The stopped old worker has released its connections. Clear only these owned derived combinations,
        // including unfinished diagnostic handles, before the candidate's independent measurements.
        for (const p of combinations) await clearResult(selected, p);
        await native.query(
          "UPDATE liekan_analysis_site SET mode='live' WHERE website_id=$1::uuid",
          [selected],
        );
        await progress(`${distribution}:bounded-rollup-build`);
        entry.build = await finishBuild(
          selected,
          new Date(today - 6 * 86400000),
          new Date(closedHour),
        );
        await startContainer(workerName, image);
        entry.dimensions = (
          await native.query(
            `SELECT count(*) AS rows,count(DISTINCT dimensions) AS dimension_groups,
        count(DISTINCT dimensions-'staticResource') AS groups_without_static, count(DISTINCT dimensions->'staticResource') AS static_variants,
        sum(pg_column_size(dimensions)-pg_column_size(dimensions-'staticResource')) AS dimension_payload_extra_bytes,
        sum(pg_column_size(l)) AS tuple_bytes FROM liekan_analysis_log l WHERE website_id=$1::uuid`,
            [selected],
          )
        ).rows[0];
        const countsInput = {
          websiteId: selected,
          startDate: new Date(today),
          endDate: new Date(frozenEnd),
        };
        const todayRaw = await readAnalysisLogToday({ ...countsInput, allowRawOnly: true });
        const todayCovered = await readAnalysisLogToday(countsInput);
        assert.equal(todayRaw.requests, todayCovered.requests);
        assert.equal(todayRaw.abnormal, todayCovered.abnormal);
        entry.transition = { raw: todayRaw, v4: todayCovered };
        await native.query(
          `UPDATE liekan_analysis_manifest SET versions=jsonb_set(versions,'{engine}','"analysis-rollups-v3"') WHERE website_id=$1::uuid`,
          [selected],
        );
        const oldCoverage = await readAnalysisLogToday(countsInput);
        assert.equal(oldCoverage.coverage.manifests, 0);
        assert.equal(oldCoverage.requests, todayRaw.requests);
        entry.transition.v3Rejected = oldCoverage;
        await native.query(
          `UPDATE liekan_analysis_manifest SET versions=jsonb_set(versions,'{engine}',to_jsonb($2::text)) WHERE website_id=$1::uuid`,
          [selected, ANALYSIS_ROLLUP_VERSION],
        );
        await progress(`${distribution}:covered-http-correctness`);
        entry.correctness = [];
        for (const [index, p] of combinations.entries()) {
          await clearResult(selected, p);
          const covered = await waitReport(selected, p, 65000, token, { followAdmission: true });
          assert.equal(covered.status, 200, `covered HTTP report failed: ${covered.errorCode}`);
          pageReportSchema.parse(covered.body);
          assert.deepEqual(statisticalPayload(covered.body), rawBodies[index]);
          entry.correctness.push({
            combination: p,
            rawDigest: digest(rawBodies[index]),
            coveredDigest: digest(statisticalPayload(covered.body)),
            equal: true,
          });
        }
        for (const p of combinations.slice(0, 2)) {
          await progress(`${distribution}:${p.resource}:warm-and-logical-cold`);
          entry.core[p.resource] = await measureCore(
            selected,
            p,
            rawBodies[combinations.indexOf(p)],
          );
          await saveReport();
        }
        // Each sampled round opens the same five combinations together with exactly one cleared result.
        // Reuse still-running short maintenance units and register a new bounded unit when one finishes.
        entry.standardFive = { requestedRounds: samples, rounds: [] };
        for (let round = 0; round < samples; round++) {
          await clearResult(selected, combinations[4]);
          for (const [automaticHistory, origin, at] of [
            [true, 'synthetic-dashboard-history', oldAt],
            [false, 'synthetic-dashboard-incremental', todayAt],
          ] as const)
            await native.query(
              `INSERT INTO liekan_analysis_build(id,website_id,epoch,family,unit_seconds,range_start,range_end,timezone,locale,request_id,request_hash,status,work_total,automatic_history)
             SELECT gen_random_uuid(),s.website_id,s.epoch,'log',300,to_timestamp($2/1000.0),to_timestamp(($2+300000)/1000.0),'UTC','en-US',gen_random_uuid(),$4,'queued',1,$3
             FROM liekan_analysis_site s WHERE s.website_id=$1::uuid AND NOT EXISTS(SELECT 1 FROM liekan_analysis_build b
              WHERE b.website_id=s.website_id AND b.epoch=s.epoch AND b.request_hash=$4 AND b.status IN('queued','running'))`,
              [selected, Math.floor(at / 300000) * 300000, automaticHistory, origin],
            );
          const background = (
            await native.query(
              `SELECT id,status,automatic_history,family,unit_seconds FROM liekan_analysis_build WHERE website_id=$1::uuid
             AND request_hash IN('synthetic-dashboard-history','synthetic-dashboard-incremental') AND status IN('queued','running') ORDER BY automatic_history`,
              [selected],
            )
          ).rows;
          const submittedAt = Date.now();
          const results = await Promise.all(
            combinations.map(async (p, index) => {
              const { body, ...timing } = await waitReport(selected, p, 65000, token, {
                followAdmission: true,
              });
              return { parameters: p, expectedStatisticsHash: digest(rawBodies[index]), ...timing };
            }),
          );
          const initiallyPublished = results.filter(v => v.firstStatus === 200).length;
          const cold = results.filter(v => v.firstStatus !== 200);
          const backgroundPresent =
            background.some(b => b.automatic_history) && background.some(b => !b.automatic_history);
          entry.standardFive.rounds.push({
            round,
            submittedAt,
            finishedAt: Date.now(),
            background,
            backgroundPresent,
            initiallyPublished,
            coldCount: cold.filter(standardProducerObserved).length,
            results,
            passed:
              initiallyPublished >= 4 &&
              cold.length === 1 &&
              cold.every(standardProducerObserved) &&
              backgroundPresent &&
              results.every(
                v =>
                  v.status === 200 &&
                  v.contractValid &&
                  v.statisticsHash === v.expectedStatisticsHash,
              ),
          });
          await saveReport();
        }
        const standardResults = entry.standardFive.rounds.flatMap((r: any) => r.results);
        const standardCold = standardResults.filter((v: any) => v.firstStatus !== 200);
        entry.standardFive.cold = {
          accepted: standardCold.filter(standardProducerObserved).length,
          initial429: standardCold.filter((v: any) => v.firstStatus === 429).length,
          responseHandles: standardCold.filter(
            (v: any) => v.producer?.source === 'response-handle' && standardProducerObserved(v),
          ).length,
          publishedAfterAdmission: standardCold.filter(
            (v: any) => v.producer?.source === 'published-response' && standardProducerObserved(v),
          ).length,
          complete: summary(
            standardCold
              .filter((v: any) => v.status === 200 && v.contractValid)
              .map((v: any) => v.completeMs),
          ),
          queue: summary(
            standardCold
              .filter((v: any) => v.status === 200 && v.contractValid && v.queueMs !== null)
              .map((v: any) => v.queueMs),
          ),
          failures: standardCold.filter(
            (v: any) =>
              v.status !== 200 ||
              !v.contractValid ||
              v.statisticsHash !== v.expectedStatisticsHash ||
              !standardProducerObserved(v),
          ),
        };
        entry.standardFive.publishedHttp = summary(
          standardResults
            .filter((v: any) => v.firstStatus === 200 && v.status === 200 && v.contractValid)
            .map((v: any) => v.submitMs),
        );
        entry.standardFive.passed = standardFivePassed(entry.standardFive, samples);
        await drainConsumers(`${distribution}:before-double-cold`);
        const doubleRounds: any[] = [];
        for (let sample = 0; sample < samples; sample++) {
          await drainConsumers(`${distribution}:double-cold:${sample}`);
          for (const p of combinations.slice(0, 2)) await clearResult(selected, p);
          const doubleStart = performance.now();
          const double = await Promise.all(
            combinations
              .slice(0, 2)
              .map(p => waitReport(selected, p, 65000, token, { followAdmission: true })),
          );
          doubleRounds.push({
            wallMs: performance.now() - doubleStart,
            results: double.map(({ body, ...v }, index) => ({
              ...v,
              parameters: combinations[index],
              expectedStatisticsHash: digest(rawBodies[index]),
            })),
          });
        }
        entry.doubleCold = {
          rounds: doubleRounds,
          wall: summary(doubleRounds.map(round => round.wallMs)),
          results: doubleRounds.flatMap(round => round.results),
        };
        entry.doubleCold.passed = doubleColdPassed(entry.doubleCold, samples);
        await drainConsumers(`${distribution}:before-ten-cold-burst`);
        const burst = Array.from({ length: 10 }, (_, i) => ({
          ...combinations[i % 2],
          startAt: today - i - 1,
        }));
        await native.query(
          "UPDATE liekan_analysis_site SET mode='live' WHERE website_id=ANY($1::uuid[])",
          [sites.slice(1, 3)],
        );
        let monitoring = true;
        const peaks = { global: 0, site: 0, actor: 0, samples: 0 };
        const quotaFrames: any[] = [];
        const captureQuota = async () => {
          const queryStartedAt = Date.now();
          const row = (
            await native.query(
              `WITH active AS (
            SELECT * FROM liekan_analysis_query WHERE status IN('queued','running') AND retention_until>clock_timestamp())
            SELECT (SELECT count(*) FROM active) AS global,
             (SELECT coalesce(jsonb_object_agg(website_id,n),'{}'::jsonb) FROM(SELECT website_id,count(*) AS n FROM active GROUP BY website_id) s) AS sites,
             (SELECT coalesce(jsonb_object_agg(actor_id,n),'{}'::jsonb) FROM(SELECT c.actor_id,count(DISTINCT q.id) AS n
               FROM active q JOIN liekan_analysis_query_consumer c ON c.job_id=q.id
               WHERE c.actor_id=ANY($1::uuid[]) AND q.target=ANY($2::text[]) GROUP BY c.actor_id) a) AS actors`,
              [[actorId, secondActor], liveAnalysisTargets],
            )
          ).rows[0];
          const frame = {
            queryStartedAt,
            observedAt: Date.now(),
            global: Number(row.global),
            sites: row.sites,
            actors: row.actors,
          };
          quotaFrames.push(frame);
          peaks.global = Math.max(peaks.global, frame.global);
          peaks.site = Math.max(peaks.site, ...Object.values(frame.sites).map(Number), 0);
          peaks.actor = Math.max(peaks.actor, ...Object.values(frame.actors).map(Number), 0);
          peaks.samples++;
        };
        await captureQuota();
        const monitor = (async () => {
          while (monitoring) {
            await captureQuota();
            await pause(100);
          }
        })();
        const burstStartedAt = Date.now();
        try {
          const requests = burst.map(async (p, i) => {
            const site = sites[i % 3],
              consumer = i % 2;
            const requestedAt = Date.now();
            try {
              const { body, ...timing } = await waitReport(
                site,
                p,
                30000,
                consumer ? secondToken : token,
                { followAdmission: false },
              );
              return {
                site,
                consumer,
                consumerId: consumer ? secondActor : actorId,
                parameters: p,
                ...timing,
              };
            } catch (error) {
              return {
                site,
                consumer,
                consumerId: consumer ? secondActor : actorId,
                parameters: p,
                requestedAt,
                observedAt: Date.now(),
                firstObservedAt: Date.now(),
                status: 0,
                firstStatus: 0,
                contractValid: false,
                statisticsHash: null,
                errorCode: (error as any)?.code || (error as any)?.name || 'transport-failed',
              };
            }
          });
          const collectionEvent = randomUUID();
          const collection = (async () => {
            const startedAt = Date.now();
            const start = performance.now();
            try {
              const response = await fetch(`${endpoint}/api/send`, {
                method: 'POST',
                headers: benchmarkBrowserHeaders,
                body: JSON.stringify({
                  type: 'event',
                  payload: {
                    website: collectionSite,
                    eventId: collectionEvent,
                    hostname: 'collection.invalid',
                    url: `/synthetic/burst/${distribution}`,
                  },
                }),
                signal: AbortSignal.timeout(10000),
              });
              const bytes = await response.text();
              let errorCode: string | null = null;
              if (!response.ok) {
                try {
                  errorCode = JSON.parse(bytes).error?.code || 'collection-http-failed';
                } catch {
                  errorCode = 'collection-http-failed';
                }
              }
              return {
                eventId: collectionEvent,
                startedAt,
                observedAt: Date.now(),
                elapsedMs: performance.now() - start,
                status: response.status,
                errorCode,
              };
            } catch (error) {
              return {
                eventId: collectionEvent,
                startedAt,
                observedAt: Date.now(),
                elapsedMs: performance.now() - start,
                status: 0,
                errorCode:
                  (error as any)?.code || (error as any)?.name || 'collection-transport-failed',
              };
            }
          })();
          const [results, collectionResult] = await Promise.all([
            Promise.all(requests),
            collection,
          ]);
          entry.tenColdBurst = results;
          // Public eventId identifies the client receipt; its committed server event has its own UUID.
          const committed = Number(
            (
              await native.query(
                `SELECT count(*) FROM liekan_collection_receipt r
                 JOIN website_event e ON e.website_id=r.website_id AND e.event_id=r.event_id
                 WHERE r.website_id=$1::uuid AND r.client_event_id=$2::uuid`,
                [collectionSite, collectionEvent],
              )
            ).rows[0].count,
          );
          entry.tenColdBurstCollection = {
            ...collectionResult,
            committed,
            overlapped:
              collectionResult.startedAt <= Math.max(...results.map(v => v.observedAt)) &&
              collectionResult.observedAt >= burstStartedAt,
          };
          burstCollectionTrials.push(entry.tenColdBurstCollection);
        } finally {
          monitoring = false;
          await monitor;
        }
        const quotaEvidence = (result: any) => {
          const state = result.admissionState || [];
          const counts = {
            global: state.length,
            site: state.filter((q: any) => q.website_id === result.site).length,
            actor: state.filter(
              (q: any) =>
                liveAnalysisTargets.includes(q.target) && q.consumers.includes(result.consumerId),
            ).length,
          };
          if (counts.global >= 32 || counts.site >= 8 || counts.actor >= 2)
            return { verified: true, kind: 'response-admission-state', counts };
          const matching = quotaFrames.filter(
            frame =>
              frame.observedAt >= result.requestedAt &&
              frame.queryStartedAt <= result.firstObservedAt &&
              (frame.global >= 32 ||
                Number(frame.sites[result.site] || 0) >= 8 ||
                Number(frame.actors[result.consumerId] || 0) >= 2),
          );
          return {
            verified: matching.length > 0,
            kind: 'overlapping-quota-observation',
            observations: matching,
            counts,
          };
        };
        entry.tenColdBurst = entry.tenColdBurst.map((result: any) => {
          const accepted = result.firstStatus === 202 || result.firstStatus === 200;
          const evidence = result.firstStatus === 429 ? quotaEvidence(result) : null;
          const passed = burstResponsePassed({ ...result, quotaEvidence: evidence });
          return {
            ...result,
            accepted,
            quotaEvidence: evidence,
            terminal: passed ? (accepted ? 'ready' : 'quota-rejected') : 'failed',
            passed,
          };
        });
        const containerState = [];
        for (const name of [
          databaseName,
          appName,
          workerName,
          ...(baselineImage ? [baselineName] : []),
        ]) {
          await assertOwner(name);
          const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', name]));
          containerState.push({
            name,
            running: state.Running,
            oomKilled: state.OOMKilled,
            dead: state.Dead,
            restarting: state.Restarting,
            exitCode: state.ExitCode,
            status: state.Status,
            error: Boolean(state.Error),
          });
        }
        entry.tenColdBurstLimits = {
          global: 32,
          site: 8,
          actor: 2,
          sites: 3,
          consumers: 2,
          observedPeaks: peaks,
          observations: quotaFrames,
        };
        entry.tenColdBurstGate = {
          results: entry.tenColdBurst.length,
          containerState,
          passed: burstPassed(
            entry.tenColdBurst,
            peaks,
            containerState,
            entry.tenColdBurstCollection,
          ),
        };
        await native.query(
          "UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id=ANY($1::uuid[])",
          [sites.slice(1, 3)],
        );
        await drainConsumers(`${distribution}:after-ten-cold-burst`);
        // Settle registered readers, builds and descendants while automatic maintenance continues.
        await drainConsumers(`${distribution}:history-growth-isolated-start`, sites, true);
        const growthHttpBefore: Record<string, any> = {};
        entry.historyGrowthHttp = {};
        entry.historyGrowthStage = {
          startedAt: new Date().toISOString(),
          loadCondition:
            'Adjacent before/after arms use the same inputs; registered readers, builds and descendants settle at arm boundaries. Continuing automatic maintenance is recorded. Buffers stay warm.',
        };
        for (const p of combinations.slice(0, 2)) {
          await drainConsumers(`${distribution}:${p.resource}:growth-before-arm`, sites, true);
          await progress(`${distribution}:${p.resource}:history-growth-before-http`);
          const measured: any[] = [];
          for (let sample = 0; sample < samples; sample++) {
            await clearResult(selected, p);
            measured.push(await waitReport(selected, p, 65000, token, { followAdmission: true }));
          }
          growthHttpBefore[p.resource] = {
            ...summary(measured.filter(v => v.status === 200).map(v => v.completeMs)),
            queue: summary(measured.filter(v => v.queueMs !== null).map(v => v.queueMs)),
            sampleTimings: measured.map(({ body, ...v }) => v),
            completedSamples: measured.filter(v => v.status === 200).length,
            failures: measured.filter(v => v.status !== 200).map(({ body, ...v }) => v),
            outputsEqual: measured.every(
              v =>
                v.status === 200 &&
                digest(statisticalPayload(v.body)) === digest(rawBodies[combinations.indexOf(p)]),
            ),
          };
          entry.historyGrowthBefore = growthHttpBefore;
          await saveReport();
        }
        await drainConsumers(`${distribution}:history-growth-before-source-expansion`, sites, true);
        const todayCoverage = async () =>
          (
            await native.query(
              `SELECT m.family,m.bucket,m.bucket_end,m.generation,m.fingerprint,m.versions,m.row_count
          FROM liekan_analysis_manifest m JOIN liekan_analysis_site s USING(website_id,epoch)
          WHERE m.website_id=$1::uuid AND m.bucket<to_timestamp($3/1000.0) AND m.bucket_end>to_timestamp($2/1000.0)
          ORDER BY m.family,m.bucket`,
              [selected, today, frozenEnd],
            )
          ).rows;
        const coverageBeforeGrowth = await todayCoverage();
        // Fixed today plus 100% more old history; source rows remain explicitly separate from the standard 1M fixture.
        const growthBefore: number[] = [],
          growthAfter: number[] = [];
        for (let i = 0; i < samples; i++) {
          const start = performance.now();
          await readAnalysisLogToday(countsInput);
          growthBefore.push(performance.now() - start);
        }
        const oldImport = randomUUID();
        await native.query("SET session_replication_role='replica'");
        try {
          await native.query(
            'INSERT INTO liekan_import(id,website_id,digest,accepted,rejected,imported_at) VALUES($1::uuid,$2::uuid,$1,$3,0,to_timestamp($4/1000.0))',
            [oldImport, selected, Number(entry.population.selected_logs), today - 365 * 86400000],
          );
          await native.query(
            `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
        SELECT md5(l.id||'-old-growth'),l.website_id,$2::uuid,l.created_at-interval '365 days',l.path,l.method,l.status,l.bytes,l.ip_masked,l.ip_hash,l.user_agent,l.location,l.bot,l.vendor,l.bot_type,l.verification,l.ai_eligible,l.recognition_state FROM liekan_log l WHERE l.website_id=$1::uuid`,
            [selected, oldImport],
          );
          await native.query('DROP TABLE IF EXISTS pg_temp.benchmark_growth_sessions');
          await native.query(
            `CREATE TEMP TABLE benchmark_growth_sessions AS SELECT s.session_id AS original_session_id,gen_random_uuid() AS growth_session_id
             FROM session s WHERE s.website_id=$1::uuid AND EXISTS(SELECT 1 FROM website_event e WHERE e.website_id=s.website_id AND e.session_id=s.session_id)`,
            [selected],
          );
          await native.query('DROP TABLE IF EXISTS pg_temp.benchmark_growth_visits');
          await native.query(
            `CREATE TEMP TABLE benchmark_growth_visits AS SELECT session_id AS original_session_id,visit_id AS original_visit_id,gen_random_uuid() AS growth_visit_id
             FROM(SELECT DISTINCT session_id,visit_id FROM website_event WHERE website_id=$1::uuid) visits`,
            [selected],
          );
          await native.query(
            `INSERT INTO session(session_id,website_id,created_at,browser,os,device,country,region,city,screen,language,distinct_id)
             SELECT g.growth_session_id,s.website_id,s.created_at-interval '365 days',s.browser,s.os,s.device,s.country,s.region,s.city,s.screen,s.language,s.distinct_id
             FROM benchmark_growth_sessions g JOIN session s ON s.session_id=g.original_session_id AND s.website_id=$1::uuid`,
            [selected],
          );
          await native.query(
            `INSERT INTO website_event(event_id,website_id,session_id,visit_id,created_at,url_path,event_type,hostname,referrer_domain)
             SELECT gen_random_uuid(),e.website_id,s.growth_session_id,v.growth_visit_id,e.created_at-interval '365 days',e.url_path,e.event_type,e.hostname,e.referrer_domain
             FROM website_event e JOIN benchmark_growth_sessions s ON s.original_session_id=e.session_id
              JOIN benchmark_growth_visits v ON v.original_session_id=e.session_id AND v.original_visit_id=e.visit_id
             WHERE e.website_id=$1::uuid`,
            [selected],
          );
          await seedBenchmarkBrowserEvidence(native, [selected]);
        } finally {
          await native.query("SET session_replication_role='origin'");
        }
        for (const table of [
          'liekan_log',
          'website_event',
          'liekan_event_quality',
          'liekan_event_environment',
        ])
          await native.query(`ANALYZE ${table}`);
        const growthTuples = (
          await native.query(
            `SELECT
          (SELECT count(*) FROM benchmark_growth_sessions) AS added_sessions,
          (SELECT count(*) FROM benchmark_growth_visits) AS added_visits,
          (SELECT count(*) FROM website_event e JOIN benchmark_growth_sessions g ON e.session_id=g.growth_session_id WHERE e.website_id=$1::uuid) AS added_events,
          (SELECT count(*) FROM website_event e WHERE e.website_id=$1::uuid AND e.created_at>=to_timestamp($2/1000.0) AND e.created_at<=to_timestamp($3/1000.0)) AS today_events,
          (SELECT count(*) FROM liekan_log l WHERE l.website_id=$1::uuid AND l.created_at>=to_timestamp($2/1000.0) AND l.created_at<=to_timestamp($3/1000.0)) AS today_logs,
          (SELECT count(*) FROM website_event current_event WHERE current_event.website_id=$1::uuid AND current_event.created_at>=to_timestamp($2/1000.0)
            AND (EXISTS(SELECT 1 FROM benchmark_growth_sessions g WHERE g.growth_session_id=current_event.session_id)
             OR EXISTS(SELECT 1 FROM benchmark_growth_visits g WHERE g.growth_visit_id=current_event.visit_id))) AS today_tuple_overlap`,
            [selected, today, frozenEnd],
          )
        ).rows[0];
        const coverageAfterGrowth = await todayCoverage();
        entry.historyGrowthFixture = {
          independentOldSessionAndVisitTuples: true,
          ...growthTuples,
          todayCoverageBeforeHash: digest(coverageBeforeGrowth),
          todayCoverageAfterHash: digest(coverageAfterGrowth),
          todayCoverageUnchanged: digest(coverageBeforeGrowth) === digest(coverageAfterGrowth),
          passed:
            Number(growthTuples.added_events) === Number(entry.population.selected_events) &&
            Number(growthTuples.today_tuple_overlap) === 0 &&
            Number(growthTuples.today_events) === Number(entry.population.selected_today_events) &&
            Number(growthTuples.today_logs) === Number(entry.population.selected_today_logs) &&
            digest(coverageBeforeGrowth) === digest(coverageAfterGrowth),
        };
        for (let i = 0; i < samples; i++) {
          const start = performance.now();
          await readAnalysisLogToday(countsInput);
          growthAfter.push(performance.now() - start);
        }
        entry.fixedTodayGrowingOldHistory = {
          layer: 'today reader kernel',
          addedOldLogRows: Number(entry.population.selected_logs),
          before: summary(growthBefore),
          after: summary(growthAfter),
          ratio: summary(growthAfter).p95Ms / summary(growthBefore).p95Ms,
        };
        for (const p of combinations.slice(0, 2)) {
          await drainConsumers(`${distribution}:${p.resource}:growth-after-arm`, sites, true);
          await progress(`${distribution}:${p.resource}:fixed-today-growing-old-history-http`);
          const measured: any[] = [];
          for (let sample = 0; sample < samples; sample++) {
            await clearResult(selected, p);
            measured.push(await waitReport(selected, p, 65000, token, { followAdmission: true }));
          }
          const after = summary(measured.filter(v => v.status === 200).map(v => v.completeMs));
          entry.historyGrowthHttp[p.resource] = {
            layer: 'cold HTTP/job/result completion',
            addedOldEvents: Number(entry.population.selected_events),
            addedOldLogs: Number(entry.population.selected_logs),
            before: growthHttpBefore[p.resource],
            after,
            p95Ratio:
              after.p95Ms === null || growthHttpBefore[p.resource].p95Ms === null
                ? null
                : after.p95Ms / growthHttpBefore[p.resource].p95Ms,
            attemptLatency: summary(measured.map(v => v.completeMs)),
            queue: summary(measured.filter(v => v.queueMs !== null).map(v => v.queueMs)),
            sampleTimings: measured.map(({ body, ...v }) => v),
            failures: measured.filter(v => v.status !== 200).map(({ body, ...v }) => v),
            retries: measured.filter(v => v.attempts > 1).length,
            outputsEqual: measured.every(
              v =>
                v.status === 200 &&
                digest(statisticalPayload(v.body)) === digest(rawBodies[combinations.indexOf(p)]),
            ),
          };
          await saveReport();
        }
        entry.historyGrowthStage.finishedAt = new Date().toISOString();
        let planNumber = 0;
        await analysisTransaction(
          tx =>
            withinQuerySnapshot(
              {
                $executeRawUnsafe: (statement: string, ...values: unknown[]) =>
                  tx.$executeRawUnsafe(statement, ...values),
                $queryRawUnsafe: async (statement: string, ...values: unknown[]) => {
                  if (statement.includes('WITH covered AS MATERIALIZED')) {
                    const plans = await tx.$queryRawUnsafe(
                      `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${statement}`,
                      ...values,
                    );
                    await save(`${distribution}-today-plan-${planNumber++}.json`, plans);
                  }
                  return tx.$queryRawUnsafe(statement, ...values);
                },
              },
              async () => {
                await readAnalysisLogToday({ ...countsInput, allowRawOnly: true });
                await readAnalysisLogToday(countsInput);
              },
            ),
          'RepeatableRead',
        );
        // A real late log commit drives the existing capture, publication and automatic-read path.
        const previous = await waitReport(selected, combinations[0], 65000, token, {
          followAdmission: true,
        });
        assert.equal(
          previous.status,
          200,
          `freshness initial HTTP report failed: ${previous.errorCode}`,
        );
        assert(previous.contractValid, 'freshness initial report contract is invalid');
        const previousCard = previous.body.cards.find((card: any) => card.label === '今日总请求');
        assert.equal(typeof previousCard?.value, 'number');
        const writeStartedAt = Date.now();
        await native.query(
          `INSERT INTO liekan_log(id,website_id,import_id,created_at,path,method,status,bytes,ip_masked,ip_hash,user_agent,location,bot,vendor,bot_type,verification,ai_eligible,recognition_state)
        SELECT $1,$2::uuid,id,to_timestamp($3/1000.0),'/synthetic/freshness','GET',200,0,'','','SyntheticBenchmarkBot','','GPTBot','OpenAI','训练','unverified',true,'recognized' FROM liekan_import WHERE website_id=$2::uuid ORDER BY imported_at DESC LIMIT 1`,
          [randomUUID(), selected, writeStartedAt - 60000],
        );
        const committedAt = Date.now();
        const observations: any[][] = combinations.map(() => []);
        let propagatedAt: number | null = null,
          lastOverviewValue = previousCard.value;
        for (
          let round = 0;
          round < samples || (propagatedAt === null && Date.now() - committedAt < 120000);
          round++
        ) {
          const readings = await Promise.all(
            combinations.map(async (p, index) => {
              const requestedAt = Date.now();
              try {
                const response = await fetchJson(path(selected, p));
                const observedAt = Date.now();
                const body = response.body;
                const contractValid =
                  response.response.status === 200 &&
                  pageReportSchema.safeParse(body).success &&
                  body.website.id === selected &&
                  body.resource === p.resource &&
                  body.range.startAt === p.startAt &&
                  body.range.endAt === p.endAt &&
                  body.range.timezone === p.timezone;
                const dataThrough =
                  typeof body.meta?.snapshot?.dataThrough === 'number' &&
                  Number.isFinite(body.meta.snapshot.dataThrough)
                    ? body.meta.snapshot.dataThrough
                    : null;
                const lagMs = dataThrough === null ? null : observedAt - dataThrough;
                const value = contractValid
                  ? (body.cards.find((card: any) => card.label === '今日总请求')?.value ?? null)
                  : null;
                return {
                  round,
                  combination: index,
                  requestedAt,
                  observedAt,
                  dataThrough,
                  lagMs,
                  status: response.response.status,
                  contractValid,
                  timestampValid: dataThrough !== null && lagMs >= 0,
                  statisticsHash: contractValid ? digest(statisticalPayload(body)) : null,
                  snapshotState: body.meta?.snapshot?.state ?? null,
                  responseMs: response.wallMs,
                  value,
                  errorCode: body.error?.code ?? null,
                };
              } catch (error) {
                return {
                  round,
                  combination: index,
                  requestedAt,
                  observedAt: Date.now(),
                  dataThrough: null,
                  lagMs: null,
                  status: 0,
                  contractValid: false,
                  timestampValid: false,
                  statisticsHash: null,
                  snapshotState: null,
                  responseMs: null,
                  value: null,
                  errorCode:
                    (error as any)?.code || (error as any)?.name || 'freshness-transport-failed',
                };
              }
            }),
          );
          for (const [index, reading] of readings.entries()) observations[index].push(reading);
          if (readings[0].contractValid) {
            lastOverviewValue = readings[0].value;
            if (lastOverviewValue === previousCard.value + 1 && propagatedAt === null)
              propagatedAt = readings[0].observedAt;
          }
          entry.activeFreshnessObservations = observations;
          await saveReport();
          if (round + 1 < samples || (propagatedAt === null && Date.now() - committedAt < 120000))
            await pause(1000);
        }
        const freshnessCombinations = observations.map((readings, index) => {
          return {
            parameters: combinations[index],
            minimumSamples: samples,
            ...freshnessLagResult(readings, samples),
            observations: readings,
          };
        });
        entry.activeFreshness = {
          layer: 'five published HTTP combinations under continuous active automatic reads',
          committedAt,
          samplingCadenceMs: 1000,
          propagation: {
            before: previousCard.value,
            expected: previousCard.value + 1,
            after: lastOverviewValue,
            firstObservedAt: propagatedAt,
            elapsedMs: propagatedAt === null ? null : propagatedAt - committedAt,
            passed: propagatedAt !== null,
          },
          dataThroughLag: {
            p95LimitMs: 60000,
            minimumSamplesPerCombination: samples,
            combinations: freshnessCombinations,
            passed:
              freshnessCombinations.length === 5 && freshnessCombinations.every(c => c.passed),
          },
          passed: propagatedAt !== null && freshnessCombinations.every(c => c.passed),
        };
        delete entry.activeFreshnessObservations;
        // Do not carry this distribution's background work into the next distribution.
        await native.query(
          "UPDATE liekan_analysis_site SET mode='disabled' WHERE website_id=ANY($1::uuid[])",
          [sites],
        );
        await saveReport();
      }
      if (baselineImage) {
        const arms: Record<string, number[]> = { baseline: [], candidate: [] },
          failures: any[] = [];
        for (let i = 0; i < samples; i++)
          for (const [name, base] of i % 2
            ? [
                ['candidate', endpoint],
                ['baseline', baselineEndpoint],
              ]
            : [
                ['baseline', baselineEndpoint],
                ['candidate', endpoint],
              ]) {
            const start = performance.now();
            const response = await fetch(`${base}/api/send`, {
              method: 'POST',
              headers: benchmarkBrowserHeaders,
              body: JSON.stringify({
                type: 'event',
                payload: {
                  website: collectionSite,
                  eventId: randomUUID(),
                  hostname: 'collection.invalid',
                  url: `/synthetic/collection/${i}`,
                },
              }),
              signal: AbortSignal.timeout(10000),
            });
            await response.arrayBuffer();
            if (response.ok) arms[name].push(performance.now() - start);
            else failures.push({ arm: name, status: response.status });
          }
        report.collection = {
          layer: 'actual HTTP collection and committed writes',
          derivedMaintenance:
            'The collection website is disabled for derived maintenance. Measure live capture and closed-bucket lag separately with --capture-benchmark.',
          baseline: summary(arms.baseline),
          candidate: summary(arms.candidate),
          failures,
          p95Ratio: summary(arms.candidate).p95Ms / summary(arms.baseline).p95Ms,
          committedEvents: Number(
            (
              await native.query('SELECT count(*) FROM website_event WHERE website_id=$1::uuid', [
                collectionSite,
              ])
            ).rows[0].count,
          ),
          expectedCommittedEvents: samples * 2 + distributions.length,
          burstCollectionTrials,
        };
      } else
        report.collection = {
          status: 'not measured',
          reason: '--baseline-image is required for a paired collection comparison',
        };
      const logs = await docker(['logs', workerName]);
      const retainedLogs = (await readdir(folder)).filter(name =>
        /^(uniform|hotspot80)-(candidate-raw|baseline)-worker[.]private[.]log$/.test(name),
      );
      const allLogs = [
        logs,
        ...(await Promise.all(retainedLogs.map(name => readFile(`${folder}/${name}`, 'utf8')))),
      ];
      const diagnostics = allLogs
        .join('\n')
        .split('\n')
        .flatMap(line => {
          try {
            const item = JSON.parse(line);
            return item.event === 'analysis-attempt' || item.event === 'analysis-admission'
              ? [item]
              : [];
          } catch {
            return [];
          }
        });
      await save('dashboard-worker-diagnostics.json', diagnostics);
      report.workerDiagnostics = {
        records: diagnostics.length,
        path: 'dashboard-worker-diagnostics.json',
      };
      report.elapsedMs = performance.now() - started;
      report.candidateTargetsPassed =
        report.distributions.every(
          (d: any) =>
            Object.values(d.core).every(
              (c: any) =>
                c.warm.samples === samples &&
                c.warm.correctOutputs === samples &&
                c.warm.p95Ms <= 500 &&
                c.warm.failures.length === 0 &&
                c.logicalCold.p95Ms <= 5000 &&
                c.logicalCold.samples === samples &&
                c.logicalCold.correctOutputs === samples &&
                c.logicalCold.queue.samples === samples &&
                c.logicalCold.queue.p95Ms <= 2000 &&
                c.logicalCold.failures.length === 0 &&
                c.logicalCold.actualColdHandles === samples,
            ) &&
            d.standardFive.passed &&
            d.doubleCold.passed &&
            d.historyGrowthFixture.passed &&
            Object.values(d.historyGrowthHttp).every(
              (g: any) =>
                g.after.samples === samples &&
                g.before.completedSamples === samples &&
                g.before.outputsEqual &&
                g.p95Ratio <= 1.3 &&
                g.failures.length === 0 &&
                g.outputsEqual,
            ) &&
            d.tenColdBurstGate.passed &&
            d.activeFreshness.propagation.passed &&
            d.activeFreshness.dataThroughLag.passed,
        ) &&
        report.collection.p95Ratio <= 1.1 &&
        report.collection.committedEvents === samples * 2 + distributions.length &&
        burstCollectionTrials.length === distributions.length &&
        report.collection.failures.length === 0;
      report.baselineDiagnostics = report.distributions.map((d: any) => ({
        distribution: d.distribution,
        ...d.baseline,
      }));
      report.baselineCompletedResponsesValid = report.distributions.every(
        (d: any) => !d.baseline || d.baseline.completedResponsesValid,
      );
      report.passed = report.candidateTargetsPassed && report.baselineCompletedResponsesValid;
      await saveReport();
      // Performance targets are reported as measured. They never suppress other distributions or falsify correctness.
      assert(
        report.distributions.length === distributions.length &&
          report.distributions.every((d: any) => d.correctness.length === 5),
      );
    } catch (error) {
      report.error = {
        code: (error as any)?.code || 'dashboard-benchmark-failed',
        message: (error as Error).message,
      };
      await saveReport();
      throw error;
    } finally {
      for (const name of created.reverse()) {
        if (!(await docker(['inspect', '--format', '{{.Id}}', name], true))) continue;
        await assertOwner(name);
        await writeFile(
          `${folder}/${name === workerName ? 'dashboard-worker' : name === appName ? 'dashboard-app' : 'dashboard-baseline'}.private.log`,
          await docker(['logs', name], true),
          { mode: 0o600 },
        );
        await docker(['rm', '--force', '--volumes', name]);
      }
      await native.end();
      await prisma.client.$disconnect();
    }
  },
  7200000,
);
