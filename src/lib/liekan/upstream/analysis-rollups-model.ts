import { createHash } from 'node:crypto';
import { storageHistorySiteAllowedSql } from './storage-capacity';

export const ANALYSIS_ROLLUP_VERSION = 'analysis-rollups-v4';
export const ANALYSIS_CHUNK_SIZE = 2000;
export { ANALYSIS_SITE_LIMIT, ANALYSIS_GLOBAL_LIMIT } from './analysis-storage-limits';
/** Keep today's short recovery units ahead of retained history within each site. */
export const analysisBuildPrioritySql = `CASE
 WHEN b.actor_id IS NULL AND NOT b.automatic_history
  AND coalesce((b.checkpoint->>'hour')::timestamptz,b.range_start)>=clock_timestamp()-interval '26 hours' THEN 0
 WHEN b.actor_id IS NOT NULL THEN 1
 WHEN NOT b.automatic_history THEN 2 ELSE 3 END,
 CASE WHEN b.actor_id IS NULL AND NOT b.automatic_history THEN b.range_end END DESC`;
/** Recovery pumping and owned-unit release use the same runnable demand boundaries. */
export const analysisBuildWaitingSql = {
  incremental: `(SELECT min(b.updated_at) FROM liekan_analysis_build b JOIN liekan_analysis_site s ON s.website_id=b.website_id AND s.epoch=b.epoch
    WHERE s.mode='live' AND (b.actor_id IS NULL AND NOT b.automatic_history) AND b.status IN('queued','running') AND b.next_attempt_at<=clock_timestamp() AND (b.lease_until IS NULL OR b.lease_until<=clock_timestamp()))`,
  history: (
    globalAllowed: boolean,
  ) => `(SELECT min(b.created_at) FROM liekan_analysis_build b JOIN liekan_analysis_site s ON s.website_id=b.website_id AND s.epoch=b.epoch
    WHERE s.mode='live' AND (b.actor_id IS NOT NULL OR b.automatic_history) AND b.status IN('queued','running') AND b.next_attempt_at<=clock_timestamp() AND (b.lease_until IS NULL OR b.lease_until<=clock_timestamp())
    AND ${globalAllowed ? storageHistorySiteAllowedSql : 'false'}
    AND NOT EXISTS(SELECT 1 FROM liekan_history_repair_run WHERE status IN('queued','scanning','preparing','running','validating')))`,
};
export type AnalysisFamily = 'log' | 'visit';
export type AnalysisBuildStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'invalidated'
  | 'capacity_limited';
