import { createHash } from 'node:crypto';
import { warehouseReader } from '../warehouse/reader-runtime';
import { readReportingMetadata } from '../warehouse/reporting-context';
import { warehouseControlFingerprint } from './warehouse-report-snapshot';
import { analysisModelVersion } from './warehouse-analysis-model';

let nextAt = 0,
  lastSite: string | null = null,
  tableCursor = 0;
/** One bounded, installation-scoped maintenance step. Site FOR UPDATE excludes
 * new reference pins until a synchronous deletion completes. Existing query,
 * export and snapshot references and in-flight builds defer collection. */
export async function collectAnalysisArtifacts(signal: AbortSignal) {
  if (Date.now() < nextAt) return;
  nextAt = Date.now() + 60000;
  const reader = warehouseReader();
  await reader.verifyIdentity();
  signal.throwIfAborted();
  const [candidate] = await reader.db.read<{ website_id: string }>(
    `SELECT website_id FROM liekan_warehouse_site
    WHERE state='active' AND resource_type='website' AND ($1::uuid IS NULL OR website_id>$1)
    ORDER BY website_id LIMIT 1`,
    [lastSite],
  );
  lastSite = candidate?.website_id ?? null;
  if (!candidate) {
    tableCursor++;
    return;
  }
  const site = candidate.website_id;
  const metadata = await readReportingMetadata(reader.db, site);
  const control = createHash('sha256')
    .update(JSON.stringify([analysisModelVersion, warehouseControlFingerprint(metadata)]))
    .digest('hex');
  await reader.db.transaction(async tx => {
    await tx.query("SET LOCAL lock_timeout='100ms'");
    const {
      rows: [locked],
    } = await tx.query(
      `SELECT epoch,publication FROM liekan_warehouse_site WHERE website_id=$1 AND state='active' FOR UPDATE SKIP LOCKED`,
      [site],
    );
    if (
      !locked ||
      String(locked.epoch) !== metadata.boundary.epoch ||
      String(locked.publication) !== metadata.boundary.publication
    )
      return;
    const {
      rows: [busy],
    } = await tx.query(
      `SELECT EXISTS(SELECT 1 FROM liekan_warehouse_reference WHERE website_id=$1 AND (expires_at IS NULL OR expires_at>clock_timestamp()))
      OR EXISTS(SELECT 1 FROM liekan_warehouse_overview_snapshot WHERE website_id=$1 AND lease_until>clock_timestamp()) AS present`,
      [site],
    );
    if (busy.present) return;
    const params: Record<string, unknown> = {
      site,
      epoch: metadata.boundary.epoch,
      control,
      publication: metadata.boundary.publication,
    };
    const settings = { max_threads: 1, max_execution_time: 5, mutations_sync: '1' as const };
    const query = async <T>(sql: string) =>
      (
        await reader.ch.query({
          query: sql,
          query_params: params,
          format: 'JSONEachRow',
          clickhouse_settings: settings,
          abort_signal: signal,
        })
      ).json<T>();
    const [coverage] = await query<{
      checkpoint: string;
      browser: string;
      log: string;
    }>(`SELECT toString(checkpoint) AS checkpoint,browser,log FROM warehouse_analysis_coverage_v1
      WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND control={control:String} AND publication<={publication:UInt64}
      ORDER BY publication DESC,recorded_at DESC,checkpoint DESC LIMIT 1`);
    // Parse before deleting anything. A malformed manifest is a maintenance failure.
    const builds = (text: string | undefined) => {
      const rows = JSON.parse(text ?? '[]');
      if (
        !Array.isArray(rows) ||
        rows.some(b => !Array.isArray(b) || !/^[-a-f0-9]{36}$/.test(b[1]))
      )
        throw new Error('warehouse-analysis-gc-manifest-invalid');
      return [...new Set(rows.map(b => b[1]))];
    };
    params.checkpoint = coverage?.checkpoint ?? '00000000-0000-0000-0000-000000000000';
    // Retire selectable manifests before any referenced data. A timed-out CH
    // mutation may continue after the PG lock is released: never start a data
    // deletion unless retirement completed and the remaining manifests were read.
    const retired = `website_id={site:UUID} AND epoch={epoch:UInt64}
      AND recorded_at<now()-INTERVAL 1 DAY AND checkpoint!={checkpoint:UUID}`;
    if (
      (await query(`SELECT 1 FROM warehouse_analysis_coverage_v1 WHERE ${retired} LIMIT 1`)).length
    )
      await reader.ch.command({
        query: `ALTER TABLE warehouse_analysis_coverage_v1 DELETE WHERE ${retired}`,
        query_params: params,
        clickhouse_settings: settings,
        abort_signal: signal,
      });
    const remaining = await query<{ browser: string; log: string }>(
      `SELECT browser,log FROM warehouse_analysis_coverage_v1
       WHERE website_id={site:UUID} AND epoch={epoch:UInt64}`,
    );
    params.browserBuilds = [...new Set(remaining.flatMap(row => builds(row.browser)))];
    params.logBuilds = [...new Set(remaining.flatMap(row => builds(row.log)))];
    const { rows: artifacts } = await tx.query<{ build: string }>(
      `SELECT result->'rankings'->>'build' AS build FROM liekan_warehouse_overview_snapshot
      WHERE website_id=$1 AND result->'rankings'->>'build' IS NOT NULL`,
      [site],
    );
    if (artifacts.some(a => !/^[-a-f0-9]{36}$/.test(a.build)))
      throw new Error('warehouse-ranking-gc-manifest-invalid');
    params.rankBuilds = artifacts.map(a => a.build);
    const steps = [
      [
        'warehouse_analysis_browser_v1',
        '_recorded_at<now()-INTERVAL 1 DAY AND _build NOT IN {browserBuilds:Array(UUID)}',
      ],
      [
        'warehouse_analysis_visit_hour_v1',
        '_recorded_at<now()-INTERVAL 1 DAY AND _build NOT IN {browserBuilds:Array(UUID)}',
      ],
      [
        'warehouse_analysis_log_v1',
        '_recorded_at<now()-INTERVAL 1 DAY AND _build NOT IN {logBuilds:Array(UUID)}',
      ],
      [
        'warehouse_report_rank_v1',
        'recorded_at<now()-INTERVAL 1 DAY AND build NOT IN {rankBuilds:Array(UUID)}',
      ],
    ];
    const [table, where] = steps[tableCursor % steps.length];
    // Empty candidate sets avoid creating a mutation on every maintenance pass.
    if (
      (
        await query(
          `SELECT 1 FROM ${table} WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND ${where} LIMIT 1`,
        )
      ).length
    )
      await reader.ch.command({
        query: `ALTER TABLE ${table} DELETE WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND ${where}`,
        query_params: params,
        clickhouse_settings: settings,
        abort_signal: signal,
      });
  });
}
