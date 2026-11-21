import type { AnalysisKind } from '../warehouse/analysis-context';
import { WarehouseBackgroundDeferred } from './warehouse-background-budget';

export type AnalysisBuild = {
  id: string;
  sourceBuild?: string;
  checkpoint: string;
  kind: AnalysisKind;
  hours: number[];
  control: string;
  publication: string;
  receipts: Record<string, unknown>;
  progressAt?: number;
  intent?: string;
};
export type AnalysisBuildStore = {
  current(): AnalysisBuild | null;
  save(value: AnalysisBuild | null): Promise<void>;
  notBefore(): number;
  deferUntil(value: number): Promise<void>;
};
export class AnalysisBuildAbandoned extends Error {
  constructor() {
    super('warehouse-analysis-build-unverified');
  }
}

/** Acknowledged stages are immutable receipts. An ambiguous write is verified
 * before reuse; a partial candidate is abandoned, never appended to again. */
export async function analysisBuildStep<T>(
  state: AnalysisBuild,
  store: AnalysisBuildStore | undefined,
  name: string,
  work: () => Promise<T>,
  recover?: () => Promise<T>,
): Promise<T> {
  if (Object.hasOwn(state.receipts, name)) return state.receipts[name] as T;
  if (state.intent === name && recover) {
    const value = await recover();
    state.receipts[name] = value;
    state.progressAt = Date.now();
    delete state.intent;
    await store?.save(state);
    return value;
  }
  if (recover) {
    state.intent = name;
    await store?.save(state);
  }
  let value: T;
  try {
    value = await work();
  } catch (error) {
    // Admission deferral guarantees work did not start. All other write
    // failures retain the intent, including response loss and process death.
    if (recover && error instanceof WarehouseBackgroundDeferred) {
      delete state.intent;
      await store?.save(state);
    }
    throw error;
  }
  state.receipts[name] = value;
  state.progressAt = Date.now();
  delete state.intent;
  await store?.save(state);
  return value;
}
