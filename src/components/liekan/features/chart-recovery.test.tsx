import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { Chart } from './Chart';
const engine = vi.hoisted(() => ({ init: vi.fn(), renders: 0 }));
vi.mock('../chartRuntime', () => ({ loadEcharts: async () => ({ init: engine.init }) }));
beforeEach(() => {
  engine.renders = 0;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
  engine.init.mockImplementation((root: HTMLElement) => {
    root.replaceChildren(document.createElement('canvas'));
    return {
      setOption: () => {
        if (++engine.renders === 1) throw new Error('Rendering failed');
      },
      resize: vi.fn(),
      on: vi.fn(),
      dispose: () => root.replaceChildren(),
      getOption: () => ({}),
    };
  });
});
it('retries an already-loaded runtime without deleting React-owned recovery controls', async () => {
  const { unmount } = render(
    <Chart
      interactionKey="recovery-fixture"
      labels={['2026-10-04']}
      series={[{ name: '访问', values: [2] }]}
    />,
  );
  await screen.findByRole('group');
  fireEvent.click(screen.getByRole('button', { name: '重试图表' }));
  await waitFor(() => expect(engine.renders).toBe(2));
  expect(screen.getByRole('img')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  unmount();
});
