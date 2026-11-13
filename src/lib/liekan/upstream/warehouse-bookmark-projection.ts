import { createHash } from 'node:crypto';
import { WarehouseConflict } from '../warehouse/control-db';
import { warehouseTime } from '../warehouse/fact-input';
import { warehouseReader } from '../warehouse/reader-runtime';
import { warehouseReportMetadata } from './warehouse-report-snapshot';

/** Replay bookmarks is projected in bounded pages. Reports join it
 * inside CH; no full log/path ID list travels back to PG for membership checks. */
export async function warehouseBookmarkProjection(site: string) {
  const reader = warehouseReader(),
    metadata = await warehouseReportMetadata(site);
  const revision = metadata.bookmarkRevision,
    epoch = metadata.boundary.epoch;
  if (!revision) throw new WarehouseConflict('warehouse-bookmark-revision-missing');
  const params = { site, epoch, revision };
  const readManifest = () =>
    reader.ch
      .query({
        query: `SELECT DISTINCT value FROM warehouse_control_projection
    WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND revision={revision:UInt64} AND kind='bookmark-manifest-v1' LIMIT 2`,
        query_params: params,
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ value: string }>());
  const existing = await readManifest();
  if (existing.length > 1) throw new WarehouseConflict('warehouse-bookmark-manifest-conflict');
  if (existing.length === 1) return { wh_bookmark_revision: revision };
  const source = createHash('sha256');
  let after: string | null = null,
    count = 0;
  const assertRevision = async () => {
    const [current] = await reader.db.read<{
      bookmark_revision: string;
      epoch: string;
      state: string;
    }>(
      'SELECT bookmark_revision::text,epoch::text,state FROM liekan_warehouse_site WHERE website_id=$1',
      [site],
    );
    if (
      current?.state !== 'active' ||
      current.epoch !== epoch ||
      current.bookmark_revision !== revision
    )
      throw new WarehouseConflict('warehouse-bookmark-changed');
  };
  for (;;) {
    await assertRevision();
    const rows = await reader.db.read<{ path: string; value: string }>(
      `SELECT saved_replay_id::text AS path,json_build_object('visitId',visit_id::text,'name',name)::text AS value FROM session_replay_saved WHERE website_id=$1 AND ($2::uuid IS NULL OR saved_replay_id>$2::uuid) ORDER BY saved_replay_id LIMIT 1000`,
      [site, after],
    );
    if (!rows.length) break;
    for (const row of rows) source.update(JSON.stringify([row.path, row.value]) + '\n');
    count += rows.length;
    await reader.ch.insert({
      table: 'warehouse_control_projection',
      format: 'JSONEachRow',
      values: rows.map(row => ({
        website_id: site,
        epoch,
        kind: 'bookmark-value-v1',
        revision,
        key: row.path,
        value: row.value,
        created_at: warehouseTime(new Date()),
      })),
    });
    after = rows.at(-1).path;
  }
  await assertRevision();
  const actual = createHash('sha256');
  let actualCount = 0;
  after = null;
  for (;;) {
    const rows = await reader.ch
      .query({
        query: `SELECT DISTINCT key,value FROM warehouse_control_projection
      WHERE website_id={site:UUID} AND epoch={epoch:UInt64} AND revision={revision:UInt64} AND kind='bookmark-value-v1'
      AND ({first:Bool} OR key>{after:String}) ORDER BY key LIMIT 1000`,
        query_params: { ...params, first: after === null, after: after ?? '' },
        format: 'JSONEachRow',
      })
      .then(r => r.json<{ key: string; value: string }>());
    if (!rows.length) break;
    for (const row of rows) actual.update(JSON.stringify([row.key, row.value]) + '\n');
    actualCount += rows.length;
    after = rows.at(-1).key;
  }
  const checksum = source.digest('hex');
  if (actualCount !== count || actual.digest('hex') !== checksum)
    throw new WarehouseConflict('warehouse-bookmark-verification-failed');
  await assertRevision();
  const manifest = JSON.stringify({ format: 'bookmark-value-v1', count, checksum });
  await reader.ch.insert({
    table: 'warehouse_control_projection',
    format: 'JSONEachRow',
    values: [
      {
        website_id: site,
        epoch,
        kind: 'bookmark-manifest-v1',
        revision,
        key: '',
        value: manifest,
        created_at: warehouseTime(new Date()),
      },
    ],
  });
  const verified = await readManifest();
  if (verified.length !== 1 || verified[0].value !== manifest)
    throw new WarehouseConflict('warehouse-bookmark-manifest-conflict');
  return { wh_bookmark_revision: revision };
}

// The projection table also holds manifests and other payload shapes. The
// optimizer may evaluate this expression before applying the kind filter, so
// conversion must be defined for those unrelated rows as well.
export const warehouseBookmarkValues = `(SELECT DISTINCT toUUIDOrNull(JSONExtractString(value,'visitId')) AS visit_id,JSONExtractString(value,'name') AS name FROM warehouse_control_projection
  WHERE website_id={wh_site:UUID} AND epoch={wh_epoch:UInt64} AND revision={wh_bookmark_revision:UInt64} AND kind='bookmark-value-v1')`;
