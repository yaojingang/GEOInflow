import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { overviewVersionConflict } from '../contracts/query';
import { LiekanError } from './errors';
import type { LiekanReport, Row } from '../contracts/report';
import { applyReportPopulation } from '../contracts/population-results';
import {
  warehouseReportMetadata,
  warehouseReportCommand,
  warehouseControlFingerprint,
} from './warehouse-report-snapshot';
import { rankingCacheEnabled, readRankingCache, saveRankingCache } from './report-ranking-cache';

type RankingSink = { emit: (table: string, rows: Row[], locations?: unknown[]) => Promise<void> };
const sinks = new AsyncLocalStorage<RankingSink>();
export const capturingReportRankings = () => !!sinks.getStore();
export async function recordReportRanking(
  report: Pick<LiekanReport, 'meta'>,
  table: string,
  rows: Row[],
  locations?: unknown[],
) {
  if (!sinks.getStore()) return;
  const qualified = applyReportPopulation(
    { meta: report.meta, cards: [], tables: { [table]: rows }, charts: {} } as LiekanReport,
    report.meta.population,
  );
  await sinks.getStore().emit(table, qualified.tables[table], locations);
}
export type ReportRankingArtifact = {
  build: string;
  counts: Record<string, number>;
  totals?: Record<string, number>;
  pending?: boolean;
  round?: string;
};
export function rankingPageReady(
  artifact: ReportRankingArtifact,
  table: string,
  page: number,
  size: number,
  total: number,
) {
  return (artifact.counts[table] ?? -1) >= Math.min(total, page * size);
}
/** Bounded batches append to an unpublished build. The report CAS publishes the
 * build pointer only after all rows and the report have passed their controls. */
export async function captureReportRankings<T>(
  site: string,
  snapshot: string,
  work: () => Promise<T>,
  options: { previous?: ReportRankingArtifact; round?: string; byteBudget?: number } = {},
) {
  const previous = options.previous;
  if (previous && (!options.round || previous.round !== options.round))
    throw new Error('warehouse-ranking-resume-boundary');
  const build = previous?.build ?? randomUUID(),
    counts: Record<string, number> = { ...previous?.counts },
    totals: Record<string, number> = {};
  // Only a durable protected round can yield and resume. Other jobs still write
  // bounded chunks, without a cumulative result-size quota.
  const budget = options.round ? (options.byteBudget ?? 128 * 1024 * 1024) : Infinity;
  let bytes = 0;
  await warehouseReportMetadata(site);
  const value = await sinks.run(
    {
      emit: async (table, rows, locations) => {
        if (!/^[a-zA-Z]+$/.test(table)) throw new Error('warehouse-ranking-table-invalid');
        const start = totals[table] ?? 0;
        totals[table] = start + rows.length;
        counts[table] ??= 0;
        for (let i = Math.max(0, counts[table] - start); i < rows.length; ) {
          const offset = start + i;
          if (offset !== counts[table] || bytes >= budget) break;
          const payload: { ordinal: number; row: string; geography: string | null }[] = [];
          let chunkBytes = 0;
          while (i < rows.length && payload.length < 500) {
            const item = {
              ordinal: start + i,
              row: JSON.stringify(rows[i]),
              geography: locations?.[i] === undefined ? null : JSON.stringify(locations[i]),
            };
            const size = Buffer.byteLength(JSON.stringify(item));
            if (payload.length && chunkBytes + size > 1024 * 1024) break;
            payload.push(item);
            chunkBytes += size;
            i++;
          }
          bytes += chunkBytes;
          await warehouseReportCommand(
            site,
            `INSERT INTO warehouse_report_rank_v1 (website_id,epoch,snapshot,build,table_name,ordinal,row,geography)
        SELECT {wh_site:UUID},{wh_epoch:UInt64},{rankSnapshot:UUID},{rankBuild:UUID},{rankTable:String},r.1,r.2,r.3
        FROM (SELECT arrayJoin(arrayZip({rankOrdinals:Array(UInt64)},{rankRows:Array(String)},{rankLocations:Array(Nullable(String))})) AS r)`,
            {
              rankSnapshot: snapshot,
              rankBuild: build,
              rankTable: table,
              rankOrdinals: payload.map(r => r.ordinal),
              rankRows: payload.map(r => r.row),
              rankLocations: payload.map(r => r.geography),
            },
            55,
          );
          counts[table] = offset + payload.length;
        }
        counts[table] ??= 0;
      },
    },
    work,
  );
  if (
    previous &&
    JSON.stringify(Object.entries(totals).sort()) !==
      JSON.stringify(Object.entries(previous.totals ?? previous.counts).sort())
  )
    throw new Error('warehouse-ranking-resume-mismatch');
  const pending = Object.entries(totals).some(([table, total]) => counts[table] !== total);
  return {
    value,
    rankings: {
      build,
      counts,
      totals,
      pending,
      ...(options.round ? { round: options.round } : {}),
    },
  };
}

