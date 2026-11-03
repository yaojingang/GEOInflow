import {
  identityEncodingChanged,
  identityUsable,
  unavailableFields,
  type BrowserPopulation,
} from './browser-population';
import type { LiekanReport } from './report';

export const identityUnavailableReason =
  '所选范围存在身份信息缺失，访客、会话及依赖身份的指标不可用；浏览量仍可统计。';
export const qualifiedBrowserReason = '仅统计身份信息完整的浏览事件；其余采集数据见流量质量。';
export const qualifiedBrowserUnavailableReason =
  '当前范围缺少可用浏览身份。请核对可信入口 CLIENT_IP_HEADER 及代理覆盖配置；历史缺失数据见流量质量。';
export const identityEncodingChangeReason =
  '仅统计合格浏览事件；范围跨越匿名标识算法升级，UV 和会话可能重复计算同一访客。';

/** Apply after report calculations so zero-coalescing never publishes a fabricated identity metric. */
export function applyReportPopulation(
  report: LiekanReport,
  population?: BrowserPopulation,
): LiekanReport {
  if (!population) return report;
  report.meta.population = population;
  const scoped = population.metricScope === 'qualified-browser';
  const cards = new Set([
    '人类访客（UV）',
    '访客（UV）',
    '访客数 UV',
    '跳出率',
    '平均访问时长',
    '新访客占比',
    '直接访问',
    '传统搜索',
    'AI 搜索引荐',
    'AI 引荐转化率',
    '搜索总会话',
    '传统搜索会话',
    'AI 搜索引荐会话',
    'AI 搜索占比',
    '入口页 TOP1',
    '退出页 TOP1',
    '内容页平均停留',
    '全站转化率',
    'TOP1 城市',
    '海外 TOP1',
    '搜索渠道会话',
    '来源搜索词会话',
    'UTM 关键词会话',
    '关键词可用率',
    '覆盖省份',
    '海外国家/地区',
    '有流量页面',
  ]);
  if (scoped) {
    cards.add('浏览量 PV');
    cards.add('浏览量（PV）');
  }
  if (identityUsable(population)) {
    const changedEncoding = identityEncodingChanged(population);
    if (scoped && (population.identity.status === 'partial' || changedEncoding))
      report.cards = report.cards.map(card =>
        cards.has(card.key) || cards.has(card.label)
          ? {
              ...card,
              detail: changedEncoding ? identityEncodingChangeReason : qualifiedBrowserReason,
              state:
                changedEncoding &&
                [
                  '访客数 UV',
                  '访客（UV）',
                  '人类访客（UV）',
                  '跳出率',
                  '平均访问时长',
                  '新访客占比',
                ].includes(card.key)
                  ? 'estimated'
                  : card.state,
            }
          : card,
      );
  } else {
    const reason = scoped ? qualifiedBrowserUnavailableReason : identityUnavailableReason;
    if (scoped && report.states) report.states.human = 'unavailable';
    report.cards = report.cards.map(card =>
      cards.has(card.key) || cards.has(card.label)
        ? { ...card, value: null, state: 'unavailable', detail: reason }
        : card,
    );
    const tableFields: Record<string, string[]> = {
      srcBody: ['sessions', 'share', 'bounceRate', 'conversionRate', 'trend'],
      searchEngineBody: ['sessions', 'share', 'bounceRate', 'conversionRate', 'trend'],
      keywordBody: ['sessions', 'bounces', 'conversions', 'share', 'bounceRate', 'conversionRate'],
      cityBody: ['sessions', 'share', 'duration', 'bounceRate', 'conversionRate'],
      envGrid: ['share'],
      pgBody: ['uv', 'entries', 'duration', 'bounceRate', 'conversionRate'],
      visitorPgBody: ['uv', 'entries', 'duration', 'bounceRate', 'conversionRate'],
      visitorTopBody: ['uv', 'entries', 'duration', 'bounceRate', 'conversionRate'],
      goalBody: ['convertedSessions', 'conversionRate', 'rate'],
      journeyList: ['count'],
    };
    for (const [id, fields] of Object.entries(tableFields))
      if (report.tables[id])
        report.tables[id] = report.tables[id].map(row => unavailableFields(row, fields));
    delete report.meta.geographyCoverage;
    if (report.meta.geography?.cards) {
      delete report.meta.geography.cards['TOP1 城市'];
      delete report.meta.geography.cards['海外 TOP1'];
    }
  }
  const chartIds = new Set([
    'd3',
    'h2',
    'h3',
    's1',
    's2',
    'se1',
    'se2',
    'g1',
    'g2',
    'c1',
    'f1',
    'f2',
  ]);
  for (const [id, chart] of Object.entries(report.charts)) {
    const chartPopulation = ['h1', 'd1'].includes(id)
      ? report.meta.trendPopulation || population
      : population;
    if (
      id === 'd1' &&
      !identityUsable(chartPopulation) &&
      chartPopulation.metricScope === 'qualified-browser'
    ) {
      chart.series = chart.series.map(series =>
        series.name === '浏览 PV' ? { ...series, values: series.values.map(() => null) } : series,
      );
    }
    if (!identityUsable(chartPopulation) && (id === 'h1' || chartIds.has(id))) {
      chart.series = chart.series.map(series =>
        chartPopulation.metricScope !== 'qualified-browser' && id === 'h1' && series.name === 'PV'
          ? series
          : { ...series, values: series.values.map(() => null) },
      );
      chart.state = 'unavailable';
      if (chart.rows)
        chart.rows = chart.rows.map(row => unavailableFields(row, ['conversionRate']));
    }
  }
  return report;
}

