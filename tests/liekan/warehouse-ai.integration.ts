import { testClickHouseURL } from './warehouse-test-target';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';

assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = process.env.WAREHOUSE_FEATURE_FIXTURE;
assert.match(run, /^warehouse_feature_data_\d+$/);
const fixture = JSON.parse(await readFile(`.local/ch-implementation/${run}.json`, 'utf8'));
const url = new URL(`postgresql://127.0.0.1:25459/${run}`);
url.username = 'liekan_ch_proto';
url.password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
process.env.DATABASE_URL = url.toString();
process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
process.env.LIEKAN_CLICKHOUSE_URL = testClickHouseURL;
process.env.LIEKAN_CLICKHOUSE_DATABASE = run;
delete process.env.CLICKHOUSE_URL;
const db = new pg.Client({ connectionString: url.toString() });
await db.connect();
const owner = randomUUID(),
  conversationId = randomUUID(),
  epoch = randomUUID();
await db.query('INSERT INTO "user"(user_id,username,password,role) VALUES($1,$2,$3,$4)', [
  owner,
  'isolated-ai-' + owner,
  'not-a-login',
  'user',
]);
const [old] = (
  await db.query('SELECT user_id,team_id FROM website WHERE website_id=$1', [fixture.site])
).rows;
const imports = (
  await db.query('SELECT id,accepted FROM liekan_import WHERE website_id=$1', [fixture.site])
).rows;
await db.query(
  'UPDATE liekan_import i SET accepted=(SELECT count(*) FROM liekan_log l WHERE l.website_id=i.website_id AND l.import_id=i.id) WHERE i.website_id=$1',
  [fixture.site],
);
await db.query('UPDATE website SET user_id=$2,team_id=NULL WHERE website_id=$1', [
  fixture.site,
  owner,
]);
await db.query(
  'INSERT INTO liekan_ai_website_state(website_id,epoch,owner_user_id) VALUES($1,$2,$3) ON CONFLICT(website_id) DO UPDATE SET epoch=excluded.epoch,owner_user_id=excluded.owner_user_id,team_id=NULL',
  [fixture.site, epoch, owner],
);
await db.query(
  'INSERT INTO liekan_ai_conversation(id,creator_id,owner_user_id,website_id,website_epoch) VALUES($1,$2,$2,$3,$4)',
  [conversationId, owner, fixture.site, epoch],
);
const { buildAiFactsContext } = await import('../../src/lib/liekan/upstream/ai-facts');
const input = {
  actor: { id: owner, role: 'user' },
  conversationId,
  signal: new AbortController().signal,
  input: {
    clientRequestId: randomUUID(),
    expectedConfigVersion: 1,
    question: 'isolated facts verification',
    startAt: '2026-11-03T00:00:00Z',
    endAt: '2026-11-03T00:30:00Z',
    timezone: 'UTC',
  },
};
const cases: object[] = [];
try {
  process.env.LIEKAN_ANALYTICS_BACKEND = 'postgresql';
  const expected = await buildAiFactsContext(input);
  console.log('PG facts read');
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  const actual = await buildAiFactsContext(input);
  console.log('CH facts read');
  for (const k of ['id', 'generatedAt']) {
    delete (actual as any)[k];
    delete (expected as any)[k];
  }
  assert.deepEqual(actual, expected);
  assert.ok((actual.facts.find(f => f.id === 'summary') as any).data.logs.requests > 0);
  assert.ok((actual.facts.find(f => f.id === 'goals') as any).data.rows.some(r => r.count > 0));
  cases.push({ name: 'nonempty human/log/referral/goal facts exact parity', status: 'pass' });
  await db.query('UPDATE liekan_ai_website_state SET epoch=$2 WHERE website_id=$1', [
    fixture.site,
    randomUUID(),
  ]);
  await assert.rejects(buildAiFactsContext(input), (e: any) => e.code === 'resource_unavailable');
  cases.push({ name: 'old conversation rejected after epoch changes', status: 'pass' });
  await assert.rejects(
    buildAiFactsContext({ ...input, actor: { id: randomUUID(), role: 'admin' } }),
    (e: any) => e.code === 'resource_unavailable',
  );
  cases.push({ name: 'different actor cannot reuse conversation', status: 'pass' });
} catch (e) {
  cases.push({
    name: 'AI integration',
    status: 'failed',
    error: e instanceof Error ? e.message : 'unknown',
    cause: (e as any)?.cause?.message,
  });
  process.exitCode = 1;
} finally {
  await db.query('DELETE FROM liekan_ai_conversation WHERE id=$1', [conversationId]);
  await db.query('DELETE FROM liekan_ai_website_state WHERE website_id=$1 AND owner_user_id=$2', [
    fixture.site,
    owner,
  ]);
  await db.query('UPDATE website SET user_id=$2,team_id=$3 WHERE website_id=$1', [
    fixture.site,
    old.user_id,
    old.team_id,
  ]);
  await db.query('DELETE FROM "user" WHERE user_id=$1', [owner]);
  for (const row of imports)
    await db.query('UPDATE liekan_import SET accepted=$2 WHERE id=$1', [row.id, row.accepted]);
  await db.end();
  await (await import('../../src/lib/liekan/upstream/ai-facts-db')).disconnectAiFactsClient();
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  await (await import('../../src/lib/liekan/warehouse/reader-runtime')).warehouseReader().close();
  await (await import('../../src/lib/prisma')).default.client.$disconnect();
}
const report = { fixture: run, cases };
await writeFile(
  `.local/ch-implementation/warehouse_ai_${Date.now()}.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
process.exit(process.exitCode ?? 0);
