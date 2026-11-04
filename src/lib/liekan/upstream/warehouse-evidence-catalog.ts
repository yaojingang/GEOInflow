import { createHash } from 'node:crypto';
import { WarehouseConflict } from '../warehouse/control-db';
import { warehouseReader } from '../warehouse/reader-runtime';
import { LiekanError } from './errors';
import { warehouseReportMetadata } from './warehouse-report-snapshot';

/** Match contentHash([{path,updatedAt},...]) byte-for-byte without retaining
 * the complete business catalog. Its publication revision fences every page. */
export async function warehouseEvidenceCatalog(site: string, signal?: AbortSignal) {
  const metadata = await warehouseReportMetadata(site),
    reader = warehouseReader();
  const assertRevision = async () => {
    if (signal?.aborted) throw new LiekanError('统计读取已取消', 499);
    const [current] = await reader.db.read<any>(
      'SELECT epoch::text,catalog_revision::text,state FROM liekan_warehouse_site WHERE website_id=$1',
      [site],
    );
    if (
      current?.state !== 'active' ||
      current.epoch !== metadata.boundary.epoch ||
      current.catalog_revision !== metadata.catalogRevision
    )
      throw new WarehouseConflict('warehouse-catalog-changed');
  };
  const hash = createHash('sha256');
  hash.update('[');
  let after: string | null = null,
    count = 0;
  for (;;) {
    await assertRevision();
    const rows = await reader.db.read<{ path: string; updatedAt: Date }>(
      `SELECT path,updated_at AS "updatedAt" FROM liekan_catalog
      WHERE website_id=$1 AND ($2::text IS NULL OR path>$2) ORDER BY path LIMIT 1000`,
      [site, after],
    );
    if (!rows.length) break;
    for (const row of rows) {
      hash.update((count ? ',' : '') + JSON.stringify(row));
      count++;
    }
    after = rows.at(-1).path;
  }
  await assertRevision();
  hash.update(']');
  return { hash: hash.digest('hex'), count };
}
