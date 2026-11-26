import { expect, it, vi } from 'vitest';
import { fromZonedTime } from 'date-fns-tz';
import type { AnalysisRead } from '../warehouse/analysis-context';
import { countLogWindow, logCountVersion } from './warehouse-log-hour-counts';

it.each([
  ['Asia/Kathmandu', '2026-11-16', '2026-11-17'],
  ['America/New_York', '2026-11-01', '2026-11-02'],
  ['America/New_York', '2026-03-08', '2026-03-09'],
])('combines validated hours and exact edges in %s on %s', async (zone, day, tomorrow) => {
  const start = +fromZonedTime(day + 'T00:00:00', zone);
  const end = +fromZonedTime(tomorrow + 'T00:00:00', zone) - 1;
  const first = Math.ceil(start / 3600000) * 3600000;
  const last = Math.floor(end / 3600000) * 3600000;
  const events = [start, first, first + 1, last, end, end + 0.5];
  const model: AnalysisRead = {
    site: 's',
    control: 'v',
    browser: [],
    log: [],
    logCounts: { version: logCountVersion, hours: {} },
  };
  for (let t = first; t < last; t += 3600000) {
    const n = events.filter(e => e >= t && e < t + 3600000).length;
    model.log.push([t / 1000, 'build', n, 0]);
    if (n) model.logCounts.hours[t / 1000] = ['build', n, 0];
  }
  const read = vi.fn(async (s: number, e: number, exclusive: boolean) => ({
    requests: events.filter(t => t >= s && (exclusive ? t < e : t <= e)).length,
    abnormal: 0,
  }));
  expect(await countLogWindow(model, start, end, read)).toEqual({ requests: 5, abnormal: 0 });
  expect(read.mock.calls).toEqual([
    ...(start < first ? [[start, first, true]] : []),
    [last, end, false],
  ]);
  model.logCounts.hours[first / 1000] = ['superseded', 17, 2];
  read.mockClear();
  expect(await countLogWindow(model, start, end, read)).toEqual({ requests: 5, abnormal: 0 });
  expect(read.mock.calls[0]).toEqual([start, first + 3600000, true]);
  model.logCounts.version = 'old';
  read.mockClear();
  expect(await countLogWindow(model, start, end, read)).toEqual({ requests: 5, abnormal: 0 });
  expect(read.mock.calls).toEqual([[start, end, false]]);
});
