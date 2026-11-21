import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const queryIds = new AsyncLocalStorage<Set<string>>();

// Several concurrent attempts can share a physical INSERT. Each caller links the
// same ID to its own span before the buffer is flushed.
export function linkPublicationQuery(id?: string) {
  const ids = queryIds.getStore();
  if (!ids) return id;
  const queryId = id ?? randomUUID();
  ids.add(queryId);
  return queryId;
}

export function publicationQueryOptions<T extends { query_id?: string }>(input: T): T {
  const queryId = linkPublicationQuery(input.query_id);
  return queryId && queryId !== input.query_id ? { ...input, query_id: queryId } : input;
}

export function flushOutsidePublicationSpan<T>(work: () => T): T {
  return queryIds.exit(work);
}

// Substeps overlap when candidate families are written concurrently. Keep their
// intervals separate from the additive stages on the attempt log.
export class PublicationTrace {
  readonly spans: {
    name: string;
    startMs: number;
    ms: number;
    failed?: true;
    rows?: number;
    queryIds?: string[];
  }[] = [];

  constructor(private readonly origin = performance.now()) {}

  record(name: string, start: number, failed = false, rows?: number, ids?: Set<string>) {
    this.spans.push({
      name,
      startMs: Math.round((start - this.origin) * 10) / 10,
      ms: Math.round((performance.now() - start) * 10) / 10,
      ...(ids?.size && { queryIds: [...ids] }),
      ...(failed && { failed: true as const }),
      ...(rows !== undefined && { rows }),
    });
  }
}

export function tracePublication<T>(
  trace: PublicationTrace | undefined,
  name: string,
  work: () => Promise<T>,
  rows?: number,
): Promise<T> {
  if (!trace) return work();
  const start = performance.now();
  const ids = new Set<string>();
  return queryIds
    .run(ids, async () => work())
    .then(
      value => {
        trace.record(name, start, false, rows, ids);
        return value;
      },
      error => {
        trace.record(name, start, true, rows, ids);
        throw error;
      },
    );
}
