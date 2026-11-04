// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ status: vi.fn(), facts: vi.fn() }));
vi.mock('@/lib/liekan/upstream/analytics-engine', () => ({
  getAnalyticsEngine: m.status,
  changeAnalyticsEngine: vi.fn(),
}));
vi.mock('@/lib/liekan/http', () => ({ api: m.facts, readBody: vi.fn() }));
import { LiekanError } from '@/lib/liekan/upstream/errors';
import { GET } from './route';
beforeEach(() => {
  vi.resetAllMocks();
  m.facts.mockRejectedValue(new Error('warehouse-authority-frozen'));
});
it('keeps authenticated control status visible while fact reads are frozen', async () => {
  m.status.mockResolvedValue({ warehouse: { authority: 'frozen', transition: 'draining' } });
  const response = await GET(new Request('http://localhost/api/liekan/admin/analytics-engine'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ warehouse: { authority: 'frozen' } });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(m.facts).not.toHaveBeenCalled();
});
it.each([401, 403])('preserves administrator authentication rejection %s', async status => {
  m.status.mockRejectedValue(new LiekanError('denied', status, 'engine-admin-required'));
  const response = await GET(new Request('http://localhost'));
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});
it('does not expose connection errors or credentials', async () => {
  m.status.mockRejectedValue(new Error('postgres://secret@private.invalid'));
  const response = await GET(new Request('http://localhost'));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('secret');
});
