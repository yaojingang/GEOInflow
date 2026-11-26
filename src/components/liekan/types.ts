import type { DataState, LiekanReport, Row } from '@/lib/liekan/contracts/report';

export type { DataState, LiekanReport, Row };
export type ChartData = LiekanReport['charts'][string];
export type ReportViewProps = {
  trend?: {
    key: string;
    onInvalidated: (error: unknown) => void;
    userId: string;
    websiteId: string;
    teamId?: string;
    timezone: string;
    endAt: number;
    resource: 'overview' | 'human/overview';
    basePeriod: 'today' | '7d' | '30d' | '24h';
    initialPeriod: 'today' | '7d' | '30d' | '24h';
  };
  geoWeight?: import('react').ReactNode;
  report?: LiekanReport;
  rangeLabel: string;
  trendLabel?: string;
  live?: boolean;
  aiCrawlerEnabled?: boolean;
};
export type Resource =
  | 'overview'
  | 'ai/overview'
  | 'ai/bots'
  | 'ai/pages'
  | 'ai/preference'
  | 'human/overview'
  | 'human/geo'
  | 'human/sources'
  | 'human/search-engines'
  | 'human/keywords'
  | 'content'
  | 'conversions'
  | 'logs';
