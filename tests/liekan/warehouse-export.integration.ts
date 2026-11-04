import { testClickHouseURL } from './warehouse-test-target';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';

// Read-only diagnostics reuse one synthetic reporting fixture. They never attach
// to the downloaded production clone and do not rebuild large DBs on each fix.
assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const files = (await readdir('.local/ch-implementation'))
  .filter(f => /^warehouse_reporting_\d+\.json$/.test(f))
  .sort();
const run = process.env.WAREHOUSE_EXPORT_FIXTURE ?? files.at(-1)?.replace('.json', '');
assert.match(run, /^warehouse_reporting_\d+$/);
const url = new URL(`postgresql://127.0.0.1:25459/${run}`);
url.username = 'liekan_ch_proto';
url.password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const pgReader = new pg.Client({
  connectionString: url.toString(),
  options: '-c default_transaction_read_only=on',
});
await pgReader.connect();
const [{ website_id: site }] = (
  await pgReader.query("SELECT website_id FROM website WHERE name='Isolated reporting fixture'")
).rows;
const [{ session_id: session }] = (
  await pgReader.query('SELECT session_id FROM session WHERE website_id=$1', [site])
).rows;
await pgReader.end();
process.env.DATABASE_URL = url.toString();
process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
process.env.LIEKAN_CLICKHOUSE_URL = testClickHouseURL;
process.env.LIEKAN_CLICKHOUSE_DATABASE = run;
delete process.env.CLICKHOUSE_URL;
delete process.env.LIEKAN_QUEUE_BROKERS;
const start = new Date('2026-11-03T00:00:00Z'),
  end = new Date('2026-11-03T09:00:00Z');
