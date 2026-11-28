import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { KeywordExport } from './KeywordExport';
import { keywordConditionsSchema } from '@/lib/liekan/contracts/keywords';
import type { ExportFrame } from '@/lib/liekan/contracts/exports';
import type { LiekanReport } from './types';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';

const { stream } = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@/lib/liekan/upstream/features-client', () => ({ streamFeatureExport: stream }));
vi.mock('@/lib/liekan/upstream/client', () => ({
  useFeatureAppState: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'test-user' } }),
}));

const report = {
  website: { id: 'test-website' },
  range: { startAt: 0, endAt: 1000, timezone: 'Asia/Shanghai' },
} as LiekanReport;
const google = keywordConditionsSchema.parse({ engine: 'Google' });
const bing = keywordConditionsSchema.parse({ engine: 'Bing' });

function pendingExport() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  let onFrame!: (frame: ExportFrame) => void;
  let signal!: AbortSignal;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  stream.mockImplementationOnce(
    (_website: string, _body: unknown, abort: AbortSignal, callback: typeof onFrame) => {
      signal = abort;
      onFrame = callback;
      return promise;
    },
  );
  return {
    resolve,
    reject,
    get signal() {
      return signal;
    },
    frame: (frame: ExportFrame) => onFrame(frame),
  };
}

beforeEach(() => stream.mockReset());

it.each(['resolve', 'reject'] as const)(
  'keeps the active export when an aborted request completes late with %s after returning to the same filters',
  async completion => {
    const old = pendingExport();
    const latest = pendingExport();
    const view = render(<KeywordExport report={report} conditions={google} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: '导出全部筛选结果' }));
    expect(stream.mock.calls[0][1]).toMatchObject({ keywordStatusVersion: '2' });
    view.rerender(<KeywordExport report={report} conditions={bing} disabled={false} />);
    expect(old.signal.aborted).toBe(true);
    view.rerender(<KeywordExport report={report} conditions={google} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: '导出全部筛选结果' }));
    act(() => latest.frame({ type: 'progress', stage: '新任务正在生成', percent: 10 }));
    await act(async () => {
      if (completion === 'resolve') old.resolve();
      else old.reject(new DOMException('Aborted', 'AbortError'));
    });
    expect(screen.getByRole('button', { name: '正在导出' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('新任务正在生成');
    expect(screen.getByRole('button', { name: '取消导出' })).toBeEnabled();
    expect(stream).toHaveBeenCalledTimes(2);
    await act(async () => latest.reject(new Error('当前任务错误')));
    expect(screen.getByRole('status')).toHaveTextContent('当前任务错误');
    expect(screen.getByRole('button', { name: '导出全部筛选结果' })).toBeEnabled();
  },
);

it('shows cancellation for the current request and allows another export', async () => {
  const current = pendingExport();
  render(<KeywordExport report={report} conditions={google} disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: '导出全部筛选结果' }));
  fireEvent.click(screen.getByRole('button', { name: '取消导出' }));
  expect(current.signal.aborted).toBe(true);
  await act(async () => current.reject(new DOMException('Aborted', 'AbortError')));
  expect(screen.getByRole('status')).toHaveTextContent('导出已取消');
  expect(screen.getByRole('button', { name: '导出全部筛选结果' })).toBeEnabled();
});

it('captures the submission locale and keeps an active export when the display locale changes', async () => {
  const current = pendingExport();
  const view = render(
    <LiekanLocaleContext.Provider value="en-US">
      <KeywordExport report={report} conditions={google} disabled={false} />
    </LiekanLocaleContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Export all filtered results' }));
  expect(stream.mock.calls[0][1]).toMatchObject({ locale: 'en-US', engine: 'Google' });
  view.rerender(
    <LiekanLocaleContext.Provider value="zh-CN">
      <KeywordExport report={report} conditions={google} disabled={false} />
    </LiekanLocaleContext.Provider>,
  );
  expect(current.signal.aborted).toBe(false);
  expect(stream).toHaveBeenCalledTimes(1);
  await act(async () => current.reject(new Error('fixture failure')));
  const next = pendingExport();
  fireEvent.click(screen.getByRole('button', { name: '导出全部筛选结果' }));
  expect(stream.mock.calls[1][1]).toMatchObject({ locale: 'zh-CN' });
  await act(async () => next.reject(new Error('fixture failure')));
});

it('downloads a large prepared file without buffering it into a browser Blob', async () => {
  const current = pendingExport();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const previous = URL.createObjectURL,
    create = vi.fn();
  URL.createObjectURL = create;
  try {
    render(<KeywordExport report={report} conditions={google} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: '导出全部筛选结果' }));
    await act(async () => {
      current.frame({
        type: 'file',
        name: 'keywords.csv',
        size: 75 * 1024 * 1024,
        mime: 'text/csv',
        manifest: {},
        downloadUrl: '/api/liekan/websites/test/exports/prepared',
      });
      current.frame({ type: 'complete' });
      current.resolve();
    });
    expect(click).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('已导出全部筛选结果');
  } finally {
    URL.createObjectURL = previous;
    click.mockRestore();
  }
});
