import { setTimeout as delay } from 'node:timers/promises';
import { WarehouseConflict } from './control-db';

export function migrationIOFailure(error: unknown): string | undefined {
  if (
    error instanceof WarehouseConflict &&
    ['warehouse-control-busy', 'warehouse-control-unavailable'].includes(error.code)
  )
    return error.code;
  const code = String((error as { code?: unknown })?.code ?? '');
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(code))
    return 'warehouse-transport-unavailable';
  // The CH HTTP client reports request_timeout as a plain Error without a code.
  // Match that exact message, never persist or log the arbitrary server message.
  if (error instanceof Error && error.message === 'Timeout error')
    return 'warehouse-transport-timeout';
  if (
    error instanceof Error &&
    [
      'Connection terminated due to connection timeout',
      'timeout exceeded when trying to connect',
    ].includes(error.message)
  )
    return 'warehouse-source-unavailable';
  if (['40001', '40P01', '55P03', '57014', '53300'].includes(code)) return 'warehouse-source-busy';
  return undefined;
}

/** Only for a read or an idempotent migration page. Ownership is checked again
 * before every attempt; digest/authority failures are never retried or hidden. */
export async function retryMigrationIO<T>(
  work: () => Promise<T>,
  fence: () => Promise<void>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    await fence();
    try {
      return await work();
    } catch (error) {
      const code = migrationIOFailure(error);
      if (!code) throw error;
      if (attempt >= 2) throw new WarehouseConflict(code);
      await delay(250 * 2 ** attempt, undefined, { signal });
    }
  }
}
