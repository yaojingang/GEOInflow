import { beforeEach, expect, it, vi } from 'vitest';
import { statfs } from 'node:fs/promises';
import { QUEUE_MIN_FREE_BYTES, queueStorage, requireQueueInputSpace } from './queue-storage';

vi.mock('node:fs/promises', () => {
  const statfs = vi.fn();
  return { statfs, default: { statfs } };
});
beforeEach(() => vi.resetAllMocks());

it('checks available filesystem bytes and resumes intake after space recovers', async () => {
  vi.mocked(statfs).mockResolvedValue({
    bsize: 4096n,
    bavail: QUEUE_MIN_FREE_BYTES / 4096n - 1n,
  } as any);
  await expect(requireQueueInputSpace('/queue')).rejects.toThrow('warehouse-queue-disk-pressure');
  expect(await queueStorage('/queue')).toMatchObject({ configured: true, inputAllowed: false });
  vi.mocked(statfs).mockResolvedValue({
    bsize: 4096n,
    bavail: QUEUE_MIN_FREE_BYTES / 4096n,
  } as any);
  await expect(requireQueueInputSpace('/queue')).resolves.toBeUndefined();
});

it('fails closed for an unavailable configured mount without exposing paths', async () => {
  vi.mocked(statfs).mockRejectedValue(new Error('private mount details'));
  await expect(requireQueueInputSpace('/private')).rejects.toThrow(
    'warehouse-queue-storage-unavailable',
  );
  expect(await queueStorage('/private')).toEqual({
    configured: true,
    available: false,
    inputAllowed: false,
  });
});

it('leaves external brokers to their own storage monitoring', async () => {
  await expect(requireQueueInputSpace()).resolves.toBeUndefined();
  expect(await queueStorage()).toEqual({ configured: false });
  expect(statfs).not.toHaveBeenCalled();
});
