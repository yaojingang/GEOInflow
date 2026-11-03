// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { CALENDAR_POLICY_VERSION } from '../contracts/calendar';
import { readAnalyticsVersions } from './analytics-revision';
import { analysisDigest, ANALYSIS_RESULT_FORMAT } from './analysis-query-model';
import { DASHBOARD_FORMAT } from './dashboard-snapshot-model';

it('fences old calendar results without changing raw data or eligibility revisions', async () => {
  const tx = { $queryRawUnsafe: vi.fn().mockResolvedValue([]) };
  const id = '00000000-0000-4000-8000-000000000001';
  const current = await readAnalyticsVersions(tx, [`website:${id}`]);
  const fields = JSON.parse(current.strong);
  expect(fields.at(-1)).toBe(CALENDAR_POLICY_VERSION);
  const legacy = JSON.stringify(fields.slice(0, -1));
  expect(current.data).toBe('[]');
  for (const format of [DASHBOARD_FORMAT, ANALYSIS_RESULT_FORMAT]) {
    expect(analysisDigest([format, id, current.strong])).not.toBe(
      analysisDigest([format, id, legacy]),
    );
  }
  expect(tx.$queryRawUnsafe.mock.calls.every(([sql]) => !/UPDATE|INSERT|DELETE/.test(sql))).toBe(
    true,
  );
});

it('fences prior metric semantics while keeping source revisions unchanged', async () => {
  const tx = { $queryRawUnsafe: vi.fn().mockResolvedValue([]) };
  const current = await readAnalyticsVersions(tx, ['website:00000000-0000-4000-8000-000000000001']);
  const fields = JSON.parse(current.strong);
  expect(fields).toContain('analytics-read-v4');
  const legacy = JSON.stringify(
    fields.map((value: unknown) => (value === 'analytics-read-v4' ? 'analytics-read-v3' : value)),
  );
  expect(current.strong).not.toBe(legacy);
  for (const format of [DASHBOARD_FORMAT, ANALYSIS_RESULT_FORMAT]) {
    expect(analysisDigest([format, current.strong])).not.toBe(analysisDigest([format, legacy]));
  }
  expect(current.data).toBe('[]');
  expect(tx.$queryRawUnsafe.mock.calls.every(([sql]) => !/UPDATE|INSERT|DELETE/.test(sql))).toBe(
    true,
  );
});
