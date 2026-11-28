import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/** Equivalent IANA names share the same persisted calculation identity. */
export function canonicalGeoTimezone(timezone: string) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    // The API reports invalid settings using its normal parameter error response.
    return timezone;
  }
}

export function geoDateOffset(date: string, days: number) {
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function geoAsOf(endAt: number, timezone: string, now = Date.now()) {
  const selected = formatInTimeZone(endAt - 1, timezone, 'yyyy-MM-dd');
  const yesterday = geoDateOffset(formatInTimeZone(now, timezone, 'yyyy-MM-dd'), -1);
  return selected < yesterday ? selected : yesterday;
}
export function geoWindow(asOf: string, timezone: string) {
  return {
    asOf,
    startAt: +fromZonedTime(geoDateOffset(asOf, -29) + 'T00:00:00', timezone),
    endAt: +fromZonedTime(geoDateOffset(asOf, 1) + 'T00:00:00', timezone),
  };
}

export function geoScoreWindows(asOf: string, timezone: string, view: 'summary' | 'detail') {
  return (view === 'detail' ? [0, 7, 14, 21, 28, 30] : [0]).map(days =>
    geoWindow(geoDateOffset(asOf, -days), timezone),
  );
}
