import { createHash } from 'node:crypto';
import {
  EXPORT_MAX_BYTES,
  EXPORT_MAX_ROWS,
  safeCsvCell,
  sanitizeExportValue,
} from '../contracts/exports';
import { parseReportQuery } from '../contracts/query';
import { reportEvidenceViewPayload } from '../contracts/report-evidence-view';
import { evidenceExportSchema } from '../contracts/traffic-evidence';
import { decodeCursor } from '../cursor';
import { buildReport } from '../report';
import {
  authenticateCrawler,
  authorizeCrawler,
  type CrawlerActor,
  crawlerTransaction,
} from '../upstream/crawler-access';
import { withPublishedRegistry } from '../upstream/crawler-registry-context';
import { LiekanError } from '../upstream/errors';
import { attachReportEvidenceView } from '../upstream/report-evidence-view';
import {
  warehouseEvidenceRows,
  withWarehouseEvidenceResources,
} from '../upstream/warehouse-evidence-table';
import { warehouseReportPageComparison } from '../upstream/warehouse-report-page-comparison';
import { withinWarehouseReport } from '../upstream/warehouse-report-snapshot';
import { warehouseEnabled } from '../warehouse/authority-routing';
import { warehouseEvidenceCsv } from './evidence-csv-artifact';
import {
  parseEvidenceQuery,
  queryEvidence,
  readCrawlerEvidence,
  readReconciliation,
} from './evidence-read';
import { evidenceSnapshot } from './evidence-snapshot';
import { parseObservationQuery, readObservations } from './observation-read';
import { readOutcomes } from './outcomes-read';
import { parsePerformanceQuery, readPerformance } from './performance-read';
import { getPublishedCatalog } from './published';
import { readReportEvidence, reportEvidenceCsv } from './report-evidence';

