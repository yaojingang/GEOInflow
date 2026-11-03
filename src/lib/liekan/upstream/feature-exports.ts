import { warehouseEnabled } from '../warehouse/authority-routing';
import { readBrowserPopulation } from './browser-population';
import { identityUsable, unavailableFields } from '../contracts/browser-population';
import { getPublishedCatalog } from '../crawlers/published';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
import { liekanProduct } from '@/lib/liekan/contracts/product';
import { getPostgresCountrySQL } from '@/lib/country';
import { createHash, randomBytes } from 'node:crypto';
import JSZip from 'jszip';
import Papa from 'papaparse';
import prisma, { getRawQueryClient } from '@/lib/prisma';
import type { PrismaClient } from '@/generated/prisma/client';
import { getQuerySnapshot, withinQuerySnapshot } from './query-snapshot';
import { timedAnalyticsClient } from './analytics-deadline';
import { getQueryFilters } from '@/lib/request';
import { getWebsiteStats } from '@/queries/sql';
import { getWebsiteSegment } from '@/queries/prisma';
import {
  EXPORT_MAX_BYTES,
  EXPORT_MAX_ROWS,
  exportRequestSchema,
  safeCsvCell,
  sanitizeExportValue,
  type ExportFrame,
} from '../contracts/exports';
import { LiekanError, reportSnapshot } from './server';
import { analyticsGate } from './analytics-budget';
import { readKeywordFacts, validateKeywordRange } from './keywords';
import { getHumanFacts } from './analytics';
import {
  countryName,
  geographyTable,
  geographyVersion,
  geographyCoverage,
} from '../contracts/geography';
import type { LiekanLocale } from '../i18n/locale';
import { DATA_TYPES } from '@/lib/constants';
import {
  selectKeywords,
  supportsKeywordRedirect,
  keywordConditionsSchema,
  keywordStatusLabels,
  keywordEvidenceLabels,
  redactKeywordTerm,
} from '../contracts/keywords';

const englishExportLabels: Record<string, string> = {
  统计读取时间: 'Statistics read at',
  开始时间: 'Start time',
  结束时间: 'End time',
  时区: 'Timezone',
  筛选条件: 'Filters',
  一致性: 'Consistency',
  '关键词/状态': 'Keyword / status',
  搜索引擎: 'Search engine',
  识别依据: 'Evidence',
  会话数: 'Sessions',
  '搜索渠道占比(%)': 'Search channel share (%)',
  '跳出率(%)': 'Bounce rate (%)',
  '转化率(%)': 'Conversion rate (%)',
  城市: 'City',
  会话: 'Sessions',
  '占比(%)': 'Share (%)',
  '平均时长(秒)': 'Average duration (seconds)',
  已识别: 'Identified',
  来源未携带搜索词: 'Source has no search term',
  跳转链接无可用搜索词: 'Redirect link has no usable search term',
  无法解析: 'Unable to parse',
  来源格式不支持: 'Unsupported source format',
  证据冲突: 'Conflicting evidence',
  完整性无法确认: 'Completeness unconfirmed',
  已脱敏: 'Redacted',
  来源搜索词: 'Referrer search term',
  'UTM 手动标记': 'Manual UTM tag',
  无可用关键词: 'No usable keyword',
  百度: 'Baidu',
  搜狗: 'Sogou',
  '360 搜索': '360 Search',
  神马: 'Shenma',
};
export const exportLabel = (source: string, locale?: LiekanLocale) =>
  locale === 'en-US' && Object.hasOwn(englishExportLabels, source)
    ? englishExportLabels[source]
    : source;
