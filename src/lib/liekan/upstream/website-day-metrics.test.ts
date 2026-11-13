import { describe, expect, it } from 'vitest';
import { getCompareDate } from '@/lib/date';
import { projectToday, projectTrend, websiteDayWindow } from './website-day-metrics';

describe('websiteDayWindow', () => {
  it('returns the exact local day window for a fixed-offset timezone', () => {
    // 2026-10-08 10:30 CST === 2026-10-08 02:30 UTC
    const now = Date.parse('2026-10-08T02:30:00Z');
    expect(websiteDayWindow('Asia/Shanghai', now)).toEqual({
      startAt: Date.parse('2026-10-07T16:00:00Z'),
      endAt: Date.parse('2026-10-08T15:59:59.999Z'),
      timezone: 'Asia/Shanghai',
    });
  });

  it('compares a 23-hour day to the full previous local day', () => {
    const timezone = 'America/New_York';
    const { startAt, endAt } = websiteDayWindow(timezone, Date.parse('2026-03-08T16:00:00Z'));
    expect(endAt + 1 - startAt).toBe(23 * 3600000);
    const previous = getCompareDate('prev', new Date(startAt), new Date(endAt), timezone);
    expect(previous.startDate.toISOString()).toBe('2026-03-07T05:00:00.000Z');
    expect(previous.endDate.toISOString()).toBe('2026-03-08T04:59:59.999Z');
  });

  it('keeps the local calendar day across DST transitions', () => {
    // 2026-10-07 23:00 in New York is still the same local day as 2026-10-07 06:00.
    const morning = Date.parse('2026-10-07T10:00:00Z'); // 06:00 EDT (UTC-4)
    const night = Date.parse('2026-10-08T03:00:00Z'); // 23:00 EDT
    expect(websiteDayWindow('America/New_York', morning).startAt).toBe(
      Date.parse('2026-10-07T04:00:00Z'),
    );
    expect(websiteDayWindow('America/New_York', night).startAt).toBe(
      Date.parse('2026-10-07T04:00:00Z'),
    );
    expect(websiteDayWindow('America/New_York', morning).endAt).toBe(
      websiteDayWindow('America/New_York', night).endAt,
    );
  });
});

describe('projectToday', () => {
  const noon = Date.parse('2026-10-08T04:00:00Z'); // 12:00 CST — half the day gone

  it('scales the measured value by elapsed progress', () => {
    expect(projectToday(100, 'Asia/Shanghai', noon)).toBe(200);
  });

  it('never divides by less than ten minutes of progress', () => {
    const dawn = Date.parse('2026-10-07T16:05:00Z'); // 00:05 CST
    expect(projectToday(100, 'Asia/Shanghai', dawn)).toBe(Math.round((100 * 86400000) / 600000));
  });

  it('caps the projection at the measured value after midnight crossing', () => {
    const lastMinute = Date.parse('2026-10-08T15:59:30Z'); // 23:59:30 CST
    expect(projectToday(999, 'Asia/Shanghai', lastMinute)).toBeGreaterThanOrEqual(999);
  });

  it('returns null for missing or invalid input', () => {
    expect(projectToday(null, 'Asia/Shanghai', noon)).toBeNull();
    expect(projectToday(Number.NaN, 'Asia/Shanghai', noon)).toBeNull();
  });
});

describe('projectTrend', () => {
  it('compares the projection with yesterday', () => {
    expect(projectTrend(200, 100)).toBe(1);
    expect(projectTrend(50, 100)).toBe(-1);
    expect(projectTrend(100, 100)).toBe(0);
    expect(projectTrend(null, 100)).toBe(0);
    expect(projectTrend(200, null)).toBe(0);
  });
});
