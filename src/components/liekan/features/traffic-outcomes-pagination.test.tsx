import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { TrafficEvidencePanel } from './TrafficEvidencePanel';
import { LiekanLocaleContext } from '@/lib/liekan/i18n/client';
import { translateText } from '@/lib/liekan/i18n/text';
import type { LiekanLocale } from '@/lib/liekan/i18n/locale';
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  download: vi.fn(),
  reset: false,
  sections: true,
}));
vi.mock('@/lib/liekan/upstream/features-client', () => ({
  featureRequest: mocks.request,
  downloadTrafficEvidence: mocks.download,
}));
const range = { startAt: 1792022400000, endAt: 1792108800000, timezone: 'UTC' };
const props = {
  websiteId: '12345678-1234-4234-8234-123456789012',
  hostname: 'example.com',
  range,
  mode: 'outcomes' as const,
};
beforeEach(() => {
  mocks.request.mockReset();
  mocks.reset = false;
  mocks.sections = true;
  mocks.request.mockImplementation(async (_method, endpoint, query) => {
    const reset = endpoint.endsWith('/outcomes') && mocks.reset;
    if (reset) mocks.reset = false;
    const page = reset ? 1 : query.page || 1;
    const reasonsPage = reset ? 1 : query.reasonsPage || 1;
    return {
      meta: {
        sources: [],
        snapshot: reset ? 'c'.repeat(64) : 'a'.repeat(64),
        policySnapshot: 'b'.repeat(64),
        readAt: new Date(range.endAt).toISOString(),
        conditions: query,
        quality: { state: 'complete' },
        page,
        total: 41,
        reset,
        ...(mocks.sections
          ? { sectionPages: { reasons: { page: reasonsPage, total: 41, pageSize: 20 } } }
          : {}),
      },
      rows: [
        {
          platformId: 'landing',
          path: `/landing-${page}`,
          requests: 3,
          visits: null,
          conversions: null,
          ratio: { value: null, reasonCode: 'browser_missing' },
        },
      ],
      reasons: [
        {
          platformId: `platform-${reasonsPage}`,
          requests: 3,
          get2xx: 3,
          catalogPaths: 1,
          visits: null,
          conversions: null,
          goalEvents: null,
          conversionRate: null,
        },
      ],
    };
  });
});
const requests = () =>
  mocks.request.mock.calls.filter(([, endpoint]) => endpoint.endsWith('/outcomes'));
for (const locale of ['zh-CN', 'en-US'] as LiekanLocale[]) {
  it(`paginates platform summaries independently in ${locale}, and resets both pages with range changes`, async () => {
    const panel = (value = range) => (
      <LiekanLocaleContext.Provider value={locale}>
        <TrafficEvidencePanel {...props} range={value} />
      </LiekanLocaleContext.Provider>
    );
    const view = render(panel());
    await screen.findByText('platform-1');
    const next = () => screen.getAllByRole('button', { name: translateText('下一页', locale) });
    expect(next()).toHaveLength(2);
    fireEvent.click(next()[0]);
    await screen.findByText('platform-2');
    expect(requests().at(-1)[2]).toMatchObject({ page: 1, reasonsPage: 2 });
    expect(screen.getByText('/landing-1')).toBeInTheDocument();
    fireEvent.click(next()[1]);
    await screen.findByText('/landing-2');
    expect(requests().at(-1)[2]).toMatchObject({ page: 2, reasonsPage: 2 });
    expect(screen.getByText('platform-2')).toBeInTheDocument();
    view.rerender(panel({ ...range, startAt: range.startAt + 1000 }));
    await waitFor(() =>
      expect(requests().at(-1)[2]).toMatchObject({
        page: 1,
        reasonsPage: 1,
        startAt: range.startAt + 1000,
      }),
    );
    await screen.findByText('platform-1');
    expect(screen.getByText('/landing-1')).toBeInTheDocument();
  });
}
it('resets both paging states after the server invalidates a snapshot', async () => {
  render(<TrafficEvidencePanel {...props} />);
  await screen.findByText('platform-1');
  fireEvent.click(screen.getAllByRole('button', { name: '下一页' })[0]);
  await screen.findByText('platform-2');
  mocks.reset = true;
  fireEvent.click(screen.getAllByRole('button', { name: '下一页' })[1]);
  await waitFor(() => expect(requests().at(-1)[2]).toMatchObject({ page: 1, reasonsPage: 1 }));
  await screen.findByText('platform-1');
  expect(screen.getByText('/landing-1')).toBeInTheDocument();
});
it('keeps the legacy PG summary table unpaged when section metadata is absent', async () => {
  mocks.sections = false;
  render(<TrafficEvidencePanel {...props} />);
  await screen.findByText('platform-1');
  expect(screen.getAllByRole('button', { name: '下一页' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('/landing-2');
  expect(requests().at(-1)[2]).toMatchObject({ page: 2, reasonsPage: 1 });
});
