import { createHash } from 'node:crypto';
import { WarehouseConflict } from '../warehouse/control-db';
import { warehouseTime } from '../warehouse/fact-input';
import { warehouseReader } from '../warehouse/reader-runtime';
import { LiekanError } from './errors';
import { humanPathFromEncoded } from './paths';
import { warehouseCatalogProjection } from './warehouse-catalog';
import { warehouseReportMetadata } from './warehouse-report-snapshot';

/** Versioned business-catalog mapping. Compute decodeURI with the same JS
 * implementation as product reports, then join the bounded projection in CH. */
export async function warehouseCatalogHumanPaths(site: string, signal?: AbortSignal) {
  const params = await warehouseCatalogProjection(site, signal),
    reader = warehouseReader(),
    metadata = await warehouseReportMetadata(site);
  const bound = { site, epoch: metadata.boundary.epoch, revision: metadata.catalogRevision };
  const kind = 'catalog-human-path-v1',
    manifestKind = 'catalog-human-manifest-v1';
  const manifest = () =>
    reader.ch
      .query({
        query: `SELECT DISTINCT value FROM warehouse_control_projection
    WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND revision={revision:UInt64} AND kind={kind:String} LIMIT 2`,
        query_params: { ...bound, kind: manifestKind },
        format: 'JSONEachRow',
        abort_signal: signal,
      })
      .then(r => r.json<{ value: string }>());
  const existing = await manifest();
  if (existing.length > 1) throw new WarehouseConflict('warehouse-catalog-human-manifest-conflict');
  if (existing.length) return params;
  const check = async () => {
    if (signal?.aborted) throw new LiekanError('统计读取已取消', 499);
    const [current] = await reader.db.read<any>(
      'SELECT epoch::text,catalog_revision::text,state FROM liekan_warehouse_site WHERE website_id=$1',
      [site],
    );
    if (
      current?.epoch !== bound.epoch ||
      current.catalog_revision !== bound.revision ||
      current.state !== 'active'
    )
      throw new WarehouseConflict('warehouse-catalog-changed');
  };
  let after: string | null = null,
    count = 0;
  const digest = createHash('sha256');
  for (;;) {
    await check();
    const rows = await reader.db.read<{ key: string }>(
      `SELECT path AS key FROM liekan_catalog
      WHERE website_id=$1 AND ($2::text IS NULL OR path>$2) ORDER BY path LIMIT 1000`,
      [site, after],
    );
    if (!rows.length) break;
    const values = rows.map(({ key }, index) => {
      const value = JSON.stringify({
        humanPath: humanPathFromEncoded(key),
        order: count + index + 1,
      });
      digest.update(JSON.stringify([key, value]) + '\n');
      return {
        website_id: site,
        epoch: bound.epoch,
        revision: bound.revision,
        kind,
        key,
        value,
        created_at: warehouseTime(new Date()),
      };
    });
    await reader.ch.insert({
      table: 'warehouse_control_projection',
      format: 'JSONEachRow',
      abort_signal: signal,
      values,
    });
    count += rows.length;
    after = rows.at(-1).key;
  }
  const expected = digest.digest('hex'),
    actual = createHash('sha256');
  let actualCount = 0,
    afterOrder = 0;
  for (;;) {
    const rows = await reader.ch
      .query({
        query: `SELECT DISTINCT key,value FROM warehouse_control_projection
      WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND revision={revision:UInt64} AND kind={kind:String}
        AND JSONExtractUInt(value,'order')>{afterOrder:UInt64} ORDER BY JSONExtractUInt(value,'order'),key,value LIMIT 1000`,
        query_params: { ...bound, kind, afterOrder },
        format: 'JSONEachRow',
        abort_signal: signal,
      })
      .then(r => r.json<{ key: string; value: string }>());
    if (!rows.length) break;
    for (const row of rows) actual.update(JSON.stringify([row.key, row.value]) + '\n');
    actualCount += rows.length;
    afterOrder = JSON.parse(rows.at(-1).value).order;
  }
  if (actualCount !== count || actual.digest('hex') !== expected)
    throw new WarehouseConflict('warehouse-catalog-human-verification-failed');
  await check();
  const value = JSON.stringify({ format: kind, count, checksum: expected });
  await reader.ch.insert({
    table: 'warehouse_control_projection',
    format: 'JSONEachRow',
    abort_signal: signal,
    values: [
      {
        website_id: site,
        epoch: bound.epoch,
        revision: bound.revision,
        kind: manifestKind,
        key: '',
        value,
        created_at: warehouseTime(new Date()),
      },
    ],
  });
  const verified = await manifest();
  if (verified.length !== 1 || verified[0].value !== value)
    throw new WarehouseConflict('warehouse-catalog-human-manifest-conflict');
  return params;
}

export const warehouseCatalogHumanRelation = `(SELECT DISTINCT key AS encodedPath,JSONExtractString(value,'humanPath') AS humanPath,JSONExtractUInt(value,'order') AS catalogOrder FROM warehouse_control_projection
  WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND revision={wh_catalog_revision:UInt64} AND kind='catalog-human-path-v1')`;
