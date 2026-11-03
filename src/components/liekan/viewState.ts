import {
  crawlerFilterLabels,
  pagableTables,
  tablePageMax,
  reportPageMax,
} from '@/lib/liekan/contracts/query';
import { columns, primaryTables } from './data';
import type { Resource } from './types';
import { calendarDayRange, shiftCalendarRange } from '@/lib/liekan/contracts/calendar';

export const viewParamKeys = [
  'botType',
  'botProductForm',
  'botCategory',
  'botId',
  'botName',
  'crawlerIdentityScope',
  'filter',
  'search',
  'page',
  'chartPeriod',
  'sort',
  'direction',
  'compareWeek',
  'live',
  'cursor',
  'seek',
] as const;
export const resetViewParams = Object.fromEntries(viewParamKeys.map(key => [key, undefined]));
const pagableSet = new Set<string>(pagableTables);
// URL 扁平参数 tp_<table>=<page> → tablePages；仅接受白名单表且页码 ≥ 2（第 1 页归一为不传参）。
export function readTablePages(params: Record<string, string>) {
  const tablePages: Record<string, number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!key.startsWith('tp_')) continue;
    const table = key.slice(3);
    const page = Number(value);
    if (pagableSet.has(table) && Number.isSafeInteger(page) && page > 1 && page <= tablePageMax)
      tablePages[table] = page;
  }
  return tablePages;
}
export const clearTablePages = (tablePages: Record<string, number>) =>
  Object.fromEntries(Object.keys(tablePages).map(table => [`tp_${table}`, undefined]));
export function readReportPage(value: unknown) {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 && page <= reportPageMax ? page : 1;
}
const filters: Partial<Record<Resource, string[]>> = {
  'human/search-engines': ['全部', '传统搜索', 'AI 搜索引荐'],
  'ai/bots': crawlerFilterLabels,
  'ai/pages': ['按抓取量', '按重复率', '按蜘蛛数'],
  content: ['按 PV', '按入口', '按时长'],
  logs: ['全部', '仅 AI 蜘蛛', '未知／未分类', '仅异常'],
};
export function readViewState(params: Record<string, string>, resource: Resource) {
  const table = primaryTables[resource];
  const filter =
    resource === 'ai/bots' && params.filter === '其他已知' ? '其他爬虫' : params.filter;
  // Keep existing overview bookmarks valid after the display terminology changed.
  const sortLabel =
    resource === 'overview' && params.sort === '人类 PV'
      ? '浏览 PV'
      : resource === 'overview' && params.sort === 'AI/人 比值'
        ? 'AI/浏览 比值'
        : params.sort;
  const cursor =
    resource === 'logs' && params.cursor?.length <= 512 && ['after', 'before'].includes(params.seek)
      ? params.cursor
      : '';
  return {
    filter: filters[resource]?.includes(filter) ? filter : '',
    search: ['logs', 'human/geo'].includes(resource) ? (params.search || '').slice(0, 200) : '',
    logPage: resource === 'logs' ? readReportPage(params.page) : 1,
    cursor,
    seek: cursor ? params.seek : '',
    chartPeriod: (['overview', 'human/overview'].includes(resource) &&
    ['today', '30d', '7d', '24h'].includes(params.chartPeriod)
      ? params.chartPeriod
      : params.date === '7day'
        ? '7d'
        : params.date === '24hour'
          ? '24h'
          : !params.date || params.date === '0day'
            ? 'today'
            : '30d') as 'today' | '30d' | '7d' | '24h',
    sort: {
      label: [
        ...(columns[table] || []),
        ...(resource === 'overview' ? columns.visitorTopBody : []),
      ].some(([, label]) => label === sortLabel)
        ? sortLabel
        : '',
      direction: params.direction === 'asc' ? 1 : -1,
    },
    compare: resource === 'human/overview' && params.compareWeek === '1',
    tablePages: resource === 'logs' ? {} : readTablePages(params),
  };
}
export function previousWeekRange(startAt: number, endAt: number, timezone = 'Asia/Shanghai') {
  return shiftCalendarRange(startAt, endAt, -7, timezone);
}
export function isLiveLogView(params: Record<string, string>, resource: Resource) {
  return resource === 'logs' && params.live === '1';
}
export function defaultDateRange(now: number, timezone = 'Asia/Shanghai') {
  return calendarDayRange(now, timezone);
}
