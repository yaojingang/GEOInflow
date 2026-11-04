import { compareReportAiPages } from '../report-log-tables';
import { warehouseReader } from '../warehouse/reader-runtime';
import {
  type EvidenceProducer,
  type SpoolRows,
  WarehouseEvidenceSpool,
} from './warehouse-evidence-spool';

const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export async function streamWarehouseCatalogPaths(
  site: string,
  emit: (row: { path: string }) => Promise<void>,
) {
  let after: string | null = null;
  for (;;) {
    const rows = await warehouseReader().db.read<{ path: string }>(
      'SELECT path FROM liekan_catalog WHERE website_id=$1::uuid AND ($2::text IS NULL OR path>$2) ORDER BY path LIMIT 1000',
      [site, after],
    );
    if (!rows.length) return;
    for (const row of rows) await emit(row);
    after = rows.at(-1).path;
  }
}

/** Exact global cards and directory chart with request-owned external sorting.
 * pages is path-sorted; catalog order remains the original PostgreSQL order. */
export async function summarizeWarehousePagePaths(
  spool: WarehouseEvidenceSpool,
  pages: SpoolRows<any>,
  produceCatalog: EvidenceProducer<{ path: string }>,
) {
  let pageCount = 0,
    repeated = 0,
    depthTotal = 0,
    depthCount = 0,
    maximum = 0;
  const directoryInputs = await spool.sort<any>(
    async emit => {
      for await (const page of pages.iterate()) {
        pageCount++;
        if (page.requests >= 50) repeated++;
        maximum = Math.max(maximum, page.requests);
        if (page.catalog?.linkDepth != null) {
          depthTotal += Number(page.catalog.linkDepth);
          depthCount++;
        }
        await emit({
          directory: `/${page.path.split('/').filter(Boolean)[0] ?? ''}/`,
          path: page.path,
          requests: page.requests,
        });
      }
    },
    (a, b) => lexical(a.directory, b.directory),
  );
  const directories = await spool.sort<any>(
    async emit => {
      let current: any;
      for await (const row of directoryInputs.iterate()) {
        if (current && current.directory !== row.directory) {
          await emit(current);
          current = undefined;
        }
        current ??= { directory: row.directory, count: 0, leader: row };
        current.count += row.requests;
        if (compareReportAiPages(row, current.leader) < 0) current.leader = row;
      }
      if (current) await emit(current);
    },
    (a, b) => b.count - a.count || compareReportAiPages(a.leader, b.leader),
  );
  await directoryInputs.remove();
  const topDirectories = (await directories.page(0, 10)).map(({ directory, count }) => ({
    name: directory,
    count,
  }));
  await directories.remove();
  let catalogCount = 0;
  const catalog = await spool.sort<any>(
    async emit => {
      await produceCatalog(async row => {
        await emit({ ...row, ordinal: catalogCount++ });
      });
    },
    (a, b) => lexical(a.path, b.path),
  );
  const iterator = pages.iterate();
  let candidate = await iterator.next();
  let covered = 0;
  let blind: SpoolRows<any>;
  try {
    blind = await spool.sort<any>(
      async emit => {
        for await (const row of catalog.iterate()) {
          while (!candidate.done && lexical(candidate.value.path, row.path) < 0)
            candidate = await iterator.next();
          if (!candidate.done && candidate.value.path === row.path) covered++;
          else await emit({ path: row.path, ordinal: row.ordinal });
        }
      },
      (a, b) => a.ordinal - b.ordinal,
    );
  } finally {
    await iterator.return(undefined);
  }
  await catalog.remove();
  return {
    pageCount,
    repeated,
    depthTotal,
    depthCount,
    maximum,
    catalogCount,
    covered,
    topDirectories,
    blind,
  };
}
