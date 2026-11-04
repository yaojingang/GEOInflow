import { afterEach, describe, expect, it, vi } from 'vitest';
import { WarehouseConflict } from './control-db';
import { migrationIOFailure, retryMigrationIO } from './migration-retry';

afterEach(() => vi.useRealTimers());
describe('migration transport recovery', () => {
  it('rechecks ownership before retrying a lost response', async () => {
    vi.useFakeTimers();
    const work = vi
      .fn()
      .mockRejectedValueOnce(new Error('Timeout error'))
      .mockResolvedValue('verified');
    const fence = vi.fn().mockResolvedValue(undefined);
    const result = retryMigrationIO(work, fence);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe('verified');
    expect(fence).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(2);
  });
  it('stops after three attempts and returns a fixed diagnostic code', async () => {
    vi.useFakeTimers();
    const work = vi.fn().mockRejectedValue(new Error('Timeout error'));
    const assertion = expect(retryMigrationIO(work, async () => {})).rejects.toMatchObject({
      code: 'warehouse-transport-timeout',
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(work).toHaveBeenCalledTimes(3);
  });
  it('never retries corruption or an authorization/lease failure', async () => {
    for (const error of [
      new Error('Warehouse candidate verification failed'),
      new WarehouseConflict('warehouse-migration-lease-lost'),
      Object.assign(new Error('memory exhausted'), { code: '241' }),
    ]) {
      const work = vi.fn().mockRejectedValue(error);
      await expect(retryMigrationIO(work, async () => {})).rejects.toBe(error);
      expect(work).toHaveBeenCalledTimes(1);
    }
  });
  it('does not retry after ownership changes during the delay', async () => {
    vi.useFakeTimers();
    const work = vi.fn().mockRejectedValue(new Error('Timeout error'));
    const fence = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new WarehouseConflict('warehouse-migration-lease-lost'));
    const assertion = expect(retryMigrationIO(work, fence)).rejects.toMatchObject({
      code: 'warehouse-migration-lease-lost',
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('cancels backoff promptly without issuing another operation', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const work = vi.fn().mockRejectedValue(new Error('Timeout error'));
    const assertion = expect(
      retryMigrationIO(work, async () => {}, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('classifies known transport and source failures without exposing messages', () => {
    expect(
      migrationIOFailure(
        Object.assign(new Error('private connection details'), { code: 'ECONNRESET' }),
      ),
    ).toBe('warehouse-transport-unavailable');
    expect(migrationIOFailure(new Error('Connection terminated due to connection timeout'))).toBe(
      'warehouse-source-unavailable',
    );
    expect(migrationIOFailure({ code: '57014' })).toBe('warehouse-source-busy');
    expect(
      migrationIOFailure(new Error('unknown query containing Timeout error and private data')),
    ).toBeUndefined();
  });
});
