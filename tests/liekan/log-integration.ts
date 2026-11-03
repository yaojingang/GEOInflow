import assert from 'node:assert/strict';
import { reviewLifecycle } from './log-lifecycle-review';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { POST as receiveLogBatch } from '../../src/app/api/liekan/log-sources/[sourceId]/batches/route';
import prisma from '../../src/lib/prisma';
import { transaction, query } from '../../src/lib/liekan/upstream/server';
import {
  createSource,
  activateSource,
  heartbeat,
  receiveBatch,
  processBatch,
  manageSource,
  listSources,
} from '../../src/lib/liekan/log-ingestion/service';
import { getQueue, LOG_QUEUE } from '../../src/lib/liekan/log-ingestion/queue';
import { recoverBatches } from '../../src/lib/liekan/log-ingestion/recovery';
import { maintainProvider } from '../../src/lib/liekan/log-ingestion/provider';
import { openPlatformSecret } from '../../src/lib/liekan/log-ingestion/secrets';
import { importLogs } from '../../src/lib/liekan/store';
import { resetLiekanStatistics, stopWebsiteSources } from '../../src/lib/liekan/upstream/lifecycle';
import {
  beginCloudflare,
  acceptCloudflareCallback,
  finalizeCloudflare,
  maintainCloudflare,
  logpushConfiguration,
} from '../../src/lib/liekan/log-ingestion/cloudflare';

const userId = randomUUID(),
  websiteId = randomUUID(),
  otherId = randomUUID();
await prisma.client.user.create({
  data: {
    id: userId,
    username: 'log-integration',
    password: 'test-only-disabled-login',
    role: 'admin',
  },
});
for (const id of [websiteId, otherId])
  await prisma.client.website.create({
    data: { id, userId, name: 'integration', domain: 'example.com' },
  });
const identity = { userId };
const first = await transaction(tx => createSource(tx, websiteId, 'server', identity));
assert.equal(first.source.state, 'configuring');
await heartbeat(first.source.id, first.token, {
  version: '1.0.0',
  pending: 0,
  bytes: 0,
  gap: false,
  errorCode: 'none',
});
const now = new Date(Date.now() + 2000);
const time = now.toISOString();
const combined = `192.0.2.5 - - [${String(now.getUTCDate()).padStart(2, '0')}/${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][now.getUTCMonth()]}/${now.getUTCFullYear()}:${now.toISOString().slice(11, 19)} +0000] "GET /article?secret=removed HTTP/1.1" 200 64 "-" "GPTBot"`;
const generation = randomUUID(),
  event = { generation, offset: 0, line: combined };
