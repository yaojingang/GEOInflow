import { populationFromRow } from '../upstream/browser-population';
import { describe, it, expect } from 'vitest';
import {
  completedObservationDate,
  conditionsToQuery,
  duration,
  featureDateRange,
  relativeDaySeries,
  retentionSummary,
  savedConditionParameters,
} from './analysis';
describe('Liekan analysis boundaries', () => {
  it('converts preferred timezone presets and preserves custom timestamps', () => {
    const wall = new Date(2026, 9, 3, 0, 0, 0);
    expect(
      featureDateRange({ value: '0day', startDate: wall, endDate: wall }, 'Asia/Shanghai').startAt,
    ).toBe(Date.parse('2026-10-02T16:00:00Z'));
    expect(
      featureDateRange(
        { value: 'range:123:987:day', startDate: new Date(123), endDate: new Date(987) },
        'Asia/Shanghai',
      ),
    ).toMatchObject({ startAt: 123, endAt: 987 });
  });
  it('fills internal zero days before relative comparison', () => {
    expect(
      relativeDaySeries(
        [
          { x: '2026-10-01T00:00:00Z', y: 5 },
          { x: '2026-10-03T00:00:00Z', y: 7 },
        ],
        Date.parse('2026-10-01T00:00Z'),
        Date.parse('2026-10-03T23:59Z'),
        'UTC',
      ),
    ).toEqual([5, 0, 7]);
  });
  it('formats durations without unbounded minute counts', () => {
    expect(duration(null)).toBe('—');
    expect(duration(0)).toBe('00:00');
    expect(duration(59.4)).toBe('00:59');
    expect(duration(759)).toBe('12:39');
    expect(duration(3600)).toBe('1:00:00');
    expect(duration(45554)).toBe('12:39:14');
    expect(duration(45554 + 40 * 86400)).toBe('40 天 12 小时');
    expect(duration(90000, 'en-US')).toBe('1d 1h');
    expect(duration(90000, 'zh-CN')).toBe('1 天 1 小时');
  });
  it('excludes incomplete observation days and weights mature cohorts', () => {
    expect(completedObservationDate(Date.parse('2026-10-03T04:00Z'), 'Asia/Shanghai')).toBe(
      '2026-10-02',
    );
    expect(completedObservationDate(Date.parse('2026-10-03T15:59:59.999Z'), 'Asia/Shanghai')).toBe(
      '2026-10-03',
    );
    expect(
      retentionSummary(
        [
          { date: '2026-10-01', day: 0, visitors: 100 },
          { date: '2026-10-01', day: 1, returnVisitors: 20 },
          { date: '2026-10-02', day: 0, visitors: 10 },
          { date: '2026-10-02', day: 1, returnVisitors: 10 },
          { date: '2026-10-03', day: 0, visitors: 1000 },
        ],
        1,
        '2026-10-03',
      ),
    ).toEqual({ total: 110, returned: 30, percentage: (30 / 110) * 100 });
  });
  it('preserves repeated dimensions, plan conditions and existing typed properties', () => {
    const conditions = [
      { name: 'referrer', operator: 'eq', value: 'chatgpt.com' },
      { name: 'referrer', operator: 'eq', value: 'claude.ai' },
      { name: 'sessionPlan', operator: 'neq', value: 'free' },
    ];
    expect(conditionsToQuery(conditions, 'any', 'company.size', 'small')).toEqual({
      match: 'any',
      referrer: 'eq.chatgpt.com',
      referrer1: 'eq.claude.ai',
      spf0: '1.neq.plan.free',
      spf1: '1.eq.company%2Esize.small',
    });
    expect(
      savedConditionParameters(conditions, 'any', 'region', 'US', [
        { propertyName: 'score', dataType: 2, operator: 'gt', value: '5' },
      ]),
    ).toMatchObject({
      filters: conditions.slice(0, 2),
      sessionPropertyFilters: [
        { propertyName: 'plan', dataType: 1, operator: 'neq', value: 'free' },
        { propertyName: 'score', dataType: 2, operator: 'gt', value: '5' },
        { propertyName: 'region', dataType: 1, operator: 'eq', value: 'US' },
      ],
    });
  });
});

it('preserves missing comparison coverage without converting it to empty days', () => {
  const range = {
    startAt: Date.parse('2026-01-09T00:00:00Z'),
    endAt: Date.parse('2026-01-09T23:59:59Z'),
    timezone: 'UTC',
  };
  const missing = populationFromRow(
    {
      resourceKind: 'website',
      metricScope: 'qualified-browser',
      eligibleEvents: 5,
      qualifiedEvents: 0,
      eligiblePV: 5,
      qualifiedPV: 0,
      qualifiedVisitors: 0,
    },
    range,
  );
  expect(relativeDaySeries([], range.startAt, range.endAt, range.timezone, missing)).toEqual([
    null,
  ]);
  const empty = populationFromRow(
    {
      resourceKind: 'website',
      metricScope: 'qualified-browser',
      eligibleEvents: 0,
      qualifiedEvents: 0,
      eligiblePV: 0,
      qualifiedPV: 0,
      qualifiedVisitors: 0,
    },
    range,
  );
  expect(relativeDaySeries([], range.startAt, range.endAt, range.timezone, empty)).toEqual([0]);
});
