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
  pending: vi.fn(),
  admission: undefined as any,
}));
vi.mock('../warehouse/reader-runtime', () => ({
  warehouseReader: () => ({
    db: { read: mocks.pending },
    ch: { query: mocks.query },
    admission: mocks.admission,
    verifyIdentity: mocks.identity,
  }),
}));
vi.mock('../warehouse/reporting-context', () => ({ readReportingMetadata: mocks.metadata }));
vi.mock('../warehouse/reporting-relations', () => ({
  reportingParameters: ({ boundary }) => ({ wh_publication: boundary.publication }),
}));
vi.mock('../warehouse/read-reference', () => ({
  WarehouseReadReferences: class {
    signal = new AbortController().signal;
    pin = mocks.pin;
    close = mocks.close;
    verify = mocks.verify;
  },
}));
import {
  frozenCountKey,
  readFrozenCount,
  saveFrozenCount,
  withinWarehouseReport,
  warehouseReportQuery,
  warehouseReportMetadata,
  warehouseReportStream,
} from './warehouse-report-snapshot';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.admission = new ReadAdmission(1);
  mocks.metadata.mockResolvedValue({ boundary: { publication: '1' }, policy: '1' });
  mocks.pending.mockResolvedValue([{ pending: false }]);
  mocks.query.mockResolvedValue({ json: async () => [{ count: 1 }] });
});
afterEach(() => {
  mocks.admission.close();
  vi.useRealTimers();
});
it('applies the background budget only to explicitly marked jobs and inherits it in nested reads', async () => {
  await withinWarehouseReport(() => warehouseReportQuery('site', 'SELECT 1'));
  expect(mocks.pending).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls[0][0].clickhouse_settings.max_threads).toBeUndefined();
  expect(mocks.query.mock.calls[0][0].clickhouse_settings.workload).toBe('liekan_interactive');
  await withinWarehouseReport(() => warehouseReportQuery('site', 'SELECT 1'), { background: true });
  expect(mocks.pending).toHaveBeenCalledTimes(1);
  expect(mocks.query.mock.calls[1][0].clickhouse_settings.max_threads).toBe(1);
  expect(mocks.query.mock.calls[1][0].clickhouse_settings.workload).toBe('liekan_background');
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

it('reads the snapshot publication after newer facts have been published', async () => {
  mocks.metadata
    .mockResolvedValueOnce({ boundary: { websiteId: 'site', publication: '8' }, policy: '1' })
    .mockResolvedValueOnce({ boundary: { websiteId: 'site', publication: '9' }, policy: '1' });
  await expect(
    withinWarehouseReport(() => warehouseReportQuery('site', 'SELECT 1'), {
      publication: { websiteId: 'site', publication: '5' },
    }),
  ).resolves.toEqual([{ count: 1 }]);
  expect(mocks.pin).toHaveBeenCalledWith({ websiteId: 'site', publication: '5' });
  expect(mocks.query).toHaveBeenCalledWith(
    expect.objectContaining({ query_params: { wh_publication: '5' } }),
  );
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
  mocks.metadata.mockReturnValueOnce(
    new Promise(resolve => {
      release = resolve;
    }),
  );
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

it('keeps a saved-page boundary separate from the enclosing request publication', async () => {
  mocks.metadata.mockResolvedValue({
    boundary: { websiteId: 'site', publication: '9' },
    policy: '1',
  });
  await withinWarehouseReport(async () => {
    await warehouseReportQuery('site', 'SELECT 1');
    await withinWarehouseReport(() => warehouseReportQuery('site', 'SELECT 2'), {
      publication: { websiteId: 'site', publication: '5' },
    });
    await warehouseReportQuery('site', 'SELECT 3');
  });
  expect(mocks.query.mock.calls.map(([q]) => q.query_params.wh_publication)).toEqual([
    '9',
    '5',
    '9',
  ]);
  expect(mocks.close).toHaveBeenCalledTimes(2);
});

it.each([
  'audienceRevision',
  'crawlerRevision',
  'controlRevision',
  'repairGeneration',
  'exclusions',
  'reports',
])('rejects a changed %s while retaining append-only publication stability', async field => {
  const initial = {
    boundary: { websiteId: 'site', epoch: '1', publication: '1', deletionRevision: '0' },
    [field]: 'old',
  };
  mocks.metadata.mockResolvedValueOnce(initial).mockResolvedValueOnce({
    ...initial,
    boundary: { ...initial.boundary, publication: '2' },
    [field]: 'new',
  });
  await expect(
    withinWarehouseReport(() => warehouseReportQuery('site', 'SELECT 1')),
  ).rejects.toBeInstanceOf(Error);
  expect(mocks.close).toHaveBeenCalledTimes(1);
});

it('reuses only exact same-boundary counts and fences publication/control changes', async () => {
  const base = {
    boundary: { websiteId: 'count-site', epoch: '0', publication: '1', deletionRevision: '0' },
    policy: 'v1',
  };
  mocks.metadata.mockResolvedValue(base);
  const key = await withinWarehouseReport(() =>
    frozenCountKey('count-site', 'count-visits', { start: 1 }),
  );
  saveFrozenCount(key, 12);
  expect(readFrozenCount(key)).toBe(12);
  for (const metadata of [
    { ...base, policy: 'v2' },
    { ...base, boundary: { ...base.boundary, publication: '2' } },
    { ...base, boundary: { ...base.boundary, deletionRevision: '1' } },
  ]) {
    mocks.metadata.mockResolvedValue(metadata);
    const next = await withinWarehouseReport(() =>
      frozenCountKey('count-site', 'count-visits', { start: 1 }),
    );
    expect(next).not.toBe(key);
    expect(readFrozenCount(next)).toBeUndefined();
  }
  expect(() => saveFrozenCount(key, Infinity)).toThrow();
});
