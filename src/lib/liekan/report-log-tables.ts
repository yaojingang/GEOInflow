import { isbot } from 'isbot';
import { endOfDay } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { dashboardClock } from './upstream/dashboard-clock';
import { LiekanError } from './upstream/errors';
import { crawlerAiRequests, isUnknownCrawler } from './rules/population';
import { calendarDayRange, calendarDayCount } from './contracts/calendar';
import type { parseReportQuery } from './contracts/query';
type ReportQuery = Extract<ReturnType<typeof parseReportQuery>, { success: true }>['data'];
const pct = (a: number, b: number): number | null => (b ? Math.round((a / b) * 10000) / 100 : null);
export function reportLogRange(p: ReportQuery) {
  const clock = dashboardClock();
  const now = clock?.cutoff ?? Date.now();
  let latestEnd: number;
  try {
    new Intl.DateTimeFormat('en', { timeZone: p.timezone }).format();
    latestEnd = Math.max(
      now + 86400000,
      +fromZonedTime(endOfDay(toZonedTime(now, p.timezone)), p.timezone) + 1,
    );
  } catch {
    throw new LiekanError('时区无效');
  }
  const readEndAt =
    clock || (p.crawlerMetricsVersion === 1 && p.resource.startsWith('ai/'))
      ? Math.min(p.endAt, now - (clock && p.crawlerMetricsVersion !== 1 ? 1 : 0))
      : p.endAt;
  if (readEndAt < p.startAt || p.endAt - p.startAt > 1096 * 86400000 || p.endAt > latestEnd)
    throw new LiekanError('日期范围无效，上限 3 年');
  const start = new Date(p.startAt),
    end = new Date(readEndAt);
  const halfOpen = p.crawlerMetricsVersion === 1;
  const calendarStart = calendarDayRange(+start, p.timezone).startAt === +start;
  const days = Math.max(
    1,
    calendarStart
      ? calendarDayCount(+start, Math.max(p.startAt, readEndAt - (halfOpen ? 1 : 0)), p.timezone)
      : Math.ceil((readEndAt - p.startAt + (halfOpen ? 0 : 1)) / 86400000),
  );
  return { clock, now, start, end, readEndAt, days, halfOpen };
}
export const reportLogRow = (row: any) => ({
  ...row,
  ...(row.identityEvidence != null && typeof row.identityEvidence === 'object'
    ? { identityEvidence: JSON.stringify(row.identityEvidence) }
    : {}),
  time: row.time,
  classification: isUnknownCrawler(row)
    ? isbot(row.userAgent || '')
      ? '自动化特征 · 身份未核验'
      : '未知／未分类'
    : `${row.bot} · ${row.verification === 'verified_range' ? '官方 IP 范围匹配' : row.verification === 'verified_dns' ? '官方 DNS 双向核验' : row.verification === 'verified_edge' ? '可信边缘身份核验' : row.verification === 'range_mismatch' ? '官方范围未匹配' : '身份未核验'}`,
});
export const reportBotRow = (
  b: any,
  days: number,
  preference: string | null,
  previousRequests?: number,
) => ({
  name: b.name,
  botId: b.botId ?? null,
  aiRequests: crawlerAiRequests(b),
  vendor: b.vendor,
  type: b.type,
  productForm: b.productForm ?? 'unknown',
  requests: b.requests,
  dailyAverage: Math.round((b.requests / days) * 100) / 100,
  pages: b.pages,
  preference,
  lastVisit: b.lastVisit,
  trend: previousRequests ? Math.round((b.requests / previousRequests - 1) * 10000) / 100 : null,
});

export const reportAiPageRow = (
  page: any,
  catalogRow: any,
  maximum: number,
  readEndAt: number,
) => ({
  path: page.path,
  title: catalogRow?.title?.trim() || null,
  requests: page.requests,
  bots: page.bots,
  heat: pct(page.requests, maximum),
  repeatRate: null,
  bot: page.bot,
  ...(page.botId !== undefined && { botId: page.botId }),
  bot2: page.leaders[1]?.bot ?? null,
  ...(page.leaders[1]?.botId !== undefined && { bot2Id: page.leaders[1].botId }),
  lastCrawled: page.lastCrawled,
  freshness: catalogRow?.updatedAt
    ? `${Math.max(0, Math.floor((readEndAt - new Date(catalogRow.updatedAt).getTime()) / 86400000))} 天`
    : null,
});
export function addReportAiPage(previous: any, row: any) {
  const old = previous ?? {
    path: row.path,
    requests: 0,
    bots: 0,
    bot: row.bot,
    botId: row.botId,
    lastCrawled: row.lastCrawled,
    main: 0,
    leaders: [],
  };
  old.requests += row.requests;
  old.bots++;
  old.leaders = [...old.leaders, row]
    .sort(
      (a, b) =>
        b.requests - a.requests ||
        String(a.bot).localeCompare(String(b.bot)) ||
        String(a.botId ?? '').localeCompare(String(b.botId ?? '')),
    )
    .slice(0, 2);
  old.bot = old.leaders[0].bot;
  old.botId = old.leaders[0].botId;
  old.main = old.leaders[0].requests;
  if (row.lastCrawled > old.lastCrawled) old.lastCrawled = row.lastCrawled;
  return old;
}
export const compareReportAiPages = (a: any, b: any) =>
  b.requests - a.requests || String(a.path).localeCompare(String(b.path));
