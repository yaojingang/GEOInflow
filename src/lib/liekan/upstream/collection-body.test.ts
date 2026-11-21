// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { readCollectionJson } from './collection-body';

it('counts bytes, parses once and accepts an exact limit with split UTF-8 characters', async () => {
  const bytes = Buffer.from('{"text":"猎看"}');
  let position = 0;
  const request = new Request('http://localhost', {
    method: 'POST',
    duplex: 'half',
    body: new ReadableStream({
      pull(c) {
        if (position === bytes.length) c.close();
        else c.enqueue(bytes.subarray(position, ++position));
      },
    }),
  } as RequestInit);
  expect(await readCollectionJson(request, bytes.length)).toEqual({ text: '猎看' });
  expect(request.bodyUsed).toBe(true);
});

it('rejects an oversized declared length before pulling and does not await stalled cancellation', async () => {
  const pull = vi.fn(),
    cancel = vi.fn(() => new Promise<void>(() => {}));
  const request = new Request('http://localhost', {
    method: 'POST',
    duplex: 'half',
    headers: { 'Content-Length': '100' },
    body: new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
  } as RequestInit);
  await expect(readCollectionJson(request, 99)).rejects.toMatchObject({ size: 100, maxBytes: 99 });
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

it('returns malformed or absent JSON to the existing request validator', async () => {
  expect(
    await readCollectionJson(new Request('http://localhost', { method: 'POST', body: '{' }), 10),
  ).toBeUndefined();
  expect(await readCollectionJson(new Request('http://localhost'), 10)).toBeUndefined();
});
