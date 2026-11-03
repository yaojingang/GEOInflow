import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ mount: vi.fn() }));
vi.mock('./LanguageSelector', () => ({ LanguageSelector: () => <span>Language</span> }));
vi.mock('./features/RobotsManagementPanel', () => ({
  RobotsManagementPanel: (props: any) => {
    calls.mount(props);
    return (
      <output data-test="robots-fixture">
        {props.websiteId} {props.initialView} {props.range?.startAt}
      </output>
    );
  },
}));
import { WebsiteToolbar } from './WebsiteToolbar';
afterEach(() => {
  cleanup();
  calls.mount.mockClear();
});
it('opens the current private website overview on demand and captures its date range', async () => {
  render(
    <WebsiteToolbar
      contextRef={() => {}}
      websiteId="site-a"
      range={{ startAt: 1000, endAt: 2000, timezone: 'UTC' }}
    />,
  );
  expect(calls.mount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'robots 管理' }));
  expect(await screen.findByTestId('robots-fixture')).toHaveTextContent('site-a overview 1000');
});
it('does not expose website management without a resolved website', () => {
  render(<WebsiteToolbar contextRef={() => {}} />);
  expect(screen.queryByRole('button', { name: 'robots 管理' })).not.toBeInTheDocument();
});
it('clears an open website panel when the website changes', async () => {
  const view = render(<WebsiteToolbar contextRef={() => {}} websiteId="site-a" />);
  fireEvent.click(screen.getByRole('button', { name: 'robots 管理' }));
  await screen.findByTestId('robots-fixture');
  view.rerender(<WebsiteToolbar contextRef={() => {}} websiteId="site-b" />);
  expect(screen.queryByTestId('robots-fixture')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'robots 管理' }));
  expect(await screen.findByTestId('robots-fixture')).toHaveTextContent('site-b overview');
});
