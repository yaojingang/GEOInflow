ALTER TABLE liekan_warehouse_upload ADD COLUMN actor_id uuid;
ALTER TABLE liekan_warehouse_upload ADD COLUMN warehouse_epoch bigint NOT NULL DEFAULT 0 CHECK(warehouse_epoch>=0);
ALTER TABLE liekan_warehouse_upload ADD COLUMN cancelled integer NOT NULL DEFAULT 0 CHECK(cancelled>=0);
