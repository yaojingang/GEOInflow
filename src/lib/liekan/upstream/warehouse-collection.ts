import { WarehouseUnavailable } from '../warehouse/runtime';
import { submitV2BrowserCollection } from '../warehouse-v2/index';
import { CollectionConflictError } from './collection-write';
import type { WarehouseCollectionPackage } from './warehouse-collection-package';

export async function submitWarehouseCollection(
  pkg: WarehouseCollectionPackage,
  resourceType: 'website' | 'link' | 'pixel',
  sessionId: string,
  visitId: string,
  receivedAt: Date,
): Promise<{ status: 'accepted' | 'duplicate'; sessionId: string; visitId: string; eventId: string }> {
  try {
    return await submitV2BrowserCollection(pkg, resourceType, sessionId, visitId, receivedAt);
  } catch (error) {
    if (error instanceof CollectionConflictError || (error as { code?: string })?.code === 'COLLECTION_CONFLICT') {
      throw new CollectionConflictError();
    }
    if (error instanceof WarehouseUnavailable) throw error;
    throw new WarehouseUnavailable('warehouse-collection-unavailable');
  }
}
