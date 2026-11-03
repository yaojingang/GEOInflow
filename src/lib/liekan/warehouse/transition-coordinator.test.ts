// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { TransitionCoordinator } from './transition-coordinator';

function fixture(status: 'pending' | 'confirmed' | 'published' | 'cancelled') {
  let taskStatus = status;
  let barrier: Record<string, unknown> | undefined;
  let installationLocked = false;
  const topic = '1'.repeat(32);
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    let rows: unknown[];
    if (sql.includes('FROM liekan_warehouse_installation')) {
      installationLocked = sql.includes('FOR UPDATE');
      rows = [
        {
          authority: 'clickhouse',
          revision: '7',
          topic_id: topic,
          partition_count: 1,
          facts_fenced: true,
          identity_bound: true,
        },
      ];
    } else if (sql.includes('FROM liekan_warehouse_task')) {
      expect(installationLocked).toBe(true);
      rows = ['pending', 'confirmed'].includes(taskStatus) ? [{ task_id: 'durable-task' }] : [];
    } else if (sql.includes('FROM liekan_warehouse_barrier')) {
      rows = barrier ? [barrier] : [];
    } else if (sql.includes('FROM liekan_warehouse_transition')) {
      rows = [{ state: 'capturing' }];
    } else if (sql.includes('INSERT INTO liekan_warehouse_barrier')) {
      barrier = {
        operation_id: values[0],
        kind: values[1],
        authority: values[2],
        installation_revision: values[3],
        topic_id: values[4],
        boundary: JSON.parse(String(values[5])),
        status: 'draining',
      };
      rows = [barrier];
    } else throw new Error(`Unexpected test SQL: ${sql}`);
    return { rows, rowCount: rows.length };
  });
  const db = {
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      installationLocked = false;
      return work({ query });
    },
  };
  const queue = {
    installation: { topicId: topic, partitions: 1 },
    assertIdentity: vi.fn(async () => {}),
    highWatermarks: vi.fn(async () => [{ partition: 0, offset: '10' }]),
  };
  return {
    coordinator: new TransitionCoordinator(db as any, queue as any),
    setTaskStatus: (value: typeof taskStatus) => {
      taskStatus = value;
    },
    barrier: () => barrier,
    queue,
    query,
  };
}

test.each(['pending', 'confirmed'] as const)(
  'rollback rejects a %s task before installing a boundary and retries the same operation after publication',
  async status => {
    const f = fixture(status),
      id = randomUUID();
    await expect(f.coordinator.request('rollback', id)).rejects.toThrow(
      'warehouse-transition-control-not-drained',
    );
    expect(f.barrier()).toBeUndefined();
    f.setTaskStatus('published');
    const result = await f.coordinator.request('rollback', id);
    expect(result.operation_id).toBe(id);
    expect(result.status).toBe('draining');
  },
);

test('a task registered after reading H is checked before the barrier commits', async () => {
  const f = fixture('published');
  f.queue.highWatermarks.mockImplementationOnce(async () => {
    f.setTaskStatus('pending');
    return [{ partition: 0, offset: '10' }];
  });
  await expect(f.coordinator.request('rollback')).rejects.toThrow(
    'warehouse-transition-control-not-drained',
  );
  expect(f.barrier()).toBeUndefined();
});

test('terminal tasks permit a barrier and stable operation retries preserve its boundary', async () => {
  const f = fixture('cancelled'),
    id = randomUUID();
  const first = await f.coordinator.request('rollback', id);
  f.setTaskStatus('pending');
  f.queue.highWatermarks.mockResolvedValueOnce([{ partition: 0, offset: '20' }]);
  expect(await f.coordinator.request('rollback', id)).toEqual(first);
  expect(f.barrier()?.boundary).toEqual([{ partition: 0, offset: '10' }]);
});
