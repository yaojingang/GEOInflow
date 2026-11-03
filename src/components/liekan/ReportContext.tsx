'use client';
import type { KeywordConditions } from '@/lib/liekan/contracts/keywords';
import type { CrawlerPageFilters } from '@/lib/liekan/contracts/query';
import { createContext, useContext } from 'react';
export type ReportActions = {
  crawlers?: {
    conditions: CrawlerPageFilters;
    onChange: (next: CrawlerPageFilters) => void;
  };
  keywords?: {
    conditions: KeywordConditions;
    busy: boolean;
    onChange: (next: Partial<KeywordConditions>) => void;
    onPage: (page: number) => void;
  };
  filter: string;
  query: string;
  sort: { label: string; direction: number };
  period: string;
  onFilter: (label: string) => void;
  onSort: (label: string) => void;
  onAction: (label: string) => void;
  onLogsPage?: (page: number) => void;
  // 服务端分页明细表翻页：meta.tablePages 内的 ReportRows / ReportList 共用同一协议。
  onTablePage?: (table: string, page: number) => void;
};
export const ReportContext = createContext<ReportActions>({
  filter: '',
  query: '',
  sort: { label: '', direction: -1 },
  period: '30 天',
  onFilter() {},
  onSort() {},
  onAction() {},
});
export function useReportActions() {
  return useContext(ReportContext);
}
