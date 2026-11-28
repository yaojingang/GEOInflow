-- Disposable, bounded metrics belonging to one immutable, referenced report round.
-- Losing this reuse state changes computation cost, never report correctness.
ALTER TABLE liekan_warehouse_report_round
  ADD COLUMN metrics jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE liekan_warehouse_report_round
  ADD CONSTRAINT liekan_warehouse_round_metrics_object CHECK (jsonb_typeof(metrics) = 'object');