const englishFieldLabels: Record<string, string> = {
  pageviews: 'Pageviews',
  visitors: 'Visitors',
  visits: 'Sessions',
  bounces: 'Bounces',
  totaltime: 'Total duration (seconds)',
  id: 'Visitor ID',
  firstAt: 'First seen',
  lastAt: 'Last seen',
  views: 'Pageviews',
  events: 'Events',
  browser: 'Browser',
  device: 'Device',
  country: 'Country / region',
  name: 'Name',
  triggers: 'Triggers',
  event: 'Event',
  property: 'Property',
  type: 'Type',
  value: 'Value',
};
export function csvFieldLabel(file: string, field: string, locale?: LiekanLocale) {
  if (locale !== 'en-US') return field;
  if (field === 'name')
    return (
      {
        'pages.csv': 'Page',
        'sources.csv': 'Referrer',
        'browsers.csv': 'Browser',
        'devices.csv': 'Device',
        'countries.csv': 'Country / region',
        'events.csv': 'Event',
      }[file] || 'Name'
    );
  return Object.hasOwn(englishFieldLabels, field) ? englishFieldLabels[field] : field;
}
export function csvDisplayValue(
  file: string,
  field: string,
  value: unknown,
  locale?: LiekanLocale,
) {
  if (locale !== 'en-US') return value;
  if (
    typeof value === 'string' &&
    (field === 'country' || (file === 'countries.csv' && field === 'name'))
  )
    return countryName(value, locale);
  if (
    typeof value === 'string' &&
    (field === 'device' || (file === 'devices.csv' && field === 'name'))
  ) {
    const devices = { desktop: 'Desktop', laptop: 'Laptop', mobile: 'Mobile', tablet: 'Tablet' };
    return Object.hasOwn(devices, value) ? devices[value] : value;
  }
  if (file === 'event-properties.csv' && field === 'type')
    return Object.hasOwn(DATA_TYPES, String(value))
      ? DATA_TYPES[value as keyof typeof DATA_TYPES]
      : value;
  return value;
}

