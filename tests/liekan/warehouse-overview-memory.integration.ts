// Real ClickHouse resource regression. Generates synthetic rows inside a SELECT;
// no existing facts, configuration, publication or PostgreSQL data are written.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWarehouseClient } from '../../src/lib/liekan/warehouse/client';
import { warehouseReadResources } from '../../src/lib/liekan/warehouse/read-resources';
import {
  logSummaryColumns,
  reportingLogRelation,
} from '../../src/lib/liekan/warehouse/reporting-relations';

assert.equal(process.env.WAREHOUSE_OVERVIEW_MEMORY_TEST, 'isolated');
const url = process.env.WAREHOUSE_TEST_CLICKHOUSE_URL ?? 'http://127.0.0.1:28149';
assert.match(url, /^http:\/\/127\.0\.0\.1:(28139|28149|28159)$/);
const auth = url.endsWith(':28149')
  ? {
      username: 'liekan_full_test',
      password: (await readFile('.local/ch-full-validation/ch-password', 'utf8')).trim(),
    }
  : {};
process.env.DATABASE_URL = 'postgresql://unused@127.0.0.1:1/unused';
process.env.DATABASE_TYPE = 'postgresql';
const { warehouseLogQuerySpec } = await import(
  '../../src/lib/liekan/upstream/warehouse-log-queries'
);
const ch = createWarehouseClient({
  url,
  ...auth,
  request_timeout: 120000,
  clickhouse_settings: {
    ...warehouseReadResources(),
    max_threads: 2,
    max_execution_time: 90,
    max_block_size: '8192',
    join_use_nulls: 1,
    max_query_size: '1048576',
  },
});
try {
  const spec = await warehouseLogQuerySpec(
    new Date('2026-11-01T00:00:00Z'),
    new Date('2026-11-02T00:00:00Z'),
    'UTC',
    { resource: 'overview', crawlerIdentityScope: 'all' },
    '',
    '',
    false,
    'fixture',
    true,
  );
  const columns = [
    ...new Set([
      ...logSummaryColumns,
      'bot',
      'vendor',
      'bot_type',
      'reporting_crawler_id',
      'path',
      'created_at',
      'ai_eligible',
      'recognition_state',
    ]),
  ];
  const relations = [false, true]
    .map(ordered =>
      reportingLogRelation(
        {
          immutableTimeWindow: { start: 'logStart', end: 'logEnd', endExclusive: false },
          ...(ordered ? { orderedLogVersions: true as const } : {}),
        },
        columns,
      ),
    )
    .filter(relation => spec.overview.split(relation).length === 2);
  assert.equal(relations.length, 1, 'substitute exactly one production fact source');
  const relation = relations[0];
  const rows = 3400000;
  const synthetic = `(SELECT concat('/synthetic-memory/',toString(number%150000),'/',repeat('x',320)) AS path,
    toInt32(200) AS status,toNullable(true) AS ai_eligible,'搜索' AS bot_type,
    concat('Fixture-',toString(number%10)) AS bot,'Synthetic' AS vendor,
    toNullable(concat('fixture-',toString(number%10))) AS reporting_crawler_id,
    toNullable('recognized') AS recognition_state,toNullable('synthetic-v1') AS reporting_classification_version,
    toDateTime64('2026-11-01 12:00:00',6,'UTC') AS created_at FROM numbers(${rows}))`;
  const at = performance.now();
  const result = await ch.query({
    query: spec.overview.replace(relation, synthetic),
    format: 'JSONEachRow',
  });
  let summary: any,
    bots = 0,
    paths = 0,
    botRequests = 0,
    pathRequests = 0;
  for await (const batch of result.stream<{ section: string; row: string }>()) {
    for (const item of batch) {
      const record = item.json(),
        row = JSON.parse(record.row);
      if (record.section === 'summary') {
        assert.equal(summary, undefined);
        summary = row;
      } else if (record.section === 'bots') {
        bots++;
        botRequests += Number(row.requests);
      } else if (record.section === 'pages') {
        paths++;
        pathRequests += Number(row.requests);
      } else assert.fail('unexpected section');
    }
  }
  assert.equal(Number(summary.requests), rows);
  assert.equal(Number(summary.pages), 150000);
  assert.equal(Number(summary.ai), rows);
  assert.equal(bots, 10);
  assert.equal(paths, 150000);
  assert.equal(botRequests, rows);
  assert.equal(pathRequests, rows);
  console.log(
    JSON.stringify({
      status: 'pass',
      rows,
      paths,
      bots,
      queryMemoryBytes: 1073741824,
      ms: Math.round(performance.now() - at),
    }),
  );
} finally {
  await ch.close();
}