function upload(sourceId: string, token: string, batchId: string, events = [event], epoch = 1) {
  return receiveBatch(
    new Request(`https://logs.example/api/liekan/log-sources/${sourceId}/batches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, batchId, events, epoch }),
    }),
    sourceId,
  );
}
const requestId = randomUUID(),
  ack: any = await upload(first.source.id, first.token, requestId);
assert.equal(ack.requestBatchId, requestId);
assert.equal(ack.valid, 1);
const privatePayload = JSON.stringify(
  (await query('SELECT payload FROM liekan_ingest_batch WHERE id=$1::uuid', ack.batchId))[0],
);
assert.equal(privatePayload.includes('192.0.2.5'), false);
assert.equal(privatePayload.includes('secret=removed'), false);
const duplicate: any = await upload(first.source.id.toUpperCase(), first.token, requestId);
assert.equal(duplicate.duplicate, true);
await assert.rejects(
  upload(first.source.id, first.token, requestId, [
    { ...event, line: combined.replace('64', '65') },
  ]),
  /同一批次/,
);
await assert.rejects(
  upload(first.source.id, first.token, randomUUID(), [
    event,
    { ...event, line: combined.replace('64', '65') },
  ]),
  /同一事件/,
);
await processBatch(ack.batchId);
await processBatch(ack.batchId);
assert.equal(
  (await query('SELECT count(*)::int AS n FROM liekan_log WHERE website_id=$1::uuid', websiteId))[0]
    .n,
  1,
);
assert.equal(
  (
    await query(
      'SELECT count(*)::int AS n FROM liekan_effective_log WHERE website_id=$1::uuid',
      websiteId,
    )
  )[0].n,
  1,
);
const rebatch: any = await upload(first.source.id, first.token, randomUUID());
await processBatch(rebatch.batchId);
assert.equal(
  (await query('SELECT duplicates FROM liekan_ingest_batch WHERE id=$1::uuid', rebatch.batchId))[0]
    .duplicates,
  1,
);
await transaction(tx =>
  tx.$executeRawUnsafe('DELETE FROM liekan_ingest_batch WHERE id=$1::uuid', ack.batchId),
);
assert.equal(((await upload(first.source.id, first.token, requestId)) as any).duplicate, true);
await assert.rejects(
  importLogs(
    websiteId,
    'example.com',
    {
      format: 'json',
      records: [
        { ip: '192.0.2.5', path: '/manual', time, status: 200, bytes: 1, userAgent: 'GPTBot' },
      ],
    },
    identity,
  ),
  /重叠/,
);
const other = await transaction(tx => createSource(tx, otherId, 'server', identity));
await assert.rejects(upload(first.source.id, other.token, randomUUID()), /凭据/);
// A durable ACK survives both exhausted retry state and expiry/deletion of its vendor job.
const recovering: any = await upload(first.source.id, first.token, randomUUID(), [
  { ...event, offset: 300 },
]);
const queue = await getQueue();
await queue.deleteJob(LOG_QUEUE, recovering.batchId);
await queue.send(
  LOG_QUEUE,
  { batchId: recovering.batchId },
  { id: recovering.batchId, retryLimit: 0 },
);
await queue.fail(LOG_QUEUE, recovering.batchId, { message: 'test transient processing failure' });
assert.equal((await queue.getJobById(LOG_QUEUE, recovering.batchId))?.state, 'failed');
await transaction(tx =>
  tx.$executeRawUnsafe(
    "UPDATE liekan_ingest_batch SET received_at=now()-interval '8 days' WHERE id=$1::uuid",
    recovering.batchId,
  ),
);
await recoverBatches();
assert.equal((await queue.getJobById(LOG_QUEUE, recovering.batchId))?.state, 'retry');
await queue.deleteJob(LOG_QUEUE, recovering.batchId);
await transaction(tx =>
  tx.$executeRawUnsafe(
    'UPDATE liekan_ingest_batch SET last_recovery_at=NULL WHERE id=$1::uuid',
    recovering.batchId,
  ),
);
await recoverBatches();
assert.equal((await queue.getJobById(LOG_QUEUE, recovering.batchId))?.state, 'created');
await processBatch(recovering.batchId);
assert.equal(
  (await query('SELECT state FROM liekan_ingest_batch WHERE id=$1::uuid', recovering.batchId))[0]
    .state,
  'processed',
);
// Concurrent installs require a recoverable confirmation when the primary policy changed.
const contender = await transaction(tx => createSource(tx, websiteId, 'server', identity));
const winning = await transaction(tx => createSource(tx, websiteId, 'server', identity));
const healthy = { version: '1', pending: 0, bytes: 0, gap: false, errorCode: 'none' };
await heartbeat(winning.source.id, winning.token, healthy);
assert.equal((await heartbeat(contender.source.id, contender.token, healthy)).state, 'paused');
assert.equal(
  (await listSources(websiteId)).find(row => row.id === contender.source.id)?.errorCode,
  'confirmation-required',
);
await manageSource(websiteId, contender.source.id, { action: 'select' }, identity);
await transaction(tx =>
  tx.$executeRawUnsafe(
    'UPDATE liekan_log_source SET credential_hash=NULL WHERE id=$1::uuid',
    contender.source.id,
  ),
);
await assert.rejects(
  manageSource(websiteId, contender.source.id, { action: 'select' }, identity),
  /凭据/,
);
await manageSource(websiteId, first.source.id, { action: 'select' }, identity);
const pending: any = await upload(first.source.id, first.token, randomUUID(), [
  { ...event, offset: 100 },
]);
await transaction(tx => resetLiekanStatistics(tx, websiteId, identity));
await processBatch(pending.batchId);
assert.equal(
  (
    await query('SELECT state,payload FROM liekan_ingest_batch WHERE id=$1::uuid', pending.batchId)
  )[0].state,
  'cancelled',
);
await assert.rejects(upload(first.source.id, first.token, randomUUID()), /代次/);
assert.equal(
  (
    await heartbeat(first.source.id, first.token, {
      version: '1',
      pending: 0,
      bytes: 0,
      gap: false,
    })
  ).epoch,
  2,
);
// OAuth state/cookie binding, callback-only staging, authenticated finalization and owned job isolation.
await transaction(tx =>
  tx.$executeRawUnsafe(
    'INSERT INTO liekan_worker_state(id,heartbeat_at,version) VALUES($1,now(),$2)',
    'integration',
    '1.0.0',
  ),
);
const flow = await beginCloudflare(websiteId, identity),
  state = new URL(flow.authorizationUrl).searchParams.get('state');
const originalFetch = globalThis.fetch;
const mutations: any[] = [];
assert.equal(
  logpushConfiguration(first.source, { receiverToken: first.token } as any, 2).output_options
    .timestamp_format,
  'rfc3339ns',
);
let job: any;
let createAttempts = 0;
const destinationStatuses: number[] = [];
async function pushCloudflare(destination: string, text: string, authorization?: string | null) {
  const endpoint = new URL(destination);
  const headers = new Headers({ 'content-encoding': 'gzip' });
  for (const [key, value] of endpoint.searchParams)
    if (key.startsWith('header_')) headers.set(key.slice(7), value);
  if (authorization === null) headers.delete('authorization');
  else if (authorization !== undefined) headers.set('authorization', authorization);
  const sourceId = endpoint.pathname.split('/').at(-2);
  assert.ok(sourceId);
  return receiveLogBatch(
    new Request(`${endpoint.origin}${endpoint.pathname}`, {
      method: 'POST',
      headers,
      body: new Uint8Array(gzipSync(text)),
    }),
    { params: Promise.resolve({ sourceId }) },
  );
}
async function logCounts() {
  return (
    await query(
      `SELECT (SELECT count(*)::int FROM liekan_ingest_batch) AS batches,
        (SELECT count(*)::int FROM liekan_import) AS imports,
        (SELECT count(*)::int FROM liekan_log) AS logs,
        (SELECT count(*)::int FROM liekan_jobs.job WHERE name=$1) AS queued`,
      LOG_QUEUE,
    )
  )[0];
}
globalThis.fetch = (async (url, init: any) => {
  const path = String(url);
  if (path.endsWith('/revoke')) return new Response(null, { status: 200 });
  if (path.endsWith('/token'))
    return Response.json({
      access_token: 'integration-access',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  if (path.includes('/zones/?'))
    return Response.json({
      success: true,
      result: [{ id: 'a'.repeat(32), name: 'example.com', status: 'active' }],
    });
  if (path.endsWith('/logpush/datasets/http_requests/fields'))
    return Response.json({ success: true, result: {} });
  if (path.includes('/logpush/jobs')) {
    if (init?.method === 'POST') {
      const definition = JSON.parse(init.body);
      createAttempts++;
      // Exercise a failed destination check, then retry with the configured credential.
      const probe = await pushCloudflare(
        definition.destination_conf,
        '{"content":"test"}',
        createAttempts === 1 ? `Bearer ${'A'.repeat(43)}` : undefined,
      );
      destinationStatuses.push(probe.status);
      if (!probe.ok)
        return Response.json(
          { success: false, errors: [{ code: 1002, message: 'error validating destination' }] },
          { status: 400 },
        );
      assert.deepEqual(await probe.json(), { test: true });
      job = { id: 19, ...definition };
      mutations.push(job);
      return Response.json({ success: true, result: job });
    }
    if (init?.method === 'PUT') {
      const changes = JSON.parse(init.body);
      if (changes.destination_conf) {
        const probe = await pushCloudflare(changes.destination_conf, '{"content":"tests"}');
        assert.equal(probe.status, 200);
        assert.deepEqual(await probe.json(), { test: true });
      }
      Object.assign(job, changes);
      mutations.push(changes);
      return Response.json({ success: true, result: job });
    }
    return Response.json({
      success: true,
      result: [
        ...(job ? [job] : []),
        {
          id: 2,
          name: 'customer-job',
          dataset: 'http_requests',
          destination_conf: 'https://customer.example',
          enabled: true,
        },
      ],
    });
  }
  throw new Error('Unexpected provider endpoint');
}) as typeof fetch;
try {
  const callback = `https://logs.example/api/liekan/oauth/cloudflare/callback?state=${state}&code=integration-code`;
  await assert.rejects(acceptCloudflareCallback(new Request(callback)), /流程/);
  const headers = { cookie: flow.cookie.split(';')[0] },
    request = new Request('https://logs.example', { headers });
  await acceptCloudflareCallback(new Request(callback, { headers }));
  const zones: any = await finalizeCloudflare(
    websiteId,
    { flowId: flow.flowId },
    identity,
    request,
  );
  assert.equal(zones.zones[0].name, 'example.com');
  assert.equal(
    (await query('SELECT count(*)::int AS n FROM liekan_log_source WHERE kind=$1', 'cloudflare'))[0]
      .n,
    0,
  );
  await assert.rejects(
    finalizeCloudflare(otherId, { flowId: flow.flowId }, identity, request),
    /身份/,
  );
  const confirmed: any = await finalizeCloudflare(
    websiteId,
    { flowId: flow.flowId, zoneId: 'a'.repeat(32), acceptCosts: true },
    identity,
    request,
  );
  const beforeCounts = await logCounts();
  const beforeSource = (
    await query('SELECT * FROM liekan_log_source WHERE id=$1::uuid', confirmed.sourceId)
  )[0];
  const workerId = randomUUID();
  await assert.rejects(
    maintainProvider(confirmed.sourceId, 'configure', workerId),
    /Provider temporarily unavailable/,
  );
  const failedSource = (
    await query('SELECT * FROM liekan_log_source WHERE id=$1::uuid', confirmed.sourceId)
  )[0];
  assert.equal(failedSource.state, 'configuring');
  assert.equal(failedSource.error_code, 'provider-unavailable');
  assert.equal(failedSource.credential_hash, beforeSource.credential_hash);
  const beforeProvider = JSON.parse(
    openPlatformSecret(beforeSource.provider_config, confirmed.sourceId),
  );
  const failedProvider = JSON.parse(
    openPlatformSecret(failedSource.provider_config, confirmed.sourceId),
  );
  for (const key of ['accessToken', 'receiverToken', 'zoneId'])
    assert.ok(failedProvider[key] === beforeProvider[key]);
  assert.equal(failedSource.provider_job_id, null);
  assert.equal(failedSource.provider_lease, null);
  assert.equal(failedSource.last_test_at, null);
  assert.equal(job, undefined);
  await maintainProvider(confirmed.sourceId, 'configure', workerId);
  assert.deepEqual(destinationStatuses, [401, 200]);
  assert.equal(createAttempts, 2);
  assert.equal(job.enabled, true);
  const destination = job.destination_conf;
  const legacyProbe = await pushCloudflare(destination, ' \r\n { "content": "tests" } \r\n');
  assert.equal(legacyProbe.status, 200);
  assert.deepEqual(await legacyProbe.json(), { test: true });
  assert.equal((await pushCloudflare(destination, '{"content":"test"}', null)).status, 401);
  assert.equal(
    (await pushCloudflare(destination, '{"content":"test","RayID":"fixture"}')).status,
    400,
  );
  assert.equal(
    (await pushCloudflare(destination, '{"content":"test"}\n{"content":"tests"}')).status,
    400,
  );
  const activeSource = (
    await query('SELECT * FROM liekan_log_source WHERE id=$1::uuid', confirmed.sourceId)
  )[0];
  assert.equal(activeSource.state, 'active');
  assert.equal(activeSource.error_code, null);
  assert.equal(activeSource.credential_hash, beforeSource.credential_hash);
  assert.equal(activeSource.provider_job_id, '19');
  assert.equal(activeSource.provider_lease, null);
  assert.ok(activeSource.last_test_at);
  assert.equal(activeSource.last_received_at, null);
  assert.equal(activeSource.last_processed_at, null);
  assert.deepEqual(await logCounts(), beforeCounts);
  assert.equal(
    (
      await query(
        'SELECT count(*)::int AS n FROM liekan_log_interval WHERE website_id=$1::uuid AND ends_at IS NULL',
        websiteId,
      )
    )[0].n,
    1,
  );
  const cloudflareEvent = JSON.stringify({
    ClientIP: '192.0.2.20',
    ClientRequestHost: 'example.com',
    ClientRequestMethod: 'GET',
    ClientRequestURI: '/cloudflare?secret=removed',
    ClientRequestUserAgent: 'GPTBot',
    EdgeResponseStatus: 200,
    EdgeResponseBodyBytes: 25,
    EdgeStartTimestamp: new Date(Date.now() + 2000).toISOString(),
    RayID: 'integration-ray',
    ClientRequestSource: 'eyeball',
  });
  const response = await pushCloudflare(destination, cloudflareEvent);
  assert.equal(response.status, 200);
  const received: any = await response.json();
  assert.equal(received.valid, 1);
  assert.equal(received.rejected, 0);
  await processBatch(received.batchId);
  const repeated = await pushCloudflare(destination, cloudflareEvent);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).duplicate, true);
  const rebatched = await pushCloudflare(destination, `${cloudflareEvent}\n${cloudflareEvent}`);
  assert.equal(rebatched.status, 200);
  const rebatchedAck: any = await rebatched.json();
  assert.equal(rebatchedAck.valid, 2);
  await processBatch(rebatchedAck.batchId);
  assert.equal(
    (
      await query(
        'SELECT duplicates FROM liekan_ingest_batch WHERE id=$1::uuid',
        rebatchedAck.batchId,
      )
    )[0].duplicates,
    2,
  );
  assert.equal(
    (
      await query(
        'SELECT count(*)::int AS n FROM liekan_log WHERE source_id=$1::uuid',
        confirmed.sourceId,
      )
    )[0].n,
    1,
  );
  const processedSource = (
    await query(
      'SELECT last_received_at,last_processed_at FROM liekan_log_source WHERE id=$1::uuid',
      confirmed.sourceId,
    )
  )[0];
  assert.ok(processedSource.last_received_at);
  assert.ok(processedSource.last_processed_at);
  await manageSource(websiteId, confirmed.sourceId, { action: 'pause' }, identity);
  await maintainCloudflare(confirmed.sourceId, 'health');
  assert.equal(job.enabled, false);
  await manageSource(websiteId, confirmed.sourceId, { action: 'select' }, identity);
  await maintainProvider(confirmed.sourceId, 'configure', workerId);
  assert.equal(job.enabled, true);
  assert.equal(job.id, 19);
  assert.equal(createAttempts, 2);
  await transaction(tx => stopWebsiteSources(tx, websiteId));
  await maintainCloudflare(confirmed.sourceId, 'disconnect');
  assert.equal(
    mutations.some(value => value.id === 2),
    false,
  );
} finally {
  globalThis.fetch = originalFetch;
}
await reviewLifecycle(userId);
// The rolling limit retains room for a burst that follows ordinary traffic.
const quotaId = randomUUID();
await prisma.client.website.create({
  data: { id: quotaId, userId, name: 'quota', domain: 'example.com' },
});
const quota = await transaction(tx => createSource(tx, quotaId, 'server', identity));
await heartbeat(quota.source.id, quota.token, {
  version: '1',
  pending: 0,
  bytes: 0,
  gap: false,
  errorCode: 'none',
});
async function seedQuota(start: number, end: number) {
  await transaction(tx =>
    tx.$executeRawUnsafe(
      "INSERT INTO liekan_ingest_batch(id,website_id,source_id,epoch,digest,received,valid,rejected,state) SELECT md5($1::text||g::text)::uuid,$1::uuid,$2::uuid,1,md5('quota-'||g::text),0,0,0,'processed' FROM generate_series($3::int,$4::int) g",
      quotaId,
      quota.source.id,
      start,
      end,
    ),
  );
}
await seedQuota(1, 600);
assert.equal(((await upload(quota.source.id, quota.token, randomUUID())) as any).valid, 1);
await seedQuota(601, 1199);
await assert.rejects(
  upload(quota.source.id, quota.token, randomUUID()),
  error => (error as any).status === 429,
);
assert.equal(
  (
    await query(
      "SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname=current_schema() AND tablename='liekan_log' AND indexname='liekan_log_import'",
    )
  )[0].n,
  1,
);
await (await getQueue()).stop();
await prisma.client.$disconnect();
console.log(
  'PASS: isolated migrations and vendor bootstrap; durable ACK, privacy, case/rebatch dedup, conflicts, interval policy, reset fencing, scoped credentials, OAuth binding, authenticated gzip destination probes, provider retry and owned Logpush lifecycle, bounded burst quota and import index.',
);
