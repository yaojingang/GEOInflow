import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiekanError } from './errors';

const mocks = vi.hoisted(() => ({ source: vi.fn(), website: vi.fn() }));
vi.mock('../log-ingestion/service', () => ({ validateSource: mocks.source }));
vi.mock('./server', async () => ({
  ...(await import('./errors')),
  lockWritableWebsite: mocks.website,
}));

import type { ControlSQL } from '../warehouse/control-db';
import { logEnvelope } from '../warehouse/log-package';
import {
  authorizeWarehouseUploads,
  confirmWarehouseAuthority,
  authorizeWarehouseTask,
} from './warehouse-authority';

const site = '11111111-1111-1111-1111-111111111111',
  batch = '22222222-2222-2222-2222-222222222222';
const upload = {
  actor_id: site,
  source_id: batch,
  source_epoch: 1,
  kind: 'automatic',
  warehouse_epoch: '0',
  status: 'pending',
};
function fixture() {
  const tx = {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes('liekan_warehouse_upload') ? [upload] : [{ epoch: 1 }],
      rowCount: 1,
    })),
  };
  const db = { transaction: async (work: any) => work(tx) };
  return { tx: tx as unknown as ControlSQL, db };
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(upload, { kind: 'automatic', source_epoch: 1, actor_id: site });
  mocks.source.mockResolvedValue({ source: { website_id: site }, epoch: 1 });
  mocks.website.mockResolvedValue(undefined);
});
describe('warehouse governance and repair confirmation fences', () => {
  it('rechecks preview author and expiry in both planning and the confirmation transaction', async () => {
    const result = {
      kind: 'traffic-exclusion' as const,
      collectionId: batch,
      actorId: site,
      windowEnd: '2026-11-03T01:00:00Z',
      digest: 'a'.repeat(64),
      events: 1,
    };
    const { tx } = fixture();
    expect(await authorizeWarehouseTask(tx, site, result)).toBe(true);
    expect(mocks.website).toHaveBeenCalledWith(expect.anything(), site, { userId: site }, 'share');
    mocks.website.mockRejectedValue(new LiekanError('revoked', 403));
    expect(await authorizeWarehouseTask(tx, site, result)).toBe(false);
    mocks.website.mockRejectedValue(new Error('connection lost'));
    await expect(authorizeWarehouseTask(tx, site, result)).rejects.toThrow('connection lost');
  });
  it('rejects a collection decision planned before the repair freeze or log epoch changed', async () => {
    const scope = batch;
    const tx = {
      query: vi.fn(async (sql: string) => ({
        rowCount: 1,
        rows: sql.includes('SELECT resource_type')
          ? [{ resource_type: 'website' }]
          : sql.includes('repair_scope_id')
            ? [{ epoch: '2', repair_scope_id: scope }]
            : [{}],
      })),
    };
    const d: any = {
      input: { envelope: { kind: 'browser' } },
      status: 'new',
      facts: [
        { family: 'liekan_event_quality', row: { repair_scope_id: null } },
        { family: 'liekan_event_observation', row: { epoch: '1' } },
      ],
    };
    await expect(
      confirmWarehouseAuthority(tx as any, { website_id: site } as any, [d]),
    ).rejects.toThrow('warehouse-collection-context-changed');
    d.facts[0].row.repair_scope_id = scope;
    await expect(
      confirmWarehouseAuthority(tx as any, { website_id: site } as any, [d]),
    ).rejects.toThrow('warehouse-collection-context-changed');
    d.facts[1].row.epoch = '2';
    await expect(
      confirmWarehouseAuthority(tx as any, { website_id: site } as any, [d]),
    ).resolves.toBeUndefined();
  });
});
describe('warehouse upload confirmation authority', () => {
  it('binds each accepted automatic batch to current source permission and collection epoch', async () => {
    const { db } = fixture();
    expect(
      await authorizeWarehouseUploads(db as any)([{ batchId: batch, websiteId: site, epoch: '0' }]),
    ).toEqual(new Set([batch]));
    expect(mocks.source).toHaveBeenCalledWith(expect.anything(), batch, undefined, true, 'share');
    mocks.source.mockResolvedValue({ source: { website_id: site }, epoch: 2 });
    expect(
      await authorizeWarehouseUploads(db as any)([{ batchId: batch, websiteId: site, epoch: '0' }]),
    ).toEqual(new Set());
  });
  it('cancels only definite authority failures; transient database failures remain retryable', async () => {
    const { db } = fixture(),
      read = () =>
        authorizeWarehouseUploads(db as any)([{ batchId: batch, websiteId: site, epoch: '0' }]);
    mocks.source.mockRejectedValue(new LiekanError('revoked', 403));
    expect(await read()).toEqual(new Set());
    mocks.source.mockRejectedValue(new Error('connection lost'));
    await expect(read()).rejects.toThrow('connection lost');
  });
  it('requires the stored manual actor and rechecks permission at decision commit', async () => {
    upload.kind = 'manual';
    const { db, tx } = fixture();
    expect(
      await authorizeWarehouseUploads(db as any)([{ batchId: batch, websiteId: site, epoch: '0' }]),
    ).toEqual(new Set([batch]));
    expect(mocks.website).toHaveBeenCalledWith(expect.anything(), site, { userId: site }, 'share');
    const input = logEnvelope(
      { website_id: site, epoch: '0', policy_revision: '0' } as any,
      { topicId: 'isolated' } as any,
      {
        id: 'b'.repeat(64),
        time: '2026-11-03T01:00:00Z',
        path: '/',
        method: 'GET',
        status: 200,
        bytes: 0,
        ipMasked: 'masked',
        ipHash: 'a'.repeat(64),
        userAgent: 'IsolatedTest',
        location: 'unknown',
        bot: '其他',
        vendor: '其他',
        type: '其他',
        verification: 'unverified',
      } as any,
      {
        batchId: batch,
        sourceId: batch,
        sourceEpoch: 1,
        kind: 'manual',
        receivedAt: new Date('2026-11-03T01:00:00Z'),
      },
    );
    mocks.website.mockRejectedValue(new LiekanError('revoked', 403));
    const decision = {
      input: { envelope: input, partition: 0, offset: '0' },
      status: 'new',
      sessionId: null,
      visitId: null,
      facts: [],
    };
    await expect(
      confirmWarehouseAuthority(tx, { website_id: site, epoch: '0' } as any, [decision as any]),
    ).rejects.toThrow('warehouse-upload-authority-changed');
    await expect(
      confirmWarehouseAuthority(tx, { website_id: site, epoch: '0' } as any, [
        { ...decision, status: 'cancelled' } as any,
      ]),
    ).resolves.toBeUndefined();
  });
});
