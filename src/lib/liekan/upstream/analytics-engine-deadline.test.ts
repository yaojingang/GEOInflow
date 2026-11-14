// @vitest-environment node
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { engineClient, engineQuery } from './analytics-engine-clickhouse';
it('cancels a delayed response body within the shared deadline and closes its socket', async () => {
  let slow = false,
    closed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.flushHeaders();
    if (!slow) {
      response.end('{"ready":1}\n');
      return;
    }
    response.on('close', () => {
      closed = true;
    });
    const timer = setTimeout(() => {
      timers.delete(timer);
      response.end('{"ready":1}\n');
    }, 400);
    timers.add(timer);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.LIEKAN_ANALYTICS_CLICKHOUSE_URL;
  const port = (server.address() as { port: number }).port;
  process.env.LIEKAN_ANALYTICS_CLICKHOUSE_URL = `http://127.0.0.1:${port}/deadline_test`;
  try {
    expect(await engineQuery('SELECT 1')).toEqual([{ ready: 1 }]);
    slow = true;
    const at = performance.now();
    await expect(engineQuery('SELECT 1', {}, Date.now() + 60)).rejects.toThrow();
    expect(performance.now() - at).toBeLessThan(250);
    await expect.poll(() => closed, { timeout: 250 }).toBe(true);
  } finally {
    await engineClient().close();
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.LIEKAN_ANALYTICS_CLICKHOUSE_URL;
    else process.env.LIEKAN_ANALYTICS_CLICKHOUSE_URL = previous;
  }
});
