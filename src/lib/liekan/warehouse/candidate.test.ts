// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { expect, test, vi } from 'vitest';
import { candidateDigest, CandidateWriter, storedFact } from './candidate';
import { factInput } from './fact-input';

const family = 'liekan_traffic_exclusion_member';

function candidate() {
  const site = randomUUID();
  return storedFact(
    family,
    { website_id: site, collection_id: randomUUID(), event_id: randomUUID() },
    {
      _website_id: site,
      _record_time: '2026-11-17 04:00:00.000000',
      _session_id: null,
      _epoch: '0',
      _version: '1',
      _ordinal: 0,
      _attempt_id: randomUUID(),
      _candidate_id: randomUUID(),
      _topic_id: randomUUID(),
      _partition: 0,
      _offset: '10',
      _deleted: false,
    },
  );
}

test('coalesces concurrent candidates while requiring the same durable insert acknowledgement', async () => {
  const first = candidate();
  const second = candidate();
  const insert = vi.fn(async () => {});
  const writer = new CandidateWriter({ insert } as unknown as ClickHouseClient, { coalesce: true });
  await Promise.all([writer.append(family, [first]), writer.append(family, [second])]);
  expect(insert).toHaveBeenCalledExactlyOnceWith({
    table: `warehouse_${family}`,
    values: [first, second],
    format: 'JSONEachRow',
  });
});

test('applies the ingestion flush limit only to opted-in log and geography inserts', async () => {
  const meta = candidate();
  const site = meta._website_id;
  const id = randomUUID();
  const fixtures = {
    liekan_log: factInput('liekan_log', {
      id,
      website_id: site,
      import_id: randomUUID(),
      created_at: meta._record_time,
      path: '/',
      method: 'GET',
      status: 200,
      bytes: 1,
      ip_masked: '',
      ip_hash: '',
      user_agent: '',
      location: '',
      bot: '',
      vendor: '',
      bot_type: '',
      verification: '',
    }),
    liekan_log_geography: factInput('liekan_log_geography', {
      log_id: id,
      website_id: site,
      processed_at: meta._record_time,
      source: 'unknown',
      trust: 'unknown',
      ip_family: 'unknown',
      precision: 'unknown',
      reason: '',
      rule_version: '1',
      country_basis: 'unknown',
    }),
  };
  for (const limit of [undefined, 60]) {
    const insert = vi.fn(async () => {});
    const writer = new CandidateWriter({ insert } as unknown as ClickHouseClient, {
      coalesce: true,
      ingestionLogFlushLimitMs: limit,
    });
    for (const [name, row] of Object.entries(fixtures)) {
      const fact = storedFact(name, row, meta);
      await writer.append(name, [fact]);
      expect(insert).toHaveBeenLastCalledWith({
        table: `warehouse_${name}`,
        values: [fact],
        format: 'JSONEachRow',
        ...(limit && { clickhouse_settings: { async_insert_busy_timeout_max_ms: limit } }),
      });
    }
    await writer.append(family, [meta]);
    expect(insert).toHaveBeenLastCalledWith({
      table: `warehouse_${family}`,
      values: [meta],
      format: 'JSONEachRow',
    });
  }
});

test('propagates an ambiguous insert failure to every included candidate and permits retry', async () => {
  const first = candidate();
  const second = candidate();
  const error = new Error('acknowledgement lost');
  const insert = vi.fn(async () => {}).mockRejectedValueOnce(error);
  const writer = new CandidateWriter({ insert } as unknown as ClickHouseClient, { coalesce: true });
  expect(
    await Promise.allSettled([writer.append(family, [first]), writer.append(family, [second])]),
  ).toEqual([
    { status: 'rejected', reason: error },
    { status: 'rejected', reason: error },
  ]);
  await writer.append(family, [first]);
  expect(insert).toHaveBeenLastCalledWith({
    table: `warehouse_${family}`,
    values: [first],
    format: 'JSONEachRow',
  });
});

test('verifies the sealed digest and the overflow row of each stored candidate', async () => {
  const first = candidate();
  const second = { ...first, _candidate_id: randomUUID(), _attempt_id: randomUUID() };
  let rows: (typeof first)[] = [second];
  const query = vi.fn(async () => ({ json: async () => rows }));
  const writer = new CandidateWriter({ query } as unknown as ClickHouseClient);
  const read = () =>
    writer.verify(
      family,
      first._website_id,
      first._epoch,
      second._candidate_id,
      1,
      candidateDigest(family, [second]),
    );
  expect((await read()).attempts).toEqual([second._attempt_id]);
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({
      query_params: {
        site: first._website_id,
        epoch: first._epoch,
        candidate: second._candidate_id,
        limit: 2,
      },
    }),
  );
  rows = [first];
  await expect(read()).rejects.toThrow('candidate verification failed');
  rows = [];
  await expect(read()).rejects.toThrow('candidate verification failed');
  rows = [second, first];
  await expect(read()).rejects.toThrow('candidate verification failed');
  const memoryError = Object.assign(new Error('memory limit'), { code: '241' });
  query.mockRejectedValueOnce(memoryError);
  await expect(read()).rejects.toBe(memoryError);
});

test('on recovery only writes missing ordinals after checking the complete stored subset', async () => {
  const one = candidate();
  const two = { ...one, _ordinal: 1 };
  const expected = [one, two];
  const digest = candidateDigest(family, expected);
  let persisted = [two];
  const timeout = Object.assign(new Error('readback timed out'), { code: '159' });
  const query = vi.fn(async () => ({ json: async () => persisted }));
  const insert = vi.fn(async ({ values }: { values: typeof expected }) => {
    persisted.push(...values);
  });
  const writer = new CandidateWriter({ query, insert } as unknown as ClickHouseClient);
  const recover = () =>
    writer.verify(family, one._website_id, one._epoch, one._candidate_id, 2, digest, expected);
  query.mockRejectedValueOnce(timeout);
  await expect(recover()).rejects.toBe(timeout);
  expect(insert).not.toHaveBeenCalled();
  await expect(recover()).resolves.toMatchObject({ rowCount: '2', digest });
  expect(insert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ values: [one] }));
  await recover();
  expect(insert).toHaveBeenCalledTimes(1);

  for (const bad of [
    { ...two, _attempt_id: randomUUID() },
    { ...two, _ordinal: 9 },
    { ...two, _row_hash: '0'.repeat(64) },
  ]) {
    persisted = [bad];
    await expect(recover()).rejects.toThrow();
    expect(insert).toHaveBeenCalledTimes(1);
  }
});
