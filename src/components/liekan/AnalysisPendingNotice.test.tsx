import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnalysisPendingNotice } from './AnalysisPendingNotice';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';

const state = vi.hoisted(() => ({ value: '[]', resume: vi.fn() }));
vi.mock('@/lib/liekan/upstream/analysis-query-client', () => ({
  analysisPendingStore: {
    subscribe: () => () => {},
    snapshot: () => state.value,
    serverSnapshot: () => state.value,
    resume: state.resume,
  },
}));
beforeEach(() => {
  state.value = '[]';
  state.resume.mockClear();
});
afterEach(cleanup);

it('shows queued work for the current website immediately', () => {
  state.value = JSON.stringify([
    { id: 'task', websiteId: 'site', paused: false, job: { status: 'queued' } },
  ]);
  render(<AnalysisPendingNotice websiteId="site" />);
  expect(screen.getByRole('status')).toHaveTextContent('统计任务排队中');
});
it('shows computation in English without exposing a made-up percentage', () => {
  state.value = JSON.stringify([
    { id: 'task', websiteId: 'site', paused: false, job: { status: 'running' } },
  ]);
  render(
    <LiekanLocaleContext.Provider value="en-US">
      <AnalysisPendingNotice websiteId="site" />
    </LiekanLocaleContext.Provider>,
  );
  expect(screen.getByRole('status')).toHaveTextContent('Calculating statistics');
  expect(screen.getByRole('status')).not.toHaveTextContent('%');
});
it('keeps paused work resumable and hides other websites', () => {
  state.value = JSON.stringify([{ id: 'task', websiteId: 'other', paused: true }]);
  const view = render(<AnalysisPendingNotice websiteId="site" />);
  expect(screen.queryByRole('alert')).toBeNull();
  view.rerender(<AnalysisPendingNotice websiteId="other" />);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(state.resume).toHaveBeenCalledWith('task');
});
