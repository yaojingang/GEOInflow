// @vitest-environment node
import { expect, it } from 'vitest';
import {
  canonicalDashboardParameters,
  dashboardCutoff,
  dashboardWindow,
  defaultDashboardRange,
  dashboardWarmRanges,
  canAdvanceDashboardClock,
} from './dashboard-snapshot-model';
import { analysisDigest, analysisQueryParameters } from './analysis-query-model';
const now = +new Date('2026-10-24T10:07:30+08:00');
it.each(['overview', 'human/overview', 'ai/overview', 'ai/bots', 'ai/pages', 'ai/preference'])(
  'can advance unchanged %s facts within the same local day',
  resource => {
    const parameters = {
      resource,
      startAt: +new Date('2026-10-23T00:00:00+08:00'),
      endAt: +new Date('2026-10-25T00:00:00+08:00'),
      timezone: 'Asia/Shanghai',
      ...(resource.startsWith('ai/') ? { crawlerMetricsVersion: 1 } : {}),
    };
    expect(canAdvanceDashboardClock('feature:page-report', parameters, now, now + 30000)).toBe(
      true,
    );
    expect(
      canAdvanceDashboardClock(
        'feature:page-report',
        parameters,
        now,
        +new Date('2026-10-25T00:00:00+08:00'),
      ),
    ).toBe(false);
    expect(canAdvanceDashboardClock('native:stats', parameters, now, now + 30000)).toBe(false);
  },
);
it.each(['ai/overview', 'ai/bots'])(
  'retains %s daily averages at non-midnight elapsed-day boundaries',
  resource => {
    const parameters = {
      resource,
      startAt: now - 86400000 + 15000,
      endAt: now + 3600000,
      timezone: 'Asia/Shanghai',
      crawlerMetricsVersion: 1,
    };
    expect(canAdvanceDashboardClock('feature:page-report', parameters, now, now + 30000)).toBe(
      false,
    );
    expect(canAdvanceDashboardClock('feature:page-report', parameters, now, now + 10000)).toBe(
      true,
    );
  },
);
it('preserves fixed AI ends and unknown resources when considering clock advancement', () => {
  for (const resource of ['ai/overview', 'ai/bots', 'ai/pages', 'ai/preference', 'human/sources'])
    expect(
      canAdvanceDashboardClock(
        'feature:page-report',
        {
          resource,
          startAt: now - 86400000,
          endAt: now - 1,
          timezone: 'UTC',
          crawlerMetricsVersion: 1,
        },
        now,
        now + 30000,
      ),
    ).toBe(false);
});
it.each(['ai/overview', 'ai/bots', 'ai/pages', 'ai/preference'])(
  'keeps legacy inclusive %s outside no-input reuse',
  resource => {
    expect(
      canAdvanceDashboardClock(
        'feature:page-report',
        {
          resource,
          startAt: +new Date('2026-10-23T00:00:00Z'),
          endAt: now + 3600000,
          timezone: 'UTC',
        },
        now,
        now + 30000,
      ),
    ).toBe(false);
  },
);
it('keeps natural-day averages across a 23-hour DST day', () => {
  const parameters = {
    resource: 'ai/overview',
    startAt: +new Date('2026-03-08T05:00:00Z'),
    endAt: +new Date('2026-03-10T04:00:00Z'),
    timezone: 'America/New_York',
    crawlerMetricsVersion: 1,
  };
  const at = +new Date('2026-03-09T16:00:00Z');
  expect(canAdvanceDashboardClock('feature:page-report', parameters, at, at + 30000)).toBe(true);
});
it.each([
  ['UTC', '2026-10-01T00:00Z', '2026-10-25T08:55:14.457Z'],
  ['Asia/Shanghai', '2026-09-30T16:00Z', '2026-10-25T08:55:14.457Z'],
  ['America/New_York', '2026-10-01T04:00Z', '2026-10-25T08:55:14.457Z'],
  ['America/New_York', '2026-03-01T05:00Z', '2026-03-20T08:55:14.457Z'],
])(
  'shares current-month retention identity without changing executed bounds in %s',
  (timezone, start, enteredAt) => {
    const firstAt = Date.parse(enteredAt),
      secondAt = firstAt + 84647,
      first = { startAt: Date.parse(start), endAt: firstAt, timezone },
      second = { ...first, endAt: secondAt };
    const firstWindow = dashboardWindow('native:retention', first, firstAt),
      secondWindow = dashboardWindow('native:retention', second, secondAt);
    expect(firstWindow.parameters).toEqual(secondWindow.parameters);
    expect(analysisDigest(first)).not.toBe(analysisDigest(second));
    const canonicalFirst = canonicalDashboardParameters('native:retention', first, firstAt),
      canonicalSecond = canonicalDashboardParameters('native:retention', second, secondAt);
    expect(canonicalFirst.endAt).toBe(firstWindow.parameters.endAt);
    expect(analysisQueryParameters('native:retention', canonicalFirst)).toEqual(
      analysisQueryParameters('native:retention', canonicalSecond),
    );
    expect(analysisDigest(canonicalFirst)).toBe(analysisDigest(canonicalSecond));
    expect(dashboardWindow('native:retention', canonicalFirst, firstAt).parameters).toEqual(
      firstWindow.parameters,
    );
    expect(dashboardWindow('native:retention', canonicalSecond, secondAt).parameters).toEqual(
      secondWindow.parameters,
    );
    const later = dashboardWindow('native:retention', canonicalFirst, firstAt + 300000);
    expect(later.hot).toBe(false);
    expect(later.through).toBe(firstWindow.through);
    expect(later.parameters.endAt).toBe(firstWindow.parameters.endAt);
    const nextRead = canonicalDashboardParameters(
      'native:retention',
      { ...first, endAt: firstAt + 300000 },
      firstAt + 300000,
    );
    expect(analysisDigest(nextRead)).not.toBe(analysisDigest(canonicalFirst));
    expect(nextRead.endAt).toBe(firstWindow.parameters.endAt + 300000);
  },
);

