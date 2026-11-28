import { warehouseReader } from '../warehouse/reader-runtime';
import { rowMatchesSelection, rowSelectionComparator } from '@/components/liekan/data';
import { pageUrl } from '../contracts/page-url';
import { parseReportQuery } from '../contracts/query';
import {
  addReportAiPage,
  compareReportAiPages,
  reportAiPageRow,
  reportBotRow,
  reportLogRange,
  reportLogRow,
} from '../report-log-tables';
import type { AiTx } from './ai-db';
import { LiekanError } from './errors';
import { WarehouseEvidenceSpool, type SpoolRows } from './warehouse-evidence-spool';
import { warehouseEvidenceSignal } from './warehouse-evidence-queries';
import { registerWarehouseEvidenceRows } from './warehouse-evidence-table';
import {
  warehouseLogDate,
  warehouseLogDetailColumns,
  warehouseLogDetailRow,
  warehouseLogQuerySpec,
  warehouseNumbers,
} from './warehouse-log-queries';
import { warehouseReportStream } from './warehouse-report-snapshot';
import {
  streamWarehouseCatalogPaths,
  summarizeWarehousePagePaths,
} from './warehouse-page-path-summary';

const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const identity = (row: any) => JSON.stringify([row.name ?? row.bot, row.botId ?? null]);
const completeIdentity = (row: any) =>
  JSON.stringify([row.name, row.vendor, row.type, row.botId ?? null]);
const serializable = (row: any) => JSON.parse(JSON.stringify(row));

/** Bounded lookups keep the business catalog in PG, without loading it into
 * either a JS Map or a ClickHouse Array parameter for the complete report.
 * The surrounding publication reference fences catalogRevision at completion;
 * these batched reads must not enter warehouseControlRead's small replay log. */
async function withCatalog(
  site: string,
  rows: any[],
  consume: (row: any, catalog: any) => Promise<void>,
) {
  for (let offset = 0; offset < rows.length; offset += 256) {
    const batch = rows.slice(offset, offset + 256);
    const catalog = await warehouseReader().db.read<any>(
      'SELECT path,title,content_type AS type,content_updated_at AS "updatedAt",link_depth AS "linkDepth" FROM liekan_catalog WHERE website_id=$1::uuid AND path=ANY($2::text[])',
      [site, [...new Set(batch.map(row => row.path))]],
    );
    const byPath = new Map(catalog.map(row => [row.path, row]));
    for (const row of batch) await consume(row, byPath.get(row.path));
  }
}

// Both inputs are disk-sorted by the exact same identity. No hash map grows with
// bot names, vendors, paths or prior-period groups.
async function* leftJoin(left: SpoolRows<any>, right: SpoolRows<any>, key: (row: any) => string) {
  const iterator = right.iterate();
  let candidate = await iterator.next();
  try {
    for await (const row of left.iterate()) {
      const wanted = key(row);
      while (!candidate.done && lexical(key(candidate.value), wanted) < 0)
        candidate = await iterator.next();
      yield [
        row,
        !candidate.done && key(candidate.value) === wanted ? candidate.value : null,
      ] as const;
    }
  } finally {
    await iterator.return(undefined);
  }
}