export function applyFeaturePopulation(
  value: any,
  kind: string,
  population: BrowserPopulation,
): any {
  const available = identityUsable(population);
  const fields: Record<string, string[]> = {
    events: ['visitors'],
    utm: ['visitors'],
    sources: ['visitors'],
    goal: ['num', 'total'],
    realtime: ['active', 'ai', 'value'],
    'heatmap-scroll': ['total', 'reach25', 'reach50', 'reach75', 'reach100'],
    'session-properties': ['sessions'],
    attribution: ['visitors', 'attributed', 'value'],
    session: ['seconds', 'count', 'firstAt', 'lastAt', 'entryPath', 'exitPath', 'referrerDomain'],
    sessions: ['seconds', 'count'],
    replays: ['duration', 'count'],
    properties: ['sessions'],
    journey: ['visitors', 'visits', 'seconds', 'count'],
  };
  const walk = (entry: any): any => {
    if (Array.isArray(entry)) return entry.map(walk);
    if (!entry || typeof entry !== 'object') return entry;
    return Object.fromEntries(
      Object.entries(entry).map(([key, item]) => [
        key,
        !available && fields[kind]?.includes(key) ? null : walk(item),
      ]),
    );
  };
  const result = walk(value);
  if (
    !available &&
    ['session', 'sessions', 'properties', 'session-properties', 'journey', 'replays'].includes(kind)
  ) {
    result.rows = [];
    if (kind === 'session') result.more = false;
    if ('sessions' in result) result.sessions = [];
  }
  if (Array.isArray(result)) return { rows: result, population };
  return { ...result, population };
}

export function applyHumanFactsPopulation<T extends Record<string, any>>(
  facts: T,
  population?: BrowserPopulation,
): T {
  if (identityUsable(population)) return facts;
  const result: Record<string, any> = { ...facts, converted: null, newVisitors: null };
  const fields: Record<string, string[]> = {
    daily: ['uv', 'sessions', 'duration', 'bounces', 'conversions'],
    geo: ['sessions', 'duration', 'durationTotal', 'durationSamples', 'bounces', 'conversions'],
    sources: ['pv', 'sessions', 'duration', 'bounces', 'conversions', 'count'],
    sourceEvidence: ['pv', 'sessions', 'duration', 'bounces', 'conversions', 'count'],
    environment: ['sessions'],
    pages: ['uv', 'entries', 'duration', 'samples', 'bounces'],
    heatmap: ['count'],
    goals: ['convertedSessions'],
    dailySources: ['sessions', 'duration', 'bounces', 'conversions', 'count'],
  };
  for (const [key, keys] of Object.entries(fields))
    if (result[key]) result[key] = result[key].map((row: any) => unavailableFields(row, keys));
  result.journeys = [];
  result.exits = [];
  result.funnelState = 'unavailable';
  return result as T;
}