it('pins retention registration to its captured closed window across a five-minute rollover', () => {
  const enteredAt = Date.parse('2026-10-25T09:04:59Z'),
    registeredAt = Date.parse('2026-10-25T09:05:01Z'),
    input = {
      startAt: Date.parse('2026-10-01T00:00Z'),
      endAt: enteredAt - 100,
      timezone: 'UTC',
    };
  const captured = dashboardWindow('native:retention', input, enteredAt),
    canonical = canonicalDashboardParameters('native:retention', input, enteredAt),
    registered = dashboardWindow('native:retention', canonical, registeredAt);
  expect(registered.hot).toBe(false);
  expect(registered.parameters.endAt).toBe(captured.parameters.endAt);
  expect(registered.parameters.endAt).toBeLessThan(input.endAt);
  expect(registered.through).toBe(captured.through);
  expect(registered.dependencyEnd).toBe(captured.dependencyEnd);
  const legacyThrough = registered.through + 300000;
  expect(
    dashboardWindow('native:retention', canonical, registeredAt, true, legacyThrough),
  ).toMatchObject({ through: legacyThrough, dependencyEnd: captured.dependencyEnd });
});

it('preserves historical, explicit past submonth and future-month retention selections', () => {
  const at = Date.parse('2026-10-25T08:55:14Z');
  for (const parameters of [
    {
      startAt: Date.parse('2026-09-01T00:00Z'),
      endAt: Date.parse('2026-09-30T23:59:59.999Z'),
      timezone: 'UTC',
    },
    {
      startAt: Date.parse('2026-10-01T00:00Z'),
      endAt: Date.parse('2026-10-25T08:54:59.998Z'),
      timezone: 'UTC',
    },
    { startAt: Date.parse('2026-10-02T00:00Z'), endAt: at, timezone: 'UTC' },
    {
      startAt: Date.parse('2026-11-01T00:00Z'),
      endAt: Date.parse('2026-11-30T23:59:59.999Z'),
      timezone: 'UTC',
    },
  ]) {
    const canonical = canonicalDashboardParameters('native:retention', parameters, at);
    expect(canonical).toBe(parameters);
    expect(dashboardWindow('native:retention', canonical, at)).toEqual(
      dashboardWindow('native:retention', parameters, at),
    );
  }
  const parameters = { startAt: Date.parse('2026-10-01T00:00Z'), endAt: at, timezone: 'UTC' };
  expect(canonicalDashboardParameters('native:stats', parameters, at)).toBe(parameters);
});

it('keeps the first current-month read exact until its first five-minute window closes', () => {
  const at = Date.parse('2026-11-01T00:00:10Z');
  const parameters = { startAt: Date.parse('2026-11-01T00:00Z'), endAt: at, timezone: 'UTC' };
  expect(dashboardWindow('native:retention', parameters, at).computable).toBe(false);
  expect(canonicalDashboardParameters('native:retention', parameters, at)).toBe(parameters);
});

