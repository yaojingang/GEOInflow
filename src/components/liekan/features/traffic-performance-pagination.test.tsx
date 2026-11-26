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
  mode: 'performance' as const,
};
beforeEach(() => {
  mocks.request.mockReset();
  mocks.reset = false;
  mocks.sections = true;
  mocks.request.mockImplementation(async (_method, endpoint, query) => {
    const reset = endpoint.endsWith('/performance') && mocks.reset;
    if (reset) mocks.reset = false;
    const fieldCoveragePage = reset ? 1 : query.fieldCoveragePage || 1;
    const reasonsPage = reset ? 1 : query.reasonsPage || 1;
    return {
      meta: {
        sources: [],
        snapshot: reset ? 'c'.repeat(64) : 'a'.repeat(64),
        policySnapshot: 'b'.repeat(64),
        readAt: new Date(range.endAt).toISOString(),
        conditions: query,
        quality: { state: 'complete' },
        page: 1,
        total: 1,
        reset,
        ...(mocks.sections
          ? {
              sectionPages: {
                reasons: { page: reasonsPage, total: 41, pageSize: 20 },
                fieldCoverage: { page: fieldCoveragePage, total: 61, pageSize: 20 },
              },
            }
          : {}),
      },
      rows: [
        {
          unit: 'edge_body',
          observedBytes: '100',
          samples: 3,
          requests: 3,
          peakMinuteBytes: '100',
        },
      ],
      reasons: [{ status: `cache-${reasonsPage}`, requests: 3 }],
      fieldCoverage: [
        {
          field: 'EdgeResponseContentType',
          state: 'present',
          value: `type-${fieldCoveragePage}`,
          requests: 3,
        },
      ],
      totals: {
        rpm: 3,
        peakMinuteAverageRps: 0.05,
        incompleteMinuteRequests: 0,
        edgeOverLimit: 0,
        originOverLimit: 0,
        unattributedOrigin: 0,
      },
      coverage: {},
    };
  });
});
const requests = () =>
  mocks.request.mock.calls.filter(([, endpoint]) => endpoint.endsWith('/performance'));
for (const locale of ['zh-CN', 'en-US'] as LiekanLocale[]) {
  it(`paginates cache and field coverage independently in ${locale}, retaining aggregate rows`, async () => {
    const panel = (value = range) => (
      <LiekanLocaleContext.Provider value={locale}>
        <TrafficEvidencePanel {...props} range={value} />
      </LiekanLocaleContext.Provider>
    );
    const view = render(panel());
    await screen.findByText('cache-1');
    fireEvent.click(screen.getByText(translateText('边缘字段可用性与分布', locale)));
    const next = () => screen.getAllByRole('button', { name: translateText('下一页', locale) });
    expect(next()).toHaveLength(2);
    fireEvent.click(next()[1]);
    await screen.findByText('type-2');
    expect(requests().at(-1)[2]).toMatchObject({ page: 1, reasonsPage: 1, fieldCoveragePage: 2 });
    expect(screen.getByText('cache-1')).toBeInTheDocument();
    // Refetch remounts the existing result block and closes native details.
    fireEvent.click(next()[0]);
    await screen.findByText('cache-2');
    expect(requests().at(-1)[2]).toMatchObject({ page: 1, reasonsPage: 2, fieldCoveragePage: 2 });
    expect(screen.getByText('type-2')).toBeInTheDocument();
    expect(screen.getByText(translateText('边缘响应正文', locale))).toBeInTheDocument();
    view.rerender(panel({ ...range, startAt: range.startAt + 1000 }));
    await waitFor(() =>
      expect(requests().at(-1)[2]).toMatchObject({
        page: 1,
        reasonsPage: 1,
        fieldCoveragePage: 1,
        startAt: range.startAt + 1000,
      }),
    );
    await screen.findByText('cache-1');
    expect(screen.getByText('type-1')).toBeInTheDocument();
  });
}
it('resets both secondary sections after snapshot invalidation', async () => {
  render(<TrafficEvidencePanel {...props} />);
  await screen.findByText('cache-1');
  fireEvent.click(screen.getByText('边缘字段可用性与分布'));
  fireEvent.click(screen.getAllByRole('button', { name: '下一页' })[1]);
  await screen.findByText('type-2');
  mocks.reset = true;
  fireEvent.click(screen.getAllByRole('button', { name: '下一页' })[0]);
  await waitFor(() =>
    expect(requests().at(-1)[2]).toMatchObject({ page: 1, reasonsPage: 1, fieldCoveragePage: 1 }),
  );
  await screen.findByText('cache-1');
  expect(screen.getByText('type-1')).toBeInTheDocument();
});
it('keeps legacy PG cache and field coverage tables unpaged', async () => {
  mocks.sections = false;
  render(<TrafficEvidencePanel {...props} />);
  await screen.findByText('cache-1');
  fireEvent.click(screen.getByText('边缘字段可用性与分布'));
  expect(screen.getByText('type-1')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument();
  expect(requests().at(-1)[2]).toMatchObject({ page: 1, reasonsPage: 1, fieldCoveragePage: 1 });
});
