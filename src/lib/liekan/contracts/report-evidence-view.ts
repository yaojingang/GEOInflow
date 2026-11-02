import { selectRows } from '@/components/liekan/data';
import { pageUrl } from './page-url';
import type { LiekanReport } from './report';

/** Shared browser/server projection of the displayed table and its pagination totals. */
export function reportEvidenceViewPayload(
  report: LiekanReport,
  display: {
    filter: string;
    sort: { label: string; direction?: number };
    search: string;
  },
) {
  const view = report.meta.crawlerEvidenceView;
  const normalized = {
    filter: display.filter,
    sort: { label: display.sort.label, direction: display.sort.direction ?? 1 },
    search: display.search,
  };
  const table = { 'ai/bots': 'botBody', 'ai/pages': 'apBody', logs: 'logBody' }[
    String(view.query.resource)
  ];
  const payload = {
    query: view.query,
    policySnapshot: view.policySnapshot,
    display: normalized,
    table,
    rows: selectRows(
      report.tables[table] || [],
      display.filter,
      normalized.sort,
      table,
      display.search,
      value => pageUrl(value, report.website.domain),
    ),
    totalLogs: report.meta.totalLogs,
    tablePage: report.meta.tablePages?.[table],
  };
  // PostgreSQL JSONB can reorder object keys; the evidence keeps displayed array order.
  return JSON.stringify(payload, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(key => [key, value[key]]),
        )
      : value,
  );
}
