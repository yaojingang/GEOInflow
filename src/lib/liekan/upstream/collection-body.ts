export class CollectionBodyTooLarge extends Error {
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super('collection-body-too-large');
  }
}

/** Bound the original stream, without a tee that retains an unconsumed copy. */
export async function readCollectionJson(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new CollectionBodyTooLarge(declared, maxBytes);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new CollectionBodyTooLarge(size, maxBytes);
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } catch {
      return undefined; // The existing schema supplies the public 400 response.
    }
  } catch (error) {
    // Cancellation must not delay the 413 if an upstream source stalls its
    // cancellation callback. Never read another chunk or parse an oversized body.
    void reader.cancel().catch(() => {});
    if (error instanceof CollectionBodyTooLarge) throw error;
    return undefined;
  } finally {
    reader.releaseLock();
  }
}
