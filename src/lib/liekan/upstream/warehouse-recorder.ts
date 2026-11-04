import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { HeatmapEventRow } from '@/queries/sql/heatmap/saveHeatmapEvents';
import type { SaveRecordingArgs } from '@/queries/sql/replays/saveRecording';
import { WarehouseUnavailable } from '../warehouse/completion';
import { factInput } from '../warehouse/fact-input';
import type { FactMutation } from '../warehouse/landing';
import { validateRecorderPackage } from '../warehouse/recorder-planner';
import { warehouseRuntime } from '../warehouse/runtime';
import { CollectionConflictError } from './collection-write';

async function submit(
  kind: 'replay' | 'heatmap',
  websiteId: string,
  sessionId: string,
  visitId: string,
  facts: FactMutation[],
) {
  try {
    const runtime = await warehouseRuntime(),
      site = await runtime.resource(websiteId, 'website');
    const data = { format: 'recorder-v1', facts };
    const envelope = runtime.envelope(site, {
      websiteId,
      sessionId,
      visitId,
      kind,
      eventId: randomUUID(),
      fingerprint: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
      collectionSource: 'browser',
      collectionScope: 'recorder',
      receivedAt: new Date().toISOString(),
      data,
    });
    validateRecorderPackage(envelope);
    await runtime.queue.enqueue(envelope);
    const result = await runtime.completion.wait(envelope);
    if (result.status === 'cancelled' || result.status === 'conflict')
      throw new CollectionConflictError();
  } catch (error) {
    if (error instanceof CollectionConflictError || error instanceof WarehouseUnavailable)
      throw error;
    throw new WarehouseUnavailable('warehouse-recorder-unavailable');
  }
}

export async function saveWarehouseRecording(args: SaveRecordingArgs) {
  const { websiteId, sessionId, visitId } = args;
  await submit('replay', websiteId, sessionId, visitId, [
    {
      family: 'session_replay',
      row: factInput('session_replay', {
        replay_id: randomUUID(),
        website_id: websiteId,
        session_id: sessionId,
        visit_id: visitId,
        chunk_index: args.chunkIndex,
        events: gzipSync(Buffer.from(JSON.stringify(args.events))),
        event_count: args.eventCount,
        started_at: args.startedAt,
        ended_at: args.endedAt,
        created_at: new Date(),
      }),
    },
  ]);
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
  )
    throw new Error('warehouse-recorder-mixed-identity');
  await submit(
    'heatmap',
    first.websiteId,
    first.sessionId,
    first.visitId,
    rows.map(r => ({
      family: 'heatmap_event',
      row: factInput('heatmap_event', {
        heatmap_event_id: randomUUID(),
        website_id: r.websiteId,
        session_id: r.sessionId,
        visit_id: r.visitId,
        url_path: r.urlPath,
        event_type: r.eventType,
        x: r.x,
        y: r.y,
        page_x: r.pageX,
        page_y: r.pageY,
        page_w: r.pageW,
        viewport_w: r.viewportW,
        viewport_h: r.viewportH,
        page_h: r.pageH,
        scroll_pct: r.scrollPct,
        created_at: r.createdAt,
      }),
    })),
  );
}
