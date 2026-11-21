// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { expect, test, vi } from 'vitest';
import type { ControlDatabase } from './control-db';
import { type ManifestEntry, manifestDigest, WarehousePublisher } from './publication';

function manifestFixture() {
  const attemptId = randomUUID();
  const entries: ManifestEntry[] = ['liekan_log', 'liekan_crawler_evidence'].map(family => ({
    attemptId,
    family,
    candidateId: randomUUID(),
    rowCount: '1',
    digest: 'a'.repeat(64),
  }));
  const reserved = {
    operation_id: randomUUID(),
    website_id: randomUUID(),
    epoch: '1',
    publication: '4',
    manifest: entries,
    manifest_digest: manifestDigest(entries),
    status: 'reserved',
    created_at: new Date(),
  };
  const transaction = vi.fn().mockResolvedValue({ ...reserved, status: 'published' });
  const db = { read: async () => [reserved], transaction };
  const rows = entries.map(e => ({
    attempt_id: e.attemptId,
    family: e.family,
    candidate_id: e.candidateId,
    row_count: e.rowCount,
    digest: e.digest,
  }));
  const stored: typeof rows = [];
  const query = vi.fn(async () => ({ json: async () => stored.slice() }));
  const insert = vi.fn(async ({ values }: { values: typeof rows }) => {
    stored.push(...values);
  });
  const publisher = new WarehousePublisher(
    db as unknown as ControlDatabase,
    { query, insert } as unknown as ClickHouseClient,
  );
  return {
    recover: () => publisher.project(reserved.operation_id, undefined, undefined, true),
    stored,
    rows,
    query,
    insert,
    transaction,
  };
}

test('manifest recovery fills the missing choice, then reuses the complete manifest after a lost acknowledgement', async () => {
  const f = manifestFixture();
  f.stored.push(f.rows[0]);
  f.insert.mockImplementationOnce(async ({ values }) => {
    f.stored.push(...values);
    throw Error('ack lost');
  });
  await expect(f.recover()).rejects.toThrow('ack lost');
  expect(f.transaction).not.toHaveBeenCalled();
  expect(f.insert.mock.calls[0][0].values).toEqual([expect.objectContaining(f.rows[1])]);
  await f.recover();
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(f.insert).toHaveBeenCalledTimes(1);
  expect(f.transaction).toHaveBeenCalledTimes(1);
});

test('unreadable, unexpected and conflicting manifest rows cannot authorize a write or PG commit', async () => {
  const f = manifestFixture();
  f.query.mockRejectedValueOnce(new Error('read failed'));
  await expect(f.recover()).rejects.toThrow('read failed');
  f.stored.push({ ...f.rows[0], digest: 'b'.repeat(64) });
  await expect(f.recover()).rejects.toMatchObject({
    code: 'warehouse-manifest-verification-failed',
  });
  f.stored.splice(0, 1, { ...f.rows[0], candidate_id: randomUUID() });
  await expect(f.recover()).rejects.toMatchObject({
    code: 'warehouse-manifest-verification-failed',
  });
  expect(f.insert).not.toHaveBeenCalled();
  expect(f.transaction).not.toHaveBeenCalled();
});
