// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import {
  analysisAttemptDiagnostics,
  analysisErrorReason,
  captureReportTimings,
  noteAnalysisDelivery,
  reportServerTiming,
  timeReportQuery,
  type ReportTimings,
} from './analysis-diagnostics';
import { LiekanError } from './errors';

afterEach(() => vi.restoreAllMocks());
const id = '11111111-1111-4111-8111-111111111111';

it('measures deferred dependency wall time and concurrent contexts independently', async () => {
  const first: ReportTimings = {},
    second: ReportTimings = {};
  let release: () => void;
  const deferred = new Promise<void>(resolve => {
    release = resolve;
  });
  const start = captureReportTimings(() => timeReportQuery('human', () => deferred), first);
  await captureReportTimings(() => timeReportQuery('logs', async () => 'second'), second);
  expect(first.human).toBeUndefined();
  expect(second.logs).toMatchObject({ calls: 1, failures: 0 });
  release();
  await start;
  expect(first.human).toMatchObject({ calls: 1, failures: 0 });
  expect(first.logs).toBeUndefined();
  expect(reportServerTiming(first)).toMatch(/^report-human;dur=\d+\.\d;desc="wall-clock"$/);
});

it('retains a failed query duration and preserves the thrown error', async () => {
  const timings: ReportTimings = {};
  const error = new Error('private SQL and visitor data');
  await expect(
    captureReportTimings(
      () =>
        timeReportQuery('logs', async () => {
          throw error;
        }),
      timings,
    ),
  ).rejects.toBe(error);
  expect(timings.logs).toMatchObject({ calls: 1, failures: 1 });
  expect(JSON.stringify(timings)).not.toContain('private');
});

it.each([1, 3])(
  'separates first queue wait and current retry eligibility for attempt %i',
  async attempts => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const diagnostic = analysisAttemptDiagnostics(
      {
        id,
        attempts,
        target: 'native:stats',
        queued_at: new Date(1000),
        started_at: new Date(10000),
      },
      new Date(9000),
    );
    await diagnostic.compute(() => timeReportQuery('human', async () => 'ok'));
    await diagnostic.publish(async () => 'published');
    diagnostic.sources([{ status: 'hit', expiresAt: Date.now() + 10000 }]);
    diagnostic.finish();
    expect(log).toHaveBeenCalledTimes(1);
    const record = JSON.parse(log.mock.calls[0][0]);
    expect(record).toMatchObject({
      taskId: id,
      target: 'native',
      attempt: attempts,
      outcome: 'ready',
      sourceResultState: 'hit',
      firstQueueWaitWallMs: attempts === 1 ? 9000 : null,
      retryEligibleWaitWallMs: attempts === 1 ? null : 1000,
      queryGroups: { human: { calls: 1, failures: 0 } },
    });
    expect(record.computeWallMs).toBeGreaterThanOrEqual(0);
    expect(record.publishWallMs).toBeGreaterThanOrEqual(0);
  },
);

it.each([
  [new LiekanError('private', 503, 'analysis-source-expired'), 'source-expired'],
  [new LiekanError('private', 413, 'analysis-capacity-limited'), 'capacity'],
  [Object.assign(new Error('private SQL'), { code: '57014' }), 'timeout'],
  [Object.assign(new Error('private SQL'), { code: 'P2028' }), 'timeout'],
  [{ code: 'P2010', meta: { code: '57014' } }, 'timeout'],
  [{ cause: { code: '57014' } }, 'timeout'],
  [
    { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '57014' } } } },
    'timeout',
  ],
  [{ code: 'P2010', meta: { code: '23505' } }, 'compute-failed'],
  [new LiekanError('private', 403), 'authorization'],
  [new LiekanError('private', 410), 'invalidated-or-lease-lost'],
  [new Error('private SQL'), 'compute-failed'],
])('maps errors into closed reasons without exception text', (error, reason) => {
  expect(analysisErrorReason(error)).toBe(reason);
});

it('logs wrapped PostgreSQL timeouts without their private error details', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const diagnostic = analysisAttemptDiagnostics(
    {
      id,
      attempts: 1,
      target: 'feature:page-report',
      queued_at: new Date(0),
      started_at: new Date(1),
    },
    null,
  );
  diagnostic.finish({
    code: 'P2010',
    message: 'SELECT private visitor-ip full-UA credentials',
    meta: {
      driverAdapterError: {
        cause: { originalCode: '57014', originalMessage: 'private SQL and credentials' },
      },
    },
  });
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ outcome: 'failed', reason: 'timeout' });
  expect(log.mock.calls[0][0]).not.toMatch(/SELECT|private|visitor-ip|full-UA|credentials/);
});

it('summarizes contention once when a delivery cycle acquires its permit', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const job = { id: 'delivery-acquired', data: { id }, retryCount: 0 };
  for (let retryCount = 0; retryCount < 5; retryCount++)
    noteAnalysisDelivery({ ...job, retryCount }, false, true);
  expect(log).not.toHaveBeenCalled();
  noteAnalysisDelivery({ ...job, retryCount: 5 }, true, false);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
    event: 'analysis-admission',
    taskId: id,
    contendedDeliveries: 5,
    outcome: 'acquired',
  });
});

it('emits one terminal contention summary without per-poll output', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  for (let retryCount = 0; retryCount <= 10; retryCount++)
    noteAnalysisDelivery({ id: 'delivery-exhausted', data: { id }, retryCount }, false, true);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
    contendedDeliveries: 11,
    outcome: 'exhausted',
  });
});

it('finishes a cycle immediately when the queue delivery has no retry budget', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  noteAnalysisDelivery(
    { id: 'delivery-no-retry', data: { id }, retryCount: 0, retryLimit: 0 },
    false,
    true,
  );
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
    contendedDeliveries: 1,
    outcome: 'exhausted',
  });
});
