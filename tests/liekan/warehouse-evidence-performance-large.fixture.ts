import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { secret } from '../../src/lib/crypto';
import { createSecureToken } from '../../src/lib/jwt';
import { exportEvidence } from '../../src/lib/liekan/crawlers/evidence-export';
import { parseEvidenceQuery, queryEvidence } from '../../src/lib/liekan/crawlers/evidence-read';
import { readPerformance } from '../../src/lib/liekan/crawlers/performance-read';
import { edgeObservation } from '../../src/lib/liekan/log-ingestion/edge-observation';
import { storedFact } from '../../src/lib/liekan/warehouse/candidate';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
export async function verifyLargePerformanceEvidence({ db, ch, site, batch, owner, run }: any) {
  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  process.env.APP_SECRET = 'isolated-performance-' + run;
  const prefix = 'perf-' + randomUUID(),
    total = 100005,
    actor = { id: owner, role: 'admin' };
  const [state] = await db.read(
    'SELECT epoch::text,publication::text FROM liekan_warehouse_site WHERE website_id=$1',
    [site],
  );
  const version = String(BigInt(state.publication) + 1n);
  const publications = [];
  if (process.env.WAREHOUSE_PERFORMANCE_REUSE !== '1') {
    for (const family of ['liekan_log', 'liekan_crawler_evidence']) {
      const attempt = randomUUID(),
        candidate = randomUUID();
      for (let offset = 0; offset < total; offset += 1000) {
        const values = Array.from({ length: Math.min(1000, total - offset) }, (_, i) => {
          const index = String(offset + i).padStart(6, '0'),
            id = prefix + '-' + index;
          const fields =
            family === 'liekan_log'
              ? {
                  id,
                  website_id: site,
                  import_id: batch,
                  created_at: '2026-11-02T07:00:00Z',
                  path: '/' + prefix,
                  method: 'GET',
                  status: 200,
                  bytes: 1,
                  ip_masked: 'synthetic',
                  ip_hash: '7'.repeat(64),
                  user_agent: 'SyntheticPerformance',
                  location: 'unknown',
                  bot: 'GPTBot',
                  vendor: 'OpenAI',
                  bot_type: '训练',
                  verification: 'verified_range',
                  source_id: null,
                  ai_eligible: true,
                  recognition_state: 'recognized',
                }
              : {
                  website_id: site,
                  log_id: id,
                  classification_version: 'synthetic-performance-v1',
                  crawler_id: 'gptbot',
                  cache_status: 'cache_' + index,
                  measurement: {
                    version: 'log-measurement-v1',
                    bytesUnit: 'edge_body',
                    bytesAvailability: 'present',
                  },
                  edge_observation: edgeObservation({
                    EdgeResponseContentType: 'application/x-' + index + '-' + 'x'.repeat(600),
                  }),
                };
          return storedFact(family, factInput(family, fields), {
            _website_id: site,
            _record_time: '2026-11-02 07:00:00.000000',
            _session_id: null,
            _epoch: state.epoch,
            _version: version,
            _ordinal: offset + i,
            _attempt_id: attempt,
            _candidate_id: candidate,
            _topic_id: 'fixture-performance',
            _partition: 0,
            _offset: String(offset + i),
            _deleted: false,
          });
        });
        await ch.insert({ table: 'warehouse_' + family, format: 'JSONEachRow', values });
      }
      publications.push({
        website_id: site,
        epoch: state.epoch,
        publication: version,
        attempt_id: attempt,
        family,
        candidate_id: candidate,
        row_count: total,
        digest: 'a'.repeat(64),
        published_at: '2026-11-03 03:00:00.000000',
      });
    }
    await ch.insert({
      table: 'warehouse_publication',
      format: 'JSONEachRow',
      values: publications,
    });
    await db.transaction((tx: any) =>
      tx.query('UPDATE liekan_warehouse_site SET publication=$2 WHERE website_id=$1', [
        site,
        version,
      ]),
    );
  }
  const query = parseEvidenceQuery({
    startAt: +new Date('2026-11-02T07:00:00Z'),
    endAt: +new Date('2026-11-02T07:00:01Z'),
    timezone: 'UTC',
    sourceId: 'manual',
    population: 'all_logs',
    crawlerIdentityScope: 'all',
  });
  const first = await queryEvidence(actor, site, query, 'performance', readPerformance, true);
  assert.equal(first.totals.requests, total);
  assert.equal(first.meta.sectionPages.reasons.total, total);
  assert.equal(first.meta.sectionPages.fieldCoverage.total, total + 6);
  assert.equal(first.reasons.length, 20);
  assert.equal(first.fieldCoverage.length, 20);
  const second = await queryEvidence(
    actor,
    site,
    { ...query, reasonsPage: 2, fieldCoveragePage: 2, snapshot: first.meta.snapshot },
    'performance',
    readPerformance,
    true,
  );
  assert.equal(second.meta.reset, false);
  assert.equal(second.meta.snapshot, first.meta.snapshot);
  assert.equal(second.reasons[0].status, 'cache_000020');
  assert.equal(second.meta.sectionPages.fieldCoverage.page, 2);
  assert.notDeepEqual(first.fieldCoverage, second.fieldCoverage);
  const last = await queryEvidence(
    actor,
    site,
    { ...query, reasonsPage: 5001, fieldCoveragePage: 5001, snapshot: first.meta.snapshot },
    'performance',
    readPerformance,
    true,
  );
  assert.equal(last.reasons.length, 5);
  assert.equal(last.reasons.at(-1).status, 'cache_100004');
  assert.equal(last.fieldCoverage.length, 11);
  const token = createSecureToken({ userId: owner }, secret(), { expiresIn: 900 });
  const response = await exportEvidence(
    actor,
    site,
    {
      kind: 'performance',
      query: Object.fromEntries(Object.entries(query).filter(([key]) => key !== 'view')),
      locale: 'en-US',
      policySnapshot: first.meta.policySnapshot,
      viewSnapshot: first.meta.snapshot,
    },
    new Request('http://localhost/evidence', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
    }),
    ['performance'],
  );
  let cacheRows = 0,
    fieldRows = 0,
    bytes = 0,
    tail = '',
    maxChunk = 0;
  for await (const chunk of response.body as any) {
    bytes += chunk.length;
    maxChunk = Math.max(maxChunk, chunk.length);
    const lines = (tail + Buffer.from(chunk).toString('utf8')).split('\r\n');
    tail = lines.pop();
    cacheRows += lines.filter(line => line.startsWith('"reasons","cache_')).length;
    fieldRows += lines.filter(line =>
      line.startsWith('"fieldCoverage","EdgeResponseContentType"'),
    ).length;
  }
  assert.equal(cacheRows, total);
  assert.equal(fieldRows, total);
  assert.ok(bytes > 50 * 1024 * 1024);
  assert.ok(maxChunk < 2 * 1024 * 1024);
  console.log(JSON.stringify({ performanceRows: total, cacheRows, fieldRows, bytes, maxChunk }));
}
