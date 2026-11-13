import { createHash } from 'node:crypto';
import {
  addKeywordCandidate,
  type KeywordCandidate,
  type KeywordConditions,
  type KeywordRow,
  keywordConditionsSchema,
  selectKeywords,
  supportsKeywordRedirect,
} from '../contracts/keywords';
import { warehouseBrowserParameters, warehouseVisitsSQL } from './warehouse-browser-queries';
import {
  type EvidenceProducer,
  type SpoolRows,
  WarehouseEvidenceSpool,
} from './warehouse-evidence-spool';
import { warehouseReportStream, withinWarehouseReport } from './warehouse-report-snapshot';

const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const percent = (n: number, d: number) => (d ? Math.round((n / d) * 10000) / 100 : null);
const metrics = ['sessions', 'bounces', 'conversions'] as const;
type SelectionQuery = Partial<KeywordConditions> & { keywordStatusVersion?: string };
export type WarehouseKeywordSelection = {
  rows: SpoolRows<KeywordRow>;
  hasGoals: boolean;
  snapshot: string;
  readAt: number;
  engines: string[];
  total: number;
  referrer: number;
  utm: number;
  availability: number | null;
  dispose(): Promise<void>;
};
const add = (a: number, b: number) => {
  const value = a + b;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('warehouse-keyword-counter-out-of-range');
  return value;
};
// Match selectKeywords' null-last ordering and deterministic identity tie break.
function keywordOrder(conditions: KeywordConditions) {
  return (a: KeywordRow, b: KeywordRow) => {
    const av = a[conditions.sort],
      bv = b[conditions.sort];
    const order =
      av === bv
        ? 0
        : av === null
          ? 1
          : bv === null
            ? -1
            : typeof av === 'number' && typeof bv === 'number'
              ? av - bv
              : textOrder(String(av), String(bv));
    return (
      (av === null || bv === null ? order : order * (conditions.direction === 'asc' ? 1 : -1)) ||
      textOrder(a.id, b.id)
    );
  };
}
async function collapse(spool: WarehouseEvidenceSpool, sorted: SpoolRows<KeywordRow>) {
  const result = await spool.write<KeywordRow>(async emit => {
    let group: KeywordRow | undefined;
    for await (const row of sorted.iterate()) {
      if (group?.id !== row.id) {
        if (group) await emit(group);
        group = row;
      } else for (const metric of metrics) group[metric] = add(group[metric], row[metric]);
    }
    if (group) await emit(group);
  });
  await sorted.remove();
  return result;
}

/** Complete keyword evidence stays on request-owned temporary disk. Raw source
 * evidence is identified/redacted before it enters the spool or shared cache. */
export async function buildWarehouseKeywordSelection(
  produce: EvidenceProducer<KeywordCandidate>,
  p: SelectionQuery,
  hasGoals: boolean,
  signal?: AbortSignal,
): Promise<WarehouseKeywordSelection> {
  const spool = await WarehouseEvidenceSpool.create(signal);
  try {
    const conditions = keywordConditionsSchema.parse(p);
    const original = await collapse(
      spool,
      await spool.sort<KeywordRow>(
        async emit => {
          // One candidate map reuses the exact browser keyword identification policy.
          const group = new Map<string, KeywordRow>();
          await produce(async row => {
            for (const metric of metrics) add(0, row[metric]);
            group.clear();
            if (addKeywordCandidate(group, row)) await emit(group.values().next().value);
          });
        },
        (a, b) => textOrder(a.id, b.id),
      ),
    );
    const engines = new Set<string>(); // Seven contract-defined search engines.
    const digest = createHash('sha256').update(`[1,${JSON.stringify(hasGoals)},[`);
    let first = true;
    for await (const row of original.iterate()) {
      engines.add(row.engine);
      digest.update(
        (first ? '' : ',') + JSON.stringify([row.id, row.sessions, row.bounces, row.conversions]),
      );
      first = false;
    }
    const hash = digest.update(']]').digest('hex').slice(0, 32);
    const snapshot = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
    let population = original;
    if (!supportsKeywordRedirect(p)) {
      population = await collapse(
        spool,
        await spool.sort<KeywordRow>(
          async emit => {
            for await (const row of original.iterate()) {
              const status = row.status === 'redirect' ? 'unsupported' : row.status;
              await emit({
                ...row,
                status,
                id: JSON.stringify([row.engine, row.keyword, row.evidence, status]),
              });
            }
          },
          (a, b) => textOrder(a.id, b.id),
        ),
      );
      await original.remove();
    }
    let total = 0,
      referrer = 0,
      utm = 0;
    for await (const row of population.iterate()) {
      if (conditions.engine && row.engine !== conditions.engine) continue;
      total = add(total, row.sessions);
      if (row.evidence === 'referrer') referrer = add(referrer, row.sessions);
      if (row.evidence === 'utm') utm = add(utm, row.sessions);
    }
    const rows = await spool.sort<KeywordRow>(async emit => {
      for await (const row of population.iterate()) {
        // Selection filters/status aliases and per-row rates use the shared
        // contract. Share always uses the complete engine population denominator.
        const selected = selectKeywords([row], conditions, hasGoals, true).rows[0];
        if (selected) await emit({ ...selected, share: percent(row.sessions, total) });
      }
    }, keywordOrder(conditions));
    await population.remove();
    return {
      rows,
      hasGoals,
      snapshot,
      readAt: Date.now(),
      engines: [...engines].sort(),
      total,
      referrer,
      utm,
      availability: percent(referrer + utm, total),
      dispose: () => spool.dispose(),
    };
  } catch (error) {
    await spool.dispose();
    throw error;
  }
}

/** The callback and all dependent browser reads share one publication/control
 * boundary. Dispose only after the page or complete export has been produced. */
export async function withWarehouseKeywords<T>(
  site: string,
  p: SelectionQuery & { startAt: number; endAt: number; timezone: string },
  work: (selection: WarehouseKeywordSelection) => Promise<T>,
  signal?: AbortSignal,
  longRunning = false,
) {
  return withinWarehouseReport(async () => {
    const params = await warehouseBrowserParameters(
      site,
      new Date(p.startAt),
      new Date(p.endAt),
      p.timezone,
    );
    const selected = await buildWarehouseKeywordSelection(
      async emit => {
        await warehouseReportStream(
          site,
          `${warehouseVisitsSQL()} SELECT v.referrer,v.utmSource,v.utmMedium,v.utmCampaign,v.referrerPath,v.referrerQuery,v.utmTerm,
          count() AS sessions,countIf(v.pv=1 AND v.custom=0) AS bounces,countIf(v.converted) AS conversions
          FROM visits v GROUP BY v.referrer,v.utmSource,v.utmMedium,v.utmCampaign,v.referrerPath,v.referrerQuery,v.utmTerm`,
          params,
          async rows => {
            for (const row of rows)
              await emit({
                ...row,
                ...Object.fromEntries(metrics.map(k => [k, Number(row[k])])),
              } as KeywordCandidate);
          },
          signal,
          longRunning,
        );
      },
      p,
      params.goalIds.length > 0,
      signal,
    );
    try {
      return await work(selected);
    } finally {
      await selected.dispose();
    }
  });
}
