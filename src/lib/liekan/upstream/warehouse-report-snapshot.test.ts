// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReadAdmission } from '../warehouse/read-admission';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  metadata: vi.fn(),
  pin: vi.fn(),
  close: vi.fn(),
  verify: vi.fn(),
  identity: vi.fn(),
  admission: undefined as any,
}));
vi.mock('../warehouse/reader-runtime', () => ({
  warehouseReader: () => ({
    db: {},
    ch: { query: mocks.query },
    admission: mocks.admission,
    verifyIdentity: mocks.identity,
  }),
}));
vi.mock('../warehouse/reporting-context', () => ({ readReportingMetadata: mocks.metadata }));
vi.mock('../warehouse/reporting-relations', () => ({ reportingParameters: () => ({}) }));
vi.mock('../warehouse/read-reference', () => ({
  WarehouseReadReferences: class {
    signal = new AbortController().signal;
    pin = mocks.pin;
    close = mocks.close;
    verify = mocks.verify;
  },
}));
import {
  withinWarehouseReport,
  warehouseReportQuery,
  warehouseReportMetadata,
  warehouseReportStream,
} from './warehouse-report-snapshot';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.admission = new ReadAdmission(1);
  mocks.metadata.mockResolvedValue({ boundary: { publication: '1' }, policy: '1' });
  mocks.query.mockResolvedValue({ json: async () => [{ count: 1 }] });
});
afterEach(() => {
  mocks.admission.close();
  vi.useRealTimers();
});
it('propagates the report deadline to CH and retains the permit until cancellation settles', async () => {
  vi.useFakeTimers();
  let observed!: AbortSignal, finish!: () => void;
  mocks.query.mockImplementation(({ abort_signal }) => {
    observed = abort_signal;
    return new Promise((_, reject) => {
      finish = () => reject(abort_signal.reason);
    });
  });
  const report = withinWarehouseReport(() => warehouseReportQuery('site', 'SELECT 1'), {
    deadline: Date.now() + 100,
  });
  const rejected = expect(report).rejects.toMatchObject({ code: 'analysis-query-timeout' });
  await vi.advanceTimersByTimeAsync(110);
  expect(observed.aborted).toBe(true);
  expect(mocks.close).not.toHaveBeenCalled();
  const next = vi.fn(async () => 2),
    queued = mocks.admission.run(next);
  expect(next).not.toHaveBeenCalled();
  finish();
  await rejected;
  expect(await queued).toBe(2);
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
it('does not dispatch a queued query after client cancellation', async () => {
  let release!: () => void;
  const blocker = mocks.admission.run(
    () =>
      new Promise<void>(r => {
        release = r;
      }),
  );
  const abort = new AbortController();
  const report = withinWarehouseReport(() => warehouseReportQuery('site', 'SELECT 1'), {
    signal: abort.signal,
  });
  const rejected = expect(report).rejects.toThrow('client canceled');
  await new Promise(r => setTimeout(r, 5));
  abort.abort(new Error('client canceled'));
  await rejected;
  release();
  await blocker;
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
it('still rejects a changed policy at the report publication fence', async () => {
  mocks.metadata
    .mockResolvedValueOnce({ boundary: { publication: '1' }, policy: '1' })
    .mockResolvedValueOnce({ boundary: { publication: '2' }, policy: '2' });
  await expect(
    withinWarehouseReport(() => warehouseReportQuery('site', 'SELECT 1')),
  ).rejects.toBeInstanceOf(Error);
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(mocks.close).toHaveBeenCalledTimes(1);
});

it('closes the stream on cancellation and does not consume another batch', async () => {
  const abort = new AbortController(),
    closed = vi.fn(),
    consume = vi.fn(async () => {
      abort.abort(new Error('stream canceled'));
    });
  mocks.query.mockResolvedValue({
    stream: async function* () {
      yield [{ json: () => ({ value: 1 }) }];
      yield [{ json: () => ({ value: 2 }) }];
    },
    close: closed,
  });
  await expect(
    withinWarehouseReport(() => warehouseReportStream('site', 'SELECT 1', {}, consume), {
      signal: abort.signal,
    }),
  ).rejects.toThrow('stream canceled');
  expect(consume).toHaveBeenCalledTimes(1);
  expect(closed).toHaveBeenCalledTimes(1);
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.query.mock.calls[0][0].clickhouse_settings).toMatchObject({
    readonly: '2',
    cancel_http_readonly_queries_on_client_close: 1,
  });
});
it('uses the remaining whole-report budget after waiting and cannot extend it in a nested report', async () => {
  vi.useFakeTimers();
  const start = Date.now();
  await withinWarehouseReport(
    async () => {
      await vi.advanceTimersByTimeAsync(1200);
      await withinWarehouseReport(() => warehouseReportQuery('site', 'SELECT 1'), {
        deadline: start + 10000,
      });
    },
    { deadline: start + 3000 },
  );
  expect(mocks.query.mock.calls[0][0].clickhouse_settings.max_execution_time).toBe(2);
  expect(mocks.close).toHaveBeenCalledTimes(1);
});

it('lets parallel reads within one report wait past the default admission queue timeout', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  mocks.admission = new ReadAdmission(1, 16, 5000);
  mocks.query.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = () => resolve({ json: async () => [{ count: 1 }] });
      }),
  );
  const report = withinWarehouseReport(
    () =>
      Promise.all([
        warehouseReportQuery('site', 'SELECT 1'),
        warehouseReportQuery('site', 'SELECT 2'),
      ]),
    { deadline: Date.now() + 10000 },
  );
  // Attach now so a broken implementation is reported as an assertion failure.
  const result = report.then(
    value => ({ value }),
    error => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(6000);
  finish();
  expect(await result).toEqual({ value: [[{ count: 1 }], [{ count: 1 }]] });
  expect(mocks.query).toHaveBeenCalledTimes(2);
});
it('cancels and drains sibling queries before releasing a failed report reference', async () => {
  vi.useFakeTimers();
  mocks.admission = new ReadAdmission(2);
  let abort!: AbortSignal, settle!: () => void, failed!: () => void;
  mocks.query.mockImplementationOnce(
    ({ abort_signal }) =>
      new Promise((_, reject) => {
        abort = abort_signal;
        settle = () => reject(abort_signal.reason);
      }),
  );
  const report = withinWarehouseReport(() =>
    Promise.all([
      warehouseReportQuery('site', 'SELECT 1'),
      new Promise((_, reject) => {
        failed = () => reject(new Error('sibling failed'));
      }),
    ]),
  );
  const rejected = expect(report).rejects.toThrow('sibling failed');
  await vi.advanceTimersByTimeAsync(0);
  failed();
  await vi.advanceTimersByTimeAsync(0);
  expect(abort.aborted).toBe(true);
  expect(mocks.close).not.toHaveBeenCalled();
  settle();
  await rejected;
  expect(mocks.close).toHaveBeenCalledTimes(1);
});

it('drains pending metadata before closing references when another report branch fails', async () => {
  let release!: (value: unknown) => void;
  mocks.metadata.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const report = withinWarehouseReport(async () => {
    void warehouseReportMetadata('site').catch(() => {});
    throw new Error('another branch failed');
  });
  const failure = expect(report).rejects.toThrow('another branch failed');
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(mocks.close).not.toHaveBeenCalled();
  release({ boundary: { publication: '1' }, policy: '1' });
  await failure;
  expect(mocks.pin).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