export async function warehouseReportEvidence(
  _tx: AiTx,
  site: string,
  raw: unknown,
  display: any,
  domain: string,
  options: { pageSummary?: boolean; longRunning?: boolean } = {},
) {
  const parsed = parseReportQuery(raw);
  if (!parsed.success) throw new LiekanError('统计参数无效');
  const p = parsed.data;
  const { start, end, readEndAt, days } = reportLogRange(p);
  const table = {
    logs: 'logBody',
    'ai/pages': 'apBody',
    'ai/overview': 'apBody',
    'ai/bots': 'botBody',
  }[p.resource];
  if (!table) throw new LiekanError('统计参数无效');
  const signal = warehouseEvidenceSignal();
  const spool = await WarehouseEvidenceSpool.create(signal);
  try {
    const spec = await warehouseLogQuerySpec(
      start,
      end,
      p.timezone,
      p,
      p.filter,
      p.search,
      p.resource === 'ai/bots',
      site,
    );
    const stream = (sql: string, consume: (rows: any[]) => Promise<void>, params = spec.params) =>
      warehouseReportStream<any>(
        site,
        sql,
        params,
        rows => consume(warehouseNumbers(rows)),
        signal,
        options.longRunning ?? true,
      );
    const matches = (row: any) =>
      rowMatchesSelection(row, display.filter, table, display.search, value =>
        pageUrl(value, domain),
      );
    const compare = rowSelectionComparator(display.filter, display.sort, table);
    let result: SpoolRows<any>;
    let pageSummary: Awaited<ReturnType<typeof summarizeWarehousePagePaths>> | undefined;
    if (p.resource === 'logs') {
      result = await spool.sort(async emit => {
        await stream(
          `SELECT ${warehouseLogDetailColumns(spec.ai)} ${spec.detailBase} ORDER BY created_at DESC,id DESC`,
          async rows => {
            for (const input of rows) {
              const row = reportLogRow(serializable(warehouseLogDetailRow(input)));
              if (matches(row)) await emit(row);
            }
          },
        );
      }, compare);
    } else if (table === 'apBody') {
      // Path aggregation is done in a sorted stream; only the current path's two
      // leaders and counters are retained, regardless of how many bots hit it.
      const inputs = await spool.sort<any>(
        async emit => {
          await stream(spec.statements.pages, rows =>
            withCatalog(site, rows, async (row, catalog) => {
              await emit({
                ...row,
                lastCrawled: warehouseLogDate(row.lastCrawled)?.toISOString() ?? null,
                catalog,
              });
            }),
          );
        },
        (a, b) => lexical(a.path, b.path),
      );
      let maximum = 0;
      const pages = await spool.write<any>(async emit => {
        let current: any, catalog: any;
        const flush = async () => {
          if (!current) return;
          maximum = Math.max(maximum, current.requests);
          await emit({ ...current, catalog });
        };
        for await (const row of inputs.iterate()) {
          if (current && current.path !== row.path) {
            await flush();
            current = undefined;
          }
          catalog = row.catalog;
          current = addReportAiPage(current, row);
        }
        await flush();
      });
      await inputs.remove();
      if (options.pageSummary)
        pageSummary = await summarizeWarehousePagePaths(spool, pages, emit =>
          streamWarehouseCatalogPaths(site, emit),
        );
      result = await spool.sort(
        async emit => {
          for await (const page of pages.iterate()) {
            const row = reportAiPageRow(page, page.catalog, maximum, readEndAt);
            if (matches(row)) await emit(row);
          }
        },
        (a, b) => compare(a, b) || compareReportAiPages(a, b),
      );
      await pages.remove();
    } else {
      // Previous totals and preference contributions may themselves have high
      // cardinality. External merge joins preserve the original report mapping.
      const previous = await spool.sort<any>(
        async emit => {
          await stream(
            spec.botQuery,
            async rows => {
              for (const row of rows) await emit(row);
            },
            spec.previousParams,
          );
        },
        (a, b) => lexical(completeIdentity(a), completeIdentity(b)),
      );
      let ordinal = 0;
      const current = await spool.sort<any>(
        async emit => {
          await stream(spec.botQuery, async rows => {
            for (const row of rows)
              await emit({
                ...row,
                ordinal: ordinal++,
                lastVisit: warehouseLogDate(row.lastVisit)?.toISOString() ?? null,
              });
          });
        },
        (a, b) => lexical(completeIdentity(a), completeIdentity(b)),
      );
      const bots = await spool.sort<any>(
        async emit => {
          for await (const [row, old] of leftJoin(current, previous, completeIdentity))
            await emit({ ...row, previous: old?.requests });
        },
        (a, b) => lexical(identity(a), identity(b)),
      );
      await current.remove();
      await previous.remove();
      const totals = await spool.write<any>(async emit => {
        let current: any;
        for await (const row of bots.iterate()) {
          if (current && identity(current) !== identity(row)) {
            await emit(current);
            current = undefined;
          }
          current ??= { name: row.name, botId: row.botId, total: 0 };
          current.total += row.requests;
        }
        if (current) await emit(current);
      });
      const contributions = await spool.sort<any>(
        async emit => {
          await stream(spec.statements.pages, rows =>
            withCatalog(site, rows, async (row, catalog) => {
              if (catalog?.type)
                await emit({
                  name: row.bot,
                  botId: row.botId,
                  type: catalog.type,
                  requests: row.requests,
                });
            }),
          );
        },
        (a, b) => lexical(identity(a), identity(b)) || lexical(a.type, b.type),
      );
      const preferences = await spool.write<any>(async emit => {
        let current: any,
          winner: any,
          type = '',
          requests = 0;
        const choose = () => {
          if (!current) return;
          if (
            !winner ||
            requests > winner.requests ||
            (requests === winner.requests && type.localeCompare(winner.type) < 0)
          )
            winner = { type, requests };
        };
        const flush = async () => {
          choose();
          if (current) await emit({ name: current.name, botId: current.botId, ...winner });
        };
        for await (const row of contributions.iterate()) {
          if (current && identity(current) !== identity(row)) {
            await flush();
            current = undefined;
            winner = undefined;
            requests = 0;
          }
          if (current && type !== row.type) {
            choose();
            requests = 0;
          }
          current = row;
          type = row.type;
          requests += row.requests;
        }
        await flush();
      });
      await contributions.remove();
      const enriched = await spool.write<any>(async emit => {
        for await (const [row, total] of leftJoin(bots, totals, identity))
          await emit({ ...row, total: total?.total ?? 0 });
      });
      await bots.remove();
      await totals.remove();
      const selected = await spool.sort<any>(
        async emit => {
          for await (const [row, top] of leftJoin(enriched, preferences, identity)) {
            const preference =
              top && row.total
                ? `${top.type}（${Math.round((top.requests / row.total) * 10000) / 100}% 抓取集中）`
                : null;
            const mapped = reportBotRow(row, days, preference, row.previous);
            if (matches(mapped)) await emit({ row: mapped, ordinal: row.ordinal });
          }
        },
        (a, b) => compare(a.row, b.row) || a.ordinal - b.ordinal,
      );
      await enriched.remove();
      await preferences.remove();
      result = await spool.write(async emit => {
        for await (const value of selected.iterate()) await emit(value.row);
      });
      await selected.remove();
    }
    return {
      table,
      pageSummary,
      source: registerWarehouseEvidenceRows({
        count: () => result.count(),
        fingerprint: (signal?: AbortSignal) => result.fingerprint(signal),
        page: (offset, limit) => result.page(offset, limit),
        stream: (consume, signal?: AbortSignal) => result.stream(consume, signal),
        dispose: () => spool.dispose(),
      }),
    };
  } catch (error) {
    await spool.dispose();
    throw error;
  }
}
