import type { ReportResource } from './page-report';
/** Details/realtime retain cursor reads. These aggregate pages publish immutable results. */
export const scheduledReportResources: readonly ReportResource[] = [
  'overview',
  'ai/overview',
  'ai/bots',
  'ai/pages',
  'ai/preference',
  'human/overview',
  'human/geo',
  'human/sources',
  'human/search-engines',
  'content',
  'conversions',
];
export const isScheduledReport = (resource: string): resource is ReportResource =>
  scheduledReportResources.includes(resource as ReportResource);
