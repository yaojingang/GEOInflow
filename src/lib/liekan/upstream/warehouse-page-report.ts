import type { ReportQuery } from '../contracts/query';
import type { PreparedReport } from '../report-prepared';
import { warehouseReader } from '../warehouse/reader-runtime';
import { reportLogRange } from '../report-log-tables';
import { prepareWarehouseAiPageReport } from './warehouse-ai-page-report';
import { pageReportParts } from '../contracts/page-report';
import { getLogFacts } from './logs';
import { warehouseReportMetadata } from './warehouse-report-snapshot';

async function warehousePageCatalogCount(site: string) {
  const [row] = await warehouseReader().db.read<{ count: string }>(
    'SELECT count(*)::text AS count FROM liekan_catalog WHERE website_id=$1::uuid',
    [site],
  );
  const catalogCount = Number(row.count);
  if (!Number.isSafeInteger(catalogCount) || catalogCount < 0)
    throw new Error('warehouse-catalog-count-out-of-range');
  return catalogCount;
}

export async function prepareWarehousePageReport(
  website: { id: string; domain: string },
  p: ReportQuery,
): Promise<PreparedReport | undefined> {
  const range = reportLogRange(p);
  if (['ai/pages', 'ai/bots', 'ai/overview'].includes(p.resource))
    return prepareWarehouseAiPageReport(website.id, website.domain, p, range);
  if (['human/overview', 'human/geo', 'logs', 'conversions'].includes(p.resource)) {
    const logs = await getLogFacts(
      website.id,
      range.start,
      range.end,
      p.timezone,
      p.page,
      p.filter,
      p.search,
      p.cursor,
      p.seek,
      pageReportParts[p.resource].logs.filter(field => field !== 'catalog'),
      p,
    );
    const catalogCount = await warehousePageCatalogCount(website.id);
    return { range, logs, catalogCount };
  }
  if (!['overview', 'content', 'human/sources'].includes(p.resource)) return undefined;
  const { prepareWarehouseBrowserPageReport } = await import('./warehouse-browser-page-report');
  if (p.resource === 'overview') await warehouseReportMetadata(website.id);
  const catalogCount = await warehousePageCatalogCount(website.id);
  const prepared = await prepareWarehouseBrowserPageReport(website.id, p, range, catalogCount);
  prepared.range = range;
  try {
    const catalog = prepared.catalogCoverage ?? { catalogCount, blindCount: catalogCount };
    prepared.catalogCount = catalog.catalogCount;
    const decorate = prepared.decorate;
    prepared.decorate = report => {
      decorate?.(report);
      report.states.catalog = catalog.catalogCount ? 'available' : 'not_connected';
      const catalogInsight = report.insights.indexOf(
        '接入日志与 sitemap、CSV 或 JSON 目录后可计算完整覆盖率。',
      );
      if (p.resource === 'overview' && catalogInsight >= 0) {
        report.insights[catalogInsight] =
          catalog.catalogCount && prepared.logs?.latest
            ? `目录 ${catalog.catalogCount} 个 URL，${catalog.blindCount} 个在所选范围没有 AI 抓取。`
            : '接入日志与 sitemap、CSV 或 JSON 目录后可计算完整覆盖率。';
        if (report.tables.recoList)
          report.tables.recoList = report.insights.map((detail, i) => ({
            name: `观察 ${i + 1}`,
            detail,
            state: '规则生成',
          }));
      }
    };
    return prepared;
  } catch (error) {
    await prepared.dispose?.();
    throw error;
  }
}
