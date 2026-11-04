import { testClickHouseURL } from './warehouse-test-target';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { WarehouseReadReferences } from '../../src/lib/liekan/warehouse/read-reference';
import { WarehouseFactGC } from '../../src/lib/liekan/warehouse/fact-gc';
assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
const run = process.env.WAREHOUSE_FEATURE_FIXTURE;
assert.match(run, /^warehouse_feature_data_\d+$/);
const fixture = JSON.parse(await readFile(`.local/ch-implementation/${run}.json`, 'utf8'));
const url = new URL(`postgresql://127.0.0.1:25459/${run}`);
url.username = 'liekan_ch_proto';
url.password = (await readFile('.local/ch-prototype-round2/pg-password', 'utf8')).trim();
const db = new ControlDatabase(url.toString()),
  ch = createWarehouseClient({ url: testClickHouseURL, database: run });
const cases: object[] = [];
const record = async (name: string, work: () => Promise<void>) => {
  await work();
  cases.push({ name, status: 'pass' });
  console.log('PASS ' + name);
};
const [site] = await db.read<any>('SELECT * FROM liekan_warehouse_site WHERE website_id=$1', [
  fixture.site,
]);
const boundary = {
  websiteId: fixture.site,
  epoch: site.epoch,
  publication: site.publication,
  deletionRevision: site.deletion_revision,
};
try {
  await record('reference pins publication, renews and releases', async () => {
    const ref = new WarehouseReadReferences(db);
    await ref.pin(boundary);
    await ref.pin(boundary);
    assert.equal(
      (
        await db.read(
          "SELECT 1 FROM liekan_warehouse_reference WHERE website_id=$1 AND kind='query'",
          [fixture.site],
        )
      ).length,
      1,
    );
    await ref.verify(true);
    await ref.close();
    assert.equal(
      (
        await db.read(
          "SELECT 1 FROM liekan_warehouse_reference WHERE website_id=$1 AND kind='query'",
          [fixture.site],
        )
      ).length,
      0,
    );
  });
  await record('expired ownership rejects a result instead of returning partial data', async () => {
    const ref = new WarehouseReadReferences(db);
    await ref.pin(boundary);
    await db.read(
      "UPDATE liekan_warehouse_reference SET expires_at=clock_timestamp()-interval '1 second' WHERE website_id=$1 AND kind='query'",
      [fixture.site],
    );
    await assert.rejects(ref.verify(), /warehouse-read-reference-lost/);
    assert.equal(ref.signal.aborted, true);
    await ref.close();
  });
  await record('abandoned candidate reclaimed while published candidate survives', async () => {
    const [original] = await ch
      .query({
        query: 'SELECT * FROM warehouse_website_event WHERE _website_id={site:UUID} LIMIT 1',
        query_params: { site: fixture.site },
        format: 'JSONEachRow',
      })
      .then(r => r.json<any>());
    const orphan = randomUUID();
    await ch.insert({
      table: 'warehouse_website_event',
      format: 'JSONEachRow',
      values: [{ ...original, _candidate_id: orphan }],
    });
    const prior = await db.read<any>('SELECT * FROM liekan_warehouse_installation');
    if (!prior.length)
      await db.read(
        `INSERT INTO liekan_warehouse_installation(id,installation_id,schema_version,routing_version,topic_name,topic_id,partition_count,authority,transition,facts_fenced)
      VALUES(1,$1,2,1,'isolated-retention','isolated-retention',1,'clickhouse','none',true)`,
        [randomUUID()],
      );
    else
      await db.read(
        "UPDATE liekan_warehouse_installation SET authority='clickhouse',facts_fenced=true WHERE id=1",
      );
    try {
      for (const id of [orphan, original._candidate_id])
        await db.read(
          `INSERT INTO liekan_warehouse_garbage(candidate_id,website_id,epoch,family) VALUES($1,$2,$3,'website_event') ON CONFLICT DO NOTHING`,
          [id, fixture.site, site.epoch],
        );
      const result = await new WarehouseFactGC(db, ch).collect();
      assert.equal(result.removed, 1);
      assert.equal(result.protectedCandidates, 1);
      const rows = await ch
        .query({
          query:
            'SELECT _candidate_id,count() AS n FROM warehouse_website_event WHERE _candidate_id IN {ids:Array(UUID)} GROUP BY _candidate_id',
          query_params: { ids: [orphan, original._candidate_id] },
          format: 'JSONEachRow',
        })
        .then(r => r.json<any>());
      assert.equal(rows.length, 1);
      assert.equal(rows[0]._candidate_id, original._candidate_id);
      assert.deepEqual(await new WarehouseFactGC(db, ch).collect(), {
        removed: 0,
        protectedCandidates: 0,
      });
    } finally {
      await db.read('DELETE FROM liekan_warehouse_garbage WHERE candidate_id=ANY($1::uuid[])', [
        [orphan, original._candidate_id],
      ]);
      if (!prior.length) await db.read('DELETE FROM liekan_warehouse_installation WHERE id=1');
      else
        await db.read(
          'UPDATE liekan_warehouse_installation SET authority=$1,facts_fenced=$2 WHERE id=1',
          [prior[0].authority, prior[0].facts_fenced],
        );
    }
  });
} catch (e) {
  cases.push({
    name: 'retention',
    status: 'failed',
    error: e instanceof Error ? e.message : 'unknown',
  });
  process.exitCode = 1;
} finally {
  await db.close();
  await ch.close();
}
await writeFile(
  `.local/ch-implementation/warehouse_retention_${Date.now()}.json`,
  JSON.stringify({ fixture: run, cases }, null, 2),
);
console.log(JSON.stringify(cases));
