import { describe, expect, it, vi } from 'vitest';
import { prepareWarehouseUpload } from './warehouse-log-ingestion';

const input = {
  websiteId: '6dd75878-7966-4a62-b86a-790cde04525b',
  batchId: 'e8ae48ba-a17b-4f66-8444-0470de3ca62f',
  sourceId: null,
  sourceEpoch: 1,
  kind: 'manual' as const,
  digest: 'd'.repeat(64),
  count: 2,
};
const upload = {
  website_id: input.websiteId,
  source_id: input.sourceId,
  source_epoch: input.sourceEpoch,
  bound_epoch: '3',
  kind: input.kind,
  digest: input.digest,
  expected: input.count,
  status: 'pending',
};

function metadataTx() {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValueOnce([{ authority: 'clickhouse' }])
      .mockResolvedValueOnce([{ epoch: '3', state: 'active' }]),
  };
}

describe('warehouse upload registration', () => {
  it('checks and returns the newly registered row without a second upload lookup', async () => {
    const tx = metadataTx();
    tx.$queryRawUnsafe.mockResolvedValueOnce([upload]);
    await expect(prepareWarehouseUpload(tx, input)).resolves.toEqual(upload);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    expect(tx.$queryRawUnsafe.mock.calls[2][0]).toContain('RETURNING');
  });

  it.each([{ digest: 'changed' }, { bound_epoch: '2' }, { status: 'cancelled' }])(
    'reads a conflicting registration and rejects an incompatible row %o',
    async change => {
      const tx = metadataTx();
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ ...upload, ...change }]);
      await expect(prepareWarehouseUpload(tx, input)).rejects.toMatchObject({ status: 409 });
      expect(tx.$queryRawUnsafe).toHaveBeenLastCalledWith(
        expect.stringMatching(/FROM liekan_warehouse_upload .*FOR SHARE/),
        input.batchId,
      );
    },
  );
});