const filters = { startDate: start, endDate: end, timezone: 'UTC', unit: 'day' };
const cases: object[] = [];
async function check(name: string, work: () => Promise<void>) {
  if (process.env.WAREHOUSE_EXPORT_CASE && process.env.WAREHOUSE_EXPORT_CASE !== name) return;
  if (
    process.env.WAREHOUSE_EXPORT_CASES &&
    !new RegExp(process.env.WAREHOUSE_EXPORT_CASES).test(name)
  )
    return;
  try {
    await work();
    cases.push({ name, status: 'pass' });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({
      name,
      status: 'failed',
      error: error instanceof Error ? error.message : 'unknown',
    });
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : 'unknown'}`);
    process.exitCode = 1;
  }
}
const { prepareFeatureExport } = await import('../../src/lib/liekan/upstream/feature-exports');
const { withoutQueryCache, bindCacheRequest } = await import(
  '../../src/lib/liekan/upstream/cache-context'
);
const { WarehouseExportArtifact, downloadWarehouseExport } = await import(
  '../../src/lib/liekan/upstream/warehouse-export-artifact'
);
const { withinWarehouseReport } = await import(
  '../../src/lib/liekan/upstream/warehouse-report-snapshot'
);
const { randomUUID } = await import('node:crypto');
const { rm, mkdir } = await import('node:fs/promises');
const JSZip = (await import('jszip')).default;
const Papa = (await import('papaparse')).default;
const owner = randomUUID(),
  directory = `.local/ch-implementation/export-${Date.now()}`;
process.env.LIEKAN_EXPORT_DIRECTORY = directory;
const abort = new AbortController(),
  website = { id: site, name: 'Isolated reporting fixture', domain: 'fixture.invalid' };
let large: InstanceType<typeof WarehouseExportArtifact>;
async function exported(extra: Record<string, unknown> = {}) {
  return withoutQueryCache(async () => {
    const request = new Request(`http://localhost/api/liekan/websites/${site}/exports`, {
      method: 'POST',
      headers: { authorization: 'Bearer isolated-export-test' },
    });
    bindCacheRequest(request, { user: { id: owner, role: 'admin' } }, undefined, async () => true);
    const payload: any = {
      startAt: +start,
      endAt: +end,
      timezone: 'UTC',
      format: 'zip',
      sections: ['summary', 'dimensions', 'events', 'sessions', 'config'],
      ...extra,
    };
    if (payload.kind) delete payload.sections;
    const response = await prepareFeatureExport(website, payload, abort.signal);
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.equal(frames.at(-1).type, 'complete', JSON.stringify(frames.at(-1)));
    const file = frames.find(f => f.type === 'file');
    assert.ok(file?.downloadUrl);
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const id = file.downloadUrl.split('/').at(-1);
    const download = await downloadWarehouseExport(site, owner, id, abort.signal);
    assert.equal(Number(download.headers.get('content-length')), file.size);
    return { file, bytes: Buffer.from(await download.arrayBuffer()), id };
  });
}
await check('all sections and both locales from CH', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    const { bytes } = await exported({ locale });
    const zip = await JSZip.loadAsync(bytes);
    assert.equal(Object.keys(zip.files).length, 13);
    const pages = Papa.parse(await zip.file('pages.csv').async('string'), {
      header: true,
      skipEmptyLines: true,
    }).data;
    assert.equal(pages.length, 2);
    assert.deepEqual(pages.map((r: any) => r[locale === 'en-US' ? 'Page' : 'name']).sort(), [
      '/0',
      '/8',
    ]);
    const sessions = await zip.file('sessions.csv').async('string');
    assert.ok(!sessions.includes(session));
    assert.match(sessions, /visitor-/);
    assert.equal(
      JSON.parse(await zip.file('manifest.json').async('string')).consistency,
      'published-generation',
    );
  }
});
await check('geography and keywords use bounded download protocol', async () => {
  for (const kind of ['geography', 'source-keywords']) {
    const { bytes } = await exported({ kind, format: 'csv', sections: undefined });
    assert.ok(bytes.length > 0);
  }
});
await check('large CSV exceeds former bytes and row ceilings', async () => {
  large = new WarehouseExportArtifact(site, owner, abort.signal);
  await large.initialize();
  await large.csv('pages.csv', ['name', 'views'], async consume => {
    for (let at = 0; at < 100001; at += 500)
      await consume(
        Array.from({ length: Math.min(500, 100001 - at) }, (_, i) => ({
          name: `/large/${at + i}/` + 'x'.repeat(600),
          views: 1,
        })),
      );
  });
  const frame = await withinWarehouseReport(() => large.complete('csv', { rows: 100001 }));
  assert.ok(frame.size > 50 * 1024 * 1024);
  assert.equal(large.files[0].rows, 100001);
  const download = await downloadWarehouseExport(site, owner, large.id, abort.signal);
  let bytes = 0;
  for await (const chunk of download.body as any) bytes += chunk.byteLength;
  assert.equal(bytes, frame.size);
  await assert.rejects(
    () => downloadWarehouseExport(site, randomUUID(), large.id, abort.signal),
    /导出文件不存在/,
  );
  await assert.rejects(
    () => downloadWarehouseExport(site, owner, '..', abort.signal),
    /导出文件不存在/,
  );
});
await check('cancel removes incomplete artifact', async () => {
  const cancellation = new AbortController(),
    artifact = new WarehouseExportArtifact(site, owner, cancellation.signal);
  await artifact.initialize();
  cancellation.abort();
  await assert.rejects(
    () => artifact.csv('pages.csv', ['name'], consume => consume([{ name: '/cancel' }])),
    /导出已取消/,
  );
  await artifact.remove();
  assert.ok(!(await readdir(directory)).includes(artifact.id));
});
await rm(directory, { recursive: true, force: true });
await (await import('../../src/lib/liekan/warehouse/reader-runtime')).warehouseReader().close();
await writeFile(
  `.local/ch-implementation/warehouse_export_${Date.now()}.json`,
  JSON.stringify({ fixture: run, cases }, null, 2),
  { mode: 0o600 },
);