async function exportEvidenceSnapshot(
  actor: CrawlerActor,
  websiteId: string,
  body: unknown,
  request: Request,
  permitted: readonly string[],
) {
  const parsed = evidenceExportSchema.safeParse(body);
  if (!parsed.success || !permitted.includes(parsed.data.kind))
    throw new LiekanError('导出参数无效', 400);
  const input = parsed.data;
  const query =
    input.kind === 'observations'
      ? parseObservationQuery(input.query)
      : ['performance', 'outcomes'].includes(input.kind)
        ? parsePerformanceQuery(input.query)
        : parseEvidenceQuery(input.query, input.kind === 'reconciliation');
  const reportResource = 'reportResource' in query ? query.reportResource : undefined;
  if (reportResource && input.kind !== 'evidence') throw new LiekanError('导出参数无效', 400);
  const reader = reportResource
    ? readReportEvidence
    : input.kind === 'evidence'
      ? readCrawlerEvidence
      : input.kind === 'reconciliation'
        ? readReconciliation
        : input.kind === 'observations'
          ? readObservations
          : input.kind === 'performance'
            ? readPerformance
            : input.kind === 'outcomes'
              ? readOutcomes
              : null;
  if (!reader) throw new LiekanError('导出类型不受支持', 400);
  const viewQuery = input.viewReportQuery ? parseReportQuery(input.viewReportQuery) : null;
  if (
    viewQuery &&
    (!viewQuery.success ||
      !reportResource ||
      viewQuery.data.resource !== reportResource ||
      (reportResource === 'ai/pages' &&
        ['botType', 'botId', 'botName'].some(key => viewQuery.data[key] !== query[key])) ||
      viewQuery.data.botProductForm !==
        ('botProductForm' in query ? query.botProductForm : undefined) ||
      viewQuery.data.botCategory !== ('botCategory' in query ? query.botCategory : undefined) ||
      viewQuery.data.startAt !== query.startAt ||
      viewQuery.data.endAt !== query.endAt ||
      viewQuery.data.timezone !== query.timezone ||
      viewQuery.data.crawlerMetricsVersion !== 1 ||
      viewQuery.data.crawlerIdentityScope !==
        ('crawlerIdentityScope' in query ? query.crawlerIdentityScope : undefined) ||
      viewQuery.data.filter !== ('logFilter' in query ? (query.logFilter ?? '') : '') ||
      viewQuery.data.search !== ('search' in query ? (query.search ?? '') : ''))
  )
    throw new LiekanError('页面统计条件与导出不一致，请重新读取', 409);
  const result = await queryEvidence(
    actor,
    websiteId,
    query,
    reportResource ? 'report-evidence' : input.kind,
    async (tx, id, conditions, evidence) => {
      if (evidence.policySnapshot !== input.policySnapshot)
        throw new LiekanError('统计条件已变化，请重新读取后导出', 409);
      const value = await reader(tx, id, conditions, evidence);
      if (viewQuery?.success) {
        let boundary: [Date, string] | undefined;
        if (viewQuery.data.cursor) {
          try {
            const encoded = JSON.parse(
              Buffer.from(viewQuery.data.cursor, 'base64url').toString('utf8'),
            );
            if (!/^[a-f0-9]{64}$/.test(encoded[2])) throw new Error();
            boundary = decodeCursor(viewQuery.data.cursor, encoded[2]);
          } catch {
            throw new LiekanError('日志游标无效', 400);
          }
        }
        if (warehouseEnabled()) {
          value.meta.pageComparisonSnapshot = await warehouseReportPageComparison(
            tx,
            id,
            viewQuery.data,
            evidence,
            'reportDisplay' in query && query.reportDisplay
              ? query.reportDisplay
              : { filter: '全部', sort: { label: '', direction: 1 }, search: '' },
            boundary,
            value[warehouseEvidenceRows],
          );
        } else {
          const page = await evidenceSnapshot(tx, async () =>
            attachReportEvidenceView(
              await buildReport(
                { id, name: evidence.access.name, domain: evidence.access.domain },
                false,
                viewQuery.data,
                true,
                false,
                boundary,
              ),
              viewQuery.data,
            ),
          );
          value.meta.pageComparisonSnapshot = createHash('sha256')
            .update(
              reportEvidenceViewPayload(
                page,
                'reportDisplay' in query && query.reportDisplay
                  ? query.reportDisplay
                  : { filter: '全部', sort: { label: '', direction: 1 }, search: '' },
              ),
            )
            .digest('hex');
        }
      }
      return value;
    },
    true,
    request.signal,
  );
  if (result.meta.policySnapshot !== input.policySnapshot)
    throw new LiekanError('统计条件已变化，请重新读取后导出', 409);
  const metadata = {
    ...result.meta,
    locale: input.locale,
    exportReadAt: result.meta.readAt,
    viewSnapshot: input.viewSnapshot ?? null,
    exportSnapshot: result.meta.snapshot,
    viewComparisonScope: viewQuery ? 'rendered_report' : 'complete_evidence',
    changed: input.viewSnapshot
      ? input.viewSnapshot !== (result.meta.pageComparisonSnapshot ?? result.meta.snapshot)
      : null,
  };
  if (warehouseEnabled())
    return warehouseEvidenceCsv(
      result,
      metadata,
      actor,
      websiteId,
      input.kind,
      input.locale,
      request,
    );
  const records: unknown[][] = [
    [
      input.locale === 'zh-CN' ? '导出说明' : 'Export metadata',
      JSON.stringify(sanitizeExportValue(metadata)),
    ],
  ];
  for (const [key, value] of Object.entries(JSON.parse(JSON.stringify(result)))) {
    if (key === 'meta' || key === 'outsideScope') continue;
    if (Array.isArray(value)) {
      if (value.length > EXPORT_MAX_ROWS) throw new LiekanError('导出行数超出上限', 413);
      if (!value.length) continue;
      const columns = Object.keys(value[0]);
      records.push([key, ...columns]);
      for (const row of value)
        records.push([
          key,
          ...columns.map(column =>
            typeof row[column] === 'object' && row[column] !== null
              ? JSON.stringify(sanitizeExportValue(row[column]))
              : row[column],
          ),
        ]);
    } else records.push([key, JSON.stringify(sanitizeExportValue(value))]);
  }
  if (records.length > EXPORT_MAX_ROWS) throw new LiekanError('导出行数超出上限', 413);
  let csv =
    '\ufeff' +
    records
      .map(row =>
        row
          .map(
            value =>
              '"' +
              String(safeCsvCell(sanitizeExportValue(value)) ?? '').replaceAll('"', '""') +
              '"',
          )
          .join(','),
      )
      .join('\r\n');
  if (reportResource)
    csv =
      '\ufeff' +
      records[0]
        .map(value => '"' + String(safeCsvCell(value) ?? '').replaceAll('"', '""') + '"')
        .join(',') +
      '\r\n' +
      reportEvidenceCsv(result, input.locale).replace(/^\ufeff/, '');
  if (Buffer.byteLength(csv) > EXPORT_MAX_BYTES) throw new LiekanError('导出文件超出上限', 413);
  if (request.signal.aborted) throw new LiekanError('导出已取消', 499);
  const current = await authenticateCrawler(request);
  if (current.id !== actor.id) throw new LiekanError('当前登录已失效', 401);
  await crawlerTransaction(tx => authorizeCrawler(tx, current, websiteId));
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="liekan-${input.kind}.csv"`,
      'Cache-Control': 'private, no-store',
      'X-Liekan-Export-Read-At': metadata.exportReadAt,
      'X-Liekan-Export-Changed': metadata.changed === null ? 'unknown' : String(metadata.changed),
    },
  });
}

export async function exportEvidence(...args: Parameters<typeof exportEvidenceSnapshot>) {
  const requested = args[3].headers.get('X-Liekan-Catalog-Version') || undefined;
  return withPublishedRegistry(async () => {
    let response: Response;
    try {
      response = await (warehouseEnabled()
        ? withWarehouseEvidenceResources(() =>
            withinWarehouseReport(async () => (response = await exportEvidenceSnapshot(...args))),
          )
        : exportEvidenceSnapshot(...args));
      response.headers.set('X-Liekan-Catalog-Version', getPublishedCatalog().version);
      return response;
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      throw error;
    }
  }, requested);
}
