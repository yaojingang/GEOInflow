export class WarehouseReadBusy extends Error {
  readonly status = 503;
  constructor() {
    super('warehouse-read-capacity-busy');
  }
}

// Capacity limits bound live query memory, not stored data or feature access.
// Timed-out waiters are removed before execution and can be retried by callers.
export class ReadAdmission {
  private active = 0;
  private closed = false;
  private waiting: {
    accept: () => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }[] = [];
  constructor(
    private readonly concurrency: number,
    private readonly maxWaiting = 64,
    private readonly waitMs = 5000,
  ) {
    if (![concurrency, maxWaiting, waitMs].every(n => Number.isSafeInteger(n) && n > 0))
      throw new Error('warehouse-invalid-read-capacity');
  }
  async run<T>(work: () => Promise<T>, signal?: AbortSignal, deadline?: number): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed) throw new WarehouseReadBusy();
    if (this.active < this.concurrency) this.active++;
    else {
      if (this.waiting.length >= this.maxWaiting) throw new WarehouseReadBusy();
      await new Promise<void>((accept, reject) => {
        const remove = (error: Error) => {
          this.waiting = this.waiting.filter(w => w !== entry);
          entry.cleanup();
          reject(error);
        };
        const cancel = () => remove(signal.reason);
        const timer = setTimeout(
          () => remove(new WarehouseReadBusy()),
          deadline === undefined ? this.waitMs : Math.max(1, deadline - Date.now()),
        );
        const entry = {
          accept,
          reject,
          cleanup: () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
          },
        };
        this.waiting.push(entry);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      });
    }
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next.cleanup();
        next.accept();
      } else this.active--;
    }
  }
  close() {
    this.closed = true;
    for (const entry of this.waiting) {
      entry.cleanup();
      entry.reject(new WarehouseReadBusy());
    }
    this.waiting = [];
  }
}