export async function readReportRanking(
  site: string,
  snapshot: string,
  artifact: ReportRankingArtifact,
  table: string,
  page: number,
  pageSize: number,
  total: number,
  cache = true,
) {
  if (
    (artifact.totals?.[table] ?? artifact.counts[table]) !== total ||
    !rankingPageReady(artifact, table, page, pageSize, total)
  )
    throw new Error('warehouse-ranking-incomplete');
  const scope = await rankingScope(site, snapshot, artifact, table, total);
  if (cache) {
    const hit = await readRankingCache(scope, page, pageSize);
    if (hit) return hit;
  }
  const { warehouseReportQuery } = await import('./warehouse-report-snapshot');
  const offset = (page - 1) * pageSize;
  const rows = await warehouseReportQuery<{
    ordinal: string;
    row: string;
    geography: string | null;
    variants: number | string;
  }>(
    site,
    `SELECT ordinal,any(r.row) AS row,any(r.geography) AS geography,uniqExact(tuple(r.row,r.geography)) AS variants FROM warehouse_report_rank_v1 r
    WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND snapshot={rankSnapshot:UUID}
      AND build={rankBuild:UUID} AND table_name={rankTable:String} AND ordinal>={rankOffset:UInt64}
      AND ordinal<{rankEnd:UInt64} GROUP BY ordinal ORDER BY ordinal`,
    {
      rankSnapshot: snapshot,
      rankBuild: artifact.build,
      rankTable: table,
      rankOffset: String(offset),
      rankEnd: String(Math.min(Number.MAX_SAFE_INTEGER, offset + pageSize)),
    },
  );
  if (
    rows.length !== Math.max(0, Math.min(pageSize, total - offset)) ||
    rows.some((r, i) => Number(r.ordinal) !== offset + i || Number(r.variants) !== 1)
  )
    throw new LiekanError('总览快照已更新，请重新读取第一页', 409, overviewVersionConflict);
  const value = {
    rows: rows.map(r => JSON.parse(r.row) as Row),
    geography: rows.map(r => (r.geography ? JSON.parse(r.geography) : null)),
  };
  if (cache) await saveRankingCache(scope, page, pageSize, value);
  return value;
}

async function rankingScope(
  site: string,
  snapshot: string,
  artifact: ReportRankingArtifact,
  table: string,
  total: number,
) {
  const metadata = await warehouseReportMetadata(site);
  return {
    boundary: metadata.boundary,
    control: warehouseControlFingerprint(metadata),
    snapshot,
    build: artifact.build,
    table,
    total,
  };
}

/** Read back and verify the first three pages together before publishing the
 * pointer. Cache failure is optional; incomplete/conflicting CH rows still fail
 * verification. The normal publication CAS and every read's fences stay intact. */
export async function prefillReportRankings(
  site: string,
  snapshot: string,
  artifact: ReportRankingArtifact,
  pages: LiekanReport['meta']['tablePages'],
) {
  if (!rankingCacheEnabled()) return;
  for (const [table, paging] of Object.entries(pages ?? {})) {
    if (!paging.total || paging.pageSize > 100 || !artifact.counts[table]) continue;
    const size = paging.pageSize,
      total = paging.total;
    const pageCount = Math.min(
      3,
      Math.ceil(total / size),
      Math.floor(artifact.counts[table] / size) +
        (artifact.counts[table] === total && total % size ? 1 : 0),
    );
    if (!pageCount) continue;
    const all = await readReportRanking(
      site,
      snapshot,
      artifact,
      table,
      1,
      size * pageCount,
      total,
      false,
    );
    const scope = await rankingScope(site, snapshot, artifact, table, total);
    for (let page = 1; page <= pageCount; page++) {
      const offset = (page - 1) * size;
      await saveRankingCache(scope, page, size, {
        rows: all.rows.slice(offset, offset + size),
        geography: all.geography.slice(offset, offset + size),
      });
    }
  }
}
