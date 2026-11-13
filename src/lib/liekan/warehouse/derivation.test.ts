// @vitest-environment node
import type { ClickHouseClient } from '@clickhouse/client';
import { afterEach, expect, test, vi } from 'vitest';
import { CandidateWriter, type StoredFact } from './candidate';
import type { Attempt } from './control';
import type { ControlDatabase } from './control-db';
import { WarehouseDeriver } from './derivation';
import { deriveCandidates } from './derivation-plan';
import { LandingStore } from './landing';
import { WarehousePublisher } from './publication';

vi.mock('./derivation-plan', () => ({ deriveCandidates: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

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
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT digest,row_count'))
      return { rows: [{ digest: entry.digest, row_count: entry.rowCount }] };
    if (sql.includes('SELECT epoch,publication,state'))
      return { rows: [{ epoch: attempt.epoch, publication: '8', state: 'active' }] };
    if (sql.includes('SELECT website_id,epoch,version,status')) return { rows: [attempt] };
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
    transaction: async (work: (tx: { query: typeof query }) => Promise<unknown>) => work({ query }),
  } as unknown as ControlDatabase;
  return {
    deriver: new WarehouseDeriver(db, {} as ClickHouseClient),
    attempt,
    operations,
    verify,
    project,
  };
}

test('verifies persisted facts once before marking candidates and reserving publication', async () => {
  const f = fixture();
  await f.deriver.derive(f.attempt.attempt_id);
  expect(f.operations).toEqual(['append', 'verify', 'verified', 'reserved', 'published']);
});

test('a busy site leaves candidates retryable and publishes no competing operation', async () => {
  const f = fixture(true);
  await expect(f.deriver.derive(f.attempt.attempt_id)).rejects.toMatchObject({
    code: 'warehouse-publication-pending',
  });
  expect(f.operations).toEqual(['append', 'verify']);
  expect(f.project).not.toHaveBeenCalled();
});

test('a failed candidate readback leaves the publication unreserved', async () => {
  const f = fixture();
  f.verify.mockRejectedValueOnce(new Error('Warehouse candidate verification failed'));
  await expect(f.deriver.derive(f.attempt.attempt_id)).rejects.toThrow(
    'Warehouse candidate verification failed',
  );
  expect(f.operations).toEqual(['append']);
  expect(f.project).not.toHaveBeenCalled();
});