export async function prepareFeatureExport(
  website: { id: string; name: string; domain: string },
  input: unknown,
  signal: AbortSignal,
) {
  const parsed = exportRequestSchema.safeParse(input);
  if (!parsed.success) throw new LiekanError('导出参数无效');
  const p = parsed.data;
  if (warehouseEnabled() && p.kind)
    return (await import('./warehouse-special-exports')).warehouseSpecialExport(website, p, signal);
  if (p.kind === 'geography') {
    if (process.env.CLICKHOUSE_URL) throw new LiekanError('地域完整导出当前支持 PostgreSQL', 501);
    return analyticsGate.run(() =>
      reportSnapshot(() => prepareGeographySnapshot(website, p, signal)),
    );
  }
  if (p.kind === 'source-keywords') {
    const deadline = Date.now() + 65000;
    return analyticsGate.run(
      () =>
        reportSnapshot(() =>
          withinQuerySnapshot(
            timedAnalyticsClient(getQuerySnapshot(), Math.min(deadline, Date.now() + 60000)),
            () => prepareKeywordSnapshot(website, p, signal),
          ),
        ),
      deadline,
    );
  }
  if (warehouseEnabled())
    return (await import('./warehouse-feature-exports')).warehouseFeatureExport(website, p, signal);
  if (process.env.CLICKHOUSE_URL)
    throw new LiekanError('完整导出当前支持 PostgreSQL，可使用兼容导出功能。', 501);
  const primary = getRawQueryClient(prisma.client, { write: true }) as PrismaClient;
  return primary.$transaction(
    tx => withinQuerySnapshot(tx, () => prepareSnapshot(website, p, signal)),
    { isolationLevel: 'RepeatableRead', maxWait: 10000, timeout: 120000 },
  );
}
async function prepareSnapshot(
  website: { id: string; name: string; domain: string },
  p: Exclude<ReturnType<typeof exportRequestSchema.parse>, { kind: string }>,
  signal: AbortSignal,
) {
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: p.timezone }).format();
  } catch {
    throw new LiekanError('时区无效');
  }
  const population = await readBrowserPopulation(
    website.id,
    new Date(p.startAt),
    new Date(p.endAt),
    p.timezone,
  );
  const sections = p.format === 'zip' ? [...new Set(p.sections)] : ['summary'];
  for (const key of ['segment', 'cohort'])
    if (p.filters[key] && !(await getWebsiteSegment(website.id, p.filters[key])))
      throw new LiekanError('人群条件不属于所选站点', 404);
  const filters = await getQueryFilters(
    { ...p.filters, startAt: p.startAt, endAt: p.endAt, timezone: p.timezone },
    website.id,
  );
  const { filterQuery, joinSessionQuery, cohortQuery, excludeBounceQuery, queryParams } =
    prisma.parseFilters({
      ...filters,
      websiteId: website.id,
    });
  const cte = `WITH selected AS(SELECT website_event.* FROM website_event ${cohortQuery} ${joinSessionQuery} ${excludeBounceQuery} WHERE website_event.website_id={{websiteId::uuid}} AND website_event.created_at BETWEEN {{startDate}} AND {{endDate}} AND website_event.event_type IN (1,2) ${filterQuery})`;
  const aborted = () => {
    if (signal.aborted) throw new LiekanError('导出已取消', 499);
  };
  const run = async (sql: string, params: any = {}) => {
    aborted();
    const rows = await prisma.rawQuery(
      `${cte} ${sql}`,
      { ...queryParams, ...params },
      'liekanCompleteExport',
    );
    aborted();
    return JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
  };
  const salt = randomBytes(32).toString('hex');
  const mask = (id: string) =>
    id
      ? `visitor-${createHash('sha256')
          .update(salt + id)
          .digest('hex')
          .slice(0, 12)}`
      : null;
  const files: { name: string; content: string; rows: number; fields: string[] }[] = [];
  let bytes = 0,
    rows = 0;
  const add = (name: string, data: any[], format: 'csv' | 'json' = 'csv') => {
    const displayLocale = p.format === 'json' ? undefined : p.locale;
    rows += data.length;
    if (rows > EXPORT_MAX_ROWS)
      throw new LiekanError('导出明细超过 100,000 行，请缩小日期范围或数据范围', 413);
    const safe = data.map(row => {
      const clean: any = sanitizeExportValue(row);
      if (row.property && /password|secret|token|key|email|phone|ip|cookie/i.test(row.property))
        clean.value = '[已脱敏]';
      return clean;
    });
    const fields = [...new Set<string>(safe.flatMap(row => Object.keys(row)))];
    const content =
      format === 'json'
        ? JSON.stringify(safe)
        : Papa.unparse(
            {
              fields: fields.map(key => safeCsvCell(csvFieldLabel(name, key, displayLocale))),
              data: safe.map(row =>
                fields.map(key =>
                  safeCsvCell(
                    typeof row[key] === 'object' && row[key] !== null
                      ? JSON.stringify(row[key])
                      : csvDisplayValue(name, key, row[key], displayLocale),
                  ),
                ),
              ),
            },
            { header: true },
          );
    bytes += Buffer.byteLength(content);
    if (bytes > EXPORT_MAX_BYTES)
      throw new LiekanError('导出文件超过 50 MiB，请缩小日期范围或数据范围', 413);
    files.push({ name, content, rows: data.length, fields });
  };
  const paged = async (sql: string, mapper: (row: any) => any = r => r) => {
    const data: any[] = [];
    let bufferedBytes = 0;
    for (let offset = 0; ; offset += 1000) {
      const rawPage = await run(`${sql} LIMIT 1000 OFFSET {{offset}}`, { offset });
      const page = identityUsable(population)
        ? rawPage
        : rawPage.map(row => unavailableFields(row, ['visitors', 'visits', 'seconds']));
      for (const row of page) {
        const mapped = mapper(row);
        bufferedBytes += Buffer.byteLength(JSON.stringify(sanitizeExportValue(mapped)));
        if (bytes + bufferedBytes > EXPORT_MAX_BYTES)
          throw new LiekanError('导出处理数据超过 50 MiB，请缩小范围', 413);
        data.push(mapped);
      }
      if (rows + data.length > EXPORT_MAX_ROWS)
        throw new LiekanError('导出明细超过 100,000 行，请缩小日期范围或数据范围', 413);
      if (page.length < 1000) break;
    }
    return data;
  };
  let summary: any;
  if (sections.includes('summary')) {
    aborted();
    summary = await getWebsiteStats(website.id, filters);
    aborted();
    summary = JSON.parse(
      JSON.stringify(summary, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)),
    );
    add('summary.csv', [summary]);
  }
  if (sections.includes('dimensions')) {
    for (const [name, column, session] of [
      ['pages', 'url_path', false],
      ['sources', 'referrer_domain', false],
      ['browsers', 'browser', true],
      ['devices', 'device', true],
      ['countries', 'country', true],
    ] as const) {
      const query = session
        ? `SELECT ${column === 'country' ? getPostgresCountrySQL('s.liekan_country') : `s.liekan_${column}`} AS name,COUNT(DISTINCT s.session_id) AS visitors,COUNT(*) FILTER(WHERE event_type=1) AS views FROM selected s WHERE s.event_type=1 GROUP BY 1 ORDER BY visitors DESC,name`
        : `SELECT ${column} AS name,COUNT(DISTINCT session_id) AS visitors,COUNT(*) AS views FROM selected WHERE event_type=1 GROUP BY 1 ORDER BY views DESC,name`;
      add(`${name}.csv`, await paged(query));
    }
  }
  if (sections.includes('events')) {
    add(
      'events.csv',
      await paged(
        'SELECT event_name AS name,COUNT(*) AS triggers,COUNT(DISTINCT session_id) AS visitors FROM selected WHERE event_type=2 GROUP BY 1 ORDER BY triggers DESC,name',
      ),
    );
    add(
      'event-properties.csv',
      await paged(
        'SELECT s.event_name AS event,d.data_key AS property,d.data_type AS type,COALESCE(d.string_value,d.number_value::text,d.date_value::text) AS value,COUNT(DISTINCT s.event_id) AS triggers FROM event_data d JOIN selected s ON s.event_id=d.website_event_id WHERE d.website_id={{websiteId::uuid}} AND s.event_type=2 GROUP BY 1,2,3,4 ORDER BY event,property,type,value',
      ),
    );
  }
  if (sections.includes('sessions') && identityUsable(population)) {
    add(
      'sessions.csv',
      await paged(
        `SELECT s.session_id AS id,MIN(s.created_at) AS "firstAt",MAX(s.created_at) AS "lastAt",COUNT(*) FILTER(WHERE event_type=1) AS views,COUNT(*) FILTER(WHERE event_type=2) AS events,COUNT(DISTINCT visit_id) AS visits,(ARRAY_AGG(s.liekan_browser ORDER BY s.created_at DESC,s.event_id DESC))[1] AS browser,(ARRAY_AGG(s.liekan_device ORDER BY s.created_at DESC,s.event_id DESC))[1] AS device,${getPostgresCountrySQL('(ARRAY_AGG(s.liekan_country ORDER BY s.created_at DESC,s.event_id DESC))[1]')} AS country FROM selected s GROUP BY s.session_id ORDER BY "lastAt",s.session_id`,
        r => ({ ...r, id: mask(r.id) }),
      ),
    );
  }
  if (sections.includes('config')) {
    const sizes = await run(
      'SELECT COALESCE((SELECT SUM(octet_length(parameters::text)) FROM report WHERE website_id={{websiteId::uuid}}),0)+COALESCE((SELECT SUM(octet_length(parameters::text)) FROM segment WHERE website_id={{websiteId::uuid}}),0) AS bytes',
    );
    if (Number(sizes[0]?.bytes) > EXPORT_MAX_BYTES - bytes)
      throw new LiekanError('保存配置超过 50 MiB，请缩小导出范围', 413);
    const reports = await paged(
      'SELECT name,type,parameters FROM report WHERE website_id={{websiteId::uuid}} ORDER BY report_id',
    );
    add('saved-reports.json', reports, 'json');
    const segments = await paged(
      'SELECT name,type,parameters FROM segment WHERE website_id={{websiteId::uuid}} ORDER BY segment_id',
    );
    add('saved-audiences.json', segments, 'json');
    add(
      'configuration.json',
      [{ website: { name: website.name, domain: website.domain } }],
      'json',
    );
  }
  aborted();
  const manifest = {
    catalogVersion: getPublishedCatalog()?.version ?? null,
    populationVersion: TRAFFIC_POLICY_VERSION,
    snapshotVersion: 'browser-population-v1',
    population,
    product: p.format === 'json' ? 'Liekan 猎看统计' : liekanProduct.name,
    createdAt: new Date().toISOString(),
    website: { name: website.name, domain: website.domain },
    range: { startAt: p.startAt, endAt: p.endAt, timezone: p.timezone },
    filterFields: Object.keys(p.filters),
    sections,
    unavailableSections:
      !identityUsable(population) && sections.includes('sessions') ? ['sessions'] : [],
    format: p.format,
    consistency: 'repeatable-read',
    limits: { rows: EXPORT_MAX_ROWS, bytes: EXPORT_MAX_BYTES },
    privacy:
      p.locale === 'en-US' && p.format !== 'json'
        ? 'Session identifiers are anonymized within this file. Raw IP addresses, account credentials, keys and backup codes are excluded.'
        : '会话标识在本文件内脱敏；不包含原始 IP、账户凭据、密钥或备份代码',
    files: files.map(({ name, rows, fields }) => ({
      name,
      rows,
      fields,
      ...(p.locale === 'en-US' && p.format !== 'json' && name.endsWith('.csv')
        ? { displayFields: fields.map(field => csvFieldLabel(name, field, p.locale)) }
        : {}),
    })),
  };
  const manifestContent = JSON.stringify(manifest, null, 2);
  bytes += Buffer.byteLength(manifestContent);
  if (bytes > EXPORT_MAX_BYTES) throw new LiekanError('字段清单与数据超过 50 MiB，请缩小范围', 413);
  const name = `liekan-export-${new Date().toISOString().replace(/[:.]/g, '-')}.${p.format}`;
  return exportFilesResponse(files, p.format, summary, manifest, name, manifestContent, signal);
}
function exportFilesResponse(
  files: { content: string; name: string }[],
  format: 'csv' | 'json' | 'zip',
  summary: unknown,
  manifest: unknown,
  name: string,
  manifestContent: string,
  signal: AbortSignal,
) {
  let canceled = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const onAbort = () => {
          canceled = true;
        };
        signal.addEventListener('abort', onAbort, { once: true });
        const emit = (frame: ExportFrame) => {
          if (canceled || signal.aborted) throw new LiekanError('导出已取消', 499);
          controller.enqueue(new TextEncoder().encode(JSON.stringify(frame) + '\n'));
        };
        try {
          emit({
            type: 'progress',
            stage: '已完成数据查询与范围校验',
            percent: 0,
          });
          let file: Buffer;
          if (format === 'zip') {
            const zip = new JSZip();
            files.forEach(f => zip.file(f.name, f.content));
            zip.file('manifest.json', manifestContent);
            file = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }, update =>
              emit({
                type: 'progress',
                stage: '正在生成文件',
                percent: Math.round(update.percent * 0.8),
              }),
            );
          } else
            file = Buffer.from(
              format === 'csv' ? files[0].content : JSON.stringify({ summary, manifest }),
            );
          if (file.length > EXPORT_MAX_BYTES)
            throw new LiekanError('下载文件超过 50 MiB，请缩小范围', 413);
          emit({
            type: 'file',
            name,
            mime:
              format === 'zip'
                ? 'application/zip'
                : format === 'csv'
                  ? 'text/csv;charset=utf-8'
                  : 'application/json',
            size: file.length,
            manifest,
          });
          for (let offset = 0; offset < file.length; offset += 49152) {
            emit({ type: 'chunk', data: file.subarray(offset, offset + 49152).toString('base64') });
            emit({
              type: 'progress',
              stage: '正在传输下载文件',
              percent:
                80 +
                Math.round((Math.min(file.length, offset + 49152) / Math.max(1, file.length)) * 20),
            });
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          emit({ type: 'complete' });
          controller.close();
        } catch (error) {
          if (!canceled && !signal.aborted) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  type: 'error',
                  status: error instanceof LiekanError ? error.status : 500,
                  message: error instanceof LiekanError ? error.message : '文件生成失败',
                }) + '\n',
              ),
            );
            controller.close();
          }
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      },
      cancel() {
        canceled = true;
      },
    }),
    {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}

