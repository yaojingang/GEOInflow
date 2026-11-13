-- Effects are committed by PG authority before CH shadow publication. Keep
-- their acknowledgement independent from the derived-fact publication state.
ALTER TABLE liekan_warehouse_attempt ADD COLUMN effects_applied boolean NOT NULL DEFAULT false;
UPDATE liekan_warehouse_attempt SET effects_applied=true WHERE status='projected';
