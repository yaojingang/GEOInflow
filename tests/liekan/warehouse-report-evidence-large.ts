import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { ControlDatabase } from '../../src/lib/liekan/warehouse/control-db';
import type { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { factInput } from '../../src/lib/liekan/warehouse/fact-input';
import { storedFact } from '../../src/lib/liekan/warehouse/candidate';

/** Invoked only by the isolated warehouse-evidence integration driver. It uses
 * that driver's disposable synthetic clone, never the production download. */
export async function runLargeReportEvidence({
  db,
  ch,
  site,
  batch,
  owner,
  run,
}: {
  db: ControlDatabase;
  ch: ReturnType<typeof createWarehouseClient>;
  site: string;
  batch: string;
  owner: string;
  run: string;
}) {
  assert.equal(process.env.WAREHOUSE_SCHEMA_TEST, 'isolated-round2');
  assert.equal(process.env.WAREHOUSE_REPORT_EVIDENCE_LARGE, '1');
  assert.match(run, /^warehouse_contracts_\d+$/);
  const count = 100005,
    marker = randomUUID(),
    attempt = randomUUID(),
    candidate = randomUUID();
  const timestamp = '2026-11-02 13:00:00.000000';
  const [{ epoch, publication }] = await db.read<any>(
    "SELECT epoch::text,publication::text FROM liekan_warehouse_site WHERE website_id=$1 AND state='active'",
    [site],
  );
  const startAt = +new Date('2026-11-02T13:00:00Z'),
    endAt = startAt + 1000;
  const prefix = `/report-large-${marker}/`;
  for (let offset = 0; offset < count; offset += 256) {
    const values = [];
    for (let index = offset; index < Math.min(offset + 256, count); index++) {
      const suffix = String(index).padStart(6, '0');
      const row = factInput('liekan_log', {
        id: createHash('sha256')
          .update(marker + suffix)
          .digest('hex'),
        website_id: site,
        import_id: batch,
        created_at: timestamp,
        path: prefix + suffix + '-' + 'p'.repeat(600),
        method: 'GET',
        status: 200,
        bytes: 1,
        ip_masked: 'synthetic',
        ip_hash: 'd'.repeat(64),
        user_agent: 'SyntheticReportEvidence',
        location: 'unknown',
        bot: `蜘蛛${suffix}-` + '蛛'.repeat(80),
        vendor: '厂'.repeat(80),
        bot_type: '训练',
        verification: 'unverified',
        source_id: null,
        ai_eligible: true,
        recognition_state: 'recognized',
      });
      values.push(
        storedFact('liekan_log', row, {
          _website_id: site,
          _record_time: timestamp,
          _session_id: null,
          _epoch: epoch,
          _version: '0',
          _ordinal: index,
          _attempt_id: attempt,
          _candidate_id: candidate,
          _topic_id: 'synthetic-report-large',
          _partition: 0,
          _offset: '0',
          _deleted: false,
        }),
      );
    }
    await ch.insert({ table: 'warehouse_liekan_log', format: 'JSONEachRow', values });
  }
  await ch.insert({
    table: 'warehouse_publication',
    format: 'JSONEachRow',
    values: [
      {
        website_id: site,
        epoch,
        publication,
        attempt_id: attempt,
        family: 'liekan_log',
        candidate_id: candidate,
        row_count: count,
        digest: 'a'.repeat(64),
        published_at: timestamp,
      },
    ],
  });
  const [pg] = await db.read<any>(
    'SELECT count(*)::text AS total FROM liekan_log WHERE website_id=$1 AND path LIKE $2',
    [site, prefix + '%'],
  );
  assert.equal(Number(pg.total), 0, 'large facts exist only in CH');

  process.env.LIEKAN_ANALYTICS_BACKEND = 'clickhouse';
  process.env.APP_SECRET = 'isolated-contracts-' + run;
  const { createSecureToken } = await import('../../src/lib/jwt');
  const { secret } = await import('../../src/lib/crypto');
  const { queryEvidence, parseEvidenceQuery } = await import(
    '../../src/lib/liekan/crawlers/evidence-read'
  );
  const { readReportEvidence } = await import('../../src/lib/liekan/crawlers/report-evidence');
  const { exportEvidence } = await import('../../src/lib/liekan/crawlers/evidence-export');
  const actor = { id: owner, role: 'admin' },
    token = createSecureToken({ userId: owner }, secret(), { expiresIn: 3600 });
  const results: any[] = [];
  let peakHeap = 0,
    peakRss = 0;
  const measure = () => {
    const memory = process.memoryUsage();
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    peakRss = Math.max(peakRss, memory.rss);
  };
  const sample = setInterval(measure, 100);
  try {
    for (const reportResource of ['logs', 'ai/pages', 'ai/bots']) {
      const began = Date.now();
      console.log(`REPORT LARGE start ${reportResource}`);
      const p = parseEvidenceQuery({
        startAt,
        endAt,
        timezone: 'UTC',
        crawlerIdentityScope: 'all',
        reportResource,
        view: 'requests',
      });
      const first = await queryEvidence(
        actor,
        site,
        p,
        'report-evidence',
        readReportEvidence,
        true,
      );
      assert.equal(first.meta.total, count, reportResource + ' complete count');
      assert.equal(first.rows.length, 20);
      const second = await queryEvidence(
        actor,
        site,
        { ...p, page: 2, snapshot: first.meta.snapshot },
        'report-evidence',
        readReportEvidence,
        true,
      );
      const last = await queryEvidence(
        actor,
        site,
        { ...p, page: 5001, snapshot: first.meta.snapshot },
        'report-evidence',
        readReportEvidence,
        true,
      );
      assert.equal(second.meta.reset, false);
      assert.equal(last.meta.reset, false);
      assert.equal(last.rows.length, 5);
      assert.equal(last.meta.total, count);
      const key = (row: any) => row.recordId ?? row.path ?? row.name;
      assert.equal(
        new Set([...first.rows, ...second.rows, ...last.rows].map(key)).size,
        45,
        reportResource + ' disjoint stable pages',
      );
      if (reportResource !== 'logs') assert.match(key(last.rows.at(-1)), /100004-/);
      const request = new Request(
        `http://127.0.0.1/api/liekan/websites/${site}/traffic-quality/export-evidence`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        },
      );
      const response = await exportEvidence(
        actor,
        site,
        {
          kind: 'evidence',
          query: p,
          locale: 'en-US',
          policySnapshot: first.meta.policySnapshot,
          viewReportQuery: {
            resource: reportResource,
            startAt,
            endAt,
            timezone: 'UTC',
            crawlerMetricsVersion: 1,
            crawlerIdentityScope: 'all',
            filter: '',
            search: '',
          },
        },
        request,
        ['evidence'],
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Type'), /text\/csv/);
      let bytes = 0,
        lines = 0;
      const reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        for (const byte of chunk.value) if (byte === 10) lines++;
      }
      assert.equal(lines, count + 2, reportResource + ' complete CSV plus metadata/header');
      assert.ok(bytes > 50 * 1024 * 1024, reportResource + ' exceeds former 50MiB cap');
      measure();
      console.log(
        `REPORT LARGE pass ${reportResource}: ${count} rows, ${bytes} CSV bytes, ${Date.now() - began} ms`,
      );
      results.push({
        reportResource,
        count,
        csvBytes: bytes,
        csvLines: lines,
        milliseconds: Date.now() - began,
      });
    }
  } finally {
    clearInterval(sample);
  }
  await writeFile(
    `.local/ch-implementation/warehouse_report_evidence_large_${Date.now()}.json`,
    JSON.stringify(
      {
        run,
        count,
        results,
        peakHeap,
        peakRss,
        pgFacts: 0,
        fullUpgradeValidated: false,
      },
      null,
      2,
    ),
  );
  return results;
}
