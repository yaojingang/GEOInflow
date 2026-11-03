import type { ReportQuery } from '../contracts/query';
import type { PreparedReport } from '../report-prepared';
import { warehouseReader } from '../warehouse/reader-runtime';
import { reportLogRange } from '../report-log-tables';
import { warehouseCatalogProjection, warehouseCatalogPaths } from './warehouse-catalog';
import { warehouseLogQuerySpec } from './warehouse-log-queries';
import { warehouseReportQuery } from './warehouse-report-snapshot';
import { prepareWarehouseAiPageReport } from './warehouse-ai-page-report';
import { pageReportParts } from '../contracts/page-report';
import { getLogFacts } from './logs';

export async function warehousePageCatalogCoverage(
  site: string,
  p: ReportQuery,
  countCoverage: boolean,
  range = reportLogRange(p),
) {
  const [row] = await warehouseReader().db.read<{ count: string }>(
    'SELECT count(*)::text AS count FROM liekan_catalog WHERE website_id=$1::uuid',
    [site],
  );
  const catalogCount = Number(row.count);
  if (!Number.isSafeInteger(catalogCount) || catalogCount < 0)
    throw new Error('warehouse-catalog-count-out-of-range');
  if (!catalogCount || !countCoverage) return { catalogCount, blindCount: catalogCount };
  const { start, end } = range;
  const spec = await warehouseLogQuerySpec(
    start,
    end,
    p.timezone,
    p,
    p.filter,
    p.search,
    false,
    site,
  );
  const projection = await warehouseCatalogProjection(site);
  const [coverage] = await warehouseReportQuery<{ blind: string }>(
    site,
    `SELECT countIf(path NOT IN (SELECT path FROM (${spec.statements.pages}))) AS blind FROM ${warehouseCatalogPaths}`,
    { ...spec.params, ...projection },
  );
  const blindCount = Number(coverage.blind);
  if (!Number.isSafeInteger(blindCount) || blindCount < 0 || blindCount > catalogCount)
    throw new Error('warehouse-catalog-coverage-out-of-range');
  return { catalogCount, blindCount };
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
    const { catalogCount } = await warehousePageCatalogCoverage(website.id, p, false, range);
    return { range, logs, catalogCount };
  }
  if (!['overview', 'content', 'human/sources'].includes(p.resource)) return undefined;
  const { prepareWarehouseBrowserPageReport } = await import('./warehouse-browser-page-report');
  const prepared = await prepareWarehouseBrowserPageReport(website.id, p, range);
  prepared.range = range;
  try {
    const catalog = await warehousePageCatalogCoverage(
      website.id,
      p,
      p.resource === 'overview' && !!prepared.logs?.latest,
      range,
    );
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
