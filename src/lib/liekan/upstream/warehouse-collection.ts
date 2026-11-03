import { validateBrowserPackage } from '../warehouse/browser-planner';
import { WarehouseUnavailable } from '../warehouse/completion';
import { warehouseRuntime } from '../warehouse/runtime';
import { CollectionConflictError } from './collection-write';
import type { WarehouseCollectionPackage } from './warehouse-collection-package';

export async function submitWarehouseCollection(
  p: WarehouseCollectionPackage,
  resourceType: 'website' | 'link' | 'pixel',
  sessionId: string,
  visitId: string,
  receivedAt: Date,
) {
  try {
    const runtime = await warehouseRuntime();
    const site = await runtime.resource(p.input.websiteId, resourceType);
    if (
      p.input.expectedPolicyRevision !== undefined &&
      p.input.expectedPolicyRevision !== site.policy_revision
    )
      throw new CollectionConflictError();
    const envelope = runtime.envelope(site, {
      websiteId: p.input.websiteId,
      sessionId,
      visitId,
      eventId: p.eventId,
      clientEventId: p.input.eventId,
      kind: p.input.identify ? 'identify' : resourceType === 'website' ? 'browser' : resourceType,
      fingerprint: p.input.fingerprint,
      collectionSource: p.input.quality?.source ?? resourceType,
      collectionScope: p.input.identity?.scope ?? p.input.quality?.source ?? resourceType,
      receivedAt: receivedAt.toISOString(),
      data: p.seal(),
    });
    validateBrowserPackage(envelope);
    await runtime.queue.enqueue(envelope);
    const result = await runtime.completion.wait(envelope);
    if (result.status === 'conflict' || result.status === 'cancelled')
      throw new CollectionConflictError();
    if (!result.sessionId || !result.visitId)
      throw new WarehouseUnavailable('warehouse-response-unavailable');
    return result;
  } catch (error) {
    if (error instanceof CollectionConflictError || error instanceof WarehouseUnavailable)
      throw error;
    throw new WarehouseUnavailable('warehouse-temporarily-unavailable');
  }
}
