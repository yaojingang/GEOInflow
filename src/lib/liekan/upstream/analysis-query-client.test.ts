import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { AnalysisPendingNotice } from '@/components/liekan/AnalysisPendingNotice';
import {
  analysisAsyncPath,
  analysisPendingStore,
  followAnalysisJob,
  waitForAnalysisAdmission,
} from './analysis-query-client';
const id = '11111111-1111-4111-8111-111111111111',
  site = '22222222-2222-4222-8222-222222222222';
const job = {
  id,
  websiteId: site,
  status: 'queued',
  queuedAt: '2026-01-01',
  startedAt: null,
  completedAt: null,
  generatedAt: null,
  expiresAt: null,
  errorCode: null,
  retryAfterMs: 3000,
  resultUrl: `/liekan/websites/${site}/analytics-jobs/${id}/result`,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('polls status at a bounded interval and fetches the final data once', async () => {
  const fetchJob = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ analysisJob: { ...job, status: 'running' } }))
    .mockResolvedValueOnce(Response.json({ analysisJob: { ...job, status: 'ready' } }))
    .mockResolvedValueOnce(Response.json({ pageviews: 12 }));
  const pending = followAnalysisJob({ analysisJob: job }, { fetchJob });
  expect(JSON.parse(analysisPendingStore.snapshot())).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2999);
  expect(fetchJob).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fetchJob).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect((await pending).data).toEqual({ pageviews: 12 });
  expect(fetchJob.mock.calls.at(-1)[0]).toBe(job.resultUrl);
  expect(analysisPendingStore.snapshot()).toBe('[]');
});
it.each(['status', 'result'])(
  'retains the same task through a retryable %s lock timeout',
  async phase => {
    const busy = () =>
      Response.json(
        { error: { code: 'analysis-read-busy' } },
        { status: 503, headers: { 'Retry-After': '4' } },
      );
    const fetchJob = vi.fn();
    if (phase === 'status') fetchJob.mockResolvedValueOnce(busy());
    else
      fetchJob
        .mockResolvedValueOnce(Response.json({ analysisJob: { ...job, status: 'ready' } }))
        .mockResolvedValueOnce(busy());
    fetchJob
      .mockResolvedValueOnce(Response.json({ analysisJob: { ...job, status: 'ready' } }))
      .mockResolvedValueOnce(Response.json({ pageviews: 12 }));
    const releaseJob = vi.fn(async () => {});
    const pending = followAnalysisJob({ analysisJob: job }, { fetchJob, releaseJob });
    const settled = vi.fn();
    void pending.then(settled, settled);
    await vi.advanceTimersByTimeAsync(3000);
    const calls = fetchJob.mock.calls.length;
    expect(settled).not.toHaveBeenCalled();
    expect(releaseJob).not.toHaveBeenCalled();
    expect(JSON.parse(analysisPendingStore.snapshot())[0].job.id).toBe(id);
    await vi.advanceTimersByTimeAsync(3999);
    expect(fetchJob).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).data).toEqual({ pageviews: 12 });
    expect(releaseJob).toHaveBeenCalledOnce();
  },
);
it.each([401, 403, 410, 500, 503])('stops for non-retryable HTTP %s', async status => {
  const fetchJob = vi.fn(async () =>
    Response.json({ error: { code: 'analysis-failed' } }, { status }),
  );
  const pending = followAnalysisJob({ analysisJob: job }, { fetchJob });
  const assertion = expect(pending).rejects.toMatchObject({ status, code: 'analysis-failed' });
  await vi.advanceTimersByTimeAsync(3000);
  await assertion;
  expect(fetchJob).toHaveBeenCalledOnce();
});
it('aborts a transient lock retry and releases only the current viewer', async () => {
  const controller = new AbortController();
  const fetchJob = vi.fn(async () =>
    Response.json({ error: { code: 'analysis-read-busy' } }, { status: 503 }),
  );
  const releaseJob = vi.fn(async () => {});
  const pending = followAnalysisJob(
    { analysisJob: job },
    { fetchJob, releaseJob, signal: controller.signal },
  );
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(3000);
  expect(fetchJob).toHaveBeenCalledOnce();
  controller.abort();
  await assertion;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetchJob).toHaveBeenCalledOnce();
  expect(releaseJob).toHaveBeenCalledWith(job.resultUrl.replace(/\/result$/, ''));
  expect(analysisPendingStore.snapshot()).toBe('[]');
});
it('pauses hidden tabs and aborts the consumer without deleting server work', async () => {
  vi.mocked(vi.spyOn(document, 'visibilityState', 'get')).mockReturnValue('hidden');
  const controller = new AbortController(),
    fetchJob = vi.fn();
  const pending = followAnalysisJob({ analysisJob: job }, { fetchJob, signal: controller.signal });
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(12000);
  expect(fetchJob).not.toHaveBeenCalled();
  controller.abort();
  await assertion;
  expect(analysisPendingStore.snapshot()).toBe('[]');
});
it('keeps queued work silent and lets the user resume a paused read after timeout', async () => {
  let elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  const fetchJob = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ analysisJob: { ...job, status: 'ready' } }))
    .mockResolvedValueOnce(Response.json({ pageviews: 12 }));
  const pending = followAnalysisJob({ analysisJob: job }, { fetchJob });
  render(createElement(AnalysisPendingNotice, { websiteId: site }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText(/统计任务已排队|后台正在计算/)).not.toBeInTheDocument();
  elapsed = 15 * 60000;
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(screen.getByRole('alert')).toHaveTextContent('本轮处理超时');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect((await pending).data).toEqual({ pageviews: 12 });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(analysisPendingStore.snapshot()).toBe('[]');
});
it('refuses external task result URLs and never treats failure as a result', async () => {
  const fetchJob = vi.fn(),
    releaseJob = vi.fn(async () => Response.json({ released: true }));
  const pending = followAnalysisJob(
    { analysisJob: { ...job, resultUrl: 'https://evil.invalid/steal' } },
    { fetchJob, releaseJob },
  );
  const assertion = expect(pending).rejects.toThrow('Invalid analytics task path');
  await vi.advanceTimersByTimeAsync(3000);
  await assertion;
  expect(fetchJob).not.toHaveBeenCalled();
  expect(releaseJob).not.toHaveBeenCalled();
});
it('opts in only compatible aggregate routes', () => {
  expect(
    analysisAsyncPath(`/liekan/websites/${site}/page-report`, { resource: 'ai/overview' }),
  ).toBe(true);
  for (const resource of ['logs', 'human/keywords'])
    expect(analysisAsyncPath(`/liekan/websites/${site}/page-report`, { resource })).toBe(false);
  expect(analysisAsyncPath(`/websites/${site}/metrics`, { browser1: 'eq.Chrome' })).toBe(false);
  expect(analysisAsyncPath(`/websites/${site}/sessions`)).toBe(false);
});

it('retains link and pixel aggregates on their original protocol', () => {
  for (const eventType of [3, 4, '3', '4'])
    expect(analysisAsyncPath('/websites/site/stats', { eventType })).toBe(false);
});

it('waits for durable jobs from the previous page to free a quota slot and remains abortable', async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: { code: 'analysis-concurrency-limited' } }, { status: 429 }),
    )
    .mockResolvedValueOnce(Response.json({ pageviews: 7 }));
  const waiting = waitForAnalysisAdmission(site, send);
  expect(JSON.parse(analysisPendingStore.snapshot())[0]).toMatchObject({
    websiteId: site,
    paused: false,
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await (await waiting).json()).toEqual({ pageviews: 7 });
  expect(analysisPendingStore.snapshot()).toBe('[]');
  const controller = new AbortController();
  const aborted = waitForAnalysisAdmission(site, send, controller.signal);
  const assertion = expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await assertion;
  expect(analysisPendingStore.snapshot()).toBe('[]');
});
