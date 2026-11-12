import { createHash } from 'node:crypto';
import { CRAWLER_METRIC_VERSION } from '../contracts/crawler-metrics';
import type { ReportQuery } from '../contracts/query';
import type { LiekanReport } from '../contracts/report';
import { reportEvidenceViewPayload } from '../contracts/report-evidence-view';
import { getPublishedCatalog } from '../crawlers/published';
import { query } from './server';
import { TRAFFIC_POLICY_VERSION } from './traffic-query';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Capture the actual page inside its read transaction, including its original cursor. */
export async function attachReportEvidenceView(report: LiekanReport, p: ReportQuery) {
  if (p.crawlerMetricsVersion !== 1 || !['ai/bots', 'ai/pages', 'logs'].includes(p.resource))
    return report;
  const policySnapshot = await reportEvidencePolicy(report.website.id);
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

export async function reportEvidencePolicy(websiteId: string) {
  const [catalog, policies, states, repairs] = await Promise.all([
    query(
      'SELECT path,updated_at AS "updatedAt" FROM liekan_catalog WHERE website_id=$1::uuid ORDER BY path',
      websiteId,
    ),
    query(
      'SELECT mode,revision::text,allowed_hostnames FROM liekan_collection_policy WHERE website_id=$1::uuid',
      websiteId,
    ),
    query('SELECT epoch FROM liekan_log_state WHERE website_id=$1::uuid', websiteId),
    query(
      'SELECT active_generation::text AS generation,active_revision::text AS revision FROM liekan_history_repair_run WHERE website_id=$1::uuid',
      websiteId,
    ),
  ]);
  return hash({
    catalog: hash(catalog),
    registryVersion: getPublishedCatalog()?.version ?? null,
    populationVersion: TRAFFIC_POLICY_VERSION,
    policy: policies[0] || { mode: 'standard', revision: '0' },
    epoch: states[0]?.epoch ?? 1,
    metricVersion: CRAWLER_METRIC_VERSION,
    historyRepair: repairs[0] || { generation: null, revision: '0' },
  });
}
