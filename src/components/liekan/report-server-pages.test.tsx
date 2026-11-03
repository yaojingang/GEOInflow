import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReportList, ReportRows } from './ReportComponents';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';
import { translateText } from '@/lib/liekan/i18n/text';
import { ReportContext, type ReportActions } from './ReportContext';
import type { LiekanReport, Row } from './types';

const baseActions: ReportActions = {
  filter: '',
  query: '',
  sort: { label: '', direction: -1 },
  period: '30 天',
  onFilter() {},
  onSort() {},
  onAction() {},
};

function report(): LiekanReport {
  return {
    contractVersion: 2,
    website: { id: 'site', name: '站点', domain: 'example.test' },
    range: { startAt: 1, endAt: 2, timezone: 'Asia/Shanghai' },
    states: {
      human: 'available',
      logs: 'available',
      catalog: 'available',
      goals: 'not_connected',
    },
    cards: [],
    charts: {},
    tables: {},
    insights: [],
    meta: { demo: false, canManage: true, latestImportAt: null, ruleCount: 0 },
  };
}

function rows(from: number, to: number): Row[] {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    path: `/page-${from + i}`,
    pv: to - from - i,
  }));
}

function renderTable(table: string, data: LiekanReport, actions = baseActions) {
  return render(
    <ReportContext.Provider value={actions}>
      <table>
        <ReportRows table={table} report={data} pageSize={20} />
      </table>
    </ReportContext.Provider>,
  );
}

const click = async (button: HTMLElement) => {
  await act(async () => {
    fireEvent.click(button);
  });
};

describe('server-paged detail tables', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    it(`renders and requests the blind-spot server page without slicing it twice in ${locale}`, async () => {
      const onTablePage = vi.fn();
      const data = report();
      data.tables.blindList = rows(21, 40);
      data.meta.tablePages = {
        blindList: { page: 2, pageSize: 20, total: 100005 },
        apBody: { page: 7, pageSize: 20, total: 200 },
      };
      const list = () => (
        <LiekanLocaleContext.Provider value={locale}>
          <ReportContext.Provider value={{ ...baseActions, onTablePage }}>
            <ReportList
              id="blindList"
              className="divide-y divide-line/60 text-[12px]"
              report={data}
              pageSize={20}
            />
          </ReportContext.Provider>
        </LiekanLocaleContext.Provider>
      );
      const view = render(list());
      expect(screen.getByText('https://example.test/page-21')).toBeInTheDocument();
      expect(screen.getByText('https://example.test/page-40')).toBeInTheDocument();
      expect(document.getElementById('blindList')?.children).toHaveLength(20);
      await click(screen.getByRole('button', { name: translateText('下一页', locale) }));
      expect(onTablePage).toHaveBeenLastCalledWith('blindList', 3);
      await click(screen.getByRole('button', { name: translateText('上一页', locale) }));
      expect(onTablePage).toHaveBeenLastCalledWith('blindList', 1);
      expect(data.meta.tablePages.apBody.page).toBe(7);
      data.tables.blindList = rows(100001, 100005);
      data.meta.tablePages.blindList.page = 5001;
      view.rerender(list());
      expect(screen.getByText('https://example.test/page-100005')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: translateText('下一页', locale) })).toBeDisabled();
      data.tables.blindList = rows(1, 20);
      data.meta.tablePages.blindList.page = 1;
      view.rerender(list());
      expect(screen.getByText('https://example.test/page-1')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: translateText('上一页', locale) })).toBeDisabled();
    });

    it(`keeps legacy blind-spot arrays on client pagination in ${locale}`, async () => {
      const onTablePage = vi.fn();
      const data = report();
      data.tables.blindList = rows(1, 45);
      // Another server-paged table does not switch the legacy list into server mode.
      data.meta.tablePages = { apBody: { page: 2, pageSize: 20, total: 45 } };
      render(
        <LiekanLocaleContext.Provider value={locale}>
          <ReportContext.Provider value={{ ...baseActions, onTablePage }}>
            <ReportList id="blindList" className="" report={data} pageSize={20} />
          </ReportContext.Provider>
        </LiekanLocaleContext.Provider>,
      );
      await click(screen.getByRole('button', { name: translateText('下一页', locale) }));
      expect(screen.getByText('https://example.test/page-21')).toBeInTheDocument();
      expect(screen.queryByText('https://example.test/page-20')).not.toBeInTheDocument();
      expect(onTablePage).not.toHaveBeenCalled();
    });
  }

  it('renders the server slice with pager state from meta and routes page turns', async () => {
    const onTablePage = vi.fn();
    const data = report();
    data.tables.topBody = rows(21, 40);
    data.meta.tablePages = { topBody: { page: 2, pageSize: 20, total: 45 } };
    renderTable('topBody', data, { ...baseActions, onTablePage });
    expect(screen.getByText('共 45 条')).toBeInTheDocument();
    expect(screen.getByText('第 2 / 3 页')).toBeInTheDocument();
    expect(screen.getByText('https://example.test/page-21')).toBeInTheDocument();
    expect(screen.getByText('https://example.test/page-40')).toBeInTheDocument();
    expect(screen.queryByText('https://example.test/page-1')).not.toBeInTheDocument();
    await click(screen.getByRole('button', { name: '下一页' }));
    expect(onTablePage).toHaveBeenCalledTimes(1);
    expect(onTablePage).toHaveBeenCalledWith('topBody', 3);
    await click(screen.getByRole('button', { name: '上一页' }));
    expect(onTablePage).toHaveBeenCalledWith('topBody', 1);
  });

  it('hides the pager when the server total fits one page', () => {
    const data = report();
    data.tables.topBody = rows(1, 12);
    data.meta.tablePages = { topBody: { page: 1, pageSize: 20, total: 12 } };
    renderTable('topBody', data);
    expect(screen.queryByText(/共 \d+ 条/)).not.toBeInTheDocument();
    expect(screen.getByText('https://example.test/page-12')).toBeInTheDocument();
  });

  it('labels current-page-only filtering when local filters act on a slice', () => {
    const data = report();
    data.tables.topBody = rows(21, 40);
    data.meta.tablePages = { topBody: { page: 2, pageSize: 20, total: 45 } };
    renderTable('topBody', data, { ...baseActions, filter: '按 PV' });
    expect(screen.getByText('当前页内筛选 · 共 45 条')).toBeInTheDocument();
  });

  it('keeps the pager visible when a local filter empties the current slice', () => {
    const data = report();
    data.tables.topBody = rows(21, 40);
    data.meta.tablePages = { topBody: { page: 2, pageSize: 20, total: 45 } };
    renderTable('topBody', data, { ...baseActions, query: '没有的路径' });
    expect(screen.getByText('没有匹配的记录')).toBeInTheDocument();
    expect(screen.getByText('当前页内筛选 · 共 45 条')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled();
  });

  it('keeps unkeyed tables on the client paging behavior', async () => {
    const data = report();
    data.tables.topBody = rows(1, 25);
    data.meta.tablePages = { pgBody: { page: 1, pageSize: 20, total: 30 } };
    renderTable('topBody', data);
    expect(screen.getByText('共 25 条')).toBeInTheDocument();
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument();
    expect(screen.queryByText('https://example.test/page-21')).not.toBeInTheDocument();
    await click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('https://example.test/page-21')).toBeInTheDocument();
  });
});
