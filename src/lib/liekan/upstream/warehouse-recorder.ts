import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { HeatmapEventRow } from '@/queries/sql/heatmap/saveHeatmapEvents';
import type { SaveRecordingArgs } from '@/queries/sql/replays/saveRecording';
import { WarehouseUnavailable } from '../warehouse/runtime';
import { insertV2Rows, toV2Timestamp, v2Tables, warehouseV2Runtime } from '../warehouse-v2/index';

async function readSiteEpoch(websiteId: string): Promise<string> {
  const rt = warehouseV2Runtime();
  await rt.ensureReady();
  const { rows } = await rt.pg.query<{ active: boolean; epoch: string }>(
    `SELECT
       EXISTS(SELECT 1 FROM website WHERE website_id=$1::uuid AND deleted_at IS NULL) AS active,
       coalesce((SELECT epoch::text FROM liekan_log_state WHERE website_id=$1::uuid), '1') AS epoch`,
    [websiteId],
  );
  if (!rows[0]?.active) throw new WarehouseUnavailable('warehouse-recorder-site-inactive');
  return rows[0].epoch;
}

export async function saveWarehouseRecording(args: SaveRecordingArgs) {
  try {
    const rt = warehouseV2Runtime();
    const epoch = await readSiteEpoch(args.websiteId);
    const eventsHex = gzipSync(Buffer.from(JSON.stringify(args.events))).toString('hex');
    await insertV2Rows(rt.ch, v2Tables.sessionReplay, [
      {
        website_id: args.websiteId,
        epoch,
        replay_id: randomUUID(),
        session_id: args.sessionId,
        visit_id: args.visitId,
        chunk_index: Number(args.chunkIndex ?? 0),
        events: eventsHex,
        event_count: Number(args.eventCount ?? 0),
        started_at: toV2Timestamp(args.startedAt),
        ended_at: toV2Timestamp(args.endedAt),
        created_at: toV2Timestamp(new Date()),
        _ver: String(Date.now()),
      },
    ]);
  } catch (error) {
    if (error instanceof WarehouseUnavailable) throw error;
    throw new WarehouseUnavailable('warehouse-recorder-unavailable');
  }
}

export async function saveWarehouseHeatmap(rows: HeatmapEventRow[]) {
  if (!rows.length) return;
  const first = rows[0];
  if (
    rows.some(
      r =>
        r.websiteId !== first.websiteId ||
        r.sessionId !== first.sessionId ||
        r.visitId !== first.visitId,
    )
  ) {
    throw new Error('warehouse-recorder-mixed-identity');
  }
  try {
    const rt = warehouseV2Runtime();
    const epoch = await readSiteEpoch(first.websiteId);
    const ver = String(Date.now());
    await insertV2Rows(
      rt.ch,
      v2Tables.heatmap,
      rows.map(r => ({
        website_id: r.websiteId,
        epoch,
        heatmap_event_id: randomUUID(),
        session_id: r.sessionId,
        visit_id: r.visitId,
        url_path: r.urlPath,
        event_type: Number(r.eventType ?? 1),
        x: r.x != null ? Number(r.x) : null,
        y: r.y != null ? Number(r.y) : null,
        page_x: r.pageX != null ? Number(r.pageX) : null,
        page_y: r.pageY != null ? Number(r.pageY) : null,
        page_w: r.pageW != null ? Number(r.pageW) : null,
        viewport_w: r.viewportW != null ? Number(r.viewportW) : null,
        viewport_h: r.viewportH != null ? Number(r.viewportH) : null,
        page_h: r.pageH != null ? Number(r.pageH) : null,
        scroll_pct: r.scrollPct != null ? Number(r.scrollPct) : null,
        created_at: toV2Timestamp(r.createdAt),
        _ver: ver,
      })),
    );
  } catch (error) {
    if (error instanceof WarehouseUnavailable) throw error;
    throw new WarehouseUnavailable('warehouse-recorder-unavailable');
  }
}
