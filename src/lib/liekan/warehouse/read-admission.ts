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
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  constructor(
    private readonly concurrency: number,
    private readonly maxWaiting = 64,
    private readonly waitMs = 5000,
  ) {
    if (![concurrency, maxWaiting, waitMs].every(n => Number.isSafeInteger(n) && n > 0))
      throw new Error('warehouse-invalid-read-capacity');
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) throw new WarehouseReadBusy();
    if (this.active < this.concurrency) this.active++;
    else {
      if (this.waiting.length >= this.maxWaiting) throw new WarehouseReadBusy();
      await new Promise<void>((accept, reject) => {
        const entry = { accept, reject, timer: undefined as ReturnType<typeof setTimeout> };
        entry.timer = setTimeout(() => {
          this.waiting = this.waiting.filter(w => w !== entry);
          reject(new WarehouseReadBusy());
        }, this.waitMs);
        this.waiting.push(entry);
      });
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.accept();
      } else this.active--;
    }
  }
  close() {
    this.closed = true;
    for (const entry of this.waiting) {
      clearTimeout(entry.timer);
      entry.reject(new WarehouseReadBusy());
    }
    this.waiting = [];
  }
}
