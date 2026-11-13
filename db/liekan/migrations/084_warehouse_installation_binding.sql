ALTER TABLE liekan_warehouse_installation
  ADD COLUMN identity_bound boolean NOT NULL DEFAULT false,
  ADD COLUMN setup_mode text CHECK(setup_mode IN('fresh','pg-transition'));
