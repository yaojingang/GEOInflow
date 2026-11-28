import { createHash } from 'node:crypto';
import type { Row } from '../contracts/report';
import { analyticsRedis } from './analytics-redis';
import { analyticsInfrastructureKey } from './query-cache';

export type RankingSlice = { rows: Row[]; geography: unknown[] };
export type RankingCacheScope = {
  boundary: unknown;
  control: string;
  snapshot: string;
  build: string;
  table: string;
  total: number;
};
const MAX_BYTES = 256 * 1024;
export const rankingCacheEnabled = () => analyticsRedis.enabled;
export function rankingCacheKey(scope: RankingCacheScope, page: number, size: number) {
  return `liekan:ranking:v1:${analyticsInfrastructureKey('ranking-v1', [
    process.env.DATABASE_URL,
    process.env.LIEKAN_CLICKHOUSE_DATABASE,
    scope,
    page,
    size,
  ])}`;
}
function cacheable(page: number, size: number) {
  return (
    Number.isSafeInteger(page) &&
    page >= 1 &&
    page <= 3 &&
    Number.isSafeInteger(size) &&
    size >= 1 &&
    size <= 100
  );
}
export async function readRankingCache(scope: RankingCacheScope, page: number, size: number) {
  if (!cacheable(page, size)) return;
  const key = rankingCacheKey(scope, page, size);
  const raw = await analyticsRedis.command<string>(['GET', key]);
  if (!raw || Buffer.byteLength(raw) > MAX_BYTES) return;
  try {
    const entry = JSON.parse(raw);
    if (
      entry.key !== key ||
      typeof entry.payload !== 'string' ||
      entry.checksum !== createHash('sha256').update(entry.payload).digest('hex')
    )
      return;
    const value = JSON.parse(entry.payload);
    const length = Math.max(0, Math.min(size, scope.total - (page - 1) * size));
    if (
      !Array.isArray(value.rows) ||
      value.rows.length !== length ||
      !Array.isArray(value.geography) ||
      value.geography.length !== length
    )
      return;
    return value as RankingSlice;
  } catch {
    return;
  }
}
export async function saveRankingCache(
  scope: RankingCacheScope,
  page: number,
  size: number,
  value: RankingSlice,
) {
  if (!cacheable(page, size)) return;
  const key = rankingCacheKey(scope, page, size),
    payload = JSON.stringify(value);
  const entry = JSON.stringify({
    key,
    payload,
    checksum: createHash('sha256').update(payload).digest('hex'),
  });
  if (Buffer.byteLength(entry) > MAX_BYTES) return;
  // Only verified immutable artifact slices enter this disposable cache. A late
  // old build has a different key; expiry/eviction only causes a CH fallback.
  await analyticsRedis.command(['SET', key, entry, 'EX', '3600']);
}
