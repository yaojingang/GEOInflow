import { createHash } from 'node:crypto';
import { type LogReadQuery, logReadQuery } from '../contracts/log-read';
import { CRAWLER_POPULATION_VERSION } from '../rules/population';
import { readAnalyticsVersions } from './analytics-revision';
import { LiekanError } from './errors';

export function parseLogRead(input: unknown): LogReadQuery {
  const parsed = logReadQuery.safeParse(input);
  if (!parsed.success) throw new LiekanError('统计参数无效', 400);
  const p = parsed.data;
  try {
    new Intl.DateTimeFormat('en', { timeZone: p.timezone });
  } catch {
    throw new LiekanError('时区无效', 400);
  }
  if (
    p.endAt < p.startAt ||
    p.endAt - p.startAt > 1096 * 86400000 ||
    p.endAt > Date.now() + 2 * 86400000
  )
    throw new LiekanError('日期范围无效，上限 3 年', 400);
  return p;
}

/** Bind independently delivered parts to the same input and reporting semantics. */
export async function logReadBoundary(tx: any, websiteId: string, p: LogReadQuery) {
  const versions = await readAnalyticsVersions(tx, [`website:${websiteId}`]);
  const start = new Date(p.startAt),
    end = new Date(p.endAt + (p.crawlerMetricsVersion === 1 ? 0 : 1));
  const [state] = await tx.$queryRawUnsafe(
    `SELECT s.epoch::text,s.mode,l.epoch::text AS log_epoch,
      liekan_report_range_fingerprint(s.website_id,s.epoch,'log',$2::timestamptz,$3::timestamptz) AS coarse,'' AS fine
     FROM liekan_analysis_site s LEFT JOIN liekan_log_state l USING(website_id) WHERE s.website_id=$1::uuid`,
    websiteId,
    start,
    end,
  );
  if (!state) throw new LiekanError('统计加速迁移未完成', 503);
  const identity = [
    'log-read-v2',
    websiteId,
    p.startAt,
    p.endAt,
    p.timezone,
    p.filter,
    p.search,
    p.crawlerIdentityScope,
    p.crawlerMetricsVersion ?? null,
    CRAWLER_POPULATION_VERSION,
    versions.strong,
    state.epoch,
    state.log_epoch,
    state.mode,
    state.mode === 'live' ? [state.coarse, state.fine] : versions.data,
  ];
  const boundary = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  if (p.readBoundary && p.readBoundary !== boundary)
    throw new LiekanError('日志数据已变化，请重新读取', 409, 'log-read-boundary-conflict');
  return boundary;
}
