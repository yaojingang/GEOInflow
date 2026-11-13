ALTER TABLE liekan_warehouse_deletion ADD COLUMN authority text NOT NULL DEFAULT 'clickhouse'
  CHECK(authority IN('postgres','clickhouse'));
