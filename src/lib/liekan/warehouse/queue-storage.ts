import { statfs } from 'node:fs/promises';

// Physical free-space reserve for the bundled single-host queue, matching the
// previous broker guard. This is shared disk headroom, never a tenant quota.
export const QUEUE_MIN_FREE_BYTES = 5n * 1024n * 1024n * 1024n;

export async function queueStorage(path?: string) {
  if (!path) return { configured: false as const };
  try {
    const space = await statfs(path, { bigint: true });
    const free = space.bavail * space.bsize;
    return {
      configured: true as const,
      available: true as const,
      freeBytes: free.toString(),
      minimumFreeBytes: QUEUE_MIN_FREE_BYTES.toString(),
      inputAllowed: free >= QUEUE_MIN_FREE_BYTES,
    };
  } catch {
    return { configured: true as const, available: false as const, inputAllowed: false };
  }
}

export async function requireQueueInputSpace(path?: string) {
  const storage = await queueStorage(path);
  if (storage.configured && !storage.inputAllowed)
    throw new Error(
      storage.available ? 'warehouse-queue-disk-pressure' : 'warehouse-queue-storage-unavailable',
    );
}
