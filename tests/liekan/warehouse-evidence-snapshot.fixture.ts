import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  parseEvidenceQuery,
  queryEvidence,
  readCrawlerEvidence,
} from '../../src/lib/liekan/crawlers/evidence-read';
import { warehouseEvidenceTable } from '../../src/lib/liekan/upstream/warehouse-evidence-table';
import { withinWarehouseReport } from '../../src/lib/liekan/upstream/warehouse-report-snapshot';
import { storedFact } from '../../src/lib/liekan/warehouse/candidate';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';

export async function verifyEvidenceSnapshot({ db, ch, site, batch, owner }: any) {
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  // Exercise the actual aggregate, including overflow modulo UInt256, NULL,
  // duplicate rows and a same-count content replacement. Compare with JS SHA256.
  const q = "SELECT number, if(number=0,NULL,'') AS value FROM numbers(13)";
  const serialized = await ch
    .query({ query: `SELECT toJSONString(tuple(*)) AS value FROM (${q})`, format: 'JSONEachRow' })
    .then((r: any) => r.json());
  const mask = (1n << 256n) - 1n;
  const sum = serialized.reduce(
    (n: bigint, row: any) =>
      n +
      BigInt(
        '0x' +
          Buffer.from(createHash('sha256').update(row.value).digest()).reverse().toString('hex'),
      ),
    0n,
  );
  assert.ok(sum > mask, 'fixture must exercise UInt256 overflow');
  const [actual] = await ch
    .query({
      query: `SELECT count() AS total,toTypeName(sum(reinterpretAsUInt256(SHA256(toJSONString(tuple(*)))))) AS kind,toString(sum(reinterpretAsUInt256(SHA256(toJSONString(tuple(*)))))) AS value FROM (${q})`,
      format: 'JSONEachRow',
    })
    .then((r: any) => r.json());
  assert.equal(actual.kind, 'UInt256');
  assert.equal(actual.value, String(sum & mask));
  await withinWarehouseReport(async () => {
    const descriptor = warehouseEvidenceTable(site, q, {}, 'number');
    assert.equal(await descriptor.count(), 13);
    assert.equal(
      await descriptor.fingerprint(),
      createHash('sha256')
        .update(JSON.stringify(['row-sum-sha256-v1', actual.total, actual.value]))
        .digest('hex'),
    );
    const fp = async (sql: string) => warehouseEvidenceTable(site, sql, {}, 'value').fingerprint();
    assert.notEqual(
      await fp("SELECT toNullable('') AS value"),
      await fp('SELECT CAST(NULL AS Nullable(String)) AS value'),
    );
    assert.notEqual(
      await fp("SELECT 'x' AS value FROM numbers(2)"),
      await fp("SELECT 'y' AS value FROM numbers(2)"),
    );
    assert.notEqual(
      await fp("SELECT 'x' AS value FROM numbers(2)"),
      await fp("SELECT 'x' AS value FROM numbers(4)"),
    );
  });
  const prefix = 'snapshot-' + randomUUID(),
    actor = { id: owner, role: 'admin' };
  const publish = async (items: any[]) => {
    const [state] = await db.read(
      'SELECT epoch::text,publication::text FROM liekan_warehouse_site WHERE website_id=$1',
      [site],
    );
    const version = String(BigInt(state.publication) + 1n),
      attempt = randomUUID(),
      candidate = randomUUID();
    await ch.insert({
      table: 'warehouse_liekan_log',
      format: 'JSONEachRow',
      values: items.map((fields, i) =>
        storedFact(
          'liekan_log',
          factInput('liekan_log', {
            id: prefix + '-' + String(i).padStart(3, '0'),
            website_id: site,
            import_id: batch,
            created_at: '2026-11-02T01:00:00Z',
            path: '/' + prefix + '/' + String(i).padStart(3, '0'),
            method: 'GET',
            status: 200,
            bytes: 1,
            ip_masked: 'synthetic',
            ip_hash: '5'.repeat(64),
            user_agent: 'SyntheticSnapshot',
            location: 'unknown',
            bot: 'GPTBot',
            vendor: 'OpenAI',
            bot_type: '训练',
            verification: 'verified_range',
            source_id: null,
            ai_eligible: true,
            recognition_state: 'recognized',
            ...fields,
          }),
          {
            _website_id: site,
            _record_time: fields.created_at ?? '2026-11-02 01:00:00.000000',
            _session_id: null,
            _epoch: state.epoch,
            _version: version,
            _ordinal: i,
            _attempt_id: attempt,
            _candidate_id: candidate,
            _topic_id: 'fixture-snapshot',
            _partition: 0,
            _offset: String(i),
            _deleted: false,
          },
        ),
      ),
    });
    await ch.insert({
      table: 'warehouse_publication',
      format: 'JSONEachRow',
      values: [
        {
          website_id: site,
          epoch: state.epoch,
          publication: version,
          attempt_id: attempt,
          family: 'liekan_log',
          candidate_id: candidate,
          row_count: items.length,
          digest: 'a'.repeat(64),
          published_at: '2026-11-02 03:00:00.000000',
        },
      ],
    });
    await db.transaction((tx: any) =>
      tx.query('UPDATE liekan_warehouse_site SET publication=$2 WHERE website_id=$1', [
        site,
        version,
      ]),
    );
  };
  await publish(Array.from({ length: 25 }, () => ({})));
  const query = parseEvidenceQuery({
    startAt: +new Date('2026-11-02T00:00:00Z'),
    endAt: +new Date('2026-11-02T02:00:00Z'),
    timezone: 'UTC',
    view: 'requests',
    search: prefix,
    sort: 'path',
    direction: 'asc',
    sourceId: 'manual',
    population: 'all_logs',
    crawlerIdentityScope: 'all',
  });
  const first = await queryEvidence(actor, site, query, 'evidence', readCrawlerEvidence, true);
  assert.equal(first.meta.total, 25);
  await publish([{ id: prefix + '-outside', created_at: '2026-11-01T01:00:00Z' }]);
  const next = await queryEvidence(
    actor,
    site,
    { ...query, page: 2, snapshot: first.meta.snapshot },
    'evidence',
    readCrawlerEvidence,
    true,
  );
  assert.equal(
    next.meta.snapshot,
    first.meta.snapshot,
    'outside-window publication cannot reset history pagination',
  );
  assert.equal(next.meta.reset, false);
  assert.equal(next.meta.page, 2);
  assert.equal(next.rows.length, 5);
  // Updating an existing immutable event's mutable status preserves result count
  // but must invalidate the content snapshot.
  await publish([{ status: 403 }]);
  const changed = await queryEvidence(
    actor,
    site,
    { ...query, page: 2, snapshot: first.meta.snapshot },
    'evidence',
    readCrawlerEvidence,
    true,
  );
  assert.equal(changed.meta.total, 25);
  assert.equal(changed.meta.reset, true);
  assert.equal(changed.meta.page, 1);
  assert.equal(changed.rows[0].status, 403);
}
