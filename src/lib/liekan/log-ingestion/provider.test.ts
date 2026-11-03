import { beforeEach, expect, it, vi } from 'vitest';
import { LiekanError } from '../upstream/errors';
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  maintain: vi.fn(),
}));
vi.mock('../upstream/server', async () => ({
  ...(await vi.importActual('../upstream/errors')),
  transaction: mocks.transaction,
}));
vi.mock('./cloudflare', () => ({ maintainCloudflare: mocks.maintain }));
import { maintainProvider } from './provider';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([{ id: 'source' }]);
  mocks.execute.mockResolvedValue(1);
  mocks.transaction.mockImplementation(fn =>
    fn({ $queryRawUnsafe: mocks.query, $executeRawUnsafe: mocks.execute }),
  );
});
it.each(['provider-not-entitled', 'provider-permission-denied'])(
  'pauses %s without revoking the existing receiver credential',
  async code => {
    mocks.maintain.mockRejectedValue(new LiekanError('Provider unavailable', 403, code));
    await maintainProvider('source', 'configure', 'worker');
    expect(mocks.execute.mock.calls).toContainEqual([
      'UPDATE liekan_log_source SET error_code=$2 WHERE id=$1::uuid',
      'source',
      code,
    ]);
    const sql = mocks.execute.mock.calls.map(call => call[0]).join('\n');
    expect(sql).toContain("state='paused'");
    expect(sql).toContain('ends_at=clock_timestamp()');
    expect(sql).toContain('policy_revision=policy_revision+1');
    expect(sql).not.toContain('credential_hash=NULL');
    expect(sql).toContain('provider_lease=NULL');
  },
);
it('continues revoking credentials for real authorization failures', async () => {
  mocks.maintain.mockRejectedValue(new LiekanError('Expired', 401));
  await maintainProvider('source', 'configure', 'worker');
  expect(mocks.execute.mock.calls.some(call => call[0].includes('credential_hash=NULL'))).toBe(
    true,
  );
});
it('keeps transient failures retryable and always releases its lease', async () => {
  mocks.maintain.mockRejectedValue(new LiekanError('Network unavailable', 503));
  await expect(maintainProvider('source', 'configure', 'worker')).rejects.toThrow(
    'Provider temporarily unavailable',
  );
  expect(mocks.execute.mock.calls.some(call => call[0].includes('provider_lease=NULL'))).toBe(true);
  expect(mocks.execute.mock.calls.some(call => call[0].includes('credential_hash=NULL'))).toBe(
    false,
  );
});
