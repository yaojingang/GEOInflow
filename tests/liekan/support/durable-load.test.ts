import { describe, expect, it } from 'vitest';
import { sendDurableBatch, superviseLoad } from './durable-load';

describe('durable HTTP load validation', () => {
  it('retries lost acknowledgements with the identical serialized batch', async () => {
    const bodies: string[] = [],
      records: string[] = [];
    const body = JSON.stringify({ batchId: 'stable', events: [{ offset: 0 }] });
    const result = await sendDurableBatch({
      body,
      signal: new AbortController().signal,
      maxAttempts: 3,
      backoffMs: 1,
      record: async event => {
        records.push(event.stage);
      },
      send: async value => {
        bodies.push(value);
        if (bodies.length === 1) throw new TypeError('connection lost after receipt');
        return new Response(
          JSON.stringify({
            requestBatchId: 'stable',
            received: 1,
            valid: 1,
            rejected: 0,
            batchId: 'accepted',
          }),
        );
      },
    });
    expect(bodies).toEqual([body, body]);
    expect(result.batchId).toBe('accepted');
    expect(records).toEqual(['attempt', 'retry', 'attempt', 'acknowledged']);
  });
  it('fails closed on conflict and never records a successful acknowledgement', async () => {
    const records: string[] = [];
    await expect(
      sendDurableBatch({
        body: JSON.stringify({ batchId: 'stable', events: [] }),
        signal: new AbortController().signal,
        record: async event => {
          records.push(event.stage);
        },
        send: async () => new Response('{}', { status: 409 }),
      }),
    ).rejects.toThrow('load-http-409');
    expect(records).toEqual(['attempt']);
  });
  it('retries the same batch if the response body disconnects after HTTP 200', async () => {
    const body = JSON.stringify({ batchId: 'stable', events: [{}] });
    const bodies: string[] = [];
    await sendDurableBatch({
      body,
      signal: new AbortController().signal,
      backoffMs: 1,
      record: async () => {},
      send: async content => {
        bodies.push(content);
        return bodies.length === 1
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new TypeError('response body disconnected'));
                },
              }),
            )
          : Response.json({
              requestBatchId: 'stable',
              received: 1,
              valid: 1,
              rejected: 0,
              batchId: 'accepted',
            });
      },
    });
    expect(bodies).toEqual([body, body]);
  });
  it('rejects partial or unrelated acknowledgements', async () => {
    await expect(
      sendDurableBatch({
        body: JSON.stringify({ batchId: 'stable', events: [{}] }),
        signal: new AbortController().signal,
        record: async () => {},
        send: async () =>
          new Response(
            JSON.stringify({ requestBatchId: 'other', received: 1, valid: 1, rejected: 0 }),
          ),
      }),
    ).rejects.toThrow('load-acknowledgement-mismatch');
  });
  it('propagates sender failure while the reporting stage is still running', async () => {
    const load = superviseLoad(async () => {
      throw new Error('sender stopped');
    });
    await expect(load.guard(new Promise(() => {}))).rejects.toThrow('sender stopped');
    expect(load.signal.aborted).toBe(true);
    await expect(load.finish()).rejects.toThrow('sender stopped');
  });
  it('observes already-started work when the sender has already failed', async () => {
    const load = superviseLoad(async () => {
      throw new Error('sender stopped');
    });
    await expect(load.finish()).rejects.toThrow('sender stopped');
    await expect(load.guard(Promise.reject(new Error('report also failed')))).rejects.toThrow(
      'sender stopped',
    );
  });
});
