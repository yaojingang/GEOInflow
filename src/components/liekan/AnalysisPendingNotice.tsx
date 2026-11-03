'use client';
import { useSyncExternalStore } from 'react';
import { analysisPendingStore } from '@/lib/liekan/upstream/analysis-query-client';
import { useLiekanI18n } from '@/lib/liekan/i18n/client';
import styles from '@/styles/liekan/Shell.module.css';
import type { AnalysisJob } from '@/lib/liekan/contracts/analysis-acceleration';

export function AnalysisPendingNotice({
  websiteId,
  websiteHandle,
}: {
  websiteId?: string;
  websiteHandle?: string;
}) {
  const i18n = useLiekanI18n();
  const state = useSyncExternalStore(
    analysisPendingStore.subscribe,
    analysisPendingStore.snapshot,
    analysisPendingStore.serverSnapshot,
  );
  const current = (
    JSON.parse(state) as Array<{
      id: string;
      websiteId: string;
      paused: boolean;
      job?: AnalysisJob;
    }>
  ).filter(
    row => row.websiteId === websiteId || (!!websiteHandle && row.websiteId === websiteHandle),
  );
  const paused = current.filter(row => row.paused);
  if (!current.length) return null;
  if (!paused.length)
    return (
      <div className={styles.notice} role="status" aria-live="polite">
        {current.some(row => row.job?.status === 'running')
          ? i18n.text('正在计算统计数据，完成后自动显示。')
          : current.some(row => row.job?.errorCode === 'analysis-query-timeout')
            ? i18n.text('上次计算超时，正在按重试计划恢复。')
            : i18n.text('统计任务排队中，开始后将自动显示进度。')}
      </div>
    );
  return (
    <div className={styles.notice} role="alert">
      {i18n.text('本轮处理超时，进度已保留，可以重试。')}
      {paused.map(({ id }) => (
        <button key={id} type="button" onClick={() => analysisPendingStore.resume(id)}>
          {i18n.text('重试')}
        </button>
      ))}
    </div>
  );
}
