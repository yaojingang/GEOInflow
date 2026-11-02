import { expect, it } from 'vitest';
import { expectedEngineBenchmark } from './analytics-engine-benchmark-fixture';

it('pins the synthetic generator to independently countable full-year and last-month populations', () => {
  const full = expectedEngineBenchmark(1460, 365),
    month = expectedEngineBenchmark(1460, 30);
  expect(full.summary).toEqual({
    requests: 1460,
    ai: 1095,
    pages: 1095,
    abnormal: 85,
    classificationVersions: 1,
    legacyRequests: 365,
    unclassifiedRequests: 365,
  });
  expect(full.bots.map(bot => bot.requests)).toEqual([365, 365, 365]);
  expect(full.statuses).toEqual([
    { status: 200, count: 1031 },
    { status: 400, count: 64 },
  ]);
  expect(month.summary).toMatchObject({ requests: 120, ai: 90, pages: 90, legacyRequests: 30 });
  expect(month.daily).toHaveLength(90);
});
