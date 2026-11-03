import assert from 'node:assert/strict';

// Engine compatibility runs may use a separately restored local fixture. Never
// accept a production URL (or credentials) through this test-only override.
export const testClickHouseURL =
  process.env.WAREHOUSE_TEST_CLICKHOUSE_URL ?? 'http://127.0.0.1:28139';
assert.match(testClickHouseURL, /^http:\/\/127\.0\.0\.1:(28139|28159)$/);