async function prepareKeywordSnapshot(
  website: { id: string; name: string; domain: string },
  p: Extract<ReturnType<typeof exportRequestSchema.parse>, { kind: 'source-keywords' }>,
  signal: AbortSignal,
) {
  validateKeywordRange(p);
  const facts = await readKeywordFacts(website.id, p, signal);
  const population = await readBrowserPopulation(
    website.id,
    new Date(p.startAt),
    new Date(p.endAt),
    p.timezone,
  );
  const conditions = keywordConditionsSchema.parse(p);
  const selected = selectKeywords(
    facts.rows,
    conditions,
    facts.hasGoals,
    supportsKeywordRedirect(p),
  );
  if (selected.rows.length > EXPORT_MAX_ROWS)
    throw new LiekanError('关键词导出超过 100,000 行，请缩小范围', 413);
  const createdAt = new Date(facts.readAt).toISOString();
  const safeConditions = sanitizeExportValue({
    ...conditions,
    search: redactKeywordTerm(conditions.search),
  });
  const metadata = [
    ['统计读取时间', createdAt],
    ['开始时间', new Date(p.startAt).toISOString()],
    ['结束时间', new Date(p.endAt).toISOString()],
    ['时区', p.timezone],
    ['筛选条件', JSON.stringify(safeConditions)],
    ['一致性', 'repeatable-read'],
  ].map(([label, value]) => [exportLabel(label, p.locale), value]);
  const fields = [
    '关键词/状态',
    '搜索引擎',
    '识别依据',
    '会话数',
    '搜索渠道占比(%)',
    '跳出率(%)',
    '转化率(%)',
  ].map(label => exportLabel(label, p.locale));
  const data = selected.rows.map(row => [
    row.keyword || exportLabel(keywordStatusLabels[row.status], p.locale),
    exportLabel(row.engine, p.locale),
    exportLabel(keywordEvidenceLabels[row.evidence], p.locale),
    identityUsable(population) ? row.sessions : null,
    identityUsable(population) ? row.share : null,
    identityUsable(population) ? row.bounceRate : null,
    identityUsable(population) ? row.conversionRate : null,
  ]);
  const content =
    '\ufeff' +
    Papa.unparse(metadata.map(row => row.map(safeCsvCell))) +
    '\r\n\r\n' +
    Papa.unparse({ fields: fields.map(safeCsvCell), data: data.map(row => row.map(safeCsvCell)) });
  if (Buffer.byteLength(content) > EXPORT_MAX_BYTES)
    throw new LiekanError('关键词导出超过 50 MiB，请缩小范围', 413);
  const manifest = {
    catalogVersion: getPublishedCatalog()?.version ?? null,
    populationVersion: TRAFFIC_POLICY_VERSION,
    snapshotVersion: 'browser-population-v1',
    population,
    kind: p.kind,
    createdAt,
    website: { name: website.name, domain: website.domain },
    range: { startAt: p.startAt, endAt: p.endAt, timezone: p.timezone },
    conditions: safeConditions,
    rows: selected.rows.length,
    fields,
    consistency: 'repeatable-read',
    limits: { rows: EXPORT_MAX_ROWS, bytes: EXPORT_MAX_BYTES },
  };
  return exportFilesResponse(
    [{ name: 'source-keywords.csv', content }],
    'csv',
    undefined,
    manifest,
    `liekan-source-keywords-${createdAt.replace(/[:.]/g, '-')}.csv`,
    JSON.stringify(manifest),
    signal,
  );
}