export interface AnalysisBuildDto {
  id: string;
  status: AnalysisBuildStatus;
  progress: number;
  completedUnits: string;
  totalUnits: string;
  rangeStart: string;
  rangeEnd: string;
  timezone: string;
  locale: 'zh-CN' | 'en-US';
  errorCode: string | null;
  revision: number;
  updatedAt: string;
}
export interface AnalysisStatusDto {
  websiteId: string;
  supported: boolean;
  mode: 'live' | 'disabled';
  expansion: { path: boolean; visit: boolean };
  epoch: string;
  revision: number;
  captureFrom: string;
  builds: AnalysisBuildDto[];
  coverage: {
    family: AnalysisFamily;
    rangeStart: string;
    rangeEnd: string;
    current: boolean;
    rowCount: string;
  }[];
  capacity: { siteBytes: string; globalBytes: string; siteLimit: number; globalLimit: number };
}
export interface AnalysisBuildInput {
  startDate: Date | string;
  endDate: Date | string;
  timezone: string;
  locale: 'zh-CN' | 'en-US';
  requestId: string;
  expectedRevision?: number;
}
export interface AnalysisLogInput {
  websiteId: string;
  startDate: Date;
  endDate: Date;
  /** Internal exact raw comparison for isolated validation. Production callers leave false. */
  allowRawOnly?: boolean;
  timezone?: string;
  crawlerMetricsVersion?: 1;
  crawlerIdentityScope?: 'all' | 'verified_range' | 'verified_identity';
  filters?: Record<string, unknown>;
  fields?: readonly string[];
}
export interface AnalysisVisitInput {
  websiteId: string;
  startDate: Date;
  endDate: Date;
  /** Internal exact raw comparison for isolated validation. Production callers leave false. */
  allowRawOnly?: boolean;
  filters?: Record<string, unknown>;
}
export interface AnalysisVisitPopulationInput {
  websiteId: string;
  startDate: Date;
  endDate: Date;
  timezone?: string;
  halfOpen?: boolean;
}
export interface AnalysisLogResult {
  /** Internal cursor population identity; requested explicitly by the log reader. */
  classificationSet?: string;
  summary: {
    requests: number;
    ai: number;
    pages: number;
    abnormal: number;
    classificationVersions: number;
    legacyRequests: number;
    unclassifiedRequests: number;
  };
  bots: {
    name: string;
    vendor: string;
    type: string;
    botId: string | null;
    productForm?: string;
    requests: number;
    aiRequests: number;
    pages: number;
    lastVisit: string;
  }[];
  pages: {
    path: string;
    bot: string;
    botId: string | null;
    requests: number;
    lastCrawled: string;
  }[];
  daily: {
    day: string;
    bot: string;
    vendor: string;
    botId: string | null;
    count: number;
    aiRequests: number;
  }[];
  statuses: { status: number; count: number }[];
  hours: { hour: number; count: number }[];
  coverage: { manifests: number; rawFallback: boolean };
}
export interface AnalysisVisitTotals {
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  totaltime: number;
}
export interface AnalysisTx {
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>;
  $queryRawUnsafe<T = Record<string, unknown>[]>(sql: string, ...params: unknown[]): Promise<T>;
}
export interface AnalysisCheckpoint {
  hour?: string;
  family?: AnalysisFamily;
  generation?: string;
  fingerprint?: string;
  versions?: Record<string, unknown>;
  afterTime?: string;
  afterId?: string;
  spanEnd?: string;
  rows?: string;
  chunkSize?: number;
  stage?: 'canary' | 'history';
  canaryFrom?: string;
  canaryUntil?: string;
  pathComplete?: boolean;
}
export interface AnalysisBuildRow {
  id: string;
  website_id: string;
  actor_id: string | null;
  family: 'both' | AnalysisFamily;
  unit_seconds: number;
  epoch: bigint;
  range_start: Date;
  range_end: Date;
  timezone: string;
  locale: 'zh-CN' | 'en-US';
  request_id: string;
  request_hash: string;
  revision: number;
  status: AnalysisBuildStatus;
  work_total: bigint;
  work_done: bigint;
  checkpoint: AnalysisCheckpoint;
  lease_token: string | null;
  lease_until: Date | null;
  attempts: number;
  updated_at: Date;
  error_code: string | null;
}
export const analysisHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const hourFloor = (value: Date | string) =>
  new Date(Math.floor(+new Date(value) / 3600000) * 3600000);
export const hourCeil = (value: Date | string) =>
  new Date(Math.ceil(+new Date(value) / 3600000) * 3600000);
export const analysisNextBoundary = (value: Date | string, seconds: number) =>
  new Date((Math.floor(+new Date(value) / (seconds * 1000)) + 1) * seconds * 1000);
/** Compressed empty spans prove no path facts. Nonempty paths cover one closed UTC hour. */
export const analysisPathCoverageSql = (
  alias: string,
) => `(${alias}.row_count=0 OR (${alias}.path_complete
 AND ${alias}.bucket=date_bin(interval '1 hour',${alias}.bucket,timestamptz '2000-01-01Z')
 AND ${alias}.bucket_end=${alias}.bucket+interval '1 hour'
 AND ${alias}.bucket_end<=clock_timestamp()-interval '30 seconds'))`;
/** Legacy nonaligned ranges retain their frozen logical units while UTC edge fragments publish. */
export function analysisCompletedUnits(row: AnalysisBuildRow, start: string, end: string) {
  const unit = row.unit_seconds * 1000;
  const ordinal = (at: number) =>
    at >= +row.range_end
      ? Math.ceil((+row.range_end - +row.range_start) / unit)
      : Math.floor((at - +row.range_start) / unit);
  return ordinal(+new Date(end)) - ordinal(+new Date(start));
}
/** Refuse unsafe numeric conversions so callers can use their exact raw path. */
export function analysisSafeNumber(value: string | number | bigint) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RangeError('analysis-count-overflow');
  return number;
}
export function analysisBuildDto(row: AnalysisBuildRow): AnalysisBuildDto {
  const total = Number(row.work_total),
    done = Number(row.work_done);
  return {
    id: row.id,
    status: row.status,
    progress: total ? Math.min(100, Math.floor((done / total) * 100)) : 0,
    completedUnits: String(row.work_done),
    totalUnits: String(row.work_total),
    rangeStart: new Date(row.range_start).toISOString(),
    rangeEnd: new Date(row.range_end).toISOString(),
    timezone: row.timezone,
    locale: row.locale,
    errorCode: row.error_code,
    revision: row.revision,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
