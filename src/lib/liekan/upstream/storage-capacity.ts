import { ANALYSIS_SITE_LIMIT } from './analysis-storage-limits';

export const storageResultReserve = { site: 32 * 1024 ** 2, global: 128 * 1024 ** 2 };
export const storageSiteBytesSql = `(s.derived_bytes+pg_column_size(s)*2+16777216
 +coalesce((SELECT sum(m.bytes) FROM liekan_analysis_meter m WHERE m.website_id=s.website_id),0)
 +coalesce((SELECT sum(q.result_bytes) FROM liekan_analysis_query q WHERE q.website_id=s.website_id),0)*2
 +coalesce((SELECT sum(d.result_bytes) FROM liekan_dashboard_snapshot d WHERE d.website_id=s.website_id),0)*2
 +coalesce((SELECT sum(f.result_bytes) FROM liekan_report_fragment f WHERE f.website_id=s.website_id),0)*2
 +(SELECT count(*)*512 FROM liekan_analytics_input_summary i WHERE i.website_id=s.website_id)
 +(SELECT count(*)*512 FROM liekan_analytics_input_state i WHERE i.website_id=s.website_id))`;
export const storageHistorySiteAllowedSql = `${storageSiteBytesSql}*100<${ANALYSIS_SITE_LIMIT}::bigint*90`;
export const storageSitePressureSql = `${storageSiteBytesSql}*100>=${ANALYSIS_SITE_LIMIT}::bigint*80`;
export function storageHistoryAllowed(capacity: { globalBytes: string; globalLimit: number }) {
  return BigInt(capacity.globalBytes) * 100n < BigInt(capacity.globalLimit) * 90n;
}
export function storagePressure(
  capacity: { siteBytes: string; globalBytes: string; siteLimit: number; globalLimit: number },
  percent = 80,
) {
  return (
    BigInt(capacity.siteBytes) * 100n >= BigInt(capacity.siteLimit) * BigInt(percent) ||
    BigInt(capacity.globalBytes) * 100n >= BigInt(capacity.globalLimit) * BigInt(percent)
  );
}
/** Saved report results share the existing limits with rebuildable facts. */
export function hasAnalysisBuildCapacity(capacity: {
  siteBytes: string;
  globalBytes: string;
  siteLimit: number;
  globalLimit: number;
}) {
  return (
    BigInt(capacity.siteBytes) < BigInt(capacity.siteLimit - storageResultReserve.site) &&
    BigInt(capacity.globalBytes) < BigInt(capacity.globalLimit - storageResultReserve.global)
  );
}
