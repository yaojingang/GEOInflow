-- Unpublished stage receipts belong to a referenced, fenced report round.
-- No event contents are retained here: only hour plans and verification digests.
ALTER TABLE liekan_warehouse_report_round
  ADD COLUMN analysis_build jsonb,
  ADD COLUMN next_eligible_at timestamptz;
ALTER TABLE liekan_warehouse_report_round
  ADD CONSTRAINT liekan_warehouse_analysis_build_object
  CHECK (analysis_build IS NULL OR jsonb_typeof(analysis_build) = 'object');
