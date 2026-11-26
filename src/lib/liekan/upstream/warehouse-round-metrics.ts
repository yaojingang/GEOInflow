import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

// Optional, bounded reuse of small aggregate results within an already pinned
// background round. Losing this cache changes cost only, never coverage or state.
export type RoundMetricStore = {
  values: Record<string, unknown>;
  save: (key: string, value: unknown) => Promise<void>;
};
const context = new AsyncLocalStorage<{ id: string; store?: RoundMetricStore }>();
const rounds = new Map<string, { values: Map<string, unknown>; bytes: number; touched: number }>();
const maxBytes = 256 * 1024;
export const withRoundMetrics = <T>(
  id: string | undefined,
  work: () => T,
  store?: RoundMetricStore,
) => context.run(id ? { id, store } : undefined, work);
export const releaseRoundMetrics = (id: string) => rounds.delete(id);

export async function memoRoundMetric<T>(key: string, load: () => Promise<T>): Promise<T> {
  const active = context.getStore();
  if (!active) return load();
  const { id, store } = active;
  const now = Date.now();
  for (const [name, round] of rounds) if (now - round.touched > 15 * 60000) rounds.delete(name);
  let round = rounds.get(id);
  if (!round) {
    while (rounds.size >= 16) rounds.delete(rounds.keys().next().value);
    const entries = Object.entries(store?.values ?? {}).filter(([key]) =>
      /^[a-f0-9]{64}$/.test(key),
    );
    const bytes = Buffer.byteLength(JSON.stringify(Object.fromEntries(entries)));
    round =
      bytes <= maxBytes && entries.length <= 256
        ? { values: new Map(entries), bytes, touched: now }
        : { values: new Map(), bytes: 0, touched: now };
    rounds.set(id, round);
  }
  round.touched = now;
  const hash = createHash('sha256').update(key).digest('hex');
  if (round.values.has(hash)) return structuredClone(round.values.get(hash)) as T;
  const value = await load();
  const bytes = Buffer.byteLength(JSON.stringify(value) ?? 'null');
  if (bytes <= 32 * 1024 && round.bytes + bytes <= maxBytes && round.values.size < 256) {
    // Do not memoize promises or failures. Callers may mutate their own result.
    await store?.save(hash, value);
    round.values.set(hash, structuredClone(value));
    round.bytes += bytes;
  }
  return value;
}

export function cachedRoundMetric<T>(key: string): { value: T } | undefined {
  const active = context.getStore();
  if (!active) return;
  const hash = createHash('sha256').update(key).digest('hex');
  const round = rounds.get(active.id);
  if (round && Date.now() - round.touched <= 15 * 60000 && round.values.has(hash))
    return { value: structuredClone(round.values.get(hash)) as T };
  if (Object.hasOwn(active.store?.values ?? {}, hash))
    return { value: structuredClone(active.store.values[hash]) as T };
}
