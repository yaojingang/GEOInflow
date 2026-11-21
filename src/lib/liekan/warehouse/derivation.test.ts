// @vitest-environment node
import type { ClickHouseClient } from '@clickhouse/client';
import { afterEach, expect, test, vi } from 'vitest';
import { CandidateWriter, type StoredFact } from './candidate';
import type { Attempt } from './control';
import type { ControlDatabase } from './control-db';
import { WarehouseDeriver } from './derivation';
import { deriveCandidates } from './derivation-plan';
import { LandingStore, type LandedDecision } from './landing';
import { projectLogScopeProofs } from './log-scope-proof';
import { WarehousePublisher } from './publication';
import { PublicationTrace } from './publication-timing';

vi.mock('./derivation-plan', () => ({ deriveCandidates: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(busy = false) {
  const attempt = {
    attempt_id: '11111111-1111-4111-8111-111111111111',
    website_id: '22222222-2222-4222-8222-222222222222',
    version: '3',
    epoch: '1',
    status: 'confirmed',
  } as Attempt;
  const entry = {
    attemptId: attempt.attempt_id,
    candidateId: '33333333-3333-4333-8333-333333333333',
    family: 'liekan_crawler_evidence',
    rowCount: '1',
    digest: 'a'.repeat(64),
  };
  const operations: string[] = [];
  let candidates = [entry];
  let active = false;
  let siteEpoch = attempt.epoch;
  vi.mocked(deriveCandidates).mockReturnValue({
    groups: new Map([[entry.family, [{} as StoredFact]]]),
    manifest: [entry],
  });
  vi.spyOn(LandingStore.prototype, 'projectDecision').mockResolvedValue();
  vi.spyOn(LandingStore.prototype, 'recover').mockResolvedValue([]);
  vi.spyOn(CandidateWriter.prototype, 'append').mockImplementation(async () => {
    operations.push('append');
  });
  const verify = vi.spyOn(CandidateWriter.prototype, 'verify').mockImplementation(async () => {
    operations.push('verify');
    return {
      attempts: [attempt.attempt_id],
      versions: [attempt.version],
      digest: entry.digest,
      rowCount: entry.rowCount,
    };
  });
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('SELECT candidate_id,family,row_count,digest'))
      return {
        rows: candidates.map(candidate => ({
          candidate_id: candidate.candidateId,
          family: candidate.family,
          digest: candidate.digest,
          row_count: candidate.rowCount,
        })),
      };
    if (sql.includes('SELECT epoch,publication,state'))
      return { rows: [{ epoch: siteEpoch, publication: '8', state: 'active' }] };
    if (sql.includes('SELECT attempt_id,website_id,epoch,version,status'))
      return { rows: [attempt] };
    if (sql.includes('SELECT 1 FROM liekan_warehouse_publication') && busy)
      return { rows: [{ exists: true }] };
    if (sql.includes("SET status='verified'")) operations.push('verified');
    if (sql.includes('INSERT INTO liekan_warehouse_publication')) {
      operations.push('reserved');
      return { rows: [{ operation_id: '44444444-4444-4444-8444-444444444444' }] };
    }
    return { rows: [] };
  });
  const project = vi.spyOn(WarehousePublisher.prototype, 'project').mockImplementation(async () => {
    operations.push('published');
    return undefined;
  });
  const db = {
    read: async () => [attempt],
    transaction: async (work: (tx: { query: typeof query }) => Promise<unknown>) => {
      active = true;
      try {
        return await work({ query });
      } finally {
        active = false;
      }
    },
  } as unknown as ControlDatabase;
  return {
    deriver: new WarehouseDeriver(db, {} as ClickHouseClient),
    attempt,
    operations,
    verify,
    query,
    entry,
    setCandidates: (entries: typeof candidates) => {
      candidates = entries;
    },
    project,
    setBusy: (value: boolean) => {
      busy = value;
    },
    setEpoch: (value: string) => {
      siteEpoch = value;
    },
    active: () => active,
  };
}

