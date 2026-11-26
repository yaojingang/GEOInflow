import { warehouseEnabled } from '../warehouse/authority-routing';
import { LiekanError } from './errors';
import { createHash } from 'node:crypto';
import { withWarehouseReadBoundary } from './warehouse-log-boundary';

export function sessionBoundaryScope(input: Record<string, unknown>) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'session-read-v1',
        Object.entries(input)
          .filter(([key]) => !['page', 'readBoundary', 'refresh', 'maxResults'].includes(key))
          .sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest('hex');
}
export function withSessionReadBoundary<T extends object>(
  site: string,
  input: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<T & { readBoundary?: string }> {
  if (!warehouseEnabled()) return work();
  return withWarehouseReadBoundary(
    site,
    sessionBoundaryScope(input),
    input.readBoundary as string | undefined,
    async token => ({ ...(await work()), readBoundary: token }),
  ).catch(error => {
    if (error instanceof LiekanError && error.status === 409)
      throw new LiekanError(
        '统计读取边界已失效，请重新读取第一页',
        409,
        'session-read-boundary-conflict',
      );
    throw error;
  });
}
