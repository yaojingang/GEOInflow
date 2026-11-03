import { createHash } from 'node:crypto';
import { selectRows } from '@/components/liekan/data';
import { pageUrl } from '../contracts/page-url';
import { tablePageSize, type ReportQuery } from '../contracts/query';
import type { EvidenceInputs } from '../crawlers/evidence-read';
import { reportLogRange, reportLogRow } from '../report-log-tables';
import type { AiTx } from './ai-db';
import type { WarehouseEvidenceRows } from './warehouse-evidence-table';
import { warehouseEvidenceSignal } from './warehouse-evidence-queries';
import { warehouseLogFacts } from './warehouse-log-queries';
import { warehouseReportEvidence } from './warehouse-report-evidence';
import { withinWarehouseReport } from './warehouse-report-snapshot';

type Display = { filter: string; sort: { label: string; direction?: number }; search: string };
const neutral = { filter: '全部', sort: { label: '', direction: 1 }, search: '' };

/** Byte-for-byte JSON.stringify shape used by reportEvidenceViewPayload. Only
 * the rows array is streamed; no digest substitutes for its original bytes. */
export async function hashReportEvidenceViewRows(
  metadata: {
    query: Record<string, unknown>;
    policySnapshot: string;
    display: Display;
    table: string;
    totalLogs?: number;
    tablePage?: { page: number; pageSize: number; total: number };
  },
  produce: (emit: (row: any) => void) => Promise<void>,
) {
  const { totalLogs, tablePage, ...prefix } = metadata;
  const hash = createHash('sha256');
  hash.update(JSON.stringify(prefix).slice(0, -1) + ',"rows":[');
  let first = true;
  await produce(row => {
    hash.update((first ? '' : ',') + JSON.stringify(row));
    first = false;
  });
  const tail = JSON.stringify({ totalLogs, tablePage });
  hash.update(']' + (tail === '{}' ? '}' : ',' + tail.slice(1)));
  return hash.digest('hex');
}

/** Compare exactly the original rendered report without rebuilding unrelated
 * cards/charts or retaining all facts. Pages slice before display selection;
 * botBody historically renders all rows, so its original JSON is hashed as a stream. */
export async function warehouseReportPageComparison(
  tx: AiTx,
  site: string,
  p: ReportQuery,
  evidence: EvidenceInputs,
  display: Display,
  boundary?: [Date, string],
  completeTable?: WarehouseEvidenceRows,
) {
  return withinWarehouseReport(async () => {
    const { start, end, readEndAt } = reportLogRange(p);
    const effective = { ...p, endAt: readEndAt };
    const reusable = readEndAt === p.endAt ? completeTable : undefined;
    const { refresh: _refresh, ...conditions } = p;
    const query = { ...conditions, startAt: p.startAt, endAt: readEndAt, timezone: p.timezone };
    const normalized = {
      filter: display.filter,
      sort: { label: display.sort.label, direction: display.sort.direction ?? 1 },
      search: display.search,
    };
    // attachReportEvidenceView predates the warehouse control fingerprint. Keep
    // its original policy JSON field order and the already-fenced catalog hash.
    const baseline = evidence.baseline;
    const policySnapshot = createHash('sha256')
      .update(
        JSON.stringify({
          catalog: baseline.catalog,
          registryVersion: baseline.registryVersion,
          populationVersion: baseline.populationVersion,
          policy: baseline.policy,
          epoch: baseline.epoch,
          metricVersion: baseline.metricVersion,
          historyRepair: baseline.historyRepair || { generation: null, revision: '0' },
        }),
      )
      .digest('hex');
    const table = { 'ai/bots': 'botBody', 'ai/pages': 'apBody', logs: 'logBody' }[p.resource];
    const metadata = { query, policySnapshot, display: normalized, table };
    const signal = warehouseEvidenceSignal();
    if (p.resource === 'logs') {
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
        ['recent', 'count'],
        p,
        false,
        boundary,
      );
      const rows = logs.recent.map(row => reportLogRow(JSON.parse(JSON.stringify(row))));
      const selected = selectRows(
        rows,
        normalized.filter,
        normalized.sort,
        table,
        normalized.search,
        value => pageUrl(value, evidence.access.domain),
      );
      return hashReportEvidenceViewRows({ ...metadata, totalLogs: logs.totalLogs }, async emit => {
        for (const row of selected) emit(row);
      });
    }
    if (p.resource === 'ai/pages') {
      const isNeutral =
        normalized.filter === '全部' && normalized.sort.label === '' && normalized.search === '';
      const source =
        reusable && isNeutral
          ? reusable
          : (await warehouseReportEvidence(tx, site, effective, neutral, evidence.access.domain))
              .source;
      const page = p.tablePages.apBody ?? 1;
      const rows = await source.page((page - 1) * tablePageSize, tablePageSize);
      const selected = selectRows(
        rows,
        normalized.filter,
        normalized.sort,
        table,
        normalized.search,
        value => pageUrl(value, evidence.access.domain),
      );
      return hashReportEvidenceViewRows(
        { ...metadata, tablePage: { page, pageSize: tablePageSize, total: await source.count() } },
        async emit => {
          for (const row of selected) emit(row);
        },
      );
    }
    const source =
      reusable ??
      (await warehouseReportEvidence(tx, site, effective, normalized, evidence.access.domain))
        .source;
    return hashReportEvidenceViewRows(metadata, emit =>
      source.stream(async rows => {
        for (const row of rows) emit(row);
      }, signal),
    );
  });
}
