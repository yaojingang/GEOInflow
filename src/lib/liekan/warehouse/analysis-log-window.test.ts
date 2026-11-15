// @vitest-environment node
import { expect, it } from 'vitest';
import { withAnalysisRead } from './analysis-context';
import { reportingLogRelation } from './reporting-relations';
import { factRelation } from './read';

it('bounds raw log fallback and its evidence by uncovered log hours before canonical aggregation', () => {
  const sql = withAnalysisRead(
    { site: 'site', control: 'control', browser: [], log: [[1793491200, 'build', 2, 0]] },
    () =>
      reportingLogRelation(
        { immutableTimeWindow: { start: 'start', end: 'end', endExclusive: true } },
        ['id', 'created_at', 'reporting_crawler_id', 'bot'],
      ),
  );
  expect(sql).toContain('warehouse_analysis_log_v1');
  expect(sql).toContain(
    'toUnixTimestamp(toStartOfHour(_record_time)) NOT IN {ar_log_hours:Array(Int64)}',
  );
  expect(sql).toContain('"log_id" IN (');
  expect(sql).toContain('"record_id" IN (');
  expect(sql).toContain('revision <= {wh_deletion:UInt64}');
  expect(sql).toContain('publication <= {wh_publication:UInt64}');
});

it('does not apply covered log hours to an unbounded or browser authoritative read', () => {
  expect(reportingLogRelation({}, ['id', 'bot'])).not.toContain('ar_log_hours');
  expect(() =>
    factRelation('website_event', {
      immutableTimeWindow: { start: 'start', end: 'end', excludedHours: 'covered' },
    } as any),
  ).toThrow('Invalid warehouse immutable-time filter');
});
