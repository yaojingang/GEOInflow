import { z } from 'zod';
import { reportQuery } from './query';
import { liekanReportSchema, type LiekanReport } from './report';

export type ReportResource = z.infer<typeof reportQuery>['resource'];
export const visitorOverviewCards = ['访客数 UV', '浏览量 PV', '跳出率', '平均访问时长'] as const;
export const pageReportParts = {
  overview: {
    cards: ['今日总请求', '访客（UV）', 'AI 蜘蛛请求', '今日转化'],
    charts: ['d1', 'd2', 'd3'],
    tables: ['topBody'],
    human: ['sources', 'pages'],
    logs: ['summary', 'catalog', 'latest', 'bots', 'pages'],
    today: true,
    insights: true,
  },
  'ai/overview': {
    cards: ['AI 蜘蛛请求（30天）', '识别 AI 蜘蛛', 'AI 抓取页面覆盖率', '单页日均最高抓取'],
    charts: ['a1', 'a2', 'a3', 'a4'],
    tables: ['robotsList'],
    human: ['daily'],
    logs: ['summary', 'catalog', 'latest', 'daily', 'bots', 'pages', 'statuses', 'hours'],
    today: false,
    insights: false,
  },
  'ai/bots': {
    cards: [],
    charts: ['b1'],
    tables: ['botBody'],
    human: [],
    logs: ['summary', 'catalog', 'latest', 'bots', 'pages', 'previousBots'],
    today: false,
    insights: false,
  },
  'ai/pages': {
    cards: ['被 AI 抓取页面', '反复抓取页面', '从未被抓页面', '平均抓取深度'],
    charts: ['ap1'],
    tables: ['apBody', 'blindList'],
    human: [],
    logs: ['summary', 'catalog', 'latest', 'pages', 'bots'],
    today: false,
    insights: false,
  },
  'ai/preference': {
    cards: ['AI 最爱内容类型', '案例页 AI/浏览 比值', '图文页 vs 交互页', '长文平均抓取完成率'],
    charts: ['pf1', 'pf2'],
    tables: ['prefList', 'pathList'],
    human: ['pages'],
    logs: ['summary', 'catalog', 'latest', 'bots', 'pages', 'recent'],
    today: false,
    insights: true,
  },
  'human/overview': {
    cards: ['访客数 UV', '浏览量 PV', '跳出率', '平均访问时长', '新访客占比'],
    charts: ['h1', 'h2', 'h3'],
    tables: ['envGrid'],
    human: ['environment', 'heatmap', 'newVisitors'],
    logs: ['summary', 'catalog', 'latest'],
    today: false,
    insights: false,
  },
  'human/geo': {
    cards: ['覆盖省份', '海外国家/地区', 'TOP1 城市', '海外 TOP1'],
    charts: ['g1', 'g2'],
    tables: ['cityBody'],
    human: ['geo'],
    logs: ['summary', 'catalog', 'latest'],
    today: false,
    insights: false,
  },
  'human/sources': {
    cards: ['直接访问', '传统搜索', 'AI 搜索引荐', 'AI 引荐转化率'],
    charts: ['s1', 's2'],
    tables: ['srcBody'],
    human: ['daily', 'sources', 'dailySources', 'previousSources'],
    logs: ['summary', 'catalog', 'latest', 'daily'],
    today: false,
    insights: false,
  },
  'human/search-engines': {
    cards: ['搜索总会话', '传统搜索会话', 'AI 搜索引荐会话', 'AI 搜索占比'],
    charts: ['se1', 'se2'],
    tables: ['searchEngineBody'],
    human: ['sources'],
    logs: [],
    today: false,
    insights: false,
  },
  'human/keywords': {
    cards: ['搜索渠道会话', '来源搜索词会话', 'UTM 关键词会话', '关键词可用率'],
    charts: [],
    tables: ['keywordBody'],
    human: [],
    logs: [],
    today: false,
    insights: false,
  },
  content: {
    cards: ['有流量页面', '入口页 TOP1', '退出页 TOP1', '内容页平均停留'],
    charts: ['c1'],
    tables: ['pgBody', 'journeyList'],
    human: ['pages', 'journeys', 'exits'],
    logs: ['summary', 'catalog', 'latest', 'pages'],
    today: false,
    insights: false,
  },
  conversions: {
    cards: ['全站转化率', '今日转化', '转化页 TOP1', '白皮书下载'],
    charts: ['f1', 'f2', 'f3'],
    tables: ['goalBody'],
    human: ['sources', 'goals', 'converted', 'dailyConversions', 'previousGoals', 'funnel'],
    logs: ['summary', 'catalog', 'latest'],
    today: true,
    insights: false,
  },
  logs: {
    cards: ['日志处理能力', '今日已解析', '蜘蛛识别规则', '异常请求（今日）'],
    charts: [],
    tables: ['logBody', 'pipeList'],
    human: [],
    logs: ['summary', 'catalog', 'latest', 'recent', 'count'],
    today: true,
    insights: false,
  },
} as const;

const dashboardSnapshotSchema = liekanReportSchema.shape.meta.shape.snapshot.unwrap();
export const pageReportSchema = liekanReportSchema.extend({
  resource: reportQuery.shape.resource,
  charts: z.record(z.string(), liekanReportSchema.shape.charts.shape.d1),
  meta: liekanReportSchema.shape.meta.extend({
    generatedAt: z.number(),
    expiresAt: z.number(),
    snapshot: dashboardSnapshotSchema.optional(),
  }),
});
export type LiekanPageReport = LiekanReport & {
  resource: ReportResource;
  meta: LiekanReport['meta'] & {
    generatedAt: number;
    expiresAt: number;
    snapshot?: z.infer<typeof dashboardSnapshotSchema>;
  };
};
