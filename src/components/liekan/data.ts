import { isUnknownCrawler } from '@/lib/liekan/rules/population';
import { isOtherCrawler } from '@/lib/liekan/contracts/query';
import type { LiekanLocale } from '@/lib/liekan/i18n/locale';
import type { DataState, Resource, Row } from './types';
export const pages: Array<{
  path: string;
  resource: Resource;
  title: string;
  actions: string[];
  group: string;
  icon: number;
}> = [
  {
    path: '',
    resource: 'overview',
    title: '流量总览',
    actions: ['站点设置', '导出日报'],
    group: '总览',
    icon: 1,
  },
  {
    path: '/ai',
    resource: 'ai/overview',
    title: 'AI 访问总览',
    actions: ['蜘蛛白名单'],
    group: 'AI 蜘蛛',
    icon: 2,
  },
  {
    path: '/ai/bots',
    resource: 'ai/bots',
    title: '蜘蛛明细',
    actions: ['特征库管理', '导出清单'],
    group: 'AI 蜘蛛',
    icon: 3,
  },
  {
    path: '/ai/pages',
    resource: 'ai/pages',
    title: 'AI 抓取页面',
    actions: ['sitemap 管理', '导出抓取清单'],
    group: 'AI 蜘蛛',
    icon: 4,
  },
  {
    path: '/ai/preference',
    resource: 'ai/preference',
    title: 'AI 访问偏好',
    actions: ['生成内容建议'],
    group: 'AI 蜘蛛',
    icon: 5,
  },
  {
    path: '/human',
    resource: 'human/overview',
    title: '访客总览',
    actions: ['对比上周', '导出报表'],
    group: '人类访问',
    icon: 6,
  },
  {
    path: '/human/geo',
    resource: 'human/geo',
    title: '地域分布',
    actions: ['导出地域报表'],
    group: '人类访问',
    icon: 7,
  },
  {
    path: '/human/sources',
    resource: 'human/sources',
    title: '来源渠道',
    actions: ['UTM 管理', '导出渠道表'],
    group: '人类访问',
    icon: 8,
  },
  {
    path: '/human/search-engines',
    resource: 'human/search-engines',
    title: '搜索引擎',
    actions: [],
    group: '人类访问',
    icon: 8,
  },
  {
    path: '/human/keywords',
    resource: 'human/keywords',
    title: '来源关键词',
    actions: [],
    group: '人类访问',
    icon: 8,
  },
  {
    path: '/content',
    resource: 'content',
    title: '页面与内容',
    actions: ['导出页面表'],
    group: '内容与转化',
    icon: 9,
  },
  {
    path: '/conversions',
    resource: 'conversions',
    title: '转化分析',
    actions: ['目标配置', '导出转化表'],
    group: '内容与转化',
    icon: 10,
  },
  {
    path: '/logs',
    resource: 'logs',
    title: '实时访问流',
    actions: ['日志查询', '解析规则'],
    group: '日志',
    icon: 11,
  },
];
export function isWebsiteLanding(pathname: string) {
  return /^(?:\/teams\/[a-f0-9-]{36})?\/websites\/(?:[a-f0-9-]{36}|\d{1,9})$/.test(pathname);
}
export function isLiekanRoute(pathname: string) {
  return /\/websites\/[^/]+\/geo(?:\/|$)/.test(pathname);
}
export const stateLabels: Record<DataState, string> = {
  available: '',
  empty: '当前范围暂无数据',
  not_connected: '待接入',
  unavailable: '身份指标不可用',
  unsupported: '当前数据源未提供',
  estimated: '估算',
};
export const columns: Record<string, Array<[string, string, boolean?]>> = {
  visitorTopBody: [
    ['path', '页面'],
    ['pv', '浏览量 PV', true],
    ['uv', '访客数 UV', true],
  ],
  topBody: [
    ['path', '页面'],
    ['humanPv', '浏览 PV', true],
    ['aiRequests', 'AI 抓取', true],
    ['ratio', 'AI/浏览 比值', true],
    ['bot', '最活跃蜘蛛'],
    ['evaluation', 'GEO 评价'],
  ],
  botBody: [
    ['name', '蜘蛛 / 厂商'],
    ['type', '类型'],
    ['requests', '所选期间抓取', true],
    ['dailyAverage', '日均', true],
    ['pages', '覆盖页面', true],
    ['preference', '最爱内容'],
    ['lastVisit', '最后访问'],
    ['trend', '趋势', true],
  ],
  apBody: [
    ['path', '页面'],
    ['title', '标题'],
    ['requests', '抓取次数', true],
    ['bots', '蜘蛛种类', true],
    ['heat', '抓取热度'],
    ['bot', '主力蜘蛛'],
    ['lastCrawled', '最近抓取'],
    ['freshness', '内容新鲜度', true],
  ],
  cityBody: [
    ['city', '城市'],
    ['sessions', '会话', true],
    ['share', '占比', true],
    ['duration', '平均时长', true],
    ['bounceRate', '跳出率', true],
    ['conversionRate', '转化率', true],
  ],
  searchEngineBody: [
    ['engine', '搜索引擎 / 平台'],
    ['type', '搜索类型'],
    ['sessions', '会话数', true],
    ['pv', '浏览量 PV', true],
    ['share', '搜索总占比', true],
    ['categoryShare', '同类占比', true],
    ['bounceRate', '跳出率', true],
    ['conversionRate', '转化率', true],
  ],
  srcBody: [
    ['source', '来源'],
    ['channel', '渠道归类'],
    ['sessions', '会话', true],
    ['share', '占比', true],
    ['bounceRate', '跳出率', true],
    ['conversionRate', '转化率', true],
    ['trend', '环比', true],
  ],
  visitorPgBody: [
    ['path', '页面'],
    ['pv', 'PV', true],
    ['uv', 'UV', true],
    ['entries', '入口数', true],
    ['duration', '平均停留', true],
    ['bounceRate', '跳出率', true],
  ],
  pgBody: [
    ['path', '页面'],
    ['pv', 'PV', true],
    ['uv', 'UV', true],
    ['entries', '入口数', true],
    ['duration', '平均停留', true],
    ['bounceRate', '跳出率', true],
    ['aiRequests', 'AI 抓取', true],
  ],
  goalBody: [
    ['name', '转化目标'],
    ['count', '次数', true],
    ['rate', '转化率', true],
    ['trend', '环比', true],
    ['path', '主承接页'],
  ],
  logBody: [
    ['time', '时间'],
    ['ipMasked', 'IP / 归属'],
    ['path', '请求'],
    ['status', '状态'],
    ['userAgent', 'User-Agent（截断）'],
    ['classification', '判定', true],
  ],
};
export const primaryTables: Partial<Record<Resource, string>> = {
  overview: 'topBody',
  'ai/bots': 'botBody',
  'ai/pages': 'apBody',
  'human/geo': 'cityBody',
  'human/sources': 'srcBody',
  'human/search-engines': 'searchEngineBody',
  content: 'pgBody',
  conversions: 'goalBody',
  logs: 'logBody',
};
export const cardLabels: Partial<Record<Resource, string[]>> = {
  'human/overview': ['访客数 UV', '浏览量 PV', '跳出率', '平均访问时长', '新访客占比'],
};
export const tableLimits: Record<string, number> = {
  topBody: 7,
  visitorTopBody: 7,
  apBody: 10,
  cityBody: 12,
  srcBody: 10,
  pgBody: 10,
  visitorPgBody: 10,
  goalBody: 5,
  logBody: 12,
  prefList: 6,
  robotsList: 6,
  pathList: 7,
  blindList: 5,
  pipeList: 5,
  journeyList: 6,
};
export function formatValue(value: unknown, locale: LiekanLocale = 'zh-CN') {
  return value == null || value === ''
    ? '–'
    : typeof value === 'number'
      ? value.toLocaleString(locale, { maximumFractionDigits: 2 })
      : String(value);
}
export function formatPercentage(value: unknown, locale: LiekanLocale = 'zh-CN') {
  return value == null
    ? '–'
    : typeof value === 'number'
      ? `${formatValue(value, locale)}%`
      : String(value);
}
function formatDuration(value: number, locale: LiekanLocale = 'zh-CN') {
  const seconds = Math.round(value);
  return locale === 'en-US'
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}
export function formatMetricValue(
  card: { value: unknown; unit?: string; label: string },
  locale: LiekanLocale = 'zh-CN',
  display: (source: string) => string = source => source,
) {
  if (typeof card.value === 'number' && card.unit === '秒' && /时长|停留/.test(card.label))
    return formatDuration(card.value, locale);
  let unit = card.unit ? display(card.unit) : '';
  if (locale === 'en-US' && card.value === 1) {
    const singular: Record<string, string> = {
      times: 'time',
      items: 'item',
      pages: 'page',
      visitors: 'visitor',
      types: 'type',
      seconds: 'second',
      days: 'day',
    };
    unit = singular[unit.toLowerCase()] || unit;
  }
  return `${formatValue(card.value, locale)}${card.value == null ? '' : unit ? (locale === 'en-US' && unit !== '%' ? ' ' : '') + unit : ''}`;
}
export function crawlerIdentityLabel(
  row: Row,
  display: (source: string) => string = source => source,
) {
  if (typeof row.botId === 'string' && row.botId) return display('官方身份');
  if (row.botId === null) return display('自定义／历史未映射');
  return '';
}
export function formatCellValue(
  row: Row,
  field: string,
  table: string,
  locale: LiekanLocale = 'zh-CN',
  display: (source: string) => string = source => source,
) {
  const value = row[field];
  if (table === 'apBody' && field === 'title' && (value == null || value === ''))
    return display('未提供');
  if (value == null || value === '') return '–';
  if (field === 'source' && row.sourceLabel === 'direct') return display('直接访问');
  if (table === 'botBody' && field === 'name') {
    const identity = crawlerIdentityLabel(row, display);
    return `${formatValue(value, locale)}${row.vendor ? ` / ${row.vendor}` : ''}${identity ? ` / ${identity}` : ''}`;
  }
  if (field === 'bot' && table === 'apBody') {
    return [
      { bot: row.bot, botId: row.botId },
      { bot: row.bot2, botId: row.bot2Id },
    ]
      .filter(bot => bot.bot)
      .map(bot => {
        const identity = crawlerIdentityLabel(bot, display);
        return `${formatValue(bot.bot, locale)}${identity ? ` / ${identity}` : ''}`;
      })
      .join('\n');
  }
  if (field === 'bot' && table === 'topBody') {
    const identity = crawlerIdentityLabel(row, display);
    return `${formatValue(value, locale)}${identity ? ` / ${identity}` : ''}`;
  }
  if (table === 'logBody' && field === 'ipMasked')
    return `${formatValue(value, locale)}${row.location ? ` / ${row.location}` : ''}`;
  if (table === 'logBody' && field === 'path')
    return `${row.method || '–'} ${formatValue(value, locale)}`;
  if (['channel', 'evaluation', 'classification', 'freshness'].includes(field))
    return display(String(value));
  if (field === 'type') {
    const type = display(
      value === '训练' ? 'AI 训练' : value === '搜索' ? 'AI 搜索' : formatValue(value, locale),
    );
    const forms =
      table === 'botBody'
        ? String(row.productForm ?? '')
            .split(',')
            .filter(form => ['workbench', 'personal_agent'].includes(form))
            .map(form => display(form === 'workbench' ? 'AI 工作台' : '个人 Agent'))
        : [];
    return [type, ...forms].join(' · ');
  }
  if (['share', 'categoryShare', 'bounceRate', 'conversionRate', 'rate'].includes(field))
    return formatPercentage(value, locale);
  if (field === 'trend' && typeof value === 'number')
    return `${value > 0 ? '+' : ''}${formatValue(value, locale)}%`;
  if (field === 'duration' && typeof value === 'number') return formatDuration(value, locale);
  if (
    ['time', 'lastVisit', 'lastCrawled'].includes(field) &&
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/.test(value)
  )
    return new Intl.DateTimeFormat(locale, {
      ...(field === 'time' ? {} : { month: '2-digit', day: '2-digit' }),
      hour: '2-digit',
      minute: '2-digit',
      second: field === 'time' ? '2-digit' : undefined,
      hour12: false,
      timeZone: 'Asia/Shanghai',
    }).format(new Date(value));
  return formatValue(value, locale);
}
export function selectRows(
  rows: Row[],
  filter: string,
  sort: { label: string; direction: number },
  table: string,
  query = '',
  displayPath?: (value: unknown) => string | null,
) {
  const filtered = rows.filter(row => {
    const category = String(row.type ?? row.classification ?? '');
    const matches =
      filter === '全部' ||
      !filter ||
      filter.startsWith('按') ||
      (filter === 'AI 训练' && category === '训练') ||
      (filter === 'AI 搜索' && category === '搜索') ||
      (['其他爬虫', '其他已知'].includes(filter) && isOtherCrawler(row)) ||
      (filter === 'AI 工作台' &&
        String(row.productForm ?? '')
          .split(',')
          .includes('workbench')) ||
      (filter === '个人 Agent' &&
        String(row.productForm ?? '')
          .split(',')
          .includes('personal_agent')) ||
      (filter === '仅 AI 蜘蛛' &&
        table === 'logBody' &&
        (typeof row.aiEligible === 'boolean'
          ? row.aiEligible
          : ['训练', '搜索', '用户触发'].includes(String(row.botType ?? '')))) ||
      (filter === '未知／未分类' &&
        isUnknownCrawler({
          bot: row.bot as string | undefined,
          recognitionState: row.recognitionState as string | null | undefined,
        })) ||
      (filter === '仅异常' &&
        (/risk|异常|风险|unknown/i.test(category) || Number(row.status) >= 400)) ||
      category.replace(/\s/g, '').includes(filter.replace(/\s/g, ''));
    return (
      matches &&
      (!query ||
        [...Object.values(row), displayPath?.(row.path)].some(value =>
          String(value ?? '')
            .toLowerCase()
            .includes(query.toLowerCase()),
        ))
    );
  });
  const byFilter: Record<string, string> = {
    按抓取量: 'requests',
    按重复率: 'repeatRate',
    按蜘蛛数: 'bots',
    '按 PV': 'pv',
    按入口: 'entries',
    按时长: 'duration',
  };
  const key = byFilter[filter] || columns[table]?.find(([, label]) => label === sort.label)?.[0];
  if (!key) return filtered;
  return [...filtered].sort((a, b) => {
    const av = a[key],
      bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (
      (typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), 'zh-CN', { numeric: true })) *
      (byFilter[filter] ? -1 : sort.direction)
    );
  });
}
export function csvMatrix(headers: string[], rows: string[][]) {
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return (
    '\uFEFF' +
    [headers.map(cell).join(','), ...rows.map(row => row.map(cell).join(','))].join('\r\n')
  );
}
export function csvText(rows: Row[]) {
  const keys = Array.from(new Set(rows.flatMap(row => Object.keys(row))));
  return csvMatrix(
    keys,
    rows.map(row => keys.map(key => String(row[key] ?? ''))),
  );
}
export function tableCsv(
  table: string,
  rows: Row[],
  filter: string,
  sort: { label: string; direction: number },
  search = '',
  displayPath?: (value: unknown) => string | null,
  locale: LiekanLocale = 'zh-CN',
  display: (source: string) => string = source => source,
) {
  const fields = columns[table] || [];
  const selected = selectRows(rows, filter, sort, table, search, displayPath);
  return csvMatrix(
    fields.map(([, label]) => display(label)),
    selected.map(row =>
      fields.map(([field]) => formatCellValue(row, field, table, locale, display)),
    ),
  );
}
export function reportCsvFilename(
  resource: Resource,
  range: { startAt: number; endAt: number; timezone: string },
) {
  const stamp = (value: number) => new Date(value).toISOString().replaceAll(':', '-');
  const zone = range.timezone.replace(/[:/]/g, '-');
  return `liekan-${resource.replaceAll('/', '-')}-${stamp(range.startAt)}--${stamp(range.endAt)}-${zone}.csv`;
}
export function downloadFile(content: string, name: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
