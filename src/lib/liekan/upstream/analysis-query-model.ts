import { createHash } from 'node:crypto';
import { z } from 'zod';
import { browserPopulationSchema, type BrowserPopulation } from '../contracts/browser-population';
import { parseAnalyticsHotParameters, analyticsRefreshJobSchema } from './analytics-hot-parameters';
import { LiekanError } from './errors';
export const ANALYSIS_QUERY_QUEUE = 'liekan-analysis-query';
export const ANALYSIS_BUILD_QUEUE = 'liekan-analysis-build';
export const ANALYSIS_RESULT_FORMAT = 'liekan-analysis-result-v3';
export const liveAnalysisTargets = ['feature:page-report', 'native:stats', 'native:pageviews'];
/** Classify each unclaimed attempt from current authorized reader demand. */
export function analysisAttemptPolicy(row: {
  target: string;
  attempts: number;
  foreground?: boolean;
}) {
  const firstLive = row.attempts === 0 && liveAnalysisTargets.includes(row.target);
  const viewedPage = row.target === 'feature:page-report' && row.foreground !== false;
  return {
    lane:
      viewedPage || (firstLive && row.foreground !== false)
        ? ('dashboard' as const)
        : ('interactive' as const),
    budgetMs: (firstLive && !viewedPage) || row.target === 'native:heatmaps' ? 10000 : 60000,
  };
}
export const analysisQueryLimits = Object.freeze({
  global: 32,
  site: 8,
  actor: 2,
  bytes: 2 * 1024 * 1024,
  retention: 86400000,
});
export function stableAnalysisJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableAnalysisJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableAnalysisJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const analysisDigest = (value: unknown) =>
  createHash('sha256').update(stableAnalysisJson(value)).digest('hex');
export function analysisQueryParameters(target: string, input: Record<string, unknown>) {
  if (
    target === 'feature:shared-report' ||
    !analyticsRefreshJobSchema.shape.target.options.includes(target as any)
  )
    throw new LiekanError('不支持的统计任务', 400);
  if (
    target === 'feature:analytics' &&
    [
      'realtime',
      'session',
      'sessions',
      'session-properties',
      'events',
      'replays',
      'revenue',
    ].includes(String(input.kind))
  )
    throw new LiekanError('此数据使用独立读取协议', 400);
  let parsed: Record<string, any>;
  try {
    parsed = parseAnalyticsHotParameters(target, input);
  } catch {
    throw new LiekanError('统计参数无效', 400);
  }
  if (
    Object.keys(input).some(
      key =>
        key !== 'refresh' &&
        !(target === 'feature:page-report' && key.startsWith('tp_')) &&
        !Object.hasOwn(parsed, key),
    )
  )
    throw new LiekanError('统计条件暂不支持异步读取', 400);
  const { refresh: _refresh, ...parameters } = parsed;
  if (target === 'feature:page-report' && ['logs', 'human/keywords'].includes(parameters.resource))
    throw new LiekanError('此数据使用独立读取协议', 400);
  return parameters;
}
export const analysisResultFresh = (
  row: { status: string; expires_at: Date | string | null; retention_until: Date | string },
  now = Date.now(),
) =>
  row.status === 'ready' &&
  +new Date(row.retention_until) > now &&
  row.expires_at != null &&
  +new Date(row.expires_at) > now;

/** Validate bigint counts before global JSON serializers can coerce them. */
export function encodeAnalysisResult(value: unknown) {
  const safe = (item: any): any => {
    if (typeof item === 'bigint') {
      if (item > BigInt(Number.MAX_SAFE_INTEGER) || item < BigInt(Number.MIN_SAFE_INTEGER))
        throw new LiekanError('统计数值超出安全范围', 413, 'analysis-count-overflow');
      return Number(item);
    }
    if (Array.isArray(item)) return item.map(safe);
    if (item && typeof item === 'object' && typeof item.toJSON !== 'function')
      return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, safe(value)]));
    return item;
  };
  return JSON.stringify(safe(value));
}

const analysisResultEnvelope = z
  .object({
    format: z.literal(ANALYSIS_RESULT_FORMAT),
    value: z.unknown(),
    populations: z.array(browserPopulationSchema.extend({ resourceId: z.string() })),
  })
  .strict();

/** Private storage envelope; public responses retain their original value and JSON shape. */
export function decodeAnalysisEnvelope(input: unknown, websiteId: string) {
  const result = analysisResultEnvelope.safeParse(input);
  if (
    !result.success ||
    !Object.hasOwn(result.data, 'value') ||
    result.data.value === undefined ||
    result.data.populations.some(population => population.resourceId !== websiteId)
  )
    throw new LiekanError('统计结果已过期，请重新读取', 410, 'analysis-expired');
  return result.data;
}

export function encodeAnalysisEnvelope(
  value: unknown,
  populations: BrowserPopulation[],
  websiteId: string,
) {
  const envelope = decodeAnalysisEnvelope(
    { format: ANALYSIS_RESULT_FORMAT, value, populations },
    websiteId,
  );
  const encoded = encodeAnalysisResult(envelope);
  if (Buffer.byteLength(encoded) > analysisQueryLimits.bytes)
    throw new LiekanError(
      '结果超过保存上限，请缩小范围或使用导出',
      413,
      'analysis-result-too-large',
    );
  return encoded;
}
