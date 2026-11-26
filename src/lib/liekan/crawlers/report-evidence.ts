import { warehouseEnabled } from '../warehouse/authority-routing';
import { warehouseReportEvidence } from '../upstream/warehouse-report-evidence';
import { warehouseEvidenceRows } from '../upstream/warehouse-evidence-table';
import { buildReport } from '../report';
import { pageUrl } from '../contracts/page-url';
import { evidenceSnapshot } from './evidence-snapshot';
import { tableCsv, selectRows } from '@/components/liekan/data';
import { metricLabel } from '../i18n/text';
import { sanitizeExportValue } from '../contracts/exports';
import type { LiekanLocale } from '../i18n/locale';
import { evidenceMeta, enforceEvidenceBudget, type EvidenceReader } from './evidence-read';

export const readReportEvidence: EvidenceReader = async (tx, websiteId, p, input) => {
  const query = {
    startAt: p.startAt,
    endAt: p.endAt,
    timezone: p.timezone,
    crawlerIdentityScope: p.crawlerIdentityScope,
    crawlerMetricsVersion: 1,
    resource: p.reportResource,
    ...(p.reportResource === 'ai/pages'
      ? {
          botType: p.botType,
          botId: p.botId,
          botName: p.botName,
          botProductForm: p.botProductForm,
          botCategory: p.botCategory,
        }
      : p.reportResource === 'ai/bots'
        ? { botProductForm: p.botProductForm, botCategory: p.botCategory }
        : {}),
    filter: p.logFilter ?? '',
    search: p.reportResource === 'logs' ? (p.search ?? '') : '',
  };
  const display = p.reportDisplay ?? {
    filter: '全部',
    sort: { label: '', direction: 1 },
    search: '',
  };
  if (warehouseEnabled()) {
    const { table, source } = await warehouseReportEvidence(
      tx,
      websiteId,
      query,
      display,
      input.access.domain,
    );
    return { meta: evidenceMeta(p, input), rows: [], table, [warehouseEvidenceRows]: source };
  }
  const report = await evidenceSnapshot(tx, () =>
    buildReport(
      { id: websiteId, name: input.access.name, domain: input.access.domain },
      false,
      query,
      true,
      true,
    ),
  );
  const table = { 'ai/bots': 'botBody', 'ai/pages': 'apBody', logs: 'logBody' }[p.reportResource];
  const rows = report.tables[table] || [];
  enforceEvidenceBudget(rows, p.reportResource === 'logs' ? report.meta.totalLogs : rows.length);
  const path = (value: unknown) => pageUrl(value, input.access.domain);
  return {
    meta: evidenceMeta(p, input),
    rows: selectRows(rows, display.filter, display.sort, table, display.search, path),
    table,
  };
};

export function reportEvidenceCsv(result: any, locale: LiekanLocale) {
  return tableCsv(
    result.table,
    sanitizeExportValue(JSON.parse(JSON.stringify(result.rows))) as any,
    '全部',
    { label: '', direction: 1 },
    '',
    undefined,
    locale,
    source => metricLabel(source, 'pageviews', locale),
  );
}
