import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';

// Test-only transport bridge preserves the same destination identity in the
// host app and constrained Docker worker on Docker Desktop.
assert.equal(process.env.LIEKAN_ANALYTICS_ENGINE_TEST, '1');
for (const key of ['DATABASE_URL', 'LIEKAN_ANALYTICS_CLICKHOUSE_URL']) {
  const url = new URL(process.env[key]);
  assert.equal(url.hostname, '127.0.0.1');
  const port = Number(url.port);
  assert(Number.isInteger(port) && port > 1024);
  const server = createServer(socket => {
    const remote = connect({ host: 'host.docker.internal', port });
    socket.on('error', () => remote.destroy());
    remote.on('error', () => socket.destroy());
    socket.pipe(remote);
    remote.pipe(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}
await import('../../dist/liekan-analytics-worker.mjs');