async function prepareGeographySnapshot(
  website: { id: string; name: string; domain: string },
  p: Extract<ReturnType<typeof exportRequestSchema.parse>, { kind: 'geography' }>,
  signal: AbortSignal,
) {
  const aborted = () => {
    if (signal.aborted) throw new LiekanError('导出已取消', 499);
  };
  aborted();
  if (p.endAt > Date.now() + 86400000) throw new LiekanError('日期范围无效');
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: p.timezone }).format();
  } catch {
    throw new LiekanError('时区无效');
  }
  const facts = await getHumanFacts(
    website.id,
    new Date(p.startAt),
    new Date(p.endAt),
    p.timezone,
    ['geo', 'goals'],
    { rows: EXPORT_MAX_ROWS, bytes: EXPORT_MAX_BYTES },
  );
  aborted();
  const population = facts.totals.population;
  const rows = geographyTable(
    facts.geo,
    facts.totals.visits,
    !!facts.goals.length,
    p,
    p.locale,
  ).map(row =>
    identityUsable(population)
      ? row
      : unavailableFields(row, ['sessions', 'share', 'duration', 'bounceRate', 'conversionRate']),
  );
  if (rows.length > EXPORT_MAX_ROWS)
    throw new LiekanError('地域导出超过 100,000 行，请缩小范围', 413);
  const fields = ['城市', '会话', '占比(%)', '平均时长(秒)', '跳出率(%)', '转化率(%)'].map(label =>
    exportLabel(label, p.locale),
  );
  const safeRows = sanitizeExportValue(rows) as typeof rows;
  const content =
    '\ufeff' +
    Papa.unparse({
      fields,
      data: safeRows.map(row =>
        [
          redactKeywordTerm(row.city),
          row.sessions,
          row.share,
          row.duration,
          row.bounceRate,
          row.conversionRate,
        ].map(safeCsvCell),
      ),
    });
  if (Buffer.byteLength(content) > EXPORT_MAX_BYTES)
    throw new LiekanError('地域导出超过 50 MiB，请缩小范围', 413);
  aborted();
  const createdAt = new Date().toISOString();
  const manifest = {
    catalogVersion: getPublishedCatalog()?.version ?? null,
    populationVersion: TRAFFIC_POLICY_VERSION,
    snapshotVersion: 'browser-population-v1',
    population,
    kind: p.kind,
    createdAt,
    geographyVersion,
    geographyCoverage: identityUsable(population)
      ? geographyCoverage(facts.geo, facts.totals.visits)
      : null,
    rows: rows.length,
    fields,
    range: { startAt: p.startAt, endAt: p.endAt, timezone: p.timezone },
    selection: sanitizeExportValue({
      search: redactKeywordTerm(p.search),
      geoSort: p.geoSort,
      direction: p.direction,
    }),
    consistency: 'repeatable-read',
  };
  return exportFilesResponse(
    [{ name: 'geography.csv', content }],
    'csv',
    undefined,
    manifest,
    `liekan-geography-${createdAt.replace(/[:.]/g, '-')}.csv`,
    JSON.stringify(manifest),
    signal,
  );
}
