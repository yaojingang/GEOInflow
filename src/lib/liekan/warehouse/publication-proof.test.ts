// @vitest-environment node
import type { ClickHouseClient } from '@clickhouse/client';
import { expect, test, vi } from 'vitest';
import type { Attempt } from './control';
import type { ManifestEntry } from './publication';
import { persistPublicationProof } from './publication-proof';

test('proof recovery repairs only proven omissions and rejects unreadable or conflicting evidence', async () => {
  const expected = new Map([
    ['first', 'one'],
    ['second', 'two'],
  ]);
  let stored = [{ key: 'second', value: 'two' }];
  const insert = vi.fn(async ({ values }: { values: typeof stored }) => {
    stored.push(...values.map(({ key, value }) => ({ key, value })));
  });
  const query = vi.fn(async () => ({ json: async () => stored }));
  const recover = () =>
    persistPublicationProof(
      { insert, query } as unknown as ClickHouseClient,
      { website_id: 'site', epoch: '0' } as Attempt,
      { candidateId: 'candidate' } as ManifestEntry,
      expected,
      {
        kind: 'log-import-scope-v1',
        revision: '0',
        createdAt: '2026-11-21 00:00:00',
        mismatch: 'proof mismatch',
        mode: 'recover',
        verifyAfterWrite: false,
      },
    );
  query.mockRejectedValueOnce(new Error('timeout'));
  await expect(recover()).rejects.toThrow('timeout');
  expect(insert).not.toHaveBeenCalled();
  await recover();
  expect(insert.mock.calls[0][0].values).toEqual([
    expect.objectContaining({ key: 'first', value: 'one' }),
  ]);
  await recover();
  stored = [{ key: 'second', value: 'wrong' }];
  await expect(recover()).rejects.toThrow('proof mismatch');
  expect(insert).toHaveBeenCalledTimes(1);
});
