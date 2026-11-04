import assert from 'node:assert/strict';

// Engine compatibility runs may use a separately restored local fixture. Never
// accept a production URL (or credentials) through this test-only override.
export const testClickHouseURL =
  process.env.WAREHOUSE_TEST_CLICKHOUSE_URL ?? 'http://127.0.0.1:28139';
assert.match(testClickHouseURL, /^http:\/\/127\.0\.0\.1:(28139|28159)$/);

export const testPostgresPort = Number(process.env.WAREHOUSE_TEST_POSTGRES_PORT ?? 25459);
assert.ok([25459, 25479].includes(testPostgresPort), 'Only isolated local PostgreSQL ports');
export const testPostgresPasswordFile =
  testPostgresPort === 25479
    ? '.local/kafka-validation-20261104/pg-password'
    : '.local/ch-prototype-round2/pg-password';
