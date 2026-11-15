import { setTimeout as delay } from 'node:timers/promises';

export class WarehouseBackgroundDeferred extends Error {
  constructor() {
    super('warehouse-background-deferred');
  }
}

/** Cooperative scheduling for the single leased report builder. Foreground
 * reads and ingestion never enter this governor. While ingestion is pending
 * or has only briefly been idle,
 * target a one-sixth duty cycle between background queries; do not
 * hold a query permit or database transaction during the recovery interval.
 * This is a scheduling budget, not a data/result quota or a CPU reservation. */
export class WarehouseBackgroundBudget {
  private next = 0;
  private busyUntil = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly pending: () => Promise<boolean>) {}

  private async ingestionBusy() {
    // Batches can empty the queue between arrivals. Require a short quiet
    // interval before bypassing recovery debt, rather than starting another
    // heavy query in every inter-batch gap. This never delays ingestion.
    if (await this.pending()) this.busyUntil = Date.now() + 2000;
    return Date.now() < this.busyUntil;
  }

  run<T>(work: () => Promise<T>, signal: AbortSignal, deadline?: number): Promise<T> {
    // Reserve the scheduling turn before probing. Concurrent page components
    // must not all observe the same idle interval and bypass the shared budget.
    const result = this.tail.then(() => this.dispatch(work, signal, deadline));
    this.tail = result.catch(() => {});
    return result;
  }

  private async dispatch<T>(
    work: () => Promise<T>,
    signal: AbortSignal,
    deadline?: number,
  ): Promise<T> {
    signal.throwIfAborted();
    if (deadline !== undefined && deadline <= Date.now() + 1000)
      throw new WarehouseBackgroundDeferred();
    let busy = await this.ingestionBusy();
    while (busy && this.next > Date.now()) {
      if (deadline !== undefined && this.next >= deadline - 1000)
        throw new WarehouseBackgroundDeferred();
      await delay(Math.min(200, this.next - Date.now()), undefined, { signal });
      busy = await this.ingestionBusy();
    }
    signal.throwIfAborted();
    const started = Date.now();
    try {
      return await work();
    } finally {
      // Also account for a query that started while idle: ingestion may have
      // arrived during that query. A subsequent idle probe bypasses the debt.
      this.next = Date.now() + 5 * (Date.now() - started);
    }
  }
}
