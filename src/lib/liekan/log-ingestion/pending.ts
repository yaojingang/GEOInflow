// GEO uses the first evidence day as well as the scoring window, so there is no lower cutoff.
export function pendingBeforeSql(cutoff: '$2' | 'cutoff') {
  return `state='pending' AND valid>0 AND (min_event_at IS NULL OR min_event_at<${cutoff}::timestamptz)`;
}
