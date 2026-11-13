import { AsyncLocalStorage } from 'node:async_hooks';
import { processSingleton } from './process-singleton';

const clock = processSingleton(
  'dashboard-clock',
  () =>
    new AsyncLocalStorage<{
      cutoff: number;
      dayAt: number;
      scheduledOverview?: 'first' | 'refresh';
    }>(),
);
export const dashboardClock = () => clock.getStore();
export function withDashboardClock<T>(
  cutoff: number,
  work: () => Promise<T>,
  scheduledOverview?: 'first' | 'refresh',
) {
  return clock.run({ cutoff, dayAt: Date.now(), scheduledOverview }, work);
}
