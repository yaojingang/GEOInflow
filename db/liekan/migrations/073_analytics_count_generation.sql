-- Older workers can publish raw generations without knowing the independent count proof.
ALTER TABLE liekan_analytics_engine_unit ADD COLUMN counts_generation uuid;
