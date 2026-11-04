// Aggregate parity on the downloaded backup's immutable clone and the fully
// migrated isolated target. Never materialize visitor rows in a test report.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { createWarehouseReader } from '../../src/lib/liekan/warehouse/reader-runtime';
import { crawlerAiSql, unknownCrawlerSql } from '../../src/lib/liekan/rules/population';
import { readReportingMetadata } from '../../src/lib/liekan/warehouse/reporting-context';
import {
  browserEventRelation,
  logSummaryColumns,
  reportingLogRelation,
  reportingParameters,
} from '../../src/lib/liekan/warehouse/reporting-relations';

assert.equal(process.env.WAREHOUSE_FULL_UPGRADE_TEST, 'isolated-downloaded-clone');
const root = resolve('.local/ch-full-validation');
const state = JSON.parse(await readFile(`${root}/workflow.json`, 'utf8'));
assert.ok(
  state.steps.final?.passed,
  'Finish the full migration/cutover/rollback/exit acceptance first',
);
const clone = state.steps['snapshot-restore'].descriptor.database;
assert.match(clone, /^liekan_snapshot_[a-z0-9_]+$/);
const password = (await readFile(`${root}/pg-password`, 'utf8')).trim();
const config = {
  host: '127.0.0.1',
  port: 25469,
  user: 'liekan_full_test',
  password,
  options: '-c default_transaction_read_only=on -c statement_timeout=300000',
};
const source = new pg.Client({ ...config, database: clone });
const target = new pg.Client({ ...config, database: 'liekan_full_test' });
const targetURL = new URL('postgresql://127.0.0.1:25469/liekan_full_test');
targetURL.username = config.user;
targetURL.password = password;
targetURL.searchParams.set('options', config.options);
// Exercise the real reader's spill, join/block and timeout settings, rather
// than an independently configured test client that can drift from production.
const reader = createWarehouseReader({
  databaseURL: targetURL.toString(),
  clickhouseURL: 'http://127.0.0.1:28149',
  clickhouseDatabase: 'liekan_full_test',
  clickhouseUsername: 'liekan_full_test',
  clickhousePassword: (await readFile(`${root}/ch-password`, 'utf8')).trim(),
});
const ch = reader.ch;
const cases: object[] = [];
async function expectedQuery(sql: string, parameters: string[]) {
  // Reuse successful reads only from this immutable source and exact verified
  // migration/query identity. Failed target queries never create passing proof.
  const key = createHash('sha256')
    .update(JSON.stringify({ clone, digest: state.steps.verify.digest, sql, parameters }))
    .digest('hex');
  const path = `${root}/artifacts/reporting-expected-${key}.json`;
  try {
    const cached = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(cached.key, key);
    assert.ok(Array.isArray(cached.rows));
    return { ...cached, reused: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const start = performance.now(),
    rows = (await source.query(sql, parameters)).rows;
  const result = { key, rows, ms: Math.round(performance.now() - start) };
  await writeFile(path, JSON.stringify(result), { mode: 0o600 });
  return { ...result, reused: false };
}
try {
  await source.connect();
  await target.connect();
  // Two largest real log sites exercise the high-cardinality path population.
  const sites = (
    await source.query<{
      website_id: string;
    }>(`SELECT l.website_id FROM liekan_log l JOIN website w USING(website_id) WHERE w.deleted_at IS NULL
    GROUP BY l.website_id ORDER BY count(*) DESC,l.website_id LIMIT 2`)
  ).rows;
  assert.equal(sites.length, 2);
  for (const { website_id: site } of sites) {
    const metadata = await readReportingMetadata(
      { read: async (sql, values) => (await target.query(sql, values)).rows },
      site,
    );
    for (const [view, relation, pathColumn] of [
      ['liekan_reporting_log', reportingLogRelation({}, ['created_at', 'path']), 'path'],
      ['liekan_observed_browser_event', browserEventRelation('observed'), 'url_path'],
      ['liekan_effective_browser_event', browserEventRelation(), 'url_path'],
    ] as const) {
      const browser = view !== 'liekan_reporting_log';
      const extra = browser ? ' AND event_type=1' : '';
      const baseline = await expectedQuery(
        `SELECT to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
        count(*)::text AS requests,count(DISTINCT ${pathColumn})::text AS paths
        FROM ${view} WHERE website_id=$1 AND created_at IS NOT NULL${extra} GROUP BY 1 ORDER BY 1`,
        [site],
      );
      const expected = baseline.rows;
      const pgMs = baseline.ms,
        chStart = performance.now();
      const actual = await ch
        .query({
          query: `SELECT formatDateTime(created_at,'%Y-%m-%d','Asia/Shanghai') AS day,
        toString(count()) AS requests,toString(uniqExact(${pathColumn})) AS paths FROM ${relation}
        WHERE created_at IS NOT NULL${extra} GROUP BY day ORDER BY day`,
          query_params: reportingParameters(metadata),
          format: 'JSONEachRow',
        })
        .then(r => r.json());
      assert.deepEqual(actual, expected, `${view} daily population and complete paths`);
      const record = {
        site,
        view,
        status: 'pass',
        days: actual.length,
        pgMs,
        sourceReadReused: baseline.reused,
        chMs: Math.round(performance.now() - chStart),
      };
      cases.push(record);
      console.log(JSON.stringify(record));
    }
    // Include repaired classification/proof columns, not only date/path. This
    // exercises the real summary's wide joins on the largest historical sites.
    const ai = crawlerAiSql('l'),
      unknown = unknownCrawlerSql('l');
    const baseline = await expectedQuery(
      `SELECT count(*)::text AS requests,
      (count(*) FILTER (WHERE ${ai}))::text AS ai,
      (count(DISTINCT path) FILTER (WHERE ${ai}))::text AS pages,
      (count(*) FILTER (WHERE status>=400))::text AS abnormal,
      count(DISTINCT coalesce(reporting_classification_version,'legacy'))::text AS "classificationVersions",
      (count(*) FILTER (WHERE ai_eligible IS NULL))::text AS "legacyRequests",
      (count(*) FILTER (WHERE ${unknown}))::text AS "unclassifiedRequests"
      FROM liekan_reporting_log l WHERE website_id=$1`,
      [site],
    );
    const expected = baseline.rows;
    const pgMs = baseline.ms,
      chStart = performance.now();
    const actual = await ch
      .query({
        query: `SELECT toString(count()) AS requests,
      toString(countIf(${ai})) AS ai,toString(uniqExactIf(path,${ai})) AS pages,
      toString(countIf(status>=400)) AS abnormal,
      toString(uniqExact(coalesce(reporting_classification_version,'legacy'))) AS classificationVersions,
      toString(countIf(isNull(ai_eligible))) AS legacyRequests,
      toString(countIf(${unknown})) AS unclassifiedRequests
      FROM ${reportingLogRelation({}, logSummaryColumns)} l`,
        query_params: reportingParameters(metadata),
        format: 'JSONEachRow',
      })
      .then(r => r.json());
    assert.deepEqual(actual, expected, 'Complete repaired log summary equals PG');
    const record = {
      site,
      view: 'log-summary-ordinary',
      status: 'pass',
      pgMs,
      sourceReadReused: baseline.reused,
      chMs: Math.round(performance.now() - chStart),
    };
    cases.push(record);
    console.log(JSON.stringify(record));
  }
} catch (error) {
  cases.push({ status: 'failed', error: error instanceof Error ? error.message : 'unknown' });
  console.error(error instanceof Error ? error.message : 'Reporting parity failed');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([source.end(), target.end(), reader.close()]);
  await writeFile(
    `${root}/artifacts/reporting-parity.json`,
    JSON.stringify(
      { cases, immutableSource: true, productionTouched: false, capacityAcceptance: false },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
