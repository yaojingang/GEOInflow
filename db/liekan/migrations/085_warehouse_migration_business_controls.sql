CREATE TABLE liekan_warehouse_migration_business_control (
  operation_id uuid PRIMARY KEY REFERENCES liekan_warehouse_barrier(operation_id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','ready')),
  resource_cursor uuid,
  current_resource uuid,
  bookmark_cursor uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
