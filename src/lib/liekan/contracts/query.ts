import { crawlerMetricOptionsSchema } from './crawler-metrics';
import { z } from 'zod';
import { keywordConditionsSchema, keywordStatusVersion } from './keywords';
import { geographySorts } from './geography';
import { evidenceQuerySchema } from './traffic-evidence';

export const crawlerPageFiltersSchema = evidenceQuerySchema.pick({
  botType: true,
  botProductForm: true,
  botCategory: true,
  botId: true,
  botName: true,
});
export type CrawlerPageFilters = z.infer<typeof crawlerPageFiltersSchema>;
export const crawlerPageTypes = [
  ['', '全部'],
  ['训练', 'AI 训练'],
  ['搜索', 'AI 搜索'],
  ['用户触发', '用户触发'],
  ['传统搜索', '传统搜索'],
] as const;
export const crawlerProductFormFilters = [
  ['workbench', 'AI 工作台'],
  ['personal_agent', '个人 Agent'],
] as const;
export function crawlerProductFormForLabel(label: string) {
  return crawlerProductFormFilters.find(([, text]) => text === label)?.[0];
}
export const crawlerFilterLabels = [
  ...crawlerPageTypes.map(([, label]) => label),
  ...crawlerProductFormFilters.map(([, label]) => label),
  '其他爬虫',
];
export function isOtherCrawler(row: { type?: unknown; productForm?: unknown }) {
  return (
    !['训练', '搜索', '用户触发', '传统搜索'].includes(String(row.type ?? '')) &&
    !String(row.productForm ?? '')
      .split(',')
      .some(form => ['workbench', 'personal_agent'].includes(form))
  );
}
// 可分页明细表白名单：请求以扁平参数 tp_<table>=<page> 携带页码。
// 其余明细表行数有界或已由独立协议（logBody keyset）分页，不在白名单内。
// reportQuery 保持纯对象 schema（下游有 pick/extend/shape 派生），白名单校验收口在 parseReportQuery。
export const pagableTables = [
  'topBody',
  'visitorTopBody',
  'pgBody',
  'visitorPgBody',
  'cityBody',
  'srcBody',
  'apBody',
  'blindList',
] as const;
export type PagableTable = (typeof pagableTables)[number];
const pagableTableSet = new Set<string>(pagableTables);
export const tablePageSize = 20;
// Keep offset and offset + batch size safe, without imposing a group-count cap.
export const tablePageMax = Math.floor(Number.MAX_SAFE_INTEGER / tablePageSize);
// `page` is shared by 100-row log batches and 20-row keyword pages.
export const reportPageMax = Math.floor(Number.MAX_SAFE_INTEGER / 100);

export const reportQuery = z.object({
  ...crawlerMetricOptionsSchema.shape,
  ...crawlerPageFiltersSchema.shape,
  refresh: z.literal('1').optional(),
  resource: z.enum([
    'overview',
    'ai/overview',
    'ai/bots',
    'ai/pages',
    'ai/preference',
    'human/overview',
    'human/geo',
    'human/sources',
    'human/search-engines',
    'human/keywords',
    'content',
    'conversions',
    'logs',
  ]),
  startAt: z.coerce.number().int().min(0),
  endAt: z.coerce.number().int().min(0),
  timezone: z.string().max(80).default('Asia/Shanghai'),
  page: z.coerce.number().int().min(1).max(reportPageMax).default(1),
  cursor: z.string().max(512).default(''),
  seek: z.enum(['after', 'before']).default('after'),
  filter: z.enum(['', 'ai', 'abnormal', 'other']).default(''),
  search: z.string().max(200).default(''),
  geoSort: z.enum(geographySorts).default('sessions'),
  engine: keywordConditionsSchema.shape.engine,
  evidence: keywordConditionsSchema.shape.evidence,
  status: keywordConditionsSchema.shape.status,
  keywordStatusVersion: z.literal(keywordStatusVersion).optional(),
  sort: keywordConditionsSchema.shape.sort,
  direction: keywordConditionsSchema.shape.direction,
  keywordSnapshot: z
    .string()
    .regex(/^$|^[a-f0-9-]{36}$/)
    .default(''),
  chartPeriod: z.enum(['today', '30d', '7d', '24h']).default('30d'),
  tablePages: z.record(z.string(), z.coerce.number().int().min(1).max(tablePageMax)).default({}),
});
export type ReportQuery = z.output<typeof reportQuery>;
export const isReportOwnedBy = (key: readonly unknown[], userId: string) =>
  key[0] === 'liekan' && key[14] === userId;
/** Keep a rolling snapshot within its resource and query conditions. */
export function reportSnapshotOwner(key: readonly unknown[]) {
  return key[0] === 'liekan' && key.length >= 15
    ? key.map((value, index) => (index === 4 || index === 5 ? undefined : value))
    : key;
}

// URL 查询是扁平键值（Object.fromEntries），tp_<table> 先归并为 tablePages 再解析；
// 键按字典序排序，保证相同页码集合生成稳定的缓存键与序列化结果。
export function parseReportQuery(input: unknown): z.ZodSafeParseResult<ReportQuery> {
  let flat: unknown = input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const copy: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    const tablePages: Record<string, unknown> = {};
    for (const key of Object.keys(copy).sort()) {
      if (!key.startsWith('tp_')) continue;
      tablePages[key.slice(3)] = copy[key];
      delete copy[key];
    }
    if (Object.keys(tablePages).length) copy.tablePages = tablePages;
    flat = copy;
  }
  const parsed = reportQuery.safeParse(flat);
  if (!parsed.success) return parsed;
  if (
    (parsed.data.botProductForm || parsed.data.botCategory) &&
    !['ai/bots', 'ai/pages'].includes(parsed.data.resource)
  )
    return z.never().safeParse(flat) as z.ZodSafeParseResult<ReportQuery>;
  if (parsed.data.botCategory && (parsed.data.botType || parsed.data.botProductForm))
    return z.never().safeParse(flat) as z.ZodSafeParseResult<ReportQuery>;
  const foreign = Object.keys(parsed.data.tablePages).find(table => !pagableTableSet.has(table));
  return foreign ? (z.never().safeParse(foreign) as z.ZodSafeParseResult<ReportQuery>) : parsed;
}
