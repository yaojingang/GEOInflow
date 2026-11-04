import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { secret } from '../../src/lib/crypto';
import { createSecureToken } from '../../src/lib/jwt';
import { exportEvidence } from '../../src/lib/liekan/crawlers/evidence-export';
import {
  evidenceInputs,
  parseEvidenceQuery,
  queryEvidence,
  readReconciliation,
} from '../../src/lib/liekan/crawlers/evidence-read';
import { crawlerTransaction } from '../../src/lib/liekan/upstream/crawler-access';
import { warehouseEvidenceCatalog } from '../../src/lib/liekan/upstream/warehouse-evidence-catalog';
import { withinWarehouseReport } from '../../src/lib/liekan/upstream/warehouse-report-snapshot';
export async function verifyLargeEvidenceCatalog({ db, site, owner, run }: any) {
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  process.env.APP_SECRET = 'isolated-catalog-' + run;
  const prefix = '/catalog-' + randomUUID() + '-',
    added = 100005,
    actor = { id: owner, role: 'admin' };
  const [before] = await db.read(
    'SELECT count(*)::int AS n FROM liekan_catalog WHERE website_id=$1',
    [site],
  );
  for (let start = 0; start < added; start += 1000) {
    const paths = Array.from(
      { length: Math.min(1000, added - start) },
      (_, i) => prefix + String(start + i).padStart(6, '0'),
    );
    await db.transaction((tx: any) =>
      tx.query(
        "INSERT INTO liekan_catalog(website_id,path,title,content_type) SELECT $1,path,'Synthetic catalog','article' FROM unnest($2::text[]) path",
        [site, paths],
      ),
    );
  }
  const query = parseEvidenceQuery(
    {
      startAt: +new Date('2026-11-02T00:00:00Z'),
      endAt: +new Date('2026-11-02T02:00:00Z'),
      timezone: 'UTC',
      sourceId: 'manual',
      hostname: 'fixture.invalid',
      sort: 'path',
      direction: 'asc',
    },
    true,
  );
  await withinWarehouseReport(async () => {
    const input = await crawlerTransaction(tx => evidenceInputs(tx, actor, site, query));
    assert.equal(input.catalog.length, 0, 'CH evidence must not retain the complete catalog');
    assert.equal(input.catalogCount, before.n + added);
    assert.equal((await warehouseEvidenceCatalog(site)).count, before.n + added);
  });
  const first = await queryEvidence(actor, site, query, 'reconciliation', readReconciliation, true);
  assert.equal(first.meta.total, before.n + added);
  assert.equal(first.rows.length, 20);
  const last = await queryEvidence(
    actor,
    site,
    { ...query, page: Math.ceil(first.meta.total / 20), snapshot: first.meta.snapshot },
    'reconciliation',
    readReconciliation,
    true,
  );
  assert.equal(last.meta.reset, false);
  assert.equal(last.rows.length, first.meta.total % 20 || 20);
  const token = createSecureToken({ userId: owner }, secret(), { expiresIn: 900 });
  const response = await exportEvidence(
    actor,
    site,
    {
      kind: 'reconciliation',
      query,
      locale: 'en-US',
      policySnapshot: first.meta.policySnapshot,
      viewSnapshot: first.meta.snapshot,
    },
    new Request('http://localhost/evidence', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
    }),
    ['reconciliation'],
  );
  let count = 0,
    bytes = 0,
    tail = '',
    maxChunk = 0;
  for await (const chunk of response.body as any) {
    bytes += chunk.length;
    maxChunk = Math.max(maxChunk, chunk.length);
    const lines = (tail + Buffer.from(chunk).toString('utf8')).split('\r\n');
    tail = lines.pop();
    count += lines.filter(line => line.startsWith('"rows","' + prefix)).length;
  }
  assert.equal(count, added);
  assert.ok(maxChunk < 2 * 1024 * 1024);
  console.log(
    JSON.stringify({ catalogRows: first.meta.total, catalogCsvRows: count, bytes, maxChunk }),
  );
}