test('verifies persisted facts once before marking candidates and reserving publication', async () => {
  const f = fixture();
  await f.deriver.derive(f.attempt.attempt_id);
  expect(f.operations).toEqual(['append', 'verify', 'verified', 'reserved', 'published']);
  expect(LandingStore.prototype.projectDecision).toHaveBeenCalledTimes(1);
});

test('starts independent candidate writes together and drains both before propagating failure', async () => {
  const f = fixture();
  const second = {
    ...f.entry,
    family: 'liekan_log_geography',
    candidateId: '55555555-5555-4555-8555-555555555555',
  };
  f.setCandidates([f.entry, second]);
  vi.mocked(deriveCandidates).mockReturnValue({
    groups: new Map([f.entry, second].map(entry => [entry.family, [{} as StoredFact]])),
    manifest: [f.entry, second],
  });
  let finish: () => void;
  const other = new Promise<void>(resolve => {
    finish = resolve;
  });
  const append = vi.mocked(CandidateWriter.prototype.append);
  append.mockRejectedValueOnce(new Error('candidate write failed')).mockReturnValueOnce(other);
  const result = f.deriver.derive(f.attempt.attempt_id);
  let settled = false;
  void result.catch(() => {
    settled = true;
  });
  try {
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    expect(f.verify).not.toHaveBeenCalled();
  } finally {
    finish();
  }
  await expect(result).rejects.toThrow('candidate write failed');
  expect(f.project).not.toHaveBeenCalled();
});

test('stages a log scope proof once and independently rejects a missing persisted proof', async () => {
  const f = fixture();
  const entry = { ...f.entry, family: 'liekan_log' };
  const decisions = [
    {
      status: 'new',
      input: { envelope: { kind: 'log', receivedAt: '2026-11-17T10:00:00Z' } },
      facts: [{ family: 'liekan_log', row: { import_id: 'import' } }],
      effects: [{ kind: 'log-upload', batchId: 'import', scopeProof: { present: true } }],
    },
  ] as unknown as LandedDecision[];
  const insert = vi.fn(async () => ({}));
  const query = vi.fn(async () => ({ json: async () => [] }));
  const ch = { insert, query } as unknown as ClickHouseClient;
  await projectLogScopeProofs(ch, f.attempt, decisions, [entry]);
  expect(insert).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      table: 'warehouse_control_projection',
      clickhouse_settings: { async_insert: 0 },
    }),
  );
  expect(query).not.toHaveBeenCalled();
  await expect(projectLogScopeProofs(ch, f.attempt, decisions, [entry], 'verify')).rejects.toThrow(
    'warehouse-log-scope-proof-mismatch',
  );
  expect(query).toHaveBeenCalledTimes(1);
  expect(insert).toHaveBeenCalledTimes(1);
});

test('reuses the staged readback while the publisher still independently reads landing', async () => {
  const f = fixture();
  const staged = vi.fn(() => []);
  await f.deriver.derive(f.attempt.attempt_id, undefined, staged);
  expect(staged).toHaveBeenCalledExactlyOnceWith(f.attempt);
  expect(LandingStore.prototype.recover).toHaveBeenCalledExactlyOnceWith(f.attempt);
  expect(f.operations).toEqual(['append', 'verify', 'verified', 'reserved', 'published']);
});

test('checks the complete candidate manifest in one transaction before writing any facts', async () => {
  const f = fixture();
  const missing = {
    ...f.entry,
    candidateId: '44444444-4444-4444-8444-444444444444',
    family: 'liekan_log',
  };
  vi.mocked(deriveCandidates).mockImplementation(() => ({
    groups: new Map(),
    manifest: [f.entry, missing],
  }));
  await expect(f.deriver.derive(f.attempt.attempt_id)).rejects.toMatchObject({
    code: 'warehouse-derivation-conflict',
  });
  const inserts = f.query.mock.calls.filter(([sql]) =>
    sql.includes('INSERT INTO liekan_warehouse_candidate'),
  );
  expect(inserts).toHaveLength(1);
  expect(JSON.parse(inserts[0][1][0] as string).map(row => row.candidate_id)).toEqual([
    f.entry.candidateId,
    missing.candidateId,
  ]);
  expect(f.operations).toEqual([]);
});

