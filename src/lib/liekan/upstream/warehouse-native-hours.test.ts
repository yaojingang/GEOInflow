// @vitest-environment node
import { expect, it } from 'vitest';
import {
  analysisWindowRelation,
  analysisReadRelation,
  withAnalysisRead,
  type AnalysisRead,
} from '../warehouse/analysis-context';
import { nativeHourlyStats } from './warehouse-native-hours';

const start = +new Date('2026-11-01T00:00:00Z');
const window = { start, end: start + 7200000 - 1 };
const value: AnalysisRead = {
  site: 'site',
  control: 'control',
  browser: [0, 1].map(i => [start / 1000 + i * 3600, 'build', 1, 1]),
  log: [],
};
const sql = 'select sum(views),uniq(session_id) from website_event_stats_hourly as website_event';
const params = {
  websiteId: 'site',
  startDate: new Date(start),
  endDate: new Date(window.end),
  timezone: 'UTC',
  unit: 'hour',
};

it('requires runtime verification and every requested bucket, rather than trusting copied coverage', () => {
  expect(
    withAnalysisRead(value, () => analysisWindowRelation('browser', ['event_id'], window)),
  ).toBeUndefined();
  withAnalysisRead(
    value,
    () => {
      expect(analysisWindowRelation('browser', ['event_id'], window)).toContain(
        'warehouse_analysis_browser_v1',
      );
      expect(
        analysisWindowRelation('browser', ['event_id'], { ...window, end: window.end + 1 }),
      ).toBeUndefined();
      expect(
        analysisWindowRelation('browser', ['event_id'], {
          ...window,
          end: window.end + 1,
          endExclusive: true,
        }),
      ).toContain('created_at<');
      expect(
        withAnalysisRead(value, () => analysisWindowRelation('browser', ['event_id'], window)),
      ).toBeUndefined();
    },
    [],
    ['browser'],
  );
});

it('uses a verified empty-gap proof only inside its exact family and time window', () => {
  const gapWindow = { start, end: window.end + 3600000 };
  withAnalysisRead(
    value,
    () => {
      expect(analysisWindowRelation('browser', ['event_id'], gapWindow)).toContain(
        'warehouse_analysis_browser_v1',
      );
      expect(
        analysisWindowRelation('browser', ['event_id'], {
          ...gapWindow,
          end: gapWindow.end + 1,
        }),
      ).toBeUndefined();
      // A window proof cannot authorize an unbounded visit anchor or a different family.
      expect(analysisReadRelation('browser', ['event_id'], () => 'raw_events')).toContain(
        'raw_events',
      );
      expect(analysisWindowRelation('log', ['id'], gapWindow)).toBeUndefined();
      expect(
        withAnalysisRead(value, () => analysisWindowRelation('browser', ['event_id'], gapWindow)),
      ).toBeUndefined();
    },
    [],
    ['browser'],
    { browser: gapWindow },
  );
});

it('uses physical fragments only for audited PV/UV series and exact calendar boundaries', () => {
  withAnalysisRead(
    value,
    () => {
      const query = nativeHourlyStats('getPageviewStats', sql, params, window);
      expect(query).toContain('warehouse_analysis_visit_hour_v1');
      expect(query).not.toContain('UNION ALL');
      const edge = nativeHourlyStats('getSessionStats', sql, params, {
        ...window,
        start: start + 1,
      });
      expect(edge).toContain('UNION ALL');
      expect(edge).toContain('warehouse_analysis_browser_v1');
      for (const changed of [{ timezone: 'Asia/Kolkata' }, { unit: 'minute' }, { country: 'CN' }])
        expect(
          nativeHourlyStats('getPageviewStats', sql, { ...params, ...changed }, window),
        ).toBeUndefined();
      expect(nativeHourlyStats('getRetention', sql, params, window)).toBeUndefined();
      expect(
        nativeHourlyStats('getPageviewStats', sql + ' JOIN other', params, window),
      ).toBeUndefined();
    },
    [],
    ['browser'],
  );
});
