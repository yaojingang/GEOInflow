import { getPublishedCatalog } from '../crawlers/published';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';
import { createHash } from 'node:crypto';
import type { LiekanReport } from '../contracts/report';
import type { ReportQuery } from '../contracts/query';
import { CRAWLER_METRIC_VERSION } from '../contracts/crawler-metrics';
import { query } from './server';
import { reportEvidenceViewPayload } from '../contracts/report-evidence-view';
import { warehouseEnabled } from '../warehouse/runtime';
import { warehouseEvidenceCatalog } from './warehouse-evidence-catalog';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Capture the actual page inside its read transaction, including its original cursor. */
export async function attachReportEvidenceView(report: LiekanReport, p: ReportQuery) {
  if (p.crawlerMetricsVersion !== 1 || !['ai/bots', 'ai/pages', 'logs'].includes(p.resource))
    return report;
  const [catalog, policies, states, repairs] = await Promise.all([
    warehouseEnabled()
      ? warehouseEvidenceCatalog(report.website.id)
      : query(
          'SELECT path,updated_at AS "updatedAt" FROM liekan_catalog WHERE website_id=$1::uuid ORDER BY path',
          report.website.id,
        ),
    query(
      'SELECT mode,revision::text,allowed_hostnames FROM liekan_collection_policy WHERE website_id=$1::uuid',
      report.website.id,
    ),
    query('SELECT epoch FROM liekan_log_state WHERE website_id=$1::uuid', report.website.id),
    query(
      'SELECT active_generation::text AS generation,active_revision::text AS revision FROM liekan_history_repair_run WHERE website_id=$1::uuid',
      report.website.id,
    ),
  ]);
  const policySnapshot = hash({
    catalog: Array.isArray(catalog) ? hash(catalog) : catalog.hash,
    registryVersion: getPublishedCatalog()?.version ?? null,
    populationVersion: TRAFFIC_POLICY_VERSION,
    policy: policies[0] || { mode: 'standard', revision: '0' },
    epoch: states[0]?.epoch ?? 1,
    metricVersion: CRAWLER_METRIC_VERSION,
    historyRepair: repairs[0] || { generation: null, revision: '0' },
  });
  const { refresh: _refresh, ...conditions } = p;
  report.meta.crawlerEvidenceView = {
    query: { ...conditions, ...report.range },
    policySnapshot,
    snapshot: '',
  };
  report.meta.crawlerEvidenceView.snapshot = createHash('sha256')
    .update(
      reportEvidenceViewPayload(report, {
        filter: '全部',
        sort: { label: '', direction: 1 },
        search: '',
      }),
    )
    .digest('hex');
  return report;
}
