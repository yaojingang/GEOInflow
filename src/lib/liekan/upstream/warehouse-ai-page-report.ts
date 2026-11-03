import type { PreparedReport } from '../report-prepared';
import type { ReportQuery } from '../contracts/query';
import { tablePageSize } from '../contracts/query';
import { reportLogRange } from '../report-log-tables';
import { warehouseLogFacts } from './warehouse-log-queries';
import { warehouseReportEvidence } from './warehouse-report-evidence';
import { pageReportParts } from '../contracts/page-report';
import { warehouseReader } from '../warehouse/reader-runtime';

export async function prepareWarehouseAiPageReport(
  site: string,
  domain: string,
  p: ReportQuery,
  range = reportLogRange(p),
): Promise<PreparedReport> {
  const { start, end, readEndAt } = range;
  const logs = await warehouseLogFacts(
    site,
    start,
    end,
    p.timezone,
    p.page,
    p.filter,
    p.search,
    p.cursor,
    p.seek,
    pageReportParts[p.resource].logs.filter(
      field => !['pages', 'catalog', 'previousBots'].includes(field),
    ),
    p,
  );
  const evidence = await warehouseReportEvidence(
    undefined,
    site,
    { ...p, endAt: readEndAt },
    { filter: '全部', sort: { label: '', direction: 1 }, search: '' },
    domain,
    { pageSummary: p.resource !== 'ai/bots', longRunning: false },
  );
  try {
    if (p.resource === 'ai/bots') {
      const rows: any[] = [];
      await evidence.source.stream(async batch => {
        rows.push(...batch);
      });
      const [catalog] = await warehouseReader().db.read<{ count: string }>(
        'SELECT count(*)::text AS count FROM liekan_catalog WHERE website_id=$1::uuid',
        [site],
      );
      const catalogCount = Number(catalog.count);
      if (!Number.isSafeInteger(catalogCount) || catalogCount < 0)
        throw new Error('warehouse-catalog-count-out-of-range');
      return {
        range,
        logs,
        catalogCount,
        dispose: () => evidence.source.dispose(),
        decorate(report) {
          report.tables.botBody = rows;
        },
      };
    }
    const summary = evidence.pageSummary;
    if (p.resource === 'ai/overview') {
      return {
        range,
        logs,
        catalogCount: summary.catalogCount,
        dispose: () => evidence.source.dispose(),
        decorate(report) {
          for (const card of report.cards) {
            if (card.label === 'AI 抓取页面覆盖率')
              card.value =
                logs.latest && summary.catalogCount
                  ? Math.round((summary.covered / summary.catalogCount) * 10000) / 100
                  : null;
            if (card.label === '单页日均最高抓取')
              card.value = summary.pageCount
                ? Math.round((summary.maximum / range.days) * 100) / 100
                : null;
          }
        },
      };
    }
    const page = p.tablePages.apBody ?? 1,
      blindPage = p.tablePages.blindList ?? 1;
    const rows = await evidence.source.page((page - 1) * tablePageSize, tablePageSize);
    const blindTotal = logs.latest ? await summary.blind.count() : 0;
    const blindRows = logs.latest
      ? (await summary.blind.page((blindPage - 1) * tablePageSize, tablePageSize)).map(row => ({
          path: row.path,
          reason: '已收录目录，所选范围无 AI 抓取',
        }))
      : [];
    return {
      range,
      catalogCount: summary.catalogCount,
      logs,
      dispose: () => evidence.source.dispose(),
      decorate(report) {
        report.states.catalog = summary.catalogCount ? 'available' : 'not_connected';
        const values = {
          '被 AI 抓取页面': logs.latest ? summary.pageCount : null,
          反复抓取页面: logs.latest ? summary.repeated : null,
          从未被抓页面: logs.latest && summary.catalogCount ? blindTotal : null,
          平均抓取深度: summary.depthCount
            ? Math.round((summary.depthTotal / summary.depthCount) * 100) / 100
            : null,
        };
        for (const card of report.cards) {
          card.value = values[card.label];
          if (card.label === '从未被抓页面')
            card.state =
              report.states.logs === 'not_connected' ? 'not_connected' : report.states.catalog;
          if (card.label === '平均抓取深度')
            card.state = summary.depthCount ? report.states.logs : 'not_connected';
        }
        report.charts.ap1 = {
          labels: summary.topDirectories.map(row => row.name),
          series:
            report.states.logs === 'not_connected'
              ? []
              : [{ name: '抓取次数', values: summary.topDirectories.map(row => row.count) }],
          state: report.states.logs,
          ...(report.states.logs === 'not_connected' ? { rows: [] } : {}),
        };
        report.tables.apBody = rows;
        report.tables.blindList = blindRows;
        report.meta.tablePages = {
          ...report.meta.tablePages,
          apBody: { page, pageSize: tablePageSize, total: summary.pageCount },
          blindList: { page: blindPage, pageSize: tablePageSize, total: blindTotal },
        };
      },
    };
  } catch (error) {
    await evidence.source.dispose();
    throw error;
  }
}