it('publishes completed thirty-second windows without a minute-long hold', () => {
  expect(dashboardCutoff(now)).toBe(+new Date('2026-10-24T10:07:30+08:00'));
  expect(dashboardCutoff(+new Date('2026-10-24T10:05:59+08:00'))).toBe(
    +new Date('2026-10-24T10:05:30+08:00'),
  );
});
it('defers a new day until its first complete inclusive bucket is available', () => {
  const at = +new Date('2026-10-25T00:00:10+08:00');
  const w = dashboardWindow(
    'native:stats',
    {
      timezone: 'Asia/Shanghai',
      startAt: +new Date('2026-10-25T00:00:00+08:00'),
      endAt: +new Date('2026-10-25T23:59:59.999+08:00'),
    },
    at,
  );
  expect(w.computable).toBe(false);
  expect(w.parameters.endAt).toBe(+new Date('2026-10-25T00:00:29.999+08:00'));
  expect(w.availableAt).toBe(+new Date('2026-10-25T00:00:30+08:00'));
});
it('keeps historical boundaries exact and clips current inclusive and half-open reads', () => {
  const parameters = {
    ...defaultDashboardRange('Asia/Shanghai', now),
    timezone: 'Asia/Shanghai',
    resource: 'ai/overview',
    crawlerMetricsVersion: 1,
  };
  const hot = dashboardWindow('feature:page-report', parameters, now);
  expect(hot.hot).toBe(true);
  expect(hot.parameters.endAt).toBe(parameters.endAt);
  expect(dashboardWindow('native:stats', parameters, now).parameters.endAt).toBe(
    dashboardCutoff(now) - 1,
  );
  const history = { ...parameters, endAt: +new Date('2026-10-24T00:00:00+08:00') };
  expect(dashboardWindow('feature:page-report', history, now)).toMatchObject({
    hot: false,
    parameters: history,
  });
});
it('rotates dedicated today counters by local calendar day and preserves natural-day DST boundaries', () => {
  const p = { startAt: 0, endAt: 1, resource: 'overview', timezone: 'Asia/Shanghai' };
  expect(dashboardWindow('feature:page-report', p, now).day).toBe('2026-10-24');
  expect(
    dashboardWindow('feature:page-report', p, +new Date('2026-10-25T00:00:00+08:00')).day,
  ).toBe('2026-10-25');
  const range = defaultDashboardRange('America/New_York', +new Date('2026-03-20T16:00:00Z'));
  expect(new Date(range.startAt).toISOString()).toBe('2026-02-19T05:00:00.000Z');
  expect(new Date(range.endAt).toISOString()).toBe('2026-03-21T03:59:59.999Z');
});

it('preserves distinct selected report boundaries in the background task identity', () => {
  const parameters = {
    ...defaultDashboardRange('Asia/Shanghai', now),
    timezone: 'Asia/Shanghai',
    resource: 'overview',
  };
  const noon = { ...parameters, endAt: +new Date('2026-10-24T12:00:00+08:00') };
  const first = dashboardWindow('feature:page-report', parameters, now);
  const second = dashboardWindow('feature:page-report', noon, now);
  expect(first.parameters.endAt).toBe(parameters.endAt);
  expect(second.parameters.endAt).toBe(noon.endAt);
  expect(first.parameters.endAt).not.toBe(second.parameters.endAt);
  expect(first.through).toBe(second.through);
});
it('keeps inactive maintenance behind foreground cadence without moving a publication backwards', () => {
  const at = +new Date('2026-10-24T10:08:31+08:00');
  const published = +new Date('2026-10-24T10:06:30+08:00');
  const p = { ...defaultDashboardRange('Asia/Shanghai', at), timezone: 'Asia/Shanghai' };
  const inactive = dashboardWindow('native:stats', p, at, false, published);
  expect(inactive.through).toBe(published);
  expect(inactive.parameters.endAt).toBe(published - 1);
  expect(inactive.nextRefresh).toBe(+new Date('2026-10-24T10:10:00+08:00'));
});

it.each(['Asia/Shanghai', 'America/New_York', 'UTC'])(
  'prewarms existing picker bounds in %s across DST and midnight',
  async timezone => {
    const { readFeatureDateRange } = await import('./date-range');
    const { featureDateRange } = await import('../contracts/analysis');
    for (const at of [now, +new Date('2026-03-08T08:00:00Z'), +new Date('2026-10-24T16:00:00Z')]) {
      const ranges = dashboardWarmRanges(timezone, at);
      for (const [i, value] of ['0day', '7day', '30day'].entries()) {
        const dateRange = readFeatureDateRange(value, '', 0, timezone, 'en-US', at).dateRange;
        const expected = featureDateRange(dateRange, timezone);
        expect(ranges[i]).toEqual({ startAt: expected.startAt, endAt: expected.endAt });
      }
    }
  },
);
