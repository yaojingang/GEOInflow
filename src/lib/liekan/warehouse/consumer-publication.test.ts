// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { WarehouseConsumer } from './consumer';
import type { Attempt, Ownership } from './control';
import { WarehouseDeriver } from './derivation';
import { LandingStore } from './landing';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const decisionProjected = vi.fn(async () => {});
  const queue = {
    installation: { topicName: 'test', topicId: 'topic', partitions: 1 },
    maxMessageBytes: 1024,
    kafka: {
      consumer: () => ({ events: {}, on: () => () => {} }),
    },
  };
  const worker = new WarehouseConsumer(
    { db: {}, decisionProjected } as any,
    {} as any,
    queue as any,
    async () => [],
    { groupId: 'test' },
  );
  const owner = { topicId: 'topic', partition: 0, ownerId: 'owner', generation: '1' } as Ownership;
  const attempt = { attempt_id: 'attempt', status: 'confirmed', effects: [] } as unknown as Attempt;
  return {
    decisionProjected,
    restore: () => (worker as any).restore(owner, attempt) as Promise<void>,
  };
}

test('a receipt key stays busy until a no-effect package is completely published', async () => {
  const states: string[] = [];
  vi.spyOn(LandingStore.prototype, 'projectDecision').mockImplementation(async () => {
    states.push('decision-durable');
  });
  let finish: () => void;
  const publication = new Promise<void>(resolve => {
    finish = resolve;
  });
  vi.spyOn(WarehouseDeriver.prototype, 'derive').mockImplementation(async () => {
    states.push('publication-started');
    await publication;
    states.push('package-published');
  });
  const f = fixture();
  f.decisionProjected.mockImplementation(async () => {
    states.push('receipt-key-released');
  });
  const pending = f.restore();
  await vi.waitFor(() => expect(states).toContain('publication-started'));
  const beforePublication = [...states];
  finish();
  await pending;
  expect(beforePublication).toEqual(['decision-durable', 'publication-started']);
  expect(states).toEqual([
    'decision-durable',
    'publication-started',
    'package-published',
    'receipt-key-released',
  ]);
});

test('failed no-effect derivation retains the key until recovery publishes the original package', async () => {
  vi.spyOn(LandingStore.prototype, 'projectDecision').mockResolvedValue(undefined);
  const derive = vi
    .spyOn(WarehouseDeriver.prototype, 'derive')
    .mockRejectedValueOnce(new Error('family-write-failed'))
    .mockResolvedValueOnce(undefined);
  const f = fixture();
  await expect(f.restore()).rejects.toThrow('family-write-failed');
  const releasedAfterFailure = f.decisionProjected.mock.calls.length;
  await f.restore();
  expect(releasedAfterFailure).toBe(0);
  expect(f.decisionProjected).toHaveBeenCalledTimes(1);
  expect(derive).toHaveBeenCalledTimes(2);
});