test('rechecks the durable decision when recovering an already published attempt', async () => {
  const f = fixture();
  f.attempt.status = 'projected';
  await f.deriver.derive(f.attempt.attempt_id);
  expect(LandingStore.prototype.projectDecision).toHaveBeenCalledExactlyOnceWith(f.attempt);
  expect(f.operations).toEqual([]);
  expect(f.query).not.toHaveBeenCalled();
});

test('a busy site leaves candidates retryable and publishes no competing operation', async () => {
  vi.useFakeTimers();
  const f = fixture(true);
  const rejected = expect(f.deriver.derive(f.attempt.attempt_id)).rejects.toMatchObject({
    code: 'warehouse-publication-pending',
  });
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(f.operations).toEqual(['append', 'verify']);
  expect(f.project).not.toHaveBeenCalled();
});

test('waits outside the transaction for an earlier publication without repeating candidate writes or verification', async () => {
  vi.useFakeTimers();
  const f = fixture(true);
  const result = f.deriver.derive(f.attempt.attempt_id);
  await vi.advanceTimersByTimeAsync(200);
  expect(f.active()).toBe(false);
  expect(f.operations).toEqual(['append', 'verify']);
  f.setBusy(false);
  await vi.advanceTimersByTimeAsync(50);
  await result;
  expect(f.operations).toEqual(['append', 'verify', 'verified', 'reserved', 'published']);
  expect(f.verify).toHaveBeenCalledTimes(1);
});

test('rechecks the epoch after waiting and never publishes a stale package', async () => {
  vi.useFakeTimers();
  const f = fixture(true);
  const rejected = expect(f.deriver.derive(f.attempt.attempt_id)).rejects.toMatchObject({
    code: 'warehouse-site-changed',
  });
  await vi.advanceTimersByTimeAsync(100);
  f.setBusy(false);
  f.setEpoch('2');
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  expect(f.operations).toEqual(['append', 'verify']);
  expect(f.project).not.toHaveBeenCalled();
});

test('a failed candidate readback leaves the publication unreserved', async () => {
  const f = fixture();
  const trace = new PublicationTrace();
  f.verify.mockRejectedValueOnce(new Error('Warehouse candidate verification failed'));
  await expect(f.deriver.derive(f.attempt.attempt_id, undefined, undefined, trace)).rejects.toThrow(
    'Warehouse candidate verification failed',
  );
  expect(trace.spans.map(span => span.name)).toContain('reserve.source');
  expect(trace.spans.at(-1)).toMatchObject({
    name: 'verify.liekan_crawler_evidence',
    rows: 1,
    failed: true,
  });
  expect(trace.spans.some(span => span.name === 'reserve.transaction')).toBe(false);
  expect(f.operations).toEqual(['append']);
  expect(f.project).not.toHaveBeenCalled();
});

test('worker recovery verifies against durable input before any candidate write', async () => {
  const f = fixture();
  const timeout = Object.assign(new Error('verify timed out'), { code: '159' });
  f.verify.mockRejectedValueOnce(timeout);
  await expect(f.deriver.derive(f.attempt.attempt_id)).rejects.toBe(timeout);
  await f.deriver.derive(f.attempt.attempt_id, undefined, undefined, new PublicationTrace(), true);
  expect(f.operations).toEqual(['append', 'verify', 'verified', 'reserved', 'published']);
  expect(f.verify.mock.calls.at(-1)[6]).toEqual([{}]);
});
