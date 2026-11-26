import { setTimeout as delay } from 'node:timers/promises';

// Test driver only. Production acknowledgement and deduplication stay in the
// real ingestion route; the driver never writes upload/queue ledger state.
export async function sendDurableBatch(options: {
  body: string;
  signal: AbortSignal;
  send: (body: string, signal: AbortSignal) => Promise<Response>;
  record: (event: { stage: string; attempt: number; status?: number }) => Promise<void>;
  maxAttempts?: number;
  backoffMs?: number;
}) {
  const { body, signal, send, record } = options;
  const input = JSON.parse(body);
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    await record({ stage: 'attempt', attempt });
    let response: Response;
    let value: unknown;
    try {
      response = await send(body, signal);
      // A socket can fail after the HTTP status arrives but before the ACK body.
      if (response.ok) value = await response.json();
    } catch (error) {
      // Fetch network errors and bounded request timeouts have ambiguous ACKs.
      // Identity, authorization, programming and payload errors are never retried.
      if (
        !(error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError'))
      )
        throw error;
      if (signal.aborted || attempt >= (options.maxAttempts ?? 4)) throw error;
      response = undefined;
    }
    if (response?.ok) {
      const ack = value as Record<string, unknown> | null;
      if (
        !ack ||
        ack.requestBatchId !== input.batchId ||
        ack.received !== input.events.length ||
        ack.valid !== input.events.length ||
        ack.rejected !== 0 ||
        typeof ack.batchId !== 'string'
      )
        throw new Error('load-acknowledgement-mismatch');
      await record({ stage: 'acknowledged', attempt, status: response.status });
      return ack as {
        batchId: string;
        requestBatchId: string;
        received: number;
        valid: number;
        rejected: number;
      };
    }
    if (
      response &&
      (![429, 502, 503, 504].includes(response.status) || attempt >= (options.maxAttempts ?? 4))
    )
      throw new Error(`load-http-${response.status}`);
    await record({ stage: 'retry', attempt, status: response?.status });
    await response?.body?.cancel().catch(() => {});
    await delay(Math.min(5000, (options.backoffMs ?? 250) * 2 ** (attempt - 1)), undefined, {
      signal,
    });
  }
}

// Attach rejection handling immediately. A failed sender aborts the ongoing
// reporting phase instead of silently turning a mixed run into an idle run.
export function superviseLoad(run: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  let failure: unknown;
  const done = Promise.resolve()
    .then(() => run(controller.signal))
    .catch(error => {
      failure = error;
      controller.abort(error);
    });
  return {
    signal: controller.signal,
    async guard<T>(work: Promise<T>): Promise<T> {
      // The caller may already have started work when the sender fails. Observe
      // its rejection even if the abort check below prevents entering the race.
      void work.catch(() => {});
      controller.signal.throwIfAborted();
      let rejectAbort: () => void;
      const stopped = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
      });
      try {
        return await Promise.race([work, stopped]);
      } finally {
        controller.signal.removeEventListener('abort', rejectAbort);
      }
    },
    async finish() {
      await done;
      if (failure) throw failure;
    },
  };
}
