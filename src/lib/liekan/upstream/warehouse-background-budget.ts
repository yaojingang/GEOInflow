import { AsyncLocalStorage } from 'node:async_hooks';

// Queue-head age tracks live publication backlog. Hysteresis leaves room
// for brief fluctuations while an already admitted report segment finishes.
const pauseAgeMs = 6000;
const resumeAgeMs = 3000;
const pressureRecheckMs = 1000;

export type WarehouseIngestionPressure = {
  oldestMs: number;
  publishedP95Ms: number | null;
  samples: number;
};
type BudgetStage = 'budget-queue' | 'budget-probe' | 'query-admission' | 'query-execution';

export class WarehouseBackgroundDeferred extends Error {
  constructor(readonly retryAt?: number) {
    super('warehouse-background-deferred');
  }
}

/** Pressure controls claims and durable segment boundaries. SQL within a
 * segment shares one execution lane and its original wall-clock deadline. */
export class WarehouseBackgroundBudget {
  private paused = false;
  private nextFairClaim = 0;
  private pressureGapMs = 0;
  private readonly progress = new AsyncLocalStorage<{ active: boolean }>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly pressure: () => Promise<WarehouseIngestionPressure>,
    private readonly observe: (stage: BudgetStage, ms: number) => void = () => {},
  ) {}

  // Only the serial report scheduler may request the starvation allowance.
  // Maintenance and checkpoints outside an admitted claim keep yielding.
  async claimAfter(reportClaim = false) {
    if (this.progress.getStore()?.active) return;
    const started = performance.now();
    try {
      const { oldestMs } = await this.pressure();
      this.paused = this.paused ? oldestMs > resumeAgeMs : oldestMs >= pauseAgeMs;
      const now = Date.now();
      if (!this.paused) {
        this.nextFairClaim = 0;
        return;
      }
      // Sample frequently so an empty queue resumes immediately. Under continuous
      // pressure, leave ingestion an exclusive interval before the next claim.
      this.pressureGapMs = Math.min(60000, Math.max(10000, oldestMs));
      if (!this.nextFairClaim) this.nextFairClaim = now + this.pressureGapMs;
      if (!reportClaim || now < this.nextFairClaim) return now + pressureRecheckMs;
    } finally {
      this.observe('budget-probe', performance.now() - started);
    }
  }

  get fairClaimDue() {
    return this.paused && this.nextFairClaim > 0 && Date.now() >= this.nextFairClaim;
  }

  // Called after the database lease has been acquired. One complete claim
  // keeps its normal deadline, abort signal, fences and low-priority CH lane.
  async withClaim<T>(work: () => Promise<T>): Promise<T> {
    if (!this.fairClaimDue) return work();
    const grant = { active: true };
    try {
      return await this.progress.run(grant, work);
    } finally {
      grant.active = false;
      this.nextFairClaim = Date.now() + this.pressureGapMs;
    }
  }

  async checkpoint(signal: AbortSignal, deferUntil?: (value: number) => Promise<void>) {
    signal.throwIfAborted();
    const retryAt = await this.claimAfter();
    signal.throwIfAborted();
    if (retryAt !== undefined) {
      await deferUntil?.(retryAt);
      throw new WarehouseBackgroundDeferred(retryAt);
    }
  }

  run<T>(
    work: () => Promise<T>,
    signal: AbortSignal,
    deadline?: number,
    admit: (execute: () => Promise<T>) => Promise<T> = execute => execute(),
  ): Promise<T> {
    const queued = performance.now();
    const result = this.tail.then(async () => {
      this.observe('budget-queue', performance.now() - queued);
      signal.throwIfAborted();
      if (deadline !== undefined && deadline <= Date.now() + 1000)
        throw new WarehouseBackgroundDeferred();
      const waiting = performance.now();
      return admit(async () => {
        const started = performance.now();
        this.observe('query-admission', started - waiting);
        signal.throwIfAborted();
        if (deadline !== undefined && deadline <= Date.now() + 1000)
          throw new WarehouseBackgroundDeferred();
        try {
          return await work();
        } finally {
          this.observe('query-execution', performance.now() - started);
        }
      });
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
