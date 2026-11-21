// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  analysisBuildStep,
  type AnalysisBuild,
  type AnalysisBuildStore,
} from './warehouse-analysis-build';
import { WarehouseBackgroundDeferred } from './warehouse-background-budget';

const initial = (): AnalysisBuild => ({
  id: randomUUID(),
  checkpoint: randomUUID(),
  kind: 'log',
  hours: [3600],
  control: 'c',
  publication: '10',
  receipts: {},
});
function fixture() {
  let durable = initial();
  const store: AnalysisBuildStore = {
    current: () => structuredClone(durable),
    save: async v => {
      durable = JSON.parse(JSON.stringify(v));
    },
    notBefore: () => 0,
    deferUntil: async () => {},
  };
  return store;
}
it('recovers an acknowledged write after process loss without appending it twice', async () => {
  const store = fixture();
  const write = vi.fn(async () => {
      throw new Error('response lost');
    }),
    verify = vi.fn(async () => true);
  await expect(analysisBuildStep(store.current(), store, 'facts', write, verify)).rejects.toThrow(
    'response lost',
  );
  expect(store.current().intent).toBe('facts');
  await analysisBuildStep(store.current(), store, 'facts', write, verify);
  await analysisBuildStep(store.current(), store, 'facts', write, verify);
  expect(write).toHaveBeenCalledOnce();
  expect(verify).toHaveBeenCalledOnce();
});
it('does not mistake admission deferral for an ambiguous write', async () => {
  const store = fixture(),
    verify = vi.fn(async () => true);
  await expect(
    analysisBuildStep(
      store.current(),
      store,
      'facts',
      async () => {
        throw new WarehouseBackgroundDeferred();
      },
      verify,
    ),
  ).rejects.toBeInstanceOf(WarehouseBackgroundDeferred);
  expect(store.current().intent).toBeUndefined();
  const write = vi.fn(async () => true);
  await analysisBuildStep(store.current(), store, 'facts', write, verify);
  expect(write).toHaveBeenCalledOnce();
  expect(verify).not.toHaveBeenCalled();
});
it('never publishes an unverified recovered partial write', async () => {
  const store = fixture();
  const state = store.current();
  state.intent = 'facts';
  await store.save(state);
  const work = vi.fn(async () => true);
  await expect(
    analysisBuildStep(store.current(), store, 'facts', work, async () => {
      throw new Error('checksum');
    }),
  ).rejects.toThrow('checksum');
  expect(store.current().receipts.facts).toBeUndefined();
  expect(work).not.toHaveBeenCalled();
});
