import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeUpload, normalizeAutomatic } from './protocol';
import { openSecret, sealSecret, tokenHash } from './secrets';

const source = 'd04e5c89-5a22-4132-bc26-12a3574e8db1';
const generation = '31b52c5c-697d-4a19-bc24-94df3f4cf13e';
const line =
  '192.0.2.20 - - [04/Oct/2026:10:00:00 +0800] "GET /a?secret=test HTTP/1.1" 200 25 "-" "GPTBot"';
const server = (offset: number) => ({ generation, offset, line });
const cf = (time: string) => ({
  ClientIP: '192.0.2.20',
  ClientRequestHost: 'example.com',
  ClientRequestMethod: 'GET',
  ClientRequestURI: '/a?secret=test',
  ClientRequestUserAgent: 'GPTBot',
  EdgeResponseStatus: 200,
  EdgeResponseBodyBytes: 25,
  EdgeStartTimestamp: time,
  RayID: 'same-ray',
  ClientRequestSource: 'eyeball',
});
const cloudflareUpload = (text: string, gzip = true, epoch?: number) =>
  new Request('https://logs.example/upload', {
    method: 'POST',
    body: new Uint8Array(gzip ? gzipSync(text) : Buffer.from(text)),
    headers: {
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
      ...(epoch === undefined ? {} : { 'x-liekan-epoch': String(epoch) }),
    },
  });
describe('automatic log wire protocol', () => {
  it('cancels unfinished input when gzip expansion is rejected', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(gzipSync('x'.repeat(11 * 1024 * 1024)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('https://logs.example/upload', {
      method: 'POST',
      body,
      duplex: 'half',
      headers: { 'content-encoding': 'gzip' },
    } as RequestInit);
    try {
      await expect(decodeUpload(request, 'cloudflare')).rejects.toMatchObject({ status: 413 });
      expect(cancelled).toBe(true);
    } finally {
      await body.cancel().catch(() => {});
    }
  });
  it('preserves identities across re-batching and strips raw IP and query before persistence', () => {
    const a = normalizeAutomatic(
      'server',
      source,
      [server(0), server(200)],
      'example.com',
      'test-secret',
    );
    const b = normalizeAutomatic('server', source, [server(200)], 'example.com', 'test-secret');
    expect(a.records).toHaveLength(2);
    expect(a.records[1].id).toBe(b.records[0].id);
    expect(a.records[0].id).not.toBe(a.records[1].id);
    expect(a.records[0].path).toBe('/a');
    expect(a.records[0].verificationVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(a.records[0].verificationObservedAt).toEqual(expect.any(String));
    expect(JSON.stringify(a)).not.toContain('192.0.2.20');
    expect(JSON.stringify(a)).not.toContain('secret=test');
  });
  it('keeps reused Ray IDs distinct at nanosecond precision and excludes internal requests', () => {
    const a = normalizeAutomatic(
      'cloudflare',
      source,
      [
        cf('2026-10-04T02:00:00.000000001Z'),
        cf('2026-10-04T02:00:00.000000002Z'),
        { ...cf('2026-10-04T02:00:01Z'), ClientRequestSource: 'edgeWorkerFetch' },
      ],
      'example.com',
      'secret',
    );
    expect(a.records).toHaveLength(2);
    expect(a.records[0].id).not.toBe(a.records[1].id);
    expect(a.rejected).toBe(1);
  });
  it('rejects foreign hosts, missing mandatory fields and fabricated status/IP', () => {
    const a = normalizeAutomatic(
      'cloudflare',
      source,
      [
        { ...cf('2026-10-04T02:00:00Z'), ClientRequestHost: 'foreign.example' },
        { ...cf('2026-10-04T02:00:00Z'), ClientIP: undefined },
        { ...cf('2026-10-04T02:00:00Z'), EdgeResponseStatus: 0 },
      ],
      'example.com',
      'secret',
    );
    expect(a.records).toHaveLength(0);
    expect(a.errors).toHaveLength(3);
    expect(JSON.stringify(a.errors)).not.toContain('192.0.2');
  });
  it.each([
    { content: 'test', gzip: true },
    { content: 'tests', gzip: true },
    { content: 'test', gzip: false },
    { content: 'tests', gzip: false },
  ])(
    'accepts the single $content probe with gzip=$gzip and surrounding whitespace',
    async ({ content, gzip }) => {
      const request = cloudflareUpload(` \r\n { "content" : "${content}" } \r\n`, gzip);
      expect(await decodeUpload(request, 'cloudflare')).toEqual({
        test: true,
        events: [],
        epoch: 0,
        batchId: '',
        digest: '',
      });
    },
  );
  it.each([
    '{"content":"test","RayID":"fixture"}',
    '{"content":"tests","RayID":"fixture"}',
    '{"content":"test"}\n{"content":"tests"}',
    `{"content":"test"}\n${JSON.stringify(cf('2026-10-04T02:00:00Z'))}`,
    '{"content":"TEST"}',
    '{"content":"testing"}',
    '{"content":null}',
    '{"content":true}',
    'null',
  ])('rejects non-probe content: %s', async text => {
    await expect(decodeUpload(cloudflareUpload(text), 'cloudflare')).rejects.toMatchObject({
      status: 400,
    });
  });
  it('keeps array-wrapped content on the real-log validation path', async () => {
    const decoded = await decodeUpload(
      cloudflareUpload('[{"content":"test"}]', true, 2),
      'cloudflare',
    );
    expect(decoded.test).toBe(false);
    const parsed = normalizeAutomatic(
      'cloudflare',
      source,
      decoded.events,
      'example.com',
      'secret',
    );
    expect(parsed.records).toHaveLength(0);
    expect(parsed.rejected).toBe(1);
  });
  it('requires an epoch for real logs and preserves their stable batch identity', async () => {
    const event = cf('2026-10-04T02:00:00.000000001Z');
    const text = JSON.stringify(event);
    await expect(decodeUpload(cloudflareUpload(text), 'cloudflare')).rejects.toMatchObject({
      status: 409,
    });
    const decoded = await decodeUpload(cloudflareUpload(text, true, 2), 'cloudflare');
    expect(decoded).toMatchObject({ test: false, epoch: 2, events: [event] });
    expect(await decodeUpload(cloudflareUpload(text, false, 2), 'cloudflare')).toEqual(decoded);
  });
  it.each(['test', 'tests'])('rejects the %s probe on the server protocol', async content => {
    await expect(
      decodeUpload(cloudflareUpload(JSON.stringify({ content })), 'server'),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('bounds gzip expansion and rejects corrupt gzip', async () => {
    await expect(
      decodeUpload(cloudflareUpload('x'.repeat(11 * 1024 * 1024)), 'cloudflare'),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      decodeUpload(
        new Request('https://logs.example/upload', {
          method: 'POST',
          body: new Uint8Array(gzipSync('{"content":"tests"}').subarray(0, 12)),
          headers: { 'content-encoding': 'gzip' },
        }),
        'cloudflare',
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
describe('credential protection', () => {
  it('uses authenticated encryption and a purpose binding', () => {
    const key = Buffer.alloc(32, 9).toString('base64');
    const sealed = sealSecret('long-lived-secret', key, source);
    expect(sealed).not.toContain('long-lived-secret');
    expect(openSecret(sealed, key, source)).toBe('long-lived-secret');
    expect(() => openSecret(sealed, key, 'other-source')).toThrow();
    expect(() => openSecret(sealed, Buffer.alloc(32, 10).toString('base64'), source)).toThrow();
    expect(tokenHash('secret')).toHaveLength(64);
  });
});
